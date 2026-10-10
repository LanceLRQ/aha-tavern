// 本机语音服务（mlx-audio）的进程管理：看现状、装运行环境、启动、停止、判断服务是不是插件启动的。
// 与宿主无关：平台、环境变量、which、spawn、进程查询、探测、时钟全部经 deps 注入。
// 只返回结构化结果，不决定回执文字；输出原文只放 detail（供日志）。
import type { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite, pathExists } from './fsx'
import type { VoiceServiceSettings } from './services'

/** 安装进环境的 mlx-audio 版本，写进标记文件；版本变了就视为环境没装。 */
export const MLX_AUDIO_VERSION = '0.5.8'
/** 启动后等待服务可应答的默认上限。 */
export const DEFAULT_START_TIMEOUT_MS = 180_000

/**
 * 看门启动脚本。服务与看门在同一个 Python 进程里：守护线程每 2 秒查一次父进程号，
 * 不再等于传入的 DSH 进程号（宿主被强杀或关终端、没机会收尾）就直接退出，免得服务残留。
 * argv：[1] 父进程号，其余原样交给 mlx_audio.server。
 */
export const WATCHDOG_SCRIPT = [
  'import os, sys, threading, time, runpy',
  'parent = int(sys.argv[1])',
  'def watch():',
  '    while True:',
  '        time.sleep(2)',
  '        if os.getppid() != parent:',
  '            os._exit(0)',
  'threading.Thread(target=watch, daemon=True).start()',
  "sys.argv = ['mlx_audio.server'] + sys.argv[2:]",
  "runpy.run_module('mlx_audio.server', run_name='__main__')",
].join('\n')

const LOG_MAX_BYTES = 1024 * 1024
const LOG_TAIL_LINES = 20
const DETAIL_MAX = 2000
const POLL_MS = 500
const PROBE_MS = 2000
const KILL_POLL_MS = 200
const KILL_POLLS = 15

export interface VoiceServerDeps {
  platform: string
  arch: string
  /** 传给子进程的基础环境变量。 */
  env: Record<string, string | undefined>
  which: (name: string) => string | null | Promise<string | null>
  spawn: typeof nodeSpawn
  isAlive: (pid: number) => boolean | Promise<boolean>
  /** 进程的完整命令行；进程不存在时为 null。 */
  commandOf: (pid: number) => string | null | Promise<string | null>
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** 服务能应答返回 true；不通返回 false 或抛错都算不通。 */
  probe: (endpoint: string, timeoutMs: number) => Promise<boolean>
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** 当前进程号，写进看门参数。 */
  parentPid: number
}

export interface VoiceServerInfo {
  /** 苹果芯片的 Mac，插件才能代为启动。 */
  supported: boolean
  uv: string | null
  envInstalled: boolean
  modelDownloaded: boolean
  /** 两个目录各自已占的字节数。 */
  sizes: { env: number; hf: number }
  owned: { pid: number; port: number; startedAt: number } | null
  reachable: boolean
  /** 本目录上有安装或启动正在进行。 */
  busy: boolean
}

export type InstallResult =
  | { ok: true }
  | { ok: false; kind: 'busy' | 'unsupported' | 'no-uv' | 'network' | 'cancelled' | 'failed'; detail: string }

export type StartResult =
  | { ok: true; pid: number; alreadyRunning: boolean }
  | {
      ok: false
      kind: 'busy' | 'unsupported' | 'not-installed' | 'occupied' | 'timeout' | 'exited' | 'cancelled' | 'failed'
      detail: string
    }

export interface StopResult {
  status: 'stopped' | 'not-ours' | 'not-running'
  /** 温和结束超时后动用了强制结束。 */
  forced: boolean
}

const envDir = (modelsDir: string) => path.join(modelsDir, 'env')
const hfDir = (modelsDir: string) => path.join(modelsDir, 'hf')
const pythonPath = (modelsDir: string) => path.join(envDir(modelsDir), 'bin', 'python')
const markerPath = (modelsDir: string) => path.join(modelsDir, 'env.installed')
const pidPath = (modelsDir: string) => path.join(modelsDir, 'server.pid')
const logPath = (modelsDir: string) => path.join(modelsDir, 'server.log')

const isApple = (d: VoiceServerDeps) => d.platform === 'darwin' && d.arch === 'arm64'

// ---- 进行中的操作：按 modelsDir 互斥，stop 靠它取消 ----

interface Active {
  ctl: AbortController
  detach: () => void
  done: Promise<void>
  finish: () => void
}
const active = new Map<string, Active>()

