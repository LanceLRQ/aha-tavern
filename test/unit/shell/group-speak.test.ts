// 群聊语音（#r7ht、二期规格 §13.1）的单元测试：旁白音色、按段分音色合成依次播放、手动朗读与自动朗读。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { saveCharacter, type CharacterCard } from '../../../src/core/card'
import { appendRecord, createChat, readChatAutoRead, setChatAutoRead } from '../../../src/core/chat'
import type { Player } from '../../../src/core/player'
import type { VoiceServiceSettings } from '../../../src/core/services'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { createTavern, openTavern } from '../../../src/core/tavern'
import { TtsError } from '../../../src/core/tts'
import type { GroupLine } from '../../../src/core/group-log'
import type { HostAgent, Invocation } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import {
  GroupAutoReader, groupSpeakHandler, latestRoundLines, lineVoices, narratorVoice, planGroupSpeech,
  type GroupSpeakEnv,
} from '../../../src/shell/group-speak'
import { BUILTIN_VOICE_TEXT } from '../../../src/shell/voice'
import { Speaker, type SpeakerDeps } from '../../../src/shell/speak'

const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

const PLAYER: Player = { command: 'afplay', args: (f) => [f] }
const SETTINGS: VoiceServiceSettings = {
  endpoint: 'http://127.0.0.1:8000', launch: 'none', model: 'm-1', modelsDir: '/models', read: 'lines',
  language: 'chinese', timeoutSeconds: 120, pauseSeconds: 2, pauseMinSeconds: 1, pauseMaxSeconds: 4, port: 8000, local: true,
}

// ---------- Speaker 的假依赖（与 speak.test.ts 同一套做法） ----------

function harness(opts: { auto?: boolean } = {}) {
  const auto = opts.auto ?? false
  const disk = new Map<string, Uint8Array>()
  const synths: Array<{ text: string; input: any; opts: any; done(bytes?: Uint8Array): void }> = []
  const plays: Array<{ file: string; end(): void }> = []
  const sleeps: Array<{ ms: number }> = []
  let seq = 0
  const client = {
    synthesize: vi.fn(
      (input: any, o: any) =>
        new Promise<{ bytes: Uint8Array; format: 'wav' }>((resolve, reject) => {
          const call = { text: input.text, input, opts: o, done: (bytes = new Uint8Array([1, 2, 3])) => resolve({ bytes, format: 'wav' as const }) }
          synths.push(call)
          o.signal?.addEventListener('abort', () => reject(new TtsError('cancelled')), { once: true })
          if (auto) call.done()
        }),
    ),
  }
  const log = { debug: vi.fn(), warn: vi.fn() }
  const deps: SpeakerDeps = {
    createClient: () => client,
    play: (_player, file) =>
      new Promise<void>((resolve) => {
        const p = { file, end: resolve }
        plays.push(p)
        if (auto) p.end()
      }),
    sleep: (ms) => {
      sleeps.push({ ms })
      return Promise.resolve()
    },
    tempFile: () => `/tmp/aha-group-${++seq}.wav`,
    writeFile: async (f, b) => { disk.set(f, b) },
    removeFile: async (f) => { disk.delete(f) },
    now: () => 1000,
    settleLimitMs: 50,
    log,
  }
  return { deps, disk, synths, plays, sleeps, client, log }
}

// ---------- 场地：一间酒馆、三个角色（墨鸦没有音色）、旁白音色目录、一场群聊 ----------

let dir: string
let narrDir: string
let chatId: string
let fox: CharacterCard
let shan: CharacterCard
let crow: CharacterCard
let theme: Theme

