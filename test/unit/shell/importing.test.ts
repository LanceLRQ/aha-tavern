import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, readCharacter, saveCharacter } from '../../../src/core/card'
import { readMe, writeMe } from '../../../src/core/docs'
import type { SourceListing } from '../../../src/core/importer'
import { AhaError } from '../../../src/core/errors'
import { registerTavern } from '../../../src/core/registry'
import { createTavern, openTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { SessionGate, type AskFn, type AskItem } from '../../../src/shell/confirm'
import type { Invocation } from '../../../src/shell/context'
import {
  buildConflictQuestion, buildPickBatches, describeFailure, optCopy, buildProfileConflictQuestion, buildSourceQuestion, clip,
  importHandler, interpretMulti, interpretSingle, summarize, type Outcome,
} from '../../../src/shell/importing'
import type { Runtime } from '../../../src/shell/runtime'
import type { SetupSections } from '../../../src/shell/setup'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let fools: Theme
beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  fools = (await loadTheme({ name: 'fools', builtinDir })).theme
})

const listing = (names: string[], extra: Partial<SourceListing> = {}): SourceListing => ({
  tavernId: 't_a', tavernName: '甲', hasProfile: false, broken: [],
  characters: names.map((n, i) => ({ id: `c_${i}`, name: n, dirName: n })),
  ...extra,
})
const ans = (id: string, selected: string[], custom?: string) => ({ answers: [{ id, selected, ...(custom ? { custom } : {}) }] })

describe('clip', () => {
  it('折叠空白与换行，超长截断并加省略号', () => {
    expect(clip('  a \n b  ', 10)).toBe('a b')
    expect(clip('一二三四五六', 4)).toBe('一二三…')
    expect(clip('abc', 3)).toBe('abc')
  })
})

describe('来源卡片', () => {
  it('只有一间也列出，写清名字与路径', () => {
    const q = buildSourceQuestion(theme, [{ name: '甲', path: '/a/b' }])
    expect(q.item.question).toContain('「甲」')
    expect(q.item.question).toContain('/a/b')
    expect(q.item.options).toHaveLength(1)
  })
  it('多间：重名加序号保证选项文字唯一，过长名字截断', () => {
    const long = '很'.repeat(50)
    const q = buildSourceQuestion(theme, [{ name: '甲', path: '/1' }, { name: '甲', path: '/2' }, { name: long, path: '/3' }])
    const labels = q.item.options!.map((o) => o.label)
    expect(new Set(labels).size).toBe(3)
    expect(labels[1]).toBe('甲 (2)')
    expect([...labels[2]!].length).toBeLessThanOrEqual(40)
    expect(q.byLabel.get('甲 (2)')?.path).toBe('/2')
  })
  it('回答映射：选中、跳过、自由输入、多选、不认识的选项', () => {
    const q = buildSourceQuestion(theme, [{ name: '甲', path: '/1' }, { name: '乙', path: '/2' }])
    expect(interpretSingle(ans('source', ['乙']), q)?.path).toBe('/2')
    expect(interpretSingle({ answers: [] }, q)).toBeNull()
    expect(interpretSingle(undefined, q)).toBeNull()
    expect(interpretSingle(ans('source', []), q)).toBeNull()
    expect(interpretSingle(ans('source', [], '随便'), q)).toBeNull()
    expect(interpretSingle(ans('source', ['乙'], '改主意'), q)).toBeNull()
    expect(interpretSingle(ans('source', ['甲', '乙']), q)).toBeNull()
    expect(interpretSingle(ans('source', ['丙']), q)).toBeNull()
  })
})

