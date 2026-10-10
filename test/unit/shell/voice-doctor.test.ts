import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Player } from '../../../src/core/player'
import type { VoiceServiceResult, VoiceServiceSettings } from '../../../src/core/services'
import type { VoiceServerInfo } from '../../../src/core/voice-server'
import { SessionGate } from '../../../src/shell/confirm'
import type { HostAgent, Invocation } from '../../../src/shell/context'
import {
  doctorHandler, OPT_CLOSE, OPT_RECHECK, OPT_START_SERVICE, OPT_TRIAL_SPEAK, RECHECK_MAX,
} from '../../../src/shell/doctor'
import { doctorTarget, wantsTrial } from '../../../src/shell/draw-doctor'
import {
  DOCTOR_VOICE_HINT_BOTH, DOCTOR_VOICE_HINT, doctorLine, voiceDoctorBrief, voiceDoctorCardReceipt, voiceDoctorIssues,
  voiceDoctorMarkdown, voiceDoctorOneLine, voiceTrialMarkdown,
} from '../../../src/shell/receipts'
import { createVoiceHandler, resetLaunchesForTest, type VoiceInstanceState, type VoiceOps } from '../../../src/shell/voice'
import {
  checkVoice, TRIAL_LIMIT_MS, TRIAL_TEXT, trialSpeak, voiceCardMode, type VoiceDoctorDeps, type VoiceDoctorReport,
} from '../../../src/shell/voice-doctor'
import { fakeRuntime } from './helpers/runtime'

// ---------- 模块替身：只给 doctorHandler 的真实依赖用 ----------

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  probe: vi.fn(),
  findPlayer: vi.fn(),
  speaker: { speakAndWait: vi.fn(), lastError: vi.fn() },
  readVoice: vi.fn(),
  readCharacter: vi.fn(),
}))
vi.mock('../../../src/core/voice-server', async (orig) => ({ ...(await orig<object>()), inspect: mocks.inspect }))
vi.mock('../../../src/core/tts', async (orig) => ({
  ...(await orig<object>()), createTtsClient: () => ({ probe: mocks.probe, synthesize: vi.fn(), unload: vi.fn() }),
}))
vi.mock('../../../src/core/player', async (orig) => ({ ...(await orig<object>()), findPlayer: mocks.findPlayer }))
vi.mock('../../../src/core/voice', async (orig) => ({ ...(await orig<object>()), readVoice: mocks.readVoice }))
vi.mock('../../../src/core/card', async (orig) => ({ ...(await orig<object>()), readCharacter: mocks.readCharacter }))
vi.mock('../../../src/shell/speak', async (orig) => ({ ...(await orig<object>()), sharedSpeaker: () => mocks.speaker }))

// ---------- 数据 ----------

const MODEL_06 = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit'
const DIR = '/data/voice'
const PLAYER: Player = { command: '/usr/bin/afplay', args: (f) => [f] }
const GB = 2 ** 30

const settings = (over: Partial<VoiceServiceSettings> = {}): VoiceServiceSettings => ({
  endpoint: 'http://127.0.0.1:18123/v1?token=abc', launch: 'mlx', model: MODEL_06, modelAlias: '0.6b', modelsDir: DIR,
  read: 'lines', language: 'chinese', timeoutSeconds: 120, port: 18123, local: true, ...over,
})
const info = (over: Partial<VoiceServerInfo> = {}): VoiceServerInfo => ({
  supported: true, uv: '/usr/bin/uv', envInstalled: true, modelDownloaded: true,
  sizes: { env: Math.round(0.5 * GB), hf: Math.round(1.9 * GB) }, owned: null, reachable: false, busy: false, ...over,
})
const up = (over: Partial<VoiceServerInfo> = {}): VoiceServerInfo =>
  info({ reachable: true, owned: { pid: 1, port: 18123, startedAt: 1 }, ...over })

let cfg: VoiceServiceResult
let clock: number

const makeDeps = (over: Partial<VoiceDoctorDeps> = {}): VoiceDoctorDeps => ({
  loadService: async () => cfg,
  inspect: vi.fn(async () => info()),
  loadedModels: vi.fn(async () => [MODEL_06]),
  findPlayer: vi.fn(async () => PLAYER),
  launchOf: vi.fn(() => null),
  lastSpeakError: vi.fn(() => null),
  builtinVoice: () => ({ audio: '/assets/voice-ref.wav', text: '内置' }),
  speaker: { speakAndWait: vi.fn(async () => ({ status: 'ok' as const })) },
  owner: 's1',
  now: () => (clock += 1000),
  log: { debug: vi.fn() },
  ...over,
})

beforeEach(() => {
  cfg = { configured: true, settings: settings(), problems: [] }
  clock = 1_000_000
  resetLaunchesForTest()
})

// ---------- checkVoice ----------

describe('checkVoice：配置', () => {
  it('没配置：只报未配置，什么都不查', async () => {
    cfg = { configured: false, problems: [] }
    const deps = makeDeps()
    expect(await checkVoice(deps, { detail: true })).toEqual({ configured: false, problems: [] })
    expect(deps.inspect).not.toHaveBeenCalled()
    expect(deps.findPlayer).not.toHaveBeenCalled()
  })

  it('配置写错了没读成：带问题清单', async () => {
    cfg = { configured: false, problems: ['voice.endpoint 必须是 http:// 或 https:// 开头的地址'] }
    const r = await checkVoice(makeDeps(), { detail: true })
    expect(r.problems).toHaveLength(1)
    expect(voiceDoctorOneLine(r)).toContain('! voice.endpoint')
  })

  it('已配置：回落默认值的字段也带上', async () => {
    cfg = { configured: true, settings: settings(), problems: ['voice.timeoutSeconds 不是数字，用了默认值'] }
    const r = await checkVoice(makeDeps(), { detail: true })
    expect(r.configured).toBe(true)
    expect(r.problems).toEqual(['voice.timeoutSeconds 不是数字，用了默认值'])
  })

  it('地址带用户名密码：不发任何请求，报告里没有凭据', async () => {
    cfg = { configured: true, settings: settings({ endpoint: 'http://bob:hunter2@10.0.0.1:8000' }), problems: [] }
    const deps = makeDeps()
    const r = await checkVoice(deps, { detail: true })
    expect(r.service).toEqual({ host: '10.0.0.1:8000', connected: false, credentials: true })
    expect(deps.inspect).not.toHaveBeenCalled()
    expect(deps.loadedModels).not.toHaveBeenCalled()
    const text = voiceDoctorOneLine(r)
    expect(text).toContain('地址里不要带用户名和密码')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('bob')
  })
})

