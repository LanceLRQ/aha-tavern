import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceServiceResult, VoiceServiceSettings } from '../../../src/core/services'
import { TtsError } from '../../../src/core/tts'
import type { VoiceServerInfo } from '../../../src/core/voice-server'
import { SessionGate } from '../../../src/shell/confirm'
import type { Invocation } from '../../../src/shell/context'
import { handleCommand, parseSubcommand } from '../../../src/shell/commands'
import { VOICE_OPT_CANCEL, VOICE_OPT_GO } from '../../../src/shell/receipts'
import {
  BUILTIN_VOICE_TEXT, START_WAIT_MS, abortLaunch, builtinVoice, createVoiceHandler, installVoice, parseVoiceArgs,
  launchSnapshot, isLaunching, resetLaunchesForTest, startServiceHeld, whichOnPath, lastStartOffline, restartVoiceService, type VoiceInstanceState, type VoiceOps,
} from '../../../src/shell/voice'

const MODEL_06 = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit'
const DIR = '/data/voice'

const settings = (over: Partial<VoiceServiceSettings> = {}): VoiceServiceSettings => ({
  endpoint: 'http://127.0.0.1:18123', launch: 'mlx', model: MODEL_06, modelAlias: '0.6b', modelsDir: DIR,
  read: 'lines', language: 'chinese', timeoutSeconds: 120, port: 18123, local: true, ...over,
})
const info = (over: Partial<VoiceServerInfo> = {}): VoiceServerInfo => ({
  supported: true, uv: '/usr/bin/uv', envInstalled: true, modelDownloaded: true, sizes: { env: 0, hf: 0 },
  owned: null, reachable: false, busy: false, ...over,
})

let cfg: VoiceServiceResult
let ops: { [K in keyof VoiceOps]: ReturnType<typeof vi.fn> }
let synth: ReturnType<typeof vi.fn>
let probeModels: ReturnType<typeof vi.fn>
let clock: { t: number }
let askFn: ReturnType<typeof vi.fn> | undefined
let gate: SessionGate
let state: VoiceInstanceState
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const serverDeps = { tag: 'deps' }

const mkInv = (args: string, signal?: AbortSignal): Invocation => ({
  agent: { id: 's1', ctx: {} }, args, label: '/aha 语音', services: {} as any, theme: {} as any,
  context: {} as any, steer: vi.fn(), ...(signal ? { signal } : {}),
  rt: {
    log, builtinAssetsDir: '/assets', voiceSettings: async () => cfg, voiceServerDeps: () => serverDeps,
    cards: askFn ? { gate, getAsk: () => askFn as any } : undefined, handlers: {},
  } as any,
})
const run = (args: string, signal?: AbortSignal) => createVoiceHandler(state, ops as unknown as VoiceOps)(mkInv(args, signal)) as Promise<{ kind: string; text: string }>
afterEach(() => resetLaunchesForTest())
const pick = (label: string) =>
  askFn!.mockImplementation(async (req: any) => ({ answers: [{ id: req.questions[0].id, selected: [label] }] }))

beforeEach(() => {
  cfg = { configured: true, settings: settings(), problems: [] }
  synth = vi.fn().mockResolvedValue({ bytes: new Uint8Array(), format: 'wav' })
  probeModels = vi.fn().mockResolvedValue([MODEL_06])
  clock = { t: 1_000_000 }
  resetLaunchesForTest()
  ops = {
    inspect: vi.fn().mockResolvedValue(info()),
    install: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue({ ok: true, pid: 9, alreadyRunning: false }),
    stop: vi.fn().mockResolvedValue({ status: 'stopped', forced: false }),
    modelDownloaded: vi.fn(),
    clearIncomplete: vi.fn().mockResolvedValue(2),
    createClient: vi.fn(() => ({ synthesize: synth, probe: probeModels })),
    now: vi.fn(() => clock.t),
    // 默认永不返回：启动在 8 秒内完成才有最终回执；要测转后台的用例自己放行
    sleep: vi.fn(() => new Promise<void>(() => undefined)),
  }
  askFn = vi.fn()
  gate = new SessionGate()
  state = { started: null, launching: null }
  Object.values(log).forEach((f) => f.mockClear())
})

describe('参数解析', () => {
  it.each([
    ['', 'status'], ['状态', 'status'], ['Status', 'status'], ['启动', 'start'], ['START', 'start'],
    ['停止', 'stop'], ['stop', 'stop'], ['跳舞', 'usage'], ['启动 现在', 'usage'],
  ])('%j -> %s', (args, want) => expect(parseVoiceArgs(args)).toBe(want))

  it('认不出的参数回用法，不读配置也不起进程', async () => {
    const r = await run('跳舞')
    expect(r.text).toContain('用法')
    expect(ops.inspect).not.toHaveBeenCalled()
  })
})

describe('分流', () => {
  // 分流表逐格见 core/dispatch.test.ts；这里确认两种模式的入口都把 voice 交给处理函数
  it.each([['setup', 'tavern-setup'], ['chat', 'tavern-chat']] as const)('%s 模式（门外）', async (mode, preset) => {
    const handler = vi.fn(async () => ({ kind: 'success' as const, text: 'ok' }))
    const rt: any = { config: { mode }, log, theme: async () => ({}), handlers: { voice: handler } }
    const r = await handleCommand(rt, { agentPresets: { composedPreset: () => preset } } as any,
      { id: 's1', ctx: {}, session: { header: {} } } as any, parseSubcommand('语音 状态'), '/aha 语音')
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ args: '状态' }))
    expect(r.text).toBe('ok')
  })
})