/** 各角色与旁白的音色（合成请求里应出现的参考录音路径与文字）。 */
let NARR: { audio: string; text: string }
let FOX: { audio: string; text: string }
let SHAN: { audio: string; text: string }

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-gspeak-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
  const withVoice = async (name: string, text: string): Promise<CharacterCard> => {
    const card = (await saveCharacter(dir, { name, persona: 'p', greeting: 'g' })).card
    const charDir = path.join(dir, 'characters', name)
    await fs.writeFile(path.join(charDir, 'voice_ref.wav'), Buffer.from([1, 2, 3, 4]))
    await fs.writeFile(path.join(charDir, 'voice_ref.txt'), text)
    return card
  }
  fox = await withVoice('白狐', '白狐的参考文字')
  shan = await withVoice('青衫', '青衫的参考文字')
  crow = (await saveCharacter(dir, { name: '墨鸦', persona: 'p', greeting: 'g' })).card
  narrDir = path.join(dir, '旁白音色')
  await fs.mkdir(narrDir, { recursive: true })
  await fs.writeFile(path.join(narrDir, 'voice_ref.wav'), Buffer.from([5, 6, 7, 8]))
  await fs.writeFile(path.join(narrDir, 'voice_ref.txt'), '旁白的参考文字')
  NARR = { audio: path.join(narrDir, 'voice_ref.wav'), text: '旁白的参考文字' }
  FOX = { audio: path.join(dir, 'characters', '白狐', 'voice_ref.wav'), text: '白狐的参考文字' }
  SHAN = { audio: path.join(dir, 'characters', '青衫', 'voice_ref.wav'), text: '青衫的参考文字' }
  const chat = await createChat(dir, { kind: 'group', name: '群聊', participants: [fox.id, shan.id, crow.id], sessionId: 's1', now: new Date() })
  chatId = chat.id
  theme = (await loadTheme({ name: 'plain', builtinDir: path.resolve(__dirname, '../../../themes') })).theme
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const narr = (text: string) => appendRecord(dir, chatId, { type: 'narrator', text })
const said = (id: string, text: string) => appendRecord(dir, chatId, { type: 'character', speaker: id, text })
const userMsg = (text: string) => appendRecord(dir, chatId, { type: 'user', speaker: '我', text })

interface World {
  h: ReturnType<typeof harness>
  speaker: Speaker
  env: GroupSpeakEnv & { probe: ReturnType<typeof vi.fn>; findPlayer: ReturnType<typeof vi.fn>; isLaunching: ReturnType<typeof vi.fn> }
  auto: GroupAutoReader
  handler: ReturnType<typeof groupSpeakHandler>
  agent: HostAgent
  steer: ReturnType<typeof vi.fn>
  log: Runtime['log']
  invoke(args: string, over?: { readonly?: boolean }): Promise<{ kind: string; text?: string }>
  configure(result: unknown): void
}

async function world(opts: { auto?: boolean; narratorDir?: string } = {}): Promise<World> {
  const h = harness({ auto: opts.auto ?? false })
  const speaker = new Speaker(h.deps)
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let voiceResult: unknown = { configured: true, settings: SETTINGS, problems: [] }
  const env = {
    rt: {
      log,
      voiceSettings: async () => voiceResult,
      config: { ...DEFAULTS, narratorVoiceDir: opts.narratorDir ?? narrDir },
      builtinAssetsDir: path.join(dir, 'assets'),
    },
    speaker,
    probe: vi.fn(async () => undefined),
    findPlayer: vi.fn(async () => PLAYER),
    isLaunching: vi.fn(() => false),
  } as GroupSpeakEnv & { probe: ReturnType<typeof vi.fn>; findPlayer: ReturnType<typeof vi.fn>; isLaunching: ReturnType<typeof vi.fn> }
  const agent = { id: 's1', ctx: {}, steer: vi.fn(), inject: vi.fn() }
  const auto = new GroupAutoReader(env, async () => ({ tavernDir: dir, chatId, known: [], narratorLabels: ['旁白'] }))
  const handler = groupSpeakHandler(env, auto)
  const steer = vi.fn()
  return {
    h, speaker, env, auto, handler, agent, steer, log,
    configure: (r) => { voiceResult = r },
    async invoke(args, over = {}) {
      const info = await openTavern(dir)
      const tavern = over.readonly ? { ...info, access: 'readonly' as const } : info
      const inv = {
        agent, services: {}, rt: { log } as unknown as Runtime, theme, steer, args, label: '/aha 朗读',
        context: {
          mode: 'group', cwd: dir, sessionId: 's1', tavern, state: 'performing', outsideReason: null,
          record: { mode: 'group', state: 'performing', chatId, updated: '' },
        },
      } as unknown as Invocation
      return handler(inv)
    },
  }
}

// ---------- 纯函数 ----------