describe('checkVoice：服务与模型', () => {
  it('连得上、插件启动的：已加载模型；主机只显示主机与端口', async () => {
    const deps = makeDeps({ inspect: vi.fn(async () => up()) })
    const r = await checkVoice(deps, { detail: true })
    expect(r.service).toEqual({ host: '127.0.0.1:18123', connected: true, ours: 'plugin' })
    expect(r.model).toEqual({ name: '0.6b', loaded: true })
    expect(JSON.stringify(r)).not.toContain('token')
  })

  it('连得上、外部启动的', async () => {
    const r = await checkVoice(makeDeps({ inspect: vi.fn(async () => info({ reachable: true })) }), { detail: true })
    expect(r.service?.ours).toBe('external')
  })

  it('连得上但所配模型没加载 / 查不出来', async () => {
    const deps = makeDeps({ inspect: vi.fn(async () => up()), loadedModels: vi.fn(async () => ['别的模型']) })
    expect((await checkVoice(deps, { detail: true })).model?.loaded).toBe(false)
    const bad = makeDeps({ inspect: vi.fn(async () => up()), loadedModels: vi.fn(async () => { throw new Error('boom') }) })
    expect((await checkVoice(bad, { detail: true })).model?.loaded).toBeNull()
  })

  it('没有简称就显示完整模型名', async () => {
    const { modelAlias: _alias, ...rest } = settings()
    cfg = { configured: true, settings: rest, problems: [] }
    expect((await checkVoice(makeDeps(), { detail: true })).model?.name).toBe(MODEL_06)
  })

  it('连不上：不查已加载的模型，谁启动的不适用', async () => {
    const deps = makeDeps()
    const r = await checkVoice(deps, { detail: true })
    expect(r.service).toEqual({ host: '127.0.0.1:18123', connected: false })
    expect(r.model).toEqual({ name: '0.6b' })
    expect(deps.loadedModels).not.toHaveBeenCalled()
  })

  it('正在启动：写阶段与已用秒数（取自启动记录）', async () => {
    clock = 1_040_000
    const deps = makeDeps({ launchOf: vi.fn(() => ({ stage: 'warmup' as const, startedAt: 1_000_000, finished: false })) })
    const r = await checkVoice(deps, { detail: true })
    expect(r.service?.launching).toEqual({ stage: 'warmup', seconds: 41 })
    expect(voiceDoctorOneLine(r)).toContain('正在启动：下载并加载模型，已用 41 秒')
  })

  it('目录上有别处发起的安装或启动：算正在启动，阶段未知', async () => {
    const r = await checkVoice(makeDeps({ inspect: vi.fn(async () => info({ busy: true })) }), { detail: true })
    expect(r.service?.launching).toEqual({})
  })

  it('上次启动失败：连不上时写原因；连上了就不写', async () => {
    const failed = { stage: 'start' as const, startedAt: 1, finished: true, failure: '等待服务启动超时' }
    const r = await checkVoice(makeDeps({ launchOf: vi.fn(() => failed) }), { detail: true })
    expect(r.service?.lastFailure).toBe('等待服务启动超时')
    expect(voiceDoctorOneLine(r)).toContain(`上次启动失败：等待服务启动超时（日志 ${DIR}/server.log）`)
    const ok = await checkVoice(makeDeps({ launchOf: vi.fn(() => failed), inspect: vi.fn(async () => up()) }), { detail: true })
    expect(ok.service?.lastFailure).toBeUndefined()
  })
})

describe('checkVoice：代为启动的条件', () => {
  it('launch: mlx：列出平台、uv、环境、模型与目录大小；统计大小', async () => {
    const deps = makeDeps()
    const r = await checkVoice(deps, { detail: true })
    expect(r.launch).toEqual({
      supported: true, uv: true, envInstalled: true, modelDownloaded: true, modelsDir: DIR,
      sizes: { env: Math.round(0.5 * GB), hf: Math.round(1.9 * GB) },
    })
    expect(deps.inspect).toHaveBeenCalledWith(expect.objectContaining({ modelsDir: DIR }), { sizes: true })
    const md = voiceDoctorMarkdown(r)
    expect(md).toContain('权重目录 /data/voice（运行环境 512 MB，模型 1.9 GB）')
  })

  it('launch: none：不列这一组', async () => {
    cfg = { configured: true, settings: settings({ launch: 'none' }), problems: [] }
    const r = await checkVoice(makeDeps(), { detail: true })
    expect(r.launch).toBeUndefined()
    expect(voiceDoctorMarkdown(r)).not.toContain('权重目录')
  })

  it('缺 uv、没装环境、没下模型、平台不支持', async () => {
    const r = await checkVoice(makeDeps({
      inspect: vi.fn(async () => info({ supported: false, uv: null, envInstalled: false, modelDownloaded: false })),
    }), { detail: true })
    const text = voiceDoctorOneLine(r)
    expect(text).toContain('✗ 这台机器不是苹果芯片的 Mac，插件不能代为启动')
    expect(text).toContain('✗ 没有找到 uv')
    expect(text).toContain('运行环境还没安装')
    expect(text).toContain('模型还没下载')
  })

  it('给了已知的目录大小：不再统计，报告沿用它', async () => {
    const deps = makeDeps()
    const known = { env: 1, hf: 2 }
    const r = await checkVoice(deps, { detail: true, knownSizes: known })
    expect(deps.inspect).toHaveBeenCalledWith(expect.anything(), { sizes: false })
    expect(r.launch?.sizes).toEqual(known)
  })

  it('一行小结那条路径不统计目录大小、不查已加载的模型', async () => {
    const deps = makeDeps({ inspect: vi.fn(async () => up()) })
    const r = await checkVoice(deps, { detail: false })
    expect(deps.inspect).toHaveBeenCalledWith(expect.anything(), { sizes: false })
    expect(deps.loadedModels).not.toHaveBeenCalled()
    expect(r.model).toEqual({ name: '0.6b' })
  })
})

