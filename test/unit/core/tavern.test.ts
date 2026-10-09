import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  DATA_VERSION, MARKER_FILE, isTavern, createTavern, openTavern, migrateTavern, assertWritable,
} from '../../../src/core/tavern'
import { isAhaError } from '../../../src/core/errors'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-tavern-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const writeMarker = (version: number) =>
  fs.writeFile(path.join(dir, MARKER_FILE), YAML.stringify({ version, id: 't_abcd1234', name: '旧店' }))

describe('createTavern', () => {
  it('空目录开店后有标记文件与目录结构', async () => {
    expect(await isTavern(dir)).toBe(false)
    const m = await createTavern(dir, { name: '测试店' })
    expect(m.version).toBe(DATA_VERSION)
    expect(m.id).toMatch(/^t_/)
    expect(await isTavern(dir)).toBe(true)
    for (const d of ['characters', 'chats', '.aha']) {
      expect((await fs.stat(path.join(dir, d))).isDirectory()).toBe(true)
    }
    await expect(fs.access(path.join(dir, 'lore'))).rejects.toBeTruthy()
    const raw = YAML.parse(await fs.readFile(path.join(dir, MARKER_FILE), 'utf8'))
    expect(raw).toMatchObject({ version: DATA_VERSION, id: m.id, name: '测试店' })
  })

  it('重复开店报错', async () => {
    await createTavern(dir, { name: 'a' })
    await expect(createTavern(dir, { name: 'b' })).rejects.toSatisfy((e) => isAhaError(e, 'already-tavern'))
  })
})

describe('openTavern 版本判定', () => {
  it('版本等于当前：可读写', async () => {
    await writeMarker(DATA_VERSION)
    expect((await openTavern(dir)).access).toBe('readwrite')
  })
  it('版本低于当前：需迁移', async () => {
    await writeMarker(DATA_VERSION - 1)
    expect((await openTavern(dir)).access).toBe('migrate')
  })
  it('版本高于当前：只读，写入被拒绝', async () => {
    await writeMarker(DATA_VERSION + 1)
    const info = await openTavern(dir)
    expect(info.access).toBe('readonly')
    expect(() => assertWritable(info)).toThrowError(expect.objectContaining({ code: 'version-too-new' }))
  })
  it('非酒馆目录报错；标记文件损坏报错', async () => {
    await expect(openTavern(dir)).rejects.toSatisfy((e) => isAhaError(e, 'not-tavern'))
    await fs.writeFile(path.join(dir, MARKER_FILE), 'version: x\n')
    await expect(openTavern(dir)).rejects.toSatisfy((e) => isAhaError(e, 'marker-invalid'))
  })
})

describe('migrateTavern', () => {
  it('迁移前备份标记文件，并按迁移表升到当前版本', async () => {
    await writeMarker(DATA_VERSION - 1)
    const calls: number[] = []
    const info = await migrateTavern(dir, {
      [DATA_VERSION - 1]: async (m) => { calls.push(m.version); return { ...m, version: DATA_VERSION } },
    })
    expect(calls).toEqual([DATA_VERSION - 1])
    expect(info.access).toBe('readwrite')
    const files = await fs.readdir(dir)
    const bak = files.find((f) => f.startsWith(MARKER_FILE + '.bak'))
    expect(bak).toBeTruthy()
    expect(YAML.parse(await fs.readFile(path.join(dir, bak!), 'utf8')).version).toBe(DATA_VERSION - 1)
  })
  it('缺少对应迁移时报错且不改标记文件', async () => {
    await writeMarker(DATA_VERSION - 1)
    await expect(migrateTavern(dir, {})).rejects.toSatisfy((e) => isAhaError(e, 'marker-invalid'))
    expect((await openTavern(dir)).marker.version).toBe(DATA_VERSION - 1)
  })
  it('版本过新时拒绝', async () => {
    await writeMarker(DATA_VERSION + 1)
    await expect(migrateTavern(dir)).rejects.toSatisfy((e) => isAhaError(e, 'version-too-new'))
  })
})
