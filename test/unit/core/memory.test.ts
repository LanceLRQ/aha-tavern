import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  parseMemory, roundTrip, readMemory, appendFact, appendPinned, replaceSections,
  appendIndexLine, setIndexTitle, hasChatInIndex, memoryChars,
} from '../../../src/core/memory'
import { isAhaError } from '../../../src/core/errors'

const STANDARD = `# 白狐 与 我

## 称呼与关系
她叫我"老板"。我是这家店的常客。

## 对我的印象
话不多，但每次都点同一种酒。最近好像工作不顺。

## 我让 TA 记住的
- 我下周三过生日
- 我不吃香菜

## 关键的事
- 我想换工作，她劝我先别急
- 我老家在海边

## 往事索引
- 2026-10-08 单聊：聊了老家的事 〔a1b2〕
- 2026-10-10 群聊：生日派对（白狐、青衫、我）〔c3d4〕
- 2026-10-12 单聊（未整理）〔e5f6〕
`

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-memory-'))
  file = path.join(dir, 'characters', '白狐', 'memory.md')
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function put(text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const read = () => fs.readFile(file, 'utf8')

describe('解析', () => {
  it('文件不存在：五栏皆空', async () => {
    const m = await readMemory(file)
    expect(m).toEqual({ address: '', impression: '', pinned: [], facts: [], index: [] })
    expect(await memoryChars(file)).toBe(0)
    expect(await hasChatInIndex(file, 'a1b2')).toBe(false)
  })

  it('空文件：五栏皆空', () => {
    expect(parseMemory('')).toEqual({ address: '', impression: '', pinned: [], facts: [], index: [] })
  })

  it('标准五栏', () => {
    const m = parseMemory(STANDARD)
    expect(m.address).toBe('她叫我"老板"。我是这家店的常客。')
    expect(m.impression).toContain('每次都点同一种酒')
    expect(m.pinned).toEqual(['我下周三过生日', '我不吃香菜'])
    expect(m.facts).toEqual(['我想换工作，她劝我先别急', '我老家在海边'])
    expect(m.index).toEqual([
      { date: '2026-10-08', kind: 'chat', title: '聊了老家的事', id: 'a1b2' },
      { date: '2026-10-10', kind: 'group', title: '生日派对（白狐、青衫、我）', id: 'c3d4' },
      { date: '2026-10-12', kind: 'chat', title: null, id: 'e5f6' },
    ])
  })

  it('标准五栏往返不变', () => {
    expect(roundTrip(STANDARD)).toBe(STANDARD)
  })

  it('各种怪格式往返不变', () => {
    for (const t of ['', '\n', 'abc', '## 关键的事\n- a', '前言\r\n## 关键的事\r\n- a\r\n', '\n\n## 往事索引\n\n\n']) {
      expect(roundTrip(t)).toBe(t)
    }
  })

  it('栏目顺序被调换仍能识别', () => {
    const t = '## 往事索引\n- 2026-10-08 单聊（未整理）〔x1〕\n\n## 关键的事\n- 甲\n\n## 称呼与关系\n老板\n'
    const m = parseMemory(t)
    expect(m.address).toBe('老板')
    expect(m.facts).toEqual(['甲'])
    expect(m.index[0]?.id).toBe('x1')
    expect(roundTrip(t)).toBe(t)
  })

  it('多了未知栏：读取忽略，原样保留', async () => {
    const t = STANDARD.replace('## 关键的事', '## 我的小本本\n随便写的\n- 乱七八糟\n\n## 关键的事')
    await put(t)
    expect((await readMemory(file)).facts).toEqual(['我想换工作，她劝我先别急', '我老家在海边'])
    await appendFact(file, '新的一条')
    const after = await read()
    expect(after).toContain('## 我的小本本\n随便写的\n- 乱七八糟\n')
    expect(after.indexOf('我的小本本')).toBeLessThan(after.indexOf('## 关键的事'))
    expect(after).toContain('- 我老家在海边\n- 新的一条\n')
  })

  it('栏目标题被改坏：不识别，内容保留，写入时补建正确栏', async () => {
    await put('# x\n\n## 关键的事情\n- 旧的\n')
    expect((await readMemory(file)).facts).toEqual([])
    await appendFact(file, '新的')
    const after = await read()
    expect(after).toContain('## 关键的事情\n- 旧的\n')
    expect(after).toContain('## 关键的事\n- 新的\n')
    expect((await readMemory(file)).facts).toEqual(['新的'])
  })

  it('重复的已知标题：第二个当作未知内容保留', async () => {
    const t = '## 关键的事\n- 甲\n\n## 关键的事\n- 乙\n'
    expect(parseMemory(t).facts).toEqual(['甲'])
    await put(t)
    await appendFact(file, '丙')
    const after = await read()
    expect(after).toContain('- 乙')
    expect(parseMemory(after).facts).toEqual(['甲', '丙'])
  })

  it('用户手写无项目符号的行也算条目', () => {
    expect(parseMemory('## 关键的事\n我老家在海边\n- 甲\n').facts).toEqual(['我老家在海边', '甲'])
  })

  it('无法解析的索引行保留，不进入 index', async () => {
    await put('## 往事索引\n- 手写的一行\n- 2026-10-08 单聊（未整理）〔x1〕\n')
    expect((await readMemory(file)).index.map((e) => e.id)).toEqual(['x1'])
    await appendIndexLine(file, { date: '2026-10-09', kind: 'chat', id: 'x2' })
    expect(await read()).toContain('- 手写的一行\n')
  })

  it('字数按 Unicode 字符计', async () => {
    await put('😀😀中')
    expect(await memoryChars(file)).toBe(3)
  })
})

describe('追加关键的事', () => {
  it('文件不存在：生成带五栏骨架的文件', async () => {
    const r = await appendFact(file, '我老家在海边', { characterName: '白狐' })
    expect(r).toEqual({ written: true, trimmed: 0 })
    const t = await read()
    expect(t).toBe('# 白狐 与 我\n\n## 称呼与关系\n\n## 对我的印象\n\n## 我让 TA 记住的\n\n## 关键的事\n- 我老家在海边\n\n## 往事索引\n')
    expect((await readMemory(file)).facts).toEqual(['我老家在海边'])
  })

  it('追加到末尾', async () => {
    await put(STANDARD)
    await appendFact(file, '我养了一只猫')
    expect((await readMemory(file)).facts).toEqual(['我想换工作，她劝我先别急', '我老家在海边', '我养了一只猫'])
    // 其他栏纹丝不动
    expect(await read()).toBe(STANDARD.replace('- 我老家在海边\n', '- 我老家在海边\n- 我养了一只猫\n'))
  })

  it('去重：完全相同', async () => {
    await put(STANDARD)
    const r = await appendFact(file, '我老家在海边')
    expect(r).toEqual({ written: false, reason: 'duplicate', trimmed: 0 })
    expect(await read()).toBe(STANDARD)
  })

  it('去重：只差空白与项目符号', async () => {
    await put(STANDARD)
    for (const t of ['  - 我老家在海边  ', '* 我 老家 在海边', '•我老家在海边'.replace('•', '• '), '我老家　在海边', '+ 我老家在\n海边']) {
      const r = await appendFact(file, t)
      expect(r.reason, t).toBe('duplicate')
    }
    expect(await read()).toBe(STANDARD)
  })

  it('不同内容不算重复', async () => {
    await put(STANDARD)
    expect((await appendFact(file, '我老家在海边的小镇')).written).toBe(true)
  })

  it('写入时清掉项目符号与换行', async () => {
    await put(STANDARD)
    await appendFact(file, '- 第一行\n第二行')
    expect((await readMemory(file)).facts.at(-1)).toBe('第一行 第二行')
  })

  it('空内容不写', async () => {
    const r = await appendFact(file, ' - \n ')
    expect(r).toEqual({ written: false, reason: 'empty', trimmed: 0 })
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('上限裁剪：丢最旧的', async () => {
    await put(STANDARD)
    const r = await appendFact(file, '第三条', { maxFacts: 2 })
    expect(r).toEqual({ written: true, trimmed: 1 })
    expect((await readMemory(file)).facts).toEqual(['我老家在海边', '第三条'])
  })

  it('已超上限的文件一次裁到上限', async () => {
    await put('## 关键的事\n- 1\n- 2\n- 3\n- 4\n')
    const r = await appendFact(file, '5', { maxFacts: 2 })
    expect(r.trimmed).toBe(3)
    expect((await readMemory(file)).facts).toEqual(['4', '5'])
  })

  it('默认上限 100', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `- 事${i}`).join('\n')
    await put(`## 关键的事\n${lines}\n`)
    const r = await appendFact(file, '新')
    expect(r.trimmed).toBe(1)
    const facts = (await readMemory(file)).facts
    expect(facts).toHaveLength(100)
    expect(facts[0]).toBe('事1')
    expect(facts.at(-1)).toBe('新')
  })

  it('重复的内容即使已超限也不写', async () => {
    await put('## 关键的事\n- 1\n- 2\n- 3\n')
    expect((await appendFact(file, '2', { maxFacts: 2 })).written).toBe(false)
  })
})

describe('追加我让 TA 记住的', () => {
  it('追加', async () => {
    await put(STANDARD)
    const r = await appendPinned(file, '我的生日是三月三号')
    expect(r.written).toBe(true)
    expect((await readMemory(file)).pinned).toEqual(['我下周三过生日', '我不吃香菜', '我的生日是三月三号'])
  })

  it('不去重、不裁剪（用户明确要求记的）', async () => {
    await put(STANDARD)
    await appendPinned(file, '我不吃香菜')
    expect((await readMemory(file)).pinned.filter((x) => x === '我不吃香菜')).toHaveLength(2)
  })

  it('空内容不写', async () => {
    expect((await appendPinned(file, '  ')).reason).toBe('empty')
  })

  it('文件不存在时建骨架', async () => {
    await appendPinned(file, '甲')
    const m = await readMemory(file)
    expect(m.pinned).toEqual(['甲'])
    expect(await read()).toContain('## 往事索引')
  })
})

describe('整体替换', () => {
  it('替换三栏，pinned 与 index 不动', async () => {
    await put(STANDARD)
    await replaceSections(file, { address: '她叫我"掌柜"', impression: '心情不错', facts: ['甲', '乙'] })
    const m = await readMemory(file)
    expect(m.address).toBe('她叫我"掌柜"')
    expect(m.impression).toBe('心情不错')
    expect(m.facts).toEqual(['甲', '乙'])
    expect(m.pinned).toEqual(['我下周三过生日', '我不吃香菜'])
    expect(m.index).toHaveLength(3)
    expect(await read()).toBe(
      STANDARD
        .replace(/她叫我"老板"[^\n]*/, '她叫我"掌柜"')
        .replace(/话不多[^\n]*/, '心情不错')
        .replace('- 我想换工作，她劝我先别急\n- 我老家在海边\n', '- 甲\n- 乙\n'),
    )
  })

  it('只给出的栏被替换', async () => {
    await put(STANDARD)
    await replaceSections(file, { impression: '新印象' })
    const m = parseMemory(STANDARD)
    const after = await readMemory(file)
    expect(after.address).toBe(m.address)
    expect(after.facts).toEqual(m.facts)
    expect(after.impression).toBe('新印象')
  })

  it('运行时传入 pinned / index 也被忽略', async () => {
    await put(STANDARD)
    await replaceSections(file, { address: 'x', pinned: ['坏'], index: ['坏'] } as never)
    const m = await readMemory(file)
    expect(m.pinned).toEqual(['我下周三过生日', '我不吃香菜'])
    expect(m.index).toHaveLength(3)
  })

  it('facts 替换时去重并按上限保留最新', async () => {
    await put(STANDARD)
    const r = await replaceSections(file, { facts: ['- 甲', '甲', '乙', '丙', ' '] }, { maxFacts: 2 })
    expect(r.trimmed).toBe(1)
    expect((await readMemory(file)).facts).toEqual(['乙', '丙'])
  })

  it('空字符串可以清空称呼栏', async () => {
    await put(STANDARD)
    await replaceSections(file, { address: '' })
    expect((await readMemory(file)).address).toBe('')
    expect(await read()).toContain('## 称呼与关系\n\n## 对我的印象')
  })

  it('保留未知片段', async () => {
    const t = '前言\n\n## 笔记\n随手\n\n## 称呼与关系\n旧\n'
    await put(t)
    await replaceSections(file, { address: '新' })
    const after = await read()
    expect(after).toContain('前言\n\n## 笔记\n随手\n\n## 称呼与关系\n新\n')
  })

  it('文件不存在时建骨架并写入', async () => {
    await replaceSections(file, { address: '老板' }, { characterName: '白狐' })
    const t = await read()
    expect(t.startsWith('# 白狐 与 我\n')).toBe(true)
    expect((await readMemory(file)).address).toBe('老板')
  })

  it('什么都没给：不改文件', async () => {
    await put(STANDARD)
    const r = await replaceSections(file, {})
    expect(r.written).toBe(false)
    expect(await read()).toBe(STANDARD)
  })
})

describe('往事索引', () => {
  it('追加一行（未整理）', async () => {
    await put(STANDARD)
    const r = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'g7h8' })
    expect(r).toEqual({ written: true, trimmed: 0 })
    expect(await read()).toBe(STANDARD + '- 2026-10-13 单聊（未整理）〔g7h8〕\n')
    expect(await hasChatInIndex(file, 'g7h8')).toBe(true)
  })

  it('群聊写成群聊', async () => {
    await appendIndexLine(file, { date: '2026-10-13', kind: 'group', id: 'g1' })
    expect(await read()).toContain('- 2026-10-13 群聊（未整理）〔g1〕\n')
    expect((await readMemory(file)).index[0]).toEqual({ date: '2026-10-13', kind: 'group', title: null, id: 'g1' })
  })

  it('同一编号不重复追加', async () => {
    await put(STANDARD)
    const r = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'a1b2' })
    expect(r).toEqual({ written: false, reason: 'duplicate', trimmed: 0 })
    expect(await read()).toBe(STANDARD)
  })

  it('非法编号或日期抛错', async () => {
    for (const bad of [{ id: '' }, { id: 'a b' }, { id: 'a〕b' }, { id: 'a\nb' }, { date: '昨天' }]) {
      const e = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'ok', ...bad }).catch((x) => x)
      expect(isAhaError(e, 'memory-invalid')).toBe(true)
    }
  })

  it('上限裁剪：丢最旧的行', async () => {
    await put(STANDARD)
    const r = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'z9' }, { maxIndexLines: 3 })
    expect(r).toEqual({ written: true, trimmed: 1 })
    expect((await readMemory(file)).index.map((e) => e.id)).toEqual(['c3d4', 'e5f6', 'z9'])
  })

  it('默认上限 100', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `- 2026-01-01 单聊（未整理）〔i${i}〕`).join('\n')
    await put(`## 往事索引\n${lines}\n`)
    const r = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'new' })
    expect(r.trimmed).toBe(1)
    const ids = (await readMemory(file)).index.map((e) => e.id)
    expect(ids).toHaveLength(100)
    expect(ids[0]).toBe('i1')
  })

  it('更新标题：未整理变成带标题', async () => {
    await put(STANDARD)
    const r = await setIndexTitle(file, 'e5f6', '聊了新工作')
    expect(r).toEqual({ written: true, trimmed: 0 })
    expect(await read()).toBe(STANDARD.replace('单聊（未整理）〔e5f6〕', '单聊：聊了新工作 〔e5f6〕'))
  })

  it('更新标题：已有标题可再改，群聊保持群聊', async () => {
    await put(STANDARD)
    await setIndexTitle(file, 'c3d4', '换了个名字')
    const e = (await readMemory(file)).index.find((x) => x.id === 'c3d4')
    expect(e).toEqual({ date: '2026-10-10', kind: 'group', title: '换了个名字', id: 'c3d4' })
  })

  it('标题里的换行与编号括号被清理', async () => {
    await put(STANDARD)
    await setIndexTitle(file, 'e5f6', '一\n二〔三〕')
    const e = (await readMemory(file)).index.find((x) => x.id === 'e5f6')
    expect(e?.title).toBe('一 二三')
  })

  it('更新不存在的编号：不报错、不新增、文件不变', async () => {
    await put(STANDARD)
    const r = await setIndexTitle(file, 'nope', '标题')
    expect(r).toEqual({ written: false, reason: 'not-found', trimmed: 0 })
    expect(await read()).toBe(STANDARD)
  })

  it('更新编号时文件不存在：不报错、不建文件', async () => {
    const r = await setIndexTitle(file, 'nope', '标题')
    expect(r.reason).toBe('not-found')
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('空标题不改', async () => {
    await put(STANDARD)
    expect((await setIndexTitle(file, 'e5f6', ' \n ')).reason).toBe('empty')
    expect(await read()).toBe(STANDARD)
  })

  it('按行尾编号定位：编号也出现在标题里时不误改', async () => {
    await put('## 往事索引\n- 2026-10-08 单聊：提到〔b2〕的事 〔a1〕\n- 2026-10-09 单聊（未整理）〔b2〕\n')
    await setIndexTitle(file, 'b2', '新')
    const t = await read()
    expect(t).toContain('- 2026-10-08 单聊：提到〔b2〕的事 〔a1〕')
    expect(t).toContain('- 2026-10-09 单聊：新 〔b2〕')
  })

  it('hasChatInIndex 认手写的行', async () => {
    await put('## 往事索引\n- 随便写 〔q1〕\n')
    expect(await hasChatInIndex(file, 'q1')).toBe(true)
    expect(await hasChatInIndex(file, 'q2')).toBe(false)
  })
})

