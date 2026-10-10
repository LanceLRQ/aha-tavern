import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCharacter } from '../../../src/core/card'
import { appendRecord, createChat, readChatAutoRead, readChatMeta, setChatAutoRead } from '../../../src/core/chat'
import type { Player } from '../../../src/core/player'
import { PlayerError } from '../../../src/core/player'
import type { VoiceServiceSettings } from '../../../src/core/services'
import { loadTheme } from '../../../src/core/theme'
import { openTavern } from '../../../src/core/tavern'
import { createTavern } from '../../../src/core/tavern'
import { TtsError } from '../../../src/core/tts'
import type { HostAgent, Invocation } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import {
  AutoReader, parseSpeakArgs, speakHandler, Speaker, type SpeakEnv, type SpeakerDeps, type SpeakRequest,
} from '../../../src/shell/speak'
import type { ChatTarget } from '../../../src/shell/transcript'

const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

const PLAYER: Player = { command: 'afplay', args: (f) => [f] }
const SETTINGS: VoiceServiceSettings = {
  endpoint: 'http://127.0.0.1:8000', launch: 'none', model: 'm-1', modelsDir: '/models', read: 'lines',
  language: 'chinese', timeoutSeconds: 120, port: 8000, local: true,
}
const VOICE = { audio: '/ref/a.wav', text: '参考文字' }

// ---------- Speaker 的假依赖 ----------

interface Synth {
  text: string
  input: any
  opts: any
  done(bytes?: Uint8Array): void
  fail(e: unknown): void
}
interface Play {
  file: string
  existed: boolean
  aborted: boolean
  end(): void
  fail(e: unknown): void
}

function harness(opts: { auto?: boolean; honorAbort?: boolean; playIgnoresAbort?: boolean } = {}) {
  const auto = opts.auto ?? true
  const honor = opts.honorAbort ?? true
  const disk = new Map<string, Uint8Array>()
  const synths: Synth[] = []
  const plays: Play[] = []
  const endpoints: string[] = []
  let seq = 0
  const client = {
    synthesize: vi.fn(
      (input: any, o: any) =>
        new Promise<{ bytes: Uint8Array; format: 'wav' }>((resolve, reject) => {
          const call: Synth = {
            text: input.text, input, opts: o,
            done: (bytes = new Uint8Array([1, 2, 3])) => resolve({ bytes, format: 'wav' }),
            fail: reject,
          }
          synths.push(call)
          if (honor) o.signal?.addEventListener('abort', () => reject(new TtsError('cancelled')), { once: true })
          if (auto) call.done()
        }),
    ),
  }
  const log = { debug: vi.fn(), warn: vi.fn() }
  const deps: SpeakerDeps = {
    createClient: (endpoint) => {
      endpoints.push(endpoint)
      return client
    },
    play: (_player, file, o) =>
      new Promise<void>((resolve, reject) => {
        const p: Play = { file, existed: disk.has(file), aborted: false, end: resolve, fail: reject }
        plays.push(p)
        o.signal?.addEventListener('abort', () => { p.aborted = true; if (!opts.playIgnoresAbort) reject(new PlayerError('cancelled')) }, { once: true })
        if (auto) p.end()
      }),
    tempFile: () => `/tmp/aha-${++seq}.wav`,
    writeFile: async (f, b) => { disk.set(f, b) },
    removeFile: async (f) => { disk.delete(f) },
    now: () => 1000,
    settleLimitMs: 50,
    log,
  }
  return { deps, disk, synths, plays, endpoints, client, log }
}

const req = (sentences: string[], over: Partial<SpeakRequest> = {}): SpeakRequest => ({
  sentences, voice: VOICE, settings: SETTINGS, player: PLAYER, owner: 's1', ...over,
})

