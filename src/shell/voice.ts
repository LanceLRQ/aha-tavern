// `/aha 语音`：启动、停止、查看本机语音服务。启动要等装环境、起进程、预热模型全部完成才回执；
// 不用 steer，不触发模型。进程管理在 core/voice-server.ts，这里只负责接线、确认卡片与回执。
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
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
  voiceInstallFailedReceipt, voiceNeedsCardReceipt, voiceNoUvReceipt, voiceNotConfiguredReceipt,
  voiceSelfLaunchReceipt, voiceStartedReceipt, voiceStartFailedReceipt, voiceStatusNotConfiguredReceipt,
  voiceStatusReceipt, voiceStopReceipt, voiceUserInfoReceipt, voiceWarmupFailedReceipt, type Reply,
} from './receipts'
import type { Runtime } from './runtime'

/** 随包参考录音里说的话；与 assets/voice-ref.wav 逐字一致。 */
export const BUILTIN_VOICE_TEXT = '你好，欢迎来到这间酒馆。先坐下歇一会儿吧，想聊点什么都可以。'
const BUILTIN_VOICE_FILE = 'voice-ref.wav'
/** 预热用的短句。 */
const WARMUP_TEXT = '你好。'
const WARMUP_TIMEOUT_MS = 30 * 60 * 1000
const CLEANUP_LIMIT_MS = 5000
const QUESTION_ID = 'voice-start'

/** 随包参考录音的绝对路径与对应文字；预热与自检的"试念一句"用。 */
export function builtinVoice(rt: Pick<Runtime, 'builtinAssetsDir'>): { file: string; text: string } {
  if (!rt.builtinAssetsDir) throw new Error('运行时没有提供随包资源目录')
  return { file: path.join(rt.builtinAssetsDir, BUILTIN_VOICE_FILE), text: BUILTIN_VOICE_TEXT }
}

/** 语音相关的运行时成员在 createRuntime 里一并提供；测试用的精简运行时可以不带。 */
function serverDepsOf(rt: Runtime): VoiceServerDeps {
  if (!rt.voiceServerDeps) throw new Error('运行时没有提供语音服务的进程管理')
  return rt.voiceServerDeps()
}

// ---------- 真实的进程管理依赖 ----------

function whichOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // 下一个目录
    }
  }
  return null
}

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
        execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => {
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
  createClient(endpoint: string): Pick<TtsClient, 'synthesize'>
}

export const realVoiceOps: VoiceOps = {
  inspect: server.inspect,
  install: server.install,
  start: server.start,
  stop: server.stop,
  modelDownloaded: server.modelDownloaded,
  createClient: (endpoint) => createTtsClient({ endpoint, fetch: globalThis.fetch }),
}

// ---------- 预热的取消登记（按权重目录） ----------

const warmups = new Map<string, AbortController>()

/** 取消该目录上进行中的预热；没有则什么也不做。 */
export function abortWarmup(modelsDir: string): void {
  warmups.get(modelsDir)?.abort()
}

/** 本插件实例启动的服务（用于卸载时收尾）。 */
export interface VoiceInstanceState {
  started: VoiceServiceSettings | null
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

  async function warmup(inv: Invocation, s: VoiceServiceSettings): Promise<Reply | null> {
    const { rt, signal } = inv
    const ctl = new AbortController()
    warmups.set(s.modelsDir, ctl)
    const onOuter = () => ctl.abort()
    if (signal?.aborted) ctl.abort()
    else signal?.addEventListener('abort', onOuter, { once: true })
    try {
      const ref = builtinVoice(rt)
      await ops.createClient(s.endpoint).synthesize(
        { kind: 'clone', model: s.model, text: WARMUP_TEXT, refAudio: ref.file, refText: ref.text, language: s.language },
        { timeoutMs: WARMUP_TIMEOUT_MS, signal: ctl.signal },
      )
      return null
    } catch (e) {
      const kind = e instanceof TtsError ? e.kind : 'other'
      const detail = e instanceof TtsError ? e.detail || e.message : (e as Error).message
      rt.log.warn(`语音预热失败（${kind}）：${redactUrls(detail)}`)
      return kind === 'cancelled' ? voiceCancelledReceipt() : voiceWarmupFailedReceipt(kind)
    } finally {
      signal?.removeEventListener('abort', onOuter)
      if (warmups.get(s.modelsDir) === ctl) warmups.delete(s.modelsDir)
    }
  }

