// 群聊开局（#dplo）的单元测试：拆参数、匹配、卡片、开局流程、初始化、提示词段。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, MEMORY_FILE, saveCharacter } from '../../../src/core/card'
import { readChatMeta } from '../../../src/core/chat'
import { writeMe, writeWorld } from '../../../src/core/docs'
import { readMemory } from '../../../src/core/memory'
import { readSession, saveSession } from '../../../src/core/state'
import { openTavern, createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import houseRulesGroupText from '../../../src/prompts/house-rules-group.md'
import hostGatherText from '../../../src/prompts/host-gather.md'
import { SessionGate, type AskFn } from '../../../src/shell/confirm'
import { buildContext, sessionsFile, type HostAgent, type HostServices } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { SessionSections } from '../../../src/shell/sections'
import { voiceRuntimeStubs } from './helpers/runtime'
import {
  buildCastQuestion, buildGroupConfirmQuestion, CONFIRM_ROUNDS_MAX, groupStartHandler, initializeGroup,
  interpretCastAnswer, interpretGroupConfirm, matchGroupNames, realGroupSteps, resolveGroupStart,
  splitOpeningArgs, type GroupEnv, type GroupInitSteps,
} from '../../../src/shell/group'
import type { GoodEntry } from '../../../src/shell/chat'
import { buildGatherPrompt, buildGroupPrompt, buildGroupStartCue, renderCharactersSection } from '../../../src/shell/group-prompt'
import { parseGroupStartArgs } from '../../../src/shell/group-tools'
import { narratorHandler } from '../../../src/shell/group-commands'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let dir: string
beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-group-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const rtOf = (over: Partial<Runtime['config']> = {}): Runtime => ({
  config: { ...DEFAULTS, mode: 'group', registryPath: path.join(dir, '.reg.yaml'), ...over },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined, theme: async () => theme, handlers: {}, ...voiceRuntimeStubs,
}) as Runtime

const addChar = async (name: string, extra: Record<string, string> = {}) =>
  (await saveCharacter(dir, { name, persona: `${name}的设定`, greeting: `${name}：你好`, ...extra })).card
const entriesOf = () => listCharacters(dir)
const goodOf = async (): Promise<GoodEntry[]> => (await entriesOf()).filter((e): e is GoodEntry => e.ok)
const memFileOf = (e: GoodEntry) => path.join(e.dir, MEMORY_FILE)

// ---------- 纯函数 ----------

describe('splitOpeningArgs', () => {
  it('开头的名字逐个吃掉，剩下的整段是情景', async () => {
    await addChar('白狐')
    await addChar('青衫')
    const entries = await entriesOf()
    expect(splitOpeningArgs(entries, '白狐 青衫 今天我过生日')).toEqual({ names: ['白狐', '青衫'], scenario: '今天我过生日' })
    expect(splitOpeningArgs(entries, '白狐、青衫，今天我过生日')).toEqual({ names: ['白狐', '青衫'], scenario: '今天我过生日' })
  })
  it('第一个词就对不上名字：整句算情景', async () => {
    await addChar('白狐')
    const entries = await entriesOf()
    expect(splitOpeningArgs(entries, '叫上白狐，今天我过生日')).toEqual({ names: [], scenario: '叫上白狐，今天我过生日' })
  })
  it('只给名字：情景为空', async () => {
    await addChar('白狐')
    const entries = await entriesOf()
    expect(splitOpeningArgs(entries, '白狐')).toEqual({ names: ['白狐'], scenario: '' })
  })
  it('只给情景', async () => {
    await addChar('白狐')
    const entries = await entriesOf()
    expect(splitOpeningArgs(entries, '今天我过生日')).toEqual({ names: [], scenario: '今天我过生日' })
  })
})

describe('matchGroupNames', () => {
  it('精确、前缀、包含都命中；保序去重', async () => {
    await addChar('白狐')
    await addChar('白狐妖')
    await addChar('青衫')
    const entries = await entriesOf()
    expect(matchGroupNames(entries, ['白狐妖', '青'])).toMatchObject({ kind: 'ok' })
    const ok = matchGroupNames(entries, ['青衫', '青衫', '白狐'])
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.entries.map((e) => e.card.name)).toEqual(['青衫', '白狐'])
  })
  it('对不上与歧义', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const entries = await entriesOf()
    expect(matchGroupNames(entries, ['黑猫'])).toMatchObject({ kind: 'none', name: '黑猫' })
    expect(matchGroupNames(entries, ['白'])).toMatchObject({ kind: 'ambiguous', name: '白' })
  })
})

