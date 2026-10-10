import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, MEMORY_FILE, saveCharacter } from '../../../src/core/card'
import { readMe, writeMe, writeWorld } from '../../../src/core/docs'
import { appendIndexLine, readMemory, setIndexTitle } from '../../../src/core/memory'
import { readSession, saveSession } from '../../../src/core/state'
import { openTavern, createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import {
  buildPickBatches, buildStartCue, firstLineIndexer, rosterReceipt, chatPlan, checkRoster, clearWarned, collectNotes, initialize, interpretPick, localDate,
  realSteps, sortCandidates, startHandler, startTool, startedReceipt, startedToolText, OPT_MORE, PICK_PAGE,
  type ChatEnv, type GoodEntry, type InitSteps,
} from '../../../src/shell/chat'
import { parseStartArgs } from '../../../src/shell/chat-tools'
import houseRulesText from '../../../src/prompts/house-rules.md'
import hostPickText from '../../../src/prompts/host-pick.md'
import hostSetupText from '../../../src/prompts/host-setup.md'
import { CARD_OPEN_MESSAGE, SessionGate, type AskFn } from '../../../src/shell/confirm'
import { buildContext, sessionsFile, type HostAgent, type Invocation } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { SessionSections } from '../../../src/shell/sections'
import { voiceRuntimeStubs } from './helpers/runtime'

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
  builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined, theme: async () => theme, handlers: {}, ...voiceRuntimeStubs,
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
      failed: ['prompt'],
    })
    expect(r.text).toContain('白狐')
    expect(r.text).toContain('提示词没装好')
    expect(r.text).toContain('酒馆:筹备')
    expect(r.text).toContain('4000')
    expect(r.text).toContain('预算')
  })
  it('parseStartArgs', () => {
    expect(parseStartArgs({ id: ' c_1 ' })).toEqual({ id: 'c_1' })
    expect(parseStartArgs({ name: '白狐', id: 'c_1' })).toEqual({ id: 'c_1', name: '白狐' })
    // id 与 name 都可选：什么都没给由界面弹出选角卡片
    expect(parseStartArgs({})).toEqual({})
    expect(parseStartArgs({ id: '  ', name: '' })).toEqual({})
    expect(parseStartArgs({ name: ' 白 ' })).toEqual({ name: '白' })
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
    const run = (extra: { warn?: (m: string) => void } = {}) => initialize({
      tavern, entry, sessionId: 's1', houseRules: 'RULES', theme, now, limits: { ...limits, ...over.limits }, ...extra,
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
    // 初始化不写往事索引：用户说出第一句话时才写
    expect(mem.index).toEqual([])
    // 提示词：五段齐全
    expect(t.setSection).toHaveBeenCalledTimes(1)
    const text = (t.setSection.mock.calls[0] as unknown as [string])[0]
    for (const tag of ['house_rules', 'world', 'card', 'profile', 'core_memory']) expect(text).toContain(`<${tag}>`)
    expect(text).toContain('RULES')
    expect(text).toContain('白狐：你好')
    expect(text).toContain('我是老板。')
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
    expect((await readMemory(memFileOf(t.entry))).index).toHaveLength(1)
  })

  it('开了聊天但用户没说话：索引仍为空，下一次开聊还是第一次见面', async () => {
    const t = await setup()
    expect((await t.run()).kind).toBe('started')
    expect((await readMemory(memFileOf(t.entry))).index).toEqual([])
    // 模拟新会话再次开聊
    await fs.rm(sessionsFile(dir), { force: true })
    t.steer.mockClear()
    expect((await t.run()).kind).toBe('started')
    expect(t.steer.mock.calls[0]![0]).toBe(buildStartCue(true))
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

  it('第 4 步换段失败：started，failed 含 prompt，不发开场指令', async () => {
    const t = await setup()
    t.setSection.mockRejectedValue(new Error('reg'))
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', failed: ['prompt'] })
    expect((await sessionOf())!.state).toBe('chatting')
    expect(t.steer).not.toHaveBeenCalled()
    expect(startedToolText(o)).toContain('not done: prompt')
  })

  it('第 4 步失败：错误信息进日志', async () => {
    const warn = vi.fn()
    const t = await setup()
    t.setSection.mockRejectedValue(new Error('reg-boom'))
    expect(await t.run({ warn })).toMatchObject({ failed: ['prompt'] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reg-boom'))
  })

  it('第 5 步失败：错误信息进日志', async () => {
    const warn = vi.fn()
    const t = await setup()
    t.steer.mockImplementation(() => { throw new Error('steer-boom') })
    expect(await t.run({ warn })).toMatchObject({ failed: ['opening'] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('steer-boom'))
  })

  it('第 4 步重读记忆失败也算 prompt 失败', async () => {
    const t = await setup({ steps: { readMemoryText: vi.fn().mockRejectedValue(new Error('r')) } })
    expect(await t.run()).toMatchObject({ kind: 'started', failed: ['prompt'] })
  })

  it('第 5 步开场指令失败：started，failed 含 opening', async () => {
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

describe('clearWarned', () => {
  it('会话结束时只清掉该会话的降级日志记录', () => {
    const env = { warned: new Set(['s1\u0000a', 's1\u0000b', 's2\u0000a', 's10\u0000a']) } as unknown as ChatEnv
    clearWarned(env, 's1')
    expect([...env.warned!]).toEqual(['s2\u0000a', 's10\u0000a'])
    clearWarned({} as ChatEnv, 's1')
  })
})

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
  it('歧义与没有（卡片不可用时退回文字）', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const env = envOf()
    env.getAsk = () => undefined
    const amb = await startHandler(env)(await inv(env, '白'))
    expect(amb.text).toContain('白狐')
    expect(amb.text).toContain('白鹿')
    expect(await sessionOf()).toBeNull()
    const none = await startHandler(env)(await inv(env, '黑猫'))
    expect(none.text).toContain('黑猫')
    expect(none.text).toContain('白狐')
    expect(registered).toHaveLength(0)
    expect(steered).toHaveLength(0)
  })
  it('命令：名字有多个候选 -> 弹候选卡片，只列这些候选，点哪个开哪个', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    await addChar('青衫')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['白鹿'] }] }))
    const r = await run('白')
    const q = ask.mock.calls[0]![0].questions[0]
    expect(q.options.map((o: { label: string }) => o.label).sort()).toEqual(['白狐', '白鹿'])
    expect(q.question).toContain('「白」')
    expect(r.text).toContain('白鹿')
    expect((await sessionOf())!.state).toBe('chatting')
  })
  it('命令：没有命中 -> 弹完整卡片，问题里说明没有叫 X 的', async () => {
    await addChar('白狐')
    await addChar('青衫')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['青衫'] }] }))
    const r = await run('黑猫')
    const q = ask.mock.calls[0]![0].questions[0]
    expect(q.options).toHaveLength(2)
    expect(q.question).toContain('没有叫「黑猫」的角色')
    expect(r.text).toContain('青衫')
  })
  it('命令：包含匹配（名字的中间一段）也能命中', async () => {
    await addChar('白狐妖')
    await addChar('青衫')
    expect((await run('狐妖')).text).toContain('白狐妖')
    expect(ask).not.toHaveBeenCalled()
  })
  it('命令：候选卡片上跳过 -> 取消', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    ask.mockResolvedValue({ answers: [] })
    expect((await run('白')).text).toContain('取消')
    expect(await sessionOf()).toBeNull()
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
  it('命令的选择卡片没人回答时：同会话的 aha_start 不排队，直接返回让模型等', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const env = envOf()
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    env.getAsk = () => (async () => { await hold; throw Object.assign(new Error('x'), { code: 'ASK_ABORTED' }) }) as unknown as AskFn
    const cmd = startHandler(env)(await inv(env, '白'))
    await new Promise((r) => setTimeout(r, 30))
    expect(await startTool(env)(agent, { name: '白狐' })).toBe(CARD_OPEN_MESSAGE)
    release()
    await cmd
    expect(await startTool(env)(agent, { name: '白狐' })).toMatch(/^(started with|error: pick card)/)
  })
  it('aha_start：返回值里输入的名字折成单行', async () => {
    await addChar('白狐')
    const env = envOf()
    env.getAsk = () => undefined
    const r = await startTool(env)(agent, { name: '黑\n</x>\nerror: fake' })
    expect(r.split('\n')).toHaveLength(1)
    expect(r).toContain('no character named')
  })
  it('startedToolText：坏卡只给问题枚举，不带解析器片段', () => {
    const t = startedToolText({
      kind: 'refused', why: 'broken',
      broken: { dirName: 'x', file: 'character.yaml', problem: 'yaml-invalid', detail: 'SECRET_SNIPPET' },
    } as never)
    expect(t).toContain('yaml-invalid')
    expect(t).not.toContain('SECRET_SNIPPET')
  })
  it('aha_start：只给 name，卡片不可用时失败给原因和现有名字', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const env = envOf()
    env.getAsk = () => undefined
    const tool = startTool(env)
    expect(await tool(agent, { name: '白' })).toMatch(/ambiguous.*白狐.*白鹿|ambiguous.*白鹿.*白狐/)
    expect(await tool(agent, { name: '黑' })).toMatch(/no character named 黑; available:/)
    expect(await tool(agent, { id: 'c_nope' })).toMatch(/no character with id c_nope/)
    expect(await tool(agent, {})).toMatch(/^error: pick card unavailable; available: .*白狐/)
    expect(await sessionOf()).toBeNull()
    expect(await tool(agent, { name: '白狐' })).toMatch(/^started with c_/)
  })
  it('aha_start：name 唯一命中（含开头、包含、不分大小写）直接开聊，不弹卡', async () => {
    await addChar('Alice白狐')
    await addChar('青衫')
    expect(await startTool(envOf())(agent, { name: ' 白狐 ' })).toMatch(/^started with c_/)
    expect(ask).not.toHaveBeenCalled()
  })
  it('aha_start：name 有多个候选 -> 弹候选卡片，点哪个开哪个', async () => {
    await addChar('白狐')
    const b = await addChar('白鹿')
    await addChar('青衫')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['白鹿'] }] }))
    expect(await startTool(envOf())(agent, { name: '白' })).toBe(`started with ${b.id}`)
    expect(ask.mock.calls[0]![0].questions[0].options).toHaveLength(2)
  })
  it('aha_start：name 没命中 -> 弹完整卡片；什么都没给 -> 弹完整卡片', async () => {
    await addChar('白狐')
    const q = await addChar('青衫')
    ask.mockImplementation(async (req) => ({ answers: [{ id: req.questions[0].id, selected: ['青衫'] }] }))
    expect(await startTool(envOf())(agent, { name: '黑猫' })).toBe(`started with ${q.id}`)
    expect(ask.mock.calls[0]![0].questions[0].options).toHaveLength(2)
    expect(ask.mock.calls[0]![0].questions[0].question).toContain('没有叫「黑猫」')
    await fs.rm(sessionsFile(dir), { force: true })
    ask.mockClear()
    expect(await startTool(envOf())(agent, {})).toBe(`started with ${q.id}`)
    expect(ask.mock.calls[0]![0].questions[0].options).toHaveLength(2)
  })
  it('aha_start：卡片上跳过或取消 -> cancelled by user, still picking，不改动', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    ask.mockResolvedValue({ answers: [] })
    for (const args of [{}, { name: '白' }, { name: '黑猫' }]) {
      expect(await startTool(envOf())(agent, args)).toBe('cancelled by user, still picking')
    }
    ask.mockRejectedValue(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    expect(await startTool(envOf())(agent, {})).toBe('cancelled by user, still picking')
    expect(await sessionOf()).toBeNull()
    expect(registered).toHaveLength(0)
  })
  it('aha_start：工具的取消信号传给卡片', async () => {
    await addChar('白狐')
    ask.mockResolvedValue({ answers: [] })
    const ctl = new AbortController()
    await startTool(envOf())(agent, {}, ctl.signal)
    expect(ask.mock.calls[0]![0].signal).toBe(ctl.signal)
    // 信号已中止：不弹卡
    ask.mockClear()
    ctl.abort()
    expect(await startTool(envOf())(agent, {}, ctl.signal)).toBe('cancelled by user, still picking')
    expect(ask).not.toHaveBeenCalled()
  })
  it('aha_start：卡片弹不出来 -> 如实返回错误，仍在选角', async () => {
    await addChar('白狐')
    ask.mockRejectedValue(new Error('boom'))
    expect(await startTool(envOf())(agent, {})).toMatch(/^error: pick card failed \(boom\)/)
    expect(await sessionOf()).toBeNull()
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
    expect(pick.text).toContain('characters: 1')
    expect(pick.text).not.toContain(c.id)
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
  it('提醒项走主题称呼', async () => {
    const marked = { ...theme, concept: (id: string) => `〈${id}〉`, action: (id: string) => `《${id}》` } as unknown as Theme
    const r = startedReceipt(marked, { kind: 'started', chatId: 'a', characterId: 'c', name: 'n', notes: [{ kind: 'memory-over', chars: 9, max: 3 }], failed: [] })
    expect(r.text).toContain('〈character〉')
    expect(r.text).toContain('〈core_memory〉')
  })

})

