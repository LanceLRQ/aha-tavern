// 筹备模式的外壳：开店命令、掌柜提示词段的装配与注册（每会话一次，状态变了再换）。
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import hostSetupGuide from '../prompts/host-setup.md'
import { listCharacters } from '../core/card'
import { readMe, readWorld } from '../core/docs'
import { readRegistry, registerTavern } from '../core/registry'
import { createTavern, type TavernMarker } from '../core/tavern'
import {
  buildContext, probeWebSearch, type CommandContext, type CommandHandler, type HostAgent, type HostServices,
} from './context'
import { failureReceipt, initDoneReceipt, initNeedsWorkspaceReceipt } from './receipts'
import type { Runtime } from './runtime'
import { buildDocCue, buildOpeningCue, buildSetupPrompt, planCardCommand, type SetupFacts } from './setup-prompt'
import { DeclineTracker, SessionGate, type AskFn } from './confirm'
import { importHandler } from './importing'
import { isReadonly, openResolved } from './writable'
import { registerSetupTools } from './setup-tools'
import type { Theme } from '../core/theme'

const SECTION_NAME = 'aha:host-setup'
const SECTION_ORDER = 5000

/** 宿主 agent 里筹备外壳用到的最小子集。 */
interface SetupAgent extends HostAgent {
  steer(message: unknown): unknown
}
interface SectionHost {
  systemPrompt: { section(s: { name: string; order: number; text: string; interpolate?: boolean }): () => void }
}

/** 收集状态事实；每一项读取失败都降级为"空"并记警告，不影响整体。 */
export async function collectFacts(rt: Runtime, agent: HostAgent, cc: CommandContext): Promise<SetupFacts> {
  const webSearch = probeWebSearch(rt.tools(), agent)
  const tavern = cc.tavern
  const place: SetupFacts['place'] = tavern
    ? { kind: 'inside', name: tavern.marker.name, dir: tavern.dir }
    : { kind: 'outside', reason: cc.outsideReason ?? 'not-tavern' }
  const safe = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      rt.log.warn(`读取${what}失败：${(e as Error).message}`)
      return fallback
    }
  }
  const registry = await safe('登记表', () => readRegistry(rt.config.registryPath), [])
  const otherTaverns = registry
    .filter((e) => path.resolve(e.path) !== (tavern ? path.resolve(tavern.dir) : ''))
    .map((e) => ({ name: e.name, path: e.path }))
  const facts: SetupFacts = {
    place,
    otherTaverns,
    characters: [],
    brokenCards: [],
    profile: { empty: true, length: 0 },
    world: { empty: true, length: 0, budget: rt.config.worldBudget },
    webSearch,
    ...(isReadonly(tavern) ? { readonly: true } : {}),
  }
  if (!tavern) return facts
  const entries = await safe('角色列表', () => listCharacters(tavern.dir), [])
  for (const e of entries) {
    if (e.ok) facts.characters.push({ name: e.card.name, ...(e.card.tagline ? { tagline: e.card.tagline } : {}) })
    else facts.brokenCards.push({ dirName: e.dirName, problem: e.problem })
  }
  const me = await safe('主角档案', () => readMe(tavern.dir), null)
  if (me) facts.profile = { empty: me.empty, length: me.length }
  const world = await safe('世界观', () => readWorld(tavern.dir), null)
  if (world) facts.world = { empty: world.empty, length: world.length, budget: rt.config.worldBudget }
  return facts
}

/** SetupSections 依赖的外部动作；默认是真实实现，测试里可替换。 */
export interface SectionHooks {
  loadContext(agent: HostAgent, services: HostServices): Promise<CommandContext>
  collect(agent: HostAgent, cc: CommandContext): Promise<SetupFacts>
  /** 向该会话注册提示词段，返回撤销函数。 */
  register(agent: HostAgent, text: string): () => void
}

/**
 * 按会话记账的提示词段。同一会话的注册操作串行执行；
 * done 只在段注册成功（或确认该会话不是筹备模式）后记账，失败可重试；
 * gen 是会话的"代数"：forget 之后，进行中的 apply 发现代数变了就放弃注册，避免泄漏。
 */
export class SetupSections {
  private readonly disposers = new Map<string, () => void>()
  private readonly done = new Set<string>()
  private readonly texts = new Map<string, string>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly gen = new Map<string, number>()
  private readonly hooks: SectionHooks

  constructor(private readonly rt: Runtime, private readonly guide: string, hooks: Partial<SectionHooks> = {}) {
    this.hooks = {
      loadContext: (agent, services) => buildContext(agent, services, rt.log),
      collect: (agent, cc) => collectFacts(rt, agent, cc),
      register: (agent, text) => (agent.ctx as SectionHost).systemPrompt.section({
        name: SECTION_NAME, order: SECTION_ORDER, text, interpolate: false,
      }),
      ...hooks,
    }
  }