describe('Speaker', () => {
  it('按顺序播放，合成最多领先播放一句，播完即删临时文件', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['一一一', '二二二', '三三三']))
    expect(sp.owner()).toBe('s1')
    await settle()
    expect(h.synths.map((s) => s.text)).toEqual(['一一一'])
    h.synths[0]!.done()
    await settle()
    expect(h.plays).toHaveLength(1)
    expect(h.plays[0]!.existed).toBe(true)
    expect(h.synths.map((s) => s.text)).toEqual(['一一一', '二二二'])
    h.synths[1]!.done()
    await settle()
    expect(h.synths).toHaveLength(2) // 第一句还在播，第三句不抢跑
    expect(h.plays).toHaveLength(1)
    h.plays[0]!.end()
    await settle()
    expect(h.disk.has(h.plays[0]!.file)).toBe(false)
    expect(h.plays).toHaveLength(2)
    expect(h.synths).toHaveLength(3)
    h.synths[2]!.done()
    h.plays[1]!.end()
    await settle()
    expect(h.plays).toHaveLength(3)
    h.plays[2]!.end()
    await settle()
    expect(h.disk.size).toBe(0)
    expect(sp.owner()).toBeNull()
    expect(sp.lastError()).toBeNull()
    expect(h.plays.map((p) => p.file)).toEqual(['/tmp/aha-1.wav', '/tmp/aha-2.wav', '/tmp/aha-3.wav'])
  })

  it('合成按克隆参数发出，超时取配置的秒数', async () => {
    const h = harness()
    const sp = new Speaker(h.deps)
    sp.speak(req(['你好呀朋友']))
    await settle()
    expect(h.endpoints).toEqual(['http://127.0.0.1:8000'])
    expect(h.synths[0]!.input).toEqual({
      kind: 'clone', model: 'm-1', text: '你好呀朋友', refAudio: '/ref/a.wav', refText: '参考文字', language: 'chinese',
    })
    expect(h.synths[0]!.opts.timeoutMs).toBe(120_000)
  })

  it('空句子列表什么也不做，也不顶掉正在念的', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['一一一']))
    sp.speak(req([], { owner: 's2' }))
    expect(sp.owner()).toBe('s1')
    await sp.stop()
  })

  it('新的朗读顶掉正在念的：结束播放进程，清掉旧的临时文件', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲', '乙乙乙']))
    await settle()
    h.synths[0]!.done()
    await settle()
    const first = h.plays[0]!
    sp.speak(req(['丙丙丙'], { owner: 's2' }))
    await settle()
    expect(first.aborted).toBe(true)
    expect(h.disk.has(first.file)).toBe(false)
    expect(sp.owner()).toBe('s2')
    const next = h.synths.find((s) => s.text === '丙丙丙')!
    next.done()
    await settle()
    expect(h.plays).toHaveLength(2)
    expect(h.plays[1]!.existed).toBe(true)
    h.plays[1]!.end()
    await settle()
    expect(h.disk.size).toBe(0)
    expect(sp.lastError()).toBeNull()
  })

  it('stop：取消合成、结束播放、清掉全部临时文件，不记错误', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲', '乙乙乙', '丙丙丙']))
    await settle()
    h.synths[0]!.done()
    await settle() // 第一句在播，第二句在合成
    h.synths[1]!.done()
    await settle() // 第二句已写盘等待
    expect(h.disk.size).toBe(2)
    await sp.stop()
    expect(h.plays[0]!.aborted).toBe(true)
    expect(h.disk.size).toBe(0)
    expect(sp.owner()).toBeNull()
    expect(sp.lastError()).toBeNull()
    expect(h.synths).toHaveLength(2)
  })

  it('stop 时合成还没回来：请求被取消，迟到的字节也不落盘', async () => {
    const h = harness({ auto: false, honorAbort: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    const stopped = sp.stop()
    expect(h.synths[0]!.opts.signal.aborted).toBe(true)
    h.synths[0]!.done()
    await stopped
    await settle()
    expect(h.disk.size).toBe(0)
    expect(h.plays).toHaveLength(0)
  })

  it('没在念时 stop 什么也不做', async () => {
    const sp = new Speaker(harness().deps)
    await expect(sp.stop()).resolves.toBeUndefined()
  })

  it('某一句合成失败：整段停下，剩下的不再合成，记下原因，文件清干净', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲', '乙乙乙', '丙丙丙']))
    await settle()
    h.synths[0]!.done()
    await settle()
    h.synths[1]!.fail(new TtsError('timeout', 'slow'))
    h.plays[0]!.end()
    await settle()
    expect(h.synths).toHaveLength(2)
    expect(h.plays).toHaveLength(1)
    expect(h.disk.size).toBe(0)
    expect(sp.owner()).toBeNull()
    expect(sp.lastError()).toEqual({ kind: 'timeout', at: 1000 })
    expect(h.log.warn).toHaveBeenCalled()
  })

  it('某一句播放失败：整段停下，正在合成的被取消，文件清干净', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲', '乙乙乙', '丙丙丙']))
    await settle()
    h.synths[0]!.done()
    await settle()
    h.synths[1]!.done()
    await settle()
    h.plays[0]!.fail(new PlayerError('play-failed', 'exit code=1'))
    await settle()
    expect(h.synths).toHaveLength(2)
    expect(h.plays).toHaveLength(1)
    expect(h.disk.size).toBe(0)
    expect(sp.lastError()).toEqual({ kind: 'play-failed', at: 1000 })
  })

  it('非 TtsError / PlayerError 的异常记为 other；之后整段成功念完会清掉最近错误', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[0]!.fail(new Error('boom'))
    await settle()
    expect(sp.lastError()).toEqual({ kind: 'other', at: 1000 })
    sp.speak(req(['乙乙乙']))
    await settle()
    h.synths[1]!.done()
    await settle()
    h.plays[0]!.end()
    await settle()
    expect(sp.lastError()).toBeNull()
  })

  it('append：同一来源的追加到队尾，不打断正在念的', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[0]!.done()
    await settle()
    sp.append(req(['乙乙乙']))
    await settle()
    expect(h.plays[0]!.aborted).toBe(false)
    expect(h.synths.map((s) => s.text)).toEqual(['甲甲甲', '乙乙乙'])
    h.synths[1]!.done()
    h.plays[0]!.end()
    await settle()
    expect(h.plays).toHaveLength(2)
    h.plays[1]!.end()
    await settle()
    expect(sp.owner()).toBeNull()
  })

  it('append：队列已空但最后一句还在播时追加，也能接着念', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[0]!.done()
    await settle()
    sp.append(req(['乙乙乙']))
    h.plays[0]!.end()
    await settle()
    expect(h.synths.map((s) => s.text)).toEqual(['甲甲甲', '乙乙乙'])
  })

  it('append：别的来源或没在念时，等同于 speak', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.append(req(['甲甲甲']))
    expect(sp.owner()).toBe('s1')
    await settle()
    sp.append(req(['乙乙乙'], { owner: 's2' }))
    expect(sp.owner()).toBe('s2')
    await settle()
    expect(h.synths[0]!.opts.signal.aborted).toBe(true)
    await sp.stop()
  })

  it('换段：新段的第一次播放等旧播放进程真正结束之后', async () => {
    const h = harness({ auto: false, playIgnoresAbort: true })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[0]!.done()
    await settle()
    sp.speak(req(['乙乙乙'], { owner: 's2' }))
    await settle()
    expect(h.plays[0]!.aborted).toBe(true)
    h.synths[1]!.done() // 合成可以先完成
    await settle()
    expect(h.plays).toHaveLength(1) // 旧进程还没结束，新段不出声
    h.plays[0]!.end()
    await settle()
    expect(h.plays).toHaveLength(2)
    h.plays[1]!.end()
    await settle()
    expect(h.disk.size).toBe(0)
  })

  it('换段：旧段收尾卡住时，最多等到上限就开始播', async () => {
    const h = harness({ auto: false, playIgnoresAbort: true })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[0]!.done()
    await settle()
    sp.speak(req(['乙乙乙'], { owner: 's2' }))
    await settle()
    h.synths[1]!.done()
    await new Promise((r) => setTimeout(r, 120))
    expect(h.plays).toHaveLength(2)
    h.plays[0]!.end()
    h.plays[1]!.end()
    await settle()
  })

  it('停下后马上换段，同样等上一段收尾', async () => {
    const h = harness({ auto: false, playIgnoresAbort: true })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[0]!.done()
    await settle()
    void sp.stop()
    sp.speak(req(['乙乙乙']))
    await settle()
    h.synths[1]!.done()
    await settle()
    expect(h.plays).toHaveLength(1)
    h.plays[0]!.end()
    await settle()
    expect(h.plays).toHaveLength(2)
    h.plays[1]!.end()
    await settle()
  })

  it('被取消的一段即使播放进程正常结束，也不清掉最近错误', async () => {
    const h = harness({ auto: false, playIgnoresAbort: true })
    const sp = new Speaker(h.deps)
    sp.speak(req(['丁丁丁']))
    await settle()
    h.synths[0]!.fail(new TtsError('timeout'))
    await settle()
    expect(sp.lastError()?.kind).toBe('timeout')
    sp.speak(req(['甲甲甲']))
    await settle()
    h.synths[1]!.done()
    await settle()
    const stopped = sp.stop()
    h.plays[0]!.end()
    await stopped
    expect(sp.lastError()?.kind).toBe('timeout')
  })

  it('stopIfOwner：只停属于该来源的', async () => {
    const h = harness({ auto: false })
    const sp = new Speaker(h.deps)
    sp.speak(req(['甲甲甲'], { owner: 's2' }))
    await sp.stopIfOwner('s1')
    expect(sp.owner()).toBe('s2')
    await sp.stopIfOwner('s2')
    expect(sp.owner()).toBeNull()
  })
})