describe('状态', () => {
  it('没配置', async () => {
    cfg = { configured: false, problems: [] }
    expect((await run('')).text).toBe('语音服务：未配置（见 docs/voice-setup.md）。')
  })
  it('连不上', async () => {
    expect((await run('状态')).text).toBe('语音服务：未启动。')
  })
  it('连得上，插件启动的', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true, owned: { pid: 1, port: 1, startedAt: 1 } }))
    expect((await run('')).text).toBe('语音服务：已在运行（由插件启动），模型 0.6b。')
    expect(ops.inspect.mock.calls[0]![2]).toEqual({ sizes: false })
  })
  it('连得上但模型尚未加载（含外部服务）', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    probeModels.mockResolvedValue([])
    expect((await run('')).text).toBe('语音服务：已在运行（外部启动），模型尚未加载（配置为 0.6b）。')
  })
  it('连得上但取不到已加载列表：不写模型', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    probeModels.mockRejectedValue(new Error('x'))
    expect((await run('')).text).toBe('语音服务：已在运行（外部启动）。')
  })
  it('连得上，外部启动的', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    expect((await run('')).text).toBe('语音服务：已在运行（外部启动），模型 0.6b。')
  })
  it('正在启动中', async () => {
    ops.inspect.mockResolvedValue(info({ busy: true }))
    expect((await run('')).text).toBe('语音服务：正在启动中。')
  })
  it('没配 modelAlias 时写完整模型名', async () => {
    cfg = { configured: true, settings: settings({ modelAlias: undefined, model: 'org/x' }), problems: [] }
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    probeModels.mockResolvedValue(['org/x'])
    expect((await run('')).text).toContain('org/x')
  })
})

describe('启动：不起进程的情况', () => {
  const noProcess = () => {
    expect(ops.install).not.toHaveBeenCalled()
    expect(ops.start).not.toHaveBeenCalled()
    expect(synth).not.toHaveBeenCalled()
    expect(askFn).not.toHaveBeenCalled()
  }
  it('没配置：指向文档', async () => {
    cfg = { configured: false, problems: [] }
    const r = await run('启动')
    expect(r.text).toContain('docs/voice-setup.md')
    expect(ops.inspect).not.toHaveBeenCalled()
    noProcess()
  })
  it('地址带用户名密码：不支持，不发请求', async () => {
    cfg = { configured: true, settings: settings({ endpoint: 'http://u:p@127.0.0.1:18123' }), problems: [] }
    const r = await run('启动')
    expect(r.text).toContain('用户名')
    expect(ops.inspect).not.toHaveBeenCalled()
    noProcess()
  })
  it('已在运行（插件启动的）', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true, owned: { pid: 1, port: 1, startedAt: 1 } }))
    expect((await run('启动')).text).toBe('语音服务已在运行。')
    noProcess()
  })
  it('已在运行（外部的）', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    expect((await run('启动')).text).toBe('语音服务已在运行（不是由插件启动的）。')
    noProcess()
  })
  it('launch: none', async () => {
    cfg = { configured: true, settings: settings({ launch: 'none' }), problems: [] }
    expect((await run('启动')).text).toContain('自己启动')
    noProcess()
  })
  it('平台不支持', async () => {
    ops.inspect.mockResolvedValue(info({ supported: false }))
    expect((await run('启动')).text).toContain('苹果芯片')
    noProcess()
  })
  it('没有 uv', async () => {
    ops.inspect.mockResolvedValue(info({ uv: null }))
    expect((await run('启动')).text).toContain('uv')
    noProcess()
  })
  it('正在启动中', async () => {
    ops.inspect.mockResolvedValue(info({ busy: true }))
    expect((await run('启动')).text).toBe('语音服务正在启动中，请稍候。')
    noProcess()
  })
  it('env 位置上已有别的内容：规划阶段就回说明，不弹卡片、不安装', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false, envForeign: true }))
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(r.text).toBe(`${DIR}/env 里已有别的内容，不是插件建的运行环境，请换一个权重目录或清空它。`)
    noProcess()
  })
  it('安装时才发现 env 不是插件建的（别处改了目录）：同样的说明，记为失败', async () => {
    ops.install.mockResolvedValue({ ok: false, kind: 'env-not-ours', detail: '' })
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    const r = await run('启动')
    expect(r.text).toBe(`${DIR}/env 里已有别的内容，不是插件建的运行环境，请换一个权重目录或清空它。`)
    expect(ops.start).not.toHaveBeenCalled()
    expect((await run('状态')).text).toContain('上次启动失败')
  })
  it('需要安装但没有提问服务：不启动，说明要在界面里操作', async () => {
    askFn = undefined
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    const r = await run('启动')
    expect(r.text).toContain('界面')
    expect(ops.install).not.toHaveBeenCalled()
    expect(ops.start).not.toHaveBeenCalled()
  })
})