  /** 入队时捕获会话代数；执行时发现代数变了（会话已销毁）就什么都不做。 */
  private serial(id: string, task: (g: number) => Promise<void>): Promise<void> {
    const g = this.gen.get(id) ?? 0
    const run = async (): Promise<void> => {
      if ((this.gen.get(id) ?? 0) !== g) {
        this.rt.log.debug(`会话 ${id}：排队期间会话已结束，放弃`)
        return
      }
      await task(g)
    }
    const prev = this.chains.get(id) ?? Promise.resolve()
    const next = prev.then(run, run)
    this.chains.set(id, next.catch(() => undefined))
    return next
  }

  /** 每会话只做一次；已成功处理过的会话直接返回。 */
  ensure(agent: HostAgent, services: HostServices, theme: Theme): Promise<void> {
    return this.serial(agent.id, async (g) => {
      if (this.done.has(agent.id)) return
      await this.apply(agent, services, theme, g)
    })
  }

  /** 状态变了：换成按最新状态生成的段。known 为调用方已知的上下文，给了就不再取。 */
  refresh(agent: HostAgent, services: HostServices, theme: Theme, known?: CommandContext): Promise<void> {
    return this.serial(agent.id, (g) => this.apply(agent, services, theme, g, known))
  }

  private async apply(
    agent: HostAgent, services: HostServices, theme: Theme, g: number, known?: CommandContext,
  ): Promise<void> {
    const id = agent.id
    // 已知上下文来自开店等只在筹备模式才会执行的路径：模式为空按筹备处理
    const cc = known ? { ...known, mode: known.mode ?? ('setup' as const) } : await this.hooks.loadContext(agent, services)
    // 取不到实际模式：留给之后的 pre-step 再试
    if (cc.mode === null) {
      this.rt.log.debug(`会话 ${id}：还取不到实际模式，稍后再试`)
      return
    }
    if (cc.mode !== 'setup') {
      this.rt.log.debug(`会话 ${id}：实际模式 ${cc.mode}，不注册掌柜提示词段`)
      if ((this.gen.get(id) ?? 0) === g) this.done.add(id)
      return
    }
    // 先把新段的文字准备好，再做替换
    const facts = await this.hooks.collect(agent, cc)
    const text = buildSetupPrompt(theme, this.guide, facts)
    if ((this.gen.get(id) ?? 0) !== g) {
      this.rt.log.debug(`会话 ${id}：注册途中会话已结束，放弃`)
      return
    }
    const oldDispose = this.disposers.get(id)
    const oldText = this.texts.get(id)
    oldDispose?.()
    this.disposers.delete(id)
    this.texts.delete(id)
    try {
      this.disposers.set(id, this.hooks.register(agent, text))
      this.texts.set(id, text)
    } catch (e) {
      // 新段注册失败：把旧段原样放回；放不回就清掉记账，让下一次 ensure 重试
      let restored = false
      if (oldDispose && oldText !== undefined) {
        try {
          this.disposers.set(id, this.hooks.register(agent, oldText))
          this.texts.set(id, oldText)
          restored = true
        } catch (e2) {
          this.rt.log.warn(`会话 ${id}：旧段也没能放回：${(e2 as Error).message}`)
        }
      }
      if (!restored) this.done.delete(id)
      throw e
    }
    this.done.add(id)
    this.rt.log.debug(`会话 ${id}：掌柜提示词段已注册（${text.length} 字，place=${facts.place.kind}）`)
  }

  /** 会话结束：撤销并忘掉；进行中的 apply 会因代数变化而放弃。 */
  forget(id: string): void {
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1)
    this.disposers.get(id)?.()
    this.disposers.delete(id)
    this.texts.delete(id)
    this.done.delete(id)
    this.chains.delete(id)
    this.rt.log.debug(`会话 ${id}：已结束，清掉提示词段记账`)
  }

  has(id: string): boolean {
    return this.disposers.has(id)
  }
}

/** 开店命令的处理。 */
export function initHandler(sections: SetupSections): CommandHandler {
  return async ({ agent, services, rt, theme, context, steer }) => {
    const cwd = context.cwd
    if (!cwd) return initNeedsWorkspaceReceipt(theme)
    const name = path.basename(cwd) || theme.concept('tavern')
    let marker: TavernMarker
    try {
      marker = await createTavern(cwd, { name })
    } catch (e) {
      rt.log.warn(`开店失败：${(e as Error).message}`)
      return failureReceipt((e as Error).message)
    }
    rt.log.info(`开店：${cwd}（${marker.id}）`)
    let registryWarning: string | undefined
    try {
      await registerTavern(rt.config.registryPath, { id: marker.id, name: marker.name, path: cwd })
    } catch (e) {
      registryWarning = (e as Error).message
      rt.log.warn(`登记失败：${registryWarning}`)
    }
    // 盘上已经是酒馆。后半段（刷新段、开场指令）失败不能报成"没能完成"
    try {
      const known: CommandContext = {
        ...context, tavern: await openResolved(cwd, rt.log), state: 'preparing', outsideReason: null,
      }
      await sections.refresh(agent, services, theme, known)
      const facts = await collectFacts(rt, agent, known)
      const cue = buildOpeningCue(theme, facts)
      steer(cue, `${theme.action('init')}：${marker.name}`)
      rt.log.debug(`开店：已提交开场指令（${cue.length} 字，web_search=${facts.webSearch}）`)
    } catch (e) {
      rt.log.error(`开店后引导没发出：${(e as Error).stack ?? e}`)
      return initDoneReceipt(theme, marker.name, { registryWarning, guidanceFailed: true })
    }
    return initDoneReceipt(theme, marker.name, { registryWarning })
  }
}

