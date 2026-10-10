import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceServiceSettings } from '../../../src/core/services'
import {
  MLX_AUDIO_VERSION,
  WATCHDOG_SCRIPT,
  dirSize,
  inspect,
  install,
  modelDownloaded,
  clearIncompleteBlobs,
  sanitizeProxyEnv,
  start,
  stop,
  type VoiceServerDeps,
} from '../../../src/core/voice-server'

const MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit'
const SERVER_CMD = 'python -c <watchdog> 100 --host 127.0.0.1 --port 8000 mlx_audio.server'

let dir: string
let settings: VoiceServiceSettings

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-voice-server-'))
  settings = {
    endpoint: 'http://127.0.0.1:8000',
    launch: 'mlx',
    model: MODEL,
    modelsDir: dir,
    read: 'lines',
    language: 'chinese',
    timeoutSeconds: 120,
    pauseSeconds: 2.5,
    port: 8000,
    local: true,
  }
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(pid: number): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.pid = pid
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = vi.fn()
  return c
}

interface Harness {
  deps: VoiceServerDeps
  alive: Set<number>
  signals: Array<[number, string]>
  spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>
  children: FakeChild[]
  clock: { t: number }
  /** 每次 sleep 前执行，用来在测试里制造"进程退出""取消"等事件。 */
  onSleep: Array<() => void>
  probeResults: boolean[]
  probeCalls: number
}

/** 假依赖：进程表、时钟、探测都在内存里；spawn 的行为由 behave 决定。 */
function harness(opts: {
  uv?: string | null
  platform?: string
  arch?: string
  stubborn?: boolean
  behave?: (child: FakeChild, h: Harness, cmd: string, args: string[]) => void
  probe?: (n: number) => boolean
  commandOf?: (pid: number) => string | null
} = {}): Harness {
  const h = {} as Harness
  h.alive = new Set()
  h.signals = []
  h.spawned = []
  h.children = []
  h.clock = { t: 1_000_000 }
  h.onSleep = []
  h.probeResults = []
  h.probeCalls = 0
  let nextPid = 4242
  h.deps = {
    platform: opts.platform ?? 'darwin',
    arch: opts.arch ?? 'arm64',
    env: { PATH: '/usr/bin', KEEP: 'yes' },
    which: async (name) => (name === 'uv' ? (opts.uv === undefined ? '/usr/local/bin/uv' : opts.uv) : null),
    spawn: ((cmd: string, args: string[], o: Record<string, unknown>) => {
      const c = fakeChild(nextPid++)
      h.children.push(c)
      h.spawned.push({ cmd, args, opts: o })
      h.alive.add(c.pid)
      opts.behave?.(c, h, cmd, args)
      return c
    }) as unknown as VoiceServerDeps['spawn'],
    isAlive: async (pid) => h.alive.has(pid),
    commandOf: async (pid) => (opts.commandOf ? opts.commandOf(pid) : h.alive.has(pid) ? SERVER_CMD : null),
    kill: (pid, sig) => {
      h.signals.push([pid, String(sig)])
      if (!opts.stubborn || sig === 'SIGKILL') h.alive.delete(pid)
    },
    probe: async () => {
      const n = h.probeCalls++
      return opts.probe ? opts.probe(n) : false
    },
    now: () => h.clock.t,
    sleep: async (ms) => {
      for (const f of h.onSleep.splice(0)) f()
      h.clock.t += ms
    },
    parentPid: 100,
  }
  return h
}

const pidFile = () => path.join(dir, 'server.pid')
const logFile = () => path.join(dir, 'server.log')

async function installEnvFiles(version = MLX_AUDIO_VERSION) {
  await fs.mkdir(path.join(dir, 'env', 'bin'), { recursive: true })
  await fs.writeFile(path.join(dir, 'env', 'bin', 'python'), '')
  await fs.writeFile(path.join(dir, 'env', 'pyvenv.cfg'), 'home = /usr/bin')
  await fs.writeFile(path.join(dir, 'env.installed'), JSON.stringify({ mlxAudio: version }))
}

