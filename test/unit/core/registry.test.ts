import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { isAhaError } from '../../../src/core/errors'
import { readRegistry, registerTavern, updateTavernPath } from '../../../src/core/registry'
import { createTavern } from '../../../src/core/tavern'

let root: string
let reg: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-reg-'))
  reg = path.join(root, 'global', 'taverns.yaml')
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function makeTavern(name: string) {
  const dir = path.join(root, name)
  await fs.mkdir(dir)
  const m = await createTavern(dir, { name })
  return { dir, m }
}

describe('registry', () => {
  it('登记表不存在时为空', async () => {
    expect(await readRegistry(reg)).toEqual([])
  })

  it('登记后可读出', async () => {
    const { dir, m } = await makeTavern('a')
    await registerTavern(reg, { id: m.id, name: 'a', path: dir })
    expect(await readRegistry(reg)).toEqual([{ id: m.id, name: 'a', path: dir }])
  })

  it('重复登记同一路径只留一项', async () => {
    const { dir, m } = await makeTavern('a')
    await registerTavern(reg, { id: m.id, name: 'a', path: dir })
    await registerTavern(reg, { id: m.id, name: 'a2', path: dir })
    const list = await readRegistry(reg)
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('a2')
  })

  it('路径失效或无标记文件的项在读取时被清理并写回', async () => {
    const a = await makeTavern('a')
    const b = await makeTavern('b')
    await registerTavern(reg, { id: a.m.id, name: 'a', path: a.dir })
    await registerTavern(reg, { id: b.m.id, name: 'b', path: b.dir })
    await fs.rm(a.dir, { recursive: true })
    await fs.rm(path.join(b.dir, 'aha-tavern.yaml'))
    expect(await readRegistry(reg)).toEqual([])
    expect(await fs.readFile(reg, 'utf8')).not.toContain(a.m.id)
  })

  it('同编号换路径后更新路径', async () => {
    const { dir, m } = await makeTavern('a')
    await registerTavern(reg, { id: m.id, name: 'a', path: dir })
    const moved = path.join(root, 'moved')
    await fs.rename(dir, moved)
    await registerTavern(reg, { id: m.id, name: 'a', path: moved })
    expect(await readRegistry(reg)).toEqual([{ id: m.id, name: 'a', path: moved }])
  })

  it('updateTavernPath 更新已有项；编号未登记时返回 false', async () => {
    const { dir, m } = await makeTavern('a')
    await registerTavern(reg, { id: m.id, name: 'a', path: dir })
    const moved = path.join(root, 'm2')
    await fs.rename(dir, moved)
    expect(await updateTavernPath(reg, m.id, moved)).toBe(true)
    expect(await updateTavernPath(reg, 't_nope0000', moved)).toBe(false)
  })

  it('没有失效项时读取不改写文件', async () => {
    const { dir, m } = await makeTavern('a')
    await registerTavern(reg, { id: m.id, name: 'a', path: dir })
    const before = await fs.stat(reg)
    await new Promise((r) => setTimeout(r, 20))
    await readRegistry(reg)
    const after = await fs.stat(reg)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
    await expect(fs.access(reg + '.lock')).rejects.toBeTruthy()
  })

  it('字段不合法的条目不返回，但剔除失效项写回时原样保留', async () => {
    const a = await makeTavern('a')
    const odd = { id: 'x', weird: 1 }
    await fs.mkdir(path.dirname(reg), { recursive: true })
    await fs.writeFile(reg, YAML.stringify({
      taverns: [{ id: a.m.id, name: 'a', path: a.dir }, odd, { id: 't_gone', name: 'g', path: path.join(root, 'gone') }],
    }))
    expect(await readRegistry(reg)).toEqual([{ id: a.m.id, name: 'a', path: a.dir }])
    const doc = YAML.parse(await fs.readFile(reg, 'utf8'))
    expect(doc.taverns).toContainEqual(odd)
    expect(doc.taverns).toHaveLength(2)
    await registerTavern(reg, { id: 't_new', name: 'n', path: a.dir })
    expect(YAML.parse(await fs.readFile(reg, 'utf8')).taverns).toContainEqual(odd)
  })

  it('登记表损坏时抛 registry-invalid', async () => {
    await fs.mkdir(path.dirname(reg), { recursive: true })
    await fs.writeFile(reg, 'taverns: [unclosed\n  - : :')
    await expect(readRegistry(reg)).rejects.toSatisfy((e) => isAhaError(e, 'registry-invalid'))
    await expect(registerTavern(reg, { id: 'a', name: 'a', path: root })).rejects.toSatisfy((e) => isAhaError(e, 'registry-invalid'))
  })
})