describe('checkVoice：播放器、音色、最近的朗读错误', () => {
  it('播放器：写名字（不带目录）；找不到也要说', async () => {
    const r = await checkVoice(makeDeps(), { detail: true })
    expect(r.player).toEqual({ found: true, name: 'afplay' })
    expect(voiceDoctorOneLine(r)).toContain('✓ 播放器 afplay')
    const none = await checkVoice(makeDeps({ findPlayer: vi.fn(async () => null) }), { detail: true })
    expect(none.player).toEqual({ found: false })
    expect(voiceDoctorOneLine(none)).toContain('✗ 没有找到播放器')
  })

  it('当前角色的音色：没有这个依赖（不在聊天中）就没有这一项', async () => {
    expect((await checkVoice(makeDeps(), { detail: true })).voice).toBeUndefined()
    const has = await checkVoice(makeDeps({ characterVoice: async () => ({ audio: '/a.wav', text: 't' }) }), { detail: true })
    expect(has.voice).toEqual({ present: true })
    expect(voiceDoctorOneLine(has)).toContain('✓ 当前角色有音色')
    const no = await checkVoice(makeDeps({ characterVoice: async () => null }), { detail: true })
    expect(no.voice).toEqual({ present: false })
    expect(voiceDoctorOneLine(no)).toContain('当前角色还没有音色')
  })

  it('读音色出错：这一项不列，记日志', async () => {
    const deps = makeDeps({ characterVoice: async () => { throw new Error('读不了') } })
    const r = await checkVoice(deps, { detail: true })
    expect(r.voice).toBeUndefined()
    expect(deps.log.debug).toHaveBeenCalled()
  })

  it('最近一次朗读错误：只列归类后的种类与时间，不带原文', async () => {
    const at = new Date(2026, 9, 10, 8, 5, 9).getTime()
    const r = await checkVoice(makeDeps({ lastSpeakError: vi.fn(() => ({ kind: 'unreachable', at })) }), { detail: true })
    expect(r.lastError).toEqual({ kind: 'unreachable', at })
    expect(voiceDoctorOneLine(r)).toContain('最近一次朗读出错：服务连不上（08:05:09）')
    const none = await checkVoice(makeDeps(), { detail: true })
    expect(none.lastError).toBeUndefined()
  })
})

describe('checkVoice：取消', () => {
  it('一开始就已取消：什么都不查', async () => {
    const ac = new AbortController()
    ac.abort()
    const deps = makeDeps()
    const r = await checkVoice(deps, { detail: true, signal: ac.signal })
    expect(r.cancelled).toBe(true)
    expect(deps.inspect).not.toHaveBeenCalled()
  })

  it('检查途中被取消', async () => {
    const ac = new AbortController()
    const deps = makeDeps({ inspect: vi.fn(async () => { ac.abort(); return up() }) })
    const r = await checkVoice(deps, { detail: true, signal: ac.signal })
    expect(r.cancelled).toBe(true)
    expect(deps.loadedModels).not.toHaveBeenCalled()
  })
})

// ---------- 小结与报告 ----------

const reportOf = (over: Partial<VoiceDoctorDeps> = {}, detail = false): Promise<VoiceDoctorReport> =>
  checkVoice(makeDeps(over), { detail })
const upDeps = (over: Partial<VoiceDoctorDeps> = {}): Partial<VoiceDoctorDeps> => ({ inspect: vi.fn(async () => up()), ...over })

describe('一行小结', () => {
  it('四种状态', async () => {
    cfg = { configured: false, problems: [] }
    expect(voiceDoctorBrief(await reportOf())).toEqual({ status: '未配置', flagged: false })
    cfg = { configured: true, settings: settings(), problems: [] }
    expect(voiceDoctorBrief(await reportOf())).toEqual({ status: '未启动', flagged: true })
    expect(voiceDoctorBrief(await reportOf(upDeps()))).toEqual({ status: '可用', flagged: false })
    expect(voiceDoctorBrief(await reportOf(upDeps({ findPlayer: vi.fn(async () => null) }))))
      .toEqual({ status: '不可用：没有播放器', flagged: true })
  })

  it('不可用：地址带账号密码；启动中', async () => {
    cfg = { configured: true, settings: settings({ endpoint: 'http://u:p@10.0.0.1:8000' }), problems: [] }
    expect(voiceDoctorBrief(await reportOf()).status).toBe('不可用：地址带账号密码')
    cfg = { configured: true, settings: settings(), problems: [] }
    const starting = await reportOf({ launchOf: vi.fn(() => ({ stage: 'start' as const, startedAt: 1, finished: false })) })
    expect(voiceDoctorBrief(starting)).toEqual({ status: '启动中', flagged: true })
  })

  it('"可用"只看已配置、连得上、有播放器：角色没音色、配置有小问题、有朗读错误都不影响', async () => {
    cfg = { configured: true, settings: settings(), problems: ['voice.timeoutSeconds 不是数字，用了默认值'] }
    const r = await reportOf(upDeps({
      characterVoice: async () => null, lastSpeakError: vi.fn(() => ({ kind: 'timeout', at: 1 })),
    }))
    expect(voiceDoctorBrief(r)).toEqual({ status: '可用', flagged: false })
  })

  it('没读成的配置有问题时才提示看详情', async () => {
    cfg = { configured: false, problems: ['voice 一节的格式不对'] }
    expect(voiceDoctorBrief(await reportOf())).toEqual({ status: '未配置', flagged: true })
  })

  it('连不上且上次启动失败：未启动（上次启动失败），仍提示看详情', async () => {
    const failed = { stage: 'start' as const, startedAt: 1, finished: true, failure: '等待服务启动超时' }
    expect(voiceDoctorBrief(await reportOf({ launchOf: vi.fn(() => failed) })))
      .toEqual({ status: '未启动（上次启动失败）', flagged: true })
    // 连上了就不提失败
    expect(voiceDoctorBrief(await reportOf(upDeps({ launchOf: vi.fn(() => failed) }))).status).toBe('可用')
  })

  it('每种状态都不超过 20 个字', async () => {
    const lines = ['未配置', '未启动', '可用', '不可用：没有播放器', '不可用：地址带账号密码', '启动中', '未启动（上次启动失败）']
    for (const l of lines) expect([...`语音 ${l}`].length).toBeLessThanOrEqual(20)
  })
})

describe('doctorLine 里的语音小结', () => {
  const theme = { name: '直白', concept: (k: string) => (k === 'tavern' ? '酒馆' : k) } as any
  const base = { mode: 'setup' as const, tavernDir: '/t', outsideReason: null, webSearch: 'unknown' as const }

  it('放在生图小结之后、酒馆路径之前', () => {
    const line = doctorLine(theme, { ...base, drawing: '生图 可用', drawingHint: false, voice: '语音 可用', voiceHint: false })
    expect(line).toMatch(/^当前状态：模式 .+；生图 可用；语音 可用；酒馆 \/t；/)
    expect(line).not.toContain('看详情')
  })

  it('只有语音要看详情 / 只有生图 / 两个都要', () => {
    const only = (d: boolean, v: boolean) =>
      doctorLine(theme, { ...base, drawing: '生图 x', drawingHint: d, voice: '语音 y', voiceHint: v })
    expect(only(false, true).endsWith(DOCTOR_VOICE_HINT)).toBe(true)
    expect(only(true, false).endsWith('（/aha 自检 生图 看详情）')).toBe(true)
    expect(only(true, true).endsWith(DOCTOR_VOICE_HINT_BOTH)).toBe(true)
    expect(DOCTOR_VOICE_HINT_BOTH).toBe('（/aha 自检 生图｜语音 看详情）')
    expect(DOCTOR_VOICE_HINT).toBe('（/aha 自检 语音 看详情）')
  })

  it('没有语音小结时与原来一模一样', () => {
    expect(doctorLine(theme, { ...base, drawing: '生图 可用', drawingHint: false }))
      .toBe(`当前状态：模式 酒馆:筹备；生图 可用；酒馆 /t；主题 直白；联网搜索 未知`)
  })
})

