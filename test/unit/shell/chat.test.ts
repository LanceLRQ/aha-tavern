import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, MEMORY_FILE, saveCharacter } from '../../../src/core/card'
import { readMe, writeMe, writeWorld } from '../../../src/core/docs'
import { appendIndexLine, readMemory } from '../../../src/core/memory'
import { readSession, saveSession } from '../../../src/core/state'
import { openTavern, createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import {
  buildPickBatches, buildStartCue, chatPlan, checkRoster, collectNotes, initialize, interpretPick, localDate,
  realSteps, sortCandidates, startHandler, startTool, startedReceipt, startedToolText, OPT_MORE, PICK_PAGE,
  type ChatEnv, type GoodEntry, type InitSteps,
} from '../../../src/shell/chat'
import { parseStartArgs } from '../../../src/shell/chat-tools'
import { SessionGate, type AskFn } from '../../../src/shell/confirm'
import { buildContext, sessionsFile, type HostAgent, type Invocation } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { SessionSections } from '../../../src/shell/sections'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let dir: string
beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-chat-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const rtOf = (over: Partial<Runtime['config']> = {}): Runtime => ({
  config: { ...DEFAULTS, mode: 'chat', registryPath: path.join(dir, '.reg.yaml'), ...over },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  builtinThemeDir: builtinDir, tools: () => undefined, theme: async () => theme, handlers: {},
}) as Runtime

const addChar = async (name: string, extra: Record<string, string> = {}) =>
  (await saveCharacter(dir, { name, persona: `${name}的设定`, greeting: `${name}：你好`, ...extra })).card
const entriesOf = () => listCharacters(dir)
const goodOf = async (): Promise<GoodEntry[]> => (await entriesOf()).filter((e): e is GoodEntry => e.ok)
const memFileOf = (e: GoodEntry) => path.join(e.dir, MEMORY_FILE)

// ---------- 纯函数 ----------

describe('sortCandidates', () => {
  it('最近聊过的在前，没聊过的在后按名字', async () => {
    const a = await addChar('甲')
    const b = await addChar('乙')
    const c = await addChar('丙')
    const d = await addChar('丁')
    const es = await goodOf()
    const dates = new Map([[a.id, '2026-10-01'], [c.id, '2026-10-09']])
    const names = sortCandidates(es, dates).map((e) => e.card.name)
    expect(names.slice(0, 2)).toEqual(['丙', '甲'])
    expect(names.slice(2)).toEqual([b.name, d.name].sort((x, y) => x.localeCompare(y, 'zh')))
  })
  it('同一天按名字', async () => {
    const a = await addChar('乙')
    const b = await addChar('甲')
    const es = await goodOf()
    const names = sortCandidates(es, new Map([[a.id, '2026-10-01'], [b.id, '2026-10-01']])).map((e) => e.card.name)
    expect(names).toEqual(['乙', '甲'].sort((x, y) => x.localeCompare(y, 'zh')))
  })
})

describe('buildPickBatches / interpretPick', () => {
  const fake = (n: number): GoodEntry[] => Array.from({ length: n }, (_, i) => ({
    ok: true, dir: `/x/${i}`, dirName: `c${i}`, card: { id: `c_${i}`, name: `角色${i}`, persona: 'p', ...(i === 0 ? { tagline: '简介' } : {}) },
  }))
  it('不超过一页：一张卡片，没有更多', () => {
    const b = buildPickBatches(theme, fake(12))
    expect(b).toHaveLength(1)
    expect(b[0]!.item.options).toHaveLength(12)
    expect(b[0]!.item.options.some((o) => o.label === OPT_MORE)).toBe(false)
    expect(b[0]!.item.options[0]!.description).toBe('简介')
  })
  it('超过一页：每批最后一项是更多…，最后一批放完剩下的', () => {
    const b = buildPickBatches(theme, fake(25))
    expect(b.map((x) => x.item.options.length)).toEqual([PICK_PAGE, PICK_PAGE, 3])
    expect(b[0]!.item.options.at(-1)!.label).toBe(OPT_MORE)
    const marked = { ...theme, concept: (id: string) => `〈${id}〉` } as unknown as Theme
    expect(buildPickBatches(marked, fake(25))[0]!.item.options.at(-1)!.description).toContain('〈character〉')
    expect(b[2]!.item.options.some((o) => o.label === OPT_MORE)).toBe(false)
    const ids = b.flatMap((x) => [...x.byLabel.values()]).filter((v) => v.kind === 'character')
    expect(ids).toHaveLength(25)
    expect(new Set(b.map((x) => x.item.id)).size).toBe(3)
  })
  it('只有一个角色也弹卡片确认', () => {
    const b = buildPickBatches(theme, fake(1))
    expect(b).toHaveLength(1)
    expect(b[0]!.item.question).toContain('角色0')
  })
  it('重名的选项文字加序号', () => {
    const es = fake(2)
    es[1]!.card.name = es[0]!.card.name
    const b = buildPickBatches(theme, es)
    expect(new Set(b[0]!.item.options.map((o) => o.label)).size).toBe(2)
  })
  it('回答的解释', () => {
    const b = buildPickBatches(theme, fake(15))[0]!
    const ans = (x: object) => ({ answers: [{ id: b.item.id, ...x }] })
    expect(interpretPick(ans({ selected: ['角色3'] }), b)).toEqual({ kind: 'character', id: 'c_3' })
    expect(interpretPick(ans({ selected: [OPT_MORE] }), b)).toEqual({ kind: 'more' })
    expect(interpretPick(ans({ selected: [], custom: ' 角色1 ' }), b)).toEqual({ kind: 'name', text: '角色1' })
    expect(interpretPick(ans({ selected: ['角色3'], custom: 'x' }), b)).toEqual({ kind: 'cancel' })
    expect(interpretPick(ans({ selected: ['不存在'] }), b)).toEqual({ kind: 'cancel' })
    expect(interpretPick(ans({ selected: [] }), b)).toEqual({ kind: 'cancel' })
    expect(interpretPick({ answers: [] }, b)).toEqual({ kind: 'cancel' })
    expect(interpretPick(undefined, b)).toEqual({ kind: 'cancel' })
  })
})

describe('checkRoster / collectNotes / buildStartCue / localDate', () => {
  it('没有角色、全是坏卡、有好卡', async () => {
    expect(checkRoster([])).toEqual({ kind: 'no-characters' })
    await fs.mkdir(path.join(dir, 'characters', '坏'), { recursive: true })
    const es = await entriesOf()
    expect(checkRoster(es)).toMatchObject({ kind: 'no-usable' })
    await addChar('好')
    expect(checkRoster(await entriesOf())).toBeNull()
  })
  it('提醒项：档案空、记忆超限、世界观超预算', () => {
    const base = { profileEmpty: false, memoryChars: 10, memoryMax: 3000, worldChars: 10, worldBudget: 4000 }
    expect(collectNotes(base)).toEqual([])
    expect(collectNotes({ ...base, profileEmpty: true }).map((n) => n.kind)).toEqual(['profile-empty'])
    expect(collectNotes({ ...base, memoryChars: 3001 })).toEqual([{ kind: 'memory-over', chars: 3001, max: 3000 }])
    expect(collectNotes({ ...base, worldChars: 4001 })).toEqual([{ kind: 'world-over', chars: 4001, budget: 4000 }])
    expect(collectNotes({ ...base, memoryChars: 3000, worldChars: 4000 })).toEqual([])
  })
  it('开场指令：两种情形都在 150 字以内', () => {
    const first = buildStartCue(true)
    const again = buildStartCue(false)
    expect(first).toContain('出场白')
    expect(again).toContain('不要复述记忆')
    expect(again).not.toContain('出场白的出场白')
    for (const t of [first, again]) expect([...t].length).toBeLessThanOrEqual(150)
  })
  it('本地日期', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
  it('回执：提醒与未完成步骤', () => {
    const r = startedReceipt(theme, {
      kind: 'started', chatId: 'ab12', characterId: 'c_1', name: '白狐',
      notes: [{ kind: 'profile-empty' }, { kind: 'memory-over', chars: 4000, max: 3000 }, { kind: 'world-over', chars: 5000, budget: 4000 }],
      failed: ['index'],
    })
    expect(r.text).toContain('白狐')
    expect(r.text).toContain('没记进')
    expect(r.text).toContain('酒馆:筹备')
    expect(r.text).toContain('4000')
    expect(r.text).toContain('预算')
  })
  it('parseStartArgs', () => {
    expect(parseStartArgs({ id: ' c_1 ' })).toEqual({ id: 'c_1' })
    expect(parseStartArgs({ name: '白狐', id: 'c_1' })).toEqual({ id: 'c_1', name: '白狐' })
    expect(parseStartArgs({})).toMatch(/^error/)
    expect(parseStartArgs({ id: '  ' })).toMatch(/^error/)
    expect(parseStartArgs({ id: 5 })).toMatch(/^error/)
    expect(parseStartArgs(null)).toMatch(/^error/)
  })
})

// ---------- initialize ----------

describe('initialize', () => {
  const limits = { worldBudget: 4000, memoryMaxChars: 3000, pastIndexMaxLines: 100 }
  const now = new Date(2026, 9, 9, 10, 30)

  async function setup(over: { steps?: Partial<InitSteps>; limits?: Partial<typeof limits>; access?: 'readonly' } = {}) {
    await addChar('白狐')
    const entry = (await goodOf())[0]!
    const setSection = vi.fn(async () => undefined)
    const steer = vi.fn()
    const steps: InitSteps = { ...realSteps({ setSection, steer }), ...over.steps }
    const tavern = { ...(await openTavern(dir)), ...(over.access ? { access: over.access } : {}) }
    const run = () => initialize({
      tavern, entry, sessionId: 's1', houseRules: 'RULES', theme, now, limits: { ...limits, ...over.limits },
    }, steps)
    return { entry, setSection, steer, run }
  }
  const sessionOf = async () => (await readSession(sessionsFile(dir), 's1')).record
  const chatDirs = async () => (await fs.readdir(path.join(dir, 'chats')).catch(() => [])) as string[]

  it('成功：五步都做了，第一次见面', async () => {
    await writeMe(dir, '我是老板。')
    await writeWorld(dir, '小镇。')
    const t = await setup()
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', name: '白狐', notes: [], failed: [] })
    if (o.kind !== 'started') throw new Error()
    expect(await chatDirs()).toHaveLength(1)
    expect(await sessionOf()).toMatchObject({ mode: 'chat', state: 'chatting', chatId: o.chatId, characterId: o.characterId })
    const mem = await readMemory(memFileOf(t.entry))
    expect(mem.index).toEqual([{ date: '2026-10-09', kind: 'chat', title: null, id: o.chatId }])
    // 提示词：五段齐全
    expect(t.setSection).toHaveBeenCalledTimes(1)
    const text = (t.setSection.mock.calls[0] as unknown as [string])[0]
    for (const tag of ['house_rules', 'world', 'card', 'profile', 'core_memory']) expect(text).toContain(`<${tag}>`)
    expect(text).toContain('RULES')
    expect(text).toContain('白狐：你好')
    expect(text).toContain('我是老板。')
    expect(text).toContain('未整理')
    // 开场指令：第一次见面
    expect(t.steer).toHaveBeenCalledTimes(1)
    expect(t.steer.mock.calls[0]![0]).toBe(buildStartCue(true))
  })

  it('以前聊过：开场指令不同，记忆在提示词里', async () => {
    const t = await setup()
    await appendIndexLine(memFileOf(t.entry), { date: '2026-09-01', kind: 'chat', id: 'old1' }, { characterName: '白狐' })
    const o = await t.run()
    expect(o.kind).toBe('started')
    expect(t.steer.mock.calls[0]![0]).toBe(buildStartCue(false))
    expect((t.setSection.mock.calls[0] as unknown as [string])[0]).toContain('old1')
    expect((await readMemory(memFileOf(t.entry))).index).toHaveLength(2)
  })

  it('提醒项照常初始化：档案为空、记忆超限、世界观超预算', async () => {
    await writeWorld(dir, '界'.repeat(30))
    const t = await setup({ limits: { memoryMaxChars: 5, worldBudget: 10 } })
    await appendIndexLine(memFileOf(t.entry), { date: '2026-09-01', kind: 'chat', id: 'old1' }, { characterName: '白狐' })
    const o = await t.run()
    expect(o.kind === 'started' && o.notes.map((n) => n.kind)).toEqual(['profile-empty', 'memory-over', 'world-over'])
    expect(await chatDirs()).toHaveLength(1)
    // 档案为空时段保留
    expect((t.setSection.mock.calls[0] as unknown as [string])[0]).toContain('<profile>')
  })

  it('酒馆只读：不初始化，盘上无改动', async () => {
    const t = await setup({ access: 'readonly' })
    expect(await t.run()).toMatchObject({ kind: 'refused', why: 'readonly' })
    expect(await chatDirs()).toHaveLength(0)
    expect(await sessionOf()).toBeNull()
  })

  it('坏卡：不初始化', async () => {
    await fs.mkdir(path.join(dir, 'characters', '坏'), { recursive: true })
    const bad = (await entriesOf()).find((e) => !e.ok)!
    const o = await initialize({ tavern: await openTavern(dir), entry: bad, sessionId: 's1', houseRules: '', theme, now, limits },
      realSteps({ setSection: vi.fn(), steer: vi.fn() }))
    expect(o).toMatchObject({ kind: 'refused', why: 'broken' })
    expect(await chatDirs()).toHaveLength(0)
  })

  it('第 1 步读取失败：refused，盘上无改动', async () => {
    await fs.mkdir(path.join(dir, 'world.md'))
    const t = await setup()
    expect(await t.run()).toMatchObject({ kind: 'refused', why: 'read-failed' })
    expect(await chatDirs()).toHaveLength(0)
    expect(await sessionOf()).toBeNull()
  })

  it('第 2 步建聊天目录失败：refused，仍在选角', async () => {
    const t = await setup({ steps: { createChat: vi.fn().mockRejectedValue(new Error('disk')) } })
    expect(await t.run()).toMatchObject({ kind: 'refused', why: 'chat-dir-failed', detail: 'disk' })
    expect(await sessionOf()).toBeNull()
    expect((await readMemory(memFileOf(t.entry))).index).toEqual([])
    expect(t.setSection).not.toHaveBeenCalled()
    expect(t.steer).not.toHaveBeenCalled()
  })

  it('第 3 步存会话失败：refused，刚建的目录被清掉', async () => {
    const t = await setup({ steps: { saveSession: vi.fn().mockRejectedValue(new Error('io')) } })
    expect(await t.run()).toMatchObject({ kind: 'refused', why: 'session-failed' })
    expect(await chatDirs()).toHaveLength(0)
    expect(await sessionOf()).toBeNull()
    expect(t.setSection).not.toHaveBeenCalled()
  })

  it('第 3 步会话已在聊天中：already-chatting，目录清掉', async () => {
    await saveSession(sessionsFile(dir), 's1', { mode: 'chat', state: 'chatting', chatId: 'zzzz', characterId: 'c_x' })
    const t = await setup()
    expect(await t.run()).toMatchObject({ kind: 'refused', why: 'already-chatting' })
    expect(await chatDirs()).toHaveLength(0)
    expect((await sessionOf())!.chatId).toBe('zzzz')
  })

  it('第 4 步索引失败：状态已不可逆，继续 5、6', async () => {
    const t = await setup({ steps: { appendIndexLine: vi.fn().mockRejectedValue(new Error('x')) } })
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', failed: ['index'] })
    expect((await sessionOf())!.state).toBe('chatting')
    expect(t.setSection).toHaveBeenCalled()
    expect(t.steer).toHaveBeenCalled()
  })

  it('第 5 步换段失败：started，failed 含 prompt，不发开场指令', async () => {
    const t = await setup()
    t.setSection.mockRejectedValue(new Error('reg'))
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', failed: ['prompt'] })
    expect((await sessionOf())!.state).toBe('chatting')
    expect((await readMemory(memFileOf(t.entry))).index).toHaveLength(1)
    expect(t.steer).not.toHaveBeenCalled()
    expect(startedToolText(o)).toContain('not done: prompt')
  })

  it('第 5 步重读记忆失败也算 prompt 失败', async () => {
    const t = await setup({ steps: { readMemoryText: vi.fn().mockRejectedValue(new Error('r')) } })
    expect(await t.run()).toMatchObject({ kind: 'started', failed: ['prompt'] })
  })

  it('第 6 步开场指令失败：started，failed 含 opening', async () => {
    const t = await setup()
    t.steer.mockImplementation(() => { throw new Error('no steer') })
    expect(await t.run()).toMatchObject({ kind: 'started', failed: ['opening'] })
    expect(t.setSection).toHaveBeenCalled()
  })

  it('工具返回文字', async () => {
    const t = await setup()
    const o = await t.run()
    expect(startedToolText(o)).toMatch(/^started with c_/)
    expect(startedToolText({ kind: 'refused', why: 'already-chatting' })).toBe('already chatting')
  })
})

// ---------- 命令与工具 ----------

describe('startHandler / startTool', () => {
  const registered: string[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  let steered: string[]
  let ask: ReturnType<typeof vi.fn>
  let preset: string | undefined
  let sections: SessionSections

  const envOf = (rt = rtOf()): ChatEnv => ({
    rt, sections, gate: new SessionGate(), getAsk: () => ask as unknown as AskFn,
    getServices: () => services, now: () => new Date(2026, 9, 9),
  })
  const services = { agentPresets: { composedPreset: () => preset } }
  const agent: HostAgent = {
    id: 's1',
    get ctx() { return {} },
    session: { get header() { return { cwd: dir } }, deriveMessages: () => [] },
    steer: (m: unknown) => { steered.push(JSON.stringify(m)) },
  }
  beforeEach(() => {
    registered.length = 0
    disposers.length = 0
    steered = []
    preset = 'tavern-chat'
    ask = vi.fn()
    const rt = rtOf()
    sections = new SessionSections(rt.log, (_a, text) => {
      registered.push(text)
      const d = vi.fn()
      disposers.push(d)
      return d
    })
  })

  const inv = async (env: ChatEnv, args: string): Promise<Invocation> => ({
    agent, services, rt: env.rt, theme, context: await buildContext(agent, services), args, label: '/aha 开场',
    steer: (text: string) => { steered.push(text) },
  })
  const run = async (args: string, env = envOf()) => startHandler(env)(await inv(env, args))
  const sessionOf = async () => (await readSession(sessionsFile(dir), 's1')).record

  it('开场 名字：精确匹配即开聊', async () => {
    await addChar('白狐')
    await addChar('青衫')
    const r = await run('白狐')
    expect(r.text).toContain('白狐')
    expect(r.text).toContain('开始了')
    expect((await sessionOf())!.state).toBe('chatting')
    expect(registered).toHaveLength(1)
    expect(registered[0]).toContain('白狐的设定')
    expect(steered).toHaveLength(1)
    expect(ask).not.toHaveBeenCalled()
  })

  it('前缀唯一则采用；有歧义列候选；没有则说明', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    await addChar('青衫')
    expect((await run('青')).text).toContain('开始了')
  })
  it('歧义与没有', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const amb = await run('白')
    expect(amb.text).toContain('白狐')
    expect(amb.text).toContain('白鹿')
    expect(await sessionOf()).toBeNull()
    const none = await run('黑猫')
    expect(none.text).toContain('黑猫')
    expect(none.text).toContain('白狐')
    expect(registered).toHaveLength(0)
    expect(steered).toHaveLength(0)
  })
  it('名字对上坏卡：说明哪个文件什么问题', async () => {
    await addChar('白狐')
    await fs.mkdir(path.join(dir, 'characters', '坏卡'), { recursive: true })
    const r = await run('坏卡')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('坏卡')
    expect(r.text).toContain('character.yaml')
    expect(await sessionOf()).toBeNull()
  })
  it('没有任何角色、全是坏卡', async () => {
    expect((await run('')).text).toContain('酒馆:筹备')
    await fs.mkdir(path.join(dir, 'characters', '坏'), { recursive: true })
    const r = await run('')
    expect(r.text).toContain('坏')
    expect(ask).not.toHaveBeenCalled()
  })

  it('不带名字：弹卡片，最近聊过的在前，选中即开聊', async () => {
    const a = await addChar('甲角')
    await addChar('乙角')
    const c = await addChar('丙角')
    const es = await goodOf()
    await appendIndexLine(memFileOf(es.find((e) => e.card.id === c.id)!), { date: '2026-10-01', kind: 'chat', id: 'aaaa' }, { characterName: '丙角' })
    void a
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['乙角'] }] }))
    const r = await run('')
    const q = ask.mock.calls[0]![0].questions[0]
    expect(q.options[0].label).toBe('丙角')
    expect(q.options).toHaveLength(3)
    expect(r.text).toContain('乙角')
    expect((await sessionOf())!.characterId).toBe((await goodOf()).find((e) => e.card.name === '乙角')!.card.id)
  })
  it('只有一个角色也弹卡片', async () => {
    await addChar('独角')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['独角'] }] }))
    expect((await run('')).text).toContain('开始了')
    expect(ask).toHaveBeenCalledTimes(1)
  })
  it('跳过、没选：取消，不改动', async () => {
    await addChar('甲角')
    ask.mockResolvedValue({ answers: [] })
    const r = await run('')
    expect(r.text).toContain('取消')
    expect(await sessionOf()).toBeNull()
    expect(registered).toHaveLength(0)
  })
  it('自由输入按角色名匹配（规格 11）', async () => {
    await addChar('甲角')
    await addChar('乙角')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: [], custom: '乙' }] }))
    expect((await run('')).text).toContain('乙角')
    expect((await sessionOf())!.state).toBe('chatting')
  })
  it('超过一页：点更多… 翻到下一批', async () => {
    for (let i = 0; i < 14; i++) await addChar(`角${String(i).padStart(2, '0')}`)
    ask.mockImplementationOnce(async (req) => ({ answers: [{ id: req.questions[0].id, selected: [OPT_MORE] }] }))
      .mockImplementationOnce(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['角13'] }] }))
    const r = await run('')
    expect(ask).toHaveBeenCalledTimes(2)
    expect(r.text).toContain('角13')
  })
  it('卡片被中止：取消；卡片服务不可用：说明', async () => {
    await addChar('甲角')
    ask.mockRejectedValue(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    expect((await run('')).text).toContain('取消')
    const env = envOf()
    env.getAsk = () => undefined
    const r = await startHandler(env)(await inv(env, ''))
    expect(r.kind).toBe('error')
  })
  it('第 5 步失败：回执如实说明，不回到选角', async () => {
    await addChar('甲角')
    const rt = rtOf()
    sections = new SessionSections(rt.log, () => { throw new Error('reg') })
    const r = await run('甲角', envOf(rt))
    expect(r.text).toContain('已经开始')
    expect(r.text).toContain('提示词没装好')
    expect((await sessionOf())!.state).toBe('chatting')
    expect(steered).toHaveLength(0)
  })

  it('aha_start：按 id 开聊；之后再调用返回 already chatting', async () => {
    const c = await addChar('白狐')
    const env = envOf()
    const tool = startTool(env)
    expect(await tool(agent, { id: c.id })).toBe(`started with ${c.id}`)
    expect(steered).toHaveLength(1)
    expect(registered[0]).toContain('<card>')
    expect(await tool(agent, { id: c.id })).toBe('already chatting')
    expect(await startHandler(env)(await inv(env, '白狐'))).toBeDefined()
    expect(steered).toHaveLength(1)
  })
  it('aha_start：id 与 name 都给时以 id 为准；只给 name 走同一套匹配', async () => {
    const a = await addChar('白狐')
    await addChar('青衫')
    expect(await startTool(envOf())(agent, { id: a.id, name: '青衫' })).toBe(`started with ${a.id}`)
  })
  it('aha_start：只给 name；失败给原因和现有名字', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const tool = startTool(envOf())
    expect(await tool(agent, { name: '白' })).toMatch(/ambiguous.*白狐.*白鹿|ambiguous.*白鹿.*白狐/)
    expect(await tool(agent, { name: '黑' })).toMatch(/no character named 黑; available:/)
    expect(await tool(agent, { id: 'c_nope' })).toMatch(/no character with id c_nope/)
    expect(await sessionOf()).toBeNull()
    expect(await tool(agent, { name: '白狐' })).toMatch(/^started with c_/)
  })
  it('aha_start：没有角色、不在单聊模式、没有 agent', async () => {
    const tool = startTool(envOf())
    expect(await tool(agent, { name: 'x' })).toMatch(/no characters/)
    preset = 'tavern-setup'
    expect(await tool(agent, { name: 'x' })).toMatch(/not available/)
    expect(await tool(undefined, { name: 'x' })).toMatch(/not ready/)
  })
  it('aha_start：两个并发调用只有一个开聊', async () => {
    const a = await addChar('白狐')
    await addChar('青衫')
    const tool = startTool(envOf())
    const [r1, r2] = await Promise.all([tool(agent, { id: a.id }), tool(agent, { name: '青衫' })])
    expect([r1, r2].filter((r) => r.startsWith('started'))).toHaveLength(1)
    expect([r1, r2]).toContain('already chatting')
    expect(await fs.readdir(path.join(dir, 'chats'))).toHaveLength(1)
  })

  it('chatPlan：选角阶段是掌柜的段；开聊后恢复会话装五段；模式不对跳过', async () => {
    const c = await addChar('白狐')
    await writeMe(dir, '我是老板。')
    const env = envOf()
    const plan = (a = agent) => chatPlan(env, a, services, theme)()
    const pick = await plan()
    expect(pick).toMatchObject({ kind: 'text' })
    if (pick.kind !== 'text') throw new Error()
    expect(pick.text).toContain('aha_start')
    expect(pick.text).toContain(`id: ${c.id} | name: 白狐`)
    expect(pick.text).not.toContain('<house_rules>')

    await startTool(env)(agent, { id: c.id })
    const chatting = await plan()
    if (chatting.kind !== 'text') throw new Error()
    for (const tag of ['house_rules', 'card', 'profile', 'core_memory']) expect(chatting.text).toContain(`<${tag}>`)
    expect(chatting.text).not.toContain('<world>\n')
    expect(chatting.text).toContain('我是老板。')
    expect(chatting.text).toContain('不要调用 aha_start')

    preset = 'tavern-setup'
    expect(await plan()).toMatchObject({ kind: 'skip' })
    preset = undefined
    expect(await plan()).toEqual({ kind: 'wait' })
  })
  it('chatPlan：门外的会话也是掌柜的段', async () => {
    const outside: HostAgent = { id: 's9', ctx: {}, session: { header: { cwd: path.join(dir, 'nowhere') } } }
    const p = await chatPlan(envOf(), outside, services, theme)()
    if (p.kind !== 'text') throw new Error()
    expect(p.text).toContain('place: outside (not-tavern)')
  })
  it('档案文件仍可读（没被改动）', async () => {
    await writeMe(dir, '我')
    await addChar('白狐')
    await run('白狐')
    expect((await readMe(dir)).text).toBe('我')
    expect((await listCharacters(dir)).length).toBe(1)
  })
  // ---------- 第 1 轮修复 ----------
  it('命令：gate 内复查——同一会话连敲两次开场，第二次不弹卡', async () => {
    await addChar('甲角')
    await addChar('乙角')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['甲角'] }] }))
    const env = envOf()
    const h = startHandler(env)
    const [i1, i2] = [await inv(env, ''), await inv(env, '')]
    const [r1, r2] = await Promise.all([h(i1), h(i2)])
    expect(r1.text).toContain('开始了')
    expect(r2.text).toContain('新开')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(path.join(dir, 'chats'))).toHaveLength(1)
  })
  it('命令：只读酒馆在弹卡之前拦下', async () => {
    await addChar('甲角')
    const env = envOf()
    const i = await inv(env, '')
    i.context = { ...i.context, tavern: { ...i.context.tavern!, access: 'readonly' } }
    // gate 内按盘上重新读取：把版本改新
    await fs.writeFile(path.join(dir, 'aha-tavern.yaml'), 'version: 99\nid: t_1\nname: 甲\n')
    const r = await startHandler(env)(i)
    expect(r.text).toContain('比插件新')
    expect(ask).not.toHaveBeenCalled()
  })
  it('chatPlan：角色卡读不出来时降级为固定段，不扮演角色，且不被当成已完成', async () => {
    const c = await addChar('白狐')
    const env = envOf()
    await startTool(env)(agent, { id: c.id })
    const cardFile = path.join((await goodOf())[0]!.dir, 'character.yaml')
    const good = await fs.readFile(cardFile, 'utf8')
    await fs.writeFile(cardFile, ':::bad: [')
    sections.forget('s1')
    registered.length = 0
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    expect(registered).toHaveLength(1)
    expect(registered[0]).toContain('不要扮演')
    expect(registered[0]).not.toContain('<card>\n')
    // 同一原因再规划：不重复注册，日志只记一次
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    expect(registered).toHaveLength(1)
    expect((env.rt.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter((x) => String(x[0]).includes('读不出来'))).toHaveLength(1)
    expect(env.rt.log.error).not.toHaveBeenCalled()
    // 修好后恢复五段
    await fs.writeFile(cardFile, good)
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    expect(registered).toHaveLength(2)
    expect(registered[1]).toContain('<card>')
  })
  it('chatPlan：记录里没有角色编号也降级', async () => {
    await addChar('白狐')
    await saveSession(sessionsFile(dir), 's1', { mode: 'chat', state: 'chatting', chatId: 'zzzz' })
    const p = await chatPlan(envOf(), agent, services, theme)()
    expect(p).toMatchObject({ kind: 'text', temporary: true })
  })
  it('chatPlan：聊天目录被删——降级（与卡读不出来的文字不同），只 warn 一次，目录回来后恢复五段', async () => {
    const c = await addChar('白狐')
    const env = envOf()
    await startTool(env)(agent, { id: c.id })
    const chats = path.join(dir, 'chats')
    const chatDir = path.join(chats, (await fs.readdir(chats))[0]!)
    await fs.rename(chatDir, `${chatDir}.moved`)
    sections.forget('s1')
    registered.length = 0
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    expect(registered).toHaveLength(1)
    expect(registered[0]).toContain('不要扮演')
    expect(registered[0]).toContain('记录目录不见了')
    expect(registered[0]).toContain('新开一个会话')
    expect(registered[0]).not.toContain('读不出来')
    expect(registered[0]).not.toContain('<card>\n')
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    expect(registered).toHaveLength(1)
    expect((env.rt.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter((x) => String(x[0]).includes('聊天目录'))).toHaveLength(1)
    await fs.rename(`${chatDir}.moved`, chatDir)
    await sections.ensure(agent, chatPlan(env, agent, services, theme))
    expect(registered).toHaveLength(2)
    expect(registered[1]).toContain('<card>')
  })
  it('失败步骤与"还有 N 位"走主题称呼', async () => {
    const marked = { ...theme, concept: (id: string) => `〈${id}〉`, action: (id: string) => `《${id}》` } as unknown as Theme
    const r = startedReceipt(marked, { kind: 'started', chatId: 'a', characterId: 'c', name: 'n', notes: [], failed: ['index'] })
    expect(r.text).toContain('〈core_memory〉')
    expect(r.text).not.toContain('往事索引')
  })

})
