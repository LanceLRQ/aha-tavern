import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { CARD_FILE, listCharacters, readCharacter, saveCharacter } from '../../../src/core/card'
import { readMe, writeMe } from '../../../src/core/docs'
import {
  fingerprintOf, importCharacter, importProfile, listImportable,
} from '../../../src/core/importer'
import { createTavern } from '../../../src/core/tavern'

let root: string
let src: string
let dst: string
const NOW = '2026-10-09T08:00:00.000Z'

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-import-'))
  src = path.join(root, 'src')
  dst = path.join(root, 'dst')
  await fs.mkdir(src)
  await fs.mkdir(dst)
  await createTavern(src, { name: '甲', id: 't_src' })
  await createTavern(dst, { name: '乙', id: 't_dst' })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const mk = async (name: string, extra: Record<string, unknown> = {}) => {
  const r = await saveCharacter(src, { name, persona: `${name}的人设`, tagline: `${name}简介`, ...extra })
  return r
}
const exists = (p: string) => fs.access(p).then(() => true, () => false)

describe('listImportable', () => {
  it('列出好卡与是否有主角档案，坏卡只计数与原因', async () => {
    const a = await mk('白狐')
    await fs.mkdir(path.join(src, 'characters', '坏的'))
    await fs.writeFile(path.join(src, 'characters', '坏的', CARD_FILE), 'name: x\n')
    const l1 = await listImportable(src)
    expect(l1.tavernId).toBe('t_src')
    expect(l1.tavernName).toBe('甲')
    expect(l1.characters).toEqual([{ id: a.card.id, name: '白狐', tagline: '白狐简介', dirName: '白狐' }])
    expect(l1.broken).toEqual([{ dirName: '坏的', problem: 'missing-required', detail: 'persona' }])
    expect(l1.hasProfile).toBe(false)
    await writeMe(src, '我是主角')
    expect((await listImportable(src)).hasProfile).toBe(true)
  })
})