describe('narratorVoice', () => {
  it('配置的目录优先：读目录里成对的参考录音', async () => {
    expect(await narratorVoice({ config: { ...DEFAULTS, narratorVoiceDir: narrDir }, builtinAssetsDir: dir })).toEqual(NARR)
  })
  it('没配置时用随包参考录音（与语音预热同一段）', async () => {
    const assets = path.join(dir, 'assets')
    await fs.mkdir(assets, { recursive: true })
    await fs.writeFile(path.join(assets, 'voice-ref.wav'), Buffer.from([9]))
    expect(await narratorVoice({ config: { ...DEFAULTS, narratorVoiceDir: '' }, builtinAssetsDir: assets })).toEqual({
      audio: path.join(assets, 'voice-ref.wav'), text: BUILTIN_VOICE_TEXT,
    })
  })
  it('目录里缺参考录音时为 null', async () => {
    const empty = path.join(dir, '空的')
    await fs.mkdir(empty, { recursive: true })
    expect(await narratorVoice({ config: { ...DEFAULTS, narratorVoiceDir: empty }, builtinAssetsDir: dir })).toBeNull()
  })
})

describe('lineVoices', () => {
  it('narrator 用旁白音色，character 用各自角色的音色；没有音色或读不出卡的为 null', async () => {
    const lines: GroupLine[] = [
      { kind: 'narrator', text: '月亮升起来了。' },
      { kind: 'character', speaker: fox.id, text: '一。' },
      { kind: 'character', speaker: crow.id, text: '二。' },
      { kind: 'character', speaker: 'no-such', text: '三。' },
      { kind: 'character', text: '四。' },
    ]
    expect(await lineVoices({ config: { ...DEFAULTS, narratorVoiceDir: narrDir }, builtinAssetsDir: dir }, dir, lines))
      .toEqual([NARR, FOX, null, null, null])
  })
})

describe('planGroupSpeech', () => {
  const lines: GroupLine[] = [
    { kind: 'narrator', text: '月亮升起来了，院子静了下来。' },
    { kind: 'character', speaker: 'f', text: '今天天气真好啊。我们出去走走吧。' },
    { kind: 'character', speaker: 's', text: '（想了想）挺好。' },
  ]
  it('各段句子按各自音色排开；段间按换段停顿，段内照规划的间隔', () => {
    const plan = planGroupSpeech(lines, [NARR, FOX, SHAN], 'lines')
    expect(plan.sentences).toEqual(['月亮升起来了，院子静了下来。', '今天天气真好啊。', '我们出去走走吧。', '挺好。'])
    expect(plan.gaps).toEqual(['none', 'break', 'inline', 'break'])
    expect(plan.skipped).toEqual([0, 0, 0, 0])
    expect(plan.voices).toEqual([NARR, FOX, FOX, SHAN])
    expect(plan.silent).toBe(0)
  })
  it('没有音色的段跳过并计入 silent；取字后无字的段（如只有图片行）不计入', () => {
    const plan = planGroupSpeech(
      [lines[0]!, { kind: 'character', speaker: 'c', text: '![画面](</tmp/a b.png>)' }, lines[2]!],
      [NARR, null, null], 'lines',
    )
    expect(plan.sentences).toEqual(['月亮升起来了，院子静了下来。'])
    expect(plan.voices).toEqual([NARR])
    expect(plan.silent).toBe(1)
  })
  it('单句超总字数上限时 truncated 传递', () => {
    const plan = planGroupSpeech([{ kind: 'narrator', text: '今天天气真好啊，我们出去走走。'.repeat(100) }], [NARR], 'lines')
    expect(plan.truncated).toBe(true)
  })
})

describe('latestRoundLines', () => {
  it('取最后一条用户记录之后的旁白与台词，还原说话人；场景分界与旁白要求不算', async () => {
    await narr('开场的旁白说了几句话。')
    await userMsg('开始吧')
    await appendRecord(dir, chatId, { type: 'scene', text: '后院', cast: [] })
    await narr('月亮升起来了。')
    await said(fox.id, '今天天气真好啊。')
    await appendRecord(dir, chatId, { type: 'narrator-request', text: '让气氛紧张一点' })
    expect(await latestRoundLines(dir, chatId)).toEqual([
      { kind: 'narrator', text: '月亮升起来了。' },
      { kind: 'character', speaker: fox.id, text: '今天天气真好啊。' },
    ])
  })
  it('还没有用户记录时取全部（开场那一轮）', async () => {
    await narr('开场的旁白说了几句话。')
    await said(shan.id, '我先到了。')
    expect(await latestRoundLines(dir, chatId)).toHaveLength(2)
  })
  it('没有任何旁白与台词为 null', async () => {
    await userMsg('我来了')
    expect(await latestRoundLines(dir, chatId)).toBeNull()
  })
})

// ---------- 手动命令 ----------

