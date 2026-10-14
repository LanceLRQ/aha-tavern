// 换场与收场（#b5j3、二期规格 §8、§9）的单元测试。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, MEMORY_FILE, saveCharacter } from '../../../src/core/card'
import { createChat, patchChatMeta, readChatMeta, readRecords, readShowSummary } from '../../../src/core/chat'
import { appendIndexLine, readMemory } from '../../../src/core/memory'
import { readSession, saveSession } from '../../../src/core/state'
import { createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { SessionGate, type AskFn } from '../../../src/shell/confirm'
import { buildContext, sessionsFile, type HostAgent, type HostServices } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { SessionSections } from '../../../src/shell/sections'
import { GroupTranscriptRecorder, type GroupTarget } from '../../../src/shell/group-transcript'
import { sceneTool, wrapTool, buildSceneQuestion, interpretSceneAnswer, parseSceneArgs, parseWrapArgs } from '../../../src/shell/group-scene'
import type { GroupEnv } from '../../../src/shell/group'
import { voiceRuntimeStubs } from './helpers/runtime'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let dir: string
let chatId: string
let target: GroupTarget
let ask: ReturnType<typeof vi.fn>
let rebuild: ReturnType<typeof vi.fn>
let env: GroupEnv

beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-scene-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
  const fox = (await saveCharacter(dir, { name: '白狐', persona: 'x' })).card
  const gown = (await saveCharacter(dir, { name: '青衫', persona: 'x' })).card
  const crow = (await saveCharacter(dir, { name: '墨鸦', persona: 'x' })).card
  const chat = await createChat(dir, {
    kind: 'group', name: '群聊', participants: [fox.id, gown.id], sessionId: 's1',
    now: new Date(2026, 9, 10, 20, 0), scenario: '今天我过生日',
  })
  chatId = chat.id
  await saveSession(sessionsFile(dir), 's1', { mode: 'group', state: 'performing', chatId })
  const known = (await listCharacters(dir)).filter((e) => e.ok).map((e) => ({ id: (e as { card: { id: string } }).card.id, name: (e as { card: { name: string } }).card.name }))
  target = { tavernDir: dir, chatId, known, narratorLabels: ['旁白'] }
  ask = vi.fn()
  rebuild = vi.fn(async () => undefined)
  const rt = {
    config: { ...DEFAULTS, mode: 'group', registryPath: path.join(dir, '.reg.yaml') },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined,
    theme: async () => theme, handlers: {}, ...voiceRuntimeStubs,
  } as Runtime
  const recorder = new GroupTranscriptRecorder({ resolve: async () => target, log: rt.log })
  env = {
    rt, sections: new SessionSections(rt.log, () => () => undefined), gate: new SessionGate(),
    getAsk: () => ask as unknown as AskFn, getServices: () => services, now: () => new Date(2026, 9, 10, 21, 0),
    recorder, declinedScenes: new Map(),
  }
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const services: HostServices = { agentPresets: { composedPreset: () => 'tavern-group' } }
const agent: HostAgent = { id: 's1', ctx: {}, session: { get header() { return { cwd: dir } } } }

const scene = (a: HostAgent | undefined, args: unknown, signal?: AbortSignal): Promise<string> => sceneTool(env, { rebuild })(a, args, signal)
const wrap = (a: HostAgent | undefined, args: unknown): Promise<string> => wrapTool(env)(a, args)

const memFileOfName = async (name: string): Promise<string> => {
  const hit = (await listCharacters(dir)).find((e) => e.ok && e.card.name === name)
  if (!hit || !hit.ok) throw new Error(`没有 ${name}`)
  return path.join(hit.dir, MEMORY_FILE)
}

describe('参数与卡片', () => {
  it('parseSceneArgs：summary 与 title 必填，名单去空保序去重', () => {
    expect(parseSceneArgs({ summary: ' 梗概 ', title: ' 后院 ' })).toEqual({ summary: '梗概', title: '后院' })
    expect(parseSceneArgs({ summary: 's', title: 't', endingTitle: ' 夜 ', join: ['墨鸦', '', '墨鸦'], leave: ['青衫'] }))
      .toEqual({ summary: 's', title: 't', endingTitle: '夜', join: ['墨鸦'], leave: ['青衫'] })
    expect(parseSceneArgs({ title: 't' })).toMatch(/^error: summary/)
    expect(parseSceneArgs({ summary: 's' })).toMatch(/^error: title/)
    expect(parseSceneArgs({ summary: 's', title: 't', join: 'x' })).toMatch(/^error: join/)
  })
  it('parseWrapArgs：summary 与 title 必填', () => {
    expect(parseWrapArgs({ summary: 's', title: 't' })).toEqual({ summary: 's', title: 't' })
    expect(parseWrapArgs({})).toMatch(/^error: summary/)
    expect(parseWrapArgs({ summary: 's' })).toMatch(/^error: title/)
  })
  it('换场卡片与回答', () => {
    const q = buildSceneQuestion(theme, { title: '后院夜话', joinNames: ['墨鸦'], leaveNames: ['青衫'] })
    expect(q.question).toContain('后院夜话')
    expect(q.question).toContain('墨鸦加入')
    expect(q.question).toContain('青衫离开')
    expect(interpretSceneAnswer({ answers: [{ id: q.id, selected: ['换场'] }] })).toEqual({ kind: 'change' })
    expect(interpretSceneAnswer({ answers: [{ id: q.id, selected: ['不换场'] }] })).toEqual({ kind: 'stay' })
    expect(interpretSceneAnswer({ answers: [] })).toEqual({ kind: 'stay' })
  })
})

describe('sceneTool', () => {
  it('确认换场：梗概入档、分界落盘、之后的记录归新场景', async () => {
    ask.mockResolvedValue({ answers: [{ selected: ['换场'] }] })
    const out = await scene(agent, { summary: '大堂里布置好了。', title: '后院夜话', endingTitle: '大堂布置' })
    expect(out).toContain('scene changed to "后院夜话"')
    // 梗概：场景一的小节
    const show = await readShowSummary(dir, chatId)
    expect(show.title).toBeNull()
    expect(show.scenes).toEqual([{ index: 1, title: '大堂布置', cast: ['白狐', '青衫'], text: '大堂里布置好了。' }])
    // 分界记录：新场景标题与在场名单
    const records = (await readRecords(dir, chatId)).records
    const idOf = (n: string): string => target.known.find((k) => k.name === n)!.id
    expect(records.at(-1)).toMatchObject({ type: 'scene', text: '后院夜话', scene: 2, cast: [idOf('白狐'), idOf('青衫')] })
    // 新记录归场景二
    await env.recorder.writeNarratorRequest(agent, 'x')
    expect((await readRecords(dir, chatId)).records.at(-1)).toMatchObject({ type: 'narrator-request', scene: 2 })
  })

  it('换场加减人：分界带新名单、新来的写往事索引、meta 更新、重装第 5 段', async () => {
    ask.mockResolvedValue({ answers: [{ selected: ['换场'] }] })
    const out = await scene(agent, { summary: '散了。', title: '夜深', join: ['墨鸦'], leave: ['青衫'] })
    expect(out).toContain('just joined: 墨鸦')
    expect(out).toContain('left: 青衫')
    const meta = await readChatMeta(dir, chatId)
    const idOf = (n: string): string => target.known.find((k) => k.name === n)!.id
    expect(meta.present).toEqual([idOf('白狐'), idOf('墨鸦')])
    expect([...meta.participants].sort()).toEqual([idOf('白狐'), idOf('青衫'), idOf('墨鸦')].sort())
    // 墨鸦的往事索引有这一场的未整理行；青衫的还在（参与过）
    expect((await readMemory(await memFileOfName('墨鸦'))).index).toEqual([
      { date: '2026-10-10', kind: 'group', title: null, id: chatId },
    ])
    expect((await readMemory(await memFileOfName('青衫'))).index).toEqual([])
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('用户不换：同一场景内不再问', async () => {
    ask.mockResolvedValue({ answers: [{ selected: ['不换场'] }] })
    const out = await scene(agent, { summary: 's', title: 't' })
    expect(out).toContain('declined')
    ask.mockResolvedValue({ answers: [{ selected: ['换场'] }] })
    const again = await scene(agent, { summary: 's', title: 't' })
    expect(again).toContain('already declined')
    expect((await readRecords(dir, chatId)).records).toEqual([])
  })

  it('人全走光与不在场的离开都拒绝', async () => {
    expect(await scene(agent, { summary: 's', title: 't', leave: ['白狐', '青衫'] })).toContain('at least one character must stay')
    expect(await scene(agent, { summary: 's', title: 't', leave: ['墨鸦'] })).toContain('not on stage')
  })

  it('超在场上限拒绝', async () => {
    ;(env.rt.config as { groupCastMax: number }).groupCastMax = 2
    expect(await scene(agent, { summary: 's', title: 't', join: ['墨鸦'] })).toContain('too many on stage')
  })

  it('不在场景中或名字对不上：给原因', async () => {
    expect(await scene(agent, { summary: 's', title: 't', join: ['黑猫'] })).toContain('no character named 黑猫')
    await fs.rm(sessionsFile(dir), { force: true })
    expect(await scene(agent, { summary: 's', title: 't' })).toContain('not in a show')
  })
})

describe('wrapTool', () => {
  // 真实流程里 initializeGroup 会写这两行，这里直接补上
  beforeEach(async () => {
    for (const name of ['白狐', '青衫']) {
      await appendIndexLine(await memFileOfName(name), { date: '2026-10-10', kind: 'group', id: chatId, title: null }, { characterName: name })
    }
  })

  it('收场：最后一段梗概与标题、meta 标题、往事索引行换成标题', async () => {
    const out = await wrap(agent, { summary: '吹了蜡烛。', title: '生日派对', endingTitle: '切蛋糕' })
    expect(out).toContain('wrapped with title "生日派对"')
    const show = await readShowSummary(dir, chatId)
    expect(show.title).toBe('生日派对')
    expect(show.started).toBe('2026-10-10')
    expect(show.participants).toEqual(['白狐', '青衫'])
    expect(show.scenes).toEqual([{ index: 1, title: '切蛋糕', cast: ['白狐', '青衫'], text: '吹了蜡烛。' }])
    expect((await readChatMeta(dir, chatId)).title).toBe('生日派对')
    for (const name of ['白狐', '青衫']) {
      expect((await readMemory(await memFileOfName(name))).index).toEqual([
        { date: '2026-10-10', kind: 'group', title: '生日派对', id: chatId },
      ])
    }
    // 没参与的角色没有这一行
    expect((await readMemory(await memFileOfName('墨鸦'))).index).toEqual([])
  })

  it('再次收场：覆盖最后一段与标题', async () => {
    await wrap(agent, { summary: '第一版。', title: '旧标题' })
    // 中途换过场之后又收场：换场写了场景一，收场写场景二并覆盖标题
    ask.mockResolvedValue({ answers: [{ selected: ['换场'] }] })
    await scene(agent, { summary: '散了。', title: '后院' })
    await wrap(agent, { summary: '第二版收尾。', title: '新标题' })
    const show = await readShowSummary(dir, chatId)
    expect(show.title).toBe('新标题')
    expect(show.scenes.map((s) => s.index)).toEqual([1, 2])
    expect(show.scenes[1]!.text).toBe('第二版收尾。')
    expect((await readMemory(await memFileOfName('白狐'))).index[0]!.title).toBe('新标题')
  })
})