describe('启动：确认卡片', () => {
  it('环境和模型都缺：卡片列出两项、目录、官方下载源、内存提示', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false, modelDownloaded: false }))
    pick(VOICE_OPT_GO)
    await run('启动')
    const item = askFn!.mock.calls[0]![0].questions[0]
    expect(item.options.map((o: any) => o.label)).toEqual([VOICE_OPT_GO, VOICE_OPT_CANCEL])
    expect(item.detail).toContain('运行环境（约 0.5GB）')
    expect(item.detail).toContain('模型 0.6b（约 1.9GB）')
    expect(item.detail).toContain(`存放目录：${DIR}`)
    expect(item.detail).toContain('下载源：官方')
    expect(item.detail).toContain('9GB')
  })
  it('只缺模型：不列运行环境；1.7b 约 2.9GB；下载源写镜像地址（去掉账号）', async () => {
    cfg = {
      configured: true, problems: [],
      settings: settings({ model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit', modelAlias: '1.7b', hfEndpoint: 'https://u:p@hf-mirror.com' }),
    }
    ops.inspect.mockResolvedValue(info({ modelDownloaded: false }))
    pick(VOICE_OPT_GO)
    await run('启动')
    const d = askFn!.mock.calls[0]![0].questions[0].detail as string
    expect(d).not.toContain('运行环境')
    expect(d).toContain('模型 1.7b（约 2.9GB）')
    expect(d).toContain('下载源：https://hf-mirror.com')
    expect(d).not.toContain('u:p')
  })
  it('其他模型写大小未知', async () => {
    cfg = { configured: true, problems: [], settings: settings({ model: 'org/x', modelAlias: undefined }) }
    ops.inspect.mockResolvedValue(info({ modelDownloaded: false }))
    pick(VOICE_OPT_GO)
    await run('启动')
    expect(askFn!.mock.calls[0]![0].questions[0].detail).toContain('模型 org/x（大小未知）')
  })
  it('只缺环境：不列模型', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    await run('启动')
    const d = askFn!.mock.calls[0]![0].questions[0].detail as string
    expect(d).toContain('运行环境')
    expect(d).not.toContain('模型 0.6b')
    expect(d).not.toContain('下载源')
  })
  it('选取消：什么都没做', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false, modelDownloaded: false }))
    pick(VOICE_OPT_CANCEL)
    const r = await run('启动')
    expect(r.text).toContain('已取消')
    expect(ops.install).not.toHaveBeenCalled()
    expect(ops.start).not.toHaveBeenCalled()
    expect(synth).not.toHaveBeenCalled()
    expect(state.started).toBeNull()
  })
  it('卡片被中止：视为取消', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    askFn!.mockRejectedValue(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    const r = await run('启动')
    expect(r.text).toContain('已取消')
    expect(ops.install).not.toHaveBeenCalled()
  })
  it('同会话已有命令卡片未答：不再弹，回提示', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    const hold = gate.run('s1', () => new Promise(() => undefined), 'command')
    void hold
    const r = await run('启动')
    expect(r.text).toContain('卡片')
    expect(ops.install).not.toHaveBeenCalled()
  })
  it('全部就绪：不弹卡片直接启动并预热', async () => {
    const r = await run('启动')
    expect(askFn).not.toHaveBeenCalled()
    expect(ops.install).not.toHaveBeenCalled()
    expect(ops.start).toHaveBeenCalledTimes(1)
    expect(r.kind).toBe('success')
    expect(r.text).toBe(`语音服务已启动，模型 0.6b，权重目录 ${DIR}。`)
  })
})

describe('启动：安装、启动与预热', () => {
  it('先 install 再 start；后台任务不接宿主信号，传的是自己的可打断信号', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    const ctl = new AbortController()
    const order: string[] = []
    ops.install.mockImplementation(async () => (order.push('install'), { ok: true }))
    ops.start.mockImplementation(async () => (order.push('start'), { ok: true, pid: 9, alreadyRunning: false }))
    await run('启动', ctl.signal)
    expect(order).toEqual(['install', 'start'])
    const isig = ops.install.mock.calls[0]![2].signal as AbortSignal
    expect(isig).toBeInstanceOf(AbortSignal)
    expect(isig).not.toBe(ctl.signal)
    expect(ops.start.mock.calls[0]![2].signal).toBe(isig)
    ctl.abort()
    expect(isig.aborted).toBe(false)
  })
  it('预热：随包参考录音、短句、30 分钟上限', async () => {
    await run('启动')
    expect(ops.createClient).toHaveBeenCalledWith('http://127.0.0.1:18123')
    const [input, opt] = synth.mock.calls[0]!
    expect(input).toEqual({
      kind: 'clone', model: MODEL_06, text: '你好。', refAudio: '/assets/voice-ref.wav', refText: BUILTIN_VOICE_TEXT, language: 'chinese',
    })
    expect(opt.timeoutMs).toBe(30 * 60 * 1000)
  })
  it('启动成功记下本实例启动的标记', async () => {
    await run('启动')
    expect(state.started).toEqual({ settings: expect.objectContaining({ modelsDir: DIR }), pid: 9 })
  })
  it('start 返回 alreadyRunning：不记标记，不预热', async () => {
    ops.start.mockResolvedValue({ ok: true, pid: 9, alreadyRunning: true })
    const r = await run('启动')
    expect(r.text).toBe('语音服务已在运行。')
    expect(state.started).toBeNull()
    expect(synth).not.toHaveBeenCalled()
  })
  it.each([
    ['network', '网络'], ['failed', '失败'], ['unsupported', '苹果芯片'],
  ])('install 失败 %s：error 回执，不启动', async (kind, word) => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    ops.install.mockResolvedValue({ ok: false, kind, detail: 'raw http://u:p@x/y' })
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(r.text).toContain(word)
    expect(r.text).not.toContain('raw')
    expect(ops.start).not.toHaveBeenCalled()
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('u:p')
  })
  it('install 被取消：取消回执，不启动', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    ops.install.mockResolvedValue({ ok: false, kind: 'cancelled', detail: '' })
    expect((await run('启动')).text).toContain('已取消')
    expect(ops.start).not.toHaveBeenCalled()
  })
  it.each([
    ['timeout', '超时'], ['exited', '退出'], ['occupied', '占用'], ['failed', '失败'], ['not-installed', '运行环境'],
  ])('start 失败 %s：error 回执，不预热，没有标记', async (kind, word) => {
    ops.start.mockResolvedValue({ ok: false, kind, detail: 'tail' })
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(r.text).toContain(word)
    expect(synth).not.toHaveBeenCalled()
    expect(state.started).toBeNull()
  })
  it('start 被取消', async () => {
    ops.start.mockResolvedValue({ ok: false, kind: 'cancelled', detail: '' })
    expect((await run('启动')).text).toContain('已取消')
    expect(synth).not.toHaveBeenCalled()
  })
  it('预热失败：服务保持启动，回执给归类原因，原文只进日志', async () => {
    ops.inspect.mockResolvedValue(info({ modelDownloaded: false })) // 联网启动，预热失败不补救
    pick(VOICE_OPT_GO)
    synth.mockRejectedValue(new TtsError('bad-response', 'HTTP 500 secret-body http://u:p@h/'))
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(r.text).toBe(`语音服务已启动，但模型加载失败：模型没能加载（可能没下载完整）。详情见 ${DIR}/server.log。`)
    expect(ops.stop).not.toHaveBeenCalled()
    expect(state.started).not.toBeNull()
    const logged = JSON.stringify(log.warn.mock.calls)
    expect(logged).toContain('secret-body')
    expect(logged).not.toContain('u:p')
  })
  it('预热超时归类', async () => {
    synth.mockRejectedValue(new TtsError('timeout'))
    expect((await run('启动')).text).toContain('等待超时')
  })
  it('停止命令中途取消预热：回执为已取消', async () => {
    let release!: () => void
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) => new Promise((_res, rej) => {
      release = () => rej(new TtsError('cancelled'))
      o.signal.addEventListener('abort', release)
    }))
    const p = run('启动')
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    const stopR = await run('停止')
    expect(stopR.text).toBe('语音服务已停止。')
    expect((await p).text).toContain('已取消')
  })
  it('宿主信号中止不打断后台任务：预热照常完成', async () => {
    const ctl = new AbortController()
    let release!: () => void
    synth.mockImplementation(() => new Promise((res) => { release = () => res({ bytes: new Uint8Array(), format: 'wav' }) }))
    const p = run('启动', ctl.signal)
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    ctl.abort()
    release()
    expect((await p).text).toContain('语音服务已启动，模型 0.6b')
  })
  it('启动前后用不带大小统计的 inspect', async () => {
    await run('启动')
    expect(ops.inspect.mock.calls[0]![2]).toEqual({ sizes: false })
  })
  it('模型已在本地：start 带 offline；需要下载：不带', async () => {
    await run('启动')
    expect(ops.start.mock.calls[0]![2].offline).toBe(true)
    ops.inspect.mockResolvedValue(info({ modelDownloaded: false }))
    pick(VOICE_OPT_GO)
    resetLaunchesForTest()
    await run('启动')
    expect(ops.start.mock.calls[1]![2].offline).toBe(false)
  })
})