describe('Markdown 与一行文字', () => {
  it('一项一行的列表', async () => {
    const r = await reportOf(upDeps({ characterVoice: async () => ({ audio: '/a', text: 't' }) }), true)
    const md = voiceDoctorMarkdown(r)
    expect(md.split('\n').every((l) => l.startsWith('- '))).toBe(true)
    expect(md).toContain('- ✓ 语音服务 127.0.0.1:18123 已连上（由插件启动）')
    expect(md).toContain('- ✓ 模型 0.6b 已加载')
    expect(md).toContain('- ✓ 播放器 afplay')
    expect(md).toContain('- ✓ 当前角色有音色')
  })

  it('说明文字放在最前面，其后是报告', async () => {
    const md = voiceDoctorMarkdown(await reportOf(), '语音服务正在启动（安装运行环境）。')
    expect(md.startsWith('**启动服务的结果**：语音服务正在启动（安装运行环境）。\n\n- ')).toBe(true)
  })

  it('路径只出现权重目录与日志路径；没有服务端原文、凭据和游戏名', async () => {
    const r = await reportOf({
      launchOf: vi.fn(() => ({ stage: 'start' as const, startedAt: 1, finished: true, failure: '服务启动后马上退出' })),
      lastSpeakError: vi.fn(() => ({ kind: 'bad-response', at: 5 })),
    }, true)
    const md = voiceDoctorMarkdown(r)
    const paths = md.match(/\/[A-Za-z0-9_.\-/]+/g) ?? []
    expect(paths.every((p) => p.startsWith(DIR))).toBe(true)
    expect(md).not.toContain('token')
    expect(md).not.toContain('/v1')
    expect(md).not.toContain('afplay/')
  })

  it('没配置', async () => {
    cfg = { configured: false, problems: [] }
    expect(voiceDoctorOneLine(await reportOf())).toBe('语音：未配置。配置方法见 docs/voice-setup.md。')
  })

  it('未通过的项', async () => {
    expect(voiceDoctorIssues(await reportOf())).toEqual(['连不上 127.0.0.1:18123'])
    expect(voiceDoctorIssues(await reportOf(upDeps({ findPlayer: vi.fn(async () => null) })))).toEqual(['没有播放器'])
    expect(voiceDoctorIssues(await reportOf(upDeps()))).toEqual([])
    cfg = { configured: false, problems: [] }
    expect(voiceDoctorIssues(await reportOf())).toEqual(['未配置'])
  })

  it('卡片结束的回执', async () => {
    const ok = await reportOf(upDeps())
    expect(voiceDoctorCardReceipt(ok).text).toBe('语音自检：全部通过。')
    expect(voiceDoctorCardReceipt(ok, { status: 'ok', sentences: 1, seconds: 3 }).text)
      .toBe('语音自检：全部通过，试念成功（1 句，3 秒）。')
    expect(voiceDoctorCardReceipt(ok, { status: 'failed', kind: 'timeout' }).text)
      .toBe('语音自检：全部通过，试念失败（合成超时）。')
    expect(voiceDoctorCardReceipt(await reportOf()).text).toBe('语音自检：1 项未通过。')
  })

  it('试念被打断的回执', async () => {
    const ok = await reportOf(upDeps())
    expect(voiceDoctorCardReceipt(ok, { status: 'cancelled' }).text).toBe('语音自检：全部通过，试念被打断，没有念完。')
  })

  it('试念结果卡片的正文', () => {
    expect(voiceTrialMarkdown({ status: 'ok', sentences: 1, seconds: 3 })).toBe('- ✓ 试念成功，共 1 句，用时 3 秒')
    expect(voiceTrialMarkdown({ status: 'failed', kind: 'unreachable' })).toBe('- ✗ 试念失败（服务连不上）')
    expect(voiceTrialMarkdown({ status: 'failed', kind: 'trial-timeout' })).toBe('- ✗ 试念失败（等了 60 秒还没念完）')
    expect(voiceTrialMarkdown({ status: 'failed', kind: '谁知道' })).toBe('- ✗ 试念失败（出错）')
  })
})

// ---------- 试念 ----------

describe('启动中的预热阶段不算可用', () => {
  const starting = { stage: 'warmup' as const, startedAt: 1, finished: false }

  it('连得上但启动记录未结束：报告里标启动中，卡片归 starting，一行小结也是启动中', async () => {
    const deps = makeDeps({ inspect: vi.fn(async () => up()), launchOf: vi.fn(() => starting) })
    const r = await checkVoice(deps, { detail: false })
    expect(r.service).toMatchObject({ connected: true, launching: { stage: 'warmup' } })
    expect(voiceCardMode(r)).toBe('starting')
    expect(voiceDoctorBrief(r)).toEqual({ status: '启动中', flagged: true })
    expect(voiceDoctorIssues(r)).toContain('正在启动')
    expect(voiceDoctorOneLine(r)).toContain('正在启动：下载并加载模型')
  })

  it('试念：正在启动就不开口，返回 starting', async () => {
    const deps = makeDeps({ launchOf: vi.fn(() => starting) })
    expect(await trialSpeak(deps)).toEqual({ status: 'failed', kind: 'starting' })
    expect(deps.speaker.speakAndWait).not.toHaveBeenCalled()
    expect(voiceTrialMarkdown({ status: 'failed', kind: 'starting' })).toContain('还在启动')
  })

  it('启动记录已结束：试念照常', async () => {
    const deps = makeDeps({ launchOf: vi.fn(() => ({ ...starting, finished: true })) })
    expect((await trialSpeak(deps)).status).toBe('ok')
  })
})