describe('内容卡片', () => {
  it('各角色一项，来源有主角档案再加一项，多选', () => {
    const [b] = buildPickBatches(theme, listing(['白狐', '黑猫'], { hasProfile: true }))
    expect(b!.item.multiSelect).toBe(true)
    expect(b!.item.options!.map((o) => o.label)).toEqual(['白狐', '黑猫', '主角档案'])
    expect(b!.byLabel.get('主角档案')).toEqual({ kind: 'profile' })
  })
  it('来源没有主角档案就不列；称呼经主题', () => {
    const [b] = buildPickBatches(fools, listing(['白狐']))
    expect(b!.item.options!.map((o) => o.label)).toEqual(['白狐'])
    const [c] = buildPickBatches(fools, listing([], { hasProfile: true }))
    expect(c!.item.options![0]!.label).toBe(fools.concept('profile'))
  })
  it('角色与"主角档案"重名时选项文字仍唯一', () => {
    const [b] = buildPickBatches(theme, listing(['主角档案'], { hasProfile: true }))
    expect(new Set(b!.item.options!.map((o) => o.label)).size).toBe(2)
  })
  it('超过上限分批，问题里带批次，选项总数不丢', () => {
    const names = Array.from({ length: 30 }, (_, i) => `角色${i}`)
    const batches = buildPickBatches(theme, listing(names), 12)
    expect(batches.map((b) => b.item.options!.length)).toEqual([12, 12, 6])
    expect(batches[1]!.item.question).toContain('2/3')
    expect(new Set(batches.map((b) => b.item.id)).size).toBe(3)
  })
  it('有读不出来的卡时在 detail 里说明数量', () => {
    const [b] = buildPickBatches(theme, listing(['白狐'], { broken: [{ dirName: 'x', problem: 'file-missing', detail: '' }] }))
    expect(b!.item.detail).toContain('1 张')
  })
  it('名字与简介截断', () => {
    const l = listing(['名'.repeat(80)])
    l.characters[0]!.tagline = '简'.repeat(200)
    const [b] = buildPickBatches(theme, l)
    expect([...b!.item.options![0]!.label].length).toBeLessThanOrEqual(40)
    expect([...b!.item.options![0]!.description!].length).toBeLessThanOrEqual(60)
  })
  it('多选映射：取出选中的；跳过、没选、自由输入都是取消', () => {
    const [b] = buildPickBatches(theme, listing(['白狐', '黑猫']))
    expect(interpretMulti(ans('pick-1', ['白狐', '黑猫']), b!)).toHaveLength(2)
    expect(interpretMulti(ans('pick-1', ['白狐', '白狐']), b!)).toHaveLength(1)
    expect(interpretMulti(ans('pick-1', []), b!)).toBeNull()
    expect(interpretMulti(ans('pick-1', ['白狐'], '算了'), b!)).toBeNull()
    expect(interpretMulti({}, b!)).toBeNull()
    expect(interpretMulti(ans('pick-1', ['不存在']), b!)).toBeNull()
  })
})

describe('冲突卡片', () => {
  it('编号冲突三选一，名字冲突两选一', () => {
    const idQ = buildConflictQuestion(theme, { kind: 'id', existing: { id: 'c', name: '白狐', dirName: '白狐' }, overwriteBlocked: false }, '白狐')
    expect([...idQ.byLabel.values()]).toEqual(['overwrite', 'copy', 'skip'])
    const nameQ = buildConflictQuestion(theme, { kind: 'name', dirName: '白狐' }, '白狐')
    expect([...nameQ.byLabel.values()]).toEqual(['copy', 'skip'])
  })
  it('回答映射', () => {
    const q = buildConflictQuestion(theme, { kind: 'id', existing: { id: 'c', name: '白狐', dirName: '白狐' }, overwriteBlocked: false }, '白狐')
    expect(interpretSingle(ans('conflict', ['覆盖']), q)).toBe('overwrite')
    expect(interpretSingle(ans('conflict', ['另存为新角色']), q)).toBe('copy')
    expect(interpretSingle(ans('conflict', [], '随便'), q)).toBeNull()
  })
  it('主角档案二选一', () => {
    const q = buildProfileConflictQuestion(theme)
    expect([...q.byLabel.values()]).toEqual(['overwrite', 'skip'])
  })
  it('用户可控文字被截断', () => {
    const q = buildConflictQuestion(theme, { kind: 'name', dirName: 'x'.repeat(100) }, 'y'.repeat(100))
    expect(q.item.question.length).toBeLessThan(150)
  })
})

