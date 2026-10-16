// 群聊的对话逐段落盘（二期规格 §6、§10）：用户的话取自 pre-step 的入步消息，
// 回复按行首标记拆成旁白与台词分别入档；每条带场景序号。场景分界与旁白要求也从这里写。
import { appendRecord, readRecords, type ChatRecord } from '../core/chat'
import { listCharacters } from '../core/card'
import { parseGroupReply, type GroupLine, type KnownCharacter } from '../core/group-log'
import { buildContext, type HostAgent, type HostServices } from './context'
import type { Log, Runtime } from './runtime'
import { AttemptCollector, userRecordsOf, type StreamFrameLike, type UserMessageLike } from './transcript'
import type { Theme } from '../core/theme'
import { isReadonly } from './writable'

export interface GroupTarget {
  tavernDir: string
  chatId: string
  /** 名字匹配用的全部角色（含不在场的，规格 §15） */
  known: readonly KnownCharacter[]
  /** 行首认旁白的标记：主题对 narrator 的称呼，外加固定的「旁白」 */
  narratorLabels: readonly string[]
  /** 酒馆数据比插件新：只读，不写记录 */
  readonly?: boolean
}

type GroupAppendFn = (tavernDir: string, chatId: string, record: Omit<ChatRecord, 'time'> & { time?: string }) => Promise<void>

export interface GroupRecorderDeps {
  /** 会话在场景中则给出落盘目标，否则 null。 */
  resolve(agent: HostAgent): Promise<GroupTarget | null>
  log: Pick<Log, 'debug' | 'warn'>
  append?: GroupAppendFn
  /** 一段回复拆分落盘后调用（不论是否成功），给自动朗读用；比轮次收尾晚，收尾时要先 drain。 */
  onReply?(agent: HostAgent, lines: readonly GroupLine[]): void
  /** 一段回复一提交就同步调用，给出原文、不等落盘：轮次收尾的图片行核对靠它。 */
  onText?(agent: HostAgent, text: string): void
}

interface SessionState {
  seen: Set<string>
  collector: AttemptCollector
  /** 写入队列：同一会话的落盘按到达顺序串行 */
  tail: Promise<void>
  target: GroupTarget | null
  warned: Set<string>
  /** 当前场景序号；首次落盘时按盘上记录还原（1 + 场景分界数） */
  scene: number | null
}

export class GroupTranscriptRecorder {
  private readonly sessions = new Map<string, SessionState>()
  private readonly append: GroupAppendFn

  constructor(private readonly deps: GroupRecorderDeps) {
    this.append = deps.append ?? ((dir, id, rec) => appendRecord(dir, id, rec))
  }

  private state(id: string): SessionState {
    let s = this.sessions.get(id)
    if (!s) {
      s = { seen: new Set(), collector: new AttemptCollector(), tail: Promise.resolve(), target: null, warned: new Set(), scene: null }
      this.sessions.set(id, s)
    }
    return s
  }

  /** pre-step：入步消息里的用户的话（type user，说话人记"我"）。返回本步新见到的用户消息条数。 */
  onStep(agent: HostAgent, messages: readonly UserMessageLike[]): number {
    try {
      const s = this.state(agent.id)
      const records = userRecordsOf(messages, s.seen)
      for (const r of records) this.write(agent, s, { type: 'user', speaker: '我', text: r.text })
      return records.length
    } catch (e) {
      this.deps.log.warn(`群聊落盘（用户消息）出错：${(e as Error).message}`)
      return 0
    }
  }

  /** assistant-stream：回复流的一帧；整段提交后拆分落盘。 */
  onFrame(agent: HostAgent, frame: StreamFrameLike): void {
    try {
      const s = this.state(agent.id)
      const text = s.collector.feed(frame)
      if (text === null) return
      this.deps.onText?.(agent, text)
      const arrival = this.arrival(agent, s)
      s.tail = s.tail.then(async () => {
        const t = await arrival
        const lines = parseGroupReply(text, t?.known ?? [], t?.narratorLabels ?? ['旁白'])
        if (t) for (const line of lines) {
          await this.writeLine(agent, s, t, line)
        }
        this.deps.onReply?.(agent, lines)
      }).catch((e: unknown) => this.warnOnce(s, (e as Error).message))
    } catch (e) {
      this.deps.log.warn(`群聊落盘（回复流）出错：${(e as Error).message}`)
    }
  }

  /** 换场时写场景分界（新场景的序号、标题与在场名单，规格 §8.2），之后本会话的记录归新场景。 */
  writeSceneBoundary(agent: HostAgent, input: { title: string; cast: readonly string[] }): Promise<void> {
    const s = this.state(agent.id)
    const arrival = this.arrival(agent, s)
    const task = async (): Promise<void> => {
      const t = await arrival
      if (!t) return
      const next = this.sceneOf(s) + 1
      await this.append(t.tavernDir, t.chatId, { type: 'scene', text: input.title, cast: [...input.cast], scene: next })
      s.scene = next
    }
    return this.enqueue(s, task)
  }