async function addModel(modelId = MODEL, files = true) {
  const snap = path.join(dir, 'hf', 'hub', `models--${modelId.replace('/', '--')}`, 'snapshots', 'abc123')
  await fs.mkdir(snap, { recursive: true })
  if (files) {
    await fs.writeFile(path.join(snap, 'config.json'), '{}')
    await fs.writeFile(path.join(snap, 'model.safetensors'), 'w')
  }
}

async function writePid(over: Record<string, unknown> = {}) {
  await fs.writeFile(
    pidFile(),
    JSON.stringify({ pid: 4242, port: 8000, startedAt: 1, parentPid: 100, ...over }),
  )
}

const exists = (p: string) => fs.access(p).then(() => true, () => false)

describe('modelDownloaded', () => {
  const base = () => path.join(dir, 'hf/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-8bit')
  const snap = () => path.join(base(), 'snapshots/abc123')

  /** 仿 HF 缓存：blobs 里放真实文件，快照里放指向它的符号链接。 */
  async function linked(name: string, content = 'x') {
    await fs.mkdir(path.join(base(), 'blobs'), { recursive: true })
    await fs.mkdir(snap(), { recursive: true })
    await fs.writeFile(path.join(base(), 'blobs', `h-${name}`), content)
    await fs.symlink(`../../blobs/h-${name}`, path.join(snap(), name))
  }

  it('没有目录、快照为空目录都算未下载', async () => {
    expect(await modelDownloaded(dir, MODEL)).toBe(false)
    await addModel(MODEL, false)
    expect(await modelDownloaded(dir, MODEL)).toBe(false)
  })
  it('完整：有 safetensors，条目都能解析，没有 .incomplete', async () => {
    await linked('config.json')
    await linked('model.safetensors', 'weights')
    expect(await modelDownloaded(dir, MODEL)).toBe(true)
  })
  it('safetensors 在子目录里也算', async () => {
    await fs.mkdir(path.join(snap(), 'sub'), { recursive: true })
    await fs.writeFile(path.join(snap(), 'sub', 'w.safetensors'), 'x')
    expect(await modelDownloaded(dir, MODEL)).toBe(true)
  })
  it('只有小文件、没有 safetensors：未下载', async () => {
    await linked('config.json')
    expect(await modelDownloaded(dir, MODEL)).toBe(false)
  })
  it('blobs 里有 .incomplete：未下载', async () => {
    await linked('config.json')
    await linked('model.safetensors')
    await fs.writeFile(path.join(base(), 'blobs', 'abcdef.incomplete'), 'x')
    expect(await modelDownloaded(dir, MODEL)).toBe(false)
  })
  it('快照里有断掉的符号链接：未下载', async () => {
    await linked('model.safetensors')
    await fs.symlink('../../blobs/missing', path.join(snap(), 'tokenizer.json'))
    expect(await modelDownloaded(dir, MODEL)).toBe(false)
  })
})

describe('clearIncompleteBlobs', () => {
  const blobs = (id: string) => path.join(dir, 'hf/hub', `models--${id.replace(/\//g, '--')}`, 'blobs')

  it('只删当前模型 blobs 里的 .incomplete，其余文件与别的模型不动', async () => {
    await fs.mkdir(blobs(MODEL), { recursive: true })
    await fs.mkdir(blobs('org/other'), { recursive: true })
    await fs.writeFile(path.join(blobs(MODEL), 'a.incomplete'), 'x')
    await fs.writeFile(path.join(blobs(MODEL), 'b.incomplete'), 'x')
    await fs.writeFile(path.join(blobs(MODEL), 'keep'), 'x')
    await fs.writeFile(path.join(blobs('org/other'), 'o.incomplete'), 'x')
    expect(await clearIncompleteBlobs(dir, MODEL)).toBe(2)
    expect(await fs.readdir(blobs(MODEL))).toEqual(['keep'])
    expect(await fs.readdir(blobs('org/other'))).toEqual(['o.incomplete'])
  })
  it('清理后 modelDownloaded 转为 true', async () => {
    const base = path.join(dir, 'hf/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-Base-8bit')
    await fs.mkdir(path.join(base, 'blobs'), { recursive: true })
    await fs.mkdir(path.join(base, 'snapshots/s'), { recursive: true })
    await fs.writeFile(path.join(base, 'blobs/h'), 'w')
    await fs.symlink('../../blobs/h', path.join(base, 'snapshots/s/model.safetensors'))
    await fs.writeFile(path.join(base, 'blobs/z.incomplete'), 'x')
    expect(await modelDownloaded(dir, MODEL)).toBe(false)
    await clearIncompleteBlobs(dir, MODEL)
    expect(await modelDownloaded(dir, MODEL)).toBe(true)
  })
  it('目录不存在：返回 0', async () => {
    expect(await clearIncompleteBlobs(dir, MODEL)).toBe(0)
  })
})