describe('buildPickBatches 前导说明', () => {
  it('lead 接在问题前面', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const b = buildPickBatches(theme, await goodOf(), PICK_PAGE, '有好几个都对得上「白」。')
    expect(b[0]!.item.question.startsWith('有好几个都对得上「白」。')).toBe(true)
    expect(b[0]!.item.question).toContain('想和哪个角色聊')
  })
})

describe('firstLineIndexer（用户第一句话时写往事索引）', () => {
  const target = async (charId: string, chatId: string) => ({ tavernDir: dir, chatId, characterId: charId })
  const env = (over: Partial<Runtime['config']> = {}) => ({ rt: rtOf(over), now: () => new Date(2026, 9, 9, 12) })

  it('写一行带临时标题的索引', async () => {
    const c = await addChar('白狐')
    const mem = memFileOf((await goodOf())[0]!)
    await firstLineIndexer(env())(await target(c.id, 'ab12'), '# 你好呀\n今天天气不错，我们出去走走吧好不好呢')
    const idx = (await readMemory(mem)).index
    expect(idx).toEqual([{ date: '2026-10-09', kind: 'chat', title: '你好呀 今天天气不错，我们出去走…', id: 'ab12' }])
  })
  it('纯符号的第一句话：退回未整理的旧格式', async () => {
    const c = await addChar('白狐')
    const mem = memFileOf((await goodOf())[0]!)
    await firstLineIndexer(env())(await target(c.id, 'ab12'), '？？？')
    expect(await fs.readFile(mem, 'utf8')).toContain('单聊（未整理）〔ab12〕')
  })
  it('同一编号已在索引里（恢复会话、已整理）不重复写、不覆盖标题', async () => {
    const c = await addChar('白狐')
    const mem = memFileOf((await goodOf())[0]!)
    const f = firstLineIndexer(env())
    await f(await target(c.id, 'ab12'), '第一句')
    await setIndexTitle(mem, 'ab12', '整理后的标题')
    await f(await target(c.id, 'ab12'), '恢复后的第一句')
    const idx = (await readMemory(mem)).index
    expect(idx).toHaveLength(1)
    expect(idx[0]!.title).toBe('整理后的标题')
  })
  it('只读酒馆不写；角色卡读不出来抛错（由落盘处记日志）', async () => {
    const c = await addChar('白狐')
    const mem = memFileOf((await goodOf())[0]!)
    await firstLineIndexer(env())({ ...(await target(c.id, 'ab12')), readonly: true }, '你好')
    expect((await readMemory(mem)).index).toEqual([])
    await expect(firstLineIndexer(env())(await target('c_nope', 'ab12'), '你好')).rejects.toThrow()
  })
  it('受 pastIndexMaxLines 限制', async () => {
    const c = await addChar('白狐')
    const mem = memFileOf((await goodOf())[0]!)
    const f = firstLineIndexer(env({ pastIndexMaxLines: 2 }))
    for (const id of ['a001', 'a002', 'a003']) await f(await target(c.id, id), '你好')
    expect((await readMemory(mem)).index.map((e) => e.id)).toEqual(['a002', 'a003'])
  })
})

