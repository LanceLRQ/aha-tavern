// 生图能力的可用性：按会话判定"有没有画图能力"，并据此对该会话隐藏或放开 aha_draw。
// 判定 = 读服务配置 -> 探测服务（按地址缓存）；没配置、探测不到、只读酒馆、读配置出错都按不可用处理。
// 隐藏方式是宿主的按会话限制：持有 restrict 返回的解除函数就是隐藏，调用并丢弃就是放开。
import { readCharacter } from '../core/card'
import { ComfyError, createComfyClient } from '../core/comfy'
import { lastImage, saveImage, type ImageOrientation, type ImageRecord } from '../core/images'
import { loadImageService, type ImageServiceResult, type ImageServiceSettings } from '../core/services'
import { fillWorkflow, loadWorkflow } from '../core/workflow'
import drawPrompts from '../prompts/draw.md'
import type { HostAgent, HostServices } from './context'
import type { RememberTurns } from './remember'
import type { Log, Runtime } from './runtime'
import type { SessionSections } from './sections'
import { resolveChatTarget, type ChatTarget } from './transcript'

/** 生图工具名。 */
export const DRAW_TOOL = 'aha_draw'

/** 探测超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 2000
/** 探测结果的缓存时长（毫秒），成功与失败都缓存。 */
export const PROBE_CACHE_MS = 60_000

export type AvailabilityReason = 'ok' | 'not-configured' | 'unreachable' | 'readonly' | 'not-chatting' | 'error'

export interface Availability {
  available: boolean
  settings: ImageServiceSettings | null
  reason: AvailabilityReason
}

/** 会话此刻的状态：是否在聊天中、酒馆是否只读。 */
export interface SessionFacts {
  chatting: boolean
  readonly: boolean
}

/** 宿主 agent.ctx.tools 里本插件用到的最小子集。 */
interface RestrictableTools {
  restrict(spec: { allow?: string[]; deny?: string[] }): () => void
}

/** 对这个会话隐藏 aha_draw，返回解除函数。 */
export function hideDrawTool(agent: HostAgent): () => void {
  const tools = (agent.ctx as { tools?: Partial<RestrictableTools> } | undefined)?.tools
  if (!tools || typeof tools.restrict !== 'function') throw new Error('宿主 agent.ctx.tools 没有 restrict')
  return tools.restrict({ deny: [DRAW_TOOL] })
}

export interface AvailabilityDeps {
  log: Pick<Log, 'info' | 'warn'>
  /** 会话此刻的状态；抛出时按不可用处理。 */
  inspect(agent: HostAgent): Promise<SessionFacts>
  /** 读服务配置。 */
  loadService(): Promise<ImageServiceResult>
  /** 探测服务；不可达时抛出。 */
  probe(endpoint: string, timeoutMs: number): Promise<void>
  now?: () => number
  /** 隐藏工具并返回解除函数；缺省走宿主的 restrict。 */
  hide?: (agent: HostAgent) => () => void
  /** 能力从无到有、从有到无，或有能力期间 auto 设置变了时调用一次。 */
  onChange?: (agent: HostAgent, available: boolean, settings: ImageServiceSettings | null) => void
}

interface SessionEntry {
  decided: boolean
  available: boolean
  settings: ImageServiceSettings | null
  /** 非空表示工具此刻对该会话隐藏 */
  release: (() => void) | null
  pending: Promise<Availability> | null
  /** 每次发起判定或 drop 时递增；判定返回时发现不是自己发起时的值，结果作废 */
  epoch: number
  last: Availability
}

interface ProbeEntry {
  at: number
  ok: boolean
  pending: Promise<boolean> | null
}

const NONE: Availability = { available: false, settings: null, reason: 'not-chatting' }

/** 日志里只写服务的主机与端口。 */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || '（无）'
  } catch {
    return '（无效地址）'
  }
}

export class DrawAvailability {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly probes = new Map<string, ProbeEntry>()
  private readonly now: () => number
  private readonly hide: (agent: HostAgent) => () => void

  constructor(private readonly deps: AvailabilityDeps) {
    this.now = deps.now ?? Date.now
    this.hide = deps.hide ?? hideDrawTool
  }

  /** 会话刚建好时调用：默认没有画图能力，先隐藏。 */
  conceal(agent: HostAgent): void {
    this.hideQuietly(this.entry(agent.id), agent)
  }

