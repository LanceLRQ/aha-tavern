import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readMe, writeMe, readWorld, writeWorld, countChars } from '../../../src/core/docs'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-docs-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe.each([['主角档案', readMe, writeMe, 'me.md'], ['世界观', readWorld, writeWorld, 'world.md']] as const)(
  '%s', (_n, read, write, file) => {
    it('不存在', async () => {
      expect(await read(dir)).toEqual({ exists: false, text: '', length: 0, empty: true })
    })
    it('存在但为空白', async () => {
      await fs.writeFile(path.join(dir, file), ' \n')
      expect(await read(dir)).toMatchObject({ exists: true, empty: true })
    })
    it('有内容，写入返回字数', async () => {
      expect(await write(dir, '你好😀ab')).toBe(5)
      expect(await read(dir)).toEqual({ exists: true, text: '你好😀ab', length: 5, empty: false })
    })
  })

it('countChars 按 Unicode 字符计', () => {
  expect(countChars('😀😀')).toBe(2)
  expect(countChars('中文')).toBe(2)
})