describe('inspect', () => {
  it('平台不支持', async () => {
    const h = harness({ platform: 'linux', arch: 'x64' })
    expect((await inspect(settings, h.deps)).supported).toBe(false)
    const h2 = harness({ arch: 'x64' })
    expect((await inspect(settings, h2.deps)).supported).toBe(false)
    expect((await inspect(settings, harness().deps)).supported).toBe(true)
  })

  it('没有 uv', async () => {
    expect((await inspect(settings, harness({ uv: null }).deps)).uv).toBeNull()
    expect((await inspect(settings, harness().deps)).uv).toBe('/usr/local/bin/uv')
  })

  it('环境：没装、已装、版本不一致', async () => {
    const h = harness()
    expect((await inspect(settings, h.deps)).envInstalled).toBe(false)
    await installEnvFiles()
    expect((await inspect(settings, h.deps)).envInstalled).toBe(true)
    await installEnvFiles('0.0.1')
    expect((await inspect(settings, h.deps)).envInstalled).toBe(false)
  })

  it('环境有 python 但没有标记文件算未装', async () => {
    await fs.mkdir(path.join(dir, 'env', 'bin'), { recursive: true })
    await fs.writeFile(path.join(dir, 'env', 'bin', 'python'), '')
    expect((await inspect(settings, harness().deps)).envInstalled).toBe(false)
  })

  it('模型下载与否', async () => {
    const h = harness()
    expect((await inspect(settings, h.deps)).modelDownloaded).toBe(false)
    await addModel()
    expect((await inspect(settings, h.deps)).modelDownloaded).toBe(true)
  })

  it('占用空间不重复计入符号链接', async () => {
    await fs.mkdir(path.join(dir, 'env'), { recursive: true })
    await fs.writeFile(path.join(dir, 'env', 'a'), 'x'.repeat(10))
    const base = path.join(dir, 'hf', 'hub', 'models--o--m')
    await fs.mkdir(path.join(base, 'blobs'), { recursive: true })
    await fs.mkdir(path.join(base, 'snapshots', 'rev'), { recursive: true })
    await fs.writeFile(path.join(base, 'blobs', 'b1'), 'y'.repeat(100))
    await fs.symlink('../../blobs/b1', path.join(base, 'snapshots', 'rev', 'w.bin'))
    const r = await inspect(settings, harness().deps)
    expect(r.sizes).toEqual({ env: 10, hf: 100 })
  })

  it('已在运行且是插件启动的', async () => {
    const h = harness()
    h.alive.add(4242)
    await writePid()
    h.deps.probe = async () => true
    const r = await inspect(settings, h.deps)
    expect(r.owned).toEqual({ pid: 4242, port: 8000, startedAt: 1 })
    expect(r.reachable).toBe(true)
  })

  it('已在运行但不是插件启动的：没有 pid 文件', async () => {
    const h = harness({ probe: () => true })
    const r = await inspect(settings, h.deps)
    expect(r.owned).toBeNull()
    expect(r.reachable).toBe(true)
  })

  it('pid 文件残留但进程已死：删掉残留', async () => {
    await writePid()
    const r = await inspect(settings, harness().deps)
    expect(r.owned).toBeNull()
    expect(await exists(pidFile())).toBe(false)
  })

  it('进程号被别的进程复用：不认，删掉残留', async () => {
    const h = harness({ commandOf: () => 'vim notes.txt' })
    h.alive.add(4242)
    await writePid()
    const r = await inspect(settings, h.deps)
    expect(r.owned).toBeNull()
    expect(await exists(pidFile())).toBe(false)
  })

  it('端口不一致：不算插件启动的', async () => {
    const h = harness()
    h.alive.add(4242)
    await writePid({ port: 9999 })
    expect((await inspect(settings, h.deps)).owned).toBeNull()
  })

  it('pid 文件内容坏了：当残留删掉', async () => {
    await fs.writeFile(pidFile(), 'not json')
    expect((await inspect(settings, harness().deps)).owned).toBeNull()
    expect(await exists(pidFile())).toBe(false)
  })

  it('探测抛错按连不上处理', async () => {
    const h = harness()
    h.deps.probe = async () => {
      throw new Error('boom')
    }
    expect((await inspect(settings, h.deps)).reachable).toBe(false)
  })
})