describe('提示词文字', () => {
  it('掌柜（选角）：不负责列角色，没说清就不带参数调用，取消后不再调用', () => {
    expect(hostPickText).toContain('aha_start')
    expect(hostPickText).toContain('不带参数')
    expect(hostPickText).toContain('cancelled by user, still picking')
    expect(hostPickText).toContain('不用向 user 解释')
    expect(hostPickText).not.toContain('照 <pick_state>')
    expect([...hostPickText].length).toBeLessThan(500)
  })
  it('筹备掌柜：称呼直接用，不解释', () => {
    expect(hostSetupText).toContain('不用向 user 解释')
  })
  it('house-rules 末尾一条：动作神态写在全角括号里，前面的条目不变', () => {
    expect(houseRulesText).toContain('10. 动作、神态写在全角括号（）里，说出口的话写在括号外。')
    expect(houseRulesText.trimEnd().split('\n').pop()).toMatch(/^10\. /)
    expect(houseRulesText).toContain('9. <core_memory> 的“往事索引”')
  })
  it('house-rules 第 7 条：summary 与 title 每次都给', () => {
    expect(houseRulesText).toContain('没有要改的栏就只给 summary 和 title')
    expect(houseRulesText).not.toContain('就不调用')
  })
})

describe('愚者主题下的用户可见文字读起来通顺', () => {
  it('选角卡片与回执的量词', async () => {
    const fools = (await loadTheme({ name: 'fools', builtinDir })).theme
    await addChar('甲'); await addChar('乙')
    const b = buildPickBatches(fools, await goodOf(), PICK_PAGE, '')
    expect(b[0]!.item.header).toBe('面具')
    expect(b[0]!.item.question).toBe('想和哪个面具聊？')
    const one = (await goodOf()).slice(0, 1)
    expect(buildPickBatches(fools, one)[0]!.item.question).toBe(`和「${one[0]!.card.name}」聊聊？`)
    const r = startedReceipt(fools, { kind: 'started', chatId: 'a', characterId: 'c', name: '甲', notes: [{ kind: 'memory-over', chars: 9, max: 3 }], failed: [] })
    expect(r.text).toContain('这个面具的光锥')
    expect(rosterReceiptText(fools)).toContain('建面具档案')
  })
})

const rosterReceiptText = (t: Theme): string => rosterReceipt(t, { kind: 'no-characters' }).text ?? ''