describe('并发', () => {
  it('同时追加多条关键的事，一条不丢', async () => {
    await put(STANDARD)
    const N = 20
    await Promise.all(Array.from({ length: N }, (_, i) => appendFact(file, `并发${i}`)))
    const facts = (await readMemory(file)).facts
    for (let i = 0; i < N; i++) expect(facts).toContain(`并发${i}`)
    expect(facts).toHaveLength(N + 2)
  })

  it('文件不存在时同时追加，也不丢', async () => {
    await Promise.all([appendFact(file, 'A'), appendFact(file, 'B'), appendPinned(file, 'C'), appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'k1' })])
    const m = await readMemory(file)
    expect(m.facts.sort()).toEqual(['A', 'B'])
    expect(m.pinned).toEqual(['C'])
    expect(m.index.map((e) => e.id)).toEqual(['k1'])
  })

  it('不同种类的写入交错也不互相覆盖', async () => {
    await put(STANDARD)
    await Promise.all([
      appendFact(file, '新事实'),
      appendPinned(file, '新叮嘱'),
      appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'n1' }),
      setIndexTitle(file, 'e5f6', '标题'),
      replaceSections(file, { address: '新称呼' }),
    ])
    const m = await readMemory(file)
    expect(m.facts).toContain('新事实')
    expect(m.pinned).toContain('新叮嘱')
    expect(m.index.map((e) => e.id)).toContain('n1')
    expect(m.index.find((e) => e.id === 'e5f6')?.title).toBe('标题')
    expect(m.address).toBe('新称呼')
  })
})