describe('定人与复述卡片', () => {
  it('多选卡片：全部好卡都列出来，支持多选', async () => {
    await addChar('白狐', { tagline: '守夜人' })
    await addChar('青衫')
    const q = buildCastQuestion(theme, await goodOf())
    expect(q.item.multiSelect).toBe(true)
    expect(q.item.options.map((o) => o.label).sort()).toEqual(['白狐', '青衫'])
    expect(q.item.options[0]).toMatchObject({ label: '白狐', description: '守夜人' })
    expect(q.byLabel.get('白狐')).toBeTruthy()
  })
  it('回答解释：选中的映射成编号；自由输入重拆；跳过与空选都是取消', async () => {
    await addChar('白狐')
    const q = buildCastQuestion(theme, await goodOf())
    const id = q.byLabel.get('白狐')!
    expect(interpretCastAnswer({ answers: [{ id: q.item.id, selected: ['白狐'] }] }, q.byLabel)).toEqual({ kind: 'ids', ids: [id] })
    expect(interpretCastAnswer({ answers: [{ id: q.item.id, custom: '白狐 今天我过生日' }] }, q.byLabel)).toEqual({
      kind: 'custom', text: '白狐 今天我过生日',
    })
    expect(interpretCastAnswer({ answers: [] }, q.byLabel)).toEqual({ kind: 'cancel' })
    expect(interpretCastAnswer({ answers: [{ id: q.item.id, selected: [] }] }, q.byLabel)).toEqual({ kind: 'cancel' })
  })
  it('复述卡片：列出人与情景；开场、取消、自由输入', () => {
    const item = buildGroupConfirmQuestion(theme, ['白狐', '青衫'], '今天我过生日')
    expect(item.question).toContain('白狐、青衫')
    expect(item.question).toContain('今天我过生日')
    expect(item.options.map((o) => o.label)).toEqual(['开场', '取消'])
    expect(interpretGroupConfirm({ answers: [{ id: item.id, selected: ['开场'] }] })).toEqual({ kind: 'start' })
    expect(interpretGroupConfirm({ answers: [{ id: item.id, selected: ['取消'] }] })).toEqual({ kind: 'cancel' })
    expect(interpretGroupConfirm({ answers: [{ id: item.id, custom: '改成明天过生日' }] })).toEqual({
      kind: 'custom', text: '改成明天过生日',
    })
  })
})