/** 同步占位；已有操作在跑返回 null。 */
function begin(modelsDir: string, outer?: AbortSignal): Active | null {
  if (active.has(modelsDir)) return null
  const ctl = new AbortController()
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  const onOuter = () => ctl.abort()
  const detach = () => outer?.removeEventListener('abort', onOuter)
  const entry = { ctl, detach, done, finish }
  active.set(modelsDir, entry)
  if (outer?.aborted) ctl.abort()
  else outer?.addEventListener('abort', onOuter, { once: true })
  return entry
}

function end(modelsDir: string, entry: Active): void {
  active.delete(modelsDir)
  entry.detach()
  entry.finish()
}

// ---- 文件辅助 ----

/** 递归求和；符号链接不跟随也不计数（hf 里 snapshots 指向 blobs，只数 blobs 的真实文件）。 */
export async function dirSize(dir: string, lstat: typeof fs.lstat = fs.lstat): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) total += await dirSize(p, lstat)
    else if (e.isFile()) {
      try {
        total += (await lstat(p)).size
      } catch {
        // 遍历中文件消失，当 0
      }
    }
  }
  return total
}

interface PidRecord {
  pid: number
  port: number
  startedAt: number
  parentPid: number
}

/** 读 server.pid；不存在返回 null，内容坏了返回 'broken'。 */
async function readPid(modelsDir: string): Promise<PidRecord | 'broken' | null> {
  let raw: string
  try {
    raw = await fs.readFile(pidPath(modelsDir), 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw) as Partial<PidRecord>
    if (Number.isInteger(v.pid) && Number.isInteger(v.port)) {
      return { pid: v.pid!, port: v.port!, startedAt: Number(v.startedAt) || 0, parentPid: Number(v.parentPid) || 0 }
    }
  } catch {
    // 落到下面
  }
  return 'broken'
}

async function removePid(modelsDir: string): Promise<void> {
  await fs.rm(pidPath(modelsDir), { force: true })
}

async function logTail(modelsDir: string): Promise<string> {
  try {
    const text = await fs.readFile(logPath(modelsDir), 'utf8')
    return text.split('\n').filter((l) => l.trim() !== '').slice(-LOG_TAIL_LINES).join('\n').slice(-DETAIL_MAX)
  } catch {
    return ''
  }
}

async function envInstalled(modelsDir: string): Promise<boolean> {
  if (!(await pathExists(pythonPath(modelsDir)))) return false
  try {
    const v = JSON.parse(await fs.readFile(markerPath(modelsDir), 'utf8')) as { mlxAudio?: unknown }
    return v.mlxAudio === MLX_AUDIO_VERSION
  } catch {
    return false
  }
}

/** 模型权重是否已下载：hub 下对应目录的 snapshots 里有非空目录。 */
export async function modelDownloaded(modelsDir: string, modelId: string): Promise<boolean> {
  const snaps = path.join(hfDir(modelsDir), 'hub', `models--${modelId.replace(/\//g, '--')}`, 'snapshots')
  try {
    for (const name of await fs.readdir(snaps)) {
      try {
        const p = path.join(snaps, name)
        if ((await fs.stat(p)).isDirectory() && (await fs.readdir(p)).length > 0) return true
      } catch {
        // 断链或读不了的条目跳过
      }
    }
  } catch {
    // 目录不存在
  }
  return false
}

// ---- 归属与结束进程 ----

/** 判断服务是不是插件启动的；pid 文件已失效（进程死、命令行对不上、内容坏）时顺手删掉。 */
async function findOwned(settings: VoiceServiceSettings, deps: VoiceServerDeps): Promise<PidRecord | null> {
  const rec = await readPid(settings.modelsDir)
  if (rec === null) return null
  if (rec === 'broken') {
    await removePid(settings.modelsDir)
    return null
  }
  const alive = await deps.isAlive(rec.pid)
  const cmd = alive ? await deps.commandOf(rec.pid) : null
  if (!alive || !cmd || !cmd.includes('mlx_audio')) {
    await removePid(settings.modelsDir)
    return null
  }
  // 端口对不上不算自己的，也不删文件：用户改了端口后，旧服务要等看门回收或手动处理。
  return rec.port === settings.port ? rec : null
}

/** 先 SIGTERM，每 200ms 查一次最多等 3 秒，仍活着就 SIGKILL。返回是否动用了强制。 */
async function terminate(pid: number, deps: VoiceServerDeps): Promise<boolean> {
  const send = (sig: NodeJS.Signals) => {
    try {
      deps.kill(pid, sig)
    } catch {
      // 进程已不在
    }
  }
  send('SIGTERM')
  for (let i = 0; i < KILL_POLLS; i++) {
    if (!(await deps.isAlive(pid))) return false
    await deps.sleep(KILL_POLL_MS)
  }
  if (!(await deps.isAlive(pid))) return false
  send('SIGKILL')
  return true
}