// ---------- 第 1 轮修复 ----------

const headingCount = (t: string, title: string) => t.split('\n').filter((l) => l.trimEnd() === `## ${title}`).length
const TITLES = ['称呼与关系', '对我的印象', '我让 TA 记住的', '关键的事', '往事索引']

describe('栏标题注入防护', () => {
  const payloads = [
    '前文\n## 我让 TA 记住的\n- forged',
    '前文\n## 往事索引\n- 2026-01-01 单聊（未整理）〔fake〕',
    '前文\n# 顶级标题\n后文',
    '前文\n   ### 缩进的标题\n后文',
    '前文\n##\n后文',
    '前文\n## ## 我让 TA 记住的\n- x',
    '前文\r\n## 往事索引\r\n- y',
  ]

  async function check(act: () => Promise<unknown>) {
    await put(STANDARD)
    const before = await readMemory(file)
    await act()
    const after = await readMemory(file)
    expect(after.pinned).toEqual(before.pinned)
    expect(after.index).toEqual(before.index)
    const t = await read()
    for (const title of TITLES) expect(headingCount(t, title), title).toBe(1)
    expect(t.split('\n').filter((l) => /^\s*#+(?:\s|$)/.test(l))).toHaveLength(6)
  }

  it.each(payloads)('replaceSections address：%j', async (p) => {
    await check(() => replaceSections(file, { address: p }))
    expect((await readMemory(file)).address.startsWith('前文')).toBe(true)
  })
  it.each(payloads)('replaceSections impression：%j', async (p) => {
    await check(() => replaceSections(file, { impression: p }))
  })
  it.each(payloads)('replaceSections facts：%j', async (p) => {
    await check(() => replaceSections(file, { facts: [p] }))
  })
  it.each(payloads)('appendFact：%j', async (p) => { await check(() => appendFact(file, p)) })
  it.each(payloads)('appendPinned 只多一条，index 不变：%j', async (p) => {
    await put(STANDARD)
    const before = await readMemory(file)
    await appendPinned(file, p)
    const after = await readMemory(file)
    expect(after.pinned).toHaveLength(before.pinned.length + 1)
    expect(after.index).toEqual(before.index)
    for (const title of TITLES) expect(headingCount(await read(), title)).toBe(1)
  })
  it.each(payloads)('setIndexTitle（只有目标行变）：%j', async (p) => {
    await put(STANDARD)
    const before = await readMemory(file)
    await setIndexTitle(file, 'e5f6', p)
    const after = await readMemory(file)
    expect(after.pinned).toEqual(before.pinned)
    expect(after.index.map((e) => e.id)).toEqual(before.index.map((e) => e.id))
    expect(after.index.slice(0, 2)).toEqual(before.index.slice(0, 2))
    expect(after.index[2]?.title?.startsWith('前文')).toBe(true)
    for (const title of TITLES) expect(headingCount(await read(), title)).toBe(1)
  })

  it('去掉标题记号但保留文字', async () => {
    await put(STANDARD)
    await replaceSections(file, { address: 'x\n## 我让 TA 记住的\n- forged' })
    expect((await readMemory(file)).address).toBe('x\n我让 TA 记住的\n- forged')
  })

  it('不带空白的井号不是标题，原样保留', async () => {
    await put(STANDARD)
    await replaceSections(file, { address: '#话题 很有趣' })
    expect((await readMemory(file)).address).toBe('#话题 很有趣')
  })
})

describe('CRLF 换行', () => {
  const crlf = STANDARD.replace(/\n/g, '\r\n')
  const lone = /(?<!\r)\n/

  it('追加关键的事', async () => {
    await put(crlf)
    await appendFact(file, '新')
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe(crlf.replace('- 我老家在海边\r\n', '- 我老家在海边\r\n- 新\r\n'))
  })
  it('追加我让 TA 记住的', async () => {
    await put(crlf)
    await appendPinned(file, '新')
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe(crlf.replace('- 我不吃香菜\r\n', '- 我不吃香菜\r\n- 新\r\n'))
  })
  it('追加索引行', async () => {
    await put(crlf)
    await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'n1' })
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe(crlf + '- 2026-10-13 单聊（未整理）〔n1〕\r\n')
  })
  it('更新标题', async () => {
    await put(crlf)
    await setIndexTitle(file, 'e5f6', '标题')
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe(crlf.replace('单聊（未整理）〔e5f6〕', '单聊：标题 〔e5f6〕'))
  })
  it('整体替换（含多行与清空）', async () => {
    await put(crlf)
    await replaceSections(file, { address: '甲\n乙', impression: '', facts: ['丙', '丁'] })
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe(
      crlf
        .replace(/她叫我[^\r]*\r\n/, '甲\r\n乙\r\n')
        .replace(/话不多[^\r]*\r\n/, '')
        .replace('- 我想换工作，她劝我先别急\r\n- 我老家在海边\r\n', '- 丙\r\n- 丁\r\n'),
    )
  })
  it('补建缺失的栏', async () => {
    await put('## 称呼与关系\r\n老板\r\n')
    await appendFact(file, '新')
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe('## 称呼与关系\r\n老板\r\n\r\n## 关键的事\r\n- 新\r\n')
  })
  it('最后一栏没有末尾换行', async () => {
    await put('## 关键的事\r\n- 甲')
    await appendFact(file, '乙')
    const t = await read()
    expect(lone.test(t)).toBe(false)
    expect(t).toBe('## 关键的事\r\n- 甲\r\n- 乙\r\n')
  })
  it('新建文件用 \\n', async () => {
    await appendFact(file, '甲')
    expect(await read()).not.toContain('\r')
  })
})

