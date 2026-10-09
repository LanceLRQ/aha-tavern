import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  saveCharacter, listCharacters, readCharacter, matchCharacterName, CARD_FILE,
} from '../../../src/core/card'
import { isAhaError } from '../../../src/core/errors'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-card-'))
  await fs.mkdir(path.join(dir, 'characters'), { recursive: true })
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const mk = (name: string, extra = {}) => saveCharacter(dir, { name, persona: `${name}的人设`, ...extra })
const writeRaw = async (d: string, content?: string) => {
  await fs.mkdir(path.join(dir, 'characters', d), { recursive: true })
  if (content !== undefined) await fs.writeFile(path.join(dir, 'characters', d, CARD_FILE), content)
}

describe('saveCharacter', () => {
  it('新建卡生成编号与目录', async () => {
    const r = await mk('白狐', { tagline: '狐', origin: { src: 'x', n: 1 } })
    expect(r.card.id).toMatch(/^c_/)
    expect(r.dir).toBe(path.join(dir, 'characters', '白狐'))
    const e = await readCharacter(dir, '白狐')
    expect(e).toMatchObject({ ok: true, card: { name: '白狐', tagline: '狐', origin: { src: 'x', n: 1 } } })
  })

  it('同名目录已存在时抛 character-exists', async () => {
    await mk('白狐')
    await expect(mk('白狐')).rejects.toSatisfy((e) => isAhaError(e, 'character-exists'))
  })

  it('缺必填项抛 card-invalid', async () => {
    await expect(saveCharacter(dir, { name: 'a', persona: ' ' })).rejects.toSatisfy((e) => isAhaError(e, 'card-invalid'))
  })

  it('修改卡编号不变，origin 沿用', async () => {
    const a = await mk('白狐', { origin: { k: 1 } })
    const b = await saveCharacter(dir, { id: a.card.id, name: '白狐', persona: '新人设' })
    expect(b.card.id).toBe(a.card.id)
    const e = await readCharacter(dir, a.card.id)
    expect(e).toMatchObject({ ok: true, card: { persona: '新人设', origin: { k: 1 } } })
  })

  it('改名后目录改名且 memory.md 还在', async () => {
    const a = await mk('白狐')
    await fs.writeFile(path.join(a.dir, 'memory.md'), '记忆')
    await fs.writeFile(path.join(a.dir, 'reference.png'), 'png')
    const b = await saveCharacter(dir, { id: a.card.id, name: '银狐', persona: 'p' })
    expect(b.dirName).toBe('银狐')
    await expect(fs.access(a.dir)).rejects.toBeTruthy()
    expect(await fs.readFile(path.join(b.dir, 'memory.md'), 'utf8')).toBe('记忆')
    expect(await fs.readFile(path.join(b.dir, 'reference.png'), 'utf8')).toBe('png')
    expect((await readCharacter(dir, a.card.id))?.ok).toBe(true)
  })

  it('改名撞上别的角色目录时抛 character-exists，原目录不动', async () => {
    const a = await mk('白狐')
    await mk('银狐')
    await expect(saveCharacter(dir, { id: a.card.id, name: '银狐', persona: 'p' }))
      .rejects.toSatisfy((e) => isAhaError(e, 'character-exists'))
    expect((await readCharacter(dir, '白狐'))?.ok).toBe(true)
  })

  it('修改不存在的编号抛 character-not-found', async () => {
    await expect(saveCharacter(dir, { id: 'c_nope', name: 'x', persona: 'p' }))
      .rejects.toSatisfy((e) => isAhaError(e, 'character-not-found'))
  })
})

describe('读卡与坏卡', () => {
  it('三种坏卡各自的原因', async () => {
    await writeRaw('缺文件')
    await writeRaw('坏yaml', 'name: [unclosed\n  : :')
    await writeRaw('缺必填', 'id: c_1\nname: 甲\n')
    const byDir = async (d: string) => readCharacter(dir, d)
    expect(await byDir('缺文件')).toMatchObject({ ok: false, problem: 'file-missing' })
    expect(await byDir('坏yaml')).toMatchObject({ ok: false, problem: 'yaml-invalid' })
    expect(await byDir('缺必填')).toMatchObject({ ok: false, problem: 'missing-required', detail: 'persona' })
    const bad = await byDir('缺文件')
    expect(bad && !bad.ok && bad.file).toBe(path.join(dir, 'characters', '缺文件', CARD_FILE))
  })

  it('列出时坏卡被标出，好卡照常', async () => {
    await mk('白狐')
    await writeRaw('坏的', 'x: 1')
    const list = await listCharacters(dir)
    expect(list.map((e) => [e.dirName, e.ok])).toEqual([['坏的', false], ['白狐', true]])
  })

  it('没有 characters 目录时列出为空；读不到返回 null', async () => {
    await fs.rm(path.join(dir, 'characters'), { recursive: true })
    expect(await listCharacters(dir)).toEqual([])
    expect(await readCharacter(dir, 'c_x')).toBeNull()
  })
})