/** `我` / `世界观`：把现有全文交给掌柜，由掌柜问用户、起草、确认后保存。 */
export function docHandler(kind: 'profile' | 'world'): CommandHandler {
  return async ({ rt, theme, context, steer }) => {
    const tavern = context.tavern
    if (!tavern) return failureReceipt(`这里还不是${theme.concept('tavern')}`)
    const doc = kind === 'profile' ? await readMe(tavern.dir) : await readWorld(tavern.dir)
    const cue = buildDocCue(theme, {
      kind, exists: doc.exists, text: doc.text, length: doc.length,
      ...(kind === 'world' ? { budget: rt.config.worldBudget } : {}),
    })
    steer(cue, `${kind}：${doc.empty ? 'empty' : `${doc.length} chars`}`)
    rt.log.debug(`命令 ${kind}：已交给掌柜（${doc.length} 字）`)
    return { kind: 'success', text: `${theme.host().name}正在看${theme.concept(kind)}。` }
  }
}

/** `建卡` 命令：不带名字请掌柜听描述；带名字匹配后进入修改流程，或回执说明。 */
export function cardHandler(): CommandHandler {
  return async ({ rt, theme, context, args, steer }) => {
    const tavern = context.tavern
    if (!tavern) return failureReceipt(`这里还不是${theme.concept('tavern')}`)
    const plan = planCardCommand(theme, await listCharacters(tavern.dir), args)
    if (plan.kind !== 'reply') {
      steer(plan.cue, plan.summary)
      rt.log.debug(`命令 card：${plan.kind}`)
    }
    return plan.reply
  }
}

interface SetupHost {
  inject(keys: readonly string[], cb: (c: SetupInjected) => void): void
  on(event: string, listener: (...args: any[]) => unknown): unknown
}
interface SetupInjected extends HostServices, SetupHost {}

/** 只在筹备实例里装配：工具、开店处理、created / pre-step 与会话结束的监听。 */
export function installSetup(ctx: Context, rt: Runtime): void {
  const sections = new SetupSections(rt, hostSetupGuide)
  let services: HostServices | undefined
  let ask: AskFn | undefined
  // 同一会话的确认卡片排队执行（工具保存与导入共用一把）；同一轮内被拒绝的保存不再重复弹卡片
  const gate = new SessionGate()
  const declines = new DeclineTracker()
  registerSetupTools(ctx, rt, async (agent) => {
    if (services) await sections.refresh(agent, services, await rt.theme())
  }, () => ask, { gate, declines })
  // 写盘前的确认卡片用宿主的 userQuestions；服务没来就保持 undefined，工具会拒绝写盘
  ;(ctx as unknown as SetupHost).inject(['userQuestions'], (c) => {
    const uq = (c as unknown as { userQuestions: { ask: AskFn } }).userQuestions
    ask = (req) => uq.ask(req)
  })
  rt.handlers.init = initHandler(sections)
  rt.handlers.me = docHandler('profile')
  rt.handlers.world = docHandler('world')
  rt.handlers.card = cardHandler()
  rt.handlers.import = importHandler(sections, () => ask, { gate })
  const host = ctx as unknown as SetupHost
  host.inject(['agentPresets'], (c) => {
    services = c
    const ensure = async (agent: SetupAgent, via: string): Promise<void> => {
      try {
        await sections.ensure(agent, c, await rt.theme())
      } catch (e) {
        rt.log.error(`注册掌柜提示词段失败（${via}）：${(e as Error).stack ?? e}`)
      }
    }
    // 新建与恢复会话时就注册；不等待（启动时会为多个旧会话各触发一次），pre-step 兜底
    c.on('agent/created', (payload: { agent: SetupAgent }) => {
      void ensure(payload.agent, 'created')
    })
    c.on('agent/pre-step', async (payload: { agent: SetupAgent; turn?: number }, next: () => Promise<unknown>) => {
      declines.onStep(payload.agent.id, payload.turn)
      await ensure(payload.agent, 'pre-step')
      return next()
    })
    c.on('agent/disposed', (payload: { agent: { id: string } }) => {
      sections.forget(payload.agent.id)
      declines.forget(payload.agent.id)
    })
    rt.log.info('筹备外壳已装配（created / pre-step / disposed 监听）')
  })
}
