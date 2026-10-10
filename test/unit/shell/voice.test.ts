import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceServiceResult, VoiceServiceSettings } from '../../../src/core/services'
import { TtsError } from '../../../src/core/tts'
import type { VoiceServerInfo } from '../../../src/core/voice-server'
import { SessionGate } from '../../../src/shell/confirm'
import type { Invocation } from '../../../src/shell/context'
import { handleCommand, parseSubcommand } from '../../../src/shell/commands'
import { VOICE_OPT_CANCEL, VOICE_OPT_GO } from '../../../src/shell/receipts'
import {
  BUILTIN_VOICE_TEXT, abortWarmup, builtinVoice, createVoiceHandler, installVoice, parseVoiceArgs,
  type VoiceInstanceState, type VoiceOps,
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
const pick = (label: string) =>
  askFn!.mockImplementation(async (req: any) => ({ answers: [{ id: req.questions[0].id, selected: [label] }] }))

beforeEach(() => {
  cfg = { configured: true, settings: settings(), problems: [] }
  synth = vi.fn().mockResolvedValue({ bytes: new Uint8Array(), format: 'wav' })
  ops = {
    inspect: vi.fn().mockResolvedValue(info()),
    install: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue({ ok: true, pid: 9, alreadyRunning: false }),
    stop: vi.fn().mockResolvedValue({ status: 'stopped', forced: false }),
    modelDownloaded: vi.fn(),
    createClient: vi.fn(() => ({ synthesize: synth })),
  }
  askFn = vi.fn()
  gate = new SessionGate()
  state = { started: null }
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
  })
  it('连得上，外部启动的', async () => {
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    expect((await run('')).text).toContain('外部启动')
  })
  it('正在启动中', async () => {
    ops.inspect.mockResolvedValue(info({ busy: true }))
    expect((await run('')).text).toBe('语音服务：正在启动中。')
  })
  it('没配 modelAlias 时写完整模型名', async () => {
    cfg = { configured: true, settings: settings({ modelAlias: undefined, model: 'org/x' }), problems: [] }
    ops.inspect.mockResolvedValue(info({ reachable: true }))
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
  it('先 install 再 start，信号一并传下去', async () => {
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    pick(VOICE_OPT_GO)
    const ctl = new AbortController()
    const order: string[] = []
    ops.install.mockImplementation(async () => (order.push('install'), { ok: true }))
    ops.start.mockImplementation(async () => (order.push('start'), { ok: true, pid: 9, alreadyRunning: false }))
    await run('启动', ctl.signal)
    expect(order).toEqual(['install', 'start'])
    expect(ops.install.mock.calls[0]![2].signal).toBe(ctl.signal)
    expect(ops.start.mock.calls[0]![2].signal).toBe(ctl.signal)
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
    expect(state.started?.modelsDir).toBe(DIR)
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
    synth.mockRejectedValue(new TtsError('bad-response', 'HTTP 500 secret-body http://u:p@h/'))
    const r = await run('启动')
    expect(r.kind).toBe('error')
    expect(r.text).toBe('语音服务已启动，但模型加载失败：服务返回了无法使用的结果。详情见语音目录下的 server.log。')
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
  it('宿主信号中止预热：回执为已取消', async () => {
    const ctl = new AbortController()
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) => new Promise((_res, rej) => {
      o.signal.addEventListener('abort', () => rej(new TtsError('cancelled')))
    }))
    const p = run('启动', ctl.signal)
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    ctl.abort()
    expect((await p).text).toContain('已取消')
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

  it('登记了 voice 处理函数', () => {
    expect(typeof setup().rt.handlers.voice).toBe('function')
  })
  it('没启动过服务：什么都不停', async () => {
    const { cleanup } = setup()
    await cleanup()
    expect(ops.stop).not.toHaveBeenCalled()
  })
  it('本实例启动过：卸载时停掉，且只停一次', async () => {
    const { rt, cleanup } = setup()
    rt.voiceSettings = async () => cfg
    const inv = { ...mkInv('启动'), rt: { ...mkInv('').rt, handlers: rt.handlers } } as Invocation
    await rt.handlers.voice(inv)
    expect(ops.stop).not.toHaveBeenCalled()
    await cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1)
    expect(ops.stop.mock.calls[0]![0].modelsDir).toBe(DIR)
    await cleanup()
    expect(ops.stop).toHaveBeenCalledTimes(1)
  })
  it('服务不是本实例启动的（alreadyRunning）：卸载不停', async () => {
    const { rt, cleanup } = setup()
    ops.start.mockResolvedValue({ ok: true, pid: 9, alreadyRunning: true })
    await rt.handlers.voice({ ...mkInv('启动'), rt: { ...mkInv('').rt, handlers: rt.handlers } })
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
  it('卸载时先取消进行中的预热', async () => {
    const { rt, cleanup } = setup()
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) =>
      new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled')))))
    const p = rt.handlers.voice(mkInv('启动'))
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    await cleanup()
    expect((await p).text).toContain('已取消')
  })
})

describe('builtinVoice', () => {
  it('给出录音路径与对应文字', () => {
    expect(builtinVoice({ builtinAssetsDir: '/x/assets' })).toEqual({ file: '/x/assets/voice-ref.wav', text: BUILTIN_VOICE_TEXT })
    expect(BUILTIN_VOICE_TEXT).toBe('你好，欢迎来到这间酒馆。先坐下歇一会儿吧，想聊点什么都可以。')
  })
  it('abortWarmup 没有进行中的预热时无事发生', () => {
    expect(() => abortWarmup('/nowhere')).not.toThrow()
  })
})