async function probeOk(settings: VoiceServiceSettings, deps: VoiceServerDeps, ms: number): Promise<boolean> {
  try {
    return (await deps.probe(settings.endpoint, ms)) === true
  } catch {
    return false
  }
}

// ---- 对外接口 ----

export async function inspect(settings: VoiceServiceSettings, deps: VoiceServerDeps): Promise<VoiceServerInfo> {
  const dir = settings.modelsDir
  const busy = active.has(dir)
  const [uv, installed, downloaded, envSize, hfSize, owned, reachable] = await Promise.all([
    deps.which('uv'),
    envInstalled(dir),
    modelDownloaded(dir, settings.model),
    dirSize(envDir(dir)),
    dirSize(hfDir(dir)),
    findOwned(settings, deps),
    probeOk(settings, deps, PROBE_MS),
  ])
  return {
    supported: isApple(deps),
    uv,
    envInstalled: installed,
    modelDownloaded: downloaded,
    sizes: { env: envSize, hf: hfSize },
    owned: owned && { pid: owned.pid, port: owned.port, startedAt: owned.startedAt },
    reachable,
    busy,
  }
}

const NETWORK_HINT =
  /timed out|connection refused|connection reset|dns|failed to fetch|network is unreachable|tls|certificate/i

interface StepResult {
  code: number | null
  aborted: boolean
  spawnFailed: boolean
  /** 可执行文件不存在。 */
  missing: boolean
  output: string
}

