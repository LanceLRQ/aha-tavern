// 群聊的朗读（二期规格 §13.1）：一轮回复拆出的每一段（旁白、各角色台词）按各自音色分别合成、依次播放，
// 不拼成一段文字。合成与播放复用单聊的 Speaker（进程唯一的朗读队列），这里只做"按段分音色"的编排：
// 把各段规划出的句子并成一个请求、逐句标注音色，段与段之间按换段停顿。
// 旁白用固定的旁白音色（插件配置指定，缺省用随包参考录音）；角色没登记音色的段跳过，不拦住别的段。
import { readCharacter } from '../core/card'
import { readChatAutoRead, readRecords, setChatAutoRead } from '../core/chat'
import { expandHome } from '../core/fsx'
import type { GroupLine } from '../core/group-log'
import { planSpeech, type SpeechGap } from '../core/speech-text'
import { readVoice } from '../core/voice'
import type { CommandHandler, HostAgent, HostServices } from './context'
import { resolveGroupTarget, type GroupTarget } from './group-transcript'
import {
  autoReadOffReceipt, autoReadOnReceipt, autoReadReadonlyReceipt, failureReceipt, speakBlockedReceipt,
  speakNarratorNoVoiceReceipt, speakNoReplyReceipt, speakNoVoicesReceipt, speakNothingReceipt,
  speakStartedGroupReceipt, speakStoppedReceipt, type SpeakBlock,
} from './receipts'
import type { Runtime } from './runtime'
import {
  checkService, parseSpeakArgs, realSpeakEnv, sharedSpeaker, type SpeakEnv, type SpeakRequest, type SpeakVoice, type Speaker,
} from './speak'
import { builtinVoice } from './voice'
import { isReadonly } from './writable'

/** 群聊朗读的环境：单聊 SpeakEnv 之外，还要能读配置（旁白音色目录）与随包资源目录。 */
export interface GroupSpeakEnv extends SpeakEnv {
  rt: Pick<Runtime, 'log' | 'voiceSettings' | 'config' | 'builtinAssetsDir'>
}

/**
 * 旁白音色：配置指定的目录（voice_ref.wav 与 voice_ref.txt 成对，与角色音色同样的约定）；
 * 没配置时用随包参考录音（与语音预热、自检试念用的同一段）。读不出（目录里缺文件）为 null。
 */
export async function narratorVoice(rt: Pick<Runtime, 'config' | 'builtinAssetsDir'>): Promise<SpeakVoice | null> {
  const configured = rt.config.narratorVoiceDir.trim()
  if (configured !== '') {
    try {
      const v = await readVoice(expandHome(configured))
      return v.ok ? { audio: v.audioPath, text: v.text } : null
    } catch {
      return null
    }
  }
  const builtin = builtinVoice(rt)
  return { audio: builtin.file, text: builtin.text }
}

/**
 * 逐段给出音色：narrator 段用旁白音色，character 段用该角色目录里的音色。
 * 同一轮里同一个角色说多段只读一次；角色卡读不出或没登记音色为 null（该段跳过）。
 */
export async function lineVoices(
  rt: Pick<Runtime, 'config' | 'builtinAssetsDir'>, tavernDir: string, lines: readonly GroupLine[],
): Promise<(SpeakVoice | null)[]> {
  const narrator = await narratorVoice(rt)
  const cache = new Map<string, SpeakVoice | null>()
  const ofCharacter = async (id: string | undefined): Promise<SpeakVoice | null> => {
    if (!id) return null
    if (cache.has(id)) return cache.get(id) ?? null
    let voice: SpeakVoice | null = null
    try {
      const entry = await readCharacter(tavernDir, id)
      const v = entry ? await readVoice(entry.dir) : null
      voice = v?.ok ? { audio: v.audioPath, text: v.text } : null
    } catch {
      voice = null
    }
    cache.set(id, voice)
    return voice
  }
  return Promise.all(lines.map((l) => (l.kind === 'narrator' ? Promise.resolve(narrator) : ofCharacter(l.speaker))))
}

