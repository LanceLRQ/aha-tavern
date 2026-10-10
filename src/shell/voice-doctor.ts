// 自检的"语音"一段：服务、模型、代为启动的条件、播放器、当前角色的音色、最近的朗读错误，可选试念一句。
// 不依赖宿主：依赖全部注入，返回结构化结果；回执文字由 receipts.ts 渲染。
// 不调用聊天模型，不启动、不安装、不下载任何东西（启动由调用方走 voice.ts 的启动流程）。
import path from 'node:path'
import type { Player } from '../core/player'
import { hasUserInfo, type VoiceServiceResult, type VoiceServiceSettings } from '../core/services'
import type { VoiceServerInfo } from '../core/voice-server'
import { hostOf } from './draw'
import type { Log } from './runtime'
import type { SpeakError, Speaker } from './speak'
import type { LaunchSnapshot } from './voice'
import type { VoiceStage } from './receipts'

/** 探测服务里已加载模型的时限（毫秒）。 */
export const VOICE_DOCTOR_PROBE_MS = 2000
/** 试念的固定文本。 */
export const TRIAL_TEXT = '你好，这是一次试念。'
/** 试念最多等多久（毫秒）。 */
export const TRIAL_LIMIT_MS = 60_000

export interface VoiceDoctorReport {
  /** 检查中途收到取消信号。 */
  cancelled?: boolean
  configured: boolean
  /** 配置问题清单（未配置时是为什么没读成；已配置时是回落了默认值的字段）。 */
  problems: string[]
  service?: {
    host: string
    connected: boolean
    /** 地址里带了用户名和密码（此时没有发任何请求）。 */
    credentials?: boolean
    /** 连得上时：谁启动的；连不上时不适用（无此字段）。 */
    ours?: 'plugin' | 'external'
    /** 正在启动；stage 与 seconds 来自本插件的启动记录，别处发起的启动没有。 */
    launching?: { stage?: VoiceStage; seconds?: number }
    /** 连不上且上次启动失败时的简短原因。 */
    lastFailure?: string
  }
  /** 配置的模型（简称或名字）；loaded 只在详细检查且连得上时有值，查不出来为 null。 */
  model?: { name: string; loaded?: boolean | null }
  /** 仅 launch: mlx 时有。 */
  launch?: {
    supported: boolean
    uv: boolean
    envInstalled: boolean
    modelDownloaded: boolean
    modelsDir: string
    sizes?: { env: number; hf: number }
  }
  player?: { found: boolean; name?: string }
  /** 仅在单聊·聊天中有。 */
  voice?: { present: boolean }
  lastError?: { kind: string; at: number }
}

export interface VoiceDoctorDeps {
  loadService(): Promise<VoiceServiceResult>
  inspect(settings: VoiceServiceSettings, opts: { sizes: boolean }): Promise<VoiceServerInfo>
  /** 服务里已加载的模型名；连不上就拒绝。 */
  loadedModels(endpoint: string, timeoutMs: number): Promise<string[]>
  findPlayer(): Promise<Player | null>
  /** 该权重目录上最近一次启动的概况。 */
  launchOf(modelsDir: string): LaunchSnapshot | null
  lastSpeakError(): SpeakError | null
  /** 当前角色的音色；只在单聊·聊天中提供。没有音色返回 null。 */
  characterVoice?(): Promise<{ audio: string; text: string } | null>
  /** 随包参考录音。 */
  builtinVoice(): { audio: string; text: string }
  speaker: Pick<Speaker, 'speakAndWait'>
  /** 朗读请求所属的会话编号。 */
  owner: string
  now(): number
  log: Pick<Log, 'debug'>
}

export interface VoiceDoctorOptions {
  /** 详细检查：统计目录大小、查服务里已加载的模型。一行小结那条路径不开。 */
  detail?: boolean
  signal?: AbortSignal
}

