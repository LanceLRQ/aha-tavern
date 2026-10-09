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
import { hostSectionRegister, SessionSections, type SectionPlan } from './sections'
import { registerSetupTools } from './setup-tools'
import type { Theme } from '../core/theme'

const SECTION_NAME = 'aha:host-setup'
const SECTION_ORDER = 5000

/** 宿主 agent 里筹备外壳用到的最小子集。 */
interface SetupAgent extends HostAgent {
  steer(message: unknown): unknown
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

/** 筹备模式的掌柜段：规划（取模式、收事实、拼文字）在这里，注册与记账交给通用的会话段管理器。 */
export class SetupSections {
  private readonly core: SessionSections
  private readonly hooks: SectionHooks

  constructor(private readonly rt: Runtime, private readonly guide: string, hooks: Partial<SectionHooks> = {}) {
    this.hooks = {
      loadContext: (agent, services) => buildContext(agent, services, rt.log),
      collect: (agent, cc) => collectFacts(rt, agent, cc),
      register: hostSectionRegister(SECTION_NAME, SECTION_ORDER),
      ...hooks,
    }
    this.core = new SessionSections(rt.log, (agent, text) => this.hooks.register(agent, text), '掌柜提示词段')
  }

  private plan(agent: HostAgent, services: HostServices, theme: Theme, known?: CommandContext): () => Promise<SectionPlan> {
    return async () => {
      // 已知上下文来自开店等只在筹备模式才会执行的路径：模式为空按筹备处理
      const cc = known ? { ...known, mode: known.mode ?? ('setup' as const) } : await this.hooks.loadContext(agent, services)
      if (cc.mode === null) return { kind: 'wait' }
      if (cc.mode !== 'setup') return { kind: 'skip', note: `实际模式 ${cc.mode}` }
      const facts = await this.hooks.collect(agent, cc)
      return { kind: 'text', text: buildSetupPrompt(theme, this.guide, facts), note: `place=${facts.place.kind}` }
    }
  }

  /** 每会话只做一次；已成功处理过的会话直接返回。 */
  ensure(agent: HostAgent, services: HostServices, theme: Theme): Promise<void> {
    return this.core.ensure(agent, this.plan(agent, services, theme))
  }

  /** 状态变了：换成按最新状态生成的段。known 为调用方已知的上下文，给了就不再取。 */
  refresh(agent: HostAgent, services: HostServices, theme: Theme, known?: CommandContext): Promise<void> {
    return this.core.refresh(agent, this.plan(agent, services, theme, known))
  }

  forget(id: string): void {
    this.core.forget(id)
  }

  has(id: string): boolean {
    return this.core.has(id)
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
