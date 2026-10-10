import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadImageService, loadVoiceService, VOICE_MODELS } from '../../../src/core/services'
import { TtsError } from '../../../src/core/tts'
import type { VoiceServerInfo } from '../../../src/core/voice-server'
import type { Invocation } from '../../../src/shell/context'
import type { DrawDoctorReport } from '../../../src/shell/draw-doctor'
import { voiceCardMarkdown, voiceStopReceipt } from '../../../src/shell/receipts'
import { createSettingsApi, type SettingsApi } from '../../../src/shell/settings'
import {
  createVoiceController, isLaunching, resetLaunchesForTest, type VoiceInstanceState, type VoiceOps,
} from '../../../src/shell/voice'
import { fakeRuntime } from './helpers/runtime'

const MODEL_06 = VOICE_MODELS['0.6b']
let dir: string
let file: string
let wfDir: string
let state: VoiceInstanceState
let ops: { [K in keyof VoiceOps]: ReturnType<typeof vi.fn> }
let probeModels: ReturnType<typeof vi.fn>
let probeVoice: ReturnType<typeof vi.fn>
let checkImage: ReturnType<typeof vi.fn>
let api: SettingsApi
let rt: ReturnType<typeof fakeRuntime>

const info = (over: Partial<VoiceServerInfo> = {}): VoiceServerInfo => ({
  supported: true, uv: '/usr/bin/uv', envInstalled: true, modelDownloaded: true, sizes: { env: 0, hf: 0 },
  owned: null, reachable: false, busy: false, ...over,
})

const VOICE_YAML = (extra = '') => `voice:\n  endpoint: http://127.0.0.1:18123\n  launch: mlx\n  modelsDir: /data/voice\n${extra}`

