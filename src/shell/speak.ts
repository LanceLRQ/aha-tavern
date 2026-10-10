// 朗读：把角色的话念出来。全程不调用模型（不 steer、不 inject）。
// Speaker 是整个进程唯一的朗读队列（筹备与单聊两个插件实例共用）：合成与播放两段流水，
// 合成最多领先播放一句；音频写系统临时目录，播完即删。
// 宿主在命令运行期间会锁住同一会话的输入框，所以命令只做同步排队就返回，合成与播放在后台进行，
// 后台出错只记日志与最近一次错误（供自检读取），不做任何事后提示。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readCharacter } from '../core/card'
import { readChatAutoRead, readRecords, setChatAutoRead } from '../core/chat'
import { findPlayer, PlayerError, play, type Player, type PlayerSpawn } from '../core/player'
import { hasUserInfo, type VoiceServiceSettings } from '../core/services'
import { planSpeech, type SpeechGap, type SpeechPlan } from '../core/speech-text'
import { createTtsClient, TtsError, type TtsClient } from '../core/tts'
import { readVoice } from '../core/voice'
import { trimWavSilence } from '../core/wav-trim'
import type { CommandHandler, HostAgent, HostServices } from './context'
import { redactUrls } from './draw-doctor'
import {
  autoReadOffReceipt, autoReadOnReceipt, autoReadReadonlyReceipt, failureReceipt, speakBlockedReceipt,
  speakNoReplyReceipt, speakNothingReceipt, speakStartedReceipt, speakStoppedReceipt, type SpeakBlock,
} from './receipts'
import type { Log, Runtime } from './runtime'
import { resolveChatTarget, type ChatTarget } from './transcript'
import { isLaunching, whichOnPath } from './voice'
import { isReadonly } from './writable'

/** 开始朗读前探测语音服务的时限。 */
const PROBE_MS = 2000

const noop = (): void => undefined

/** 同一段连续要念的话里，相邻两句之间停多久（毫秒）。 */
export const INLINE_PAUSE_MS = 500

// ---------- 朗读队列 ----------

export interface SpeakerDeps {
  createClient(endpoint: string): Pick<TtsClient, 'synthesize'>
  play(player: Player, file: string, opts: { signal?: AbortSignal }): Promise<void>
  /** 给出一个新的临时文件路径（随机名）。 */
  tempFile(): string
  /** 独占创建并写入；文件已存在时失败。 */
  writeFile(file: string, bytes: Uint8Array): Promise<void>
  /** 删除；文件不存在不算错。 */
  removeFile(file: string): Promise<void>
  /** 等 ms 毫秒；signal 中止时立即结束（不抛错，调用方自己检查 signal）。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
  /** 换段时最多等上一段收尾多久（毫秒），默认 2000。 */
  settleLimitMs?: number
  log: Pick<Log, 'debug' | 'warn'>
}

export interface SpeakRequest {
  sentences: readonly string[]
  /** 与 sentences 等长：每句之前的间隔种类；不给就一律不停顿（单句试念等）。 */
  gaps?: readonly SpeechGap[]
  /** 参考录音的绝对路径与录音里说的话。 */
  voice: { audio: string; text: string }
  settings: Pick<VoiceServiceSettings, 'endpoint' | 'model' | 'language' | 'timeoutSeconds' | 'pauseSeconds'> & Partial<Pick<VoiceServiceSettings, 'local'>>
  player: Player
  /** 会话编号：会话销毁、或该会话来了新的用户消息时，据此停下属于它的朗读。 */
  owner: string
}

export interface SpeakError {
  kind: string
  at: number
  /** 当时的语音服务不在本机（服务读不到这台机器上的参考录音是常见原因）。 */
  remote?: boolean
}

/** 一段朗读的结局：念完 / 出错（带种类）/ 被停下或顶掉 / 等待超时。 */
export type SpeakOutcome =
  | { status: 'ok' }
  | { status: 'failed'; kind: string }
  | { status: 'stopped' }
  | { status: 'timeout' }