describe('条目按顶层项目符号分组', () => {
  const nested = '## 关键的事\n- 甲\n  - 子项\n  续行\n- 乙\n'

  it('读取：嵌套与续行属于上一条', () => {
    expect(parseMemory(nested).facts).toEqual(['甲\n- 子项\n续行', '乙'])
  })
  it('去重只比较条目首行，子项文字不算重复', async () => {
    await put(nested)
    expect((await appendFact(file, '子项')).written).toBe(true)
    expect((await appendFact(file, '续行')).written).toBe(true)
    expect((await appendFact(file, '甲')).reason).toBe('duplicate')
  })
  it('裁剪按条目整体丢弃', async () => {
    await put(nested)
    const r = await appendFact(file, '丙', { maxFacts: 2 })
    expect(r.trimmed).toBe(1)
    const t = await read()
    expect(t).not.toContain('甲')
    expect(t).not.toContain('子项')
    expect(t).not.toContain('续行')
    expect(parseMemory(t).facts).toEqual(['乙', '丙'])
  })
  it('子项多不影响条数', async () => {
    await put('## 关键的事\n- 甲\n  a\n  b\n  c\n- 乙\n')
    const r = await appendFact(file, '丙', { maxFacts: 3 })
    expect(r.trimmed).toBe(0)
    expect(parseMemory(await read()).facts).toHaveLength(3)
  })
  it('第一条之前的手写行不计数、不被裁', async () => {
    await put('## 关键的事\n手写\n- 甲\n- 乙\n')
    const r = await appendFact(file, '丙', { maxFacts: 2 })
    expect(r.trimmed).toBe(1)
    expect(parseMemory(await read()).facts).toEqual(['手写', '乙', '丙'])
  })
  it('往事索引按顶层行计数', async () => {
    await put('## 往事索引\n- 2026-01-01 单聊（未整理）〔a〕\n  备注\n- 2026-01-02 单聊（未整理）〔b〕\n')
    const r = await appendIndexLine(file, { date: '2026-01-03', kind: 'chat', id: 'c' }, { maxIndexLines: 2 })
    expect(r.trimmed).toBe(1)
    const t = await read()
    expect(t).not.toContain('备注')
    expect((await readMemory(file)).index.map((e) => e.id)).toEqual(['b', 'c'])
  })
  it('整体替换 facts 的上限按条目计', async () => {
    await put(STANDARD)
    const r = await replaceSections(file, { facts: ['甲', '乙', '丙'] }, { maxFacts: 2 })
    expect(r.trimmed).toBe(1)
  })
})

