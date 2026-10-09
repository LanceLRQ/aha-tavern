import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createChat } from '../../../src/core/chat'
import { saveImage, lastImage, type NewImageRecord } from '../../../src/core/images'
import { isAhaError } from '../../../src/core/errors'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-images-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const mk = () =>
  createChat(dir, {
    kind: 'chat',
    name: '白狐',
    participants: ['c_aaaa1111'],
    sessionId: 's-1',
    now: new Date(2026, 9, 9, 10, 0, 0),
  })

const rec = (over: Partial<NewImageRecord> = {}): NewImageRecord => ({
  scene: '雨夜的屋檐下',
  prompt: 'a fox girl under eaves',
  seed: 123,
  width: 832,
  height: 1216,
  steps: 12,
  workflow: 'qwen-image-2.1-gguf',
  redoOf: null,
  orientation: 'portrait',
  ...over,
})
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('saveImage', () => {
  it('第一张与第二张：编号、文件、记录', async () => {
    const c = await mk()
    const ts = '2026-10-09T14:20:03.511Z'
    const a = await saveImage(dir, c.id, png, 'png', rec({ ts }))
    expect(a.n).toBe(1)
    expect(a.file).toBe('images/001.png')
    expect(a.absPath).toBe(path.join(c.dir, 'images', '001.png'))
    expect(new Uint8Array(await fs.readFile(a.absPath))).toEqual(png)
    expect(a.record).toMatchObject({ n: 1, ts, file: 'images/001.png', seed: 123, redoOf: null })
    const b = await saveImage(dir, c.id, png, 'webp', rec({ seed: 7 }))
    expect(b.n).toBe(2)
    expect(b.file).toBe('images/002.webp')
    const lines = (await fs.readFile(path.join(c.dir, 'images.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual(a.record)
    expect(JSON.parse(lines[1]!).seed).toBe(7)
    expect(await fs.readdir(path.join(c.dir, 'images'))).toEqual(['001.png', '002.webp'])
  })
  it('未知扩展名按 png，jpeg 保留', async () => {
    const c = await mk()
    expect((await saveImage(dir, c.id, png, 'gif', rec())).file).toBe('images/001.png')
    expect((await saveImage(dir, c.id, png, 'jpeg', rec())).file).toBe('images/002.jpeg')
    expect((await saveImage(dir, c.id, png, 'PNG', rec())).file).toBe('images/003.png')
  })
  it('聊天目录不存在时抛 chat-not-found', async () => {
    await expect(saveImage(dir, 'zzzz', png, 'png', rec())).rejects.toSatisfy(
      (e) => isAhaError(e) && e.code === 'chat-not-found',
    )
  })
  it('末尾有损坏行：编号接续，lastImage 取到上一张', async () => {
    const c = await mk()
    await saveImage(dir, c.id, png, 'png', rec())
    await saveImage(dir, c.id, png, 'png', rec({ seed: 2 }))
    await fs.appendFile(path.join(c.dir, 'images.jsonl'), '{"n":3,"ts":')
    expect((await lastImage(dir, c.id))?.n).toBe(2)
    const x = await saveImage(dir, c.id, png, 'png', rec())
    expect(x.n).toBe(3)
    const text = await fs.readFile(path.join(c.dir, 'images.jsonl'), 'utf8')
    expect(text.split('\n').filter(Boolean)).toHaveLength(4)
    expect((await lastImage(dir, c.id))?.n).toBe(3)
  })
  it('n 不是正整数的行不算数', async () => {
    const c = await mk()
    await saveImage(dir, c.id, png, 'png', rec())
    await fs.appendFile(path.join(c.dir, 'images.jsonl'), '{"n":"x"}\n{"n":0}\n')
    expect((await lastImage(dir, c.id))?.n).toBe(1)
    expect((await saveImage(dir, c.id, png, 'png', rec())).n).toBe(2)
  })
  it('目标文件已存在时不覆盖，往后找空位', async () => {
    const c = await mk()
    await fs.mkdir(path.join(c.dir, 'images'), { recursive: true })
    await fs.writeFile(path.join(c.dir, 'images', '001.png'), 'old')
    await fs.writeFile(path.join(c.dir, 'images', '002.webp'), 'old2')
    const r = await saveImage(dir, c.id, png, 'png', rec())
    expect(r.n).toBe(3)
    expect(await fs.readFile(path.join(c.dir, 'images', '001.png'), 'utf8')).toBe('old')
  })
  it('超过 999 按实际位数', async () => {
    const c = await mk()
    await fs.writeFile(path.join(c.dir, 'images.jsonl'), JSON.stringify({ n: 999 }) + '\n')
    const r = await saveImage(dir, c.id, png, 'png', rec())
    expect(r.file).toBe('images/1000.png')
  })
  it('重新生成记 redoOf', async () => {
    const c = await mk()
    const a = await saveImage(dir, c.id, png, 'png', rec())
    const b = await saveImage(dir, c.id, png, 'png', rec({ redoOf: a.n, orientation: 'landscape' }))
    expect(b.record.redoOf).toBe(1)
    expect(await lastImage(dir, c.id)).toMatchObject({ n: 2, redoOf: 1, orientation: 'landscape' })
  })
  it('把上一张的整条记录展开传入：n、file 仍取新分配的', async () => {
    const c = await mk()
    const a = await saveImage(dir, c.id, png, 'png', rec({ ts: '2026-10-09T00:00:00.000Z' }))
    const b = await saveImage(dir, c.id, png, 'png', { ...a.record, ts: undefined, redoOf: a.n } as NewImageRecord)
    expect(b.record).toMatchObject({ n: 2, file: 'images/002.png', redoOf: 1 })
    expect(b.record.ts).not.toBe(a.record.ts)
    expect(Object.keys(b.record).sort()).toEqual(Object.keys(a.record).sort())
  })

  it('并发保存编号不重复', async () => {
    const c = await mk()
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => saveImage(dir, c.id, png, 'png', rec({ seed: i }))),
    )
    expect(rs.map((r) => r.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const lines = (await fs.readFile(path.join(c.dir, 'images.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('写图失败不留记录', async () => {
    const c = await mk()
    // images 被同名普通文件占住，建目录会失败
    await fs.writeFile(path.join(c.dir, 'images'), 'x')
    await expect(saveImage(dir, c.id, png, 'png', rec())).rejects.toThrow()
    await expect(fs.stat(path.join(c.dir, 'images.jsonl'))).rejects.toThrow()
  })
})

describe('lastImage', () => {
  it('没有记录或聊天不存在返回 null', async () => {
    const c = await mk()
    expect(await lastImage(dir, c.id)).toBeNull()
    expect(await lastImage(dir, 'zzzz')).toBeNull()
  })
})