interface QueueItem {
  text: string
  gap: SpeechGap
}

/** 已合成好、等待播放的一句。 */
interface Ready {
  file: string
  gap: SpeechGap
}

interface Run {
  owner: string
  /** 播放用的播放器 */
  player: Player
  /** 合成请求；只播放现成文件的那一段为 null */
  req: SpeakRequest | null
  queue: QueueItem[]
  ctl: AbortController
  /** 已写出、尚未删除的临时文件 */
  files: Set<string>
  /** 不再接受追加 */
  closed: boolean
  client: Pick<TtsClient, 'synthesize'> | null
  /** 已发起、尚未取用的下一句合成（最多领先播放一句） */
  ahead: Promise<Ready> | null
  /** 正在播放一句 */
  playing: boolean
  finished: Promise<void>
  /** 这一段的结局；收尾前一直是 stopped（被停下或顶掉就是这个）。 */
  outcome: SpeakOutcome
}

export class Speaker {
  private current: Run | null = null
  private lastErr: SpeakError | null = null
  /** 最近开始的那一段的收尾；新的一段在第一次播放前等它（被顶掉或停下的旧段进程可能还没退） */
  private lastFinished: Promise<void> = Promise.resolve()

  constructor(private readonly deps: SpeakerDeps) {}

  /** 顶掉正在念的，开始念这一批。只做同步的排队，不等合成。 */
  speak(req: SpeakRequest): void {
    if (req.sentences.length === 0) return
    this.begin({
      owner: req.owner, player: req.player, req, queue: req.sentences.map((text, i) => ({ text, gap: req.gaps?.[i] ?? 'none' })), ctl: new AbortController(), files: new Set(),
      closed: false, client: this.deps.createClient(req.settings.endpoint), ahead: null, playing: false,
      finished: Promise.resolve(), outcome: { status: 'stopped' },
    })
  }

  /** 顶掉正在念的，开始这一段。 */
  private begin(run: Run): void {
    const prev = this.current
    this.current = run
    prev?.ctl.abort()
    run.finished = this.loop(run, this.lastFinished)
    this.lastFinished = run.finished
  }

