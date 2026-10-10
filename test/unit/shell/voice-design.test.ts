import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCharacter } from '../../../src/core/card'
import { VOICE_DESIGN_MODEL, type VoiceServiceResult, type VoiceServiceSettings } from '../../../src/core/services'
import { createTavern } from '../../../src/core/tavern'
import { TtsError } from '../../../src/core/tts'
import { VOICE_AUDIO_FILE, VOICE_TEXT_FILE } from '../../../src/core/voice'
import { DeclineTracker, SessionGate } from '../../../src/shell/confirm'
import type { HostAgent } from '../../../src/shell/context'
import { registerVoiceDesignTool, type VoiceDesignDeps } from '../../../src/shell/voice-design'

/** 现场生成指定时长的静音 wav（8kHz 单声道 16 位）。 */
function makeWav(seconds: number): Buffer {
  const byteRate = 16000
  const dataLen = Math.round(seconds * byteRate)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + dataLen, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(8000, 24)
  head.writeUInt32LE(byteRate, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(dataLen, 40)
  return Buffer.concat([head, Buffer.alloc(dataLen)])
}

const MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit'
const settings = (over: Partial<VoiceServiceSettings> = {}): VoiceServiceSettings => ({
  endpoint: 'http://127.0.0.1:18123', launch: 'mlx', model: MODEL, modelAlias: '0.6b', modelsDir: '/data/voice',
  read: 'lines', language: 'chinese', timeoutSeconds: 120, port: 18123, local: true, ...over,
})
const PLAYER = { command: 'afplay', args: (f: string) => [f] }
const DESC = '二十多岁的年轻女声，音色清亮，语速偏快，带一点狡黠的笑意'
const SAMPLE = '哼，这么简单的事，也值得你特地来找我吗？'

type Step = string | { custom: string } | Error
let root: string
let tavern: string
let tmpRoot: string
let charDir: string
let cfg: VoiceServiceResult
let ask: ReturnType<typeof vi.fn>
let script: Step[]
let synth: ReturnType<typeof vi.fn>
let unload: ReturnType<typeof vi.fn>
let play: ReturnType<typeof vi.fn>
let stopIfOwner: ReturnType<typeof vi.fn>
let inspect: ReturnType<typeof vi.fn>
let modelDownloaded: ReturnType<typeof vi.fn>
let restartService: ReturnType<typeof vi.fn>
let lastStartOffline: ReturnType<typeof vi.fn>
let isLaunching: ReturnType<typeof vi.fn>
let findPlayer: ReturnType<typeof vi.fn>
let onRegistered: ReturnType<typeof vi.fn>
let declines: DeclineTracker
let gate: SessionGate
let log: { debug: any; info: any; warn: any; error: any }
let defs: Record<string, { description: string; parameters: any; execute(a: unknown, e: unknown): Promise<string> }>
let exec: (a?: Record<string, unknown>, o?: { agent?: HostAgent | null; signal?: AbortSignal }) => Promise<string>

const agentAt = (cwd: string): HostAgent => ({ id: 's', ctx: {}, session: { header: { cwd } } })
const tmpEntries = () => fs.readdir(tmpRoot)

function build(over: Partial<VoiceDesignDeps> = {}) {
  defs = {}
  const ctx = { tools: { register: (d: { name: string }) => { defs[d.name] = d as never } } }
  registerVoiceDesignTool(ctx as never, {
    rt: { log, voiceSettings: async () => cfg, voiceServerDeps: () => ({ tag: 'deps' }) as never },
    getAsk: () => ask as never,
    gate,
    declines,
    speaker: { playFileAndWait: play, stopIfOwner } as never,
    findPlayer: findPlayer as never,
    createClient: () => ({ synthesize: synth, unload }) as never,
    inspect: inspect as never,
    modelDownloaded: modelDownloaded as never,
    restartService: restartService as never,
    lastStartOffline: lastStartOffline as never,
    isLaunching: isLaunching as never,
    tempRoot: () => tmpRoot,
    tavernDirOf: async (a) => a?.session?.header?.cwd as string | undefined,
    onRegistered,
    cleanupLimitMs: 200,
    ...over,
  })
  exec = (a = {}, o = {}) => defs.aha_voice_design!.execute(
    { character: '白狐', description: DESC, sampleText: SAMPLE, ...a },
    { agent: o.agent === undefined ? agentAt(tavern) : o.agent, ...(o.signal ? { signal: o.signal } : {}) },
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-voice-design-'))
  tavern = path.join(root, 'tavern')
  tmpRoot = path.join(root, 'tmp')
  await fs.mkdir(tavern)
  await fs.mkdir(tmpRoot)
  await createTavern(tavern, { name: 't' })
  charDir = (await saveCharacter(tavern, { name: '白狐', persona: 'p' })).dir
  cfg = { configured: true, settings: settings(), problems: [] }
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  script = []
  ask = vi.fn(async (req: any) => {
    const step = script.shift()
    if (step === undefined) throw new Error('unexpected card: ' + req.questions[0].id)
    if (step instanceof Error) throw step
    const id = req.questions[0].id
    return { answers: [typeof step === 'string' ? { id, selected: [step] } : { id, custom: step.custom }] }
  })
  synth = vi.fn(async () => ({ bytes: new Uint8Array(makeWav(5)), format: 'wav' }))
  unload = vi.fn(async () => undefined)
  play = vi.fn(async () => ({ status: 'ok' }))
  stopIfOwner = vi.fn(async () => undefined)
  inspect = vi.fn(async () => ({ reachable: true, owned: { pid: 9, port: 18123, startedAt: 1 } }))
  modelDownloaded = vi.fn(async () => true)
  restartService = vi.fn(async () => true)
  lastStartOffline = vi.fn(() => true)
  isLaunching = vi.fn(() => false)
  findPlayer = vi.fn(async () => PLAYER)
  onRegistered = vi.fn(async () => undefined)
  declines = new DeclineTracker()
  gate = new SessionGate()
  build()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const exists = (p: string) => fs.access(p).then(() => true, () => false)
/** 第一级选第 n 段，第二级采用。 */
const pickAndUse = (n = 1): Step[] => [`第 ${n} 段`, '用这一段']
const questionsOf = () => ask.mock.calls.map((c) => c[0].questions[0])

describe('aha_voice_design 注册', () => {
  it('三个参数都必填，描述写明调用条件', () => {
    const d = defs.aha_voice_design!
    expect(Object.keys(d.parameters.properties)).toEqual(['character', 'description', 'sampleText'])
    expect(d.parameters.required).toEqual(['character', 'description', 'sampleText'])
    expect(d.description).toContain('明确')
    expect(d.description).toContain('voice')
    expect(d.description).toContain('不要替 user 挑')
  })
})

describe('参数范围', () => {
  it.each([
    ['description 太短', { description: '短'.repeat(9) }, 'description'],
    ['description 太长', { description: '长'.repeat(301) }, 'description'],
    ['sampleText 太短', { sampleText: '短'.repeat(9) }, 'sampleText'],
    ['sampleText 太长', { sampleText: '长'.repeat(61) }, 'sampleText'],
    ['character 为空', { character: '  ' }, 'character'],
  ])('%s：直接返回范围说明，什么都不做', async (_n, over, field) => {
    const r = await exec(over)
    expect(r.startsWith('error:')).toBe(true)
    expect(r).toContain(field)
    expect(inspect).not.toHaveBeenCalled()
    expect(synth).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('字数按 Unicode 码点：10 与 60 个码点（含表情）都收', async () => {
    script.push('取消')
    const r = await exec({ sampleText: '😀'.repeat(10) })
    expect(r).not.toContain('error:')
    script.push('取消')
    expect(await exec({ sampleText: '字'.repeat(60), description: '描'.repeat(300) })).not.toContain('error:')
  })
})

describe('前置检查：命中即返回，不发生成请求', () => {
  const none = () => {
    expect(synth).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(restartService).not.toHaveBeenCalled()
    expect(unload).not.toHaveBeenCalled()
  }
  it('不是酒馆', async () => {
    build({ tavernDirOf: async () => undefined })
    expect(await exec()).toBe('error: this workspace is not a tavern yet, voice not designed')
    none()
  })
  it('只读酒馆', async () => {
    const marker = path.join(tavern, 'aha-tavern.yaml')
    const raw = await fs.readFile(marker, 'utf8')
    await fs.writeFile(marker, raw.replace(/version:\s*\d+/, 'version: 9999'))
    const r = await exec()
    expect(r).toContain('read-only')
    expect(r).toContain('voice not designed')
    none()
  })
  it('角色不存在', async () => {
    const r = await exec({ character: '黑猫' })
    expect(r).toContain('no character named')
    none()
  })
  it('没配置语音', async () => {
    cfg = { configured: false, problems: [] }
    expect(await exec()).toContain('not configured')
    none()
  })
  it('地址带用户名密码：不探测', async () => {
    cfg = { configured: true, settings: settings({ endpoint: 'http://u:p@127.0.0.1:1' }), problems: [] }
    expect(await exec()).toContain('username or password')
    expect(inspect).not.toHaveBeenCalled()
    none()
  })
  it('launch 不是 mlx：这个后端不支持音色设计', async () => {
    cfg = { configured: true, settings: settings({ launch: 'none' }), problems: [] }
    const r = await exec()
    expect(r).toContain('unsupported')
    none()
  })
  it('服务连不上：提示先启动', async () => {
    inspect.mockResolvedValue({ reachable: false, owned: null })
    const r = await exec()
    expect(r).toContain('not running')
    expect(r).toContain('/aha 语音 启动')
    none()
  })
  it('服务正在启动中：提示稍后再试', async () => {
    inspect.mockResolvedValue({ reachable: false, owned: null })
    isLaunching.mockReturnValue(true)
    const r = await exec()
    expect(r).toContain('still starting')
    expect(r).not.toContain('/aha 语音 启动')
    none()
  })
  it('服务进程已能应答但仍在启动（预热中）：同样提示稍后再试，不弹卡片不合成', async () => {
    inspect.mockResolvedValue({ reachable: true, owned: { pid: 9, port: 18123, startedAt: 1 } })
    isLaunching.mockReturnValue(true)
    const r = await exec()
    expect(r).toContain('still starting')
    expect(isLaunching).toHaveBeenCalledWith('/data/voice')
    none()
  })
  it('服务不是插件启动的：归为不支持', async () => {
    inspect.mockResolvedValue({ reachable: true, owned: null })
    const r = await exec()
    expect(r).toContain('unsupported')
    none()
  })
  it('没有提问服务：不生成', async () => {
    build({ getAsk: () => undefined })
    expect(await exec()).toBe('voice not designed: confirmation unavailable')
    expect(synth).not.toHaveBeenCalled()
  })
  it('前置检查失败不碰临时目录', async () => {
    cfg = { configured: false, problems: [] }
    await exec()
    expect(await tmpEntries()).toEqual([])
  })
})

describe('设计模型的下载确认', () => {
  beforeEach(() => modelDownloaded.mockImplementation(async (_d: string, id: string) => id !== VOICE_DESIGN_MODEL))

  it('卡片写明大小、存放目录、下载源、内存提示；用 modelDownloaded 判断', async () => {
    cfg = { configured: true, settings: settings({ hfEndpoint: 'https://hf-mirror.com' }), problems: [] }
    script.push('开始下载', ...pickAndUse())
    await exec()
    const q = questionsOf()[0]
    expect(q.id).toBe('voice-design-download')
    expect(q.detail).toContain('约 2.9GB')
    expect(q.detail).toContain('/data/voice')
    expect(q.detail).toContain('https://hf-mirror.com')
    expect(q.detail).toContain('约 6GB')
    expect(q.options.map((o: { label: string }) => o.label)).toEqual(['开始下载', '取消'])
    expect(modelDownloaded).toHaveBeenCalledWith('/data/voice', VOICE_DESIGN_MODEL)
  })

  it('取消：返回下载被取消，不生成、不动服务，同一轮再调用直接返回已拒绝', async () => {
    declines.onStep('s', 1)
    script.push('取消')
    const r = await exec()
    expect(r).toContain('download-cancelled')
    expect(synth).not.toHaveBeenCalled()
    expect(restartService).not.toHaveBeenCalled()
    expect(unload).not.toHaveBeenCalled()
    const again = await exec()
    expect(again).toBe('voice not designed: already declined this turn; ask the user what to change first')
    expect(ask).toHaveBeenCalledTimes(1)
    declines.onStep('s', 2)
    script.push('取消')
    expect(await exec()).toContain('download-cancelled')
  })

  it('卡片被中止：返回已取消，不记拒绝', async () => {
    declines.onStep('s', 1)
    script.push(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    expect(await exec()).toBe('voice not designed: cancelled')
    script.push('取消')
    expect(await exec()).toContain('download-cancelled')
  })

  it('同意后服务若是离线启动的：先联网重启再生成', async () => {
    const order: string[] = []
    restartService.mockImplementation(async (_s: unknown, o?: { offline?: boolean }) => (order.push(`restart:${o?.offline}`), true))
    synth.mockImplementation(async () => (order.push('synth'), { bytes: new Uint8Array(makeWav(5)), format: 'wav' }))
    script.push('开始下载', ...pickAndUse())
    await exec()
    expect(order.slice(0, 2)).toEqual(['restart:false', 'synth'])
  })

  it('最近一次是联网启动的：不用先重启', async () => {
    lastStartOffline.mockReturnValue(false)
    const order: string[] = []
    restartService.mockImplementation(async (_s: unknown, o?: { offline?: boolean }) => (order.push(`restart:${o?.offline}`), true))
    script.push('开始下载', ...pickAndUse())
    await exec()
    expect(order[0]).toBe('restart:undefined') // 这是收尾时的那一次
    expect(order).toHaveLength(1)
  })

  it('不知道怎么启动的：按需要重启处理', async () => {
    lastStartOffline.mockReturnValue(undefined)
    script.push('开始下载', ...pickAndUse())
    await exec()
    expect(restartService.mock.calls[0]![1]).toEqual({ offline: false })
  })

  it('联网重启失败：返回生成失败，不生成，并把服务恢复成原样', async () => {
    restartService.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    script.push('开始下载')
    const r = await exec()
    expect(r).toContain('generation-failed')
    expect(synth).not.toHaveBeenCalled()
    expect(restartService).toHaveBeenCalledTimes(2)
    expect(restartService.mock.calls[1]![1]).toBeUndefined()
    expect(r).not.toContain('restart failed')
  })

  it('联网重启失败后恢复也失败：附上重启失败的提示', async () => {
    restartService.mockResolvedValue(false)
    script.push('开始下载')
    const r = await exec()
    expect(r).toContain('generation-failed')
    expect(r).toContain('service: restart failed; ask the user to run /aha 语音 启动')
  })

  it('已下载：不弹下载卡片，也不用先重启', async () => {
    modelDownloaded.mockResolvedValue(true)
    script.push(...pickAndUse())
    await exec()
    expect(questionsOf().map((q: { id: string }) => q.id)).not.toContain('voice-design-download')
    expect(restartService.mock.calls.every((c) => c[1]?.offline === undefined)).toBe(true)
  })
})

describe('生成', () => {
  it('同一描述同一台词串行调用三次，参数与超时（30 分钟、5 分钟、5 分钟）', async () => {
    let inflight = 0
    let maxInflight = 0
    synth.mockImplementation(async () => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return { bytes: new Uint8Array(makeWav(5)), format: 'wav' }
    })
    script.push('取消')
    await exec()
    expect(synth).toHaveBeenCalledTimes(3)
    expect(maxInflight).toBe(1)
    for (const c of synth.mock.calls) {
      expect(c[0]).toEqual({ kind: 'design', model: VOICE_DESIGN_MODEL, text: SAMPLE, instruct: DESC, language: 'chinese' })
    }
    expect(synth.mock.calls.map((c) => c[1].timeoutMs)).toEqual([30 * 60_000, 5 * 60_000, 5 * 60_000])
  })

  it('时长不在 3 到 15 秒（与保存时的要求一致）、或不是 wav 的丢弃并补生成', async () => {
    const outs = [makeWav(2.5), makeWav(15.5), Buffer.from('not a wav at all, definitely'), makeWav(3), makeWav(15), makeWav(6)]
    synth.mockImplementation(async () => ({ bytes: new Uint8Array(outs.shift()!), format: 'wav' }))
    script.push('取消')
    await exec()
    expect(synth).toHaveBeenCalledTimes(5) // 总尝试 5 次封顶
    const q = questionsOf()[0]
    expect(q.options.map((o: { label: string }) => o.label)).toEqual(['第 1 段', '第 2 段', '重新生成', '取消'])
    expect(q.detail).toContain('3 秒')
    expect(q.detail).toContain('15 秒')
  })

  it('过滤上下限直接取自保存时的常量', async () => {
    const { MIN_VOICE_SECONDS, MAX_VOICE_SECONDS } = await import('../../../src/core/voice')
    const outs = [makeWav(MIN_VOICE_SECONDS - 0.1), makeWav(MAX_VOICE_SECONDS + 0.1), makeWav(MIN_VOICE_SECONDS)]
    synth.mockImplementation(async () => ({ bytes: new Uint8Array(outs.shift() ?? makeWav(MAX_VOICE_SECONDS)), format: 'wav' }))
    script.push('取消')
    await exec()
    expect(questionsOf()[0].options.map((o: { label: string }) => o.label)).toEqual(['第 1 段', '第 2 段', '第 3 段', '重新生成', '取消'])
  })

  it('全是过短的段：生成失败，不会有选了存不下的段', async () => {
    synth.mockImplementation(async () => ({ bytes: new Uint8Array(makeWav(2.5)), format: 'wav' }))
    expect(await exec()).toContain('generation-failed')
    expect(ask).not.toHaveBeenCalled()
  })

  it('一段都没有：生成失败；同一种失败连续两次就不再试', async () => {
    synth.mockRejectedValue(new TtsError('bad-response', 'secret server text'))
    const r = await exec()
    expect(r).toContain('generation-failed')
    expect(r).not.toContain('secret')
    expect(synth).toHaveBeenCalledTimes(2)
    expect(ask).not.toHaveBeenCalled()
  })

  it('失败种类交替出现不算连续：继续尝试到 5 次封顶', async () => {
    const kinds = ['timeout', 'bad-response', 'timeout', 'bad-response', 'timeout'] as const
    let i = 0
    synth.mockImplementation(async () => { throw new TtsError(kinds[i++ % kinds.length]!) })
    expect(await exec()).toContain('generation-failed')
    expect(synth).toHaveBeenCalledTimes(5)
  })

  it('中间成功一次就重新计连续失败', async () => {
    synth.mockRejectedValueOnce(new TtsError('timeout'))
    synth.mockResolvedValueOnce({ bytes: new Uint8Array(makeWav(5)), format: 'wav' })
    synth.mockRejectedValueOnce(new TtsError('timeout'))
    synth.mockResolvedValue({ bytes: new Uint8Array(makeWav(5)), format: 'wav' })
    script.push('取消')
    await exec()
    expect(questionsOf()[0].options).toHaveLength(5)
  })

  it('服务连不上：不再重试', async () => {
    synth.mockRejectedValue(new TtsError('unreachable'))
    expect(await exec()).toContain('generation-failed')
    expect(synth).toHaveBeenCalledTimes(1)
  })

  it('有的失败有的成功：补到三段为止', async () => {
    synth.mockRejectedValueOnce(new TtsError('timeout'))
    script.push('取消')
    await exec()
    expect(synth).toHaveBeenCalledTimes(4)
    expect(questionsOf()[0].options).toHaveLength(5)
  })

  it('生成中收到取消信号：返回已取消，仍收尾', async () => {
    const ac = new AbortController()
    synth.mockImplementation((_i: unknown, o: { signal: AbortSignal }) =>
      new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new TtsError('cancelled')))))
    const p = exec({}, { signal: ac.signal })
    await vi.waitFor(() => expect(synth).toHaveBeenCalled())
    ac.abort()
    expect(await p).toBe('voice not designed: cancelled')
    expect(unload).toHaveBeenCalled()
  })
})

describe('试听与挑选', () => {
  it('第一级卡片：角色、描述、台词、各段时长；选项列实际生成的段', async () => {
    script.push('取消')
    await exec()
    const q = questionsOf()[0]
    expect(q.id).toBe('voice-design')
    expect(q.detail).toContain('白狐')
    expect(q.detail).toContain(DESC)
    expect(q.detail).toContain(SAMPLE)
    expect(q.detail).toContain('第 1 段：5 秒')
    expect(q.detail).not.toContain('替换')
    expect(q.options.map((o: { label: string }) => o.label)).toEqual(['第 1 段', '第 2 段', '第 3 段', '重新生成', '取消'])
  })

  it('这时临时文件都在系统临时目录下专用的目录里', async () => {
    ask.mockImplementationOnce(async (req: any) => {
      const dirs = await tmpEntries()
      expect(dirs).toHaveLength(1)
      const files = await fs.readdir(path.join(tmpRoot, dirs[0]!))
      expect(files).toHaveLength(3)
      return { answers: [{ id: req.questions[0].id, selected: ['取消'] }] }
    })
    await exec()
    expect(await tmpEntries()).toEqual([])
  })

  it('已有音色：第一级写明会替换现有的声音', async () => {
    await fs.writeFile(path.join(charDir, VOICE_AUDIO_FILE), makeWav(4))
    await fs.writeFile(path.join(charDir, VOICE_TEXT_FILE), '旧的话')
    script.push('取消')
    await exec()
    expect(questionsOf()[0].detail).toContain('采用后会替换现有的声音')
  })

  it('选某一段：立刻播放那个文件（60 秒上限），再弹第二级', async () => {
    script.push('第 2 段', '返回', '取消')
    await exec()
    expect(play).toHaveBeenCalledTimes(1)
    const [file, opts] = play.mock.calls[0]!
    expect(path.basename(file)).toBe('r1-2.wav')
    expect(opts).toMatchObject({ player: PLAYER, owner: 's', limitMs: 60_000 })
    const second = questionsOf()[1]
    expect(second.id).toBe('voice-design-pick')
    expect(second.options.map((o: { label: string }) => o.label)).toEqual(['再听一遍', '用这一段', '返回'])
  })

  it('再听一遍：重播并回到第二级；返回：回第一级', async () => {
    script.push('第 1 段', '再听一遍', '返回', '取消')
    await exec()
    expect(play).toHaveBeenCalledTimes(2)
    expect(questionsOf().map((q: { id: string }) => q.id)).toEqual(['voice-design', 'voice-design-pick', 'voice-design-pick', 'voice-design'])
  })

  it('用这一段：存为角色音色（文字是试听台词），返回已采用', async () => {
    script.push(...pickAndUse(3))
    const r = await exec()
    expect(r).toBe('voice designed and registered for 白狐 (5s, replaced: false)')
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe(SAMPLE)
    expect(await exists(path.join(charDir, VOICE_AUDIO_FILE))).toBe(true)
    expect(onRegistered).toHaveBeenCalledTimes(1)
    expect(r).not.toContain(tmpRoot)
  })

  it('已有音色时不再另弹覆盖确认，返回 replaced: true', async () => {
    await fs.writeFile(path.join(charDir, VOICE_AUDIO_FILE), makeWav(4))
    await fs.writeFile(path.join(charDir, VOICE_TEXT_FILE), '旧的话')
    script.push(...pickAndUse())
    const r = await exec()
    expect(r).toContain('replaced: true')
    expect(questionsOf().map((q: { id: string }) => q.id)).toEqual(['voice-design', 'voice-design-pick'])
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe(SAMPLE)
  })

  it('刷新提示词段失败不影响返回', async () => {
    onRegistered.mockRejectedValue(new Error('boom'))
    script.push(...pickAndUse())
    expect(await exec()).toContain('voice designed and registered')
  })

  it('没有播放器：不播放；卡片写明无法试听并列出文件路径；选段直接进第二级', async () => {
    findPlayer.mockResolvedValue(null)
    script.push('第 1 段', '用这一段')
    const r = await exec()
    expect(play).not.toHaveBeenCalled()
    const [first, second] = questionsOf()
    expect(first.detail).toContain('没有可用的播放器')
    expect(first.detail).toContain('r1-1.wav')
    expect(first.detail).toContain(tmpRoot)
    expect(second.options.map((o: { label: string }) => o.label)).toEqual(['用这一段', '返回'])
    expect(r).toContain('voice designed and registered')
    expect(r).not.toContain(tmpRoot)
  })

  it('播放失败：照样弹第二级', async () => {
    play.mockResolvedValue({ status: 'failed', kind: 'spawn-failed' })
    script.push(...pickAndUse())
    expect(await exec()).toContain('voice designed and registered')
  })
})

describe('重新生成', () => {
  it('丢掉这批再生成三段；最多三轮，到上限后不再列这一项；旧文件被删', async () => {
    const seen: string[][] = []
    ask.mockImplementation(async (req: any) => {
      const dirs = await tmpEntries()
      seen.push(await fs.readdir(path.join(tmpRoot, dirs[0]!)))
      const labels = req.questions[0].options.map((o: { label: string }) => o.label)
      const id = req.questions[0].id
      return { answers: [{ id, selected: [labels.includes('重新生成') ? '重新生成' : '取消'] }] }
    })
    const r = await exec()
    expect(r).toContain('user cancelled')
    expect(synth).toHaveBeenCalledTimes(9)
    const lists = questionsOf()
    expect(lists).toHaveLength(3)
    expect(lists[0].options.map((o: { label: string }) => o.label)).toContain('重新生成')
    expect(lists[1].options.map((o: { label: string }) => o.label)).toContain('重新生成')
    expect(lists[2].options.map((o: { label: string }) => o.label)).not.toContain('重新生成')
    expect(seen[1]).toEqual(['r2-1.wav', 'r2-2.wav', 'r2-3.wav'])
    expect(seen[2]).toEqual(['r3-1.wav', 'r3-2.wav', 'r3-3.wav'])
  })

  it('重新生成后可以采用新一批里的段', async () => {
    script.push('重新生成', ...pickAndUse(2))
    expect(await exec()).toContain('voice designed and registered')
    expect(synth).toHaveBeenCalledTimes(6)
    expect(synth.mock.calls[3]![1].timeoutMs).toBe(5 * 60_000)
  })

  it('重新生成后一段都没有：生成失败', async () => {
    script.push('重新生成')
    let n = 0
    synth.mockImplementation(async () => {
      if (++n <= 3) return { bytes: new Uint8Array(makeWav(5)), format: 'wav' }
      throw new TtsError('timeout')
    })
    expect(await exec()).toContain('generation-failed')
  })
})

describe('取消、中止与自由输入', () => {
  it('取消：返回用户取消，记一次拒绝，同一轮再调用直接返回已拒绝', async () => {
    declines.onStep('s', 1)
    script.push('取消')
    expect(await exec()).toBe('voice not designed: user cancelled')
    expect(await exec()).toContain('already declined')
    expect(synth).toHaveBeenCalledTimes(3)
  })

  it('第一级卡片被中止：返回已取消，不记拒绝', async () => {
    declines.onStep('s', 1)
    script.push(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    expect(await exec()).toBe('voice not designed: cancelled')
    script.push('取消')
    expect(await exec()).toBe('voice not designed: user cancelled')
  })

  it('第二级卡片被中止：同样', async () => {
    script.push('第 1 段', Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    expect(await exec()).toBe('voice not designed: cancelled')
    expect(await tmpEntries()).toEqual([])
  })

  it('信号已中止：播放被打断后返回已取消', async () => {
    const ac = new AbortController()
    play.mockImplementation(async () => { ac.abort(); return { status: 'stopped' } })
    script.push('第 1 段')
    expect(await exec({}, { signal: ac.signal })).toBe('voice not designed: cancelled')
  })

  it('自由输入：返回让掌柜问用户想改什么，不记拒绝，不带用户原文', async () => {
    declines.onStep('s', 1)
    script.push({ custom: '声音再低一点' })
    const r = await exec()
    expect(r).toContain('replied with text')
    expect(r).not.toContain('声音再低一点')
    script.push('取消')
    expect(await exec()).toBe('voice not designed: user cancelled')
  })

  it('第二级的自由输入：同样结束', async () => {
    script.push('第 1 段', { custom: '再低一点' })
    expect(await exec()).toContain('replied with text')
  })

  it('没有选任何项：按取消处理并记拒绝', async () => {
    declines.onStep('s', 1)
    ask.mockResolvedValueOnce({ answers: [] })
    expect(await exec()).toBe('voice not designed: user cancelled')
    expect(await exec()).toContain('already declined')
  })
})

describe('收尾', () => {
  it('成功：停试听、卸载设计模型（带超时）、重启服务、删临时目录', async () => {
    script.push(...pickAndUse())
    const r = await exec()
    expect(r).not.toContain('restart failed')
    expect(stopIfOwner).toHaveBeenCalledWith('s')
    expect(unload).toHaveBeenCalledWith(VOICE_DESIGN_MODEL, { timeoutMs: 10_000 })
    expect(restartService).toHaveBeenCalledTimes(1)
    expect(restartService.mock.calls[0]![0]).toMatchObject({ modelsDir: '/data/voice' })
    expect(restartService.mock.calls[0]![1]).toEqual({ signal: expect.any(AbortSignal) })
    expect(await tmpEntries()).toEqual([])
  })

  it.each([
    ['取消', ['取消']],
    ['自由输入', [{ custom: 'x' }]],
    ['卡片中止', [Object.assign(new Error('x'), { code: 'ASK_ABORTED' })]],
  ] as Array<[string, Step[]]>)('%s 也做同样的收尾', async (_n, steps) => {
    script.push(...steps)
    await exec()
    expect(unload).toHaveBeenCalledTimes(1)
    expect(restartService).toHaveBeenCalledTimes(1)
    expect(await tmpEntries()).toEqual([])
  })

  it('生成全部失败也收尾', async () => {
    synth.mockRejectedValue(new TtsError('timeout'))
    await exec()
    expect(unload).toHaveBeenCalledTimes(1)
    expect(restartService).toHaveBeenCalledTimes(1)
    expect(await tmpEntries()).toEqual([])
  })

  it('流程里出意外（卡片抛了别的错）：收尾照做，返回通用说明', async () => {
    script.push(new Error('/secret/path exploded'))
    const r = await exec()
    expect(r.startsWith('error:')).toBe(true)
    expect(r).not.toContain('exploded')
    expect(r).not.toContain('/secret')
    expect(unload).toHaveBeenCalledTimes(1)
    expect(restartService).toHaveBeenCalledTimes(1)
    expect(await tmpEntries()).toEqual([])
  })

  it('卸载失败只记日志，仍然重启与清理', async () => {
    unload.mockRejectedValue(new TtsError('timeout'))
    script.push('取消')
    await exec()
    expect(log.warn).toHaveBeenCalled()
    expect(restartService).toHaveBeenCalledTimes(1)
    expect(await tmpEntries()).toEqual([])
  })

  it('期间服务被用户停掉（不再是插件启动的）：不重启，只清理', async () => {
    inspect.mockResolvedValueOnce({ reachable: true, owned: { pid: 9, port: 1, startedAt: 1 } })
    inspect.mockResolvedValue({ reachable: false, owned: null })
    synth.mockRejectedValue(new TtsError('unreachable'))
    const r = await exec()
    expect(r).toContain('generation-failed')
    expect(restartService).not.toHaveBeenCalled()
    expect(r).not.toContain('restart failed')
    expect(await tmpEntries()).toEqual([])
  })

  it('流程里出意外且收尾重启也失败：通用说明之外同样附重启失败的提示', async () => {
    restartService.mockResolvedValue(false)
    script.push(new Error('/secret/path exploded'))
    const r = await exec()
    expect(r.startsWith('error:')).toBe(true)
    expect(r).not.toContain('exploded')
    expect(r.endsWith('service: restart failed; ask the user to run /aha 语音 启动')).toBe(true)
  })

  it('收尾超时：给重启的信号被中止并记日志，中止后不再继续', async () => {
    let seen: AbortSignal | undefined
    restartService.mockImplementation((_s: unknown, o?: { signal?: AbortSignal }) => {
      seen = o?.signal
      return new Promise(() => undefined)
    })
    script.push('取消')
    const r = await exec()
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(true)
    expect(r).toContain('restart failed')
    expect(log.warn.mock.calls.some((c: string[]) => String(c[0]).includes('收尾超时'))).toBe(true)
  })

  it('重启失败：返回值附一句提示，结果本身不变', async () => {
    restartService.mockResolvedValue(false)
    script.push(...pickAndUse())
    const r = await exec()
    expect(r).toContain('voice designed and registered for 白狐')
    expect(r.endsWith('service: restart failed; ask the user to run /aha 语音 启动')).toBe(true)
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe(SAMPLE)
  })

  it('重启卡住：到时间上限就返回，并附重启失败的提示', async () => {
    restartService.mockImplementation(() => new Promise(() => undefined))
    script.push('取消')
    const r = await exec()
    expect(r).toContain('user cancelled')
    expect(r).toContain('restart failed')
    expect(await tmpEntries()).toEqual([])
  })

  it('没动过服务的出口（下载被取消、没有提问服务）：不卸载也不重启', async () => {
    modelDownloaded.mockImplementation(async (_d: string, id: string) => id !== VOICE_DESIGN_MODEL)
    script.push('取消')
    await exec()
    build({ getAsk: () => undefined })
    await exec()
    expect(unload).not.toHaveBeenCalled()
    expect(restartService).not.toHaveBeenCalled()
  })
})

describe('同一会话的卡片队列', () => {
  it('整个流程持有 gate：别的任务要等它结束', async () => {
    const order: string[] = []
    script.push(...pickAndUse())
    const p = exec()
    const other = gate.run('s', async () => { order.push('other') })
    await p
    await other
    expect(order).toEqual(['other'])
    expect(restartService).toHaveBeenCalledTimes(1)
    // 流程先于排在后面的任务做完：此时临时目录已清
    expect(await tmpEntries()).toEqual([])
  })

  it('流程进行中，排在后面的任务不会插进来', async () => {
    let release!: () => void
    ask.mockImplementationOnce(() => new Promise((res) => { release = () => res({ answers: [{ id: 'voice-design', selected: ['取消'] }] }) }))
    const p = exec()
    let ran = false
    const other = gate.run('s', async () => { ran = true })
    await vi.waitFor(() => expect(ask).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(ran).toBe(false)
    release()
    await p
    await other
    expect(ran).toBe(true)
  })
})

describe('返回值不泄露', () => {
  it('不带服务端原文、不带临时路径', async () => {
    synth.mockRejectedValue(new TtsError('bad-response', '/Users/x/secret.log boom'))
    const r = await exec()
    expect(r).not.toContain('boom')
    expect(r).not.toContain('secret')
    expect(r).not.toContain(tmpRoot)
  })
})