describe('启动转后台', () => {
  /** 让 install 停在门口，直到 release()。 */
  const gated = () => {
    let release!: (v: { ok: true }) => void
    ops.install.mockImplementation(() => new Promise((res) => { release = res as typeof release }))
    return { release: () => release({ ok: true }) }
  }
  const slow = () => ops.sleep.mockResolvedValue(undefined)
  const needInstall = () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
  }

  it('等待上限是 8 秒', async () => {
    expect(START_WAIT_MS).toBe(8000)
    await run('启动')
    expect(ops.sleep).toHaveBeenCalledWith(8000, expect.any(AbortSignal))
  })
  it('8 秒内没完成：回一行带阶段的回执，后台继续；完成后状态恢复', async () => {
    needInstall()
    slow()
    const g = gated()
    const r = await run('启动')
    expect(r).toEqual({ kind: 'success', text: '语音服务正在启动（安装运行环境），用 /aha 语音 状态 查看进度。' })
    expect(ops.start).not.toHaveBeenCalled()
    g.release()
    await vi.waitFor(() => expect(ops.start).toHaveBeenCalled())
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
  })
  it('转后台时阶段取当时的阶段（启动服务）', async () => {
    slow()
    ops.start.mockReturnValue(new Promise(() => undefined))
    expect((await run('启动')).text).toContain('（启动服务）')
  })
  it('状态：进行中回阶段与已用秒数', async () => {
    needInstall()
    slow()
    gated()
    await run('启动')
    clock.t += 42_000
    expect((await run('状态')).text).toBe('语音服务正在启动：安装运行环境，已用 42 秒。')
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('状态：预热阶段显示下载并加载模型', async () => {
    slow()
    synth.mockReturnValue(new Promise(() => undefined))
    await run('启动')
    expect((await run('状态')).text).toContain('下载并加载模型')
  })
  it('进行中再敲启动：回正在启动中，不起第二个任务', async () => {
    needInstall()
    slow()
    gated()
    await run('启动')
    const r = await run('启动')
    expect(r.text).toBe('语音服务正在启动中，请稍候。')
    expect(ops.install).toHaveBeenCalledTimes(1)
  })
  it('进程起来就记标记，哪怕预热还没完成', async () => {
    slow()
    synth.mockReturnValue(new Promise(() => undefined))
    await run('启动')
    expect(state.started?.pid).toBe(9)
    expect(state.launching).not.toBeNull()
  })
  it('失败后：服务不可达时状态给出上次失败原因与日志路径；再次启动清掉', async () => {
    ops.start.mockResolvedValue({ ok: false, kind: 'timeout', detail: 'x' })
    await run('启动')
    expect((await run('状态')).text).toBe(`上次启动失败：等待服务启动超时（日志 ${DIR}/server.log）。`)
    ops.start.mockResolvedValue({ ok: true, pid: 9, alreadyRunning: false })
    await run('启动')
    expect((await run('状态')).text).toBe('语音服务：未启动。')
  })
  it('预热失败后服务可达：状态走正常路径，不报上次失败', async () => {
    synth.mockRejectedValue(new TtsError('timeout'))
    await run('启动')
    ops.inspect.mockResolvedValue(info({ reachable: true, owned: { pid: 9, port: 1, startedAt: 1 } }))
    probeModels.mockResolvedValue([])
    expect((await run('状态')).text).toBe('语音服务：已在运行（由插件启动），模型尚未加载（配置为 0.6b）。')
  })
  it('被停止命令取消的启动不算失败', async () => {
    slow()
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) =>
      new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled')))))
    await run('启动')
    await run('停止')
    await vi.waitFor(() => expect(state.launching).toBeNull())
    expect((await run('状态')).text).toBe('语音服务：未启动。')
  })
  it('后台任务抛异常：被接住并记日志，状态给出失败，没有未处理拒绝', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      ops.start.mockRejectedValue(new Error('boom'))
      const r = await run('启动')
      expect(r.kind).toBe('error')
      expect(r.text).toContain('详情见日志')
      expect(log.error).toHaveBeenCalled()
      expect((await run('状态')).text).toContain('上次启动失败')
      await new Promise((res) => setImmediate(res))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
  it('任务先结束时清掉 8 秒等待的定时器（信号被中止）', async () => {
    await run('启动')
    expect((ops.sleep.mock.calls[0]![1] as AbortSignal).aborted).toBe(true)
  })
  it('两个实例同时启动（inspect 挂起）：只起一个后台任务，第二个回正在启动中', async () => {
    ops.sleep.mockResolvedValue(undefined)
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) =>
      new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled')))))
    const gates: Array<() => void> = []
    ops.inspect.mockImplementation(() => new Promise((res) => gates.push(() => res(info()))))
    const stateB: VoiceInstanceState = { started: null, launching: null }
    const a = createVoiceHandler(state, ops as unknown as VoiceOps)(mkInv('启动')) as Promise<{ text: string }>
    const b = createVoiceHandler(stateB, ops as unknown as VoiceOps)(mkInv('启动')) as Promise<{ text: string }>
    await vi.waitFor(() => expect(gates.length).toBe(2))
    gates[0]!()
    expect((await a).text).toContain('正在启动')
    gates[1]!()
    expect((await b).text).toBe('语音服务正在启动中，请稍候。')
    expect(ops.start).toHaveBeenCalledTimes(1)
    expect(state.launching).not.toBeNull()
    expect(stateB.launching).toBeNull()
    // Map 里仍是第一个任务：停止能打断它的预热
    ops.inspect.mockResolvedValue(info())
    await run('停止')
    await vi.waitFor(() => expect(state.launching).toBeNull())
  })
  it('日志本身抛错也不会让后台任务的结果拒绝', async () => {
    ops.start.mockRejectedValue(new Error('boom'))
    log.error.mockImplementationOnce(() => { throw new Error('log broken') })
    const r = await run('启动')
    expect(r.kind).toBe('error')
  })
  it('abortLaunch 没有进行中的启动时无事发生', () => {
    expect(() => abortLaunch('/nowhere')).not.toThrow()
  })
})

