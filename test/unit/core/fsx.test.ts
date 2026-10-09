import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite, modifyFile, safeDirName, expandHome } from '../../../src/core/fsx'
import { isAhaError } from '../../../src/core/errors'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-fsx-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('atomicWrite', () => {
  it('目标已存在时覆盖，且不留临时文件', async () => {
    const f = path.join(dir, 'a', 'b.txt')
    await atomicWrite(f, 'one')
    await atomicWrite(f, 'two')
    expect(await fs.readFile(f, 'utf8')).toBe('two')
    expect(await fs.readdir(path.dirname(f))).toEqual(['b.txt'])
  })

  it('写入失败时临时文件被清理，原文件不变', async () => {
    const f = path.join(dir, 'c.txt')
    await atomicWrite(f, 'keep')
    // 目标是目录，rename 必然失败
    const target = path.join(dir, 'isdir')
    await fs.mkdir(target)
    await expect(atomicWrite(target, 'x')).rejects.toBeTruthy()
    expect((await fs.readdir(dir)).sort()).toEqual(['c.txt', 'isdir'])
    expect(await fs.readFile(f, 'utf8')).toBe('keep')
  })
})

describe('modifyFile', () => {
  it('文件不存在时 current 为 null，返回修改后的内容', async () => {
    const f = path.join(dir, 'x.txt')
    const out = await modifyFile(f, (cur) => (cur ?? '') + 'a')
    expect(out).toBe('a')
    expect(await fs.readFile(f, 'utf8')).toBe('a')
  })

  it('并发修改被串行化，不丢更新', async () => {
    const f = path.join(dir, 'n.txt')
    await atomicWrite(f, '0')
    await Promise.all(
      Array.from({ length: 20 }, () =>
        modifyFile(f, async (cur) => {
          await new Promise((r) => setTimeout(r, 2))
          return String(Number(cur) + 1)
        }),
      ),
    )
    expect(await fs.readFile(f, 'utf8')).toBe('20')
  })

  it('过期的锁文件会被清理', async () => {
    const f = path.join(dir, 's.txt')
    const lock = f + '.lock'
    await fs.writeFile(lock, '')
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lock, old, old)
    await modifyFile(f, () => 'ok', { staleMs: 1000 })
    expect(await fs.readFile(f, 'utf8')).toBe('ok')
  })

  it('锁被占用且未过期时超时报错', async () => {
    const f = path.join(dir, 't.txt')
    await fs.writeFile(f + '.lock', '')
    await expect(modifyFile(f, () => 'x', { timeoutMs: 150, staleMs: 60_000 })).rejects.toSatisfy(
      (e) => isAhaError(e, 'lock-timeout'),
    )
  })

  it('修改函数抛错时释放锁', async () => {
    const f = path.join(dir, 'e.txt')
    await expect(modifyFile(f, () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(fs.access(f + '.lock')).rejects.toBeTruthy()
  })
})

describe('safeDirName', () => {
  it('去掉斜杠、冒号，保留中文', () => {
    expect(safeDirName('白狐/小:姐')).toBe('白狐小姐')
  })
  it('去掉首尾空格与结尾的点', () => {
    expect(safeDirName('  白狐 . ')).toBe('白狐')
  })
  it('清理后为空则报错', () => {
    expect(() => safeDirName(' / : ')).toThrowError(/./)
    try { safeDirName('..') } catch (e) { expect(isAhaError(e, 'invalid-name')).toBe(true) }
  })
})

describe('expandHome', () => {
  it('展开 ~ 开头', () => {
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'))
    expect(expandHome('/a/b')).toBe('/a/b')
  })
})