  /** 这个会话的结论；第一次真正判定，之后直接返回。选角阶段不判定、保持隐藏。 */
  async ensure(agent: HostAgent): Promise<Availability> {
    const e = this.entry(agent.id)
    if (e.decided) return e.last
    return e.pending ?? this.run(agent, e, false)
  }

  /** 无视缓存重新读配置并探测，按结果更新这个会话。 */
  async refresh(agent: HostAgent): Promise<Availability> {
    return this.run(agent, this.entry(agent.id), true)
  }

  /** 出图时发现连不上：撤掉这个会话的能力，并让该地址的缓存失效。 */
  drop(agent: HostAgent): void {
    const e = this.sessions.get(agent.id)
    if (!e) return
    if (e.settings) this.probes.delete(e.settings.endpoint)
    e.epoch += 1
    e.decided = true
    this.apply(agent, e, { available: false, settings: null, reason: 'unreachable' })
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 会话是否还在（没有被 forget）；工具收尾时用来避免给已结束的会话留记录。 */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  private entry(id: string): SessionEntry {
    let e = this.sessions.get(id)
    if (!e) {
      e = { decided: false, available: false, settings: null, release: null, pending: null, epoch: 0, last: NONE }
      this.sessions.set(id, e)
    }
    return e
  }

  private run(agent: HostAgent, e: SessionEntry, force: boolean): Promise<Availability> {
    const mine = ++e.epoch
    const p = this.decide(agent, force).then((r) => {
      // 判定期间会话可能已被 forget，或有更新的判定 / drop；此时丢弃这次结果
      if (this.sessions.get(agent.id) !== e) return r
      if (e.epoch !== mine) return e.last
      if (r.reason !== 'not-chatting') e.decided = true
      return this.apply(agent, e, r)
    }).finally(() => {
      if (e.pending === p) e.pending = null
    })
    e.pending = p
    return p
  }

  private async decide(agent: HostAgent, force: boolean): Promise<Availability> {
    try {
      const facts = await this.deps.inspect(agent)
      if (!facts.chatting) return { available: false, settings: null, reason: 'not-chatting' }
      if (facts.readonly) return { available: false, settings: null, reason: 'readonly' }
      const svc = await this.deps.loadService()
      if (!svc.configured) return { available: false, settings: null, reason: 'not-configured' }
      const ok = await this.probe(svc.settings.endpoint, force)
      return ok
        ? { available: true, settings: svc.settings, reason: 'ok' }
        : { available: false, settings: null, reason: 'unreachable' }
    } catch (err) {
      this.deps.log.warn(`会话 ${agent.id}：生图可用性判定出错，按不可用处理：${(err as Error).message}`)
      return { available: false, settings: null, reason: 'error' }
    }
  }

  /** 探测并按地址缓存；同一地址的并发探测合并成一次。 */
  private probe(endpoint: string, force: boolean): Promise<boolean> {
    const hit = this.probes.get(endpoint)
    if (hit) {
      if (hit.pending) return hit.pending
      if (!force && this.now() - hit.at < PROBE_CACHE_MS) return Promise.resolve(hit.ok)
    }
    const entry: ProbeEntry = { at: this.now(), ok: false, pending: null }
    entry.pending = this.deps.probe(endpoint, PROBE_TIMEOUT_MS).then(
      () => true,
      (err: unknown) => {
        this.deps.log.info(`生图服务 ${hostOf(endpoint)} 探测失败：${(err as Error).message}`)
        return false
      },
    ).then((ok) => {
      entry.ok = ok
      entry.at = this.now()
      entry.pending = null
      return ok
    })
    this.probes.set(endpoint, entry)
    return entry.pending
  }

  private apply(agent: HostAgent, e: SessionEntry, r: Availability): Availability {
    e.last = r
    const changed = e.available !== r.available
    const autoChanged = r.available && !changed && e.settings !== null && e.settings.auto !== r.settings?.auto
    e.available = r.available
    e.settings = r.settings
    if (r.available) {
      if (e.release) {
        const release = e.release
        e.release = null
        try {
          release()
        } catch (err) {
          this.deps.log.warn(`会话 ${agent.id}：解除 ${DRAW_TOOL} 的隐藏失败：${(err as Error).message}`)
        }
      }
    } else {
      this.hideQuietly(e, agent)
    }
    if (changed || autoChanged) {
      if (changed) this.logChange(agent, r)
      try {
        this.deps.onChange?.(agent, r.available, r.settings)
      } catch (err) {
        this.deps.log.warn(`会话 ${agent.id}：画图能力变化的回调出错：${(err as Error).message}`)
      }
    }
    return r
  }

  private logChange(agent: HostAgent, r: Availability): void {
    const where = r.settings ? `，服务 ${hostOf(r.settings.endpoint)}` : ''
    this.deps.log.info(`会话 ${agent.id}：画图能力${r.available ? '开启' : '关闭'}（${r.reason}${where}）`)
  }

  private hideQuietly(e: SessionEntry, agent: HostAgent): void {
    if (e.release) return
    try {
      e.release = this.hide(agent)
    } catch (err) {
      this.deps.log.warn(`会话 ${agent.id}：隐藏 ${DRAW_TOOL} 失败：${(err as Error).message}`)
    }
  }
}

/** 默认依赖：读 services.yaml，用 ComfyUI 客户端探测。 */
export function defaultDrawDeps(servicesPath: () => string, fetchImpl: typeof fetch = globalThis.fetch): Pick<AvailabilityDeps, 'loadService' | 'probe'> {
  return {
    loadService: () => loadImageService(servicesPath()),
    probe: async (endpoint, timeoutMs) => {
      await createComfyClient({ endpoint, fetch: fetchImpl }).probe(timeoutMs)
    },
  }
}

// ---------- 提示词段 ----------

const PROMPT_SPLIT = /^=== on-request ===$/m

/** 画图提示词段的文字：auto 为真是"角色自己决定"版，否则是"只应 user 要求"版。 */
export function drawPromptText(auto: boolean, source: string = drawPrompts): string {
  const [self, onRequest] = source.split(PROMPT_SPLIT)
  return ((auto ? self : onRequest) ?? '').trim()
}

// ---------- 参数与提示词 ----------

export const SCENE_MAX = 600
export const CHANGE_MAX = 200
const POLL_MS = 1000
const ORIENTATIONS: readonly ImageOrientation[] = ['portrait', 'landscape', 'square']

export interface DrawArgs {
  scene?: string
  orientation: ImageOrientation
  redo: boolean
  change?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clipChars = (s: string, max: number): string => [...s].slice(0, max).join('')

/** 校验 aha_draw 的参数，出错返回 error: 开头的文字。超长的 scene、change 按字符截断。 */
export function parseDrawArgs(args: unknown): DrawArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const text = (k: 'scene' | 'change', max: number): string | undefined | Error => {
    const v = args[k]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') return new Error(`error: ${k} must be a string`)
    const t = v.trim()
    return t === '' ? undefined : clipChars(t, max)
  }
  const scene = text('scene', SCENE_MAX)
  if (scene instanceof Error) return scene.message
  const change = text('change', CHANGE_MAX)
  if (change instanceof Error) return change.message
  let orientation: ImageOrientation = 'portrait'
  if (args.orientation !== undefined && args.orientation !== null) {
    if (typeof args.orientation !== 'string' || !ORIENTATIONS.includes(args.orientation as ImageOrientation)) {
      return 'error: orientation must be portrait, landscape or square'
    }
    orientation = args.orientation as ImageOrientation
  }
  let redo = false
  if (args.redo !== undefined && args.redo !== null) {
    if (typeof args.redo !== 'boolean') return 'error: redo must be a boolean'
    redo = args.redo
  }
  if (!redo && scene === undefined) return 'error: scene is required unless redo is true'
  return { ...(scene !== undefined ? { scene } : {}), orientation, redo, ...(change !== undefined ? { change } : {}) }
}

/** 方向对应的宽高：portrait 高不小于宽，landscape 相反，square 两边都取较小值。 */
export function sizeFor(orientation: ImageOrientation, width: number, height: number): { width: number; height: number } {
  const hi = Math.max(width, height)
  const lo = Math.min(width, height)
  if (orientation === 'landscape') return { width: hi, height: lo }
  if (orientation === 'square') return { width: lo, height: lo }
  return { width: lo, height: hi }
}

/**
 * redo 带 change 时，新的画面描述是"上一张的 scene，change"，总长不超过 scene 上限；
 * 超限时优先保留 change，裁掉旧 scene 的尾部。
 */
export function redoScene(previous: string, change: string | undefined): string {
  if (!change) return clipChars(previous, SCENE_MAX)
  const room = Math.max(0, SCENE_MAX - [...change].length - 1)
  return clipChars(`${clipChars(previous, room)}，${change}`, SCENE_MAX)
}

/** 出图提示词（规格 6.1）：画风、外貌、画面三段用换行连接，空的跳过。 */
export function composePrompt(parts: { style?: string; appearance?: string; scene: string }): string {
  return [parts.style, parts.appearance, parts.scene].map((p) => (p ?? '').trim()).filter((p) => p !== '').join('\n')
}

// ---------- 复述核对 ----------

/** 成功出图后记下待核对的路径；这一轮的回复里含有该路径就清掉，到下一轮开始仍没有就记 warn。 */
export class DrawEcho {
  private readonly pending = new Map<string, { path: string; n: number }>()

