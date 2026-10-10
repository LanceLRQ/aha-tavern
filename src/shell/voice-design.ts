// 筹备模式的音色设计工具 aha_voice_design：按文字描述生成几段试听，由用户在卡片上试听、挑选，采用后存为角色音色。
// 全程不 steer、不 inject；返回值是给掌柜看的文字（英文固定标识加简短说明），不带服务端原文与临时文件路径。
// 整个流程持有同一会话的卡片队列，流程里的各张卡片直接发，不再各自排队。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findPlayer, type Player } from '../core/player'
import { hasUserInfo, VOICE_DESIGN_MODEL, type VoiceServiceSettings } from '../core/services'
import { createTtsClient, TtsError, type TtsClient } from '../core/tts'
import { MAX_VOICE_SECONDS, MIN_VOICE_SECONDS, readVoice, saveDesignedVoice, wavInfo } from '../core/voice'
import { inspect as inspectServer, modelDownloaded } from '../core/voice-server'
import { answerItem, isAbort, shownName, type AskFn, type AskItem, type DeclineTracker, type SessionGate } from './confirm'
import type { HostAgent } from './context'
import { redactUrls } from './draw-doctor'
import {
  VOICE_DESIGN_OPT_AGAIN, VOICE_DESIGN_OPT_BACK, VOICE_DESIGN_OPT_DOWNLOAD, VOICE_DESIGN_OPT_REGEN, VOICE_DESIGN_OPT_USE,
  VOICE_DESIGN_TEXT as T, parseVoiceDesignSegment, voiceDesignDownloadQuestion, voiceDesignListQuestion,
  voiceDesignPickQuestion, voiceDesignSaveFailedText, voiceDesignedText,
} from './receipts'
import type { Runtime } from './runtime'
import { quietSpawn, sharedSpeaker, type Speaker } from './speak'
import { flatText } from './steer'
import { lastStartOffline, restartVoiceService, isLaunching, whichOnPath } from './voice'
import { fail, resolveCharacter } from './voice-tools'
import { readonlyToolMessage } from './writable'

const DECLINE_KIND = 'voice-design'
export const DESIGN_DESCRIPTION_RANGE = { min: 10, max: 300 } as const
export const DESIGN_SAMPLE_RANGE = { min: 10, max: 60 } as const
/** 一批试听的段数、一批里最多尝试几次、最多重新生成到第几轮。 */
const SEGMENTS = 3
const MAX_ATTEMPTS = 5
const MAX_ROUNDS = 3
/** 每段试听要求的时长（秒）：与采用时保存音色的要求一致，免得选了存不下。 */
const CLIP_SECONDS = { min: MIN_VOICE_SECONDS, max: MAX_VOICE_SECONDS } as const
/** 整个流程里第一次合成可能含模型下载，等得久；其后各段只合成。 */
const FIRST_SYNTH_MS = 30 * 60_000
const NEXT_SYNTH_MS = 5 * 60_000
const PLAY_LIMIT_MS = 60_000
const UNLOAD_MS = 10_000
/** 收尾（停播、卸载、重启服务）的总时间上限。 */
const CLEANUP_LIMIT_MS = 150_000

export interface VoiceDesignDeps {
  rt: Pick<Runtime, 'log' | 'voiceSettings' | 'voiceServerDeps'>
  getAsk(): AskFn | undefined
  /** 与保存类工具共用：同一会话的卡片整段排队。 */
  gate: SessionGate
  /** 同一轮内被拒绝后不再重复弹卡片。 */
  declines?: DeclineTracker
  speaker: Pick<Speaker, 'playFileAndWait' | 'stopIfOwner'>
  findPlayer(): Promise<Player | null>
  createClient(endpoint: string): Pick<TtsClient, 'synthesize' | 'unload'>
  inspect: typeof inspectServer
  modelDownloaded: typeof modelDownloaded
  /** 由插件重启服务；offline 不传时按所配模型是否已下载。 */
  restartService(s: VoiceServiceSettings, opts?: { offline?: boolean; signal?: AbortSignal }): Promise<boolean>
  lastStartOffline(modelsDir: string): boolean | undefined
  isLaunching(modelsDir: string): boolean
  /** 系统临时目录；每次流程在它下面建专用目录。 */
  tempRoot(): string
  tavernDirOf(agent: HostAgent | undefined): Promise<string | undefined>
  /** 采用后调用（刷新掌柜看到的角色状态）；它的失败不影响工具返回。 */
  onRegistered(agent: HostAgent): Promise<void>
  /** 收尾的时间上限，测试里缩短。 */
  cleanupLimitMs?: number
}