export async function checkVoice(deps: VoiceDoctorDeps, opts: VoiceDoctorOptions = {}): Promise<VoiceDoctorReport> {
  const svc = await deps.loadService()
  if (!svc.configured) return { configured: false, problems: svc.problems }
  const s = svc.settings
  const detail = opts.detail === true
  const report: VoiceDoctorReport = { configured: true, problems: svc.problems }
  const host = hostOf(s.endpoint)
  const stopped = (): boolean => {
    if (opts.signal?.aborted) report.cancelled = true
    return report.cancelled === true
  }
  if (hasUserInfo(s.endpoint)) {
    report.service = { host, connected: false, credentials: true }
    return report
  }
  if (stopped()) return report

  const info = await deps.inspect(s, { sizes: detail })
  if (stopped()) return report
  const snap = deps.launchOf(s.modelsDir)
  const running = snap !== null && !snap.finished
  const service: NonNullable<VoiceDoctorReport['service']> = { host, connected: info.reachable }
  if (info.reachable) service.ours = info.owned ? 'plugin' : 'external'
  else if (running || info.busy) {
    service.launching = running
      ? { stage: snap.stage, seconds: Math.max(0, Math.round((deps.now() - snap.startedAt) / 1000)) }
      : {}
  } else if (snap?.failure) service.lastFailure = snap.failure
  report.service = service

  report.model = { name: s.modelAlias ?? s.model }
  if (detail && info.reachable) {
    try {
      report.model.loaded = (await deps.loadedModels(s.endpoint, VOICE_DOCTOR_PROBE_MS)).includes(s.model)
    } catch {
      report.model.loaded = null
    }
    if (stopped()) return report
  }

  if (s.launch === 'mlx') {
    report.launch = {
      supported: info.supported, uv: info.uv !== null, envInstalled: info.envInstalled,
      modelDownloaded: info.modelDownloaded, modelsDir: s.modelsDir,
      ...(detail && info.sizes ? { sizes: info.sizes } : {}),
    }
  }

  const player = await deps.findPlayer()
  report.player = player ? { found: true, name: path.basename(player.command) } : { found: false }

  if (deps.characterVoice) {
    try {
      report.voice = { present: (await deps.characterVoice()) !== null }
    } catch (e) {
      deps.log.debug(`自检：读取当前角色的音色失败：${(e as Error).message}`)
    }
  }

  const last = deps.lastSpeakError()
  if (last) report.lastError = { kind: last.kind, at: last.at }
  stopped()
  return report
}

export type VoiceTrial =
  | { status: 'ok'; sentences: number; seconds: number }
  | { status: 'failed'; kind: string }
  | { status: 'cancelled' }

/**
 * 试念一句：有当前角色的音色就用它，否则用随包参考录音；等这一次朗读结束或失败（上限 TRIAL_LIMIT_MS）。
 * 设置现读一次，不放进报告（地址里可能带凭据）。走进程内唯一的朗读队列，会顶掉正在念的。
 */
export async function trialSpeak(deps: VoiceDoctorDeps, signal?: AbortSignal): Promise<VoiceTrial> {
  const svc = await deps.loadService()
  if (!svc.configured || hasUserInfo(svc.settings.endpoint)) return { status: 'failed', kind: 'other' }
  const settings = svc.settings
  const player = await deps.findPlayer()
  if (!player) return { status: 'failed', kind: 'no-player' }
  let own: { audio: string; text: string } | null = null
  try {
    own = (await deps.characterVoice?.()) ?? null
  } catch (e) {
    deps.log.debug(`自检：读取当前角色的音色失败：${(e as Error).message}`)
  }
  const started = deps.now()
  const out = await deps.speaker.speakAndWait(
    { sentences: [TRIAL_TEXT], voice: own ?? deps.builtinVoice(), settings, player, owner: deps.owner },
    { timeoutMs: TRIAL_LIMIT_MS, ...(signal ? { signal } : {}) },
  )
  switch (out.status) {
    case 'ok':
      return { status: 'ok', sentences: 1, seconds: Math.max(0, Math.round((deps.now() - started) / 1000)) }
    case 'failed':
      return { status: 'failed', kind: out.kind }
    case 'timeout':
      return { status: 'failed', kind: 'trial-timeout' }
    case 'stopped':
      return { status: 'cancelled' }
  }
}

/** 卡片该给哪一组选项：能试念 / 能代为启动 / 正在启动 / 其他问题。 */
export type VoiceCardMode = 'ready' | 'startable' | 'starting' | 'problem'

export function voiceCardMode(r: VoiceDoctorReport): VoiceCardMode {
  const s = r.service
  if (!r.configured || !s || s.credentials) return 'problem'
  if (s.connected) return r.player?.found ? 'ready' : 'problem'
  if (s.launching) return 'starting'
  return r.launch?.supported && r.launch.uv ? 'startable' : 'problem'
}
