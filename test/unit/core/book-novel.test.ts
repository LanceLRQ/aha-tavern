import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBook, writeSection } from '../../../src/core/book'
import { assembleNovelSource, extractImages } from '../../../src/core/book-novel'

let dir: string
let book: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-novel-'))
  book = (await createBook(dir, { title: 't', person: 'third', chats: [], sessionId: 's', now: new Date() })).dir
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const fm = { chat: 'c', range: { scene: 1 }, fingerprint: 'f', model: '', written: '' }

describe('extractImages', () => {
  it('图片引用换成占位符，编号从给定值起', () => {
    const r = extractImages('甲\n\n![](../../../chats/c/images/001.png)\n\n乙\n\n![x](../a.png)', 3)
    expect(r.text).toBe('甲\n\n[插图3]\n\n乙\n\n[插图4]')
    expect(r.images).toEqual([{ n: 3, file: '../../../chats/c/images/001.png' }, { n: 4, file: '../a.png' }])
  })
})

describe('assembleNovelSource', () => {
  it('按引用顺序拼整理稿，插图连续编号', async () => {
    await writeSection(book, '01-01', fm, '甲。\n\n![](p1.png)')
    await writeSection(book, '01-02', fm, '乙。\n\n![](p2.png)')
    const r = await assembleNovelSource(book, ['01-02', '01-01'])
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    expect(r.text).toBe('【整理稿 01-02】\n乙。\n\n[插图1]\n\n【整理稿 01-01】\n甲。\n\n[插图2]')
    expect(r.images).toEqual([{ n: 1, file: 'p2.png' }, { n: 2, file: 'p1.png' }])
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })
  it('没有原料的节：空文本，指纹固定', async () => {
    const a = await assembleNovelSource(book, [])
    const b = await assembleNovelSource(book, [])
    expect(a).toMatchObject({ ok: true, text: '', chars: 0, images: [] })
    expect(a.ok && b.ok && a.fingerprint === b.fingerprint).toBe(true)
  })
  it('引用的整理稿还没写：报错', async () => {
    expect(await assembleNovelSource(book, ['03-01'])).toEqual({ ok: false, error: 'draft section 03-01 is not written' })
  })
  it('整理稿改了，指纹跟着变', async () => {
    await writeSection(book, '01-01', fm, '甲。')
    const a = await assembleNovelSource(book, ['01-01'])
    await writeSection(book, '01-01', fm, '甲甲。')
    const b = await assembleNovelSource(book, ['01-01'])
    expect(a.ok && b.ok && a.fingerprint !== b.fingerprint).toBe(true)
  })
})