describe('末尾换行与空白', () => {
  it('没有末尾换行且目标栏不是最后一段：不补换行', async () => {
    const t = '## 关键的事\n- 甲\n\n## 往事索引\n- 2026-10-08 单聊（未整理）〔x1〕'
    await put(t)
    await appendFact(file, '乙')
    expect(await read()).toBe('## 关键的事\n- 甲\n- 乙\n\n## 往事索引\n- 2026-10-08 单聊（未整理）〔x1〕')
  })
  it('补建缺失栏不抹掉原有尾部空白', async () => {
    for (const orig of ['## 笔记\n内容  \n  ', 'x\n\n\n', 'y  ', '## 笔记\n内容\n']) {
      await put(orig)
      await appendFact(file, '新')
      const t = await read()
      expect(t.startsWith(orig), JSON.stringify(orig)).toBe(true)
      expect(parseMemory(t).facts).toEqual(['新'])
      expect(headingCount(t, '关键的事')).toBe(1)
    }
  })
  it('已有换行结尾只补必要的分隔', async () => {
    await put('x\n')
    await appendFact(file, '新')
    expect(await read()).toBe('x\n\n## 关键的事\n- 新\n')
  })
})

describe('上限参数回退到默认值', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `- 事${i}`).join('\n')
  it.each([NaN, 0, -3, 1.5, Infinity, '5' as never])('maxFacts=%s', async (bad) => {
    await put(`## 关键的事\n${hundred}\n`)
    const r = await appendFact(file, '新', { maxFacts: bad })
    expect(r.trimmed).toBe(1)
    expect((await readMemory(file)).facts).toHaveLength(100)
  })
  it.each([NaN, 0, -3, 1.5, Infinity])('maxIndexLines=%s', async (bad) => {
    const lines = Array.from({ length: 100 }, (_, i) => `- 2026-01-01 单聊（未整理）〔i${i}〕`).join('\n')
    await put(`## 往事索引\n${lines}\n`)
    const r = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'new' }, { maxIndexLines: bad })
    expect(r.trimmed).toBe(1)
    expect((await readMemory(file)).index).toHaveLength(100)
  })
  it('replaceSections 的 maxFacts 同样回退', async () => {
    await put(STANDARD)
    const r = await replaceSections(file, { facts: ['甲', '乙'] }, { maxFacts: NaN })
    expect(r.trimmed).toBe(0)
  })
})

