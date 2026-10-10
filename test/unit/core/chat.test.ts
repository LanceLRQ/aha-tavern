import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  createChat,
  findChatDir,
  appendRecord,
  readRecords,
  readChatMeta,
  writeSummary,
  writeSummaryFile,
  setChatTitle,
  setChatAutoRead,
  readChatAutoRead,
  recallChat,
} from '../../../src/core/chat'
import { countChars } from '../../../src/core/docs'
import { isAhaError } from '../../../src/core/errors'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-chat-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const now = new Date(2026, 9, 8, 21, 30, 5)
const mk = (name = '白狐', session = 's-1') =>
  createChat(dir, { kind: 'chat', name, participants: ['c_aaaa1111'], sessionId: session, now })

describe('createChat', () => {
  it('目录名与元数据', async () => {
    const c = await mk()
    expect(path.basename(c.dir)).toMatch(/^20261008-2130-白狐-[0-9a-z]{4}$/)
    expect(c.dir).toBe(path.join(dir, 'chats', c.dirName))
    expect(c.dirName.endsWith(`-${c.id}`)).toBe(true)
    const meta = YAML.parse(await fs.readFile(path.join(c.dir, 'meta.yaml'), 'utf8'))
    expect(meta).toMatchObject({
      kind: 'chat',
      participants: ['c_aaaa1111'],
      session: 's-1',
      title: '',
    })
    expect(new Date(meta.started).getTime()).toBe(now.getTime())
    expect(await readChatMeta(dir, c.id)).toMatchObject({ kind: 'chat', title: '' })
  })
  it('名称里的非法字符被清理', async () => {
    const c = await mk('a/b:c')
    expect(c.dirName).toMatch(/^20261008-2130-abc-/)
  })
  it('短编号撞车时重新生成', async () => {
    const a = await mk()
    const ids = new Set<string>([a.id])
    for (let i = 0; i < 20; i++) ids.add((await mk()).id)
    expect(ids.size).toBe(21)
  })
})

describe('appendRecord / readRecords', () => {
  it('追加多条后逐行可解析', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { time: '2026-10-08T21:31:00.000Z', type: 'user', speaker: 'user', text: '你好\n换行' })
    await appendRecord(dir, c.id, { time: '2026-10-08T21:31:05.000Z', type: 'character', speaker: 'c_aaaa1111', text: '嗯。' })
    const raw = await fs.readFile(path.join(c.dir, 'chat.jsonl'), 'utf8')
    const lines = raw.split('\n')
    expect(lines.length).toBe(3)
    expect(lines[2]).toBe('')
    expect(JSON.parse(lines[0]!).text).toBe('你好\n换行')
    const r = await readRecords(dir, c.id)
    expect(r.skipped).toBe(0)
    expect(r.records.map((x) => x.speaker)).toEqual(['user', 'c_aaaa1111'])
  })
  it('未给时间则取当前', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'x' })
    const r = await readRecords(dir, c.id)
    expect(Number.isNaN(Date.parse(r.records[0]!.time))).toBe(false)
  })
  it('坏行跳过并计数，未知字段与类型保留', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'a' })
    await fs.appendFile(path.join(c.dir, 'chat.jsonl'), 'not json\n\n[1]\n{"type":"scene-break","text":"新场景","scene":2}\n')
    const r = await readRecords(dir, c.id)
    expect(r.skipped).toBe(2)
    expect(r.records.length).toBe(2)
    expect(r.records[1]!).toMatchObject({ type: 'scene-break', text: '新场景', scene: 2 })
  })
  it('没有记录文件时为空', async () => {
    const c = await mk()
    expect(await readRecords(dir, c.id)).toEqual({ records: [], skipped: 0 })
  })
  it('聊天不存在时抛 chat-not-found', async () => {
    await expect(appendRecord(dir, 'zzzz', { type: 'user', speaker: 'user', text: 'x' })).rejects.toSatisfy((e) =>
      isAhaError(e, 'chat-not-found'),
    )
  })
})

describe('追加与往返回归', () => {
  it('末尾缺换行的残行不吞掉下一条', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'a' })
    await fs.appendFile(path.join(c.dir, 'chat.jsonl'), '{"type":"user","tex')
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'b' })
    const r = await readRecords(dir, c.id)
    expect(r.skipped).toBe(1)
    expect(r.records.map((x) => x.text)).toEqual(['a', 'b'])
  })
  it('文件为空或正常结尾时不多补换行', async () => {
    const c = await mk()
    await fs.writeFile(path.join(c.dir, 'chat.jsonl'), '')
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'a' })
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'b' })
    const raw = await fs.readFile(path.join(c.dir, 'chat.jsonl'), 'utf8')
    expect(raw.split('\n').length).toBe(3)
  })
  it('正文含引号、反斜杠、换行、U+2028 时一行一个合法 JSON 且读回相等', async () => {
    const c = await mk()
    const text = 'say "hi"\\ path\nline2\u2028sep\u2029end\r\n'
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text })
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'next' })
    const raw = await fs.readFile(path.join(c.dir, 'chat.jsonl'), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    expect(lines.map((l) => JSON.parse(l).text)[0]).toBe(text)
    const r = await readRecords(dir, c.id)
    expect(r.records[0]!.text).toBe(text)
  })
  it('标题含换行与 YAML 特殊字符时往返正确', async () => {
    const c = await mk()
    const title = 'a: b # c\n"q" \'s\' - [x]'
    await writeSummary(dir, c.id, { summary: 's', title })
    expect((await readChatMeta(dir, c.id)).title).toBe(title)
  })
  it('meta 字段不合格时抛 chat-invalid', async () => {
    const c = await mk()
    await fs.writeFile(path.join(c.dir, 'meta.yaml'), 'kind: nope\nparticipants: 1\n')
    await expect(readChatMeta(dir, c.id)).rejects.toSatisfy((e) => isAhaError(e, 'chat-invalid'))
  })
})

