import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createBook, findBookDir, readBookMeta, writeBookMeta, parseOutline, writeOutline, readOutline,
  sectionKey, writeSection, readSection, sectionStatus, relocateSections, DRAFT_DIR, UNUSED_DIR,
  type Outline,
} from '../../../src/core/book'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-book-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const now = new Date(2026, 9, 16, 20, 5, 0)
const mk = () => createBook(dir, { title: '生日那天', person: 'third', chats: ['c1'], sessionId: 's-1', now })

describe('createBook / findBookDir / book.yaml', () => {
  it('目录名、元数据与按编号查找', async () => {
    const b = await mk()
    expect(b.dirName).toMatch(/^20261016-2005-生日那天-[0-9a-z]{4}$/)
    expect(await findBookDir(dir, b.id)).toBe(b.dir)
    const meta = await readBookMeta(b.dir)
    expect(meta).toMatchObject({ title: '生日那天', person: 'third', protagonist: '', chats: ['c1'], session: 's-1', style: '' })
  })
  it('书名为空时目录名用"未命名"', async () => {
    const b = await createBook(dir, { title: '', person: 'first', chats: [], sessionId: 's', now })
    expect(b.dirName).toMatch(/-未命名-[0-9a-z]{4}$/)
  })
  it('改写元数据', async () => {
    const b = await mk()
    await writeBookMeta(b.dir, { ...(await readBookMeta(b.dir)), protagonist: '夏树' })
    expect((await readBookMeta(b.dir)).protagonist).toBe('夏树')
  })
})

const OUTLINE_YAML = `
title: 生日那天
protagonist: 夏树
chapters:
  - title: 第一话　灯笼
    chat: 20261010-2000-群聊-c3d4
    sections:
      - brief: 拌嘴
        range: { scene: 1 }
      - title: 切蛋糕
        brief: 送算盘
        range: { scene: 2 }
  - title: 第二话
    chat: 20261011-2300-白狐-a1b2
    sections:
      - brief: 旧事
        range: { from: 1, to: 86 }
`

describe('parseOutline', () => {
  it('合法目录：小节标题缺省为空串', () => {
    const r = parseOutline(OUTLINE_YAML)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.outline.chapters[0]!.sections[0]).toEqual({ title: '', brief: '拌嘴', range: { scene: 1 } })
    expect(r.outline.chapters[1]!.sections[0]!.range).toEqual({ from: 1, to: 86 })
  })
  it.each([
    ['不是 YAML', 'a: [', 'yaml'],
    ['没有话', 'title: x\nprotagonist: y\nchapters: []', 'chapters'],
    ['话里没有节', 'title: x\nprotagonist: y\nchapters:\n  - title: a\n    chat: c\n    sections: []', 'sections'],
    ['范围倒置', 'title: x\nprotagonist: y\nchapters:\n  - title: a\n    chat: c\n    sections:\n      - brief: b\n        range: { from: 5, to: 2 }', 'range'],
    ['场景序号非正整数', 'title: x\nprotagonist: y\nchapters:\n  - title: a\n    chat: c\n    sections:\n      - brief: b\n        range: { scene: 0 }', 'range'],
    ['聊天目录名带斜杠', 'title: x\nprotagonist: y\nchapters:\n  - title: a\n    chat: ../c\n    sections:\n      - brief: b\n        range: { scene: 1 }', 'chat'],
  ])('%s', (_name, text, word) => {
    const r = parseOutline(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(word)
  })
})

describe('目录读写与节文件', () => {
  it('目录写入后原样读回', async () => {
    const b = await mk()
    const r = parseOutline(OUTLINE_YAML)
    if (!r.ok) throw new Error(r.error)
    await writeOutline(b.dir, r.outline)
    expect(await readOutline(b.dir)).toEqual(r.outline)
  })
  it('没有目录时读回 null', async () => {
    expect(await readOutline((await mk()).dir)).toBeNull()
  })
  it('sectionKey 两位补零', () => {
    expect(sectionKey(0, 0)).toBe('01-01')
    expect(sectionKey(11, 2)).toBe('12-03')
  })
  it('节文件 frontmatter 与正文', async () => {
    const b = await mk()
    const fm = { chat: 'c1', range: { scene: 1 }, fingerprint: 'abc', model: 'p/m', written: '2026-10-16T12:00:00.000Z' }
    await writeSection(b.dir, '01-01', fm, '正文第一段。\n\n第二段。')
    const s = await readSection(b.dir, '01-01')
    expect(s).toEqual({ fm, body: '正文第一段。\n\n第二段。' })
    expect(await readSection(b.dir, '01-02')).toBeNull()
  })
})

describe('sectionStatus', () => {
  const fm = { chat: 'c1', range: { scene: 1 }, fingerprint: 'abc', model: 'p/m', written: 't' }
  it('未写 / 已写 / 需重写', () => {
    expect(sectionStatus(null, 'c1', { scene: 1 }, 'abc')).toBe('missing')
    expect(sectionStatus(fm, 'c1', { scene: 1 }, 'abc')).toBe('written')
    expect(sectionStatus(fm, 'c1', { scene: 1 }, 'zzz')).toBe('stale')
    expect(sectionStatus(fm, 'c2', { scene: 1 }, 'abc')).toBe('stale')
    expect(sectionStatus(fm, 'c1', { from: 1, to: 2 }, 'abc')).toBe('stale')
  })
})

describe('relocateSections', () => {
  const outlineOf = (ranges: Array<{ chat: string; range: { scene: number } }>): Outline => ({
    title: 't', protagonist: 'p',
    chapters: [{ title: 'a', chat: 'c1', sections: ranges.map((r) => ({ title: '', brief: 'b', range: r.range })) }],
  })
  it('调换顺序后节文件跟着走；找不到对应的移到 .unused', async () => {
    const b = await mk()
    const fm = (scene: number) => ({ chat: 'c1', range: { scene }, fingerprint: 'f', model: 'm', written: 't' })
    await writeSection(b.dir, '01-01', fm(1), '一')
    await writeSection(b.dir, '01-02', fm(2), '二')
    await writeSection(b.dir, '01-03', fm(3), '三')
    const r = await relocateSections(b.dir, outlineOf([{ chat: 'c1', range: { scene: 2 } }, { chat: 'c1', range: { scene: 1 } }]))
    expect((await readSection(b.dir, '01-01'))!.body).toBe('二')
    expect((await readSection(b.dir, '01-02'))!.body).toBe('一')
    expect(await readSection(b.dir, '01-03')).toBeNull()
    expect(r).toEqual({ moved: 2, unused: 1 })
    const unused = await fs.readdir(path.join(b.dir, DRAFT_DIR, UNUSED_DIR))
    expect(unused).toHaveLength(1)
  })
})
