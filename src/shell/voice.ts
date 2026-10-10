// `/aha 语音`：启动、停止、查看本机语音服务。不用 steer，不触发模型。进程管理在 core/voice-server.ts，
// 这里只负责接线、确认卡片与回执。
// 宿主在命令运行期间会锁住同一会话的输入框，所以启动不能等到底：确认卡片同步完成，
// 之后安装 → 启动 → 预热作为后台任务跑，处理函数最多等 START_WAIT_MS，没完成就回一行"正在启动"。
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { hasUserInfo, VOICE_MODELS, type VoiceServiceSettings } from '../core/services'
import { createTtsClient, TtsError, type TtsClient } from '../core/tts'
import * as server from '../core/voice-server'
import type { VoiceServerDeps } from '../core/voice-server'
import { answerItem, isAbort, type AskItem } from './confirm'
import type { CommandHandler, Invocation } from './context'
import { redactUrls } from './draw-doctor'
import {
  VOICE_CARD_BUSY_TEXT, VOICE_CARD_HEADER, VOICE_CARD_QUESTION, VOICE_OPT_CANCEL, VOICE_OPT_GO, VOICE_USAGE_TEXT,
  voiceAlreadyRunningReceipt, voiceBusyReceipt, voiceCancelledReceipt, voiceCardMarkdown, voiceDeclinedReceipt,
  voiceFailureReason, voiceInstallFailedReceipt, voiceLastFailedReceipt, voiceNeedsCardReceipt, voiceNoUvReceipt,
  voiceNotConfiguredReceipt, voiceProgressReceipt, voiceSelfLaunchReceipt, voiceStartedReceipt, voiceStartFailedReceipt,
  voiceStartingReceipt, voiceStatusNotConfiguredReceipt, voiceStatusReceipt, voiceStopReceipt, voiceUserInfoReceipt,
  voiceWarmupFailedReceipt, type Reply, type VoiceStage,
} from './receipts'
import type { Runtime } from './runtime'

/** 随包参考录音里说的话；与 assets/voice-ref.wav 逐字一致。 */
export const BUILTIN_VOICE_TEXT = '你好，欢迎来到这间酒馆。先坐下歇一会儿吧，想聊点什么都可以。'
const BUILTIN_VOICE_FILE = 'voice-ref.wav'
/** 预热用的短句。 */
const WARMUP_TEXT = '你好。'
const WARMUP_TIMEOUT_MS = 30 * 60 * 1000
// 宿主在卸载约 5 秒后会强退，收尾（打断任务 + 停服务）总共不超过 4.5 秒，超时就不再等
const CLEANUP_LIMIT_MS = 4500
const MODELS_PROBE_MS = 2000
/** 启动命令最多同步等多久；没完成就转后台。 */
export const START_WAIT_MS = 8000
const QUESTION_ID = 'voice-start'

/** 随包参考录音的绝对路径与对应文字；预热与自检的"试念一句"用。 */
export function builtinVoice(rt: Pick<Runtime, 'builtinAssetsDir'>): { file: string; text: string } {
  return { file: path.join(rt.builtinAssetsDir, BUILTIN_VOICE_FILE), text: BUILTIN_VOICE_TEXT }
}

// ---------- 真实的进程管理依赖 ----------

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** 在 PATH 里找既是普通文件又有可执行权限的同名文件（排除同名目录与没有 x 权限的文件）。 */
export function whichOnPath(name: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    if (!isFile(file)) continue
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // 没有执行权限，找下一个
    }
  }
  return null
}

/** 可取消的等待：signal 中止时立即清掉定时器并返回。 */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

export function createVoiceServerDeps(): VoiceServerDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    which: whichOnPath,
    spawn,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        // EPERM：进程在，只是不属于我们
        return (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    commandOf: (pid) =>
      new Promise((resolve) => {
        execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) => {
          const text = String(stdout).trim()
          resolve(err || text === '' ? null : text)
        })
      }),
    kill: (pid, signal) => process.kill(pid, signal),
    probe: async (endpoint, timeoutMs) => {
      await createTtsClient({ endpoint, fetch: globalThis.fetch }).probe(timeoutMs)
      return true
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    parentPid: process.pid,
  }
}