  constructor(private readonly log: Pick<Log, 'warn'>) {}

  expect(session: string, imagePath: string, n: number): void {
    this.pending.set(session, { path: imagePath, n })
  }

  /** 角色的回复提交时调用。 */
  onReply(session: string, text: string): void {
    const p = this.pending.get(session)
    if (p && text.includes(p.path)) this.pending.delete(session)
  }

  /**
   * pre-step 里调用：本步带进来多少条新的用户消息。
   * 用户在回复提交前中途插话时也会算作新一轮，可能误报一条 warn，只影响日志统计。
   */
  onUser(session: string, newUserMessages: number): void {
    if (newUserMessages <= 0) return
    const p = this.pending.get(session)
    if (!p) return
    this.pending.delete(session)
    this.log.warn(`会话 ${session}：第 ${p.n} 张图出了，但回复里没有图片路径`)
  }

  forget(session: string): void {
    this.pending.delete(session)
  }
}

// ---------- 工具 ----------

export interface DrawEnv {
  rt: Pick<Runtime, 'log' | 'builtinWorkflowDir'>
  getServices(): HostServices | undefined
  drawing: DrawAvailability
  /** 画图自己的每轮名额 */
  turns: RememberTurns
  echo: DrawEcho
  fetch?: typeof fetch
  /** 0 到 1 之间的随机数 */
  random?: () => number
  now?: () => number
  /** 会话在聊天中给出目标，否则 null；缺省按宿主服务现算。 */
  resolveTarget?: (agent: HostAgent) => Promise<ChatTarget | null>
  /** 目标角色卡的外貌；读不出来按没有。 */
  appearanceOf?: (target: ChatTarget) => Promise<string>
}

export const DRAW_HINT = '照常写这一轮的回复，不要重试，不要向 user 提起。'
export type DrawFailKind = 'unreachable' | 'missing-node' | 'missing-model' | 'timeout' | 'cancelled' | 'other'

const failText = (kind: DrawFailKind): string => `failed: ${kind}\n${DRAW_HINT}`
const UNAVAILABLE = `unavailable\n${DRAW_HINT}`

/** 图片行里的路径：尖括号写法能容纳空格与括号；路径里的 < 和 > 换成百分号编码。 */
export function imagePathText(absPath: string): string {
  return absPath.replace(/</g, '%3C').replace(/>/g, '%3E')
}

/** 图片行（Markdown），复述核对比对的就是尖括号里面的那段文字。 */
export function imageLine(absPath: string): string {
  return `![画面](<${imagePathText(absPath)}>)`
}

/** 成功时给角色的返回值：先写完整回复，最后单独一行原样输出图片行。 */
export function drawnText(absPath: string): string {
  return 'drawn. 现在写这一轮的回复（照常扮演，不要提到工具或画图的过程），并在回复的最后单独一行原样输出下面这一行，一个字符都不要改：\n'
    + imageLine(absPath)
}

function failKindOf(e: unknown): DrawFailKind {
  if (!(e instanceof ComfyError)) return 'other'
  switch (e.kind) {
    case 'unreachable':
    case 'missing-node':
    case 'missing-model':
    case 'timeout':
    case 'cancelled':
      return e.kind
    default:
      return 'other'
  }
}

/** aha_draw 的实现：返回给模型的文字。 */
export function drawTool(env: DrawEnv): (agent: HostAgent | undefined, args: unknown, signal?: AbortSignal) => Promise<string> {
  const log = env.rt.log
  const now = env.now ?? Date.now
  const random = env.random ?? Math.random
  const resolveTarget = env.resolveTarget ?? (async (agent) => {
    const services = env.getServices()
    return services ? resolveChatTarget(agent, services, env.rt.log) : null
  })
  const appearanceOf = env.appearanceOf ?? (async (t) => {
    const entry = await readCharacter(t.tavernDir, t.characterId)
    return entry && entry.ok ? (entry.card.appearance ?? '') : ''
  })

  return async (agent, args, signal) => {
    if (!agent) return 'error: session not ready'
    const session = agent.id
    try {
      const av = await env.drawing.ensure(agent)
      const settings = av.settings
      if (!av.available || !settings) return UNAVAILABLE
      const parsed = parseDrawArgs(args)
      if (typeof parsed === 'string') return parsed
      const target = await resolveTarget(agent)
      if (!target || target.readonly) return UNAVAILABLE

      let previous: ImageRecord | null = null
      if (parsed.redo) {
        previous = await lastImage(target.tavernDir, target.chatId)
        if (!previous || typeof previous.scene !== 'string' || previous.scene.trim() === '') return 'nothing to redo'
      }
      if (/[\r\n]/.test(target.tavernDir) || /[\r\n]/.test(target.chatId)) {
        log.warn(`会话 ${session}：聊天目录的路径含换行符，不出图`)
        return failText('other')
      }
      const token = env.turns.claim(session)
      if (token === null) return 'already drew this turn'

      // 占了名额之后的任何异常路径都要释放，只有成功才保留
      let drew = false
      const started = now()
      let summary = ''
      try {
        const orientation = previous ? (ORIENTATIONS.includes(previous.orientation) ? previous.orientation : 'portrait') : parsed.orientation
        const scene = previous ? redoScene(previous.scene, parsed.change) : parsed.scene!
        const { width, height } = sizeFor(orientation, settings.width, settings.height)
        const seed = Math.floor(random() * 2 ** 32)
        summary = `${width}x${height} steps=${settings.steps} redo=${parsed.redo}`
        const appearance = await appearanceOf(target).catch(() => '')
        const prompt = composePrompt({ style: settings.style, appearance, scene })
        const wf = await loadWorkflow(settings.workflow, env.rt.builtinWorkflowDir)
        const graph = fillWorkflow(wf, { prompt, width, height, seed, steps: settings.steps, models: settings.models })
        const client = createComfyClient({ endpoint: settings.endpoint, fetch: env.fetch ?? globalThis.fetch })
        const image = await client.generate(graph, {
          outputNode: wf.output, timeoutMs: settings.timeoutSeconds * 1000, pollMs: POLL_MS, ...(signal ? { signal } : {}),
        })
        const saved = await saveImage(target.tavernDir, target.chatId, image.bytes, image.ext, {
          scene, prompt, seed, width, height, steps: settings.steps, workflow: settings.workflow,
          redoOf: previous ? previous.n : null, orientation,
        })
        if (/[\r\n]/.test(saved.absPath)) throw new Error('图片路径含换行符')
        // 会话在出图期间已结束：不再登记待核对项
        if (env.drawing.has(session)) env.echo.expect(session, imagePathText(saved.absPath), saved.n)
        log.info(`会话 ${session}：出图 n=${saved.n} ${now() - started}ms ${summary}`)
        drew = true
        return drawnText(saved.absPath)
      } catch (e) {
        const kind = failKindOf(e)
        log.info(`会话 ${session}：出图失败 ${kind} ${now() - started}ms ${summary}`)
        log.debug(`出图失败原文：${e instanceof ComfyError ? e.detail || e.message : (e as Error).message}`)
        if (kind === 'unreachable') env.drawing.drop(agent)
        return failText(kind)
      } finally {
        if (!drew) env.turns.release(session, token)
      }
    } catch (e) {
      log.warn(`会话 ${session}：aha_draw 出错：${(e as Error).message}`)
      return failText('other')
    }
  }
}

// ---------- 画图提示词段的装配 ----------

type SectionOps = Pick<SessionSections, 'refresh' | 'forget'>

/** 做成 DrawAvailability 的 onChange：有能力时装上对应版本（auto 变了就换版本），没能力时撤掉。 */
export function drawPromptSync(
  sections: SectionOps, warn: (message: string) => void,
): (agent: HostAgent, available: boolean, settings: ImageServiceSettings | null) => void {
  return (agent, available, settings) => {
    if (available && settings) {
      sections.refresh(agent, async () => ({
        kind: 'text', text: drawPromptText(settings.auto), note: settings.auto ? '自动' : '仅应要求',
      })).catch((e: unknown) => warn(`注册画图提示词段失败：${(e as Error).message}`))
    } else {
      sections.forget(agent.id)
    }
  }
}