describe('服务不在本机的提醒（读不到参考录音）', () => {
  const REMOTE = '语音服务不在本机：它需要能读到这台机器上角色的参考录音路径'
  const HINT = '服务不在本机时，请确认它读得到参考录音'

  it('local 为 false：多一项提醒，不算失败项；本机服务没有', async () => {
    cfg = { configured: true, settings: settings({ endpoint: 'http://10.0.0.2:8000', local: false }), problems: [] }
    const r = await checkVoice(makeDeps({ inspect: vi.fn(async () => up()) }), { detail: true })
    expect(r.service?.remote).toBe(true)
    expect(voiceDoctorOneLine(r)).toContain(`! ${REMOTE}`)
    expect(voiceDoctorIssues(r)).toEqual([])
    expect(voiceDoctorBrief(r)).toEqual({ status: '可用', flagged: false })
    cfg = { configured: true, settings: settings(), problems: [] }
    const local = await checkVoice(makeDeps({ inspect: vi.fn(async () => up()) }), { detail: true })
    expect(local.service?.remote).toBeUndefined()
    expect(voiceDoctorOneLine(local)).not.toContain('不在本机')
  })

  it('最近一次朗读出错是服务返回异常且服务不在本机：说明里附一句', async () => {
    const at = new Date(2026, 9, 10, 8, 5, 9).getTime()
    const bad = await checkVoice(makeDeps({ lastSpeakError: vi.fn(() => ({ kind: 'bad-response', at, remote: true })) }), { detail: true })
    expect(voiceDoctorOneLine(bad)).toContain(`最近一次朗读出错：服务返回异常；${HINT}（08:05:09）`)
    const other = await checkVoice(makeDeps({ lastSpeakError: vi.fn(() => ({ kind: 'timeout', at, remote: true })) }), { detail: true })
    expect(voiceDoctorOneLine(other)).not.toContain(HINT)
    const localBad = await checkVoice(makeDeps({ lastSpeakError: vi.fn(() => ({ kind: 'bad-response', at })) }), { detail: true })
    expect(voiceDoctorOneLine(localBad)).not.toContain(HINT)
  })

  it('试念失败：服务不在本机且是服务返回异常时附一句；原文不进说明', async () => {
    cfg = { configured: true, settings: settings({ local: false }), problems: [] }
    const deps = makeDeps({ speaker: { speakAndWait: vi.fn(async () => ({ status: 'failed' as const, kind: 'bad-response' })) } })
    const t = await trialSpeak(deps)
    expect(t).toEqual({ status: 'failed', kind: 'bad-response', remote: true })
    expect(voiceTrialMarkdown(t as never)).toContain(HINT)
    expect(voiceDoctorCardReceipt({ configured: true, problems: [] } as never, t)).toMatchObject({ text: expect.stringContaining(HINT) })
    cfg = { configured: true, settings: settings(), problems: [] }
    const t2 = await trialSpeak(deps)
    expect(t2).toEqual({ status: 'failed', kind: 'bad-response' })
    expect(voiceTrialMarkdown(t2 as never)).not.toContain(HINT)
  })
})

describe('trialSpeak', () => {
  const s = settings()

  it('配置没读成或地址带凭据：不开口', async () => {
    cfg = { configured: false, problems: [] }
    const deps = makeDeps()
    expect(await trialSpeak(deps)).toEqual({ status: 'failed', kind: 'other' })
    cfg = { configured: true, settings: settings({ endpoint: 'http://u:p@10.0.0.1:8000' }), problems: [] }
    expect(await trialSpeak(deps)).toEqual({ status: 'failed', kind: 'other' })
    expect(deps.speaker.speakAndWait).not.toHaveBeenCalled()
  })

  it('没有角色音色：用随包录音；固定文本；时限 60 秒', async () => {
    const deps = makeDeps()
    const r = await trialSpeak(deps)
    expect(r).toEqual({ status: 'ok', sentences: 1, seconds: expect.any(Number) })
    const [req, opts] = (deps.speaker.speakAndWait as any).mock.calls[0]
    expect(req.sentences).toEqual([TRIAL_TEXT])
    expect(TRIAL_TEXT).toBe('你好，这是一次试念。')
    expect(req.voice).toEqual({ audio: '/assets/voice-ref.wav', text: '内置' })
    expect(req.owner).toBe('s1')
    expect(req.player).toBe(PLAYER)
    expect(req.settings).toEqual(s)
    expect(opts.timeoutMs).toBe(TRIAL_LIMIT_MS)
    expect(TRIAL_LIMIT_MS).toBe(60_000)
  })

  it('有角色音色：用角色的', async () => {
    const deps = makeDeps({ characterVoice: async () => ({ audio: '/c/voice_ref.wav', text: '角色' }) })
    await trialSpeak(deps)
    expect((deps.speaker.speakAndWait as any).mock.calls[0][0].voice).toEqual({ audio: '/c/voice_ref.wav', text: '角色' })
  })

  it('聊天中但角色没有音色：退回随包录音', async () => {
    const deps = makeDeps({ characterVoice: async () => null })
    await trialSpeak(deps)
    expect((deps.speaker.speakAndWait as any).mock.calls[0][0].voice.audio).toBe('/assets/voice-ref.wav')
  })

  it('用时按注入的时钟算', async () => {
    let t = 0
    const deps = makeDeps({ now: () => { const v = t; t += 4000; return v } })
    expect(await trialSpeak(deps)).toEqual({ status: 'ok', sentences: 1, seconds: 4 })
  })

  it.each([
    [{ status: 'failed', kind: 'unreachable' }, { status: 'failed', kind: 'unreachable' }],
    [{ status: 'timeout' }, { status: 'failed', kind: 'trial-timeout' }],
    [{ status: 'stopped' }, { status: 'cancelled' }],
  ])('朗读结局 %j', async (outcome, want) => {
    const deps = makeDeps({ speaker: { speakAndWait: vi.fn(async () => outcome as any) } })
    expect(await trialSpeak(deps)).toEqual(want)
  })

  it('取消信号传给朗读', async () => {
    const ac = new AbortController()
    const deps = makeDeps()
    await trialSpeak(deps, ac.signal)
    expect((deps.speaker.speakAndWait as any).mock.calls[0][1].signal).toBe(ac.signal)
  })

  it('找不到播放器：不开口，报没有播放器', async () => {
    const deps = makeDeps({ findPlayer: vi.fn(async () => null) })
    expect(await trialSpeak(deps)).toEqual({ status: 'failed', kind: 'no-player' })
    expect(deps.speaker.speakAndWait).not.toHaveBeenCalled()
  })
})

// ---------- 参数解析 ----------

describe('参数解析', () => {
  it('doctorTarget：生图 / image 与 语音 / voice 并列，不分大小写', () => {
    expect(doctorTarget('生图')).toBe('image')
    expect(doctorTarget(' IMAGE ')).toBe('image')
    expect(doctorTarget('语音')).toBe('voice')
    expect(doctorTarget('Voice')).toBe('voice')
    expect(doctorTarget('')).toBeNull()
    expect(doctorTarget('语音 吧')).toBeNull()
    expect(doctorTarget('随便')).toBeNull()
  })
  it('wantsTrial 保持原样', () => {
    expect(wantsTrial('生图')).toBe(true)
    expect(wantsTrial('语音')).toBe(false)
  })
})

// ---------- 命令：一行与卡片 ----------