describe('matchCharacterName', () => {
  it('精确、前缀唯一、前缀多个、无', async () => {
    await mk('白狐'); await mk('白狼'); await mk('黑猫'); await mk('黑猫猫')
    const list = await listCharacters(dir)
    expect(matchCharacterName(list, '黑猫')).toMatchObject({ kind: 'exact' })
    const amb = matchCharacterName(list, '白')
    expect(amb.kind).toBe('ambiguous')
    if (amb.kind === 'ambiguous') expect(amb.candidates).toHaveLength(2)
    expect(matchCharacterName(list, '红')).toEqual({ kind: 'none' })
    expect(matchCharacterName(list, '  ')).toEqual({ kind: 'none' })
  })

  it('前缀唯一时采用', async () => {
    await mk('白狐妖'); await mk('黑猫')
    const m = matchCharacterName(await listCharacters(dir), '白')
    expect(m.kind).toBe('prefix')
    if (m.kind === 'prefix' && m.entry.ok) expect(m.entry.card.name).toBe('白狐妖')
  })

  it('坏卡以目录名参与匹配', async () => {
    await writeRaw('坏狐', 'x: 1')
    const m = matchCharacterName(await listCharacters(dir), '坏')
    expect(m.kind).toBe('prefix')
    if (m.kind === 'prefix') expect(m.entry.ok).toBe(false)
  })

  it('同名多个精确匹配返回 ambiguous', async () => {
    await mk('白狐')
    await writeRaw('另一个', 'id: c_2\nname: 白狐\npersona: p\n')
    const m = matchCharacterName(await listCharacters(dir), '白狐')
    expect(m.kind).toBe('ambiguous')
  })
})

describe('第 1 轮修复', () => {
  it('character.yaml 读不了归为 unreadable，不拖垮列表', async () => {
    await mk('白狐')
    await fs.mkdir(path.join(dir, 'characters', '怪', CARD_FILE), { recursive: true })
    const list = await listCharacters(dir)
    expect(list).toHaveLength(2)
    expect(list.find((e) => e.dirName === '怪')).toMatchObject({ ok: false, problem: 'unreadable', detail: 'EISDIR' })
    expect(list.find((e) => e.dirName === '白狐')?.ok).toBe(true)
  })

  it('missing-id 被 listCharacters 标出', async () => {
    await writeRaw('手写', 'name: 手写\npersona: p\n')
    expect((await listCharacters(dir))[0]).toMatchObject({ ok: false, problem: 'missing-id' })
  })

  it('新建时认领 missing-id 的手写卡，保留 memory.md', async () => {
    await writeRaw('手写', 'name: 手写\npersona: p\n')
    await fs.writeFile(path.join(dir, 'characters', '手写', 'memory.md'), 'm')
    const r = await mk('手写')
    expect(r.card.id).toMatch(/^c_/)
    expect((await readCharacter(dir, r.card.id))?.ok).toBe(true)
    expect(await fs.readFile(path.join(r.dir, 'memory.md'), 'utf8')).toBe('m')
  })

  it('只改大小写的改名不误抛 character-exists', async () => {
    const a = await mk('fox')
    const b = await saveCharacter(dir, { id: a.card.id, name: 'Fox', persona: 'p' })
    expect(b.dirName).toBe('Fox')
    expect((await fs.readdir(path.join(dir, 'characters')))).toEqual(['Fox'])
    expect((await readCharacter(dir, a.card.id))?.ok).toBe(true)
  })

  it('新建写卡失败时清理刚建的空目录', async () => {
    const root = path.join(dir, 'characters')
    await fs.chmod(root, 0o555)
    try {
      await expect(mk('白狐')).rejects.toBeTruthy()
    } finally {
      await fs.chmod(root, 0o755)
    }
    // 目录建不出来时也不应留下任何东西
    expect(await fs.readdir(root)).toEqual([])
  })

  it('并发新建同名只有一个成功', async () => {
    const rs = await Promise.allSettled([mk('白狐'), mk('白狐')])
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rej = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(isAhaError(rej.reason, 'character-exists')).toBe(true)
  })
})