describe('start', () => {
  it('成功：参数、环境变量、pid 文件', async () => {
    await installEnvFiles()
    settings.hfEndpoint = 'https://hf-mirror.example'
    const h = harness({ probe: (n) => n >= 3 })
    const r = await start(settings, h.deps)
    expect(r).toEqual({ ok: true, pid: 4242, alreadyRunning: false })
    const call = h.spawned[0]!
    expect(call.cmd).toBe(path.join(dir, 'env', 'bin', 'python'))
    expect(call.args).toEqual(['-c', WATCHDOG_SCRIPT, '100', '--host', '127.0.0.1', '--port', '8000'])
    const env = call.opts.env as Record<string, string>
    expect(env.HF_HOME).toBe(path.join(dir, 'hf'))
    expect(env.HF_ENDPOINT).toBe('https://hf-mirror.example')
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(env.KEEP).toBe('yes')
    expect(call.opts.detached).toBeFalsy()
    const stdio = call.opts.stdio as unknown[]
    expect(stdio[0]).toBe('ignore')
    expect(typeof stdio[1]).toBe('number')
    expect(stdio[1]).toBe(stdio[2])
    const rec = JSON.parse(await fs.readFile(pidFile(), 'utf8'))
    expect(rec).toMatchObject({ pid: 4242, port: 8000, parentPid: 100 })
    expect(typeof rec.startedAt).toBe('number')
    expect(h.probeCalls).toBe(4)
  })

  it('没有 hfEndpoint 时不设 HF_ENDPOINT', async () => {
    await installEnvFiles()
    const h = harness({ probe: (n) => n >= 1 })
    await start(settings, h.deps)
    const env = h.spawned[0]!.opts.env as Record<string, string>
    expect('HF_ENDPOINT' in env).toBe(false)
  })

  it('环境没装、平台不支持', async () => {
    const r = await start(settings, harness().deps)
    expect(r).toMatchObject({ ok: false, kind: 'not-installed' })
    await installEnvFiles()
    const r2 = await start(settings, harness({ platform: 'linux' }).deps)
    expect(r2).toMatchObject({ ok: false, kind: 'unsupported' })
  })

  it('已有插件启动的服务在跑：不重复启动', async () => {
    await installEnvFiles()
    const h = harness({ probe: () => true })
    h.alive.add(4242)
    await writePid()
    expect(await start(settings, h.deps)).toEqual({ ok: true, pid: 4242, alreadyRunning: true })
    expect(h.spawned).toHaveLength(0)
  })

  it('超时：结束进程、删 pid 文件', async () => {
    await installEnvFiles()
    const h = harness({ probe: () => false })
    const r = await start(settings, h.deps, { timeoutMs: 2000 })
    expect(r).toMatchObject({ ok: false, kind: 'timeout' })
    expect(h.signals[0]).toEqual([4242, 'SIGTERM'])
    expect(await exists(pidFile())).toBe(false)
    expect(h.alive.has(4242)).toBe(false)
  })

  it('进程提前退出：附日志末尾', async () => {
    await installEnvFiles()
    await fs.writeFile(logFile(), 'l1\nTraceback boom\n')
    const h = harness({
      behave: (c, hh) => {
        hh.onSleep.push(() => {
          hh.alive.delete(c.pid)
          c.emit('exit', 1, null)
        })
      },
    })
    const r = await start(settings, h.deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('exited')
      expect(r.detail).toContain('Traceback boom')
    }
    expect(await exists(pidFile())).toBe(false)
  })

  it('spawn 报 error 也算退出', async () => {
    await installEnvFiles()
    const h = harness({
      behave: (c, hh) => {
        hh.onSleep.push(() => c.emit('error', new Error('ENOENT')))
      },
    })
    expect(await start(settings, h.deps)).toMatchObject({ ok: false, kind: 'exited' })
  })

  it('启动中取消', async () => {
    await installEnvFiles()
    const ctl = new AbortController()
    const h = harness()
    h.onSleep.push(() => ctl.abort())
    const r = await start(settings, h.deps, { signal: ctl.signal })
    expect(r).toMatchObject({ ok: false, kind: 'cancelled' })
    expect(await exists(pidFile())).toBe(false)
    expect(h.alive.has(4242)).toBe(false)
  })

  it('日志超过 1MB 先清空', async () => {
    await installEnvFiles()
    await fs.writeFile(logFile(), 'x'.repeat(1024 * 1024 + 1))
    await start(settings, harness({ probe: (n) => n >= 1 }).deps)
    expect((await fs.stat(logFile())).size).toBe(0)
  })

  it('同一目录同时只允许一个：第二个立即 busy', async () => {
    await installEnvFiles()
    const h = harness({ probe: (n) => n >= 3 })
    const first = start(settings, h.deps)
    const second = await start(settings, h.deps)
    expect(second).toMatchObject({ ok: false, kind: 'busy' })
    expect((await inspect(settings, h.deps)).busy).toBe(true)
    expect((await first).ok).toBe(true)
    expect((await inspect(settings, h.deps)).busy).toBe(false)
  })

  it('stop 在探测轮询中取消 start：结束进程、删 pid 文件，不重复 kill', async () => {
    await installEnvFiles()
    const h = harness()
    let stopped: ReturnType<typeof stop> | undefined
    h.onSleep.push(() => {
      stopped = stop(settings, h.deps)
    })
    const r = await start(settings, h.deps)
    expect(r).toMatchObject({ ok: false, kind: 'cancelled' })
    expect(h.spawned).toHaveLength(1)
    expect(await stopped).toMatchObject({ status: 'stopped' })
    expect(h.signals).toEqual([[4242, 'SIGTERM']])
    expect(await exists(pidFile())).toBe(false)
  })

  it('端口上已有别的服务：不启动，返回 occupied', async () => {
    await installEnvFiles()
    const h = harness({ probe: () => true })
    expect(await start(settings, h.deps)).toMatchObject({ ok: false, kind: 'occupied' })
    expect(h.spawned).toHaveLength(0)
  })

  it('spawn 同步抛错：返回 failed，日志 fd 已关闭', async () => {
    await installEnvFiles()
    const h = harness()
    h.deps.spawn = (() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    }) as unknown as VoiceServerDeps['spawn']
    const r = await start(settings, h.deps)
    expect(r).toMatchObject({ ok: false, kind: 'failed' })
    expect(await exists(pidFile())).toBe(false)
    // 目录能照常清理说明没有遗留句柄冲突；busy 也已释放
    expect((await inspect(settings, h.deps)).busy).toBe(false)
  })
})

