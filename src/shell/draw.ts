// 生图能力的可用性：按会话判定"有没有画图能力"，并据此对该会话隐藏或放开 aha_draw。
// 判定 = 读服务配置 -> 探测服务（按地址缓存）；没配置、探测不到、只读酒馆、读配置出错都按不可用处理。
// 隐藏方式是宿主的按会话限制：持有 restrict 返回的解除函数就是隐藏，调用并丢弃就是放开。
import { createComfyClient } from '../core/comfy'
import { loadImageService, type ImageServiceResult, type ImageServiceSettings } from '../core/services'
import type { HostAgent } from './context'
import type { Log } from './runtime'

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
  /** 能力从无到有或从有到无时调用一次。 */
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
    const e = this.entry(agent.id)
    if (e.settings) this.probes.delete(e.settings.endpoint)
    e.epoch += 1
    e.decided = true
    this.apply(agent, e, { available: false, settings: null, reason: 'unreachable' })
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
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
    if (changed) {
      const where = r.settings ? `，服务 ${hostOf(r.settings.endpoint)}` : ''
      this.deps.log.info(`会话 ${agent.id}：画图能力${r.available ? '开启' : '关闭'}（${r.reason}${where}）`)
      try {
        this.deps.onChange?.(agent, r.available, r.settings)
      } catch (err) {
        this.deps.log.warn(`会话 ${agent.id}：画图能力变化的回调出错：${(err as Error).message}`)
      }
    }
    return r
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