/** 跑一条命令，输出按行追加到 server.log 并回调；abort 时结束子进程。 */
function runStep(
  deps: VoiceServerDeps,
  cmd: string,
  args: string[],
  signal: AbortSignal,
  emit: (line: string) => void,
): Promise<StepResult> {
  return new Promise((resolve) => {
    let output = ''
    let aborted = false
    let spawnFailed = false
    let missing = false
    let finished = false
    let child: ReturnType<typeof nodeSpawn>
    try {
      child = deps.spawn(cmd, args, { env: deps.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({
        code: null,
        aborted: false,
        spawnFailed: true,
        missing: (e as NodeJS.ErrnoException).code === 'ENOENT',
        output: String(e),
      })
      return
    }
    const pending: Record<string, string> = {}
    const feed = (tag: string) => (chunk: Buffer | string) => {
      const text = (pending[tag] ?? '') + String(chunk)
      const lines = text.split(/\r?\n/)
      pending[tag] = lines.pop() ?? ''
      for (const l of lines) emit(l)
      output = (output + String(chunk)).slice(-DETAIL_MAX)
    }
    child.stdout?.on('data', feed('out'))
    child.stderr?.on('data', feed('err'))
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      // 3 秒后仍没退出就强制结束，免得 stop 一直等
      void deps.sleep(KILL_POLL_MS * KILL_POLLS).then(() => {
        if (!finished) child.kill('SIGKILL')
      })
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null) => {
      finished = true
      signal.removeEventListener('abort', onAbort)
      for (const rest of Object.values(pending)) if (rest) emit(rest)
      resolve({ code, aborted: aborted || signal.aborted, spawnFailed, missing, output })
    }
    child.on('error', (e) => {
      spawnFailed = true
      missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
      output += String(e)
      done(null)
    })
    child.on('close', (code) => done(code))
  })
}

/** 建 Python 环境并装 mlx-audio；成功后写标记文件。 */
export async function install(
  settings: VoiceServiceSettings,
  deps: VoiceServerDeps,
  opts: { signal?: AbortSignal; onLog?: (line: string) => void } = {},
): Promise<InstallResult> {
  const dir = settings.modelsDir
  const entry = begin(dir, opts.signal)
  if (!entry) return { ok: false, kind: 'busy', detail: '' }
  try {
    if (!isApple(deps)) return { ok: false, kind: 'unsupported', detail: '' }
    const uv = await deps.which('uv')
    if (!uv) return { ok: false, kind: 'no-uv', detail: '' }
    await fs.mkdir(dir, { recursive: true })
    await fs.rm(markerPath(dir), { force: true })

    let chain: Promise<void> = Promise.resolve()
    const emit = (line: string) => {
      opts.onLog?.(line)
      chain = chain.then(() => fs.appendFile(logPath(dir), line + '\n')).catch(() => undefined)
    }
    const steps: string[][] = [
      ['venv', '--clear', '--python', '3.12', envDir(dir)],
      ['pip', 'install', '--python', pythonPath(dir), `mlx-audio[server]==${MLX_AUDIO_VERSION}`],
    ]
    for (const args of steps) {
      const r = await runStep(deps, uv, args, entry.ctl.signal, emit)
      await chain
      if (r.aborted) return { ok: false, kind: 'cancelled', detail: '' }
      if (r.spawnFailed) return { ok: false, kind: r.missing ? 'no-uv' : 'failed', detail: r.output }
      if (r.code !== 0) {
        return { ok: false, kind: NETWORK_HINT.test(r.output) ? 'network' : 'failed', detail: r.output }
      }
    }
    await atomicWrite(markerPath(dir), JSON.stringify({ mlxAudio: MLX_AUDIO_VERSION, installedAt: deps.now() }))
    return { ok: true }
  } finally {
    end(dir, entry)
  }
}

/** 启动服务进程并等到探测通过。失败时结束进程、删 pid 文件。 */
export async function start(
  settings: VoiceServiceSettings,
  deps: VoiceServerDeps,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<StartResult> {
  const dir = settings.modelsDir
  const entry = begin(dir, opts.signal)
  if (!entry) return { ok: false, kind: 'busy', detail: '' }
  const signal = entry.ctl.signal
  try {
    if (!isApple(deps)) return { ok: false, kind: 'unsupported', detail: '' }
    if (!(await envInstalled(dir))) return { ok: false, kind: 'not-installed', detail: '' }
    const owned = await findOwned(settings, deps)
    if (owned) return { ok: true, pid: owned.pid, alreadyRunning: true }
    if (signal.aborted) return { ok: false, kind: 'cancelled', detail: '' }
    // 端口上已有别的服务在应答：不抢，交给调用方说明
    if (await probeOk(settings, deps, PROBE_MS)) return { ok: false, kind: 'occupied', detail: '' }

    try {
      if ((await fs.stat(logPath(dir))).size > LOG_MAX_BYTES) await fs.truncate(logPath(dir), 0)
    } catch {
      // 日志还不存在
    }
    const fd = await fs.open(logPath(dir), 'a')
    let exited = false
    let pid: number | undefined
    let spawnError = ''
    try {
      const env: Record<string, string | undefined> = { ...deps.env, HF_HOME: hfDir(dir), PYTHONUNBUFFERED: '1' }
      if (settings.hfEndpoint) env.HF_ENDPOINT = settings.hfEndpoint
      const child = deps.spawn(
        pythonPath(dir),
        ['-c', WATCHDOG_SCRIPT, String(deps.parentPid), '--host', '127.0.0.1', '--port', String(settings.port)],
        { env: env as NodeJS.ProcessEnv, stdio: ['ignore', fd.fd, fd.fd] },
      )
      child.on('exit', () => (exited = true))
      child.on('error', () => (exited = true))
      pid = child.pid
    } catch (e) {
      spawnError = String(e)
    } finally {
      await fd.close()
    }
    if (spawnError) return { ok: false, kind: 'failed', detail: spawnError.slice(0, DETAIL_MAX) }
    if (pid === undefined) return { ok: false, kind: 'exited', detail: await logTail(dir) }
    await atomicWrite(
      pidPath(dir),
      JSON.stringify({ pid, port: settings.port, startedAt: deps.now(), parentPid: deps.parentPid }),
    )

    const deadline = deps.now() + (opts.timeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    for (;;) {
      if (signal.aborted) return await abandon(dir, pid, deps, { ok: false, kind: 'cancelled', detail: '' })
      if (exited) {
        await removePid(dir)
        return { ok: false, kind: 'exited', detail: await logTail(dir) }
      }
      if (await probeOk(settings, deps, PROBE_MS)) return { ok: true, pid, alreadyRunning: false }
      if (deps.now() >= deadline) {
        return await abandon(dir, pid, deps, { ok: false, kind: 'timeout', detail: await logTail(dir) })
      }
      await deps.sleep(POLL_MS)
    }
  } finally {
    end(dir, entry)
  }
}

async function abandon(dir: string, pid: number, deps: VoiceServerDeps, result: StartResult): Promise<StartResult> {
  await terminate(pid, deps)
  await removePid(dir)
  return result
}

/** 只停插件启动的服务；同时取消本目录上进行中的安装或启动。 */
export async function stop(settings: VoiceServiceSettings, deps: VoiceServerDeps): Promise<StopResult> {
  const dir = settings.modelsDir
  const running = active.get(dir)
  if (running) {
    running.ctl.abort()
    await running.done
  }
  const owned = await findOwned(settings, deps)
  if (owned) {
    const forced = await terminate(owned.pid, deps)
    await removePid(dir)
    return { status: 'stopped', forced }
  }
  if (running) return { status: 'stopped', forced: false }
  const reachable = await probeOk(settings, deps, PROBE_MS)
  return { status: reachable ? 'not-ours' : 'not-running', forced: false }
}