describe('importCharacter', () => {
  it('正常复制：带参考图与音色，不带 memory.md、子目录、隐藏文件', async () => {
    const a = await mk('白狐')
    const d = a.dir
    await fs.writeFile(path.join(d, 'reference.png'), 'PNG')
    await fs.writeFile(path.join(d, 'voice_ref.wav'), 'WAV')
    await fs.writeFile(path.join(d, 'memory.md'), '# 记忆\n私密')
    await fs.writeFile(path.join(d, '.hidden'), 'x')
    await fs.mkdir(path.join(d, 'sub'))
    await fs.writeFile(path.join(d, 'sub', 'a.txt'), 'x')
    const r = await importCharacter(src, dst, { characterId: a.card.id, now: NOW })
    expect(r.status).toBe('imported')
    const out = path.join(dst, 'characters', '白狐')
    expect((await fs.readdir(out)).sort()).toEqual(['character.yaml', 'reference.png', 'voice_ref.wav'])
    expect(await fs.readFile(path.join(out, 'reference.png'), 'utf8')).toBe('PNG')
    const got = await readCharacter(dst, a.card.id)
    expect(got?.ok && got.card.name).toBe('白狐')
    // 来源酒馆原封不动
    expect(await exists(path.join(d, 'memory.md'))).toBe(true)
    expect(await exists(path.join(dst, 'chats', 'x'))).toBe(false)
  })

  it('写入来源记录：酒馆编号、内容指纹、时间', async () => {
    const a = await mk('白狐')
    const raw = await fs.readFile(path.join(a.dir, CARD_FILE), 'utf8')
    await importCharacter(src, dst, { characterId: a.card.id, now: NOW })
    const doc = YAML.parse(await fs.readFile(path.join(dst, 'characters', '白狐', CARD_FILE), 'utf8'))
    expect(doc.origin).toEqual({ tavern: 't_src', fingerprint: fingerprintOf(raw), at: NOW })
    expect(doc.origin.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(doc.id).toBe(a.card.id)
  })

  it('来源卡自带的 origin 被新的来源记录取代', async () => {
    const a = await mk('白狐', { origin: { tavern: 't_old', fingerprint: 'x', at: 'y' } })
    await importCharacter(src, dst, { characterId: a.card.id, now: NOW })
    const got = await readCharacter(dst, a.card.id)
    expect(got?.ok && (got.card.origin as { tavern: string }).tavern).toBe('t_src')
  })

  it('超过大小上限的附带文件跳过并报告', async () => {
    const a = await mk('白狐')
    await fs.writeFile(path.join(a.dir, 'big.wav'), 'x'.repeat(100))
    await fs.writeFile(path.join(a.dir, 'ok.png'), 'x')
    const r = await importCharacter(src, dst, { characterId: a.card.id, now: NOW, maxFileBytes: 50 })
    expect(r.status === 'imported' && r.skippedFiles).toEqual([{ name: 'big.wav', reason: 'too-large' }])
    expect(await exists(path.join(dst, 'characters', '白狐', 'big.wav'))).toBe(false)
    expect(await exists(path.join(dst, 'characters', '白狐', 'ok.png'))).toBe(true)
  })

  it('不跟随符号链接', async () => {
    const a = await mk('白狐')
    const outside = path.join(root, 'secret.txt')
    await fs.writeFile(outside, 's')
    await fs.symlink(outside, path.join(a.dir, 'link.txt'))
    await importCharacter(src, dst, { characterId: a.card.id, now: NOW })
    expect(await exists(path.join(dst, 'characters', '白狐', 'link.txt'))).toBe(false)
  })

  it('来源里找不到编号：抛 character-not-found；来源卡是坏卡同样', async () => {
    await expect(importCharacter(src, dst, { characterId: 'c_nope', now: NOW })).rejects.toMatchObject({ code: 'character-not-found' })
  })

  it('来源与目标是同一间酒馆：拒绝', async () => {
    const a = await mk('白狐')
    await expect(importCharacter(src, src, { characterId: a.card.id, now: NOW })).rejects.toMatchObject({ code: 'import-same-tavern' })
    await expect(importProfile(src, src)).rejects.toMatchObject({ code: 'import-same-tavern' })
  })

  describe('编号冲突', () => {
    let id: string
    beforeEach(async () => {
      const a = await mk('白狐', { persona: '新人设' })
      id = a.card.id
      await fs.writeFile(path.join(a.dir, 'reference.png'), 'NEW')
      // 目标里先导入一次，再让目标这边有自己的记忆与改动
      await importCharacter(src, dst, { characterId: id, now: NOW })
      await fs.writeFile(path.join(dst, 'characters', '白狐', 'memory.md'), '# 目标的记忆')
      await saveCharacter(src, { id, name: '白狐', persona: '来源又改了', tagline: '新简介' })
    })

    it('没给决定：返回 needs-decision，什么都不动', async () => {
      const r = await importCharacter(src, dst, { characterId: id, now: NOW })
      expect(r).toEqual({ status: 'needs-decision', conflict: { kind: 'id', existing: { id, name: '白狐', dirName: '白狐' }, overwriteBlocked: false } })
      const got = await readCharacter(dst, id)
      expect(got?.ok && got.card.persona).toBe('新人设')
    })

    it('overwrite：换卡与附带文件，memory.md 原样', async () => {
      const r = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })
      expect(r.status === 'imported' && r.mode).toBe('overwrite')
      const got = await readCharacter(dst, id)
      expect(got?.ok && got.card.persona).toBe('来源又改了')
      expect(await fs.readFile(path.join(dst, 'characters', '白狐', 'memory.md'), 'utf8')).toBe('# 目标的记忆')
      expect((await listCharacters(dst)).length).toBe(1)
    })

    it('overwrite 且来源改了名：目录跟着新名字走，记忆随目录', async () => {
      await saveCharacter(src, { id, name: '银狐', persona: '来源又改了' })
      const r = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })
      expect(r.status === 'imported' && r.dirName).toBe('银狐')
      expect(await fs.readFile(path.join(dst, 'characters', '银狐', 'memory.md'), 'utf8')).toBe('# 目标的记忆')
      expect(await exists(path.join(dst, 'characters', '白狐'))).toBe(false)
    })

    it('overwrite 改名撞上别的目录：抛 character-exists，不动原卡', async () => {
      await saveCharacter(dst, { name: '银狐', persona: 'x' })
      await saveCharacter(src, { id, name: '银狐', persona: 'y' })
      await expect(importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' }))
        .rejects.toMatchObject({ code: 'character-exists' })
      const got = await readCharacter(dst, id)
      expect(got?.ok && got.card.persona).toBe('新人设')
    })

    it('skip：不动', async () => {
      expect(await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'skip' })).toEqual({ status: 'skipped' })
      const got = await readCharacter(dst, id)
      expect(got?.ok && got.card.persona).toBe('新人设')
    })

    it('copy：新编号，目录名加序号，原角色不动', async () => {
      const r = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'copy' })
      expect(r.status).toBe('imported')
      if (r.status !== 'imported') return
      expect(r.mode).toBe('copy')
      expect(r.card.id).not.toBe(id)
      expect(r.dirName).toBe('白狐 2')
      expect(r.card.name).toBe('白狐 2')
      const all = await listCharacters(dst)
      expect(all.length).toBe(2)
      const orig = await readCharacter(dst, id)
      expect(orig?.ok && orig.card.persona).toBe('新人设')
      // 再来一次：序号递增
      const r2 = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'copy' })
      expect(r2.status === 'imported' && r2.dirName).toBe('白狐 3')
    })
  })

  describe('名字冲突（编号不同）', () => {
    let id: string
    beforeEach(async () => {
      id = (await mk('白狐')).card.id
      await saveCharacter(dst, { name: '白狐', persona: '目标自己的白狐' })
    })

    it('报告为 name 冲突', async () => {
      const r = await importCharacter(src, dst, { characterId: id, now: NOW })
      expect(r).toEqual({ status: 'needs-decision', conflict: { kind: 'name', dirName: '白狐' } })
    })

    it('copy：改名加序号，换新编号，来源记录指向来源酒馆', async () => {
      const r = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'copy' })
      expect(r.status === 'imported' && r.dirName).toBe('白狐 2')
      if (r.status !== 'imported') return
      expect(r.card.id).not.toBe(id)
      expect(r.card.origin).toEqual({
        tavern: 't_src', fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/), at: NOW,
      })
      expect((await listCharacters(dst)).length).toBe(2)
    })

    it('skip 可以；overwrite 非法', async () => {
      expect((await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'skip' })).status).toBe('skipped')
      await expect(importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' }))
        .rejects.toMatchObject({ code: 'import-invalid-decision' })
    })

    it('目标里同名目录是坏卡也算名字冲突', async () => {
      await fs.rm(path.join(dst, 'characters', '白狐'), { recursive: true })
      await fs.mkdir(path.join(dst, 'characters', '白狐'))
      const r = await importCharacter(src, dst, { characterId: id, now: NOW })
      expect(r.status).toBe('needs-decision')
    })
  })
})

