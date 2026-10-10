import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { MEMORY_FILE, listCharacters, saveCharacter } from '../../../src/core/card'
import { CHAT_SUMMARY_FILE, findChatDir, readChatMeta } from '../../../src/core/chat'
import { appendIndexLine, appendPinned, readMemory, readMemoryText } from '../../../src/core/memory'
import { createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { startTool, type ChatEnv } from '../../../src/shell/chat'
import { SessionGate } from '../../../src/shell/confirm'
import { readSession } from '../../../src/core/state'
import { buildContext, sessionsFile, type HostAgent, type Invocation } from '../../../src/shell/context'
import {
  createMemoryEnv, onChatStep, RememberTurns, parseReviewArgs, rememberHandler, rememberTool, reviewTool, REVIEW_REMINDER_TEXT, REVIEW_REQUEST_TEXT,
  type MemoryEnv,
} from '../../../src/shell/remember'
import type { Runtime } from '../../../src/shell/runtime'
import { SessionSections } from '../../../src/shell/sections'
import { voiceRuntimeStubs } from './helpers/runtime'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let dir: string
let preset: string | undefined
let steered: string[]
let injected: any[]
let agent: HostAgent
const services = { agentPresets: { composedPreset: () => preset } }

const rtOf = (over: Partial<Runtime['config']> = {}): Runtime => ({
  config: { ...DEFAULTS, mode: 'chat', registryPath: path.join(dir, '.reg.yaml'), ...over },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined, theme: async () => theme, handlers: {}, ...voiceRuntimeStubs,
}) as Runtime

beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-rem-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
  preset = 'tavern-chat'
  steered = []
  injected = []
  agent = {
    id: 's1',
    get ctx() { return {} },
    session: { get header() { return { cwd: dir } }, deriveMessages: () => [] },
    steer: (m: unknown) => { steered.push(JSON.stringify(m)) },
    inject: (m: unknown) => { injected.push(m) },
  }
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 建一个角色并让会话进入聊天；返回记忆文件路径与聊天编号。 */
async function startChat(rt = rtOf()): Promise<{ memFile: string; chatId: string }> {
  const card = (await saveCharacter(dir, { name: '白狐', persona: '白狐的设定', greeting: '你好' })).card
  const sections = new SessionSections(rt.log, () => vi.fn())
  const env: ChatEnv = {
    rt, sections, gate: new SessionGate(), getAsk: () => undefined, getServices: () => services,
    now: () => new Date(2026, 9, 9),
  }
  expect(await startTool(env)(agent, { id: card.id })).toBe(`started with ${card.id}`)
  const entry = (await listCharacters(dir)).find((e) => e.ok)!
  const memFile = path.join((entry as { dir: string }).dir, MEMORY_FILE)
  // 初始化不再写索引行；这里补上用户说过话之后才有的那一行
  const chatId = (await readSession(sessionsFile(dir), 's1')).record!.chatId!
  await appendIndexLine(memFile, { date: '2026-10-09', kind: 'chat', id: chatId }, { characterName: '白狐' })
  return { memFile, chatId }
}

const memEnv = (rt = rtOf()): MemoryEnv => createMemoryEnv(rt, () => services)
const step = (env: MemoryEnv, turn: number, users = 0) => onChatStep(env, agent, turn, users)

describe('aha_remember', () => {
  it('追加到关键的事；同一轮第二次不写入，下一轮可以再记', async () => {
    const { memFile } = await startChat()
    const env = memEnv()
    const tool = rememberTool(env)
    await step(env, 1)
    expect(await tool(agent, { text: '我老家在海边' })).toBe('remembered')
    expect(await tool(agent, { text: '我想换工作' })).toBe('already remembered this turn')
    expect((await readMemory(memFile)).facts).toEqual(['我老家在海边'])
    await step(env, 2)
    expect(await tool(agent, { text: '我想换工作' })).toBe('remembered')
    expect((await readMemory(memFile)).facts).toEqual(['我老家在海边', '我想换工作'])
  })
  it('重复条目不写入也不占用本轮名额', async () => {
    await startChat()
    const env = memEnv()
    const tool = rememberTool(env)
    await step(env, 1)
    await tool(agent, { text: '我不吃香菜' })
    await step(env, 2)
    expect(await tool(agent, { text: '我不吃香菜' })).toBe('skipped: already known')
    expect(await tool(agent, { text: '我怕狗' })).toBe('remembered')
  })
  it('选角阶段被拒绝', async () => {
    await saveCharacter(dir, { name: '白狐', persona: 'p', greeting: 'g' })
    const env = memEnv()
    expect(await rememberTool(env)(agent, { text: '某事' })).toBe('error: not chatting')
  })
  it('参数不对被拒绝', async () => {
    await startChat()
    const env = memEnv()
    expect(await rememberTool(env)(agent, { text: '  ' })).toMatch(/^error/)
    expect(await rememberTool(env)(agent, { text: 'x'.repeat(500) })).toMatch(/exceeds/)
    expect(await rememberTool(env)(undefined, { text: '某事' })).toBe('error: session not ready')
  })
  it('写盘失败：返回失败说明不抛异常，并释放本轮名额', async () => {
    const { memFile } = await startChat()
    const env = memEnv()
    await step(env, 1)
    await fs.rm(memFile)
    await fs.mkdir(memFile) // 路径被目录占住，写不进去
    const tool = rememberTool(env)
    const r = await tool(agent, { text: '某事' })
    expect(r).toMatch(/^error: not saved/)
    await fs.rm(memFile, { recursive: true })
    expect(await tool(agent, { text: '某事' })).toBe('remembered')
  })
  it('拿不到轮次号时按用户消息条数分轮', async () => {
    await startChat()
    const env = memEnv()
    const tool = rememberTool(env)
    await onChatStep(env, agent, undefined, 1)
    expect(await tool(agent, { text: '甲事' })).toBe('remembered')
    await onChatStep(env, agent, undefined, 0)
    expect(await tool(agent, { text: '乙事' })).toBe('already remembered this turn')
    await onChatStep(env, agent, undefined, 1)
    expect(await tool(agent, { text: '乙事' })).toBe('remembered')
  })
})

describe('RememberTurns', () => {
  it('release 带令牌：晚到的旧轮次释放不影响新一轮的名额', () => {
    const t = new RememberTurns()
    t.onStep('s', 1, 1)
    const old = t.claim('s')!
    expect(old).toBeTruthy()
    t.onStep('s', 2, 1)
    const cur = t.claim('s')!
    t.release('s', old)
    expect(t.claim('s')).toBeNull()
    t.release('s', cur)
    expect(t.claim('s')).not.toBeNull()
  })
  it('同一轮已占用时 claim 返回 null；turn 时有时无不让令牌错乱', () => {
    const t = new RememberTurns()
    t.onStep('s', undefined, 1)
    const a = t.claim('s')!
    expect(t.claim('s')).toBeNull()
    t.onStep('s', 5, 1)
    const b = t.claim('s')!
    expect(b).not.toBe(a)
    t.onStep('s', undefined, 1)
    const c = t.claim('s')!
    expect(c).not.toBe(b)
    expect(c).not.toBe(a)
  })
})

describe('aha_review', () => {
  it('只替换给出的栏，我让 TA 记住的与往事索引其他行原样不动；梗概与标题落盘', async () => {
    const { memFile, chatId } = await startChat()
    await appendPinned(memFile, '我下周三过生日')
    const before = await readMemory(memFile)
    const env = memEnv()
    const r = await reviewTool(env)(agent, {
      address: '她叫我老板', facts: ['我老家在海边'], summary: '聊了老家', title: '聊老家的事',
    })
    expect(r).toBe('saved: address, facts, summary, chat_title, index_title')
    const after = await readMemory(memFile)
    expect(after.pinned).toEqual(before.pinned)
    expect(after.pinned).toEqual(['我下周三过生日'])
    expect(after.impression).toBe(before.impression)
    expect(after.address).toBe('她叫我老板')
    expect(after.facts).toEqual(['我老家在海边'])
    expect(after.index.find((i) => i.id === chatId)?.title).toBe('聊老家的事')
    const chatDir = (await findChatDir(dir, chatId))!
    expect(await fs.readFile(path.join(chatDir, CHAT_SUMMARY_FILE), 'utf8')).toBe('聊了老家')
    expect((await readChatMeta(dir, chatId)).title).toBe('聊老家的事')
  })
  it('模型塞进来的 pinned / index 栏被忽略', async () => {
    const { memFile } = await startChat()
    await appendPinned(memFile, '原话')
    const r = await reviewTool(memEnv())(agent, { facts: ['事'], pinned: ['篡改'], index: ['篡改'] })
    expect(r).toBe('saved: facts')
    expect((await readMemory(memFile)).pinned).toEqual(['原话'])
  })
  it('summary 与 title 必须一起给；什么都没给是无需改动', async () => {
    await startChat()
    const env = memEnv()
    expect(await reviewTool(env)(agent, { summary: '梗概' })).toMatch(/together/)
    expect(await reviewTool(env)(agent, {})).toBe('nothing to change')
    expect(parseReviewArgs({ facts: 'x' }, 100)).toMatch(/array/)
  })
  it('写盘失败返回失败说明不抛；部分成功如实说明', async () => {
    const { memFile, chatId } = await startChat()
    const env = memEnv()
    await fs.rm(memFile)
    await fs.mkdir(memFile)
    const r = await reviewTool(env)(agent, { facts: ['事'] })
    expect(r).toMatch(/^error: not saved/)
    await fs.rm(memFile, { recursive: true })
    const chatDir = (await findChatDir(dir, chatId))!
    await fs.rm(path.join(chatDir, 'meta.yaml'))
    await fs.mkdir(path.join(chatDir, 'meta.yaml'))
    const r2 = await reviewTool(env)(agent, { facts: ['事'], summary: 's', title: 't' })
    expect(r2).toMatch(/^partly saved: facts, summary/)
    expect(r2).toMatch(/failed: chat_title/)
    expect(await fs.readFile(path.join(chatDir, 'summary.md'), 'utf8')).toBe('s')
  })
  it('往事索引里没有这一行（用户一句话都没说）：补写一行并带上标题，不报失败', async () => {
    const { memFile, chatId } = await startChat()
    const text = await readMemoryText(memFile)
    await fs.writeFile(memFile, text.split('\n').filter((l) => !l.includes(chatId)).join('\n'))
    expect((await readMemory(memFile)).index).toEqual([])
    const r = await reviewTool(memEnv())(agent, { summary: '梗概', title: '标题' })
    expect(r).toBe('saved: summary, chat_title, index_title')
    expect((await readMemory(memFile)).index).toEqual([
      expect.objectContaining({ kind: 'chat', title: '标题', id: chatId }),
    ])
  })
  it('从没说过话的聊天直接整理：索引行从无到有，再整理一次只改标题不重复', async () => {
    const { memFile, chatId } = await startChat()
    const text = await readMemoryText(memFile)
    await fs.writeFile(memFile, text.split('\n').filter((l) => !l.includes(chatId)).join('\n'))
    await reviewTool(memEnv())(agent, { summary: '梗概', title: '甲' })
    await reviewTool(memEnv())(agent, { summary: '梗概二', title: '乙' })
    const idx = (await readMemory(memFile)).index
    expect(idx).toHaveLength(1)
    expect(idx[0]).toMatchObject({ title: '乙', id: chatId })
  })
  it('记忆文件是目录写不进：整理里的标题步骤同样如实失败', async () => {
    const { memFile } = await startChat()
    await fs.rm(memFile)
    await fs.mkdir(memFile)
    const r = await reviewTool(memEnv())(agent, { summary: '梗概', title: '标题' })
    expect(r).toMatch(/failed: index_title/)
  })
  it('facts 条数上限取 keyFactsMax，超出被拒绝而不是静默截断', async () => {
    await startChat()
    const env = memEnv(rtOf({ keyFactsMax: 3 }))
    const r = await reviewTool(env)(agent, { facts: ['一', '二', '三', '四'] })
    expect(r).toMatch(/limit 3/)
    expect(parseReviewArgs({ facts: ['一', '二', '三'] }, 3)).toMatchObject({ patch: { facts: ['一', '二', '三'] } })
  })
  it('选角阶段被拒绝', async () => {
    await saveCharacter(dir, { name: '白狐', persona: 'p', greeting: 'g' })
    expect(await reviewTool(memEnv())(agent, { facts: ['事'] })).toBe('error: not chatting')
  })
})

describe('审视提醒', () => {
  it('提醒文字：summary 和 title 每次都给，不再有"无需改动就不调用"', () => {
    expect(REVIEW_REMINDER_TEXT).toContain('每次都要给')
    expect(REVIEW_REMINDER_TEXT).toContain('只给 summary 和 title')
    expect(REVIEW_REMINDER_TEXT).not.toContain('就不调用')
  })
  it('到阈值 inject 一次，来源不是 user；之后重新计数', async () => {
    await startChat()
    const env = memEnv(rtOf({ reviewIntervalTurns: 3 }))
    expect(await step(env, 1, 1)).toBe(false)
    expect(await step(env, 2, 1)).toBe(false)
    expect(injected).toHaveLength(0)
    expect(await step(env, 3, 1)).toBe(true)
    expect(injected).toHaveLength(1)
    const m = injected[0]
    expect(m.source).toMatchObject({ kind: 'aha-tavern', form: 'notice' })
    expect(m.source.kind).not.toBe('user')
    expect(JSON.stringify(m)).toContain(REVIEW_REMINDER_TEXT.slice(0, 10))
    expect(await step(env, 4, 1)).toBe(false)
    expect(injected).toHaveLength(1)
  })
  it('没有新用户消息的步（工具循环）不计数；中途有记忆写入则重新计数', async () => {
    await startChat()
    const env = memEnv(rtOf({ reviewIntervalTurns: 2 }))
    await step(env, 1, 1)
    await step(env, 1, 0)
    await step(env, 1, 0)
    expect(await rememberTool(env)(agent, { text: '某事' })).toBe('remembered')
    expect(await step(env, 2, 1)).toBe(false)
    expect(await step(env, 3, 1)).toBe(true)
  })
  it('选角阶段的用户消息不计数', async () => {
    await saveCharacter(dir, { name: '白狐', persona: 'p', greeting: 'g' })
    const env = memEnv(rtOf({ reviewIntervalTurns: 1 }))
    expect(await step(env, 1, 1)).toBe(false)
    expect(injected).toHaveLength(0)
  })
  it('宿主没有 inject 时不抛，提醒不丢：恢复后下一条消息补发', async () => {
    await startChat()
    const inject = agent.inject
    delete (agent as { inject?: unknown }).inject
    const env = memEnv(rtOf({ reviewIntervalTurns: 2 }))
    await step(env, 1, 1)
    expect(await step(env, 2, 1)).toBe(false)
    agent.inject = inject
    expect(await step(env, 3, 1)).toBe(true)
    expect(injected).toHaveLength(1)
  })
  it('inject 抛错同样不丢提醒', async () => {
    await startChat()
    const env = memEnv(rtOf({ reviewIntervalTurns: 1 }))
    agent.inject = () => { throw new Error('boom') }
    expect(await step(env, 1, 1)).toBe(false)
    agent.inject = (m: unknown) => { injected.push(m) }
    expect(await step(env, 2, 1)).toBe(true)
  })
})

describe('记忆 命令', () => {
  const invOf = async (env: MemoryEnv, args: string): Promise<Invocation> => ({
    agent, services, rt: env.rt as Runtime, theme, context: await buildContext(agent, services), args, label: '/aha 记忆',
    steer: (text: string) => { steered.push(text) },
  })

  it('带内容：追加到我让 TA 记住的（不经模型），inject 补给会话，回执带内容', async () => {
    const { memFile } = await startChat()
    steered = []
    const env = memEnv()
    const r = await rememberHandler(env)(await invOf(env, '我下周三过生日'))
    expect(r.kind).toBe('success')
    expect(r.text).toContain('我下周三过生日')
    expect(r.text).toContain('主线记忆')
    expect((await readMemory(memFile)).pinned).toEqual(['我下周三过生日'])
    expect(steered).toHaveLength(0)
    expect(injected).toHaveLength(1)
    expect(injected[0].source).toMatchObject({ kind: 'aha-tavern', form: 'notice' })
    expect(JSON.stringify(injected[0])).toContain('我下周三过生日')
  })
  it('带内容且写盘失败：失败回执，不 inject', async () => {
    const { memFile } = await startChat()
    await fs.rm(memFile)
    await fs.mkdir(memFile)
    const env = memEnv()
    const r = await rememberHandler(env)(await invOf(env, '某事'))
    expect(r.kind).toBe('error')
    expect(injected).toHaveLength(0)
  })
  it('带内容但宿主没有 inject：写入成功，回执说明角色暂时不知道', async () => {
    await startChat()
    delete (agent as { inject?: unknown }).inject
    const env = memEnv()
    const r = await rememberHandler(env)(await invOf(env, '某事'))
    expect(r.kind).toBe('success')
    expect(r.text).toContain('暂时还不知道')
  })
  it('不带内容：用 steer 请角色整理，不写盘不 inject，静默回执', async () => {
    const { memFile } = await startChat()
    steered = []
    const env = memEnv()
    const r = await rememberHandler(env)(await invOf(env, ''))
    expect(r).toEqual({ kind: 'success' })
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain('aha_review')
    // summary 与 title 每次都要给；facts 让角色根据上下文自己判断
    expect(REVIEW_REQUEST_TEXT).toContain('summary')
    expect(REVIEW_REQUEST_TEXT).toContain('title')
    expect(REVIEW_REQUEST_TEXT).toContain('必须给')
    expect(REVIEW_REQUEST_TEXT).toContain('根据这次聊天的上下文自己判断')
    expect(REVIEW_REQUEST_TEXT).toContain('只给 summary 和 title')
    expect(injected).toHaveLength(0)
    expect((await readMemory(memFile)).pinned).toEqual([])
  })
  it('不带内容但不在聊天中：中文说明，不 steer', async () => {
    await saveCharacter(dir, { name: '白狐', persona: 'p', greeting: 'g' })
    const env = memEnv()
    const r = await rememberHandler(env)(await invOf(env, ''))
    expect(r.kind).toBe('error')
    expect(r.text).not.toMatch(/error:|not chatting/)
    expect(steered).toHaveLength(0)
    const r2 = await rememberHandler(env)(await invOf(env, '某事'))
    expect(r2.text).not.toMatch(/error:|not chatting/)
  })
  it('不带内容且酒馆只读：不 steer', async () => {
    await startChat()
    steered = []
    const env = memEnv()
    const i = await invOf(env, '')
    const r = await rememberHandler(env)({ ...i, context: { ...i.context, tavern: { ...i.context.tavern!, access: 'readonly' } } })
    expect(r.kind).toBe('success')
    expect(r.text).toMatch(/升级插件/)
    expect(steered).toHaveLength(0)
  })
  it('日志只记结果标识与字数，不记内容', async () => {
    await startChat()
    const rt = rtOf()
    const env = memEnv(rt)
    await rememberTool(env)(agent, { text: '绝密内容' })
    const calls = (rt.log.debug as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(calls.some((c) => c.includes('aha_remember') && c.includes('remembered'))).toBe(true)
    expect(calls.join('\n')).not.toContain('绝密内容')
  })
  it('内容过长被拒', async () => {
    await startChat()
    const env = memEnv()
    expect((await rememberHandler(env)(await invOf(env, 'x'.repeat(600)))).kind).toBe('error')
  })
})