// ---------- 参数解析 ----------

describe('parseSpeakArgs', () => {
  it('开关词（英文不分大小写）', () => {
    for (const [w, kind] of [['开', 'on'], ['关', 'off'], ['停', 'stop'], ['on', 'on'], ['OFF', 'off'], ['Stop', 'stop']] as const) {
      expect(parseSpeakArgs(w)).toEqual({ kind })
    }
  })
  it('其余都是要念的文本，空参数为空文本', () => {
    expect(parseSpeakArgs('')).toEqual({ kind: 'text', text: '' })
    expect(parseSpeakArgs('开始吧')).toEqual({ kind: 'text', text: '开始吧' })
    expect(parseSpeakArgs('stop it')).toEqual({ kind: 'text', text: 'stop it' })
  })
})

// ---------- 命令与自动朗读 ----------

const REPLY = '今天的天气真好啊，出去走走吧。'
const IMAGE_ONLY = '![画面](</tmp/a b.png>)'

let dir: string
let tavernDir: string

interface World {
  h: ReturnType<typeof harness>
  speaker: Speaker
  env: SpeakEnv & { probe: ReturnType<typeof vi.fn>; findPlayer: ReturnType<typeof vi.fn>; isLaunching: ReturnType<typeof vi.fn> }
  auto: AutoReader
  handler: ReturnType<typeof speakHandler>
  agent: HostAgent & { steer: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> }
  steer: ReturnType<typeof vi.fn>
  target: ChatTarget
  chatId: string
  charDir: string
  log: Runtime['log']
  invoke(args: string, over?: { readonly?: boolean }): Promise<{ kind: string; text?: string }>
  configure(result: any): void
}