export interface GroupSpeakPlan {
  sentences: string[]
  gaps: SpeechGap[]
  skipped: number[]
  voices: SpeakVoice[]
  /** 有可念的字、但没有可用音色而被跳过的段数。 */
  silent: number
  truncated: boolean
}

/**
 * 把各段按各自音色规划成一个朗读请求：段内照 planSpeech 的间隔，段与段之间按换段停顿（break）。
 * 取字后没有可念字的段（如只有图片行）不计入 silent；有字但没音色的段计入。
 */
export function planGroupSpeech(
  lines: readonly GroupLine[], voices: readonly (SpeakVoice | null)[], mode: 'lines' | 'all',
): GroupSpeakPlan {
  const out: GroupSpeakPlan = { sentences: [], gaps: [], skipped: [], voices: [], silent: 0, truncated: false }
  lines.forEach((line, i) => {
    const plan = planSpeech(line.text, { mode })
    if (plan.sentences.length === 0) return
    const voice = voices[i] ?? null
    if (!voice) {
      out.silent += 1
      return
    }
    const first = out.sentences.length > 0
    plan.sentences.forEach((text, j) => {
      out.sentences.push(text)
      out.gaps.push(first && j === 0 ? 'break' : plan.gaps[j] ?? 'none')
      out.skipped.push(first && j === 0 ? 0 : plan.skipped[j] ?? 0)
      out.voices.push(voice)
    })
    out.truncated ||= plan.truncated
  })
  return out
}

/** 把规划好的各段并成一个朗读请求；voice 是整段的缺省音色（这里每句都有各自的 voices，取第一句的）。 */
function groupSpeakRequest(
  plan: GroupSpeakPlan, settings: SpeakRequest['settings'], player: SpeakRequest['player'], owner: string,
): SpeakRequest {
  return {
    sentences: plan.sentences, gaps: plan.gaps, skipped: plan.skipped, voices: plan.voices, voice: plan.voices[0]!,
    settings, player, owner,
  }
}

/**
 * 最近一轮的段（手动 `/aha 朗读` 不带文本时念的内容）：原始记录里最后一条用户记录之后的全部分 Narrator
 * 与台词，按记录顺序还原成 GroupLine；还没有用户记录时取全部（开场那一轮）。
 * 从盘上记录取而不是从内存里的落盘器取：重开会话后也能念，且不依赖落盘器的生命周期。
 * 会把整份原始记录读进内存，但只在手动命令触发，可以接受。
 */
export async function latestRoundLines(tavernDir: string, chatId: string): Promise<GroupLine[] | null> {
  const { records } = await readRecords(tavernDir, chatId)
  const start = records.map((r) => r.type).lastIndexOf('user') + 1
  const lines: GroupLine[] = []
  for (const r of records.slice(start)) {
    if (typeof r.text !== 'string' || r.text === '') continue
    if (r.type === 'narrator') lines.push({ kind: 'narrator', text: r.text })
    else if (r.type === 'character') {
      lines.push({ kind: 'character', ...(typeof r.speaker === 'string' && r.speaker !== '' ? { speaker: r.speaker } : {}), text: r.text })
    }
  }
  return lines.length > 0 ? lines : null
}

// ---------- 自动朗读 ----------

interface GroupSessionSpeech {
  /** 这一轮里已提交、还没念过的段 */
  pending: GroupLine[]
  target?: GroupTarget
  /** 自动朗读开关的缓存；未读过为 undefined */
  autoRead?: boolean
  /** 已提示过的原因 */
  skipped: Set<string>
  /** 见过的用户消息条数，用来识别"同一轮"与作废过期的回复 */
  userSeq: number
  /** 最近一次朗读所属的轮次 */
  lastKey?: string
  /** pre-step 最近见到的轮次号 */
  turn?: number
  /** 轮次收尾的处理链：同一会话的处理按到达顺序串行 */
  chain: Promise<void>
}