describe('stop', () => {
  it('温和结束成功', async () => {
    const h = harness()
    h.alive.add(4242)
    await writePid()
    const r = await stop(settings, h.deps)
    expect(r).toMatchObject({ status: 'stopped', forced: false })
    expect(h.signals).toEqual([[4242, 'SIGTERM']])
    expect(await exists(pidFile())).toBe(false)
  })

  it('3 秒不退就强制', async () => {
    const h = harness({ stubborn: true })
    h.alive.add(4242)
    await writePid()
    const r = await stop(settings, h.deps)
    expect(r).toMatchObject({ status: 'stopped', forced: true })
    expect(h.signals.map((s) => s[1])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await exists(pidFile())).toBe(false)
  })

  it('不是插件启动的', async () => {
    const h = harness({ probe: () => true })
    expect((await stop(settings, h.deps)).status).toBe('not-ours')
    expect(h.signals).toHaveLength(0)
  })

  it('进程号被复用：不杀别人的进程', async () => {
    const h = harness({ commandOf: () => 'vim', probe: () => true })
    h.alive.add(4242)
    await writePid()
    expect((await stop(settings, h.deps)).status).toBe('not-ours')
    expect(h.signals).toHaveLength(0)
  })

  it('没有服务在跑', async () => {
    const h = harness()
    expect((await stop(settings, h.deps)).status).toBe('not-running')
  })
})