  async function startFlow(inv: Invocation, s: VoiceServiceSettings): Promise<Reply> {
    const { rt, signal } = inv
    const deps = serverDepsOf(rt)
    const info = await ops.inspect(s, deps)
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
          { label: VOICE_OPT_GO, description: '安装并启动，等待时界面照常可用' },
          { label: VOICE_OPT_CANCEL, description: '什么都不做' },
        ],
      }
      const choice = await askStart(inv, item)
      if (choice === 'no-ui') return voiceNeedsCardReceipt()
      if (choice === 'busy') return { kind: 'success', text: VOICE_CARD_BUSY_TEXT }
      if (choice === 'cancelled') return voiceCancelledReceipt()
      if (choice === 'declined') return voiceDeclinedReceipt()
    }

    if (!info.envInstalled) {
      const r = await ops.install(s, deps, {
        ...(signal ? { signal } : {}),
        onLog: (line) => rt.log.debug(`语音安装：${redactUrls(line)}`),
      })
      if (!r.ok) {
        rt.log.warn(`语音运行环境安装未完成（${r.kind}）：${redactUrls(r.detail)}`)
        if (r.kind === 'cancelled') return voiceCancelledReceipt()
        if (r.kind === 'busy') return voiceBusyReceipt()
        if (r.kind === 'no-uv') return voiceNoUvReceipt()
        return voiceInstallFailedReceipt(r.kind)
      }
    }

    const started = await ops.start(s, deps, signal ? { signal } : {})
    if (!started.ok) {
      rt.log.warn(`语音服务启动未完成（${started.kind}）：${redactUrls(started.detail)}`)
      if (started.kind === 'cancelled') return voiceCancelledReceipt()
      if (started.kind === 'busy') return voiceBusyReceipt()
      return voiceStartFailedReceipt(started.kind)
    }
    if (started.alreadyRunning) return voiceAlreadyRunningReceipt(true)
    state.started = s

    const failed = await warmup(inv, s)
    return failed ?? voiceStartedReceipt(modelLabel(s), s.modelsDir)
  }

  return async (inv) => {
    const action = parseVoiceArgs(inv.args)
    if (action === 'usage') return { kind: 'success', text: VOICE_USAGE_TEXT }
    const { rt } = inv
    if (!rt.voiceSettings) throw new Error('运行时没有提供语音服务的配置')
    const cfg = await rt.voiceSettings()
    if (!cfg.configured) {
      return action === 'status' ? voiceStatusNotConfiguredReceipt() : voiceNotConfiguredReceipt()
    }
    const s = cfg.settings
    if (hasUserInfo(s.endpoint)) return voiceUserInfoReceipt()

    if (action === 'status') {
      const info = await ops.inspect(s, serverDepsOf(rt))
      return voiceStatusReceipt({ reachable: info.reachable, ours: info.owned !== null, busy: info.busy, model: modelLabel(s) })
    }
    if (action === 'stop') {
      abortWarmup(s.modelsDir)
      const r = await ops.stop(s, serverDepsOf(rt))
      if (r.status === 'stopped' && state.started?.modelsDir === s.modelsDir) state.started = null
      return voiceStopReceipt(r.status)
    }
    return startFlow(inv, s)
  }
}

export interface InstallVoiceOptions {
  ops?: VoiceOps
  /** 收尾的时间上限，测试里缩短。 */
  cleanupLimitMs?: number
}

/**
 * 登记 voice 处理函数，并在插件卸载、宿主退出时停掉本实例启动的服务。
 * 用 ctx.effect 而不是 ctx.on('dispose')（实测后者不触发）。
 */
export function installVoice(rt: Runtime, ctx: Context, opts: InstallVoiceOptions = {}): void {
  const ops = opts.ops ?? realVoiceOps
  const limit = opts.cleanupLimitMs ?? CLEANUP_LIMIT_MS
  const state: VoiceInstanceState = { started: null }
  rt.handlers.voice = createVoiceHandler(state, ops)
  const effect = (ctx as unknown as { effect(fn: () => () => unknown): unknown }).effect
  effect.call(ctx, () => async () => {
    const s = state.started
    if (!s) return
    state.started = null
    abortWarmup(s.modelsDir)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), limit) })
    try {
      const done = await Promise.race([ops.stop(s, serverDepsOf(rt)), timeout])
      if (done === 'timeout') rt.log.warn('卸载时停止语音服务超时，交给看门进程回收')
    } catch (e) {
      rt.log.warn(`卸载时停止语音服务失败：${redactUrls((e as Error).message)}`)
    } finally {
      clearTimeout(timer)
    }
  })
}