describe('writeSummaryFile / setChatTitle', () => {
  it('分步：只写梗概不动标题，只改标题不动梗概', async () => {
    const c = await mk()
    await writeSummaryFile(dir, c.id, '梗概')
    expect((await readChatMeta(dir, c.id)).title).toBe('')
    await setChatTitle(dir, c.id, '标题')
    expect((await readChatMeta(dir, c.id)).title).toBe('标题')
    expect(await fs.readFile(path.join(c.dir, 'summary.md'), 'utf8')).toBe('梗概')
  })
  it('找不到聊天抛 chat-not-found；meta 缺失时 setChatTitle 抛 chat-invalid', async () => {
    await expect(writeSummaryFile(dir, 'zzzz', 'x')).rejects.toSatisfy((e) => isAhaError(e, 'chat-not-found'))
    const c = await mk()
    await fs.rm(path.join(c.dir, 'meta.yaml'))
    await expect(setChatTitle(dir, c.id, 't')).rejects.toSatisfy((e) => isAhaError(e, 'chat-invalid'))
  })
})

describe('autoRead', () => {
  it('新建聊天缺省为 false，meta.yaml 里没有该字段也能解析', async () => {
    const c = await mk()
    expect(YAML.parse(await fs.readFile(path.join(c.dir, 'meta.yaml'), 'utf8'))).not.toHaveProperty('autoRead')
    expect(await readChatAutoRead(dir, c.id)).toBe(false)
    expect((await readChatMeta(dir, c.id)).autoRead).toBeUndefined()
  })
  it('写 true 再写 false；不动标题和别的字段', async () => {
    const c = await mk()
    await setChatTitle(dir, c.id, '标题')
    await setChatAutoRead(dir, c.id, true)
    expect(await readChatAutoRead(dir, c.id)).toBe(true)
    expect(await readChatMeta(dir, c.id)).toMatchObject({ title: '标题', session: 's-1', autoRead: true })
    await setChatAutoRead(dir, c.id, false)
    expect(await readChatAutoRead(dir, c.id)).toBe(false)
    await setChatTitle(dir, c.id, '新标题')
    expect(await readChatMeta(dir, c.id)).toMatchObject({ title: '新标题', autoRead: false })
  })
  it('非布尔值当 false，文件仍能解析', async () => {
    const c = await mk()
    const file = path.join(c.dir, 'meta.yaml')
    const meta = YAML.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, YAML.stringify({ ...meta, autoRead: 'yes' }))
    expect(await readChatAutoRead(dir, c.id)).toBe(false)
  })
  it('找不到聊天抛 chat-not-found；meta 缺失时写入抛 chat-invalid', async () => {
    await expect(setChatAutoRead(dir, 'zzzz', true)).rejects.toSatisfy((e) => isAhaError(e, 'chat-not-found'))
    const c = await mk()
    await fs.rm(path.join(c.dir, 'meta.yaml'))
    await expect(setChatAutoRead(dir, c.id, true)).rejects.toSatisfy((e) => isAhaError(e, 'chat-invalid'))
  })
})

describe('findChatDir', () => {
  it('多个目录并存时按编号后缀找对', async () => {
    const a = await mk('白狐')
    const b = await mk('青衫')
    // 名称里恰好含另一个聊天编号，也不应被误中
    const tricky = path.join(dir, 'chats', `20261008-2130-${a.id}-zzzz`)
    await fs.mkdir(tricky, { recursive: true })
    expect(await findChatDir(dir, a.id)).toBe(a.dir)
    expect(await findChatDir(dir, b.id)).toBe(b.dir)
    expect(await findChatDir(dir, 'zzzz')).toBe(tricky)
    expect(await findChatDir(dir, 'nope')).toBeNull()
  })
  it('不合格的编号一律返回 null', async () => {
    const c = await mk()
    await fs.mkdir(path.join(dir, 'chats', 'x-foo-bar-' + c.id), { recursive: true })
    // 编号可能是纯数字，大写后与原编号相同，那种情况不算不合格
    const upper = c.id.toUpperCase() === c.id ? [] : [c.id.toUpperCase()]
    for (const bad of [`bar-${c.id}`, `foo-bar-${c.id}`, '', '..', '../' + c.id, `a/${c.id}`, `a\\${c.id}`, 'a'.repeat(40), ...upper, ' ' + c.id]) {
      expect(await findChatDir(dir, bad)).toBeNull()
    }
    expect(await findChatDir(dir, c.id)).toBe(c.dir)
  })
  it('同名后缀的普通文件不命中', async () => {
    await fs.mkdir(path.join(dir, 'chats'), { recursive: true })
    await fs.writeFile(path.join(dir, 'chats', '20261008-2130-x-ab12'), 'file')
    expect(await findChatDir(dir, 'ab12')).toBeNull()
  })
  it('没有 chats 目录时为 null', async () => {
    expect(await findChatDir(dir, 'abcd')).toBeNull()
  })
})