async function world(opts: { voice?: boolean; auto?: boolean } = {}): Promise<World> {
  const h = harness({ auto: opts.auto ?? false })
  const speaker = new Speaker(h.deps)
  const { theme } = await loadTheme({ name: 'plain', builtinDir: path.resolve(__dirname, '../../../themes') })
  const card = (await saveCharacter(tavernDir, { name: '白狐', persona: 'p', greeting: 'g' })).card
  const charDir = path.join(tavernDir, 'characters', '白狐')
  if (opts.voice !== false) {
    await fs.writeFile(path.join(charDir, 'voice_ref.wav'), Buffer.from([1, 2, 3, 4]))
    await fs.writeFile(path.join(charDir, 'voice_ref.txt'), '参考文字')
  }
  const chat = await createChat(tavernDir, { kind: 'chat', name: '白狐', participants: [card.id], sessionId: 's1', now: new Date() })
  const target: ChatTarget = { tavernDir, chatId: chat.id, characterId: card.id }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let voiceResult: any = { configured: true, settings: SETTINGS, problems: [] }
  const env = {
    rt: { log, voiceSettings: async () => voiceResult } as Pick<Runtime, 'log' | 'voiceSettings'>,
    speaker,
    probe: vi.fn(async () => undefined),
    findPlayer: vi.fn(async () => PLAYER),
    isLaunching: vi.fn(() => false),
  }
  const agent = { id: 's1', ctx: {}, steer: vi.fn(), inject: vi.fn() }
  const auto = new AutoReader(env, async () => target)
  const handler = speakHandler(env, auto)
  const steer = vi.fn()
  return {
    h, speaker, env, auto, handler, agent, steer, target, chatId: chat.id, charDir, log,
    configure: (r) => { voiceResult = r },
    async invoke(args, over = {}) {
      const info = await openTavern(tavernDir)
      const tavern = over.readonly ? { ...info, access: 'readonly' as const } : info
      const inv = {
        agent, services: {}, rt: { log } as unknown as Runtime, theme, steer, args, label: '/aha 朗读',
        context: {
          mode: 'chat', cwd: tavernDir, sessionId: 's1', tavern, state: 'chatting', outsideReason: null,
          record: { mode: 'chat', state: 'chatting', chatId: chat.id, characterId: card.id, updated: '' },
        },
      } as unknown as Invocation
      return handler(inv)
    },
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-speak-'))
  tavernDir = dir
  await createTavern(dir, { name: '甲', id: 't_1' })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const user = (chatId: string, text: string) => appendRecord(tavernDir, chatId, { type: 'user', speaker: 'user', text })
const char = (w: World, text: string) => appendRecord(tavernDir, w.chatId, { type: 'character', speaker: w.target.characterId, text })

describe('朗读命令：不能朗读的情况', () => {
  it('没配置语音：指向文档，不探测', async () => {
    const w = await world()
    w.configure({ configured: false, problems: [] })
    const r = await w.invoke('你好呀朋友')
    expect(r.text).toBe('还没有配置语音服务，配置方法见 docs/voice-setup.md。')
    expect(w.env.probe).not.toHaveBeenCalled()
    expect(w.speaker.owner()).toBeNull()
  })
  it('地址带用户名密码：不发请求', async () => {
    const w = await world()
    w.configure({ configured: true, settings: { ...SETTINGS, endpoint: 'http://u:p@127.0.0.1:8000' }, problems: [] })
    const r = await w.invoke('你好呀朋友')
    expect(r.text).toBe('语音服务地址里不能带用户名或密码，请去掉后再试。')
    expect(w.env.probe).not.toHaveBeenCalled()
  })
  it('服务连不上：提示启动命令；正在启动时说还在启动', async () => {
    const w = await world()
    w.env.probe.mockRejectedValue(new TtsError('unreachable'))
    expect((await w.invoke('你好呀朋友')).text).toBe('语音服务连不上，可以用 /aha 语音 启动。')
    expect(w.env.probe).toHaveBeenCalledWith(SETTINGS.endpoint)
    w.env.isLaunching.mockReturnValue(true)
    expect((await w.invoke('你好呀朋友')).text).toBe('语音服务还在启动中，稍后再试。')
    expect(w.env.isLaunching).toHaveBeenCalledWith('/models')
    expect(w.speaker.owner()).toBeNull()
  })
  it('角色没有音色：提示到筹备模式配声音', async () => {
    const w = await world({ voice: false })
    const r = await w.invoke('你好呀朋友')
    expect(r.text).toContain('「酒馆:筹备」')
    expect(r.text).toContain('声音')
    expect(w.speaker.owner()).toBeNull()
  })
  it('找不到播放器：说明', async () => {
    const w = await world()
    w.env.findPlayer.mockResolvedValue(null)
    const r = await w.invoke('你好呀朋友')
    expect(r.text).toContain('播放器')
    expect(w.speaker.owner()).toBeNull()
  })
  it('取字后没有可念的字：说明', async () => {
    const w = await world()
    const r = await w.invoke('（笑了笑）')
    expect(r.text).toBe('没有可念的字。')
    expect(w.speaker.owner()).toBeNull()
  })
  it('检查按顺序：连不上排在没有音色之前', async () => {
    const w = await world({ voice: false })
    w.env.probe.mockRejectedValue(new Error('x'))
    expect((await w.invoke('你好呀朋友')).text).toContain('连不上')
  })
})

describe('朗读命令：开始朗读', () => {
  it('空参数念最近一条角色回复，跳过只有图片行的，立刻回执不等合成', async () => {
    const w = await world()
    await user(w.chatId, '我来了')
    await char(w, REPLY)
    await user(w.chatId, '再来一句')
    await char(w, IMAGE_ONLY)
    const r = await w.invoke('')
    expect(r.kind).toBe('success')
    expect(r.text).toMatch(/^开始朗读，共 \d+ 句。$/)
    expect(w.speaker.owner()).toBe('s1')
    await settle()
    expect(w.h.synths.map((s) => s.text).join('')).toBe(REPLY)
  })
  it('没有任何角色的话可念：说明', async () => {
    const w = await world()
    await user(w.chatId, '我来了')
    expect((await w.invoke('')).text).toBe('这场聊天里还没有角色的话可念。')
    expect(w.speaker.owner()).toBeNull()
  })
  it('念给定文本，按配置的取字方式去掉动作描写；句数写进回执', async () => {
    const w = await world()
    const r = await w.invoke('（笑）今天的天气真好啊，出去走走吧。')
    expect(r.text).toBe('开始朗读，共 1 句。')
    await settle()
    expect(w.h.synths.map((s) => s.text)).toEqual(['今天的天气真好啊，出去走走吧。'])
  })
  it('文本超过上限：回执里说明超出的部分没有念', async () => {
    const w = await world()
    const r = await w.invoke('今天天气真好啊，我们出去走走。'.repeat(100))
    expect(r.text).toMatch(/^开始朗读，共 \d+ 句，超出的部分没有念。$/)
  })
  it('又来一条朗读：顶掉正在念的', async () => {
    const w = await world()
    await w.invoke('第一句话说得比较长一点吧。')
    await settle()
    const first = w.h.synths[0]!
    await w.invoke('第二句话也说得长一点吧。')
    expect(first.opts.signal.aborted).toBe(true)
  })
  it('全过程不调用模型：不 steer 也不 inject', async () => {
    const w = await world()
    await w.invoke('你好呀朋友')
    await w.invoke('开')
    await w.invoke('停')
    await w.invoke('关')
    expect(w.steer).not.toHaveBeenCalled()
    expect(w.agent.steer).not.toHaveBeenCalled()
    expect(w.agent.inject).not.toHaveBeenCalled()
  })
})

describe('朗读命令：开 / 关 / 停', () => {
  it('开：写进 meta，能念时回执简短', async () => {
    const w = await world()
    const r = await w.invoke('开')
    expect(r.text).toBe('自动朗读已打开。')
    expect(await readChatAutoRead(tavernDir, w.chatId)).toBe(true)
    expect(w.speaker.owner()).toBeNull() // 只检查，不开始朗读
  })
  it('开：现在念不了时说明原因，开关照样打开', async () => {
    const w = await world({ voice: false })
    const r = await w.invoke('ON')
    expect(r.text).toMatch(/^自动朗读已打开；现在还念不了：.+/)
    expect(r.text).toContain('声音')
    expect(await readChatAutoRead(tavernDir, w.chatId)).toBe(true)
    w.configure({ configured: false, problems: [] })
    expect((await w.invoke('开')).text).toBe('自动朗读已打开；现在还念不了：还没有配置语音服务，配置方法见 docs/voice-setup.md。')
  })
  it('关：写 false 并停下正在念的', async () => {
    const w = await world()
    await setChatAutoRead(tavernDir, w.chatId, true)
    await w.invoke('你好呀朋友')
    expect(w.speaker.owner()).toBe('s1')
    const r = await w.invoke('关')
    expect(r.text).toBe('自动朗读已关闭。')
    expect(await readChatAutoRead(tavernDir, w.chatId)).toBe(false)
    expect(w.speaker.owner()).toBeNull()
  })
  it('停：停下正在念的；没在念也是同一句', async () => {
    const w = await world()
    await w.invoke('你好呀朋友')
    const a = await w.invoke('停')
    expect(w.speaker.owner()).toBeNull()
    const b = await w.invoke('stop')
    expect(a.text).toBe('已停止朗读。')
    expect(b.text).toBe(a.text)
  })
  it('停：没配置语音时也能用', async () => {
    const w = await world()
    w.configure({ configured: false, problems: [] })
    expect((await w.invoke('停')).text).toBe('已停止朗读。')
  })
  it('只读酒馆：不能改开关，朗读与停本身可以', async () => {
    const w = await world()
    const on = await w.invoke('开', { readonly: true })
    const off = await w.invoke('关', { readonly: true })
    expect(on.text).toContain('不能改自动朗读')
    expect(off.text).toBe(on.text)
    expect(await readChatAutoRead(tavernDir, w.chatId)).toBe(false)
    expect((await w.invoke('你好呀朋友', { readonly: true })).text).toBe('开始朗读，共 1 句。')
    expect((await w.invoke('停', { readonly: true })).text).toBe('已停止朗读。')
    expect((await readChatMeta(tavernDir, w.chatId)).autoRead).toBeUndefined()
  })
})

// ---------- 自动朗读 ----------

const agentOf = (w: World): HostAgent => w.agent

describe('自动朗读', () => {
  it('开着才念', async () => {
    const w = await world({ auto: true })
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    expect(w.h.synths).toHaveLength(0)

    await setChatAutoRead(tavernDir, w.chatId, true)
    w.auto.setFlag('s1', true)
    w.auto.onStep('s1', undefined, 1)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 2)
    await settle()
    expect(w.h.synths.map((s) => s.text).join('')).toBe(REPLY)
    expect(w.speaker.owner()).toBeNull() // 念完了
  })

  it('开关命令更新缓存：先读到关，再用命令打开，下一轮就念', async () => {
    const w = await world({ auto: true })
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 1)
    expect(w.h.synths).toHaveLength(0)
    await w.invoke('开')
    w.auto.onStep('s1', undefined, 1)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 2)
    await settle()
    expect(w.h.synths.length).toBeGreaterThan(0)
  })

  it('被停止的轮次不念，残留的回复在下一次见到用户消息时清掉', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', '被打断的那一轮说了很长的一段话。')
    // 该轮没有 turn-stopping；用户发来新消息，开始下一轮
    w.auto.onStep('s1', undefined, 1)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 2)
    await settle()
    expect(w.h.synths.map((s) => s.text).join('')).toBe(REPLY)
  })

  it('一轮里的多段回复按顺序合并念', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', '我先说第一段话，请你听好了。')
    w.auto.onReply('s1', '然后是第二段话，你听明白了吗。')
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    expect(w.h.synths.map((s) => s.text).join('')).toBe('我先说第一段话，请你听好了。然后是第二段话，你听明白了吗。')
  })

  it('与补发图片共存：同一轮第二次收尾只念新提交的一段，且追加不打断', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 7)
    await settle()
    const firstCalls = w.h.synths.length
    expect(firstCalls).toBe(1)
    w.h.synths[0]!.done()
    await settle() // 第一句在播
    // 补发：先是只有图片行的回复，同一轮再收尾一次
    w.auto.onReply('s1', IMAGE_ONLY)
    await w.auto.onTurnStopping(agentOf(w), 7)
    await settle()
    expect(w.h.synths).toHaveLength(1)
    // 又有一段带文字的回复：追加到队尾，正在念的不被打断
    w.auto.onReply('s1', '补充一句话，请你记在心里。')
    await w.auto.onTurnStopping(agentOf(w), 7)
    await settle()
    expect(w.h.plays[0]!.aborted).toBe(false)
    expect(w.h.synths.map((s) => s.text)).toEqual([REPLY, '补充一句话，请你记在心里。'])
  })

  it('下一轮的收尾顶掉上一轮还没念完的', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    w.auto.onReply('s1', '这是下一轮说的话，请你听好。')
    await w.auto.onTurnStopping(agentOf(w), 2)
    await settle()
    expect(w.h.synths[0]!.opts.signal.aborted).toBe(true)
    expect(w.h.synths.map((s) => s.text)).toEqual([REPLY, '这是下一轮说的话，请你听好。'])
  })

  it('拿不到轮次号时按用户消息划分"同一轮"', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onStep('s1', undefined, 1)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), undefined)
    await settle()
    w.h.synths[0]!.done()
    await settle()
    w.auto.onReply('s1', '补充一句话，请你记在心里。')
    await w.auto.onTurnStopping(agentOf(w), undefined)
    await settle()
    expect(w.h.plays[0]!.aborted).toBe(false)
  })

  it('同一轮两次收尾遇到慢检查：按提交顺序念，第一段在前', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    let release: () => void = () => undefined
    w.env.probe.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    w.auto.onReply('s1', '这是先提交的第一段话，慢慢说。')
    const a = w.auto.onTurnStopping(agentOf(w), 3)
    await settle()
    w.auto.onReply('s1', '这是补发后的第二段话，接着说。')
    const b = w.auto.onTurnStopping(agentOf(w), 3)
    await settle()
    expect(w.h.synths).toHaveLength(0)
    release()
    await Promise.all([a, b])
    await settle()
    expect(w.h.synths.map((x) => x.text)).toEqual(['这是先提交的第一段话，慢慢说。', '这是补发后的第二段话，接着说。'])
  })

  it('轮次变了就清掉上一轮残留的回复，哪怕不是用户消息触发的新一轮', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onStep('s1', 1, 1)
    w.auto.onReply('s1', '被停止的那一轮说了半截话。')
    w.auto.onStep('s1', 1, 0) // 同一轮的后续步骤不清
    w.auto.onStep('s1', 2, 0) // 新一轮，没有新的用户消息
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 2)
    await settle()
    expect(w.h.synths.map((s) => s.text).join('')).toBe(REPLY)
  })

  it('同一轮的后续步骤不清掉已提交的回复', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onStep('s1', 1, 1)
    w.auto.onReply('s1', REPLY)
    w.auto.onStep('s1', 1, 0)
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    expect(w.h.synths.map((s) => s.text).join('')).toBe(REPLY)
  })

  it('只有图片行的回复不念', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', IMAGE_ONLY)
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    expect(w.h.synths).toHaveLength(0)
    expect(w.env.probe).not.toHaveBeenCalled()
  })

  it('不能朗读时安静跳过：每个会话每种原因只记一条 debug 日志', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.env.probe.mockRejectedValue(new TtsError('unreachable'))
    const skipLogs = () => (w.log.debug as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('自动朗读'))
    for (let i = 1; i <= 3; i++) {
      w.auto.onStep('s1', undefined, 1)
      w.auto.onReply('s1', REPLY)
      await w.auto.onTurnStopping(agentOf(w), i)
    }
    expect(skipLogs()).toHaveLength(1)
    w.env.probe.mockResolvedValue(undefined)
    w.env.findPlayer.mockResolvedValue(null)
    for (let i = 4; i <= 5; i++) {
      w.auto.onStep('s1', undefined, 1)
      w.auto.onReply('s1', REPLY)
      await w.auto.onTurnStopping(agentOf(w), i)
    }
    expect(skipLogs()).toHaveLength(2)
    expect(w.h.synths).toHaveLength(0)
    expect(w.log.warn).not.toHaveBeenCalled()
    expect(w.steer).not.toHaveBeenCalled()
    expect(w.agent.steer).not.toHaveBeenCalled()
    expect(w.agent.inject).not.toHaveBeenCalled()
  })

  it('用户发来新消息：停下属于这个会话的朗读，别的会话的不管', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    w.h.synths[0]!.done()
    await settle()
    w.auto.onStep('s2', undefined, 1)
    expect(w.speaker.owner()).toBe('s1')
    w.auto.onStep('s1', undefined, 0) // 没有新的用户消息
    expect(w.speaker.owner()).toBe('s1')
    w.auto.onStep('s1', undefined, 1)
    await settle()
    expect(w.h.plays[0]!.aborted).toBe(true)
    expect(w.speaker.owner()).toBeNull()
  })

  it('等检查期间用户又发了消息：这一轮的回复作废，不开口', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    let release: () => void = () => undefined
    w.env.probe.mockImplementation(() => new Promise<void>((r) => { release = r }))
    w.auto.onReply('s1', REPLY)
    const done = w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    w.auto.onStep('s1', undefined, 1)
    release()
    await done
    await settle()
    expect(w.h.synths).toHaveLength(0)
  })

  it('会话销毁：清掉状态，正在念的属于它就停', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', REPLY)
    await w.auto.onTurnStopping(agentOf(w), 1)
    await settle()
    w.auto.onReply('s1', '残留的回复说了好长一段话。')
    w.auto.forget('s1')
    await settle()
    expect(w.speaker.owner()).toBeNull()
    // 销毁后收尾不会念残留的
    await w.auto.onTurnStopping(agentOf(w), 2)
    await settle()
    expect(w.h.synths).toHaveLength(1)
  })

  it('取不到聊天目标（不在聊天中）时不念；出错只记 warn', async () => {
    const w = await world({ auto: true })
    const none = new AutoReader(w.env, async () => null)
    none.onReply('s1', REPLY)
    await none.onTurnStopping(agentOf(w), 1)
    expect(w.h.synths).toHaveLength(0)
    const boom = new AutoReader(w.env, async () => { throw new Error('boom') })
    boom.onReply('s1', REPLY)
    await expect(boom.onTurnStopping(agentOf(w), 1)).resolves.toBeUndefined()
    expect(w.log.warn).toHaveBeenCalled()
  })
})