describe('联网启动成功后清理残留的 .incomplete', () => {
  const needDownload = () => {
    ops.inspect.mockResolvedValue(info({ modelDownloaded: false }))
    pick(VOICE_OPT_GO)
  }
  it('联网启动且预热成功：清当前模型目录', async () => {
    needDownload()
    const r = await run('启动')
    expect(r.kind).toBe('success')
    expect(ops.clearIncomplete).toHaveBeenCalledWith(DIR, MODEL_06)
    expect(ops.clearIncomplete).toHaveBeenCalledTimes(1)
  })
  it('清理抛错：只记日志，启动仍成功', async () => {
    needDownload()
    ops.clearIncomplete.mockRejectedValue(new Error('EACCES'))
    const r = await run('启动')
    expect(r.kind).toBe('success')
    expect(log.warn).toHaveBeenCalled()
  })
  it('预热失败：不清理', async () => {
    needDownload()
    synth.mockRejectedValue(new TtsError('timeout', 'x'))
    await run('启动')
    expect(ops.clearIncomplete).not.toHaveBeenCalled()
  })
  it('离线启动成功：不清理', async () => {
    await run('启动')
    expect(ops.clearIncomplete).not.toHaveBeenCalled()
  })
  it('离线失败后联网重启并预热成功：清理', async () => {
    synth.mockRejectedValueOnce(new TtsError('bad-response', 'IncompleteSnapshotError'))
    await run('启动')
    expect(ops.clearIncomplete).toHaveBeenCalledWith(DIR, MODEL_06)
  })
})

describe('离线加载失败后联网重试一次', () => {
  const badLoad = () => new TtsError('bad-response', 'IncompleteSnapshotError')

  it('离线预热失败 → 停掉 → 联网重启 → 再预热成功', async () => {
    synth.mockRejectedValueOnce(badLoad())
    const order: string[] = []
    ops.start.mockImplementation(async (_s: unknown, _d: unknown, o: { offline: boolean }) => {
      order.push(`start:${o.offline}`)
      return { ok: true, pid: order.length === 1 ? 9 : 10, alreadyRunning: false }
    })
    ops.stop.mockImplementation(async () => (order.push('stop'), { status: 'stopped', forced: false }))
    const r = await run('启动')
    expect(r.text).toBe(`语音服务已启动，模型 0.6b，权重目录 ${DIR}。`)
    expect(order).toEqual(['start:true', 'stop', 'start:false'])
    expect(synth).toHaveBeenCalledTimes(2)
    expect(state.started?.pid).toBe(10)
  })
  it('联网后仍失败：记为失败，只重试一次', async () => {
    synth.mockRejectedValue(badLoad())
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('模型没能加载')
    expect(ops.start).toHaveBeenCalledTimes(2)
    expect(ops.stop).toHaveBeenCalledTimes(1)
    expect(synth).toHaveBeenCalledTimes(2)
    expect((await run('状态')).text).toContain('上次启动失败')
  })
  it('联网重启本身失败：按启动失败记', async () => {
    synth.mockRejectedValue(badLoad())
    ops.start
      .mockResolvedValueOnce({ ok: true, pid: 9, alreadyRunning: false })
      .mockResolvedValueOnce({ ok: false, kind: 'timeout', detail: '' })
    const r = await run('启动')
    expect(r.text).toContain('超时')
  })
  it('阶段始终显示下载并加载模型', async () => {
    ops.sleep.mockResolvedValue(undefined)
    synth.mockRejectedValueOnce(badLoad())
    let release!: () => void
    ops.start.mockResolvedValueOnce({ ok: true, pid: 9, alreadyRunning: false })
    ops.start.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ok: true, pid: 10, alreadyRunning: false }) }))
    await run('启动')
    await vi.waitFor(() => expect(ops.start).toHaveBeenCalledTimes(2))
    expect((await run('状态')).text).toContain('下载并加载模型')
    release()
  })
  it('被停止命令取消：不补救', async () => {
    ops.sleep.mockResolvedValue(undefined)
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) =>
      new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled')))))
    await run('启动')
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    await run('停止')
    await vi.waitFor(() => expect(state.launching).toBeNull())
    expect(ops.start).toHaveBeenCalledTimes(1)
    expect(synth).toHaveBeenCalledTimes(1)
  })
  it.each([['timeout'], ['unreachable'], ['other']] as const)('预热失败种类是 %s：不补救，直接按原失败返回', async (kind) => {
    synth.mockRejectedValue(new TtsError(kind, 'x'))
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(ops.start).toHaveBeenCalledTimes(1)
    expect(ops.stop).not.toHaveBeenCalled()
    expect(synth).toHaveBeenCalledTimes(1)
  })
  it('本来就是联网启动（需要下载）：预热失败不补救', async () => {
    ops.inspect.mockResolvedValue(info({ modelDownloaded: false }))
    pick(VOICE_OPT_GO)
    synth.mockRejectedValue(badLoad())
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(ops.start).toHaveBeenCalledTimes(1)
    expect(ops.stop).not.toHaveBeenCalled()
  })
})