describe('writeSummary / recallChat', () => {
  it('写梗概后回忆返回梗概，标题同时写进元数据', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'hi' })
    await writeSummary(dir, c.id, { summary: '# 夜谈\n\n聊了很久。', title: '夜谈' })
    expect((await readChatMeta(dir, c.id)).title).toBe('夜谈')
    expect(await fs.readFile(path.join(c.dir, 'summary.md'), 'utf8')).toContain('聊了很久')
    const r = await recallChat(dir, c.id)
    expect(r).toMatchObject({ kind: 'recap' })
    expect(r.kind === 'recap' && r.text).toContain('聊了很久')
  })
  it('无梗概时返回节选，不超上限，说话人可替换', async () => {
    const c = await mk()
    for (let i = 0; i < 60; i++) {
      await appendRecord(dir, c.id, { type: i % 2 ? 'character' : 'user', speaker: i % 2 ? 'c_aaaa1111' : 'user', text: `第${i}句话`.padEnd(40, '。') })
    }
    const r = await recallChat(dir, c.id, { limit: 500, speakerNames: { user: '我', c_aaaa1111: '白狐' } })
    expect(r.kind).toBe('excerpt')
    if (r.kind !== 'excerpt') return
    expect(countChars(r.text)).toBeLessThanOrEqual(500)
    expect(r.omitted).toBeGreaterThan(0)
    expect(r.text).toContain('第0句话')
    expect(r.text).toContain('第59句话')
    expect(r.text).toContain('白狐')
    expect(r.text).not.toContain('c_aaaa1111')
    expect(r.text).toContain('中间省略')
  })
  it('默认上限 2000', async () => {
    const c = await mk()
    for (let i = 0; i < 100; i++) await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'x'.repeat(100) })
    const r = await recallChat(dir, c.id)
    expect(r.kind === 'excerpt' && countChars(r.text)).toBeLessThanOrEqual(2000)
  })
  it('记录很短时节选就是全文', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: '你好' })
    await appendRecord(dir, c.id, { type: 'character', speaker: 'c_aaaa1111', text: '嗯' })
    const r = await recallChat(dir, c.id)
    expect(r).toMatchObject({ kind: 'excerpt', omitted: 0 })
    if (r.kind !== 'excerpt') return
    expect(r.text).toBe('user：你好\nc_aaaa1111：嗯')
  })
  it('单条超长时被截断而不超限', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: '长'.repeat(3000) })
    const r = await recallChat(dir, c.id, { limit: 100 })
    expect(r.kind).toBe('excerpt')
    if (r.kind !== 'excerpt') return
    expect(countChars(r.text)).toBeLessThanOrEqual(100)
    expect(r.truncated).toBe(true)
    expect(r.text.startsWith('user：长长长')).toBe(true)
    expect(r.text.endsWith('…')).toBe(true)
  })
  it('上限小到放不下前缀时为 empty', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: '长'.repeat(50) })
    expect(await recallChat(dir, c.id, { limit: 3 })).toEqual({ kind: 'empty' })
  })
  it('truncated 标记：全文为 false，有省略为 true', async () => {
    const c = await mk()
    await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: '短' })
    const a = await recallChat(dir, c.id)
    expect(a.kind === 'excerpt' && a.truncated).toBe(false)
    for (let i = 0; i < 50; i++) await appendRecord(dir, c.id, { type: 'user', speaker: 'user', text: 'y'.repeat(50) })
    const b = await recallChat(dir, c.id, { limit: 300 })
    expect(b.kind === 'excerpt' && b.truncated).toBe(true)
  })
  it('有目录无记录为 empty；空白梗概视为没有', async () => {
    const c = await mk()
    expect(await recallChat(dir, c.id)).toEqual({ kind: 'empty' })
    await writeSummary(dir, c.id, { summary: '  \n', title: '' })
    expect(await recallChat(dir, c.id)).toEqual({ kind: 'empty' })
  })
  it('目录不存在为 missing', async () => {
    expect(await recallChat(dir, 'abcd')).toEqual({ kind: 'missing' })
  })
  it('未知类型的记录也能节选', async () => {
    const c = await mk()
    await fs.appendFile(path.join(c.dir, 'chat.jsonl'), '{"type":"narration","text":"风起了"}\n')
    const r = await recallChat(dir, c.id)
    expect(r.kind === 'excerpt' && r.text).toBe('风起了')
  })
})