describe('doctorHandler：语音', () => {
  const agent: HostAgent = { id: 's1', ctx: {} }
  const theme = { name: '直白', concept: (k: string) => (k === 'tavern' ? '酒馆' : k) } as any
  let log: { debug: any; info: any; warn: any; error: any }
  let askFn: ReturnType<typeof vi.fn> | undefined
  let gate: SessionGate
  let voiceHandler: ReturnType<typeof vi.fn>

  const inv = (
    mode: 'setup' | 'chat', args = '', over: { signal?: AbortSignal; record?: unknown; handlers?: boolean } = {},
  ): Invocation => ({
    agent, args, label: '/aha 自检', theme, services: {} as any, steer: vi.fn(),
    ...(over.signal ? { signal: over.signal } : {}),
    rt: fakeRuntime({
      log, theme: async () => theme, servicesPath: () => '/nonexistent/services.yaml',
      voiceSettings: async () => cfg, voiceServerDeps: () => ({ tag: 'deps' }) as any,
      builtinAssetsDir: '/assets',
      cards: { gate, getAsk: () => askFn as any },
      handlers: over.handlers === false ? {} : { voice: voiceHandler as any },
    }),
    context: {
      mode, tavern: { dir: '/long/tavern' }, outsideReason: null, cwd: null, sessionId: 's1',
      record: 'record' in over ? over.record : null,
    } as any,
  })
  const text = async (i: Invocation) => (await doctorHandler(i)).text as string

  /** 按提问的 id 依次回答：同一个 id 的多张卡片按顺序取。 */
  const script = (answers: Record<string, string[]>) => {
    const queues = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]))
    askFn!.mockImplementation(async (req: any) => {
      const id = req.questions[0].id as string
      return { answers: [{ id, selected: [queues[id]?.shift() ?? OPT_CLOSE] }] }
    })
  }
  const cards = () => askFn!.mock.calls.map((c) => c[0].questions[0])
  const labels = (card: any) => card.options.map((o: any) => o.label)

  beforeEach(() => {
    log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    askFn = vi.fn()
    gate = new SessionGate()
    voiceHandler = vi.fn(async () => ({ kind: 'success', text: '语音服务已启动，模型 0.6b。' }))
    for (const m of [mocks.inspect, mocks.probe, mocks.findPlayer, mocks.readVoice, mocks.readCharacter]) m.mockReset()
    mocks.speaker.speakAndWait.mockReset()
    mocks.speaker.lastError.mockReset()
    mocks.inspect.mockResolvedValue(up())
    mocks.probe.mockResolvedValue([MODEL_06])
    mocks.findPlayer.mockResolvedValue(PLAYER)
    mocks.speaker.speakAndWait.mockResolvedValue({ status: 'ok' })
    mocks.speaker.lastError.mockReturnValue(null)
    mocks.readCharacter.mockResolvedValue({ dir: '/long/tavern/characters/a' })
    mocks.readVoice.mockResolvedValue({ ok: true, audioPath: '/long/tavern/characters/a/voice_ref.wav', text: '角色的话' })
  })

  describe('/aha 自检 的一行', () => {
    it('带语音小结，一行，放在酒馆路径之前；不弹卡片、不试念', async () => {
      const t = await text(inv('setup'))
      expect(t).not.toContain('\n')
      expect(t).toMatch(/^当前状态：模式 .+；语音 可用；酒馆 \/long\/tavern；/)
      expect(askFn).not.toHaveBeenCalled()
      expect(mocks.speaker.speakAndWait).not.toHaveBeenCalled()
    })

    it('这条路径上调 inspect 不统计目录大小，也不查已加载的模型', async () => {
      await text(inv('setup'))
      expect(mocks.inspect).toHaveBeenCalledWith(expect.anything(), expect.anything(), { sizes: false })
      expect(mocks.probe).not.toHaveBeenCalled()
    })

    it('未配置：不提示详情', async () => {
      cfg = { configured: false, problems: [] }
      const t = await text(inv('setup'))
      expect(t).toContain('语音 未配置')
      // 测试里生图也没配置，行末只提示生图
      expect(t.endsWith('（/aha 自检 生图 看详情）')).toBe(true)
    })

    it('未启动：提示看详情（生图也没配置，所以两个都提示）', async () => {
      mocks.inspect.mockResolvedValue(info())
      const t = await text(inv('setup'))
      expect(t).toContain('语音 未启动')
      expect(t.endsWith(DOCTOR_VOICE_HINT_BOTH)).toBe(true)
    })

    it('不可用：没有播放器', async () => {
      mocks.findPlayer.mockResolvedValue(null)
      expect(await text(inv('chat'))).toContain('语音 不可用：没有播放器')
    })

    it('检查出错：不影响整行，也不写语音小结', async () => {
      mocks.inspect.mockRejectedValue(new Error('boom'))
      const t = await text(inv('setup'))
      expect(t).toMatch(/^当前状态：模式 /)
      expect(t).not.toContain('语音')
      expect(log.warn).toHaveBeenCalled()
    })

    it('已取消', async () => {
      const ac = new AbortController()
      ac.abort()
      expect(await text(inv('setup', '', { signal: ac.signal }))).toBe('自检已取消。')
    })
  })

  describe('/aha 自检 语音：卡片', () => {
    it('全部通过：选项是 试念一句 / 关闭，报告在 detail 里；关闭后回执', async () => {
      script({})
      const r = await doctorHandler(inv('setup', '语音'))
      const [c] = cards()
      expect(askFn).toHaveBeenCalledTimes(1)
      expect(c.header).toBe('语音自检')
      expect(c.question).toBe('语音服务检查结果：全部通过')
      expect(c.detail).toMatch(/^- ✓ 语音服务 /m)
      expect(labels(c)).toEqual([OPT_TRIAL_SPEAK, OPT_CLOSE])
      expect(r).toEqual({ kind: 'success', text: '语音自检：全部通过。' })
      expect(mocks.inspect).toHaveBeenCalledWith(expect.anything(), expect.anything(), { sizes: true })
    })

    it('参数 voice / VOICE 同样触发', async () => {
      script({})
      await doctorHandler(inv('setup', 'Voice'))
      expect(askFn).toHaveBeenCalledTimes(1)
    })

    it('单聊中有角色音色：报告里有这一项，试念用角色的音色', async () => {
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK, OPT_CLOSE] })
      const r = await doctorHandler(inv('chat', '语音', { record: { chatId: 'c1', characterId: 'a' } }))
      expect(cards()[0].detail).toContain('✓ 当前角色有音色')
      expect(mocks.readCharacter).toHaveBeenCalledWith('/long/tavern', 'a')
      const [req, opts] = mocks.speaker.speakAndWait.mock.calls[0]!
      expect(req.voice).toEqual({ audio: '/long/tavern/characters/a/voice_ref.wav', text: '角色的话' })
      expect(req.sentences).toEqual(['你好，这是一次试念。'])
      expect(opts.timeoutMs).toBe(60_000)
      expect(r.text).toMatch(/^语音自检：全部通过，试念成功（1 句，\d+ 秒）。$/)
    })

    it('筹备模式：没有角色音色这一项，试念用随包录音', async () => {
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK, OPT_CLOSE] })
      await doctorHandler(inv('setup', '语音'))
      expect(cards()[0].detail).not.toContain('当前角色')
      expect(mocks.speaker.speakAndWait.mock.calls[0]![0].voice).toEqual({
        audio: '/assets/voice-ref.wav', text: expect.stringContaining('欢迎来到这间酒馆'),
      })
      expect(mocks.readCharacter).not.toHaveBeenCalled()
    })

    it('聊天中但角色没有音色：报告列出，试念退回随包录音', async () => {
      mocks.readVoice.mockResolvedValue({ ok: false, missing: 'both' })
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK, OPT_CLOSE] })
      await doctorHandler(inv('chat', '语音', { record: { chatId: 'c1', characterId: 'a' } }))
      expect(cards()[0].detail).toContain('当前角色还没有音色')
      expect(mocks.speaker.speakAndWait.mock.calls[0]![0].voice.audio).toBe('/assets/voice-ref.wav')
    })

    it('试念成功：第二张卡片写句数与用时，选项只有关闭', async () => {
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK, OPT_CLOSE] })
      await doctorHandler(inv('setup', '语音'))
      expect(askFn).toHaveBeenCalledTimes(2)
      const c2 = cards()[1]
      expect(c2.question).toBe('试念成功')
      expect(c2.detail).toMatch(/^- ✓ 试念成功，共 1 句，用时 \d+ 秒$/)
      expect(labels(c2)).toEqual([OPT_CLOSE])
    })

    it('试念失败：卡片写归类后的原因，不带原文', async () => {
      mocks.speaker.speakAndWait.mockResolvedValue({ status: 'failed', kind: 'bad-response' })
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK, OPT_CLOSE] })
      const r = await doctorHandler(inv('setup', '语音'))
      expect(cards()[1].question).toBe('试念失败')
      expect(cards()[1].detail).toBe('- ✗ 试念失败（服务返回异常）')
      expect(r.text).toBe('语音自检：全部通过，试念失败（服务返回异常）。')
    })

    it('试念超过 60 秒：当作失败', async () => {
      mocks.speaker.speakAndWait.mockResolvedValue({ status: 'timeout' })
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK, OPT_CLOSE] })
      const r = await doctorHandler(inv('setup', '语音'))
      expect(r.text).toBe('语音自检：全部通过，试念失败（等了 60 秒还没念完）。')
    })

    it('试念时收到取消：停下，回"自检已取消"，不再弹结果卡片', async () => {
      const ac = new AbortController()
      mocks.speaker.speakAndWait.mockImplementation(async () => { ac.abort(); return { status: 'stopped' } })
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK] })
      const r = await doctorHandler(inv('setup', '语音', { signal: ac.signal }))
      expect(r.text).toBe('自检已取消。')
      expect(askFn).toHaveBeenCalledTimes(1)
    })

    it('试念被别的朗读顶掉（卡片没取消）：回执说明没念完', async () => {
      mocks.speaker.speakAndWait.mockResolvedValue({ status: 'stopped' })
      script({ 'voice-doctor': [OPT_TRIAL_SPEAK] })
      const r = await doctorHandler(inv('setup', '语音'))
      expect(askFn).toHaveBeenCalledTimes(1)
      expect(r.text).toBe('语音自检：全部通过，试念被打断，没有念完。')
    })

    it('目录大小在重新检查时沿用；启动服务（可能装了环境）之后重新统计', async () => {
      mocks.inspect.mockResolvedValueOnce(info()).mockResolvedValueOnce(info()).mockResolvedValue(up())
      script({ 'voice-doctor': [OPT_RECHECK, OPT_START_SERVICE, OPT_CLOSE] })
      await doctorHandler(inv('setup', '语音'))
      const sizesFlags = mocks.inspect.mock.calls.map((c) => c[2].sizes)
      expect(sizesFlags).toEqual([true, false, true])
      expect(cards().every((c) => c.detail.includes('运行环境 512 MB，模型 1.9 GB'))).toBe(true)
    })

    it('安装前统计到 0（环境还没装）：不缓存，启动后的那次卡片显示新的大小', async () => {
      const empty = info({ envInstalled: false, sizes: { env: 0, hf: 0 } })
      mocks.inspect.mockResolvedValueOnce(empty).mockResolvedValue(up({ sizes: { env: 433 * 1024 * 1024, hf: 0 } }))
      script({ 'voice-doctor': [OPT_START_SERVICE, OPT_CLOSE] })
      await doctorHandler(inv('setup', '语音'))
      expect(mocks.inspect.mock.calls.map((c) => c[2].sizes)).toEqual([true, true])
      expect(cards()[1].detail).toContain('运行环境 433 MB')
      expect(cards()[1].detail).not.toContain('运行环境 0 KB')
    })

    it('统计为 0 时重新检查也重新统计', async () => {
      const empty = info({ envInstalled: false, sizes: { env: 0, hf: 0 } })
      mocks.inspect.mockResolvedValue(empty)
      script({ 'voice-doctor': [OPT_RECHECK, OPT_CLOSE] })
      await doctorHandler(inv('setup', '语音'))
      expect(mocks.inspect.mock.calls.map((c) => c[2].sizes)).toEqual([true, true])
    })

    it('没连上、launch: mlx、平台支持、有 uv：启动服务 / 重新检查 / 关闭', async () => {
      mocks.inspect.mockResolvedValue(info())
      script({})
      const r = await doctorHandler(inv('setup', '语音'))
      const c = cards()[0]
      expect(c.question).toBe('语音服务检查结果：有未通过的项')
      expect(labels(c)).toEqual([OPT_START_SERVICE, OPT_RECHECK, OPT_CLOSE])
      expect(c.detail).toContain('✗ 语音服务 127.0.0.1:18123 连不上')
      expect(c.detail).toContain('权重目录 /data/voice')
      expect(r.text).toBe('语音自检：1 项未通过。')
    })

    it('启动服务：走启动流程，回执文字放进下一张自检卡片的说明，并重新检查', async () => {
      mocks.inspect.mockResolvedValueOnce(info()).mockResolvedValue(up())
      script({ 'voice-doctor': [OPT_START_SERVICE, OPT_CLOSE] })
      const r = await doctorHandler(inv('setup', '语音'))
      expect(voiceHandler).toHaveBeenCalledTimes(1)
      expect(voiceHandler.mock.calls[0]![0].args).toBe('启动')
      expect(askFn).toHaveBeenCalledTimes(2)
      const c2 = cards()[1]
      expect(c2.detail.startsWith('**启动服务的结果**：语音服务已启动，模型 0.6b。\n\n')).toBe(true)
      expect(c2.detail).toContain('✓ 语音服务 127.0.0.1:18123 已连上')
      expect(labels(c2)).toEqual([OPT_TRIAL_SPEAK, OPT_CLOSE])
      expect(r.text).toBe('语音自检：全部通过。')
    })

    it('启动服务：启动流程里的确认卡片直接发出，不在已占着的队列里再排队', async () => {
      // 用真实的启动处理函数，让它发出确认卡片
      const state: VoiceInstanceState = { started: null, launching: null }
      const startOps = {
        inspect: vi.fn().mockResolvedValue(info({ envInstalled: false })),
        install: vi.fn().mockResolvedValue({ ok: true }),
        start: vi.fn().mockResolvedValue({ ok: true, pid: 9, alreadyRunning: false }),
        stop: vi.fn(), modelDownloaded: vi.fn(),
        createClient: vi.fn(() => ({ synthesize: vi.fn().mockResolvedValue({}), probe: vi.fn() })),
        now: Date.now, sleep: vi.fn(() => new Promise<void>(() => undefined)),
      }
      voiceHandler = vi.fn(createVoiceHandler(state, startOps as unknown as VoiceOps))
      mocks.inspect.mockResolvedValueOnce(info({ envInstalled: false })).mockResolvedValue(up())
      script({ 'voice-doctor': [OPT_START_SERVICE, OPT_CLOSE], 'voice-start': ['开始'] })
      const r = await doctorHandler(inv('setup', '语音'))
      expect(cards().map((c) => c.id)).toEqual(['voice-doctor', 'voice-start', 'voice-doctor'])
      expect(startOps.install).toHaveBeenCalled()
      expect(cards()[2].detail).toContain('语音服务已启动')
      expect(r.text).toBe('语音自检：全部通过。')
    })

    it('正在启动：选项只有 重新检查 / 关闭，报告写阶段与已用时间', async () => {
      mocks.inspect.mockResolvedValue(info({ busy: true }))
      script({})
      await doctorHandler(inv('setup', '语音'))
      const c = cards()[0]
      expect(labels(c)).toEqual([OPT_RECHECK, OPT_CLOSE])
      expect(c.detail).toContain('正在启动')
    })

    it('其他问题（没有播放器 / launch: none / 缺 uv / 平台不支持）：重新检查 / 关闭', async () => {
      mocks.findPlayer.mockResolvedValue(null)
      script({})
      await doctorHandler(inv('setup', '语音'))
      expect(labels(cards()[0])).toEqual([OPT_RECHECK, OPT_CLOSE])
      expect(cards()[0].detail).toContain('✗ 没有找到播放器')

      for (const over of [{ uv: null }, { supported: false }]) {
        askFn!.mockClear()
        mocks.inspect.mockResolvedValue(info(over))
        mocks.findPlayer.mockResolvedValue(PLAYER)
        await doctorHandler(inv('setup', '语音'))
        expect(labels(cards()[0])).toEqual([OPT_RECHECK, OPT_CLOSE])
      }
      askFn!.mockClear()
      cfg = { configured: true, settings: settings({ launch: 'none' }), problems: [] }
      mocks.inspect.mockResolvedValue(info())
      await doctorHandler(inv('setup', '语音'))
      expect(labels(cards()[0])).toEqual([OPT_RECHECK, OPT_CLOSE])
    })

    it('没有登记启动处理函数：不提供"启动服务"', async () => {
      mocks.inspect.mockResolvedValue(info())
      script({})
      await doctorHandler(inv('setup', '语音', { handlers: false }))
      expect(labels(cards()[0])).toEqual([OPT_RECHECK, OPT_CLOSE])
    })

    it('没配置：重新检查 / 关闭', async () => {
      cfg = { configured: false, problems: [] }
      script({})
      const r = await doctorHandler(inv('setup', '语音'))
      expect(labels(cards()[0])).toEqual([OPT_RECHECK, OPT_CLOSE])
      expect(cards()[0].detail).toContain('语音：未配置')
      expect(r.text).toBe('语音自检：1 项未通过。')
    })

    it('重新检查：再弹卡片，通过后选项变为试念', async () => {
      mocks.inspect.mockResolvedValueOnce(info()).mockResolvedValue(up())
      script({ 'voice-doctor': [OPT_RECHECK, OPT_CLOSE] })
      const r = await doctorHandler(inv('setup', '语音'))
      expect(askFn).toHaveBeenCalledTimes(2)
      expect(labels(cards()[1])).toEqual([OPT_TRIAL_SPEAK, OPT_CLOSE])
      expect(r.text).toBe('语音自检：全部通过。')
    })

    it('重新检查最多连续 5 次（与生图自检同一个上限）', async () => {
      mocks.findPlayer.mockResolvedValue(null)
      askFn!.mockImplementation(async (req: any) => ({ answers: [{ id: req.questions[0].id, selected: [OPT_RECHECK] }] }))
      const r = await doctorHandler(inv('setup', '语音'))
      expect(askFn).toHaveBeenCalledTimes(RECHECK_MAX + 1)
      expect(r.text).toBe('语音自检：1 项未通过。')
    })

    it('卡片被跳过：结束；被取消：自检已取消', async () => {
      askFn!.mockResolvedValue({})
      expect((await doctorHandler(inv('setup', '语音'))).text).toBe('语音自检：全部通过。')
      askFn!.mockRejectedValue(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
      expect((await doctorHandler(inv('setup', '语音'))).text).toBe('自检已取消。')
    })

    it('已有卡片未答：不弹新卡片', async () => {
      let release!: () => void
      const held = gate.run('s1', () => new Promise<void>((r) => { release = r }), 'command')
      const r = await doctorHandler(inv('setup', '语音'))
      expect(r.text).toBe('有一张卡片还没回答，先处理它再自检。')
      expect(askFn).not.toHaveBeenCalled()
      release()
      await held
    })

    it('没有提问服务：完整结果压成一行，不试念、不启动', async () => {
      askFn = undefined
      mocks.inspect.mockResolvedValue(info())
      const r = await doctorHandler(inv('setup', '语音'))
      const t = r.text as string
      expect(t).not.toContain('\n')
      expect(t).toContain('✗ 语音服务 127.0.0.1:18123 连不上')
      expect(t).toContain('✓ 播放器 afplay')
      expect(voiceHandler).not.toHaveBeenCalled()
      expect(mocks.speaker.speakAndWait).not.toHaveBeenCalled()
    })

    it('检查出错：回一行说明，不抛错', async () => {
      mocks.inspect.mockRejectedValue(new Error('boom'))
      const r = await doctorHandler(inv('setup', '语音'))
      expect(r.text).toBe('语音自检出错，详情见日志。')
      expect(log.warn).toHaveBeenCalled()
    })

    it('生图参数的行为不受影响：没有声音相关的调用', async () => {
      mocks.inspect.mockClear()
      askFn!.mockResolvedValue({})
      await doctorHandler(inv('setup', '生图'))
      expect(mocks.inspect).not.toHaveBeenCalled()
    })
  })
})