describe('停止', () => {
  it.each([
    ['stopped', '语音服务已停止。'],
    ['not-ours', '这是外部启动的服务，插件不会停它。'],
    ['not-running', '语音服务没有在运行。'],
  ])('%s', async (status, text) => {
    ops.stop.mockResolvedValue({ status, forced: false })
    expect((await run('stop')).text).toBe(text)
  })
  it('先取消预热再 stop', async () => {
    const order: string[] = []
    let sig!: AbortSignal
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) => {
      sig = o.signal
      return new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled'))))
    })
    ops.stop.mockImplementation(async () => (order.push(sig.aborted ? 'aborted-first' : 'not-aborted'), { status: 'stopped', forced: false }))
    const p = run('启动')
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    await run('停止')
    await p
    expect(order).toEqual(['aborted-first'])
  })
  it('停止成功后清掉本实例标记', async () => {
    await run('启动')
    expect(state.started).not.toBeNull()
    await run('停止')
    expect(state.started).toBeNull()
  })
  it('没配置', async () => {
    cfg = { configured: false, problems: [] }
    expect((await run('停止')).text).toContain('docs/voice-setup.md')
    expect(ops.stop).not.toHaveBeenCalled()
  })
})

describe('卸载收尾', () => {
  const setup = (cleanupLimitMs?: number) => {
    let cleanup!: () => Promise<void>
    const ctx: any = { effect: (fn: () => () => Promise<void>) => { cleanup = fn() } }
    const rt: any = { log, handlers: {}, voiceServerDeps: () => serverDeps }
    installVoice(rt, ctx, { ops: ops as unknown as VoiceOps, cleanupLimitMs })
    return { rt, cleanup: () => cleanup() }
  }
  const owned = (pid: number) => info({ owned: { pid, port: 18123, startedAt: 1 } })
  // inspect 默认返回 owned 为 9：启动前的判断不看 owned，收尾时核对进程号用
  beforeEach(() => ops.inspect.mockResolvedValue(owned(9)))

  it('登记了 voice 处理函数', () => {
    expect(typeof setup().rt.handlers.voice).toBe('function')
  })
  it('没启动过服务：什么都不停', async () => {
    const { cleanup } = setup()
    await cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('本实例启动过且进程号一致：卸载时停掉，且只停一次，不统计大小', async () => {
    const { rt, cleanup } = setup()
    await rt.handlers.voice(mkInv('启动'))
    expect(ops.stop).not.toHaveBeenCalled()
    await cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1)
    expect(ops.stop.mock.calls[0]![0].modelsDir).toBe(DIR)
    expect(ops.inspect.mock.calls.at(-1)![2]).toEqual({ sizes: false })
    await cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1)
  })
  it('服务不是本实例启动的（alreadyRunning）：卸载不停', async () => {
    const { rt, cleanup } = setup()
    ops.start.mockResolvedValue({ ok: true, pid: 9, alreadyRunning: true })
    await rt.handlers.voice(mkInv('启动'))
    await cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('两个实例各管各的', async () => {
    const a = setup()
    const b = setup()
    await a.rt.handlers.voice(mkInv('启动'))
    await b.cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
    await a.cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1)
  })
  it('交错：A 启动、B 停止、B 再启动、A 卸载，A 不会停 B 启动的服务', async () => {
    const a = setup()
    const b = setup()
    await a.rt.handlers.voice(mkInv('启动')) // pid 9
    await b.rt.handlers.voice(mkInv('停止'))
    resetLaunchesForTest()
    ops.start.mockResolvedValue({ ok: true, pid: 10, alreadyRunning: false })
    await b.rt.handlers.voice(mkInv('启动'))
    ops.inspect.mockResolvedValue(owned(10))
    await a.cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1) // 只有 B 自己的"停止"那一次
    await b.cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(2)
  })
  it('进程号对不上：只清标记不停；再收尾也不停', async () => {
    const { rt, cleanup } = setup()
    await rt.handlers.voice(mkInv('启动'))
    ops.inspect.mockResolvedValue(owned(77))
    await cleanup()
    ops.inspect.mockResolvedValue(owned(9))
    await cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('服务已经不在了（owned 为空）：不停', async () => {
    const { rt, cleanup } = setup()
    await rt.handlers.voice(mkInv('启动'))
    ops.inspect.mockResolvedValue(info())
    await cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('本实例已停止过：卸载不再停', async () => {
    const { rt, cleanup } = setup()
    await rt.handlers.voice(mkInv('启动'))
    await rt.handlers.voice(mkInv('停止'))
    ops.stop.mockClear()
    await cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('停止卡住时按时间上限放行', async () => {
    const { rt, cleanup } = setup(30)
    await rt.handlers.voice(mkInv('启动'))
    ops.stop.mockReturnValue(new Promise(() => undefined))
    const t = Date.now()
    await cleanup()
    expect(Date.now() - t).toBeLessThan(1000)
    expect(log.warn).toHaveBeenCalled()
  })
  it('停止抛错：吞掉并记日志', async () => {
    const { rt, cleanup } = setup()
    await rt.handlers.voice(mkInv('启动'))
    ops.stop.mockRejectedValue(new Error('boom'))
    await expect(cleanup()).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
  })
  it('卸载时打断进行中的预热，并停掉已起的服务', async () => {
    const { rt, cleanup } = setup()
    ops.sleep.mockResolvedValue(undefined)
    let sig!: AbortSignal
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) => {
      sig = o.signal
      return new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled'))))
    })
    await rt.handlers.voice(mkInv('启动'))
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    await cleanup()
    expect(sig.aborted).toBe(true)
    expect(ops.stop).toHaveBeenCalledTimes(1)
  })
  it('卸载时打断进行中的安装：不再启动，也没有可停的服务', async () => {
    const { rt, cleanup } = setup()
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    ops.sleep.mockResolvedValue(undefined)
    ops.install.mockImplementation((_s: unknown, _d: unknown, o: { signal: AbortSignal }) =>
      new Promise((res) => o.signal.addEventListener('abort', () => res({ ok: false, kind: 'cancelled', detail: '' }))))
    await rt.handlers.voice(mkInv('启动'))
    await cleanup()
    expect(ops.start).not.toHaveBeenCalled()
    expect(ops.stop).not.toHaveBeenCalled()
  })
})

describe('builtinVoice', () => {
  it('给出录音路径与对应文字', () => {
    expect(builtinVoice({ builtinAssetsDir: '/x/assets' })).toEqual({ file: '/x/assets/voice-ref.wav', text: BUILTIN_VOICE_TEXT })
    expect(BUILTIN_VOICE_TEXT).toBe('你好，欢迎来到这间酒馆。先坐下歇一会儿吧，想聊点什么都可以。')
  })
})

describe('whichOnPath', () => {
  it('跳过没有执行权限的文件与同名目录，返回可执行文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-which-'))
    try {
      const noExec = path.join(root, 'a'); fs.mkdirSync(noExec)
      const d1 = path.join(root, 'd1'); fs.mkdirSync(d1)
      fs.writeFileSync(path.join(d1, 'uv'), '#!/bin/sh\n', { mode: 0o644 })
      const d2 = path.join(root, 'd2'); fs.mkdirSync(path.join(d2, 'uv'), { recursive: true })
      const d3 = path.join(root, 'd3'); fs.mkdirSync(d3)
      fs.writeFileSync(path.join(d3, 'uv'), '#!/bin/sh\n', { mode: 0o755 })
      const sep = path.delimiter
      expect(whichOnPath('uv', [d1].join(sep))).toBeNull()
      expect(whichOnPath('uv', [d2].join(sep))).toBeNull()
      expect(whichOnPath('uv', [root, d1, d2, d3].join(sep))).toBe(path.join(d3, 'uv'))
      expect(whichOnPath('nope', d3)).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('launchSnapshot', () => {
  it('没启动过：null', () => {
    expect(launchSnapshot(DIR)).toBeNull()
  })
  it('进行中：阶段与开始时间，未结束', async () => {
    ops.sleep.mockResolvedValue(undefined)
    ops.start.mockReturnValue(new Promise(() => undefined))
    await run('启动')
    expect(launchSnapshot(DIR)).toEqual({ stage: 'start', startedAt: 1_000_000, finished: false })
  })
  it('失败后：已结束，带失败原因', async () => {
    ops.start.mockResolvedValue({ ok: false, kind: 'timeout', detail: 'x' })
    await run('启动')
    expect(launchSnapshot(DIR)).toMatchObject({ finished: true, failure: '等待服务启动超时' })
  })
  it('成功后：已结束，没有失败原因', async () => {
    await run('启动')
    const snap = launchSnapshot(DIR)
    expect(snap?.finished).toBe(true)
    expect(snap?.failure).toBeUndefined()
  })
})

describe('startServiceHeld：调用方已持有同会话卡片队列', () => {
  const needInstall = () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
  }
  const heldRun = (inv: Invocation) => startServiceHeld(inv)

  it('走同一段启动流程：确认卡片通过后安装并启动', async () => {
    needInstall()
    const inv = mkInv('')
    inv.rt.handlers.voice = createVoiceHandler(state, ops as unknown as VoiceOps)
    const r = await heldRun(inv)
    expect(askFn).toHaveBeenCalledTimes(1)
    expect(ops.install).toHaveBeenCalled()
    expect(r.text).toContain('语音服务已启动')
  })
  it('队列已被调用方占着也不死锁，确认卡片直接发出', async () => {
    needInstall()
    const inv = mkInv('')
    inv.rt.handlers.voice = createVoiceHandler(state, ops as unknown as VoiceOps)
    const out = await gate.run('s1', () => heldRun(inv), 'command')
    expect(askFn).toHaveBeenCalledTimes(1)
    expect(out.text).toContain('语音服务已启动')
  })
  it('对照：同样占着队列时，普通的 /aha 语音 启动 回"先处理卡片"', async () => {
    needInstall()
    const out = await gate.run('s1', () => run('启动'), 'command')
    expect(out.text).toContain('先处理它')
    expect(askFn).not.toHaveBeenCalled()
  })
  it('没有登记 voice 处理函数：回执说明，不抛错', async () => {
    const r = await heldRun(mkInv(''))
    expect(r.kind).toBe('error')
  })
})

describe('记录最近一次启动的离线方式', () => {
  it('没启动过为 undefined；启动后记下 offline；联网重试后记 false', async () => {
    expect(lastStartOffline(DIR)).toBeUndefined()
    await run('启动')
    expect(lastStartOffline(DIR)).toBe(true)
  })
  it('离线预热失败改联网重启后记 false', async () => {
    synth.mockRejectedValueOnce(new TtsError('bad-response', 'IncompleteSnapshotError'))
    await run('启动')
    expect(lastStartOffline(DIR)).toBe(false)
  })
  it('停止后清掉记录', async () => {
    await run('启动')
    await run('停止')
    expect(lastStartOffline(DIR)).toBeUndefined()
  })
})

describe('restartVoiceService：由插件重启服务', () => {
  const setup = () => {
    const ctx: any = { effect: () => undefined }
    const rt: any = { log, handlers: {}, voiceServerDeps: () => serverDeps }
    installVoice(rt, ctx, { ops: ops as unknown as VoiceOps })
    return rt
  }
  it('先停后启，离线与否按所配模型是否已下载；更新本实例标记与离线记录', async () => {
    const rt = setup()
    ops.modelDownloaded.mockResolvedValue(true)
    const order: string[] = []
    ops.stop.mockImplementation(async () => (order.push('stop'), { status: 'stopped', forced: false }))
    ops.start.mockImplementation(async (_s: unknown, _d: unknown, o: { offline: boolean }) => (order.push(`start:${o.offline}`), { ok: true, pid: 77, alreadyRunning: false }))
    expect(await restartVoiceService(rt, settings(), { ops: ops as unknown as VoiceOps })).toBe(true)
    expect(order).toEqual(['stop', 'start:true'])
    expect(ops.modelDownloaded).toHaveBeenCalledWith(DIR, MODEL_06)
    expect(lastStartOffline(DIR)).toBe(true)
  })
  it('明确指定 offline: false 时不看模型是否已下载', async () => {
    const rt = setup()
    expect(await restartVoiceService(rt, settings(), { offline: false, ops: ops as unknown as VoiceOps })).toBe(true)
    expect(ops.modelDownloaded).not.toHaveBeenCalled()
    expect(ops.start.mock.calls[0]![2]).toMatchObject({ offline: false })
    expect(lastStartOffline(DIR)).toBe(false)
  })
  it('启动失败：返回 false，不留"本实例启动的"标记', async () => {
    const rt = setup()
    ops.start.mockResolvedValue({ ok: false, kind: 'timeout', detail: 'x' })
    expect(await restartVoiceService(rt, settings(), { offline: true, ops: ops as unknown as VoiceOps })).toBe(false)
    expect(lastStartOffline(DIR)).toBeUndefined()
  })
  it('把信号传给 start；停止之后信号已中止则不再启动', async () => {
    const rt = setup()
    const ac = new AbortController()
    await restartVoiceService(rt, settings(), { offline: true, signal: ac.signal, ops: ops as unknown as VoiceOps })
    expect(ops.start.mock.calls[0]![2]).toMatchObject({ signal: ac.signal })
    ops.start.mockClear()
    ops.stop.mockImplementation(async () => { ac.abort(); return { status: 'stopped', forced: false } })
    expect(await restartVoiceService(rt, settings(), { offline: true, signal: ac.signal, ops: ops as unknown as VoiceOps })).toBe(false)
    expect(ops.start).not.toHaveBeenCalled()
  })
  it('信号一开始就已中止：连停都不停', async () => {
    const rt = setup()
    const ac = new AbortController()
    ac.abort()
    expect(await restartVoiceService(rt, settings(), { offline: true, signal: ac.signal, ops: ops as unknown as VoiceOps })).toBe(false)
    expect(ops.stop).not.toHaveBeenCalled()
    expect(ops.start).not.toHaveBeenCalled()
  })
  it('别人的启动进行中：不去停服务，返回 false', async () => {
    ops.sleep.mockResolvedValue(undefined)
    let release!: () => void
    ops.start.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ok: true, pid: 9, alreadyRunning: false }) }))
    const rt = setup()
    await rt.handlers.voice(mkInv('启动'))
    expect(isLaunching(DIR)).toBe(true)
    ops.stop.mockClear()
    expect(await restartVoiceService(rt, settings(), { offline: false, ops: ops as unknown as VoiceOps })).toBe(false)
    expect(ops.stop).not.toHaveBeenCalled()
    release()
  })
  it('重启期间登记为启动中（朗读、启动命令、状态都看得到），结束后清掉', async () => {
    const rt = setup()
    let release!: () => void
    ops.stop.mockImplementationOnce(() => new Promise((res) => { release = () => res({ status: 'stopped', forced: false }) }))
    const p = restartVoiceService(rt, settings(), { offline: false, ops: ops as unknown as VoiceOps })
    expect(isLaunching(DIR)).toBe(true)
    expect(launchSnapshot(DIR)).toMatchObject({ finished: false })
    expect((await run('启动')).text).toBe('语音服务正在启动中，请稍候。')
    release()
    expect(await p).toBe(true)
    expect(isLaunching(DIR)).toBe(false)
  })
  it('重启失败也会清掉登记', async () => {
    const rt = setup()
    ops.start.mockResolvedValue({ ok: false, kind: 'timeout', detail: '' })
    expect(await restartVoiceService(rt, settings(), { offline: false, ops: ops as unknown as VoiceOps })).toBe(false)
    expect(isLaunching(DIR)).toBe(false)
  })
  it('重启期间被停止命令打断：start 收到的信号被中止', async () => {
    const rt = setup()
    let sig!: AbortSignal
    ops.start.mockImplementationOnce((_s: unknown, _d: unknown, o: { signal: AbortSignal }) => {
      sig = o.signal
      return new Promise((res) => o.signal.addEventListener('abort', () => res({ ok: false, kind: 'cancelled', detail: '' })))
    })
    const p = restartVoiceService(rt, settings(), { offline: false, ops: ops as unknown as VoiceOps })
    await vi.waitFor(() => expect(ops.start).toHaveBeenCalled())
    abortLaunch(DIR)
    expect(sig.aborted).toBe(true)
    expect(await p).toBe(false)
  })
  it('重启后卸载时会停掉这个新进程', async () => {
    let cleanup!: () => Promise<void>
    const ctx: any = { effect: (fn: () => () => Promise<void>) => { cleanup = fn() } }
    const rt: any = { log, handlers: {}, voiceServerDeps: () => serverDeps }
    installVoice(rt, ctx, { ops: ops as unknown as VoiceOps })
    ops.start.mockResolvedValue({ ok: true, pid: 77, alreadyRunning: false })
    ops.inspect.mockResolvedValue(info({ owned: { pid: 77, port: 18123, startedAt: 1 } }))
    await restartVoiceService(rt, settings(), { offline: true, ops: ops as unknown as VoiceOps })
    ops.stop.mockClear()
    await cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1)
  })
})