describe('群聊朗读命令：带文本', () => {
  it('没有说话人：用旁白音色念（固化），按配置的取字方式去掉动作描写', async () => {
    const w = await world()
    const r = await w.invoke('（笑）今天的天气真好啊，出去走走吧。')
    expect(r.text).toBe('开始朗读，共 1 句。')
    await settle()
    expect(w.h.synths.map((s) => s.input.refAudio)).toEqual([NARR.audio])
    expect(w.h.synths.map((s) => s.input.refText)).toEqual([NARR.text])
    expect(w.h.synths.map((s) => s.text)).toEqual(['今天的天气真好啊，出去走走吧。'])
    expect(w.speaker.owner()).toBe('s1')
  })
  it('旁白音色目录不对：说明而不是开始朗读', async () => {
    const w = await world({ narratorDir: path.join(dir, '没有这个目录') })
    const r = await w.invoke('你好呀朋友')
    expect(r.kind).toBe('success')
    expect(r.text).toContain('旁白的音色不可用')
    expect(r.text).toContain('voice_ref.wav')
    expect(w.speaker.owner()).toBeNull()
  })
  it('取字后没有可念的字：说明', async () => {
    const w = await world()
    expect((await w.invoke('（笑了笑）')).text).toBe('没有可念的字。')
  })
})

describe('群聊朗读命令：不带文本念上一轮', () => {
  it('按记录顺序逐段、各用各的音色，段间停顿、段内半秒', async () => {
    const w = await world({ auto: true })
    await userMsg('开始吧')
    await narr('月亮升起来了，院子静了下来。')
    await said(fox.id, '今天天气真好啊。我们出去走走吧。')
    await said(shan.id, '（想了想）挺好。')
    const r = await w.invoke('')
    expect(r.text).toBe('开始朗读，共 4 句。')
    await settle()
    expect(w.h.synths.map((s) => s.input.refAudio)).toEqual([NARR.audio, FOX.audio, FOX.audio, SHAN.audio])
    expect(w.h.synths.map((s) => s.input.refText)).toEqual([NARR.text, FOX.text, FOX.text, SHAN.text])
    // break（0 字，按换段算）1379ms、inline 500ms、break 1379ms
    expect(w.h.sleeps.map((s) => s.ms)).toEqual([1379, 500, 1379])
    expect(w.h.plays).toHaveLength(4)
  })
  it('只念最后一条用户记录之后的那一轮', async () => {
    const w = await world({ auto: true })
    await userMsg('第一轮')
    await narr('第一轮的旁白说了几句话。')
    await userMsg('第二轮')
    await narr('第二轮的月亮也升起来了。')
    await said(fox.id, '我们出去走走吧。')
    const r = await w.invoke('')
    expect(r.text).toBe('开始朗读，共 2 句。')
    await settle()
    expect(w.h.synths.map((s) => s.text)).toEqual(['第二轮的月亮也升起来了。', '我们出去走走吧。'])
    expect(w.h.synths.map((s) => s.input.refAudio)).toEqual([NARR.audio, FOX.audio])
  })
  it('还没有用户记录时念开场那一轮', async () => {
    const w = await world({ auto: true })
    await narr('开场的旁白说了几句话。')
    expect((await w.invoke('')).text).toBe('开始朗读，共 1 句。')
  })
  it('没有音色的角色段跳过，回执里说明；其余照念', async () => {
    const w = await world({ auto: true })
    await userMsg('开始吧')
    await narr('月亮升起来了，院子静了下来。')
    await said(crow.id, '我也来说一句话吧。')
    const r = await w.invoke('')
    expect(r.text).toBe('开始朗读，共 1 句；另有 1 段没有声音可念，已跳过。')
    expect(w.h.synths.map((s) => s.input.refAudio)).toEqual([NARR.audio])
  })
  it('要念的角色都没有音色：指向筹备模式', async () => {
    const w = await world({ auto: true })
    await userMsg('开始吧')
    await said(crow.id, '我也来说一句话吧。')
    const r = await w.invoke('')
    expect(r.text).toContain('「酒馆:筹备」')
    expect(w.speaker.owner()).toBeNull()
  })
  it('这场聊天里还没有可念的话：说明', async () => {
    const w = await world()
    expect((await w.invoke('')).text).toBe('这场聊天里还没有角色的话可念。')
  })
})