describe('resolveGroupStart', () => {
  let ask: ReturnType<typeof vi.fn>
  const services: HostServices = { agentPresets: { composedPreset: () => 'tavern-group' } }
  const agent: HostAgent = { id: 's1', ctx: {}, session: { header: { cwd: dir } } }
  const envOf = (rt = rtOf()): GroupEnv => ({
    rt, sections: new SessionSections(rt.log, () => () => undefined), gate: new SessionGate(),
    getAsk: () => ask as unknown as AskFn, getServices: () => services, now: () => new Date(2026, 9, 9, 10, 30),
  })
  beforeEach(() => {
    ask = vi.fn()
  })

  it('名字与情景都给：复述确认后 ready', async () => {
    await addChar('白狐')
    await addChar('青衫')
    ask.mockResolvedValue({ answers: [{ selected: ['开场'] }] })
    const r = await resolveGroupStart(envOf(), { agent, theme }, await entriesOf(), {
      names: ['白狐', '青衫'], scenario: '今天我过生日',
    })
    expect(r).toMatchObject({ kind: 'ready', scenario: '今天我过生日' })
    if (r.kind !== 'ready') throw new Error()
    expect(r.entries.map((e) => e.card.name)).toEqual(['白狐', '青衫'])
    const q = ask.mock.calls[0]![0].questions[0]
    expect(q.question).toContain('白狐、青衫')
    expect(q.question).toContain('今天我过生日')
  })
  it('确认时写自由输入：当作改过的情景再确认一轮', async () => {
    await addChar('白狐')
    ask.mockResolvedValueOnce({ answers: [{ custom: '改成明天过生日' }] })
    ask.mockResolvedValueOnce({ answers: [{ selected: ['开场'] }] })
    const r = await resolveGroupStart(envOf(), { agent, theme }, await entriesOf(), {
      names: ['白狐'], scenario: '今天我过生日',
    })
    expect(r).toMatchObject({ kind: 'ready', scenario: '改成明天过生日' })
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1]![0].questions[0].question).toContain('改成明天过生日')
  })
  it('改的次数太多按取消', async () => {
    await addChar('白狐')
    ask.mockResolvedValue({ answers: [{ custom: '再改一次' }] })
    const r = await resolveGroupStart(envOf(), { agent, theme }, await entriesOf(), {
      names: ['白狐'], scenario: '今天我过生日',
    })
    expect(r).toEqual({ kind: 'cancelled' })
    expect(ask).toHaveBeenCalledTimes(CONFIRM_ROUNDS_MAX)
  })
  it('只给名字：need-scenario，不弹卡片', async () => {
    await addChar('白狐')
    const r = await resolveGroupStart(envOf(), { agent, theme }, await entriesOf(), { names: ['白狐'] })
    expect(r).toMatchObject({ kind: 'need-scenario' })
    expect(ask).not.toHaveBeenCalled()
  })
  it('没给名字：弹多选卡片定人', async () => {
    await addChar('白狐')
    await addChar('青衫')
    ask.mockImplementationOnce(async (req: { questions: Array<{ id: string }> }) => ({
      answers: [{ id: req.questions[0]!.id, selected: ['白狐', '青衫'] }],
    })).mockResolvedValueOnce({ answers: [{ selected: ['开场'] }] })
    const r = await resolveGroupStart(envOf(), { agent, theme }, await entriesOf(), { scenario: '今天我过生日' })
    expect(r).toMatchObject({ kind: 'ready' })
    const cast = ask.mock.calls[0]![0].questions[0]
    expect(cast.multiSelect).toBe(true)
  })
  it('超过在场上限：请减人', async () => {
    await addChar('白狐')
    await addChar('青衫')
    await addChar('墨鸦')
    const r = await resolveGroupStart(envOf(rtOf({ groupCastMax: 2 })), { agent, theme }, await entriesOf(), {
      names: ['白狐', '青衫', '墨鸦'], scenario: '团圆',
    })
    expect(r).toEqual({ kind: 'over-limit', count: 3, max: 2 })
  })
  it('名字对不上与歧义', async () => {
    await addChar('白狐')
    await addChar('白鹿')
    const entries = await entriesOf()
    expect(await resolveGroupStart(envOf(), { agent, theme }, entries, { names: ['黑猫'], scenario: 'x' }))
      .toMatchObject({ kind: 'name-none', name: '黑猫' })
    expect(await resolveGroupStart(envOf(), { agent, theme }, entries, { names: ['白'], scenario: 'x' }))
      .toMatchObject({ kind: 'name-ambiguous' })
  })
  it('名字对上坏卡：说明哪个目录', async () => {
    await addChar('白狐')
    await fs.mkdir(path.join(dir, 'characters', '坏卡'), { recursive: true })
    const r = await resolveGroupStart(envOf(), { agent, theme }, await entriesOf(), { names: ['坏卡'], scenario: 'x' })
    expect(r).toMatchObject({ kind: 'bad-card' })
  })
  it('卡片不可用且没给名字：no-card', async () => {
    await addChar('白狐')
    const env = envOf()
    env.getAsk = () => undefined
    expect(await resolveGroupStart(env, { agent, theme }, await entriesOf(), {})).toEqual({ kind: 'no-card' })
  })
})

// ---------- 初始化 ----------