describe('summarize', () => {
  const o = (x: Partial<Outcome> & Pick<Outcome, 'result'>): Outcome => ({ kind: 'character', name: '白狐', ...x })
  it('按结果分组，另存带新名字，失败带原因', () => {
    const r = summarize(theme, [
      o({ result: 'imported', name: 'A' }), o({ result: 'overwritten', name: 'B' }),
      o({ result: 'copied', name: 'C', savedAs: 'C 2' }), o({ result: 'skipped', name: 'D' }),
      { kind: 'profile', name: '', result: 'imported' },
      o({ result: 'failed', name: 'E', error: '读不出来' }),
    ], { sourceName: '甲', brokenCount: 2 })
    expect(r.kind).toBe('success')
    expect(r.text).toContain('导入了：「A」、主角档案')
    expect(r.text).toContain('覆盖了：「B」')
    expect(r.text).toContain('「C」→「C 2」')
    expect(r.text).toContain('跳过了：「D」')
    expect(r.text).toContain('「E」（读不出来）')
    expect(r.text).toContain('另有 2 张角色卡读不出来')
  })
  it('全失败为 error；中途出错为 error 并说明', () => {
    expect(summarize(theme, [o({ result: 'failed', error: 'x' })], { sourceName: '甲', brokenCount: 0 }).kind).toBe('error')
    const r = summarize(theme, [o({ result: 'imported' })], { sourceName: '甲', brokenCount: 0, aborted: '宿主断了' })
    expect(r.kind).toBe('error')
    expect(r.text).toContain('宿主断了')
  })
  it('附带文件没带上要说明；全跳过为 success', () => {
    const r = summarize(theme, [o({ result: 'imported', skippedFiles: [{ name: 'v.wav', reason: 'too-large' }] })], { sourceName: '甲', brokenCount: 0 })
    expect(r.text).toContain('v.wav（文件太大）')
    const v = summarize(theme, [o({ result: 'imported', skippedFiles: [{ name: 'voice_ref.wav', reason: 'voice-unpaired' }] })], { sourceName: '甲', brokenCount: 0 })
    expect(v.text).toContain('voice_ref.wav（音色文件不成对，未带上）')
    expect(summarize(theme, [o({ result: 'skipped' })], { sourceName: '甲', brokenCount: 0 }).kind).toBe('success')
  })
  it('称呼经主题', () => {
    expect(summarize(fools, [], { sourceName: '甲', brokenCount: 0 }).text).toContain('跃迁')
  })
})