describe('群聊朗读命令：服务不可用与开关', () => {
  it('没配置语音：指向文档，不探测', async () => {
    const w = await world()
    w.configure({ configured: false, problems: [] })
    expect((await w.invoke('你好呀朋友')).text).toBe('还没有配置语音服务，配置方法见 docs/voice-setup.md。')
    expect(w.env.probe).not.toHaveBeenCalled()
  })
  it('服务连不上：提示启动命令', async () => {
    const w = await world()
    w.env.probe.mockRejectedValue(new TtsError('unreachable'))
    expect((await w.invoke('你好呀朋友')).text).toBe('语音服务连不上，可以用 /aha 语音 启动。')
    expect((await w.invoke('')).text).toBe('语音服务连不上，可以用 /aha 语音 启动。')
  })
  it('开：写进群聊的 meta；关：停下正在念的', async () => {
    const w = await world()
    expect((await w.invoke('开')).text).toBe('自动朗读已打开。')
    expect(await readChatAutoRead(dir, chatId)).toBe(true)
    await w.invoke('今天天气真好啊。')
    expect(w.speaker.owner()).toBe('s1')
    expect((await w.invoke('关')).text).toBe('自动朗读已关闭。')
    expect(await readChatAutoRead(dir, chatId)).toBe(false)
    expect(w.speaker.owner()).toBeNull()
  })
  it('停：停下正在念的', async () => {
    const w = await world()
    await w.invoke('今天天气真好啊。')
    expect((await w.invoke('停')).text).toBe('已停止朗读。')
    expect(w.speaker.owner()).toBeNull()
  })
  it('只读酒馆：不能改开关，朗读本身可以', async () => {
    const w = await world({ auto: true })
    expect((await w.invoke('开', { readonly: true })).text).toContain('不能改自动朗读')
    expect(await readChatAutoRead(dir, chatId)).toBe(false)
    await narr('月亮升起来了，院子静了下来。')
    expect((await w.invoke('', { readonly: true })).text).toBe('开始朗读，共 1 句。')
  })
  it('全过程不调用模型：不 steer 也不 inject', async () => {
    const w = await world({ auto: true })
    await w.invoke('今天天气真好啊。')
    await w.invoke('')
    await w.invoke('开')
    await w.invoke('停')
    expect(w.steer).not.toHaveBeenCalled()
    expect(w.agent.steer).not.toHaveBeenCalled()
    expect(w.agent.inject).not.toHaveBeenCalled()
  })
})

// ---------- 自动朗读 ----------

const replyLines = (): GroupLine[] => [
  { kind: 'narrator', text: '月亮升起来了，院子静了下来。' },
  { kind: 'character', speaker: fox.id, text: '今天天气真好啊。我们出去走走吧。' },
  { kind: 'character', speaker: shan.id, text: '（想了想）挺好。' },
]