describe('initializeGroup', () => {
  const limits = { worldBudget: 4000, memoryMaxChars: 3000, pastIndexMaxLines: 100 }
  const now = new Date(2026, 9, 9, 10, 30)

  async function setup(over: { steps?: Partial<GroupInitSteps>; limits?: Partial<typeof limits>; access?: 'readonly' } = {}) {
    const e1 = await addChar('白狐')
    const e2 = await addChar('青衫')
    const entries = await goodOf()
    const setSection = vi.fn(async () => undefined)
    const steer = vi.fn()
    const steps: GroupInitSteps = { ...realGroupSteps({ setSection, steer }), ...over.steps }
    const tavern = { ...(await openTavern(dir)), ...(over.access ? { access: over.access } : {}) }
    const run = (extra: { warn?: (m: string) => void } = {}) => initializeGroup({
      tavern, entries, scenario: '今天我过生日', sessionId: 's1', houseRules: 'RULES', theme, now,
      limits: { ...limits, ...over.limits }, ...extra,
    }, steps)
    return { ids: [e1.id, e2.id], entries, setSection, steer, run }
  }
  const sessionOf = async () => (await readSession(sessionsFile(dir), 's1')).record

  it('成功：目录、会话、往事索引、提示词、开场指令都做了', async () => {
    await writeMe(dir, '我是老板。')
    await writeWorld(dir, '小镇。')
    const t = await setup()
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', names: ['白狐', '青衫'], scenario: '今天我过生日', notes: [], failed: [] })
    if (o.kind !== 'started') throw new Error()
    expect(await sessionOf()).toMatchObject({ mode: 'group', state: 'performing', chatId: o.chatId })
    const meta = await readChatMeta(dir, o.chatId)
    expect(meta.kind).toBe('group')
    expect(meta.scenario).toBe('今天我过生日')
    expect(meta.participants).toEqual(t.ids)
    expect(meta.present).toEqual(t.ids)
    // 群聊初始化就写往事索引：每人一行，标未整理
    for (const e of t.entries) {
      const mem = await readMemory(memFileOf(e))
      expect(mem.index).toEqual([{ date: '2026-10-09', kind: 'group', title: null, id: o.chatId }])
    }
    // 提示词：五段齐全，情景与每个角色一段
    expect(t.setSection).toHaveBeenCalledTimes(1)
    const text = (t.setSection.mock.calls[0] as unknown as [string])[0]
    for (const tag of ['house_rules', 'world', 'scenario', 'profile', 'characters']) expect(text).toContain(`<${tag}>`)
    expect(text).toContain('今天我过生日')
    expect(text).toContain('白狐的设定')
    expect(text).toContain('青衫的设定')
    expect(text).toContain('我是老板。')
    expect((text.match(/<character>/g) ?? []).length).toBe(2)
    // 开场指令
    expect(t.steer).toHaveBeenCalledTimes(1)
    expect(t.steer.mock.calls[0]![0]).toBe(buildGroupStartCue())
  })

  it('重复初始化同一个会话：already-performing（往事索引不会被第二次追加）', async () => {
    const t = await setup()
    expect((await t.run()).kind).toBe('started')
    const second = await t.run()
    expect(second).toEqual({ kind: 'refused', why: 'already-performing' })
    const mem = await readMemory(memFileOf(t.entries[0]!))
    expect(mem.index).toHaveLength(1)
  })

  it('读失败：盘上无改动', async () => {
    await fs.mkdir(path.join(dir, 'world.md'))
    const t = await setup()
    const o = await t.run()
    expect(o).toEqual({ kind: 'refused', why: 'read-failed', detail: expect.any(String) })
    expect(await sessionOf()).toBeNull()
  })

  it('建目录失败：拒绝；存会话失败：删掉刚建的目录', async () => {
    const t1 = await setup({ steps: { createChat: async () => { throw new Error('盘满') } } })
    expect(await t1.run()).toEqual({ kind: 'refused', why: 'chat-dir-failed', detail: '盘满' })
    const removed: string[] = []
    await initializeGroup({
      tavern: await openTavern(dir), entries: t1.entries, scenario: 'x', sessionId: 's1', houseRules: 'R', theme, now, limits,
    }, {
      ...realGroupSteps({ setSection: t1.setSection, steer: t1.steer }),
      saveSession: async () => { throw new Error('锁住了') },
      removeDir: async (d) => { removed.push(d) },
    })
    expect(removed).toHaveLength(1)
  })

  it('只读酒馆：拒绝', async () => {
    const t = await setup({ access: 'readonly' })
    expect(await t.run()).toEqual({ kind: 'refused', why: 'readonly' })
  })

  it('往事索引写不上：记为没做成的步骤，其余照常', async () => {
    const t = await setup({ steps: { appendIndexLine: async () => { throw new Error('只读') } } })
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', failed: ['index'] })
    expect(t.steer).toHaveBeenCalledTimes(1)
  })

  it('提示词装不上：不再发开场指令', async () => {
    const t = await setup({ steps: { setSection: async () => { throw new Error('段失败') } } })
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'started', failed: ['prompt'] })
    expect(t.steer).not.toHaveBeenCalled()
  })

  it('提醒项：档案为空、角色记忆超限、世界观超预算', async () => {
    await writeWorld(dir, '界'.repeat(30))
    await addChar('白狐')
    await addChar('青衫')
    const entries = await goodOf()
    for (const e of entries) await fs.writeFile(memFileOf(e), '字'.repeat(30))
    const o = await initializeGroup({
      tavern: await openTavern(dir), entries, scenario: 'x', sessionId: 's1', houseRules: 'R', theme, now,
      limits: { worldBudget: 20, memoryMaxChars: 5, pastIndexMaxLines: 100 },
    }, realGroupSteps({ setSection: async () => undefined, steer: vi.fn() }))
    expect(o.kind).toBe('started')
    if (o.kind !== 'started') throw new Error()
    expect(o.notes).toEqual([
      { kind: 'profile-empty' },
      { kind: 'world-over', chars: 30, budget: 20 },
      { kind: 'memory-over', name: '白狐', chars: 30, max: 5 },
      { kind: 'memory-over', name: '青衫', chars: 30, max: 5 },
    ])
  })
})

