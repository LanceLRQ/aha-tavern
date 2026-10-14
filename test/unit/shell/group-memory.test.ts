// 群聊记忆（#3wa4、二期规格 §11）的单元测试。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, MEMORY_FILE, saveCharacter } from '../../../src/core/card'
import { createChat, readShowSummary, writeShowSummary } from '../../../src/core/chat'
import { appendIndexLine, readMemory } from '../../../src/core/memory'
import { readSession, saveSession } from '../../../src/core/state'
import { createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { SessionGate, type AskFn } from '../../../src/shell/confirm'
import { buildContext, sessionsFile, type HostAgent, type HostServices, type Invocation } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { SessionSections } from '../../../src/shell/sections'
import { GroupTranscriptRecorder, type GroupTarget } from '../../../src/shell/group-transcript'
import {
  castByScene, groupRememberHandler, groupRememberTool, groupRecallTool, groupReviewTool,
  parseGroupRecallArgs, parseGroupRememberArgs, parseGroupReviewArgs, type GroupMemoryEnv,
} from '../../../src/shell/group-memory'
import type { GroupEnv } from '../../../src/shell/group'
import { RememberTurns } from '../../../src/shell/remember'
import { ReviewReminder } from '../../../src/core/reminder'
import { voiceRuntimeStubs } from './helpers/runtime'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let dir: string
let chatId: string
let chatDir: string
let target: GroupTarget
let rt: Runtime
let recorder: GroupTranscriptRecorder
let memEnv: GroupMemoryEnv

beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-gmem-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
  for (const name of ['白狐', '青衫', '墨鸦']) await saveCharacter(dir, { name, persona: `${name}的设定` })
  const all = (await listCharacters(dir)).filter((e) => e.ok).map((e) => (e as { card: { id: string; name: string } }).card)
  const fox = all.find((c) => c.name === '白狐')!
  const gown = all.find((c) => c.name === '青衫')!
  const chat = await createChat(dir, {
    kind: 'group', name: '群聊', participants: [fox.id, gown.id], sessionId: 's1',
    now: new Date(2026, 9, 10, 20, 0), scenario: '生日', present: [fox.id, gown.id],
  })
  chatId = chat.id
  chatDir = chat.dir
  await saveSession(sessionsFile(dir), 's1', { mode: 'group', state: 'performing', chatId })
  const known = (await listCharacters(dir)).filter((e) => e.ok).map((e) => ({ id: (e as { card: { id: string } }).card.id, name: (e as { card: { name: string } }).card.name }))
  target = { tavernDir: dir, chatId, known, narratorLabels: ['旁白'] }
  rt = {
    config: { ...DEFAULTS, mode: 'group', registryPath: path.join(dir, '.reg.yaml') },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined,
    theme: async () => theme, handlers: {}, ...voiceRuntimeStubs,
  } as Runtime
  recorder = new GroupTranscriptRecorder({ resolve: async () => target, log: rt.log })
  memEnv = {
    rt, getServices: () => services,
    turns: new RememberTurns(), recallTurns: new RememberTurns(),
    reminder: new ReviewReminder(30), recorder,
  }
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function idOfName(name: string): string {
  throw new Error('用 aidOfName')
}
async function aidOfName(name: string): Promise<{ id: string; dir: string }> {
  const hit = (await listCharacters(dir)).find((e) => e.ok && e.card.name === name)
  if (!hit || !hit.ok) throw new Error(`没有 ${name}`)
  return { id: hit.card.id, dir: hit.dir }
}

const services: HostServices = { agentPresets: { composedPreset: () => 'tavern-group' } }
const agent: HostAgent = { id: 's1', ctx: {}, session: { get header() { return { cwd: dir } } } }
const remember = (a: HostAgent | undefined, args: unknown): Promise<string> => groupRememberTool(memEnv)(a, args)
const recall = (a: HostAgent | undefined, args: unknown): Promise<string> => groupRecallTool(memEnv)(a, args)
const review = (a: HostAgent | undefined, args: unknown): Promise<string> => groupReviewTool(memEnv)(a, args)

describe('参数解析', () => {
  it('随手记：who 与 text 必填', () => {
    expect(parseGroupRememberArgs({ who: ['白狐'], text: ' 记住 ' })).toEqual({ who: ['白狐'], text: '记住' })
    expect(parseGroupRememberArgs({ who: ['白狐', '白狐'], text: 'x' })).toEqual({ who: ['白狐'], text: 'x' })
    expect(parseGroupRememberArgs({ text: 'x' })).toMatch(/^error: who/)
    expect(parseGroupRememberArgs({ who: ['白狐'] })).toMatch(/^error: text/)
  })
  it('回忆：who 与 id 必填', () => {
    expect(parseGroupRecallArgs({ who: '白狐', id: 'a1b2' })).toEqual({ who: '白狐', id: 'a1b2' })
    expect(parseGroupRecallArgs({ id: 'a1b2' })).toMatch(/^error: who/)
    expect(parseGroupRecallArgs({ who: '白狐' })).toMatch(/^error: id/)
  })
  it('整理：scene_summary 与 members 必填，长度受限', () => {
    expect(parseGroupReviewArgs({ scene_summary: '梗概', members: [{ name: '白狐', facts: ['a'] }] }))
      .toEqual({ sceneSummary: '梗概', members: [{ name: '白狐', facts: ['a'] }] })
    expect(parseGroupReviewArgs({ members: [{ name: '白狐' }] })).toMatch(/^error: scene_summary/)
    expect(parseGroupReviewArgs({ scene_summary: 's', members: [] })).toMatch(/^error: members/)
    expect(parseGroupReviewArgs({ scene_summary: 's', members: [{ name: '白狐', facts: [''] }] })).toMatch(/facts of 白狐/)
  })
})

describe('castByScene', () => {
  it('分界带各场景的名单；场景一用开场名单', () => {
    const casts = castByScene([
      { type: 'scene', scene: 2, cast: ['c1'] },
      { type: 'scene', scene: 3, cast: ['c1', 'c3'] },
    ], ['c1', 'c2'])
    expect(casts.get(1)).toEqual(['c1', 'c2'])
    expect(casts.get(2)).toEqual(['c1'])
    expect(casts.get(3)).toEqual(['c1', 'c3'])
  })
})

describe('groupRememberTool', () => {
  it('指明谁记住了：写进各自的 facts；每轮最多一次', async () => {
    const out = await remember(agent, { who: ['白狐', '青衫'], text: 'user 的生日是十月十日' })
    expect(out).toBe('remembered for 白狐, 青衫')
    for (const name of ['白狐', '青衫']) {
      const { dir: cdir } = await aidOfName(name)
      expect((await readMemory(path.join(cdir, MEMORY_FILE))).facts).toContain('user 的生日是十月十日')
    }
    const again = await remember(agent, { who: ['白狐'], text: '又一件' })
    expect(again).toBe('already remembered this turn')
  })
  it('不在场的角色记不了', async () => {
    const out = await remember(agent, { who: ['墨鸦'], text: 'x' })
    expect(out).toContain('no character named 墨鸦 on stage')
    expect(out).toContain('白狐')
  })
})

describe('groupRecallTool', () => {
  it('不在自己索引里的编号：not remembered by', async () => {
    const out = await recall(agent, { who: '白狐', id: chatId })
    expect(out).toBe(`not remembered by 白狐`)
  })
  it('群聊：只返回该角色在场的场景；缺梗概的场景用原文节选补', async () => {
    const fox = await aidOfName('白狐')
    const gown = await aidOfName('青衫')
    // 单独一场：白狐先在，场景二青衫才加入
    const chat2 = await createChat(dir, {
      kind: 'group', name: '群聊', participants: [fox.id], sessionId: 's1',
      now: new Date(2026, 9, 11, 20, 0), present: [fox.id],
    })
    await fs.appendFile(path.join(chat2.dir, 'chat.jsonl'), [
      JSON.stringify({ time: 't', type: 'narrator', scene: 1, text: '大堂里点起灯。' }),
      JSON.stringify({ time: 't', type: 'character', speaker: fox.id, scene: 1, text: '来喝一杯。' }),
      JSON.stringify({ time: 't', type: 'scene', scene: 2, text: '后院', cast: [fox.id, gown.id] }),
      JSON.stringify({ time: 't', type: 'character', speaker: gown.id, scene: 2, text: '蚊子真多。' }),
    ].map((l) => `${l}\n`).join(''))
    // 只给场景二写梗概；场景一缺，用节选补
    await writeShowSummary(dir, chat2.id, { title: null, scenes: [{ index: 2, title: '后院', cast: ['白狐', '青衫'], text: '两人在后院聊天。' }] })
    await appendIndexLine(path.join(fox.dir, MEMORY_FILE), { date: '2026-10-11', kind: 'group', id: chat2.id }, { characterName: '白狐' })
    const out = await recall(agent, { who: '白狐', id: chat2.id })
    expect(out).toContain('场景二：后院')
    expect(out).toContain('两人在后院聊天。')
    expect(out).toContain('场景一')
    expect(out).toContain('大堂里点起灯')
    // 青衫不在场景一：她的回忆只有场景二
    await appendIndexLine(path.join(gown.dir, MEMORY_FILE), { date: '2026-10-11', kind: 'group', id: chat2.id }, { characterName: '青衫' })
    memEnv.recallTurns.onStep('s1', 2, 1)  // 换一轮，青衫才能回忆
    const out2 = await recall(agent, { who: '青衫', id: chat2.id })
    expect(out2).toContain('场景二')
    expect(out2).not.toContain('场景一')
  })
  it('每轮最多回忆一次', async () => {
    const fox = await aidOfName('白狐')
    await appendIndexLine(path.join(fox.dir, MEMORY_FILE), { date: '2026-10-10', kind: 'group', id: chatId }, { characterName: '白狐' })
    await recall(agent, { who: '白狐', id: chatId })
    const again = await recall(agent, { who: '白狐', id: chatId })
    expect(again).toBe('already recalled this turn')
  })
})

describe('groupReviewTool', () => {
  it('当前场景梗概入档（保留已有标题），各角色前几栏更新', async () => {
    await writeShowSummary(dir, chatId, { title: null, scenes: [{ index: 1, title: '开场', cast: ['白狐'], text: '旧梗概' }] })
    const out = await review(agent, {
      scene_summary: '新梗概。',
      members: [{ name: '白狐', impression: '话少心软。', facts: ['爱喝梅子酒'] }],
    })
    expect(out).toContain('reviewed')
    expect(out).toContain('白狐')
    const show = await readShowSummary(dir, chatId)
    expect(show.scenes[0]).toEqual({ index: 1, title: '开场', cast: ['白狐', '青衫'], text: '新梗概。' })
    const { dir: cdir } = await aidOfName('白狐')
    const mem = await readMemory(path.join(cdir, MEMORY_FILE))
    expect(mem.impression).toContain('话少心软')
    expect(mem.facts).toContain('爱喝梅子酒')
  })
})

describe('groupRememberHandler（命令）', () => {
  const env: GroupEnv = {
    rt: undefined as never, sections: undefined as never, gate: new SessionGate(),
    getAsk: () => undefined, getServices: () => services, now: () => new Date(),
    recorder: undefined as never, declinedScenes: new Map(),
  }
  const run = async (args: string): Promise<{ kind: string; text?: string; steered: string[] }> => {
    const steered: string[] = []
    const handler = groupRememberHandler(memEnv)
    const reply = await handler({
      agent, services, rt, theme, context: await buildContext(agent, services),
      args, label: '/aha 记住', steer: (t: string) => { steered.push(t) },
    } as unknown as Invocation)
    return { ...reply, steered }
  }
  it('不带内容：转告整理（aha_review）', async () => {
    const r = await run('')
    expect(r.steered).toHaveLength(1)
    expect(r.steered[0]).toContain('aha_review')
    expect(r.steered[0]).toContain('scene_summary')
  })
  it('记住 内容：在场每个人都记', async () => {
    const r = await run('明天一起去后山')
    expect(r.text).toContain('白狐')
    expect(r.text).toContain('青衫')
    for (const name of ['白狐', '青衫']) {
      const { dir: cdir } = await aidOfName(name)
      expect((await readMemory(path.join(cdir, MEMORY_FILE))).pinned).toContain('明天一起去后山')
    }
    const { dir: cdir } = await aidOfName('墨鸦')
    expect((await readMemory(path.join(cdir, MEMORY_FILE))).pinned).toEqual([])
  })
  it('记住 @谁 内容：只记 TA', async () => {
    const r = await run('@青衫 账算你头上')
    expect(r.text).toContain('青衫')
    expect(r.text).not.toContain('白狐')
    const gown = await aidOfName('青衫')
    const fox = await aidOfName('白狐')
    expect((await readMemory(path.join(gown.dir, MEMORY_FILE))).pinned).toContain('账算你头上')
    expect((await readMemory(path.join(fox.dir, MEMORY_FILE))).pinned).toEqual([])
  })
})