  /**
   * 同 speak，但等这一段结束再返回：念完、出错、被停下或顶掉、超过 timeoutMs、signal 中止都会返回。
   * 超时与中止时会停下这一段。
   */
  async speakAndWait(req: SpeakRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SpeakOutcome> {
    if (req.sentences.length === 0) return { status: 'ok' }
    if (opts.signal?.aborted) return { status: 'stopped' }
    this.speak(req)
    return this.waitRun(this.current!, opts)
  }

  /**
   * 顶掉正在念的，播放一个现成的音频文件并等它结束；不经合成，也不删这个文件（归调用方管）。
   * 结局与超时、中止的处理同 speakAndWait。
   */
  async playFileAndWait(
    file: string, opts: { player: Player; owner: string; limitMs: number; signal?: AbortSignal },
  ): Promise<SpeakOutcome> {
    if (opts.signal?.aborted) return { status: 'stopped' }
    const run: Run = {
      owner: opts.owner, player: opts.player, req: null, queue: [], ctl: new AbortController(), files: new Set(),
      closed: false, client: null, ahead: Promise.resolve({ file, gap: 'none' }), playing: false, finished: Promise.resolve(),
      outcome: { status: 'stopped' },
    }
    this.begin(run)
    return this.waitRun(run, { timeoutMs: opts.limitMs, ...(opts.signal ? { signal: opts.signal } : {}) })
  }

  private async waitRun(run: Run, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SpeakOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<'timeout' | 'aborted'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs)
      onAbort = () => resolve('aborted')
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const first = await Promise.race([run.finished.then(() => 'done' as const), interrupted])
      if (first === 'done') return run.outcome
      run.ctl.abort()
      await run.finished
      return first === 'timeout' ? { status: 'timeout' } : { status: 'stopped' }
    } finally {
      clearTimeout(timer)
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 同一来源正在念时追加到队尾，否则等同于 speak。 */
  append(req: SpeakRequest): void {
    if (req.sentences.length === 0) return
    const cur = this.current
    if (cur && !cur.closed && cur.owner === req.owner) {
      // 接到上一段末尾：第一句与前面隔着一个段落
      cur.queue.push(...req.sentences.map((text, i): QueueItem => ({ text, gap: i === 0 ? 'break' : (req.gaps?.[i] ?? 'none') })))
      this.prefetch(cur)
      return
    }
    this.speak(req)
  }

  /** 取消未完成的请求、结束播放进程、清空队列、删掉临时文件；返回的 Promise 在收尾完成后结束。 */
  stop(): Promise<void> {
    const run = this.current
    if (!run) return Promise.resolve()
    this.current = null
    run.ctl.abort()
    return run.finished
  }

  stopIfOwner(owner: string): Promise<void> {
    return this.current?.owner === owner ? this.stop() : Promise.resolve()
  }

  /** 正在念的来源；没在念为 null。 */
  owner(): string | null {
    return this.current?.owner ?? null
  }

  /** 最近一次后台失败的原因类别与时间；其后整段念完过则为 null。 */
  lastError(): SpeakError | null {
    return this.lastErr
  }

  /** 等上一段收尾完成，最多等 settleLimitMs，免得它卡住时这一段永远不出声。 */
  private async waitPrevious(before: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.settleLimitMs ?? 2000) })
    try {
      await Promise.race([before, limit])
    } finally {
      clearTimeout(timer)
    }
  }

  private async loop(run: Run, before: Promise<void>): Promise<void> {
    let waited = false
    try {
      this.prefetch(run, true)
      while (run.ahead) {
        const { file, gap } = await run.ahead
        run.ahead = null
        this.prefetch(run, true)
        if (!waited) {
          waited = true
          await this.waitPrevious(before)
        }
        // 等待期间合成已在领先；stop 或被顶掉时等待立即结束，不再播放
        const pauseMs = this.pauseMs(run, gap)
        if (pauseMs > 0) {
          await this.deps.sleep(pauseMs, run.ctl.signal)
          if (run.ctl.signal.aborted) break
        }
        run.playing = true
        try {
          await this.deps.play(run.player, file, { signal: run.ctl.signal })
        } finally {
          run.playing = false
        }
        // 只删自己合成的临时文件；现成文件归调用方管
        if (run.files.delete(file)) await this.drop(file)
        this.prefetch(run, true)
      }
      if (!run.ctl.signal.aborted) {
        this.lastErr = null
        run.outcome = { status: 'ok' }
      }
    } catch (e) {
      if (!run.ctl.signal.aborted) run.outcome = { status: 'failed', kind: this.fail(e, run.req?.settings.local === false) }
    } finally {
      run.closed = true
      if (this.current === run) this.current = null
      run.ctl.abort()
      try {
        await run.ahead
      } catch {
        // 已被取消或已记录
      }
      await Promise.all([...run.files].map((f) => this.drop(f)))
      run.files.clear()
    }
  }

  /** 播放这一句之前要等多久（毫秒）。 */
  private pauseMs(run: Run, gap: SpeechGap): number {
    if (gap === 'inline') return INLINE_PAUSE_MS
    if (gap === 'break') return Math.round((run.req?.settings.pauseSeconds ?? 0) * 1000)
    return 0
  }

  /** 队列里还有句子、且没有领先的合成时，发起下一句；force 为假时只在正在播放时发起。 */
  private prefetch(run: Run, force = false): void {
    if (run.ahead !== null || (!force && !run.playing)) return
    const item = run.queue.shift()
    if (item === undefined) return
    run.ahead = this.synth(run, item)
    run.ahead.catch(noop)
  }

  private async synth(run: Run, { text, gap }: QueueItem): Promise<Ready> {
    const { req, client } = run
    if (!req || !client) throw new TtsError('other', 'synth without request')
    const { voice, settings } = req
    const audio = await client.synthesize(
      { kind: 'clone', model: settings.model, text, refAudio: voice.audio, refText: voice.text, language: settings.language },
      { timeoutMs: settings.timeoutSeconds * 1000, signal: run.ctl.signal },
    )
    if (run.ctl.signal.aborted) throw new TtsError('cancelled')
    const file = this.deps.tempFile()
    run.files.add(file)
    await this.deps.writeFile(file, trimWavSilence(audio.bytes))
    return { file, gap }
  }

  private async drop(file: string): Promise<void> {
    try {
      await this.deps.removeFile(file)
    } catch (e) {
      this.deps.log.warn(`删除临时音频失败：${(e as Error).message}`)
    }
  }

  /** 记下最近一次失败，返回归类后的种类。 */
  private fail(e: unknown, remote = false): string {
    const known = e instanceof TtsError || e instanceof PlayerError
    const kind = known ? e.kind : 'other'
    const detail = known ? e.detail || e.message : e instanceof Error ? e.message : String(e)
    this.lastErr = { kind, at: this.deps.now(), ...(remote ? { remote: true } : {}) }
    this.deps.log.warn(`朗读中断（${kind}）：${redactUrls(detail)}`)
    return kind
  }
}