// ---------- 命令 ----------

describe('groupStartHandler', () => {
  const registered: string[] = []
  let steered: string[]
  let ask: ReturnType<typeof vi.fn>
  let preset: string | undefined
  let sections: SessionSections
  const services: HostServices = { agentPresets: { composedPreset: () => preset } }
  const agent: HostAgent = {
    id: 's1',
    get ctx() { return {} },
    session: { get header() { return { cwd: dir } }, deriveMessages: () => [] },
    steer: (m: unknown) => { steered.push(JSON.stringify(m)) },
  }
  const envOf = (rt = rtOf()): GroupEnv => ({
    rt, sections, gate: new SessionGate(), getAsk: () => ask as unknown as AskFn,
    getServices: () => services, now: () => new Date(2026, 9, 9),
  })
  beforeEach(() => {
    steered = []
    preset = 'tavern-group'
    ask = vi.fn()
    const rt = rtOf()
    sections = new SessionSections(rt.log, (_a, text) => {
      registered.push(text)
      return () => undefined
    })
  })

  const inv = async (env: GroupEnv, args: string) => ({
    agent, services, rt: env.rt, theme, context: await buildContext(agent, services),
    args, label: '/aha 开场', steer: (text: string) => { steered.push(text) },
  })
  const run = async (args: string, env = envOf()) => groupStartHandler(env)(await inv(env, args))
  const sessionOf = async () => (await readSession(sessionsFile(dir), 's1')).record

  it('开场 名字… 情景：确认后一场开始', async () => {
    await addChar('白狐')
    await addChar('青衫')
    ask.mockResolvedValue({ answers: [{ selected: ['开场'] }] })
    const r = await run('白狐 青衫 今天我过生日')
    expect(r.text).toContain('白狐、青衫')
    expect(r.text).toContain('今天我过生日')
    expect((await sessionOf())!.state).toBe('performing')
    expect(registered).toHaveLength(1)
    expect(registered[0]).toContain('白狐的设定')
    expect(steered).toHaveLength(1)
  })

  it('只说人没说情景：回执请用户补情景', async () => {
    await addChar('白狐')
    const r = await run('白狐')
    expect(r.text).toContain('人齐了')
    expect(r.text).toContain('情景')
    expect(await sessionOf()).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('只说情景：弹多选卡片定人，确认后开始', async () => {
    await addChar('白狐')
    await addChar('青衫')
    ask.mockImplementationOnce(async (req: { questions: Array<{ id: string }> }) => ({
      answers: [{ id: req.questions[0]!.id, selected: ['青衫'] }],
    })).mockResolvedValueOnce({ answers: [{ selected: ['开场'] }] })
    const r = await run('今天我过生日')
    expect(r.text).toContain('青衫')
    expect((await sessionOf())!.state).toBe('performing')
    const meta = await readChatMeta(dir, (await sessionOf())!.chatId!)
    expect(meta.present).toEqual([(await goodOf()).find((e) => e.card.name === '青衫')!.card.id])
  })

  it('取消：不开始', async () => {
    await addChar('白狐')
    ask.mockResolvedValue({ answers: [{ selected: ['取消'] }] })
    const r = await run('白狐 生日')
    expect(r.text).toContain('取消')
    expect(await sessionOf()).toBeNull()
  })

  it('已在场景中：回执去新会话', async () => {
    await addChar('白狐')
    await saveSession(sessionsFile(dir), 's1', { mode: 'group', state: 'performing', chatId: 'c9d9' })
    const r = await run('白狐 生日')
    expect(r.text).toContain('新开一个会话')
  })
})

// ---------- 提示词与参数 ----------

describe('群聊提示词与工具参数', () => {
  it('renderCharactersSection：每人一个 character，卡与记忆都在', async () => {
    const card = (await addChar('白狐')) as unknown as GoodEntry['card']
    const text = renderCharactersSection([{ card, memory: '记得上次的酒钱' }])
    expect(text).toContain('<characters>')
    expect(text).toContain('<character>')
    expect(text).toContain('name: 白狐')
    expect(text).toContain('记得上次的酒钱')
  })
  it('buildGroupPrompt：世界观空则省略，其余段固定', () => {
    const card = { id: 'x1', name: '白狐', persona: '设定' } as unknown as GoodEntry['card']
    const text = buildGroupPrompt({
      theme, houseRules: '规则', world: '  ', scenario: '生日', profile: '', members: [{ card, memory: '' }],
    })
    expect(text).toContain('<house_rules>')
    expect(text).toContain('规则')
    expect(text).not.toContain('<world>')
    expect(text).toContain('<scenario>')
    expect(text).toContain('生日')
    expect(text).toContain('(empty: the user has not written a profile yet; do not invent one)')
    expect(text).toContain('(empty)')
    expect(text).toContain('<glossary>')
  })
  it('buildGatherPrompt：人设、指引、状态事实、对照表', () => {
    const text = buildGatherPrompt(theme, hostGatherText, {
      place: { kind: 'inside', name: '甲' }, characterCount: 3, brokenCards: [], profile: { empty: true, length: 0 }, castMax: 5,
    })
    expect(text).toContain('<gather_state>')
    expect(text).toContain('characters: 3')
    expect(text).toContain('cast_max: 5')
    expect(text).toContain(hostGatherText.trim().slice(0, 10))
  })
  it('开场指令：点名旁白、格式与不替用户说话', () => {
    const cue = buildGroupStartCue()
    expect(cue).toContain('narrator')
    expect(cue).toContain('【旁白】')
    expect(cue).toContain('不替 user 说话')
  })
  it('parseGroupStartArgs：数组去空保序去重，情景去空白', () => {
    expect(parseGroupStartArgs({ names: ['白狐', ' ', '白狐', '青衫'], scenario: ' 生日 ' }))
      .toEqual({ names: ['白狐', '青衫'], scenario: '生日' })
    expect(parseGroupStartArgs({})).toEqual({})
    expect(parseGroupStartArgs({ names: '白狐' })).toMatch(/^error: /)
    expect(parseGroupStartArgs({ names: [1] })).toMatch(/^error: /)
    expect(parseGroupStartArgs({ scenario: 3 })).toMatch(/^error: /)
    expect(parseGroupStartArgs('x')).toMatch(/^error: /)
  })
  it('提示词文件与规则段：群聊规则提到回复格式', () => {
    expect(houseRulesGroupText).toContain('【旁白】')
    expect(houseRulesGroupText).toContain('不替 user 说话')
  })
})

// ---------- 旁白命令（#8l8e） ----------

describe('narratorHandler', () => {
  const agent: HostAgent = { id: 's1', ctx: {}, session: { get header() { return { cwd: dir } } } }
  const run = async (args: string) => {
    const steered: string[] = []
    const wrote: string[] = []
    const handler = narratorHandler({ recorder: { writeNarratorRequest: async (_a: unknown, text: string) => { wrote.push(text) } } as never })
    const reply = await handler({
      agent, services: { agentPresets: { composedPreset: () => 'tavern-group' } } as never, rt: rtOf(), theme,
      context: null as never, args, label: '/aha 旁白', steer: (t: string) => { steered.push(t) },
    })
    return { reply, steered, wrote }
  }
  it('不带参数：说明用法，不转告不落盘', async () => {
    const r = await run('')
    expect(r.reply.text).toContain('/aha 旁白')
    expect(r.steered).toHaveLength(0)
    expect(r.wrote).toHaveLength(0)
  })
  it('带要求：先落盘旁白要求，再转告模型；通知只给旁白、声明场景内有效', async () => {
    const r = await run('让气氛紧张一点')
    expect(r.wrote).toEqual(['让气氛紧张一点'])
    expect(r.steered).toHaveLength(1)
    expect(r.steered[0]).toContain('让气氛紧张一点')
    expect(r.steered[0]).toContain('narrator_request')
    expect(r.steered[0]).toContain('当前场景内持续有效')
    expect(r.reply.text).toContain('已转告旁白')
  })
})