describe('install', () => {
  const ok = (c: FakeChild, lines = 'line one\nline two\n') => {
    setImmediate(() => {
      c.stdout.emit('data', Buffer.from(lines))
      c.emit('exit', 0, null)
      c.emit('close', 0, null)
    })
  }

  it('成功：两步命令、标记文件、日志', async () => {
    const h = harness({ behave: (c) => ok(c) })
    const lines: string[] = []
    const r = await install(settings, h.deps, { onLog: (l) => lines.push(l) })
    expect(r).toEqual({ ok: true })
    expect(h.spawned.map((s) => [s.cmd, s.args])).toEqual([
      ['/usr/local/bin/uv', ['venv', '--clear', '--python', '3.12', path.join(dir, 'env')]],
      [
        '/usr/local/bin/uv',
        ['pip', 'install', '--python', path.join(dir, 'env', 'bin', 'python'), `mlx-audio[server]==${MLX_AUDIO_VERSION}`],
      ],
    ])
    expect(lines).toEqual(['line one', 'line two', 'line one', 'line two'])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'env.installed'), 'utf8')).mlxAudio).toBe(MLX_AUDIO_VERSION)
    expect(await fs.readFile(logFile(), 'utf8')).toContain('line two')
  })

  describe('env 目录核对（uv venv --clear 会清空目标）', () => {
    it('env 里有别的内容、没有 pyvenv.cfg：不执行任何命令，返回 env-not-ours，内容原样保留', async () => {
      await fs.mkdir(path.join(dir, 'env', 'src'), { recursive: true })
      await fs.writeFile(path.join(dir, 'env', 'src', 'a.txt'), 'mine')
      const h = harness({ behave: (c) => ok(c) })
      const r = await install(settings, h.deps)
      expect(r).toMatchObject({ ok: false, kind: 'env-not-ours' })
      expect(h.spawned).toHaveLength(0)
      expect(await fs.readFile(path.join(dir, 'env', 'src', 'a.txt'), 'utf8')).toBe('mine')
    })

    it('env 是普通文件：同样拒绝', async () => {
      await fs.writeFile(path.join(dir, 'env'), 'x')
      const h = harness({ behave: (c) => ok(c) })
      expect(await install(settings, h.deps)).toMatchObject({ ok: false, kind: 'env-not-ours' })
      expect(h.spawned).toHaveLength(0)
    })

    it('env 不存在、为空、或带 pyvenv.cfg：继续', async () => {
      const a = harness({ behave: (c) => ok(c) })
      expect(await install(settings, a.deps)).toEqual({ ok: true })
      await fs.rm(path.join(dir, 'env.installed'), { force: true })
      await fs.mkdir(path.join(dir, 'env'), { recursive: true })
      const b = harness({ behave: (c) => ok(c) })
      expect(await install(settings, b.deps)).toEqual({ ok: true })
      await fs.writeFile(path.join(dir, 'env', 'pyvenv.cfg'), 'home = /x')
      await fs.writeFile(path.join(dir, 'env', 'other.txt'), 'x')
      const c = harness({ behave: (ch) => ok(ch) })
      expect(await install(settings, c.deps)).toEqual({ ok: true })
      expect(c.spawned).toHaveLength(2)
    })

    it('inspect 在环境没装好且 env 里是别的内容时标出 envForeign', async () => {
      await fs.mkdir(path.join(dir, 'env'), { recursive: true })
      await fs.writeFile(path.join(dir, 'env', 'a.txt'), 'x')
      const h = harness()
      expect((await inspect(settings, h.deps, { sizes: false })).envForeign).toBe(true)
      await fs.rm(path.join(dir, 'env'), { recursive: true })
      expect((await inspect(settings, h.deps, { sizes: false })).envForeign).toBe(false)
    })
  })

  it('没有 uv', async () => {
    const h = harness({ uv: null })
    expect(await install(settings, h.deps)).toMatchObject({ ok: false, kind: 'no-uv' })
    expect(h.spawned).toHaveLength(0)
  })

  it('平台不支持', async () => {
    expect(await install(settings, harness({ platform: 'win32' }).deps)).toMatchObject({
      ok: false,
      kind: 'unsupported',
    })
  })

  it('中途取消：杀掉子进程，不写标记', async () => {
    const ctl = new AbortController()
    const h = harness({
      behave: (c) => {
        c.kill.mockImplementation(() => setImmediate(() => c.emit('close', null, 'SIGTERM')))
        setImmediate(() => ctl.abort())
      },
    })
    const r = await install(settings, h.deps, { signal: ctl.signal })
    expect(r).toMatchObject({ ok: false, kind: 'cancelled' })
    expect(h.children[0]!.kill).toHaveBeenCalled()
    expect(h.spawned).toHaveLength(1)
    expect(await exists(path.join(dir, 'env.installed'))).toBe(false)
  })

  it('stop 会取消进行中的 install', async () => {
    const h = harness({
      behave: (c) => {
        c.kill.mockImplementation(() => setImmediate(() => c.emit('close', null, 'SIGTERM')))
      },
    })
    const pending = install(settings, h.deps)
    await new Promise((r) => setImmediate(r))
    expect((await stop(settings, h.deps)).status).toBe('stopped')
    expect(await pending).toMatchObject({ ok: false, kind: 'cancelled' })
  })

  it('网络问题与其他失败分别归类', async () => {
    const fail = (text: string) =>
      harness({
        behave: (c) =>
          setImmediate(() => {
            c.stderr.emit('data', Buffer.from(text))
            c.emit('close', 2, null)
          }),
      })
    const net = await install(settings, fail('error: Failed to fetch: dns error: failed to lookup address').deps)
    expect(net).toMatchObject({ ok: false, kind: 'network' })
    const other = await install(settings, fail('error: something else').deps)
    expect(other).toMatchObject({ ok: false, kind: 'failed' })
    expect(await exists(path.join(dir, 'env.installed'))).toBe(false)
  })

  it('同目录并发安装第二个 busy', async () => {
    const h = harness({ behave: (c) => ok(c) })
    const first = install(settings, h.deps)
    expect(await install(settings, h.deps)).toMatchObject({ ok: false, kind: 'busy' })
    expect((await first).ok).toBe(true)
  })

  it('重装前先去掉旧标记', async () => {
    await installEnvFiles('0.0.1')
    const h = harness({
      behave: (c) =>
        setImmediate(() => {
          c.emit('close', 1, null)
        }),
    })
    await install(settings, h.deps)
    expect(await exists(path.join(dir, 'env.installed'))).toBe(false)
  })

  it('env 目录已存在、标记不存在：能走完安装', async () => {
    await fs.mkdir(path.join(dir, 'env', 'bin'), { recursive: true })
    await fs.writeFile(path.join(dir, 'env', 'bin', 'python'), '')
    await fs.writeFile(path.join(dir, 'env', 'pyvenv.cfg'), 'home = /usr/bin')
    const h = harness({ behave: (c) => ok(c) })
    expect(await install(settings, h.deps)).toEqual({ ok: true })
    expect(h.spawned[0]!.args).toContain('--clear')
    expect(await exists(path.join(dir, 'env.installed'))).toBe(true)
  })

  it('spawn 同步抛错：ENOENT 归 no-uv，其他归 failed', async () => {
    const make = (code: string) => {
      const h = harness()
      h.deps.spawn = (() => {
        throw Object.assign(new Error('x'), { code })
      }) as unknown as VoiceServerDeps['spawn']
      return h
    }
    expect(await install(settings, make('ENOENT').deps)).toMatchObject({ ok: false, kind: 'no-uv' })
    expect(await install(settings, make('EACCES').deps)).toMatchObject({ ok: false, kind: 'failed' })
  })

  it('取消后 SIGTERM 不管用就补 SIGKILL', async () => {
    const ctl = new AbortController()
    const h = harness({
      behave: (c) => {
        c.kill.mockImplementation((sig: string) => {
          if (sig === 'SIGKILL') setImmediate(() => c.emit('close', null, 'SIGKILL'))
        })
        setImmediate(() => ctl.abort())
      },
    })
    const r = await install(settings, h.deps, { signal: ctl.signal })
    expect(r).toMatchObject({ ok: false, kind: 'cancelled' })
    expect(h.children[0]!.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('"resolved" 之类的依赖解析报错不算网络问题', async () => {
    const h = harness({
      behave: (c) =>
        setImmediate(() => {
          c.stderr.emit('data', Buffer.from('error: No solution found when resolving dependencies'))
          c.emit('close', 1, null)
        }),
    })
    expect(await install(settings, h.deps)).toMatchObject({ ok: false, kind: 'failed' })
  })
})

describe('dirSize', () => {
  it('遍历中 lstat 失败当 0，不抛错', async () => {
    await fs.writeFile(path.join(dir, 'a'), 'xxxx')
    await fs.writeFile(path.join(dir, 'b'), 'yy')
    const lstat = (async (p: string) => {
      if (String(p).endsWith('a')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return fs.lstat(p)
    }) as unknown as typeof fs.lstat
    expect(await dirSize(dir, lstat)).toBe(2)
  })
})

describe('sanitizeProxyEnv', () => {
  it('去掉 NO_PROXY / no_proxy 里带方括号的条目，其余保留', () => {
    const r = sanitizeProxyEnv({ NO_PROXY: 'localhost, 127.0.0.1 ,::1,[::1]', no_proxy: 'a.com,[::1],b.com', KEEP: 'x' })
    expect(r.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(r.no_proxy).toBe('a.com,b.com')
    expect(r.KEEP).toBe('x')
  })
  it('只有方括号条目：删掉该变量', () => {
    const r = sanitizeProxyEnv({ NO_PROXY: '[::1]', no_proxy: '[::1], ]x[' })
    expect('NO_PROXY' in r).toBe(false)
    expect('no_proxy' in r).toBe(false)
  })
  it('没有该变量：原样；不改入参', () => {
    const src = { A: '1', NO_PROXY: '[::1],x' }
    expect(sanitizeProxyEnv({ A: '1' })).toEqual({ A: '1' })
    sanitizeProxyEnv(src)
    expect(src.NO_PROXY).toBe('[::1],x')
  })
})

describe('子进程环境', () => {
  it('start 与 install 都过滤 NO_PROXY', async () => {
    await installEnvFiles()
    const h = harness({ probe: (n) => n >= 1 })
    h.deps.env = { PATH: '/usr/bin', NO_PROXY: 'localhost,[::1]', no_proxy: '[::1]' }
    await start(settings, h.deps)
    const e1 = h.spawned[0]!.opts.env as Record<string, string>
    expect(e1.NO_PROXY).toBe('localhost')
    expect('no_proxy' in e1).toBe(false)

    const h2 = harness({
      behave: (c) => setImmediate(() => { c.emit('exit', 0, null); c.emit('close', 0, null) }),
    })
    h2.deps.env = { NO_PROXY: 'localhost,[::1]' }
    await install(settings, h2.deps)
    for (const sp of h2.spawned) expect((sp.opts.env as Record<string, string>).NO_PROXY).toBe('localhost')
  })
})

describe('start 的 offline 选项', () => {
  it('为真时加 HF_HUB_OFFLINE=1，否则不加', async () => {
    await installEnvFiles()
    const h = harness({ probe: (n) => n >= 1 })
    await start(settings, h.deps, { offline: true })
    expect((h.spawned[0]!.opts.env as Record<string, string>).HF_HUB_OFFLINE).toBe('1')
    await stop(settings, h.deps)
    const h2 = harness({ probe: (n) => n >= 1 })
    await start(settings, h2.deps, { offline: false })
    expect('HF_HUB_OFFLINE' in (h2.spawned[0]!.opts.env as Record<string, string>)).toBe(false)
  })
})

describe('inspect 跳过大小统计', () => {
  it('sizes: false 时 sizes 为 undefined，其余照常', async () => {
    await fs.mkdir(path.join(dir, 'env'), { recursive: true })
    await fs.writeFile(path.join(dir, 'env', 'a'), 'x'.repeat(10))
    const r = await inspect(settings, harness().deps, { sizes: false })
    expect(r.sizes).toBeUndefined()
    expect(r.uv).toBe('/usr/local/bin/uv')
    expect((await inspect(settings, harness().deps)).sizes).toEqual({ env: 10, hf: 0 })
  })
})