describe('非字符串参数', () => {
  const bad = [{}, 123, null, ['a'], true]
  it('appendFact / appendPinned / setIndexTitle', async () => {
    await put(STANDARD)
    for (const b of bad) {
      expect(isAhaError(await appendFact(file, b as never).catch((e) => e), 'memory-invalid')).toBe(true)
      expect(isAhaError(await appendPinned(file, b as never).catch((e) => e), 'memory-invalid')).toBe(true)
      expect(isAhaError(await setIndexTitle(file, 'e5f6', b as never).catch((e) => e), 'memory-invalid')).toBe(true)
    }
    expect(await read()).toBe(STANDARD)
  })
  it('replaceSections', async () => {
    await put(STANDARD)
    const patches = [{ address: 5 }, { impression: {} }, { address: null }, { facts: 'x' }, { facts: [{}] }, { facts: [1] }]
    for (const p of patches) {
      expect(isAhaError(await replaceSections(file, p as never).catch((e) => e), 'memory-invalid'), JSON.stringify(p)).toBe(true)
    }
    expect(await read()).toBe(STANDARD)
  })
  it('appendIndexLine 的各字段', async () => {
    for (const e of [{ id: 5 }, { date: 20261013 }, { kind: 'x' }] as const) {
      const r = await appendIndexLine(file, { date: '2026-10-13', kind: 'chat', id: 'ok', ...e } as never).catch((x) => x)
      expect(isAhaError(r, 'memory-invalid')).toBe(true)
    }
    await expect(fs.stat(file)).rejects.toThrow()
  })
  it('不存在的文件也不被创建', async () => {
    await appendFact(file, {} as never).catch(() => undefined)
    await expect(fs.stat(file)).rejects.toThrow()
  })
})
