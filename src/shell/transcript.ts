// 单聊的对话逐句落盘（规格 6.4）：用户的话取自 pre-step 的入步消息，角色的回复取自回复流。
// 刷出点是每次模型请求提交的 assistant/message：带工具调用的一轮会分成多条角色记录。
// 提取逻辑是纯函数 / 小状态机，接线（TranscriptRecorder）只做排队与写盘。
import { appendRecord } from '../core/chat'
import { buildContext, type HostAgent, type HostServices } from './context'
import type { Log } from './runtime'

export interface ChatTarget {
  tavernDir: string
  chatId: string
  characterId: string
}

/** 回复流帧里本模块用到的最小子集（形状依据：dsh-agent 的 AssistantStreamFrame 与 dsh-llm 的 StreamChunk）。 */
export interface StreamFrameLike {
  type: string
  chunk?: { type?: string; block?: { type?: string; text?: unknown } }
  outcome?: { kind?: string; eventType?: string }
}

/** 入步消息里本模块用到的最小子集。 */
export interface UserMessageLike {
  id?: unknown
  source?: { kind?: unknown }
  content?: ReadonlyArray<{ type?: string; text?: unknown }>
}

const textOf = (blocks: UserMessageLike['content']): string =>
  (blocks ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')

/**
 * 从入步消息里取出要入档的用户的话：只要来源为 user 的，按消息编号去重（seen 会被更新）。
 * 插件自己 steer 的消息来源是自有种类，不在其内。
 */
export function userRecordsOf(
  messages: readonly UserMessageLike[], seen: Set<string>,
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = []
  for (const m of messages) {
    if (m.source?.kind !== 'user' || typeof m.id !== 'string') continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const text = textOf(m.content)
    if (text.trim() !== '') out.push({ id: m.id, text })
  }
  return out
}

/**
 * 一次模型请求（attempt）的回复收集：start 清空，block-end 的文本块累积（思考块与分片忽略），
 * 只有提交为 assistant/message 的 end 帧给出合并后的整段文字：用户中断时已流出的前缀也以
 * assistant/message 提交（用户看到了、模型上下文里也有），照常入档；
 * assistant/attempt（失败、重试、流错误，没有表层消息）与 abandoned 一律丢弃，免得重试后重复入档。
 */
export class AttemptCollector {
  private texts: string[] = []

  feed(frame: StreamFrameLike): string | null {
    switch (frame.type) {
      case 'start':
        this.texts = []
        return null
      case 'chunk': {
        const c = frame.chunk
        if (c?.type === 'block-end' && c.block?.type === 'text' && typeof c.block.text === 'string' && c.block.text.trim() !== '') {
          this.texts.push(c.block.text.trim())
        }
        return null
      }
      case 'end': {
        const text = frame.outcome?.kind === 'committed' && frame.outcome.eventType === 'assistant/message' && this.texts.length > 0 ? this.texts.join('\n\n') : null
        this.texts = []
        return text
      }
      default:
        return null
    }
  }
}

type AppendFn = (tavernDir: string, chatId: string, record: { type: string; speaker: string; text: string }) => Promise<void>

export interface RecorderDeps {
  /** 会话在聊天中则给出落盘目标，否则 null。 */
  resolve(agent: HostAgent): Promise<ChatTarget | null>
  log: Pick<Log, 'debug' | 'warn'>
  append?: AppendFn
}

interface SessionState {
  seen: Set<string>
  collector: AttemptCollector
  /** 写入队列：同一会话的落盘按到达顺序串行 */
  tail: Promise<void>
  target: ChatTarget | null
  warned: Set<string>
}

export class TranscriptRecorder {
  private readonly sessions = new Map<string, SessionState>()
  private readonly append: AppendFn

  constructor(private readonly deps: RecorderDeps) {
    this.append = deps.append ?? ((dir, id, rec) => appendRecord(dir, id, rec))
  }

  private state(id: string): SessionState {
    let s = this.sessions.get(id)
    if (!s) {
      s = { seen: new Set(), collector: new AttemptCollector(), tail: Promise.resolve(), target: null, warned: new Set() }
      this.sessions.set(id, s)
    }
    return s
  }

  /** pre-step：入步消息里的用户的话。同步入队，不阻塞宿主。 */
  onStep(agent: HostAgent, messages: readonly UserMessageLike[]): void {
    try {
      const s = this.state(agent.id)
      const records = userRecordsOf(messages, s.seen)
      for (const r of records) this.enqueue(agent, s, 'user', 'user', r.text)
    } catch (e) {
      this.deps.log.warn(`对话落盘（用户消息）出错：${(e as Error).message}`)
    }
  }

  /** assistant-stream：回复流的一帧。 */
  onFrame(agent: HostAgent, frame: StreamFrameLike): void {
    try {
      const s = this.state(agent.id)
      const text = s.collector.feed(frame)
      if (text !== null) this.enqueue(agent, s, 'character', null, text)
    } catch (e) {
      this.deps.log.warn(`对话落盘（回复流）出错：${(e as Error).message}`)
    }
  }

  /** 等该会话已入队的写入完成（测试与收尾用）。 */
  async drain(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.tail
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private enqueue(agent: HostAgent, s: SessionState, type: 'user' | 'character', speaker: string | null, text: string): void {
    // 是否在聊天中以事件到达时的状态为准：此刻就发起判定，队列里只等这份结果
    const arrival: Promise<ChatTarget | null> = s.target ? Promise.resolve(s.target) : this.deps.resolve(agent)
    arrival.catch(() => undefined)
    s.tail = s.tail.then(async () => {
      try {
        const t = await arrival
        if (t) s.target = t
        if (!t) return
        const who = speaker ?? t.characterId
        await this.append(t.tavernDir, t.chatId, { type, speaker: who, text })
        this.deps.log.debug(`落盘 ${type} speaker=${who} ${[...text].length} 字`)
      } catch (e) {
        const msg = (e as Error).message
        if (s.warned.has(msg)) return
        s.warned.add(msg)
        this.deps.log.warn(`对话落盘失败（同类错误只提示一次）：${msg}`)
      }
    })
  }
}

/** 会话在聊天中且记录完整才给出目标；会话进入聊天后编号恒定，调用方可缓存。 */
export async function resolveChatTarget(agent: HostAgent, services: HostServices, log: Log): Promise<ChatTarget | null> {
  const cc = await buildContext(agent, services, log)
  if (cc.state !== 'chatting' || !cc.tavern || !cc.record?.chatId || !cc.record.characterId) return null
  return { tavernDir: cc.tavern.dir, chatId: cc.record.chatId, characterId: cc.record.characterId }
}