  /** 用户通过 /aha 旁白 提的要求（不作为用户台词，规格 §7.2）。 */
  writeNarratorRequest(agent: HostAgent, text: string): Promise<void> {
    const s = this.state(agent.id)
    const arrival = this.arrival(agent, s)
    return this.enqueue(s, async () => {
      const t = await arrival
      if (!t) return
      await this.append(t.tavernDir, t.chatId, { type: 'narrator-request', text, scene: this.sceneOf(s) })
    })
  }

  /** 当前场景序号（还没落过盘、没还原过为 null；换场命令用它判断）。 */
  async currentScene(agent: HostAgent): Promise<number | null> {
    const s = this.state(agent.id)
    if (s.scene !== null) return s.scene
    const t = s.target ? Promise.resolve(s.target) : this.deps.resolve(agent)
    const target = await t.catch(() => null)
    if (!target) return null
    await this.restoreScene(s, target)
    return s.scene
  }

  /** 等该会话已入队的写入完成（测试与收尾用）。 */
  async drain(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.tail
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private sceneOf(s: SessionState): number {
    // 只在写队列里调用：write 前已还原过
    return s.scene ?? 1
  }

  private async restoreScene(s: SessionState, t: GroupTarget): Promise<void> {
    const { records } = await readRecords(t.tavernDir, t.chatId)
    // 场景分界带新场景的序号：取最后一条的序号；没有分界就是场景一
    let scene = 1
    for (const r of records) {
      if (r.type === 'scene' && typeof r.scene === 'number' && Number.isInteger(r.scene) && r.scene > 0) scene = r.scene
    }
    s.scene = scene
  }

  private arrival(agent: HostAgent, s: SessionState): Promise<GroupTarget | null> {
    const arrival: Promise<GroupTarget | null> = s.target ? Promise.resolve(s.target) : this.deps.resolve(agent)
    arrival.catch(() => undefined)
    return arrival
  }

  private enqueue(s: SessionState, task: () => Promise<void>): Promise<void> {
    const run = s.tail.then(task).catch((e: unknown) => {
      this.warnOnce(s, (e as Error).message)
    })
    s.tail = run
    return run
  }

  private warnOnce(s: SessionState, msg: string): void {
    if (s.warned.has(msg)) return
    s.warned.add(msg)
    this.deps.log.warn(`群聊落盘失败（同类错误只提示一次）：${msg}`)
  }

  private write(agent: HostAgent, s: SessionState, record: Omit<ChatRecord, 'time'>): void {
    const arrival = this.arrival(agent, s)
    void this.enqueue(s, async () => {
      const t = await arrival
      if (!t) return
      if (s.scene === null) await this.restoreScene(s, t)
      if (t.readonly) return
      await this.append(t.tavernDir, t.chatId, { ...record, scene: this.sceneOf(s) })
      this.deps.log.debug(`群聊落盘 ${record.type}${typeof record.speaker === 'string' ? ` speaker=${record.speaker}` : ''} scene=${this.sceneOf(s)}`)
    })
  }

  private async writeLine(agent: HostAgent, s: SessionState, t: GroupTarget, line: GroupLine): Promise<void> {
    if (t.readonly) return
    if (s.scene === null) await this.restoreScene(s, t)
    const record: Omit<ChatRecord, 'time'> = line.kind === 'character'
      ? { type: 'character', speaker: line.speaker ?? '', text: line.text }
      : { type: 'narrator', text: line.text, ...(line.userImpersonated ? { userImpersonated: true } : {}) }
    await this.append(t.tavernDir, t.chatId, { ...record, scene: this.sceneOf(s) })
  }
}

/** 会话在场景中且记录完整才给出目标；会话进入场景后编号恒定，调用方可缓存。 */
export async function resolveGroupTarget(
  agent: HostAgent, services: HostServices, rt: Pick<Runtime, 'log' | 'theme'>,
): Promise<GroupTarget | null> {
  const cc = await buildContext(agent, services, rt.log)
  if (cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return null
  const known: KnownCharacter[] = []
  for (const e of await listCharacters(cc.tavern.dir)) {
    known.push(e.ok ? { id: e.card.id, name: e.card.name } : { id: e.dirName, name: e.dirName })
  }
  const theme: Theme = await rt.theme()
  const labels = new Set<string>([theme.concept('narrator'), '旁白'])
  return {
    tavernDir: cc.tavern.dir, chatId: cc.record.chatId, known, narratorLabels: [...labels],
    ...(isReadonly(cc.tavern) ? { readonly: true } : {}),
  }
}