/** 播放器不要占用终端的输入输出。 */
export const quietSpawn: PlayerSpawn = (command, args) => spawn(command, args, { stdio: 'ignore' })

/** 等 ms 毫秒；signal 中止时立即结束。 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export function realSpeakerDeps(log: Pick<Log, 'debug' | 'warn'>): SpeakerDeps {
  return {
    createClient: (endpoint) => createTtsClient({ endpoint, fetch: globalThis.fetch }),
    play: (player, file, opts) => play(player, file, { spawn: quietSpawn, ...(opts.signal ? { signal: opts.signal } : {}) }),
    tempFile: () => path.join(os.tmpdir(), `aha-speak-${randomBytes(8).toString('hex')}.wav`),
    writeFile: (file, bytes) => fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }),
    removeFile: (file) => fs.rm(file, { force: true }),
    sleep: abortableSleep,
    now: Date.now,
    log,
  }
}

let shared: Speaker | undefined
/** 整个进程唯一的朗读队列；第一次调用时用传入的日志创建。 */
export function sharedSpeaker(log: Pick<Log, 'debug' | 'warn'>): Speaker {
  shared ??= new Speaker(realSpeakerDeps(log))
  return shared
}

// ---------- 朗读前的检查 ----------

export interface SpeakEnv {
  rt: Pick<Runtime, 'log' | 'voiceSettings'>
  speaker: Speaker
  /** 探测语音服务（2 秒内）；不通则拒绝。 */
  probe(endpoint: string): Promise<unknown>
  findPlayer(): Promise<Player | null>
  /** 该权重目录上是否有进行中的启动。 */
  isLaunching(modelsDir: string): boolean
}

export type Readiness =
  | { ok: true; settings: VoiceServiceSettings; voice: { audio: string; text: string }; player: Player }
  | { ok: false; block: SpeakBlock }

/** 按固定顺序检查能不能朗读：配置、地址、服务、音色、播放器；命中即停。 */
export async function checkReadiness(
  env: SpeakEnv, target: Pick<ChatTarget, 'tavernDir' | 'characterId'>,
): Promise<Readiness> {
  const blocked = (block: SpeakBlock): Readiness => ({ ok: false, block })
  const cfg = await env.rt.voiceSettings()
  if (!cfg.configured) return blocked('not-configured')
  const s = cfg.settings
  if (hasUserInfo(s.endpoint)) return blocked('user-info')
  // 进程能应答 /v1/models 不等于能念：模型可能还在下载或加载，启动没结束一律按"启动中"处理
  if (env.isLaunching(s.modelsDir)) return blocked('starting')
  try {
    await env.probe(s.endpoint)
  } catch {
    return blocked('unreachable')
  }
  const entry = await readCharacter(target.tavernDir, target.characterId)
  const voice = entry ? await readVoice(entry.dir) : null
  if (!voice?.ok) return blocked('no-voice')
  const player = await env.findPlayer()
  if (!player) return blocked('no-player')
  return { ok: true, settings: s, voice: { audio: voice.audioPath, text: voice.text }, player }
}

