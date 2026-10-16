import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildBookPrompt, buildOpenQuestions, interpretOpenAnswer, openBook } from '../../../src/shell/book'
import { readBookMeta, findBookDir } from '../../../src/core/book'
import { readSession } from '../../../src/core/state'
import { sessionsFile } from '../../../src/shell/context'
import type { BookChatInfo } from '../../../src/core/book-source'

const chat = (dirName: string, started: string): BookChatInfo => ({
  dirName, kind: 'group', title: '派对', started, cast: ['白狐'], scenes: 2, chars: 100, lines: 7,
})

describe('开书卡片', () => {
  it('最多列 20 场，标签不重复', () => {
    const list = Array.from({ length: 25 }, (_, i) => chat(`d-${i}`, `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`))
    const q = buildOpenQuestions(list)
    expect(q.items[0]!.options).toHaveLength(20)
    expect(q.items[0]!.multiSelect).toBe(true)
    expect(new Set(q.items[0]!.options.map((o) => o.label)).size).toBe(20)
    expect(q.items[1]!.options.map((o) => o.label)).toEqual(['第三人称（贴着主角）', '第一人称'])
  })
  it('解读回答：选了聊天与人称；没选聊天视为取消', () => {
    const q = buildOpenQuestions([chat('d-1', '2026-10-01T00:00:00Z')])
    const label = q.items[0]!.options[0]!.label
    expect(interpretOpenAnswer({ answers: [{ id: 'book-chats', selected: [label] }, { id: 'book-person', selected: ['第一人称'] }] }, q.byLabel))
      .toEqual({ kind: 'ok', chats: ['d-1'], person: 'first' })
    expect(interpretOpenAnswer({ answers: [{ id: 'book-chats', selected: [] }] }, q.byLabel)).toEqual({ kind: 'cancel' })
    expect(interpretOpenAnswer({ answers: [{ id: 'book-chats', selected: [label] }] }, q.byLabel))
      .toEqual({ kind: 'ok', chats: ['d-1'], person: 'third' })
  })
})

describe('openBook', () => {
  let tavern: string
  beforeEach(async () => { tavern = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-ob-')) })
  afterEach(async () => { await fs.rm(tavern, { recursive: true, force: true }) })
  it('建书、绑定会话', async () => {
    const r = await openBook(tavern, 's-1', { title: '生日', chats: ['d-1'], person: 'third' }, new Date())
    expect(await findBookDir(tavern, r.id)).toBe(r.dir)
    expect(await readBookMeta(r.dir)).toMatchObject({ title: '生日', chats: ['d-1'], person: 'third' })
    expect((await readSession(sessionsFile(tavern), 's-1')).record).toMatchObject({ mode: 'book', state: 'writing', bookId: r.id })
  })
})

describe('buildBookPrompt', () => {
  it('未开书：只给指引；已开书：带书的事实与主角档案', () => {
    expect(buildBookPrompt('GUIDE', { kind: 'opening' })).toContain('/aha 写书')
    const p = buildBookPrompt('GUIDE', {
      kind: 'writing', title: '生日', person: 'third', protagonist: '', chats: ['d-1'], me: '我叫夏树。', status: [], running: false,
    })
    expect(p).toContain('GUIDE')
    expect(p).toContain('d-1')
    expect(p).toContain('我叫夏树。')
    expect(p).toContain('no outline yet')
  })
})
