import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { CARD_FILE, readCharacter, saveCharacter, updateCharacterLooks } from '../../../src/core/card'
import {
  DRAFTS_DIR, MAX_DRAFTS, REFERENCE_FILE, addDraft, clearDrafts, getDraft, listDrafts, readLooks, readPngBytes,
  removeLook, resolveLook, saveLook, type DraftMeta,
} from '../../../src/core/looks'

let root: string
let charDir: string
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
const png = (tag: number) => Buffer.concat([PNG, Buffer.from([tag])])
const meta = (over: Partial<DraftMeta> = {}): DraftMeta => ({ origin: 'text', prompt: 'p', seed: 1, ...over })
const exists = (p: string) => fs.access(p).then(() => true, () => false)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-looks-'))
  charDir = (await saveCharacter(root, { name: '阿青', persona: '人设' })).dir
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const cardLooks = async () => {
  const e = await readCharacter(root, '阿青')
  return e?.ok ? (e.card.looks ?? []) : null
}

describe('候选', () => {
  it('编号三位、接续最大编号，删掉旧的后不回头复用', async () => {
    const a = await addDraft(charDir, png(1), meta())
    const b = await addDraft(charDir, png(2), meta({ origin: 'draft', basedOn: 1, note: '换衣服' }))
    expect(a.record.n).toBe(1)
    expect(path.basename(a.file)).toBe('001.png')
    expect(b.record).toMatchObject({ n: 2, origin: 'draft', basedOn: 1, note: '换衣服' })
    await fs.rm(a.file)
    const c = await addDraft(charDir, png(3), meta())
    expect(c.record.n).toBe(3)
    // 删掉最大的那张，编号也不能回头（记录行还在）
    await fs.rm(c.file)
    const d = await addDraft(charDir, png(4), meta())
    expect(d.record.n).toBe(4)
  })

  it('jsonl 一张一行，带全部字段', async () => {
    await addDraft(charDir, png(1), meta({ origin: 'images', note: 'n', prompt: '白发', seed: 77 }))
    const lines = (await fs.readFile(path.join(charDir, DRAFTS_DIR, 'drafts.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ n: 1, origin: 'images', note: 'n', prompt: '白发', seed: 77 })
    expect(typeof JSON.parse(lines[0]!).ts).toBe('string')
  })

  it('超过 20 张删最早的，图片与记录行一并去掉', async () => {
    for (let i = 1; i <= MAX_DRAFTS + 3; i++) await addDraft(charDir, png(i), meta())
    const list = await listDrafts(charDir)
    expect(list).toHaveLength(MAX_DRAFTS)
    expect(list[0]!.n).toBe(4)
    expect(list.at(-1)!.n).toBe(23)
    const files = (await fs.readdir(path.join(charDir, DRAFTS_DIR))).filter((f) => f.endsWith('.png'))
    expect(files).toHaveLength(MAX_DRAFTS)
    expect(files).not.toContain('001.png')
    const next = await addDraft(charDir, png(0), meta())
    expect(next.record.n).toBe(24)
  })

  it('getDraft 接受 3、"3"、"003"；不存在为 null', async () => {
    for (let i = 1; i <= 3; i++) await addDraft(charDir, png(i), meta({ seed: i }))
    for (const k of [3, '3', '003']) expect((await getDraft(charDir, k))?.record.seed).toBe(3)
    expect(await getDraft(charDir, 9)).toBeNull()
    expect(await getDraft(charDir, 'abc')).toBeNull()
    expect(await getDraft(charDir, '../1')).toBeNull()
  })

  it('坏行跳过', async () => {
    await addDraft(charDir, png(1), meta())
    const log = path.join(charDir, DRAFTS_DIR, 'drafts.jsonl')
    await fs.appendFile(log, 'not json\n{"n":"x"}\n{"n":5,"origin":"bad"}\n')
    await addDraft(charDir, png(2), meta())
    expect((await listDrafts(charDir)).map((r) => r.n)).toEqual([1, 2])
  })

  it('清空：整个 .look-drafts 没了；没有时也不报错', async () => {
    await clearDrafts(charDir)
    await addDraft(charDir, png(1), meta())
    await clearDrafts(charDir)
    expect(await exists(path.join(charDir, DRAFTS_DIR))).toBe(false)
    expect(await listDrafts(charDir)).toEqual([])
  })
})

describe('保存', () => {
  it('不带名字：成为默认形象，替换时 replaced 为真；不清空候选', async () => {
    const d1 = await addDraft(charDir, png(1), meta())
    expect(await saveLook(charDir, { draft: 1 })).toEqual({ ok: true, look: 'default', replaced: false })
    expect(await fs.readFile(path.join(charDir, REFERENCE_FILE))).toEqual(png(1))
    await addDraft(charDir, png(2), meta())
    expect(await saveLook(charDir, { draft: '2' })).toEqual({ ok: true, look: 'default', replaced: true })
    expect(await fs.readFile(path.join(charDir, REFERENCE_FILE))).toEqual(png(2))
    expect(await exists(d1.file)).toBe(true)
    expect((await fs.readdir(charDir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('带名字：新建额外形象，写图并登记到角色卡', async () => {
    await addDraft(charDir, png(1), meta())
    const r = await saveLook(charDir, { draft: 1, name: ' 睁眼 ', when: '动真格时' })
    expect(r.ok && r.replaced).toBe(false)
    const id = r.ok ? r.look : ''
    expect(id).toMatch(/^l_[0-9a-z]{8}$/)
    expect(await fs.readFile(path.join(charDir, 'looks', `${id}.png`))).toEqual(png(1))
    expect(await cardLooks()).toEqual([{ id, name: '睁眼', when: '动真格时' }])
  })

  it('替换同名形象：编号不变，图换了；给了 when 就更新，没给就保留', async () => {
    await addDraft(charDir, png(1), meta())
    await addDraft(charDir, png(2), meta())
    const first = await saveLook(charDir, { draft: 1, name: '睁眼', when: '甲' })
    const id = first.ok ? first.look : ''
    const again = await saveLook(charDir, { draft: 2, name: '睁眼' })
    expect(again).toEqual({ ok: true, look: id, replaced: true })
    expect(await fs.readFile(path.join(charDir, 'looks', `${id}.png`))).toEqual(png(2))
    expect(await cardLooks()).toEqual([{ id, name: '睁眼', when: '甲' }])
    await saveLook(charDir, { draft: 1, name: '睁眼', when: '乙' })
    expect(await cardLooks()).toEqual([{ id, name: '睁眼', when: '乙' }])
  })

  it('失败原因：候选不存在、名字、when、套数上限', async () => {
    expect(await saveLook(charDir, { draft: 1 })).toEqual({ ok: false, reason: 'draft-not-found' })
    await addDraft(charDir, png(1), meta())
    const bad = (o: object) => saveLook(charDir, { draft: 1, ...o })
    expect(await bad({ name: '   ', when: 'x' })).toEqual({ ok: false, reason: 'bad-name' })
    expect(await bad({ name: 'a'.repeat(21), when: 'x' })).toEqual({ ok: false, reason: 'bad-name' })
    expect(await bad({ name: 'default', when: 'x' })).toEqual({ ok: false, reason: 'bad-name' })
    expect(await bad({ name: '新', when: '' })).toEqual({ ok: false, reason: 'bad-when' })
    expect(await bad({ name: '新' })).toEqual({ ok: false, reason: 'bad-when' })
    expect(await bad({ name: '新', when: 'x'.repeat(101) })).toEqual({ ok: false, reason: 'bad-when' })
    expect(await cardLooks()).toEqual([])
    expect(await exists(path.join(charDir, 'looks'))).toBe(false)
    for (let i = 0; i < 8; i++) expect((await bad({ name: `形象${i}`, when: 'w' })).ok).toBe(true)
    expect(await bad({ name: '第九', when: 'w' })).toEqual({ ok: false, reason: 'too-many' })
    expect((await fs.readdir(path.join(charDir, 'looks'))).length).toBe(8)
    // 已有的仍可替换
    expect((await bad({ name: '形象0' })).ok).toBe(true)
  })

  it('新建时写卡失败：刚写的图被删掉，不留半截状态', async () => {
    await addDraft(charDir, png(1), meta())
    const r = await saveLook(charDir, { draft: 1, name: '睁眼', when: 'w' }, {
      updateLooks: async () => { throw new Error('boom') },
    })
    expect(r).toEqual({ ok: false, reason: 'write-failed' })
    const left = await fs.readdir(path.join(charDir, 'looks')).catch(() => [])
    expect(left).toEqual([])
    expect(await cardLooks()).toEqual([])
  })

  it('替换时写卡失败：图已换、卡条目仍有效，返回里标明 imageReplaced', async () => {
    await addDraft(charDir, png(1), meta())
    await addDraft(charDir, png(2), meta())
    const first = await saveLook(charDir, { draft: 1, name: '睁眼', when: '甲' })
    const id = first.ok ? first.look : ''
    const r = await saveLook(charDir, { draft: 2, name: '睁眼', when: '乙' }, {
      updateLooks: async () => { throw new Error('boom') },
    })
    expect(r).toEqual({ ok: false, reason: 'write-failed', imageReplaced: true })
    expect(await fs.readFile(path.join(charDir, 'looks', `${id}.png`))).toEqual(png(2))
    expect(await cardLooks()).toEqual([{ id, name: '睁眼', when: '甲' }])
  })

  it('写图失败归 write-failed，不抛异常', async () => {
    await addDraft(charDir, png(1), meta())
    await fs.writeFile(path.join(charDir, 'looks'), 'x') // looks 被一个文件占了，建不了目录
    expect(await saveLook(charDir, { draft: 1, name: '睁眼', when: 'w' })).toEqual({ ok: false, reason: 'write-failed' })
    expect(await cardLooks()).toEqual([])
  })
})

describe('读与解析', () => {
  it('readLooks：以角色卡为准，文件不在的标 exists:false', async () => {
    await addDraft(charDir, png(1), meta())
    await saveLook(charDir, { draft: 1 })
    const a = await saveLook(charDir, { draft: 1, name: '甲', when: 'w' })
    await updateCharacterLooks(charDir, (cur) => [...cur, { id: 'l_zzzzzzzz', name: '乙', when: '' }])
    // 磁盘上多出的、卡里没登记的图不算
    await fs.writeFile(path.join(charDir, 'looks', 'l_yyyyyyyy.png'), PNG)
    const s = await readLooks(charDir)
    expect(s.default).toEqual({ file: path.join(charDir, REFERENCE_FILE), exists: true })
    expect(s.extras.map((l) => [l.name, l.exists])).toEqual([['甲', true], ['乙', false]])
    expect(a.ok && s.extras[0]!.id).toBe(a.ok ? a.look : '')
  })

  it('没有定妆图时 default.exists 为假', async () => {
    expect((await readLooks(charDir)).default.exists).toBe(false)
  })

  it('resolveLook：默认、名字（去空白）、编号、找不到、文件不在', async () => {
    expect(await resolveLook(charDir)).toEqual({ ok: false, reason: 'file-missing' })
    await addDraft(charDir, png(1), meta())
    await saveLook(charDir, { draft: 1 })
    const a = await saveLook(charDir, { draft: 1, name: '睁眼', when: 'w' })
    const id = a.ok ? a.look : ''
    const def = { ok: true, look: 'default', file: path.join(charDir, REFERENCE_FILE) }
    expect(await resolveLook(charDir)).toEqual(def)
    expect(await resolveLook(charDir, 'default')).toEqual(def)
    expect(await resolveLook(charDir, '  ')).toEqual(def)
    const extra = { ok: true, look: id, file: path.join(charDir, 'looks', `${id}.png`) }
    expect(await resolveLook(charDir, ' 睁眼 ')).toEqual(extra)
    expect(await resolveLook(charDir, id)).toEqual(extra)
    expect(await resolveLook(charDir, '睁')).toEqual({ ok: false, reason: 'no-such-look' })
    await fs.rm(extra.file)
    expect(await resolveLook(charDir, '睁眼')).toEqual({ ok: false, reason: 'file-missing' })
  })

  it('readPngBytes：文件头不是 PNG 或读不到都算没有', async () => {
    const good = path.join(root, 'g.png')
    const stub = path.join(root, 's.png')
    await fs.writeFile(good, png(1))
    await fs.writeFile(stub, Buffer.from([1, 2, 3, 4]))
    expect(await readPngBytes(good)).toEqual(png(1))
    expect(await readPngBytes(stub)).toBeNull()
    expect(await readPngBytes(path.join(root, 'none.png'))).toBeNull()
  })
})

describe('删除', () => {
  it('删默认形象', async () => {
    await addDraft(charDir, png(1), meta())
    await saveLook(charDir, { draft: 1 })
    expect(await removeLook(charDir, 'default')).toEqual({ ok: true, look: 'default' })
    expect(await exists(path.join(charDir, REFERENCE_FILE))).toBe(false)
    expect(await removeLook(charDir, 'default')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('删额外形象：图与卡里的条目都去掉，其余保留', async () => {
    await addDraft(charDir, png(1), meta())
    const a = await saveLook(charDir, { draft: 1, name: '甲', when: 'w' })
    const b = await saveLook(charDir, { draft: 1, name: '乙', when: 'w' })
    const r = await removeLook(charDir, ' 甲 ')
    expect(r).toEqual({ ok: true, look: a.ok ? a.look : '' })
    expect((await cardLooks())?.map((l) => l.name)).toEqual(['乙'])
    expect(await exists(path.join(charDir, 'looks', `${a.ok ? a.look : ''}.png`))).toBe(false)
    expect(await exists(path.join(charDir, 'looks', `${b.ok ? b.look : ''}.png`))).toBe(true)
    expect(await removeLook(charDir, '甲')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('改卡失败时不删图片', async () => {
    await addDraft(charDir, png(1), meta())
    const a = await saveLook(charDir, { draft: 1, name: '甲', when: 'w' })
    const r = await removeLook(charDir, '甲', { updateLooks: async () => { throw new Error('boom') } })
    expect(r).toEqual({ ok: false, reason: 'write-failed' })
    expect(await exists(path.join(charDir, 'looks', `${a.ok ? a.look : ''}.png`))).toBe(true)
    expect((await cardLooks())?.length).toBe(1)
  })
})

describe('角色卡 looks 栏随卡文字保存', () => {
  it('保存卡文字（输入里没有 looks）不冲掉 looks', async () => {
    await addDraft(charDir, png(1), meta())
    const a = await saveLook(charDir, { draft: 1, name: '甲', when: 'w' })
    const e = await readCharacter(root, '阿青')
    const id = e?.ok ? e.card.id : ''
    await saveCharacter(root, { id, name: '阿青', persona: '改过的人设' })
    const got = await readCharacter(root, '阿青')
    expect(got?.ok && got.card.persona).toBe('改过的人设')
    expect(got?.ok && got.card.looks).toEqual([{ id: a.ok ? a.look : '', name: '甲', when: 'w' }])
    // 改名后目录跟着走，looks 仍在
    await saveCharacter(root, { id, name: '阿蓝', persona: '改过的人设' })
    const moved = await readCharacter(root, '阿蓝')
    expect(moved?.ok && moved.card.looks?.length).toBe(1)
    expect(await exists(path.join(root, 'characters', '阿蓝', 'looks', `${a.ok ? a.look : ''}.png`))).toBe(true)
  })

  it('card 文件里是合法 YAML 且其他栏不丢', async () => {
    await addDraft(charDir, png(1), meta())
    await saveLook(charDir, { draft: 1, name: '甲', when: 'w' })
    const doc = YAML.parse(await fs.readFile(path.join(charDir, CARD_FILE), 'utf8'))
    expect(doc.name).toBe('阿青')
    expect(doc.persona).toBe('人设')
    expect(doc.looks).toHaveLength(1)
  })
})

describe('以已保存的形象为底的候选记录', () => {
  it('origin 为 look 并记下是哪一套；旧记录读出来不带该字段', async () => {
    await addDraft(charDir, png(1), meta())
    await addDraft(charDir, png(2), meta({ origin: 'look', basedOnLook: 'default', note: '便装' }))
    const list = await listDrafts(charDir)
    expect(list[0]!.basedOnLook).toBeUndefined()
    expect(list[1]).toMatchObject({ origin: 'look', basedOnLook: 'default', note: '便装' })
  })
})
