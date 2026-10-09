// 按会话管理一个提示词段的通用机制：筹备与单聊共用。
// 同一会话的操作串行执行；成功（或确认该会话不归本实例）后才记账，失败可重试；
// 会话"代数"在 forget 时加一，进行中的操作发现代数变了就放弃，避免销毁后泄漏注册。
import type { HostAgent } from './context'
import type { Log } from './runtime'

/** 一次规划的结果：给出段文字、等一等再试（还认不出会话属于哪个模式），或不归本实例管。 */
export type SectionPlan =
  /** temporary：先挂上这段文字，但不记账——下一次 ensure 会重新规划（用于降级段，原因消除后能恢复） */
  | { kind: 'text'; text: string; note?: string; temporary?: boolean }
  | { kind: 'wait' }
  | { kind: 'skip'; note?: string }

/** 向该会话注册一段文字，返回撤销函数。 */
export type SectionRegister = (agent: HostAgent, text: string) => () => void

interface SectionHost {
  systemPrompt: { section(s: { name: string; order: number; text: string; interpolate?: boolean }): () => void }
}

/** 默认的注册实现：挂到该 agent 自己的 systemPrompt 上（作用域隔离，09 T12）。 */
export function hostSectionRegister(name: string, order: number): SectionRegister {
  return (agent, text) => (agent.ctx as SectionHost).systemPrompt.section({ name, order, text, interpolate: false })
}

export class SessionSections {
  private readonly disposers = new Map<string, () => void>()
  private readonly done = new Set<string>()
  private readonly texts = new Map<string, string>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly gen = new Map<string, number>()

  constructor(
    private readonly log: Pick<Log, 'debug' | 'warn'>,
    private readonly register: SectionRegister,
    private readonly label = '提示词段',
  ) {}

  /** 入队时捕获会话代数；执行时发现代数变了（会话已销毁）就什么都不做。 */
  private serial(id: string, task: (g: number) => Promise<void>): Promise<void> {
    const g = this.gen.get(id) ?? 0
    const run = async (): Promise<void> => {
      if ((this.gen.get(id) ?? 0) !== g) {
        this.log.debug(`会话 ${id}：排队期间会话已结束，放弃`)
        return
      }
      await task(g)
    }
    const prev = this.chains.get(id) ?? Promise.resolve()
    const next = prev.then(run, run)
    this.chains.set(id, next.catch(() => undefined))
    return next
  }

  /** 每会话只做一次；已成功处理过的会话直接返回（不调用 plan）。 */
  ensure(agent: HostAgent, plan: () => Promise<SectionPlan>): Promise<void> {
    return this.serial(agent.id, async (g) => {
      if (this.done.has(agent.id)) return
      await this.apply(agent, plan, g)
    })
  }

  /** 状态变了：按最新的规划换段。 */
  refresh(agent: HostAgent, plan: () => Promise<SectionPlan>): Promise<void> {
    return this.serial(agent.id, (g) => this.apply(agent, plan, g))
  }

  /** 忘掉"已处理"的记账，让下一次 ensure 重新规划（刷新失败后用）。已注册的段不动。 */
  invalidate(id: string): void {
    this.done.delete(id)
  }

  private async apply(agent: HostAgent, plan: () => Promise<SectionPlan>, g: number): Promise<void> {
    const id = agent.id
    const p = await plan()
    if (p.kind === 'wait') {
      this.log.debug(`会话 ${id}：还取不到实际模式，稍后再试`)
      return
    }
    if (p.kind === 'skip') {
      this.log.debug(`会话 ${id}：不注册${this.label}${p.note ? `（${p.note}）` : ''}`)
      if ((this.gen.get(id) ?? 0) === g) this.done.add(id)
      return
    }
    if ((this.gen.get(id) ?? 0) !== g) {
      this.log.debug(`会话 ${id}：注册途中会话已结束，放弃`)
      return
    }
    const text = p.text
    // 文字没变就不动已注册的段（避免降级段每步重复注册、破坏提示词缓存）
    if (p.temporary && this.texts.get(id) === text && this.disposers.has(id)) {
      this.done.delete(id)
      return
    }
    const oldDispose = this.disposers.get(id)
    const oldText = this.texts.get(id)
    oldDispose?.()
    this.disposers.delete(id)
    this.texts.delete(id)
    try {
      this.disposers.set(id, this.register(agent, text))
      this.texts.set(id, text)
    } catch (e) {
      // 新段注册失败：把旧段原样放回；放不回就清掉记账，让下一次 ensure 重试
      let restored = false
      if (oldDispose && oldText !== undefined) {
        try {
          this.disposers.set(id, this.register(agent, oldText))
          this.texts.set(id, oldText)
          restored = true
        } catch (e2) {
          this.log.warn(`会话 ${id}：旧段也没能放回：${(e2 as Error).message}`)
        }
      }
      if (!restored) this.done.delete(id)
      throw e
    }
    if (p.temporary) this.done.delete(id)
    else this.done.add(id)
    this.log.debug(`会话 ${id}：${this.label}已注册（${text.length} 字${p.note ? `，${p.note}` : ''}）`)
  }

  /** 会话结束：撤销并忘掉；进行中的操作会因代数变化而放弃。 */
  forget(id: string): void {
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1)
    this.disposers.get(id)?.()
    this.disposers.delete(id)
    this.texts.delete(id)
    this.done.delete(id)
    this.chains.delete(id)
    this.log.debug(`会话 ${id}：已结束，清掉${this.label}记账`)
  }

  has(id: string): boolean {
    return this.disposers.has(id)
  }
}