// ---------- 自动朗读 ----------

interface SessionSpeech {
  /** 这一轮里已提交、还没念过的角色回复 */
  pending: string[]
  target?: ChatTarget
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
 * 按会话跟踪一轮里的角色回复，在轮次正常结束时念出来。
 * 被停止的轮次不经过 turn-stopping，残留的回复在下一次见到用户消息时清掉。
 */
export class AutoReader {
  private readonly sessions = new Map<string, SessionSpeech>()

  constructor(
    private readonly env: SpeakEnv,
    private readonly resolveTarget: (agent: HostAgent) => Promise<ChatTarget | null>,
  ) {}

  private state(id: string): SessionSpeech {
    let s = this.sessions.get(id)
    if (!s) {
      s = { pending: [], skipped: new Set(), userSeq: 0, chain: Promise.resolve() }
      this.sessions.set(id, s)
    }
    return s
  }

  /** 角色的一段回复提交时调用。 */
  onReply(session: string, text: string): void {
    this.state(session).pending.push(text)
  }

  /**
   * pre-step：轮次变了（上一轮被停止，回复没经过收尾）就清掉残留的回复；
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
   * agent/turn-stopping：取走这一轮已提交的回复，开着自动朗读且能念时交给朗读队列。
   * 同一轮第二次收尾（补发图片之后）只会拿到新提交的那段，追加到正在念的后面。从不拒绝。
   */
  onTurnStopping(agent: HostAgent, turn: unknown): Promise<void> {
    const s = this.sessions.get(agent.id)
    if (!s || s.pending.length === 0) return Promise.resolve()
    // 取走回复要同步完成，保证提交顺序；检查可能很慢，处理再按会话串行，免得后一批抢在前一批前面开口
    const text = s.pending.splice(0).join('\n\n')
    // 'all' 取字是 'lines' 的超集：连它都念不出东西（比如只有图片行）就不必再做任何检查
    if (planSpeech(text, { mode: 'all' }).sentences.length === 0) return Promise.resolve()
    const seq = s.userSeq
    const key = typeof turn === 'number' ? `t${turn}` : `u${seq}`
    s.chain = s.chain.then(() => this.speakTurn(agent, s, text, seq, key))
    return s.chain
  }

  private async speakTurn(agent: HostAgent, s: SessionSpeech, text: string, seq: number, key: string): Promise<void> {
    try {
      const target = s.target ?? (await this.resolveTarget(agent))
      if (!target) return
      s.target = target
      s.autoRead ??= await readChatAutoRead(target.tavernDir, target.chatId)
      if (!s.autoRead) return
      const ready = await checkReadiness(this.env, target)
      // 等待期间会话销毁、或用户又发了消息：这批回复已经过期
      if (this.sessions.get(agent.id) !== s || s.userSeq !== seq) return
      if (!ready.ok) {
        this.skip(agent.id, s, ready.block)
        return
      }
      const plan = planSpeech(text, { mode: ready.settings.read })
      if (plan.sentences.length === 0) return
      const req: SpeakRequest = {
        sentences: plan.sentences, gaps: plan.gaps, voice: ready.voice, settings: ready.settings, player: ready.player,
        owner: agent.id,
      }
      if (s.lastKey === key) this.env.speaker.append(req)
      else this.env.speaker.speak(req)
      s.lastKey = key
    } catch (e) {
      this.env.rt.log.warn(`自动朗读出错：${(e as Error).message}`)
    }
  }