/** 真实环境下的依赖；酒馆目录与采用后的刷新由调用方给。 */
export function realVoiceDesignDeps(
  rt: Runtime, shared: Pick<VoiceDesignDeps, 'getAsk' | 'gate' | 'declines' | 'tavernDirOf' | 'onRegistered'>,
): VoiceDesignDeps {
  return {
    ...shared,
    rt,
    speaker: sharedSpeaker(rt.log),
    findPlayer: () => findPlayer({ platform: process.platform, which: whichOnPath }),
    createClient: (endpoint) => createTtsClient({ endpoint, fetch: globalThis.fetch }),
    inspect: inspectServer,
    modelDownloaded,
    restartService: (s, opts) => restartVoiceService(rt, s, opts),
    lastStartOffline,
    isLaunching,
    tempRoot: os.tmpdir,
  }
}

interface Clip {
  /** 第几段（从 1 起） */
  n: number
  file: string
  seconds: number
}

type Args = { character: unknown; description: unknown; sampleText: unknown }
type Answer = { label: string | null; custom: string }

const codepoints = (s: string): number => [...s].length

/** 校验文字参数的长度范围；通过返回压平前的原文（去首尾空白），否则返回说明。 */
function checkText(name: string, value: unknown, range: { min: number; max: number }): { ok: true; text: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: fail(`${name} must be a string, voice not designed`) }
  const text = value.trim()
  const n = codepoints(text)
  if (n < range.min || n > range.max) {
    return { ok: false, message: fail(`${name} must be ${range.min} to ${range.max} characters (it is ${n}), voice not designed`) }
  }
  return { ok: true, text }
}

async function askOne(
  deps: VoiceDesignDeps, agent: HostAgent | undefined, signal: AbortSignal | undefined, item: AskItem,
): Promise<Answer | 'aborted'> {
  const ask = deps.getAsk()
  if (!ask || signal?.aborted) return 'aborted'
  try {
    const answer = await ask({ agent, ...(signal ? { signal } : {}), questions: [item] })
    const it = answerItem(answer, item.id)
    const selected = Array.isArray(it?.selected) ? it.selected : []
    return { label: selected[0] ?? null, custom: typeof it?.custom === 'string' ? it.custom.trim() : '' }
  } catch (e) {
    if (isAbort(e, signal)) return 'aborted'
    throw e
  }
}

