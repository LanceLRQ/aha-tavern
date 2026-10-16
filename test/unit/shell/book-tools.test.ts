import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { createBook, readOutline, readSection, readBookMeta } from '../../../src/core/book'
import { saveCharacter } from '../../../src/core/card'
import {
  chatsText, surveyText, saveOutlineText, writeText, exportText, statusLines, type BookEnv, type BookAt,
} from '../../../src/shell/book-tools'
import { BookJobs, type GenerateFn } from '../../../src/shell/book-writer'
import { fakeRuntime } from './helpers/runtime'

let tavern: string
let at: BookAt
let foxId: string
const agent = { id: 's-1', ctx: {} }

beforeEach(async () => {
  tavern = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-bt-'))
  foxId = (await saveCharacter(tavern, { name: '白狐', persona: 'p', appearance: '狐耳' })).card.id
  const dir = path.join(tavern, 'chats', 'g-a001')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.yaml'), YAML.stringify({ kind: 'group', participants: [foxId], session: 's', started: '2026-10-10T12:00:00.000Z', title: '派对' }))
  await fs.writeFile(path.join(dir, 'chat.jsonl'), [
    { time: '2026-10-10T12:00:00.000Z', type: 'character', speaker: foxId, text: '挂歪了。', scene: 1 },
    { time: '2026-10-10T12:05:00.000Z', type: 'scene', text: '切蛋糕', cast: [foxId], scene: 2 },
    { time: '2026-10-10T12:06:00.000Z', type: 'character', speaker: foxId, text: '许愿吧。', scene: 2 },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  const b = await createBook(tavern, { title: '生日', person: 'third', chats: ['g-a001'], sessionId: 's-1', now: new Date() })
  at = { tavernDir: tavern, bookId: b.id, bookDir: b.dir }
})
afterEach(async () => { await fs.rm(tavern, { recursive: true, force: true }) })

const OUTLINE = `title: 生日
protagonist: 夏树
chapters:
  - title: 第一话
    chat: g-a001
    sections:
      - brief: 拌嘴
        range: { scene: 1 }
      - brief: 许愿
        range: { scene: 2 }
`

function env(gen: GenerateFn = async () => ({ kind: 'ok', text: '成稿。' })): BookEnv & { woke: string[]; notes: string[] } {
  const woke: string[] = []
  const notes: string[] = []
  return {
    rt: fakeRuntime(), jobs: new BookJobs(), generateFor: () => gen,
    notify: (_a, t) => notes.push(t), wake: (_a, t) => woke.push(t), refresh: vi.fn(async () => {}), woke, notes,
  }
}

const waitIdle = async (e: BookEnv) => { while (e.jobs.running(at.bookId)) await new Promise((r) => setTimeout(r, 5)) }

describe('aha_book_chats / aha_book_survey', () => {
  it('列出聊天与场景', async () => {
    expect(await chatsText(env(), at)).toContain('g-a001')
    const s = await surveyText(env(), at, 'g-a001')
    expect(s).toContain('scene 1')
    expect(s).toContain('scene 2')
  })
  it('survey 不存在的聊天', async () => {
    expect(await surveyText(env(), at, 'nope')).toMatch(/^error: /)
  })
})

describe('aha_book_outline', () => {
  it('保存目录，并把书名、主角名写进 book.yaml', async () => {
    const e = env()
    const r = await saveOutlineText(e, agent, at, OUTLINE)
    expect(r).toMatch(/^outline saved/)
    expect((await readOutline(at.bookDir))!.chapters).toHaveLength(1)
    expect(await readBookMeta(at.bookDir)).toMatchObject({ title: '生日', protagonist: '夏树' })
    expect(e.refresh).toHaveBeenCalled()
  })
  it('范围越界不落盘', async () => {
    const r = await saveOutlineText(env(), agent, at, OUTLINE.replace('scene: 2', 'scene: 9'))
    expect(r).toMatch(/^error: /)
    expect(await readOutline(at.bookDir)).toBeNull()
  })
  it('第三人称而主角名为空时拒绝', async () => {
    expect(await saveOutlineText(env(), agent, at, OUTLINE.replace('protagonist: 夏树', 'protagonist: ""'))).toMatch(/protagonist/)
  })
  it('写作中拒绝保存目录', async () => {
    const e = env(() => new Promise(() => {}))
    await saveOutlineText(e, agent, at, OUTLINE)
    await writeText(e, agent, at, {})
    expect(await saveOutlineText(e, agent, at, OUTLINE)).toMatch(/writing in progress/)
  })
})

describe('aha_book_write', () => {
  it('没有目录时拒绝', async () => {
    expect(await writeText(env(), agent, at, {})).toMatch(/^error: no outline/)
  })
  it('写所有未写的节，写完唤醒编辑', async () => {
    const e = env()
    await saveOutlineText(e, agent, at, OUTLINE)
    expect(await writeText(e, agent, at, {})).toMatch(/^started: 2 sections/)
    await waitIdle(e)
    expect((await readSection(at.bookDir, '01-01'))!.body).toBe('成稿。')
    expect((await readSection(at.bookDir, '01-02'))!.fm).toMatchObject({ chat: 'g-a001', range: { scene: 2 } })
    expect(e.notes).toHaveLength(2)
    expect(e.woke).toHaveLength(1)
    expect(await writeText(e, agent, at, {})).toMatch(/nothing to write/)
  })
  it('重写一节：带修改要求与当前成稿', async () => {
    const seen: string[] = []
    const e = env(async (_s, u) => { seen.push(u); return { kind: 'ok', text: '新稿。' } })
    await saveOutlineText(e, agent, at, OUTLINE)
    await writeText(e, agent, at, {})
    await waitIdle(e)
    expect(await writeText(e, agent, at, { section: '1-2', request: '短一点' })).toMatch(/^started: 1 section/)
    await waitIdle(e)
    expect(seen[2]).toContain('<revision_request>\n短一点')
    expect(seen[2]).toContain('<current_draft>\n新稿。')
    expect(seen[0]).toContain('白狐：\n外貌：狐耳')
  })
  it('节号不存在、修改要求为空都拒绝', async () => {
    const e = env()
    await saveOutlineText(e, agent, at, OUTLINE)
    expect(await writeText(e, agent, at, { section: '3-1', request: 'x' })).toMatch(/^error: no section/)
    expect(await writeText(e, agent, at, { section: '1-1', request: ' ' })).toMatch(/^error: request/)
  })
  it('拿不到模型时不开写', async () => {
    const e = { ...env(), generateFor: () => undefined }
    await saveOutlineText(e, agent, at, OUTLINE)
    expect(await writeText(e, agent, at, {})).toMatch(/^error: no model/)
  })
})

describe('状态与导出', () => {
  it('statusLines 标出未写与已写；exportText 拼整本', async () => {
    const e = env()
    await saveOutlineText(e, agent, at, OUTLINE)
    expect((await statusLines(at)).join('\n')).toContain('missing')
    await writeText(e, agent, at, {})
    await waitIdle(e)
    expect((await statusLines(at)).join('\n')).not.toContain('missing')
    const r = await exportText(at)
    expect(r).toMatch(/^exported: /)
    const md = await fs.readFile(path.join(at.bookDir, '生日.md'), 'utf8')
    expect(md).toContain('# 生日')
    expect(md).toContain('成稿。')
  })
})