/**
 * 按会话跟踪一轮里已拆分落盘的段，在轮次正常结束时按各自音色念出来。
 * 与单聊的 AutoReader 同构：被停止的轮次不经过 turn-stopping，残留的段在下一次见到用户消息时清掉。
 */
export class GroupAutoReader {
  private readonly sessions = new Map<string, GroupSessionSpeech>()

  constructor(
    private readonly env: GroupSpeakEnv,
    private readonly resolveTarget: (agent: HostAgent) => Promise<GroupTarget | null>,
  ) {}

  private state(id: string): GroupSessionSpeech {
    let s = this.sessions.get(id)
    if (!s) {
      s = { pending: [], skipped: new Set(), userSeq: 0, chain: Promise.resolve() }
      this.sessions.set(id, s)
    }
    return s
  }

  /** 一段回复拆分落盘后同步调用；lines 是这一段拆出的旁白与台词。 */
  onReply(session: string, lines: readonly GroupLine[]): void {
    this.state(session).pending.push(...lines)
  }

  /**
   * pre-step：轮次变了（上一轮被停止，回复没经过收尾）就清掉残留的段；
   * 见到新的用户消息也清，并停下属于这个会话的朗读。
   */
  onStep(session: string, turn: unknown, newUserMessages: number): void {
    const s = this.state(session)
    if (typeof turn === 'number') {
      if (s.turn !== undefined && s.turn !== turn) s.pending = []
      s.turn = turn
    }
    if (newUserMessages <= 0) return
    s.userSeq += 1
    s.pending = []
    void this.env.speaker.stopIfOwner(session)
  }

  /** 开关命令改了开关后更新缓存。 */
  setFlag(session: string, value: boolean): void {
    this.state(session).autoRead = value
  }

  forget(session: string): void {
    this.sessions.delete(session)
    void this.env.speaker.stopIfOwner(session)
  }

  /**
   * agent/turn-stopping：取走这一轮已提交的段，开着自动朗读且能念时按各自音色交给朗读队列。
   * 同一轮第二次收尾只会拿到新提交的段，追加到正在念的后面。从不拒绝。
   */
  onTurnStopping(agent: HostAgent, turn: unknown): Promise<void> {
    const s = this.sessions.get(agent.id)
    if (!s || s.pending.length === 0) return Promise.resolve()
    // 取走段要同步完成，保证提交顺序；检查可能很慢，处理再按会话串行，免得后一批抢在前一批前面开口
    const lines = s.pending.splice(0)
    // 'all' 取字是 'lines' 的超集：连它都取不出字（比如只有图片行）就不必再做任何检查
    if (!lines.some((l) => planSpeech(l.text, { mode: 'all' }).sentences.length > 0)) return Promise.resolve()
    const seq = s.userSeq
    const key = typeof turn === 'number' ? `t${turn}` : `u${seq}`
    s.chain = s.chain.then(() => this.speakTurn(agent, s, lines, seq, key))
    return s.chain
  }

  private async speakTurn(agent: HostAgent, s: GroupSessionSpeech, lines: readonly GroupLine[], seq: number, key: string): Promise<void> {
    try {
      const target = s.target ?? (await this.resolveTarget(agent))
      if (!target) return
      s.target = target
      s.autoRead ??= await readChatAutoRead(target.tavernDir, target.chatId)
      if (!s.autoRead) return
      const ready = await checkService(this.env)
      // 等待期间会话销毁、或用户又发了消息：这批段已经过期
      if (this.sessions.get(agent.id) !== s || s.userSeq !== seq) return
      if (!ready.ok) {
        this.skip(agent.id, s, ready.block)
        return
      }
      const voices = await lineVoices(this.env.rt, target.tavernDir, lines)
      const plan = planGroupSpeech(lines, voices, ready.settings.read)
      if (plan.sentences.length === 0) {
        if (plan.silent > 0) this.skip(agent.id, s, 'no-voice')
        return
      }
      const req = groupSpeakRequest(plan, ready.settings, ready.player, agent.id)
      if (s.lastKey === key) this.env.speaker.append(req)
      else this.env.speaker.speak(req)
      s.lastKey = key
    } catch (e) {
      this.env.rt.log.warn(`群聊自动朗读出错：${(e as Error).message}`)
    }
  }