// ---------- 可注入的操作集 ----------

export interface VoiceOps {
  inspect: typeof server.inspect
  install: typeof server.install
  start: typeof server.start
  stop: typeof server.stop
  modelDownloaded: typeof server.modelDownloaded
  createClient(endpoint: string): Pick<TtsClient, 'synthesize' | 'probe'>
  now(): number
  /** 等待 ms 毫秒；signal 中止时清掉定时器并提前返回。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realVoiceOps: VoiceOps = {
  inspect: server.inspect,
  install: server.install,
  start: server.start,
  stop: server.stop,
  modelDownloaded: server.modelDownloaded,
  createClient: (endpoint) => createTtsClient({ endpoint, fetch: globalThis.fetch }),
  now: Date.now,
  sleep: realSleep,
}

// ---------- 启动任务的状态（模块级） ----------
// 筹备与单聊是同一进程里的两个插件实例，共用这份状态；按权重目录索引。
// 每个目录只保留进行中或最近一次的启动，再次启动时清掉上一次的结果。

type Outcome = { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; reason: string }

interface Launch {
  phase: VoiceStage
  startedAt: number
  ctl: AbortController
  finished: boolean
  outcome?: Outcome
  /** 最终回执；从不拒绝。 */
  done: Promise<Reply>
}
const launches = new Map<string, Launch>()

/** 打断该目录上进行中的启动（取消 install/start，预热也随之取消）；没有则什么也不做。 */
export function abortLaunch(modelsDir: string): void {
  const l = launches.get(modelsDir)
  if (l && !l.finished) l.ctl.abort()
}

/** 清掉启动历史并打断进行中的启动；只给测试用，免得模块级状态在用例之间串味。 */
export function resetLaunchesForTest(): void {
  for (const l of launches.values()) if (!l.finished) l.ctl.abort()
  launches.clear()
}

/** 本插件实例启动的服务与进行中的启动（用于卸载时收尾）。 */
export interface VoiceInstanceState {
  /** 本实例启动成功的服务；pid 用来在收尾时核对它还是不是自己的。 */
  started: { settings: VoiceServiceSettings; pid: number } | null
  /** 本实例发起、尚未结束的启动。 */
  launching: VoiceServiceSettings | null
}

// ---------- 处理函数 ----------

type Action = 'start' | 'stop' | 'status' | 'usage'

export function parseVoiceArgs(args: string): Action {
  const word = args.trim().toLowerCase()
  if (word === '' || word === '状态' || word === 'status') return 'status'
  if (word === '启动' || word === 'start') return 'start'
  if (word === '停止' || word === 'stop') return 'stop'
  return 'usage'
}

const MODEL_SIZE: Record<string, string> = {
  [VOICE_MODELS['0.6b']]: '约 1.9GB',
  [VOICE_MODELS['1.7b']]: '约 2.9GB',
}

const modelLabel = (s: VoiceServiceSettings): string => s.modelAlias ?? s.model