async function designVoice(
  deps: VoiceDesignDeps, agent: HostAgent | undefined, dir: string, args: Args, signal?: AbortSignal,
): Promise<string> {
  const { log } = deps.rt
  if (typeof args.character !== 'string' || args.character.trim() === '') {
    return fail('character must be a non-empty string, voice not designed')
  }
  const desc = checkText('description', args.description, DESIGN_DESCRIPTION_RANGE)
  if (!desc.ok) return desc.message
  const sample = checkText('sampleText', args.sampleText, DESIGN_SAMPLE_RANGE)
  if (!sample.ok) return sample.message
  const description = flatText(desc.text, 'voice')
  const sampleText = flatText(sample.text, 'voice')

  const session = agent?.id
  if (session !== undefined && deps.declines?.has(session, DECLINE_KIND)) return T.alreadyDeclined

  const found = await resolveCharacter(dir, args.character)
  if (!found.ok) return found.message
  const entry = found.entry
  const shown = shownName(entry.card.name)

  // 前置检查：命中即返回，不做别的
  const cfg = await deps.rt.voiceSettings()
  if (!cfg.configured) return T.notConfigured
  const s = cfg.settings
  if (hasUserInfo(s.endpoint)) return T.userInfo
  if (s.launch !== 'mlx') return T.unsupported
  const info = await deps.inspect(s, deps.rt.voiceServerDeps(), { sizes: false })
  if (!info.reachable) return deps.isLaunching(s.modelsDir) ? T.starting : T.unreachable
  if (!info.owned) return T.unsupported
  if (!deps.getAsk()) return T.noUi

  let player: Player | null = null
  try {
    player = await deps.findPlayer()
  } catch (e) {
    log.warn(`音色设计找播放器出错：${(e as Error).message}`)
  }
  const replacing = (await readVoice(entry.dir)).ok
  const owner = session ?? 'voice-design'
  const client = deps.createClient(s.endpoint)
  const tmp = await fs.mkdtemp(path.join(deps.tempRoot(), 'aha-voice-design-'))
  /** 动过服务（联网重启或发过合成请求）：收尾时要卸载并重启。 */
  let touched = false
  let restartFailed = false

  const decline = (a: Answer): string => {
    if (a.custom !== '') return T.userReplied
    if (session !== undefined) deps.declines?.mark(session, DECLINE_KIND)
    return T.userCancelled
  }

  let firstSynth = true
  /** 生成一批试听；凑满 SEGMENTS 段或尝试满 MAX_ATTEMPTS 次为止。 */
  async function generate(round: number): Promise<Clip[] | 'aborted'> {
    const clips: Clip[] = []
    let lastKind: string | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && clips.length < SEGMENTS; attempt++) {
      if (signal?.aborted) return 'aborted'
      const timeoutMs = firstSynth ? FIRST_SYNTH_MS : NEXT_SYNTH_MS
      firstSynth = false
      touched = true
      try {
        const audio = await client.synthesize(
          { kind: 'design', model: VOICE_DESIGN_MODEL, text: sampleText, instruct: description, language: s.language },
          { timeoutMs, ...(signal ? { signal } : {}) },
        )
        const wav = wavInfo(audio.bytes)
        if (!wav || wav.seconds < CLIP_SECONDS.min || wav.seconds > CLIP_SECONDS.max) {
          log.warn(`音色设计：第 ${round} 轮第 ${attempt} 次生成的音频不合格（${wav ? `${wav.seconds.toFixed(1)} 秒` : '不是 wav'}），丢弃`)
          continue
        }
        const n = clips.length + 1
        const file = path.join(tmp, `r${round}-${n}.wav`)
        await fs.writeFile(file, audio.bytes, { mode: 0o600 })
        clips.push({ n, file, seconds: wav.seconds })
        lastKind = null
      } catch (e) {
        if (signal?.aborted || (e instanceof TtsError && e.kind === 'cancelled')) return 'aborted'
        const kind = e instanceof TtsError ? e.kind : 'other'
        const detail = e instanceof TtsError ? e.detail || e.message : (e as Error).message
        log.warn(`音色设计：第 ${round} 轮第 ${attempt} 次生成失败（${kind}）：${redactUrls(detail)}`)
        // 连不上，或同一种失败连续两次：再试也没用，别让用户干等
        if (kind === 'unreachable' || kind === lastKind) break
        lastKind = kind
      }
    }
    return clips
  }

  /** 第二级：播放选中的一段并让用户决定。 */
  async function pickOne(clip: Clip): Promise<{ use: Clip } | { back: true } | { end: string }> {
    for (;;) {
      if (player) {
        const out = await deps.speaker.playFileAndWait(clip.file, { player, owner, limitMs: PLAY_LIMIT_MS, ...(signal ? { signal } : {}) })
        if (signal?.aborted) return { end: T.aborted }
        if (out.status === 'failed') log.warn(`音色设计试听播放失败（${out.kind}）`)
      }
      const a = await askOne(deps, agent, signal, voiceDesignPickQuestion({
        n: clip.n, seconds: clip.seconds, file: clip.file, canPlay: player !== null, replacing,
      }))
      if (a === 'aborted') return { end: T.aborted }
      if (a.custom === '' && a.label === VOICE_DESIGN_OPT_AGAIN && player) continue
      if (a.custom === '' && a.label === VOICE_DESIGN_OPT_USE) return { use: clip }
      if (a.custom === '' && a.label === VOICE_DESIGN_OPT_BACK) return { back: true }
      return { end: decline(a) }
    }
  }

  /** 第一级：选一段、重新生成或取消。 */
  async function choose(clips: Clip[], round: number): Promise<{ use: Clip } | { regenerate: true } | { end: string }> {
    for (;;) {
      const a = await askOne(deps, agent, signal, voiceDesignListQuestion({
        name: shown, description, sampleText, clips, replacing, canPlay: player !== null, canRegenerate: round < MAX_ROUNDS,
      }))
      if (a === 'aborted') return { end: T.aborted }
      if (a.custom !== '') return { end: decline(a) }
      if (a.label === VOICE_DESIGN_OPT_REGEN && round < MAX_ROUNDS) return { regenerate: true }
      const n = a.label === null ? null : parseVoiceDesignSegment(a.label)
      const clip = n === null ? undefined : clips.find((c) => c.n === n)
      if (!clip) return { end: decline(a) }
      const r = await pickOne(clip)
      if ('back' in r) continue
      return r
    }
  }

  async function adopt(clip: Clip): Promise<string> {
    const r = await saveDesignedVoice({ characterDir: entry.dir, wav: new Uint8Array(await fs.readFile(clip.file)), text: sampleText })
    if (r.kind !== 'registered') return voiceDesignSaveFailedText(r.kind, 'seconds' in r ? r.seconds : undefined)
    if (agent) {
      try {
        await deps.onRegistered(agent)
      } catch (e) {
        log.warn(`采用音色后刷新提示词段失败：${(e as Error).message}`)
      }
    }
    return voiceDesignedText(flatText(entry.card.name, 'voice'), r.seconds, r.replaced)
  }

  async function run(): Promise<string> {
    const needDownload = !(await deps.modelDownloaded(s.modelsDir, VOICE_DESIGN_MODEL))
    if (needDownload) {
      const a = await askOne(deps, agent, signal, voiceDesignDownloadQuestion({
        modelsDir: s.modelsDir, hfEndpoint: s.hfEndpoint ? redactUrls(s.hfEndpoint) : undefined,
      }))
      if (a === 'aborted') return T.aborted
      if (a.custom !== '') return T.userReplied
      if (a.label !== VOICE_DESIGN_OPT_DOWNLOAD) {
        if (session !== undefined) deps.declines?.mark(session, DECLINE_KIND)
        return T.downloadCancelled
      }
      // 服务若是离线启动的就下载不了：联网重启一次；拿不到启动方式时按需要重启处理
      if (deps.lastStartOffline(s.modelsDir) !== false) {
        touched = true
        if (!(await deps.restartService(s, { offline: false }))) {
          // 尽量恢复成原样；恢复失败才需要提示用户自己启动
          touched = false
          if (!(await deps.restartService(s).catch(() => false))) restartFailed = true
          return T.generationFailed
        }
      }
    }

    for (let round = 1; ; round++) {
      const clips = await generate(round)
      if (clips === 'aborted') return T.aborted
      if (clips.length === 0) return T.generationFailed
      const r = await choose(clips, round)
      if ('end' in r) return r.end
      if ('use' in r) return adopt(r.use)
      await Promise.all(clips.map((c) => fs.rm(c.file, { force: true })))
    }
  }

  /** 收尾：停掉还在播的试听、删临时目录、卸载设计模型、重启服务释放内存。返回重启是否失败。 */
  async function cleanup(abort: AbortSignal): Promise<boolean> {
    try {
      await deps.speaker.stopIfOwner(owner)
    } catch (e) {
      log.warn(`音色设计停止试听失败：${(e as Error).message}`)
    }
    await fs.rm(tmp, { recursive: true, force: true })
    if (!touched) return false
    try {
      await client.unload(VOICE_DESIGN_MODEL, { timeoutMs: UNLOAD_MS })
    } catch (e) {
      log.warn(`卸载音色设计模型失败：${redactUrls((e as Error).message)}`)
    }
    // 卸载不归还内存，要重启服务进程；服务已不是插件启动的（比如用户中途停了它）就不管
    const now = await deps.inspect(s, deps.rt.voiceServerDeps(), { sizes: false })
    if (!now.owned || abort.aborted) return false
    return !(await deps.restartService(s, { signal: abort }))
  }

  let msg: string
  let failure: unknown
  let failed = false
  try {
    msg = await run()
  } catch (e) {
    failed = true
    failure = e
    msg = ''
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  const limit = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), deps.cleanupLimitMs ?? CLEANUP_LIMIT_MS) })
  try {
    const out = await Promise.race([cleanup(abort.signal).catch((e): boolean => {
      log.warn(`音色设计收尾出错：${redactUrls((e as Error).message)}`)
      return true
    }), limit])
    if (out === 'timeout') {
      // 让后台的重启就此作罢，免得之后与用户再次启动服务撞车
      abort.abort()
      log.warn('音色设计收尾超时，已中止后台的重启')
      restartFailed = true
    } else if (out) restartFailed = true
  } finally {
    clearTimeout(timer)
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
  if (failed) {
    log.warn(`工具 aha_voice_design 出错：${(failure as Error).message}`)
    msg = fail('voice not designed, internal error; try again or tell the user to check the files')
  }
  return restartFailed ? `${msg}; ${T.restartFailed}` : msg
}