describe('群聊自动朗读', () => {
  it('默认关闭：落盘回调攒下的段不念', async () => {
    const w = await world({ auto: true })
    w.auto.onReply('s1', replyLines())
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    expect(w.h.synths).toHaveLength(0)
    expect(w.env.probe).not.toHaveBeenCalled()
  })
  it('开着才念：按段、按各自音色依次交给队列，owner 是会话编号', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', replyLines())
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    expect(w.h.synths.map((s) => s.input.refAudio)).toEqual([NARR.audio, FOX.audio, FOX.audio, SHAN.audio])
    expect(w.h.sleeps.map((s) => s.ms)).toEqual([1379, 500, 1379])
    expect(w.speaker.owner()).toBeNull() // 念完了
  })
  it('开关按聊天目录 meta 存取：不 setFlag 也能从盘上读到开', async () => {
    const w = await world({ auto: true })
    await setChatAutoRead(dir, chatId, true)
    w.auto.onReply('s1', replyLines())
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    expect(w.h.synths.length).toBeGreaterThan(0)
  })
  it('没有音色的段安静跳过，其余照念', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', [
      { kind: 'narrator', text: '月亮升起来了，院子静了下来。' },
      { kind: 'character', speaker: crow.id, text: '我也来说一句话吧。' },
    ])
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    expect(w.h.synths.map((s) => s.input.refAudio)).toEqual([NARR.audio])
    expect(w.log.warn).not.toHaveBeenCalled()
  })
  it('只有图片行的回复不念、也不探测服务', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', [{ kind: 'narrator', text: '![画面](</tmp/a b.png>)' }])
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    expect(w.h.synths).toHaveLength(0)
    expect(w.env.probe).not.toHaveBeenCalled()
  })
  it('用户发来新消息：清掉攒下的段，停下属于这个会话的朗读', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', replyLines())
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    expect(w.h.synths).toHaveLength(1) // 第一句在合成，还没念完
    w.auto.onStep('s1', 2, 1)
    await settle()
    expect(w.h.synths[0]!.opts.signal.aborted).toBe(true)
    expect(w.speaker.owner()).toBeNull()
    // 残留的段作废：收尾也不会念
    await w.auto.onTurnStopping(w.agent, 2)
    await settle()
    expect(w.h.synths).toHaveLength(1)
  })
  it('同一轮第二次收尾只念新提交的段，且追加不打断正在念的', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', [{ kind: 'narrator', text: '我先说了第一段话，请你听好。' }])
    await w.auto.onTurnStopping(w.agent, 7)
    await settle()
    w.h.synths[0]!.done()
    await settle() // 第一句在播
    w.auto.onReply('s1', [{ kind: 'character', speaker: fox.id, text: '白狐补了一句台词，你听到了吗。' }])
    await w.auto.onTurnStopping(w.agent, 7)
    await settle()
    w.h.plays[0]!.end()
    await settle()
    expect(w.h.synths.map((s) => s.text)).toEqual(['我先说了第一段话，请你听好。', '白狐补了一句台词，你听到了吗。'])
    expect(w.h.synths[1]!.input.refAudio).toBe(FOX.audio)
    await w.speaker.stop()
  })
  it('下一轮的收尾顶掉上一轮还没念完的', async () => {
    const w = await world({ auto: false })
    w.auto.setFlag('s1', true)
    w.auto.onReply('s1', [{ kind: 'narrator', text: '我先说了第一段话，请你听好。' }])
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    w.auto.onReply('s1', [{ kind: 'narrator', text: '这是下一轮说的话，请你听好。' }])
    await w.auto.onTurnStopping(w.agent, 2)
    await settle()
    expect(w.h.synths[0]!.opts.signal.aborted).toBe(true)
    expect(w.h.synths.map((s) => s.text)).toEqual(['我先说了第一段话，请你听好。', '这是下一轮说的话，请你听好。'])
  })
  it('不能朗读时安静跳过：每种原因只记一条 debug 日志', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    w.env.probe.mockRejectedValue(new TtsError('unreachable'))
    const skipLogs = () => (w.log.debug as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('群聊自动朗读'))
    for (let i = 1; i <= 2; i++) {
      w.auto.onStep('s1', i, 1)
      w.auto.onReply('s1', replyLines())
      await w.auto.onTurnStopping(w.agent, i)
      await settle()
    }
    expect(skipLogs()).toHaveLength(1)
    expect(w.h.synths).toHaveLength(0)
    expect(w.log.warn).not.toHaveBeenCalled()
  })
  it('等检查期间用户又发了消息：这一轮的段作废，不开口', async () => {
    const w = await world({ auto: true })
    w.auto.setFlag('s1', true)
    let release: () => void = () => undefined
    w.env.probe.mockImplementation(() => new Promise<void>((r) => { release = r }))
    w.auto.onReply('s1', replyLines())
    const done = w.auto.onTurnStopping(w.agent, 1)
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
    w.auto.onReply('s1', replyLines())
    await w.auto.onTurnStopping(w.agent, 1)
    await settle()
    w.auto.onReply('s1', [{ kind: 'narrator', text: '残留的段说了好长一段话。' }])
    w.auto.forget('s1')
    await settle()
    expect(w.speaker.owner()).toBeNull()
    await w.auto.onTurnStopping(w.agent, 2)
    await settle()
    expect(w.h.synths).toHaveLength(1)
  })
  it('取不到落盘目标（不在场景中）时不念；出错只记 warn', async () => {
    const w = await world({ auto: true })
    const none = new GroupAutoReader(w.env, async () => null)
    none.setFlag('s1', true)
    none.onReply('s1', replyLines())
    await none.onTurnStopping(w.agent, 1)
    expect(w.h.synths).toHaveLength(0)
    const boom = new GroupAutoReader(w.env, async () => { throw new Error('boom') })
    boom.setFlag('s1', true)
    boom.onReply('s1', replyLines())
    await expect(boom.onTurnStopping(w.agent, 1)).resolves.toBeUndefined()
    expect(w.log.warn).toHaveBeenCalled()
  })
})