describe('importProfile', () => {
  it('目标没有：直接复制', async () => {
    await writeMe(src, '源档案')
    expect(await importProfile(src, dst)).toEqual({ status: 'imported', mode: 'new' })
    expect((await readMe(dst)).text).toBe('源档案')
  })
  it('目标已有：不给决定返回 needs-decision；overwrite 覆盖；skip 不动', async () => {
    await writeMe(src, '源档案')
    await writeMe(dst, '我的')
    expect(await importProfile(src, dst)).toEqual({ status: 'needs-decision' })
    expect((await readMe(dst)).text).toBe('我的')
    expect(await importProfile(src, dst, 'skip')).toEqual({ status: 'skipped' })
    expect((await readMe(dst)).text).toBe('我的')
    expect(await importProfile(src, dst, 'overwrite')).toEqual({ status: 'imported', mode: 'overwrite' })
    expect((await readMe(dst)).text).toBe('源档案')
  })
  it('来源没有：no-source', async () => {
    expect(await importProfile(src, dst)).toEqual({ status: 'no-source' })
  })
})

describe('覆盖的写入顺序与附件语义', () => {
  let id: string
  let out: string
  beforeEach(async () => {
    const a = await mk('白狐', { persona: '旧人设' })
    id = a.card.id
    await fs.writeFile(path.join(a.dir, 'reference.png'), 'OLD')
    await importCharacter(src, dst, { characterId: id, now: NOW })
    out = path.join(dst, 'characters', '白狐')
    await fs.writeFile(path.join(out, 'extra_note.txt'), '目标自己加的')
    await fs.writeFile(path.join(out, 'memory.md'), '# 记忆')
    await saveCharacter(src, { id, name: '白狐', persona: '新人设' })
    await fs.writeFile(path.join(a.dir, 'reference.png'), 'NEW')
  })
  const leftovers = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))

  it('覆盖时目标里来源没有的旧附件保留，同名文件被替换', async () => {
    await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })
    expect(await fs.readFile(path.join(out, 'extra_note.txt'), 'utf8')).toBe('目标自己加的')
    expect(await fs.readFile(path.join(out, 'reference.png'), 'utf8')).toBe('NEW')
    expect(await leftovers(out)).toEqual([])
  })

  it('写新卡失败：目录名不变、原卡与附件原样、没有临时文件', async () => {
    const real = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('character.yaml')) throw Object.assign(new Error('boom'), { code: 'EIO' })
      return real(from, to)
    })
    await expect(importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })).rejects.toThrow('boom')
    spy.mockRestore()
    const got = await readCharacter(dst, id)
    expect(got?.ok && got.card.persona).toBe('旧人设')
    expect(await fs.readFile(path.join(out, 'reference.png'), 'utf8')).toBe('OLD')
    expect(await leftovers(out)).toEqual([])
  })

  it('改名覆盖时写新卡失败：目录名不变（不会出现目录已改名而卡还是旧的）', async () => {
    await saveCharacter(src, { id, name: '银狐', persona: '新人设' })
    const real = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('character.yaml')) throw Object.assign(new Error('boom'), { code: 'EIO' })
      return real(from, to)
    })
    await expect(importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })).rejects.toThrow('boom')
    spy.mockRestore()
    expect(await fs.readdir(path.join(dst, 'characters'))).toEqual(['白狐'])
    const got = await readCharacter(dst, id)
    expect(got?.ok && got.card).toMatchObject({ name: '白狐', persona: '旧人设' })
  })

  it('改目录名失败：原卡内容恢复，仍可按编号读取', async () => {
    await saveCharacter(src, { id, name: '银狐', persona: '新人设' })
    const real = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}银狐`)) throw Object.assign(new Error('rename-boom'), { code: 'EIO' })
      return real(from, to)
    })
    await expect(importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })).rejects.toThrow('rename-boom')
    spy.mockRestore()
    const got = await readCharacter(dst, id)
    expect(got?.ok && got.card).toMatchObject({ name: '白狐', persona: '旧人设' })
    expect(await leftovers(out)).toEqual([])
  })

  it('复制某个附件失败：只算这个文件没带上，旧文件不被截断，没有临时文件', async () => {
    const real = fs.copyFile.bind(fs)
    const spy = vi.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
      if (String(from).endsWith('reference.png')) throw Object.assign(new Error('nospace'), { code: 'ENOSPC' })
      return real(from, to, mode)
    })
    const r = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'overwrite' })
    spy.mockRestore()
    expect(r.status === 'imported' && r.skippedFiles).toEqual([{ name: 'reference.png', reason: 'failed', code: 'ENOSPC' }])
    expect(await fs.readFile(path.join(out, 'reference.png'), 'utf8')).toBe('OLD')
    expect(await leftovers(out)).toEqual([])
    const got = await readCharacter(dst, id)
    expect(got?.ok && got.card.persona).toBe('新人设')
  })

  it('同编号冲突且新名字的目录被第三个角色占用：conflict 标明不能覆盖', async () => {
    await saveCharacter(dst, { name: '银狐', persona: '第三个' })
    await saveCharacter(src, { id, name: '银狐', persona: 'y' })
    const r = await importCharacter(src, dst, { characterId: id, now: NOW })
    expect(r).toMatchObject({ status: 'needs-decision', conflict: { kind: 'id', overwriteBlocked: true } })
    const ok = await importCharacter(src, dst, { characterId: id, now: NOW, decision: 'copy' })
    expect(ok.status).toBe('imported')
  })
})

describe('来源的特殊情况', () => {
  it('来源数据版本过新：拒绝，带错误码', async () => {
    const a = await mk('白狐')
    await fs.writeFile(path.join(src, 'aha-tavern.yaml'), YAML.stringify({ version: 99, id: 't_src', name: '甲' }))
    await expect(listImportable(src)).rejects.toMatchObject({ code: 'version-too-new' })
    await expect(importCharacter(src, dst, { characterId: a.card.id, now: NOW })).rejects.toMatchObject({ code: 'version-too-new' })
    await expect(importProfile(src, dst)).rejects.toMatchObject({ code: 'version-too-new' })
  })

  it('character.yaml 是符号链接：不可导入，计入坏卡并说明原因', async () => {
    const a = await mk('白狐')
    const real = path.join(root, 'elsewhere.yaml')
    await fs.rename(path.join(a.dir, CARD_FILE), real)
    await fs.symlink(real, path.join(a.dir, CARD_FILE))
    const l = await listImportable(src)
    expect(l.characters).toEqual([])
    expect(l.broken).toEqual([{ dirName: '白狐', problem: 'symlink', detail: CARD_FILE }])
    await expect(importCharacter(src, dst, { characterId: a.card.id, now: NOW })).rejects.toMatchObject({ code: 'import-source-symlink' })
    expect(await listCharacters(dst)).toEqual([])
  })

  it('角色目录本身是符号链接：不可导入，计入坏卡', async () => {
    const a = await mk('白狐')
    const real = path.join(root, 'elsewhere-dir')
    await fs.rename(a.dir, real)
    await fs.symlink(real, a.dir)
    const l = await listImportable(src)
    expect(l.characters).toEqual([])
    expect(l.broken).toEqual([{ dirName: '白狐', problem: 'symlink', detail: '' }])
    await expect(importCharacter(src, dst, { characterId: a.card.id, now: NOW })).rejects.toMatchObject({ code: 'character-not-found' })
  })

  it('characters/ 本身是符号链接：整体不读', async () => {
    const a = await mk('白狐')
    const real = path.join(root, 'elsewhere-chars')
    await fs.rename(path.join(src, 'characters'), real)
    await fs.symlink(real, path.join(src, 'characters'))
    const l = await listImportable(src)
    expect(l.characters).toEqual([])
    expect(l.broken).toEqual([{ dirName: 'characters', problem: 'symlink', detail: '' }])
    await expect(importCharacter(src, dst, { characterId: a.card.id, now: NOW })).rejects.toMatchObject({ code: 'import-source-symlink' })
  })

  it('me.md 是符号链接：不当作主角档案，导入时拒绝', async () => {
    const real = path.join(root, 'secret.md')
    await fs.writeFile(real, '外面的文件')
    await fs.symlink(real, path.join(src, 'me.md'))
    const l = await listImportable(src)
    expect(l.hasProfile).toBe(false)
    expect(l.profileUnsafe).toBe(true)
    await expect(importProfile(src, dst)).rejects.toMatchObject({ code: 'import-source-symlink' })
    expect((await readMe(dst)).exists).toBe(false)
  })

  it('character.yaml 位置上是同名目录：算读不出来的卡，不可导入', async () => {
    const a = await mk('白狐')
    await fs.rm(path.join(a.dir, CARD_FILE))
    await fs.mkdir(path.join(a.dir, CARD_FILE))
    const l = await listImportable(src)
    expect(l.characters).toEqual([])
    expect(l.broken).toHaveLength(1)
    expect(l.broken[0]!.dirName).toBe('白狐')
    await expect(importCharacter(src, dst, { characterId: a.card.id, now: NOW })).rejects.toMatchObject({ code: 'character-not-found' })
  })
})