export function createVoiceHandler(state: VoiceInstanceState, ops: VoiceOps = realVoiceOps): CommandHandler {
  async function askStart(inv: Invocation, item: AskItem): Promise<'go' | 'declined' | 'cancelled' | 'busy' | 'no-ui'> {
    const { rt, agent, signal } = inv
    const ask = rt.cards?.getAsk()
    if (!ask || !rt.cards) return 'no-ui'
    const { gate } = rt.cards
    if (gate.commandHolds(agent.id)) return 'busy'
    try {
      const answer = await gate.run(agent.id, () => ask({ agent, ...(signal ? { signal } : {}), questions: [item] }), 'command')
      const sel = answerItem(answer, QUESTION_ID)?.selected
      return Array.isArray(sel) && sel[0] === VOICE_OPT_GO ? 'go' : 'declined'
    } catch (e) {
      if (isAbort(e, signal)) return 'cancelled'
      throw e
    }
  }

  /** 用随包录音发一次很短的克隆合成，触发模型下载与加载。返回失败回执，成功为 null。 */
  async function warmup(rt: Runtime, s: VoiceServiceSettings, launch: Launch): Promise<{ reply: Reply; outcome: Outcome } | null> {
    try {
      const ref = builtinVoice(rt)
      await ops.createClient(s.endpoint).synthesize(
        { kind: 'clone', model: s.model, text: WARMUP_TEXT, refAudio: ref.file, refText: ref.text, language: s.language },
        { timeoutMs: WARMUP_TIMEOUT_MS, signal: launch.ctl.signal },
      )
      return null
    } catch (e) {
      const kind = e instanceof TtsError ? e.kind : 'other'
      const detail = e instanceof TtsError ? e.detail || e.message : (e as Error).message
      rt.log.warn(`语音预热失败（${kind}）：${redactUrls(detail)}`)
      // 后台任务不接宿主的取消信号，预热被取消只会来自"停止"命令或卸载
      if (kind === 'cancelled' || launch.ctl.signal.aborted) return { reply: voiceCancelledReceipt(), outcome: { kind: 'cancelled' } }
      return {
        reply: voiceWarmupFailedReceipt(kind, s.modelsDir),
        outcome: { kind: 'failed', reason: voiceFailureReason('warmup', kind) },
      }
    }
  }

  /** 后台任务：install → start → 预热。结果写进 launch.outcome，返回最终回执。 */
  async function runLaunch(
    rt: Runtime, s: VoiceServiceSettings, launch: Launch, plan: { install: boolean; offline: boolean },
  ): Promise<Reply> {
    const deps = rt.voiceServerDeps()
    const signal = launch.ctl.signal
    const end = (reply: Reply, outcome: Outcome): Reply => {
      launch.outcome = outcome
      return reply
    }
    if (plan.install) {
      launch.phase = 'install'
      const r = await ops.install(s, deps, {
        signal,
        onLog: (line) => rt.log.debug(`语音安装：${redactUrls(line)}`),
      })
      if (!r.ok) {
        rt.log.warn(`语音运行环境安装未完成（${r.kind}）：${redactUrls(r.detail)}`)
        if (r.kind === 'cancelled') return end(voiceCancelledReceipt(), { kind: 'cancelled' })
        if (r.kind === 'busy') return end(voiceBusyReceipt(), { kind: 'failed', reason: voiceFailureReason('install', r.kind) })
        if (r.kind === 'no-uv') return end(voiceNoUvReceipt(), { kind: 'failed', reason: voiceFailureReason('install', r.kind) })
        return end(voiceInstallFailedReceipt(r.kind), { kind: 'failed', reason: voiceFailureReason('install', r.kind) })
      }
    }

    launch.phase = 'start'
    const started = await ops.start(s, deps, { signal, offline: plan.offline })
    if (!started.ok) {
      rt.log.warn(`语音服务启动未完成（${started.kind}）：${redactUrls(started.detail)}`)
      if (started.kind === 'cancelled') return end(voiceCancelledReceipt(), { kind: 'cancelled' })
      const failed: Outcome = { kind: 'failed', reason: voiceFailureReason('start', started.kind) }
      return end(started.kind === 'busy' ? voiceBusyReceipt() : voiceStartFailedReceipt(started.kind), failed)
    }
    if (started.alreadyRunning) return end(voiceAlreadyRunningReceipt(true), { kind: 'ok' })
    // 进程起来就记标记，哪怕预热还没完成
    state.started = { settings: s, pid: started.pid }

    launch.phase = 'warmup'
    const failed = await warmup(rt, s, launch)
    if (failed) return end(failed.reply, failed.outcome)
    return end(voiceStartedReceipt(modelLabel(s), s.modelsDir), { kind: 'ok' })
  }

  function beginLaunch(rt: Runtime, s: VoiceServiceSettings, plan: { install: boolean; offline: boolean }): Launch {
    const launch: Launch = {
      phase: plan.install ? 'install' : 'start',
      startedAt: ops.now(),
      ctl: new AbortController(),
      finished: false,
      done: Promise.resolve({ kind: 'success', text: '' }),
    }
    launches.set(s.modelsDir, launch)
    state.launching = s
    launch.done = runLaunch(rt, s, launch, plan)
      .catch((e): Reply => {
        // 后台任务里的异常不能变成未处理的拒绝；日志本身出错也不能让 done 拒绝
        try {
          rt.log.error(`语音服务启动出错：${redactUrls((e as Error).stack ?? String(e))}`)
        } catch {
          // 忽略
        }
        launch.outcome = { kind: 'failed', reason: '内部错误，详情见日志' }
        return { kind: 'error', text: '语音服务启动出错，详情见日志。' }
      })
      .finally(() => {
        launch.finished = true
        if (state.launching?.modelsDir === s.modelsDir) state.launching = null
      })
    return launch
  }

  async function startFlow(inv: Invocation, s: VoiceServiceSettings): Promise<Reply> {
    const { rt } = inv
    const deps = rt.voiceServerDeps()
    const running = launches.get(s.modelsDir)
    if (running && !running.finished) return voiceBusyReceipt()
    const info = await ops.inspect(s, deps, { sizes: false })
    if (info.reachable) return voiceAlreadyRunningReceipt(info.owned !== null)
    if (s.launch !== 'mlx') return voiceSelfLaunchReceipt('launch')
    if (!info.supported) return voiceSelfLaunchReceipt('platform')
    if (!info.uv) return voiceNoUvReceipt()
    if (info.busy) return voiceBusyReceipt()

    const needModel = !info.modelDownloaded
    if (!info.envInstalled || needModel) {
      const detail = voiceCardMarkdown({
        env: !info.envInstalled,
        model: needModel ? { name: modelLabel(s), size: MODEL_SIZE[s.model] ?? '大小未知' } : null,
        modelsDir: s.modelsDir,
        hfEndpoint: s.hfEndpoint ? redactUrls(s.hfEndpoint) : undefined,
      })
      const item: AskItem = {
        id: QUESTION_ID, header: VOICE_CARD_HEADER, question: VOICE_CARD_QUESTION, detail,
        options: [
          { label: VOICE_OPT_GO, description: '安装并启动，可能要几分钟，期间可以用 /aha 语音 状态 查看进度' },
          { label: VOICE_OPT_CANCEL, description: '什么都不做' },
        ],
      }
      const choice = await askStart(inv, item)
      if (choice === 'no-ui') return voiceNeedsCardReceipt()
      if (choice === 'busy') return { kind: 'success', text: VOICE_CARD_BUSY_TEXT }
      if (choice === 'cancelled') return voiceCancelledReceipt()
      if (choice === 'declined') return voiceDeclinedReceipt()
    }

    // 占位必须与 beginLaunch 之间没有 await：inspect 与卡片都可能挂起，别的实例可能已经抢先开始
    const raced = launches.get(s.modelsDir)
    if (raced && !raced.finished) return voiceBusyReceipt()
    // 权重已在本地时让服务离线启动，免得去查连不上的仓库
    const launch = beginLaunch(rt, s, { install: !info.envInstalled, offline: info.modelDownloaded })
    const waitCtl = new AbortController()
    try {
      const early = await Promise.race([launch.done, ops.sleep(START_WAIT_MS, waitCtl.signal).then(() => null)])
      return early ?? voiceStartingReceipt(launch.phase)
    } finally {
      waitCtl.abort() // 任务先结束时清掉等待的定时器
    }
  }

  async function statusFlow(inv: Invocation, s: VoiceServiceSettings): Promise<Reply> {
    const { rt } = inv
    const last = launches.get(s.modelsDir)
    if (last && !last.finished) {
      return voiceProgressReceipt(last.phase, Math.max(0, Math.round((ops.now() - last.startedAt) / 1000)))
    }
    const info = await ops.inspect(s, rt.voiceServerDeps(), { sizes: false })
    if (!info.reachable && last?.outcome?.kind === 'failed') {
      return voiceLastFailedReceipt(last.outcome.reason, s.modelsDir)
    }
    let loaded: boolean | null = null
    if (info.reachable) {
      try {
        loaded = (await ops.createClient(s.endpoint).probe(MODELS_PROBE_MS)).includes(s.model)
      } catch {
        loaded = null
      }
    }
    return voiceStatusReceipt({
      reachable: info.reachable, ours: info.owned !== null, busy: info.busy, model: modelLabel(s), loaded,
    })
  }

  return async (inv) => {
    const action = parseVoiceArgs(inv.args)
    if (action === 'usage') return { kind: 'success', text: VOICE_USAGE_TEXT }
    const { rt } = inv
    const cfg = await rt.voiceSettings()
    if (!cfg.configured) {
      return action === 'status' ? voiceStatusNotConfiguredReceipt() : voiceNotConfiguredReceipt()
    }
    const s = cfg.settings
    if (hasUserInfo(s.endpoint)) return voiceUserInfoReceipt()

    if (action === 'status') return statusFlow(inv, s)
    if (action === 'stop') {
      abortLaunch(s.modelsDir)
      const r = await ops.stop(s, rt.voiceServerDeps())
      if (r.status === 'stopped' && state.started?.settings.modelsDir === s.modelsDir) state.started = null
      return voiceStopReceipt(r.status)
    }
    // 再次启动前清掉上次的结果
    const prev = launches.get(s.modelsDir)
    if (prev?.finished) launches.delete(s.modelsDir)
    return startFlow(inv, s)
  }
}