  private skip(session: string, s: GroupSessionSpeech, reason: SpeakBlock): void {
    if (s.skipped.has(reason)) return
    s.skipped.add(reason)
    this.env.rt.log.debug(`群聊自动朗读跳过（会话 ${session}）：${reason}`)
  }
}

// ---------- 命令 ----------

/** `朗读` 命令（群聊）：不带文本念上一轮的全部内容（按段、按各自音色），带文本用旁白音色念。 */
export function groupSpeakHandler(env: GroupSpeakEnv, auto: GroupAutoReader): CommandHandler {
  return async (inv) => {
    const { theme, context, agent } = inv
    const parsed = parseSpeakArgs(inv.args)
    if (parsed.kind === 'stop') {
      void env.speaker.stop()
      return speakStoppedReceipt()
    }
    const tavern = context.tavern
    const chatId = context.record?.chatId
    if (!tavern || !chatId) return failureReceipt('找不到这场聊天的记录')

    if (parsed.kind !== 'text') {
      if (isReadonly(tavern)) return autoReadReadonlyReceipt(theme)
      const on = parsed.kind === 'on'
      await setChatAutoRead(tavern.dir, chatId, on)
      auto.setFlag(agent.id, on)
      if (!on) {
        void env.speaker.stop()
        return autoReadOffReceipt()
      }
      const ready = await checkService(env)
      return autoReadOnReceipt(ready.ok ? null : ready.block, theme)
    }

    const ready = await checkService(env)
    if (!ready.ok) return speakBlockedReceipt(ready.block, theme)
    const mode = ready.settings.read
    if (parsed.text !== '') {
      // 带文本时没有说话人：用旁白音色念（在测试里固化）
      const narrator = await narratorVoice(env.rt)
      if (!narrator) return speakNarratorNoVoiceReceipt(env.rt.config.narratorVoiceDir.trim())
      const plan = planSpeech(parsed.text, { mode })
      if (plan.sentences.length === 0) return speakNothingReceipt()
      env.speaker.speak({
        sentences: plan.sentences, gaps: plan.gaps, skipped: plan.skipped, voice: narrator,
        settings: ready.settings, player: ready.player, owner: agent.id,
      })
      return speakStartedGroupReceipt(plan.sentences.length, plan.truncated, 0)
    }
    const lines = await latestRoundLines(tavern.dir, chatId)
    if (!lines) return speakNoReplyReceipt()
    const voices = await lineVoices(env.rt, tavern.dir, lines)
    const plan = planGroupSpeech(lines, voices, mode)
    if (plan.sentences.length === 0) return plan.silent > 0 ? speakNoVoicesReceipt(theme) : speakNothingReceipt()
    env.speaker.speak(groupSpeakRequest(plan, ready.settings, ready.player, agent.id))
    return speakStartedGroupReceipt(plan.sentences.length, plan.truncated, plan.silent)
  }
}

// ---------- 装配 ----------

export interface GroupSpeaking {
  speaker: Speaker
  auto: GroupAutoReader
  handler: CommandHandler
}

/** 群聊实例的朗读装配：命令处理函数与自动朗读跟踪器，共用进程唯一的朗读队列。 */
export function createGroupSpeaking(rt: Runtime, getServices: () => HostServices | undefined): GroupSpeaking {
  const speaker = sharedSpeaker(rt.log)
  const env: GroupSpeakEnv = { ...realSpeakEnv(rt, speaker), rt }
  const auto = new GroupAutoReader(env, async (agent) => {
    const services = getServices()
    return services ? resolveGroupTarget(agent, services, rt) : Promise.resolve(null)
  })
  return { speaker, auto, handler: groupSpeakHandler(env, auto) }
}