interface ToolHost {
  tools: { register(def: ReturnType<typeof defineTool>): unknown }
}

const outText = (_a: unknown, v: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: String(v) }]

export function registerVoiceDesignTool(ctx: Context | ToolHost, deps: VoiceDesignDeps): void {
  const host = ctx as unknown as ToolHost
  const run = async (exec: unknown, args: Args): Promise<string> => {
    const agent = (exec as { agent?: unknown } | null)?.agent as HostAgent | undefined
    const sg = (exec as { signal?: unknown } | null)?.signal
    const signal = sg instanceof AbortSignal ? sg : undefined
    const go = async (): Promise<string> => {
      const dir = await deps.tavernDirOf(agent)
      if (!dir) return T.notTavern
      const ro = await readonlyToolMessage(dir, deps.rt.log)
      if (ro) return ro.replace('not saved', 'voice not designed')
      try {
        const msg = await designVoice(deps, agent, dir, args, signal)
        deps.rt.log.debug(`工具 aha_voice_design：${msg}`)
        return msg
      } catch (e) {
        deps.rt.log.warn(`工具 aha_voice_design 出错：${(e as Error).message}`)
        return fail('voice not designed, internal error; try again or tell the user to check the files')
      }
    }
    return agent ? deps.gate.run(agent.id, go) : go()
  }

  host.tools.register(defineTool({
    name: 'aha_voice_design',
    description: '按文字描述给某个 character 设计一个声音：生成几段试听，由 user 在界面卡片上试听、挑选，采用后存为该 character 的音色。'
      + '只有 user 明确要求给某个 character 设计声音时才调用。'
      + 'description 取自 character 卡的 voice 栏，并合并 user 的补充（年龄感、音色、语速、语气），10 到 300 字；'
      + 'sampleText 写一句符合 character 口吻的话，10 到 60 字，试听时会念它，采用后也会存为该音色对应的文字。'
      + '需要语音服务已由插件启动，没启动时返回里会说明让 user 先敲 /aha 语音 启动。'
      + '整个过程（可能要下载模型、生成需要几分钟、试听与挑选）都在界面卡片上由 user 完成，不要替 user 挑，也不要自己重复调用。'
      + '该 character 已有音色时，采用会替换它，卡片上会写明。返回值说明是否采用，没采用时说明原因。',
    parameters: {
      character: { type: 'string', required: true, description: 'character 的名字，来自 aha_list_characters' },
      description: { type: 'string', required: true, description: '音色描述，10 到 300 字' },
      sampleText: { type: 'string', required: true, description: '试听台词，10 到 60 字，一句符合 character 口吻的话' },
    },
    output: { schema: { type: 'string' }, render: outText },
    execute: (args, exec) => run(exec, args as Args),
  }))
}