export interface InstallVoiceOptions {
  ops?: VoiceOps
  /** 收尾的时间上限，测试里缩短。 */
  cleanupLimitMs?: number
}

/**
 * 登记 voice 处理函数，并在插件卸载、宿主退出时收尾：打断本实例进行中的启动，
 * 并停掉本实例启动的服务（先用 server.pid 核对进程号，不是自己启动的那个就只清标记）。
 * 用 ctx.effect 而不是 ctx.on('dispose')（实测后者不触发）。
 */
export function installVoice(rt: Runtime, ctx: Context, opts: InstallVoiceOptions = {}): void {
  const ops = opts.ops ?? realVoiceOps
  const limit = opts.cleanupLimitMs ?? CLEANUP_LIMIT_MS
  const state: VoiceInstanceState = { started: null, launching: null }
  rt.handlers.voice = createVoiceHandler(state, ops)

  async function cleanup(): Promise<void> {
    const launching = state.launching
    if (launching) {
      abortLaunch(launching.modelsDir)
      // 等任务清理完（install/start 取消时会自己结束子进程）
      await launches.get(launching.modelsDir)?.done
    }
    const started = state.started
    if (!started) return
    state.started = null
    const deps = rt.voiceServerDeps()
    const info = await ops.inspect(started.settings, deps, { sizes: false })
    if (info.owned?.pid !== started.pid) {
      rt.log.debug('卸载收尾：服务已不是本实例启动的那个进程，不停')
      return
    }
    await ops.stop(started.settings, deps)
  }

  const effect = (ctx as unknown as { effect(fn: () => () => unknown): unknown }).effect
  effect.call(ctx, () => async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), limit) })
    try {
      const done = await Promise.race([cleanup().then(() => 'done' as const), timeout])
      if (done === 'timeout') rt.log.warn('卸载时收尾语音服务超时，交给看门进程回收')
    } catch (e) {
      rt.log.warn(`卸载时收尾语音服务失败：${redactUrls((e as Error).message)}`)
    } finally {
      clearTimeout(timer)
    }
  })
}