  private skip(session: string, s: SessionSpeech, reason: SpeakBlock): void {
    if (s.skipped.has(reason)) return
    s.skipped.add(reason)
    this.env.rt.log.debug(`自动朗读跳过（会话 ${session}）：${reason}`)
  }
}

// ---------- 命令 ----------

export type SpeakArgs = { kind: 'on' | 'off' | 'stop' } | { kind: 'text'; text: string }

/** 参数恰好是开关词时是开关，否则是要念的文本（可以为空）。 */
export function parseSpeakArgs(args: string): SpeakArgs {
  const text = args.trim()
  switch (text.toLowerCase()) {
    case '开':
    case 'on':
      return { kind: 'on' }
    case '关':
    case 'off':
      return { kind: 'off' }
    case '停':
    case 'stop':
      return { kind: 'stop' }
    default:
      return { kind: 'text', text }
  }
}

/**
 * 这场聊天里最近一条取字后非空的角色回复；没有则 null。
 * 会把整份原始记录读进内存，但只在手动 `/aha 朗读` 不带参数时触发，可以接受。
 */
async function latestPlan(target: ChatTarget, mode: 'lines' | 'all'): Promise<SpeechPlan | null> {
  const { records } = await readRecords(target.tavernDir, target.chatId)
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r.type !== 'character' || typeof r.text !== 'string') continue
    const plan = planSpeech(r.text, { mode })
    if (plan.sentences.length > 0) return plan
  }
  return null
}

export function speakHandler(env: SpeakEnv, auto: AutoReader): CommandHandler {
  return async (inv) => {
    const { theme, context, agent } = inv
    const parsed = parseSpeakArgs(inv.args)
    if (parsed.kind === 'stop') {
      void env.speaker.stop()
      return speakStoppedReceipt()
    }
    const tavern = context.tavern
    const rec = context.record
    if (!tavern || !rec?.chatId || !rec.characterId) return failureReceipt('找不到这场聊天的记录')
    const target: ChatTarget = { tavernDir: tavern.dir, chatId: rec.chatId, characterId: rec.characterId }

    if (parsed.kind !== 'text') {
      if (isReadonly(tavern)) return autoReadReadonlyReceipt(theme)
      const on = parsed.kind === 'on'
      await setChatAutoRead(target.tavernDir, target.chatId, on)
      auto.setFlag(agent.id, on)
      if (!on) {
        void env.speaker.stop()
        return autoReadOffReceipt()
      }
      const ready = await checkReadiness(env, target)
      return autoReadOnReceipt(ready.ok ? null : ready.block, theme)
    }

    const ready = await checkReadiness(env, target)
    if (!ready.ok) return speakBlockedReceipt(ready.block, theme)
    const mode = ready.settings.read
    let plan: SpeechPlan | null
    if (parsed.text !== '') {
      plan = planSpeech(parsed.text, { mode })
      if (plan.sentences.length === 0) return speakNothingReceipt()
    } else {
      plan = await latestPlan(target, mode)
      if (!plan) return speakNoReplyReceipt()
    }
    env.speaker.speak({
      sentences: plan.sentences, gaps: plan.gaps, voice: ready.voice, settings: ready.settings, player: ready.player,
      owner: agent.id,
    })
    return speakStartedReceipt(plan.sentences.length, plan.truncated)
  }
}

// ---------- 装配 ----------

export interface Speaking {
  speaker: Speaker
  auto: AutoReader
  handler: CommandHandler
}

/** 真实环境下朗读前检查要用的依赖。 */
export function realSpeakEnv(rt: Runtime, speaker: Speaker = sharedSpeaker(rt.log)): SpeakEnv {
  return {
    rt,
    speaker,
    probe: (endpoint) => createTtsClient({ endpoint, fetch: globalThis.fetch }).probe(PROBE_MS),
    findPlayer: () => findPlayer({ platform: process.platform, which: whichOnPath }),
    isLaunching,
  }
}

/** 真实环境下的朗读装配：命令处理函数与自动朗读跟踪器，共用进程唯一的朗读队列。 */
export function createSpeaking(rt: Runtime, getServices: () => HostServices | undefined): Speaking {
  const speaker = sharedSpeaker(rt.log)
  const env = realSpeakEnv(rt, speaker)
  const auto = new AutoReader(env, async (agent) => {
    const services = getServices()
    return services ? resolveChatTarget(agent, services, rt.log) : null
  })
  return { speaker, auto, handler: speakHandler(env, auto) }
}