async function setup(content: string | null): Promise<void> {
  if (content !== null) await fs.writeFile(file, content, 'utf8')
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-settings-'))
  file = path.join(dir, 'services.yaml')
  wfDir = path.join(dir, 'workflows')
  await fs.mkdir(wfDir)
  await fs.writeFile(path.join(wfDir, 'qwen-image-2.1.json'), '{}')
  await fs.writeFile(path.join(wfDir, 'qwen-image-2.1-gguf.json'), '{}')
  await fs.writeFile(path.join(wfDir, 'README.txt'), 'x')
  resetLaunchesForTest()
  state = { started: null, launching: null }
  probeModels = vi.fn().mockResolvedValue([MODEL_06])
  ops = {
    inspect: vi.fn().mockResolvedValue(info()),
    install: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue({ ok: true, pid: 9, alreadyRunning: false }),
    stop: vi.fn().mockResolvedValue({ status: 'stopped', forced: false }),
    modelDownloaded: vi.fn(),
    clearIncomplete: vi.fn().mockResolvedValue(0),
    createClient: vi.fn(() => ({ synthesize: vi.fn().mockResolvedValue({ bytes: new Uint8Array(), format: 'wav' }), probe: probeModels })),
    now: vi.fn(() => 1_000_000),
    sleep: vi.fn(() => new Promise<void>(() => undefined)),
  }
  const controller = createVoiceController(state, ops as unknown as VoiceOps)
  rt = fakeRuntime({
    servicesPath: () => file, builtinWorkflowDir: wfDir, builtinAssetsDir: '/assets',
    voiceSettings: () => loadVoiceService(file, { defaultModelsDir: '/default/voice' }),
    voiceServerDeps: () => ({ tag: 'deps' }) as any,
    voice: controller,
  })
  probeVoice = vi.fn().mockResolvedValue([MODEL_06])
  checkImage = vi.fn()
  api = createSettingsApi(rt, { probeVoice, checkImage, defaultModelsDir: () => '/default/voice' })
})
afterEach(async () => {
  resetLaunchesForTest()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('getState', () => {
  it('没有配置文件：表单为空，给出默认值与内置工作流名，语音状态为未配置', async () => {
    const s = await api.getState()
    expect(s.servicesPath).toBe(file)
    expect(s.voice.form.endpoint).toBe('')
    expect(s.image.form.endpoint).toBe('')
    expect(s.workflows).toEqual(['qwen-image-2.1', 'qwen-image-2.1-gguf'])
    expect(s.defaults.voice.modelsDir).toBe('/default/voice')
    expect(s.defaults.voice.model).toBe('0.6b')
    expect(s.defaults.image.workflow).toBe('qwen-image-2.1')
    expect(s.voiceStatus.state).toBe('not-configured')
    expect(s.problems.file).toEqual([])
  })

  it('读出已有取值与配置问题，不回显页面不认识的字段', async () => {
    await setup(VOICE_YAML('  read: weird\n  secretNote: top-secret\nimage:\n  endpoint: http://h:8188\n'))
    const s = await api.getState()
    expect(s.voice.form.launch).toBe('mlx')
    expect(s.voice.form.read).toBe('weird')
    expect(s.problems.voice.join('')).toContain('voice.read')
    expect(JSON.stringify(s)).not.toContain('top-secret')
    expect(s.image.form.endpoint).toBe('http://h:8188')
  })

  it('配置文件写坏了：说明问题，不带文件内容', async () => {
    await setup('voice: [oops\n  password: hunter2\n')
    const s = await api.getState()
    expect(s.problems.file.join('')).toContain('解析失败')
    expect(JSON.stringify(s)).not.toContain('hunter2')
  })

  it('读状态不启动、不安装', async () => {
    await setup(VOICE_YAML())
    await api.getState()
    expect(ops.install).not.toHaveBeenCalled()
    expect(ops.start).not.toHaveBeenCalled()
  })
})

describe('saveVoice / saveImage', () => {
  it('保存后能被读取逻辑读回，注释与未知字段保留', async () => {
    await setup('# 我的说明\nvoice:\n  endpoint: http://127.0.0.1:18123 # 本机\n  unknownField: 42\nimage:\n  endpoint: http://h:1\n')
    const r = await api.saveVoice({ endpoint: 'http://127.0.0.1:18123', launch: 'mlx', timeoutSeconds: '90' })
    expect(r.ok).toBe(true)
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('# 我的说明')
    expect(text).toContain('# 本机')
    expect(text).toContain('unknownField: 42')
    expect(text).toContain('endpoint: http://h:1')
    const v = await loadVoiceService(file, { defaultModelsDir: '/d' })
    expect(v.configured && v.settings.launch).toBe('mlx')
    expect(v.configured && v.settings.timeoutSeconds).toBe(90)
  })

  it('校验不过：按字段返回错误，文件一个字不动', async () => {
    await setup(VOICE_YAML())
    const before = await fs.readFile(file, 'utf8')
    const r = await api.saveVoice({ endpoint: 'http://u:pw@127.0.0.1:1', launch: 'docker', modelsDir: 'rel' })
    expect(r.ok).toBe(false)
    expect(Object.keys(r.errors ?? {}).sort()).toEqual(['endpoint', 'launch', 'modelsDir'])
    expect(JSON.stringify(r)).not.toContain('pw')
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('入参不是对象', async () => {
    expect((await api.saveVoice(null)).ok).toBe(false)
    expect((await api.saveImage('x')).ok).toBe(false)
    await expect(fs.access(file)).rejects.toBeTruthy()
  })

  it('文件有语法错误：拒绝，原文件不动，返回固定说明', async () => {
    const broken = 'image: [unclosed\n'
    await setup(broken)
    const r = await api.saveVoice({ endpoint: 'http://127.0.0.1:1' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('解析失败')
    expect(await fs.readFile(file, 'utf8')).toBe(broken)
  })

  it('保存的是新写的值，不被默认值污染：只写表单给出的字段', async () => {
    await api.saveVoice({ endpoint: 'http://127.0.0.1:18123' })
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('voice:\n  endpoint: http://127.0.0.1:18123')
  })

  it('只提交改动的字段：页面打开期间手改的别的字段不会被覆盖回旧值', async () => {
    await setup(VOICE_YAML('  read: lines\n'))
    await api.saveVoice({ read: 'all' })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('read: all')
    expect(text).toContain('launch: mlx')
    expect(text).toContain('modelsDir: /data/voice')
  })

  it('只提交改动的字段：文件里本来没有地址时仍要求填地址', async () => {
    const r = await api.saveVoice({ read: 'all' })
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveProperty('endpoint')
    await expect(fs.access(file)).rejects.toBeTruthy()
  })

  it('只改 endpoint 为非本机地址而文件里 launch 是 mlx：被拦下，按字段报错，文件不动', async () => {
    await setup(VOICE_YAML())
    const before = await fs.readFile(file, 'utf8')
    const r = await api.saveVoice({ endpoint: 'http://192.168.1.2:1' })
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveProperty('endpoint')
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('只改 launch 为 mlx 而文件里地址非本机：被拦下，错误在 launch', async () => {
    await setup('voice:\n  endpoint: http://192.168.1.2:1\n')
    const r = await api.saveVoice({ launch: 'mlx' })
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveProperty('launch')
  })

  it('文件现有值矛盾但没碰这两个字段：可以保存', async () => {
    await setup('voice:\n  endpoint: http://192.168.1.2:1\n  launch: mlx\n')
    expect((await api.saveVoice({ read: 'all' })).ok).toBe(true)
  })

  it('只改别的字段而文件 YAML 损坏：说解析失败，不是地址必填', async () => {
    await setup('voice: [oops\n')
    const r = await api.saveVoice({ read: 'all' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('解析失败')
    expect(r.errors).toBeUndefined()
  })

  it('生图：保存并读回，models 展平', async () => {
    const r = await api.saveImage({ endpoint: 'http://h:8188', workflow: 'qwen-image-2.1-gguf', auto: false, unet: 'a.gguf', width: 640 })
    expect(r.ok).toBe(true)
    const img = await loadImageService(file)
    expect(img.configured && img.settings.workflow).toBe('qwen-image-2.1-gguf')
    expect(img.configured && img.settings.auto).toBe(false)
    expect(img.configured && img.settings.models).toEqual({ unet: 'a.gguf' })
    expect(img.configured && img.settings.width).toBe(640)
  })

  it('生图校验不过', async () => {
    const r = await api.saveImage({ endpoint: 'http://h:1', width: 5 })
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveProperty('width')
  })
})

describe('voiceStatus', () => {
  it('没配置', async () => {
    expect((await api.voiceStatus()).state).toBe('not-configured')
  })

  it('地址带用户名密码：不发请求', async () => {
    await setup('voice:\n  endpoint: http://u:p@127.0.0.1:1\n')
    const s = await api.voiceStatus()
    expect(s.state).toBe('invalid')
    expect(s.text).not.toContain('p@')
    expect(ops.inspect).not.toHaveBeenCalled()
  })

  it('未启动，能代为启动', async () => {
    await setup(VOICE_YAML())
    const s = await api.voiceStatus()
    expect(s.state).toBe('stopped')
    expect(s.text).toBe('语音服务：未启动。')
    expect(s.canStart).toBe(true)
    expect(s.canStop).toBe(false)
  })

  it('launch 为 none：不能代为启动', async () => {
    await setup('voice:\n  endpoint: http://127.0.0.1:18123\n')
    expect((await api.voiceStatus()).canStart).toBe(false)
  })

  it('在运行：插件启动的可以停，外部的不能', async () => {
    await setup(VOICE_YAML())
    ops.inspect.mockResolvedValue(info({ reachable: true, owned: { pid: 1, port: 1, startedAt: 1 } }))
    let s = await api.voiceStatus()
    expect(s.state).toBe('running')
    expect(s.text).toBe('语音服务：已在运行（由插件启动），模型 0.6b。')
    expect(s.canStop).toBe(true)
    ops.inspect.mockResolvedValue(info({ reachable: true }))
    s = await api.voiceStatus()
    expect(s.ours).toBe(false)
    expect(s.canStop).toBe(false)
  })

  it('环境和模型是否已装', async () => {
    await setup(VOICE_YAML())
    ops.inspect.mockResolvedValue(info({ envInstalled: false, modelDownloaded: false }))
    const s = await api.voiceStatus()
    expect(s.env).toMatchObject({ envInstalled: false, modelDownloaded: false, supported: true, uv: true })
    expect(s.modelsDir).toBe('/data/voice')
  })
})

describe('voiceStart：与 /aha 语音 启动 同一段逻辑', () => {
  it('没配置', async () => {
    const r = await api.voiceStart({})
    expect(r.result).toBe('done')
    expect(r.ok).toBe(false)
    expect(ops.start).not.toHaveBeenCalled()
  })

  it('已装好：直接启动，不要确认', async () => {
    await setup(VOICE_YAML())
    ops.sleep.mockImplementation(() => new Promise<void>(() => undefined))
    const r = await api.voiceStart({})
    expect(r.result).toBe('done')
    expect(r.ok).toBe(true)
    expect(r.text).toBe('语音服务已启动，模型 0.6b，权重目录 /data/voice。')
    expect(ops.start).toHaveBeenCalledWith(expect.anything(), expect.anything(), { signal: expect.anything(), offline: true })
    expect(state.started?.pid).toBe(9)
  })

  it('要装环境或下模型：先返回与卡片同样的说明，不启动、不安装；确认后才开始', async () => {
    await setup(VOICE_YAML('  hfEndpoint: https://hf-mirror.com\n'))
    ops.inspect.mockResolvedValue(info({ envInstalled: false, modelDownloaded: false }))
    const first = await api.voiceStart({})
    const want = voiceCardMarkdown({
      env: true, model: { name: '0.6b', size: '约 1.9GB' }, modelsDir: '/data/voice', hfEndpoint: 'https://hf-mirror.com',
    })
    expect(first.result).toBe('need-confirm')
    expect(first.confirm?.detail).toBe(want)
    expect(ops.install).not.toHaveBeenCalled()
    expect(ops.start).not.toHaveBeenCalled()
    expect(isLaunching('/data/voice')).toBe(false)

    const second = await api.voiceStart({ confirmed: true, detail: first.confirm!.detail })
    expect(second.result).toBe('done')
    expect(ops.install).toHaveBeenCalledTimes(1)
    expect(ops.start).toHaveBeenCalledTimes(1)
  })

  it('说明已经变了（确认的不是当前的内容）：重新要确认', async () => {
    await setup(VOICE_YAML())
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    const r = await api.voiceStart({ confirmed: true, detail: '过时的说明' })
    expect(r.result).toBe('need-confirm')
    expect(ops.install).not.toHaveBeenCalled()
  })

  it('只带 confirmed 不带说明也不放行', async () => {
    await setup(VOICE_YAML())
    ops.inspect.mockResolvedValue(info({ envInstalled: false }))
    expect((await api.voiceStart({ confirmed: true })).result).toBe('need-confirm')
    expect((await api.voiceStart(null)).result).toBe('need-confirm')
    expect(ops.install).not.toHaveBeenCalled()
  })

  it('不能代为启动、已在运行等：回执文字与命令一致', async () => {
    await setup('voice:\n  endpoint: http://127.0.0.1:18123\n')
    const r = await api.voiceStart({})
    expect(r.result).toBe('done')
    expect(r.text).toBe('配置里的 launch 不是 mlx，插件不会代为启动，请自己启动语音服务。')

    await setup(VOICE_YAML())
    ops.inspect.mockResolvedValue(info({ reachable: true, owned: { pid: 1, port: 1, startedAt: 1 } }))
    expect((await api.voiceStart({})).text).toBe('语音服务已在运行。')
  })

  it('8 秒内没完成：转后台，结果是 starting；之后状态接口显示进度', async () => {
    await setup(VOICE_YAML())
    ops.start.mockImplementation(() => new Promise(() => undefined))
    ops.sleep.mockResolvedValue(undefined)
    const r = await api.voiceStart({})
    expect(r.result).toBe('starting')
    expect(isLaunching('/data/voice')).toBe(true)
    const s = await api.voiceStatus()
    expect(s.state).toBe('starting')
    expect(s.stage).toBe('start')
    expect(s.canStart).toBe(false)
  })

  it('启动中再点：提示忙，不重复启动', async () => {
    await setup(VOICE_YAML())
    ops.start.mockImplementation(() => new Promise(() => undefined))
    ops.sleep.mockResolvedValue(undefined)
    await api.voiceStart({})
    const again = await api.voiceStart({})
    expect(again.text).toBe('语音服务正在启动中，请稍候。')
    expect(ops.start).toHaveBeenCalledTimes(1)
  })

  it('启动失败：状态显示上次失败的原因', async () => {
    await setup(VOICE_YAML())
    ops.start.mockResolvedValue({ ok: false, kind: 'occupied', detail: 'secret server text' })
    const r = await api.voiceStart({})
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('secret server text')
    const s = await api.voiceStatus()
    expect(s.state).toBe('failed')
    expect(s.text).toContain('端口被别的服务占用')
  })

  it('页面启动与命令共用同一张启动表：命令查状态能看到页面发起的启动', async () => {
    await setup(VOICE_YAML())
    ops.start.mockImplementation(() => new Promise(() => undefined))
    ops.sleep.mockResolvedValue(undefined)
    await api.voiceStart({})
    const reply = await rt.voice!.handler({ rt, args: '状态', agent: { id: 's1' } } as unknown as Invocation)
    expect(reply.text).toContain('正在启动')
  })
})

describe('voiceStop：与 /aha 语音 停止 同一段逻辑', () => {
  it('停止插件启动的服务，回执与命令一致，并清掉"本实例启动"标记', async () => {
    await setup(VOICE_YAML())
    await api.voiceStart({})
    expect(state.started).not.toBeNull()
    const r = await api.voiceStop()
    expect(r.text).toBe(voiceStopReceipt('stopped').text)
    expect(ops.stop).toHaveBeenCalledTimes(1)
    expect(state.started).toBeNull()
  })

  it('外部服务不停', async () => {
    await setup(VOICE_YAML())
    ops.stop.mockResolvedValue({ status: 'not-ours', forced: false })
    const r = await api.voiceStop()
    expect(r.text).toBe(voiceStopReceipt('not-ours').text)
  })

  it('没配置', async () => {
    const r = await api.voiceStop()
    expect(r.ok).toBe(false)
    expect(ops.stop).not.toHaveBeenCalled()
  })

  it('进行中的启动被打断', async () => {
    await setup(VOICE_YAML())
    ops.start.mockImplementation(() => new Promise(() => undefined))
    ops.sleep.mockResolvedValue(undefined)
    await api.voiceStart({})
    await api.voiceStop()
    expect(ops.stop).toHaveBeenCalled()
  })
})

describe('测试连接', () => {
  it('语音：连上并加载了模型', async () => {
    await setup(VOICE_YAML())
    const r = await api.testVoice()
    expect(r.ok).toBe(true)
    expect(r.lines.map((l) => l.text).join('；')).toContain('127.0.0.1:18123')
    expect(probeVoice).toHaveBeenCalledWith('http://127.0.0.1:18123', expect.any(Number))
  })

  it('语音：连得上但模型没加载仍算连通', async () => {
    await setup(VOICE_YAML())
    probeVoice.mockResolvedValue([])
    const r = await api.testVoice()
    expect(r.ok).toBe(true)
    expect(r.lines.map((l) => l.text).join('')).toContain('尚未加载')
  })

  it('语音：连不上，只给归类后的说明，不带服务端原文与账号', async () => {
    await setup(VOICE_YAML())
    probeVoice.mockRejectedValue(new TtsError('unreachable', 'connect ECONNREFUSED http://u:pw@127.0.0.1:18123 secret-body'))
    const r = await api.testVoice()
    expect(r.ok).toBe(false)
    const all = JSON.stringify(r)
    expect(all).not.toContain('secret-body')
    expect(all).not.toContain('pw')
    expect(r.lines[0]!.text).toContain('连不上')
    expect((rt.log.debug as any).mock.calls.join('')).not.toContain('pw@')
  })

  it('语音：没配置 / 带账号都不发请求', async () => {
    expect((await api.testVoice()).ok).toBe(false)
    await setup('voice:\n  endpoint: http://u:p@127.0.0.1:1\n')
    expect((await api.testVoice()).ok).toBe(false)
    expect(probeVoice).not.toHaveBeenCalled()
  })

  it('生图：用检查报告逐项列出', async () => {
    await setup('image:\n  endpoint: http://h:8188\n')
    const report: DrawDoctorReport = {
      configured: true, problems: [],
      service: { host: 'h:8188', connected: true, version: '0.3.1' },
      workflow: { name: 'qwen-image-2.1', ok: true },
      nodes: { total: 5, missing: [] },
      models: { missing: [], unsure: [] },
    }
    checkImage.mockResolvedValue(report)
    const r = await api.testImage()
    expect(r.ok).toBe(true)
    expect(r.lines.length).toBeGreaterThanOrEqual(3)
    expect(checkImage).toHaveBeenCalledTimes(1)
  })

  it('生图：有缺项则不通过；检查本身抛错也只给固定说明', async () => {
    await setup('image:\n  endpoint: http://h:8188\n')
    checkImage.mockResolvedValueOnce({
      configured: true, problems: [],
      service: { host: 'h:8188', connected: false, failKind: 'unreachable' },
    } satisfies DrawDoctorReport)
    expect((await api.testImage()).ok).toBe(false)
    checkImage.mockRejectedValueOnce(new Error('boom http://u:pw@h secret'))
    const r = await api.testImage()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('生图：没配置', async () => {
    checkImage.mockResolvedValue({ configured: false, problems: [] } satisfies DrawDoctorReport)
    const r = await api.testImage()
    expect(r.ok).toBe(false)
  })
})