describe('importHandler', () => {
  let root: string
  let me: string
  let other: string
  let refresh: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-imp-'))
    me = path.join(root, 'me')
    other = path.join(root, 'other')
    await fs.mkdir(me)
    await fs.mkdir(other)
    const m = await createTavern(me, { name: '乙' })
    const o = await createTavern(other, { name: '甲' })
    await registerTavern(reg(), { id: m.id, name: '乙', path: me })
    await registerTavern(reg(), { id: o.id, name: '甲', path: other })
    refresh = vi.fn().mockResolvedValue(undefined)
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const reg = () => path.join(root, 'reg.yaml')

  const run = async (asks: Array<(item: AskItem) => unknown>, ask?: AskFn | null) => {
    const seen: AskItem[] = []
    const queue = [...asks]
    const fake: AskFn = async (req) => {
      const item = req.questions[0]!
      seen.push(item)
      const next = queue.shift()
      if (!next) throw new Error(`没有预设的回答：${item.id}`)
      return next(item) as never
    }
    const rt = {
      config: { ...DEFAULTS, mode: 'setup', registryPath: reg() },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      theme: async () => theme, handlers: {}, builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined,
    } as unknown as Runtime
    const steer = vi.fn()
    const inv = {
      agent: { id: 's1', ctx: {} }, services: { agentPresets: { composedPreset: () => 'tavern-setup' } }, rt, theme, steer,
      args: '', label: '/aha 导入',
      context: { mode: 'setup', cwd: me, sessionId: 's1', tavern: await openTavern(me), state: 'preparing', outsideReason: null, record: null },
    } as unknown as Invocation
    const handler = importHandler({ refresh } as unknown as SetupSections, () => (ask === null ? undefined : ask ?? fake), { now: () => '2026-10-09T00:00:00.000Z' })
    const reply = await handler(inv)
    return { reply, seen, steer, rest: queue.length }
  }

  const runWith = async (o: { ask: AskFn; signal?: AbortSignal; gate?: SessionGate; stop?: boolean }) => {
    const rt = {
      config: { ...DEFAULTS, mode: 'setup', registryPath: reg() },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      theme: async () => theme, handlers: {}, builtinThemeDir: builtinDir, builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined,
    } as unknown as Runtime
    const inv = {
      agent: { id: 's1', ctx: {} }, services: { agentPresets: { composedPreset: () => 'tavern-setup' } }, rt, theme, steer: vi.fn(),
      args: '', label: '/aha 导入', ...(o.signal ? { signal: o.signal } : {}),
      context: { mode: 'setup', cwd: me, sessionId: 's1', tavern: await openTavern(me), state: 'preparing', outsideReason: null, record: null },
    } as unknown as Invocation
    return importHandler({ refresh } as unknown as SetupSections, () => o.ask, { ...(o.gate ? { gate: o.gate } : {}) })(inv)
  }
  const pick = (...labels: string[]) => (item: AskItem) => ans(item.id, labels)
  const mk = (name: string, extra: Record<string, unknown> = {}) =>
    saveCharacter(other, { name, persona: `${name}的人设`, ...extra })

  it('正常导入：选来源、选角色，回执汇总，刷新掌柜段，无 steer', async () => {
    const a = await mk('白狐')
    await writeMe(other, '源档案')
    const { reply, seen, steer } = await run([pick('甲'), pick('白狐', '主角档案')])
    expect(seen.map((s) => s.id)).toEqual(['source', 'pick-1'])
    expect(reply.kind).toBe('success')
    expect(reply.text).toContain('导入了：「白狐」、主角档案')
    const got = await readCharacter(me, a.card.id)
    expect(got?.ok && got.card.origin).toMatchObject({ tavern: expect.any(String), at: '2026-10-09T00:00:00.000Z' })
    expect((await readMe(me)).text).toBe('源档案')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })

  it('没有别的酒馆：回执说明，不弹卡片', async () => {
    await fs.rm(path.join(other, 'aha-tavern.yaml'))
    const { reply, seen } = await run([])
    expect(seen).toEqual([])
    expect(reply.kind).toBe('success')
    expect(reply.text).toContain('没有可以导入的来源')
  })

  it('选来源时被跳过：整个导入取消', async () => {
    await mk('白狐')
    const { reply, seen } = await run([() => ({ answers: [] })])
    expect(seen).toHaveLength(1)
    expect(reply.text).toContain('已取消')
    expect(await listCharacters(me)).toHaveLength(0)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('选内容时被跳过或自由输入：取消，不改动', async () => {
    await mk('白狐')
    const r1 = await run([pick('甲'), () => ({ answers: [] })])
    expect(r1.reply.text).toContain('已取消')
    const r2 = await run([pick('甲'), (i) => ans(i.id, [], '我想想')])
    expect(r2.reply.text).toContain('已取消')
    expect(await listCharacters(me)).toHaveLength(0)
  })

  it('来源里什么都没有：回执说明', async () => {
    const { reply, seen } = await run([pick('甲')])
    expect(seen).toHaveLength(1)
    expect(reply.text).toContain('没有可以导入的')
  })

  describe('冲突', () => {
    let id: string
    beforeEach(async () => {
      id = (await mk('白狐', { persona: '旧人设' })).card.id
      await run([pick('甲'), pick('白狐')])
      await fs.writeFile(path.join(me, 'characters', '白狐', 'memory.md'), '# 我的记忆')
      await saveCharacter(other, { id, name: '白狐', persona: '新人设' })
      refresh.mockClear()
    })

    it('覆盖：换卡，记忆保留', async () => {
      const { reply, seen } = await run([pick('甲'), pick('白狐'), pick('覆盖')])
      expect(seen.map((s) => s.id)).toEqual(['source', 'pick-1', 'conflict'])
      expect(reply.text).toContain('覆盖了：「白狐」')
      const got = await readCharacter(me, id)
      expect(got?.ok && got.card.persona).toBe('新人设')
      expect(await fs.readFile(path.join(me, 'characters', '白狐', 'memory.md'), 'utf8')).toBe('# 我的记忆')
    })

    it('另存为新角色', async () => {
      const { reply } = await run([pick('甲'), pick('白狐'), pick('另存为新角色')])
      expect(reply.text).toContain('「白狐」→「白狐 2」')
      expect(await listCharacters(me)).toHaveLength(2)
    })

    it('跳过：不动，不刷新', async () => {
      const { reply } = await run([pick('甲'), pick('白狐'), pick('跳过')])
      expect(reply.text).toContain('跳过了：「白狐」')
      const got = await readCharacter(me, id)
      expect(got?.ok && got.card.persona).toBe('旧人设')
      expect(refresh).not.toHaveBeenCalled()
    })

    it('冲突卡片上跳过或自由输入：只跳过这一个，不取消整个导入', async () => {
      await mk('黑猫')
      const { reply, rest } = await run([pick('甲'), pick('白狐', '黑猫'), (i) => ans(i.id, [], '不知道')])
      expect(rest).toBe(0)
      expect(reply.text).toContain('导入了：「黑猫」')
      expect(reply.text).toContain('跳过了：「白狐」')
      const r2 = await run([pick('甲'), pick('白狐'), () => ({ answers: [] })])
      expect(r2.reply.text).toContain('跳过了：「白狐」')
    })

    it('主角档案冲突二选一', async () => {
      await writeMe(other, '源')
      await writeMe(me, '我的')
      const { seen } = await run([pick('甲'), pick('主角档案'), pick('跳过')])
      expect(seen.map((s) => s.id)).toEqual(['source', 'pick-1', 'profile-conflict'])
      expect((await readMe(me)).text).toBe('我的')
      await run([pick('甲'), pick('主角档案'), pick('覆盖')])
      expect((await readMe(me)).text).toBe('源')
    })
  })

  it('卡片不可用：给出失败回执', async () => {
    const { reply } = await run([], null)
    expect(reply.kind).toBe('error')
  })

  it('中途弹卡片失败：已处理的保留，回执说明并为 error', async () => {
    await mk('白狐')
    await mk('黑猫')
    await mk('黑猫2', { name: '黑猫2' })
    await saveCharacter(me, { name: '黑猫2', persona: 'x' }) // 名字冲突，需要弹卡片
    const { reply } = await run([pick('甲'), pick('白狐', '黑猫2'), () => { throw new Error('宿主断了') }])
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('宿主断了')
    expect(reply.text).toContain('导入了：「白狐」')
  })

  it('整条流程：全部卡片与汇总都没有直白用词', async () => {
    const a = await mk('白狐')
    const b = await mk('黑猫')
    await writeMe(other, '源档案')
    const idx = (i: number) => (item: AskItem) => ans(item.id, [item.options![i]!.label])
    const all = (item: AskItem) => ans(item.id, item.options!.map((o) => o.label))
    theme = markerTheme()
    const r1 = await run([idx(0), all])
    // 第二轮：白狐改名成"青衫"（撞第三个角色的目录）、黑猫编号冲突、档案冲突
    await saveCharacter(me, { name: '青衫', persona: 'z' })
    await saveCharacter(other, { id: a.card.id, name: '青衫', persona: 'y' })
    const r2 = await run([idx(0), all, idx(0), idx(0), idx(0)])
    const r3 = await run([idx(0), all, idx(1), idx(1), idx(1)])
    const seen = [...r1.seen, ...r2.seen, ...r3.seen]
    expect(seen.filter((i) => i.id === 'conflict').some((i) => i.options!.length === 2 && i.question.includes('不能覆盖'))).toBe(true)
    noPlainWords([...textsOf(seen), r1.reply.text!, r2.reply.text!, r3.reply.text!])
    expect(b.card.id).toBeTruthy()
  })

  it('来源数据比插件新：回执说明请先升级', async () => {
    await mk('白狐')
    await fs.writeFile(path.join(other, 'aha-tavern.yaml'), 'version: 99\nid: t_x\nname: 甲\n')
    const r = await run([pick('甲')])
    expect(r.reply.kind).toBe('error')
    expect(r.reply.text).toContain('来源酒馆「甲」的数据比插件新，请先升级插件')
    theme = markerTheme()
    noPlainWords([(await run([pick('甲')])).reply.text!])
  })

  it('卡片文字里的名字去掉「」与换行（导入卡片）', async () => {
    await mk('白「狐」\n二')
    const { seen } = await run([pick('甲'), (i) => ans(i.id, [])])
    expect(seen[1]!.options![0]!.label).toBe('白狐 二')
    expect(seen[1]!.question).not.toMatch(/「[^」]*「/)
  })

  it('提问被中止（ASK_ABORTED）：选来源时整个取消；冲突时只取消这一个并在汇总写明', async () => {
    const a = await mk('白狐')
    const abort = () => { throw Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' }) }
    const r1 = await run([abort])
    expect(r1.reply.text).toContain('已取消')
    expect(await listCharacters(me)).toHaveLength(0)
    await run([pick('甲'), pick('白狐')])
    await saveCharacter(other, { id: a.card.id, name: '白狐', persona: '新' })
    const r2 = await run([pick('甲'), pick('白狐'), abort])
    expect(r2.reply.text).toContain('因提问被中断而取消了：「白狐」')
    expect(r2.reply.kind).toBe('success')
    const got = await readCharacter(me, a.card.id)
    expect(got?.ok && got.card.persona).toBe('白狐的人设')
  })

  it('把命令的 signal 传给 ask；信号已中止则不弹卡片', async () => {
    await mk('白狐')
    const ac = new AbortController()
    const seenSignals: unknown[] = []
    const ask: AskFn = async (req) => { seenSignals.push(req.signal); return ans(req.questions[0]!.id, ['甲']) as never }
    const first = await runWith({ ask, signal: ac.signal, stop: true })
    expect(seenSignals[0]).toBe(ac.signal)
    expect(first).toBeDefined()
    ac.abort()
    seenSignals.length = 0
    const r = await runWith({ ask, signal: ac.signal })
    expect(seenSignals).toEqual([])
    expect(r.text).toContain('已取消')
  })

  it('走会话锁：导入进行中，同一会话里的别的任务排在后面', async () => {
    await mk('白狐')
    const gate = new SessionGate()
    const order: string[] = []
    let release!: () => void
    const hold = new Promise<void>((r) => { release = r })
    const ask: AskFn = async (req) => {
      order.push('ask:' + req.questions[0]!.id)
      if (req.questions[0]!.id === 'source') await hold
      return ans(req.questions[0]!.id, req.questions[0]!.id === 'source' ? ['甲'] : ['白狐']) as never
    }
    const p = runWith({ ask, gate })
    await new Promise((r) => setTimeout(r, 20))
    const other = gate.run('s1', async () => { order.push('tool') })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['ask:source'])
    release()
    await p
    await other
    expect(order).toEqual(['ask:source', 'ask:pick-1', 'tool'])
  })
})

// 用一套"哪个词都不是直白用词"的主题跑，确认没有写死的称呼
const markerTheme = (): Theme => ({
  name: 'marker',
  concept: (id) => `〈${id}〉`,
  action: (id) => `《${id}》`,
  host: () => ({ name: 'H', aliases: [] }),
  persona: () => '',
})
const PLAIN_WORDS = ['角色', '酒馆', '导入', '主角档案', '角色卡', '记忆']
const noPlainWords = (texts: string[]) => {
  for (const t of texts) for (const w of PLAIN_WORDS) expect(t, `「${t}」里出现了「${w}」`).not.toContain(w)
}
const textsOf = (items: AskItem[]) => items.flatMap((i) => [
  i.header, i.question, i.detail ?? '', ...(i.options ?? []).flatMap((o) => [o.label, o.description ?? '']),
])

describe('称呼全部走主题', () => {
  it('纯函数：冲突卡片、档案卡片、汇总、失败原因', () => {
    const t = markerTheme()
    const items = [
      buildConflictQuestion(t, { kind: 'id', existing: { id: 'c', name: '甲', dirName: '甲' }, overwriteBlocked: false }, '乙').item,
      buildConflictQuestion(t, { kind: 'id', existing: { id: 'c', name: '甲', dirName: '甲' }, overwriteBlocked: true }, '乙').item,
      buildConflictQuestion(t, { kind: 'name', dirName: '甲' }, '乙').item,
      buildProfileConflictQuestion(t).item,
      buildSourceQuestion(t, [{ name: '甲', path: '/p' }]).item,
      ...buildPickBatches(t, listing(['甲'], { hasProfile: true, broken: [{ dirName: 'x', problem: 'symlink', detail: '' }] })).map((b) => b.item),
    ]
    const sum = summarize(t, [
      { kind: 'character', name: '甲', result: 'imported' }, { kind: 'character', name: '乙', result: 'overwritten' },
      { kind: 'character', name: '丙', result: 'copied', savedAs: '丙 2' }, { kind: 'character', name: '丁', result: 'skipped' },
      { kind: 'character', name: '戊', result: 'skipped', cancelled: true },
      { kind: 'character', name: '己', result: 'failed', error: describeFailure(t, new AhaError('character-not-found', 'x')) },
      { kind: 'profile', name: '', result: 'imported', skippedFiles: [{ name: 'a.wav', reason: 'failed', code: 'ENOSPC' }] },
    ], { sourceName: '源', brokenCount: 2, brokenSymlinks: 1, profileUnsafe: true, aborted: describeFailure(t, new AhaError('version-too-new', 'x')) })
    const empty = summarize(t, [], { sourceName: '源', brokenCount: 0 })
    noPlainWords([...textsOf(items), sum.text, empty.text, optCopy(t)])
    expect(sum.text).toContain('《import》了')
    expect(sum.text).toContain('另存为新〈character〉')
  })

  it('同编号冲突且覆盖被堵住：卡片里没有"覆盖"，只有另存与跳过，并说明原因', () => {
    const q = buildConflictQuestion(theme, { kind: 'id', existing: { id: 'c', name: '甲', dirName: '甲' }, overwriteBlocked: true }, '乙')
    expect(q.item.options!.map((o) => o.label)).toEqual(['另存为新角色', '跳过'])
    expect(q.item.question).toContain('不能覆盖')
    expect([...q.byLabel.values()]).toEqual(['copy', 'skip'])
  })

  it('失败原因按错误码给人话，不带路径', () => {
    const t = theme
    const err = (code: string) => Object.assign(new Error(`${code}: boom, open '/secret/dir/file'`), { code })
    expect(describeFailure(t, err('ENAMETOOLONG'))).toBe('文件名太长')
    expect(describeFailure(t, err('EACCES'))).toBe('没有权限')
    expect(describeFailure(t, err('EPERM'))).toBe('没有权限')
    expect(describeFailure(t, err('ENOSPC'))).toBe('磁盘已满')
    expect(describeFailure(t, err('EXDEV'))).toBe('其他原因（EXDEV）')
    expect(describeFailure(t, new Error('/secret/dir/x'))).toBe('其他原因')
    expect(describeFailure(t, new AhaError('character-exists', '/secret'))).not.toContain('/secret')
    const s = summarize(t, [{ kind: 'character', name: '甲', result: 'failed', error: describeFailure(t, err('ENOSPC')) }], { sourceName: '源', brokenCount: 0 })
    expect(s.text).toContain('磁盘已满')
    expect(s.text).not.toContain('/secret')
  })

  it('符号链接：汇总说明数量与原因', () => {
    const s = summarize(theme, [], { sourceName: '源', brokenCount: 3, brokenSymlinks: 2, profileUnsafe: true })
    expect(s.text).toContain('其中 2 个是符号链接')
    expect(s.text).toContain('主角档案是符号链接')
  })
})
