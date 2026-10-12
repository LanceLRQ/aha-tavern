// 角色卡：列出、读取、保存（含改名）、按名字匹配。读卡宽容，坏卡以结果返回而不抛异常。
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { AhaError } from './errors'
import { atomicWrite, modifyFile, pathExists, safeDirName } from './fsx'
import { isLookId, newCharacterId } from './ids'

export const CARD_FILE = 'character.yaml'
export const MEMORY_FILE = 'memory.md'

/** 额外形象的名字、使用场合的长度上限（按字符数），以及一个角色最多几套额外形象。 */
export const LOOK_NAME_MAX = 20
export const LOOK_WHEN_MAX = 100
export const MAX_LOOKS = 8
/** 默认形象在名字位置上的保留写法，额外形象不能叫这个名字。 */
export const DEFAULT_LOOK = 'default'

/** 额外形象在角色卡里的一条：图片文件是 looks/<id>.png。 */
export interface CardLook {
  id: string
  name: string
  when: string
}

export interface CharacterCard {
  id: string
  name: string
  tagline?: string
  appearance?: string
  greeting?: string
  persona: string
  voice?: string
  /** 额外形象；只有默认形象时没有这一栏 */
  looks?: CardLook[]
  /** 导入来源记录；本模块原样保留，不校验内部字段 */
  origin?: unknown
}

/** 保存用的输入：id 缺省表示新建，给出表示修改。 */
export type CharacterInput = Omit<CharacterCard, 'id'> & { id?: string }

export type CardProblem = 'file-missing' | 'yaml-invalid' | 'missing-required' | 'missing-id' | 'unreadable'

export type CharacterEntry =
  | { ok: true; dir: string; dirName: string; card: CharacterCard }
  | {
      ok: false
      dir: string
      dirName: string
      /** 出问题的文件（绝对路径） */
      file: string
      problem: CardProblem
      /** 缺哪些必填栏（仅 missing-required）或解析器给出的信息（yaml-invalid）或系统错误码（unreadable） */
      detail: string
    }

const OPTIONAL_TEXT = ['tagline', 'appearance', 'greeting', 'voice'] as const

const charactersRoot = (tavernDir: string) => path.join(tavernDir, 'characters')

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const charCount = (s: string): number => [...s].length

/** 形象名规则：去首尾空白后不为空、不超过 20 字、不是保留字 default。返回规范化的名字，不合规为 null。 */
export function normalizeLookName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const name = v.trim()
  if (!name || charCount(name) > LOOK_NAME_MAX || name.toLowerCase() === DEFAULT_LOOK) return null
  return name
}

/** 使用场合规则：字符串且不超过 100 字（去首尾空白）。返回规范化的文字，不合规为 null。 */
export function normalizeLookWhen(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const when = v.trim()
  return charCount(when) > LOOK_WHEN_MAX ? null : when
}

/**
 * 整理 looks 一栏：逐条校验，不合法的丢掉，名字重复的留第一条，编号重复的留第一条，最多留 8 条。
 * 整栏不是数组时当作没有。绝不抛异常：这一栏有问题不能让整张卡读不出来。
 */
export function sanitizeLooks(v: unknown): CardLook[] {
  if (!Array.isArray(v)) return []
  const out: CardLook[] = []
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const item of v) {
    if (out.length >= MAX_LOOKS) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    if (!isLookId(o.id) || ids.has(o.id)) continue
    const name = normalizeLookName(o.name)
    if (name === null || names.has(name)) continue
    const when = normalizeLookWhen(o.when)
    if (when === null) continue
    names.add(name)
    ids.add(o.id)
    out.push({ id: o.id, name, when })
  }
  return out
}

async function readEntry(tavernDir: string, dirName: string): Promise<CharacterEntry> {
  return readEntryAt(path.join(charactersRoot(tavernDir), dirName), dirName)
}

async function readEntryAt(dir: string, dirName: string): Promise<CharacterEntry> {
  const file = path.join(dir, CARD_FILE)
  const bad = (problem: CardProblem, detail = ''): CharacterEntry => ({
    ok: false, dir, dirName, file, problem, detail,
  })
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return bad('file-missing')
    return bad('unreadable', code ?? String(e))
  }
  let data: unknown
  try {
    data = YAML.parse(raw)
  } catch (e) {
    return bad('yaml-invalid', (e as Error).message)
  }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const missing = ['name', 'persona'].filter((k) => !asText(obj[k]))
  if (missing.length) return bad('missing-required', missing.join(','))
  const id = asText(obj.id)
  if (!id) return bad('missing-id')
  const card: CharacterCard = { id, name: asText(obj.name), persona: asText(obj.persona) }
  for (const k of OPTIONAL_TEXT) {
    const v = asText(obj[k])
    if (v) card[k] = v
  }
  const looks = sanitizeLooks(obj.looks)
  if (looks.length) card.looks = looks
  if (obj.origin !== undefined && obj.origin !== null) card.origin = obj.origin
  return { ok: true, dir, dirName, card }
}

/** 列出全部角色，按目录名排序；坏卡以 ok:false 项给出，不影响其他角色。 */
export async function listCharacters(tavernDir: string): Promise<CharacterEntry[]> {
  let names: string[]
  try {
    const items = await fs.readdir(charactersRoot(tavernDir), { withFileTypes: true })
    names = items.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  names.sort()
  return Promise.all(names.map((n) => readEntry(tavernDir, n)))
}

/** 按角色编号或目录名读取一张卡；找不到返回 null。目录名优先。 */
export async function readCharacter(tavernDir: string, idOrDirName: string): Promise<CharacterEntry | null> {
  const byDir = idOrDirName && !/[\/\\]/.test(idOrDirName) && idOrDirName !== '.' && idOrDirName !== '..'
  if (byDir && (await pathExists(path.join(charactersRoot(tavernDir), idOrDirName)))) {
    return readEntry(tavernDir, idOrDirName)
  }
  const all = await listCharacters(tavernDir)
  return all.find((e) => e.ok && e.card.id === idOrDirName) ?? null
}

async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b))
  } catch {
    return false
  }
}

function validateInput(input: CharacterInput): CharacterCard {
  const name = asText(input.name)
  const persona = asText(input.persona)
  if (!name) throw new AhaError('card-invalid', '角色卡缺少必填栏：name')
  if (!persona) throw new AhaError('card-invalid', '角色卡缺少必填栏：persona')
  const card: CharacterCard = { id: input.id ?? '', name, persona }
  for (const k of OPTIONAL_TEXT) {
    const v = asText(input[k])
    if (v) card[k] = v
  }
  const looks = sanitizeLooks(input.looks)
  if (looks.length) card.looks = looks
  if (input.origin !== undefined && input.origin !== null) card.origin = input.origin
  return card
}

export function serializeCard(card: CharacterCard): string {
  // 固定栏目顺序，便于人读
  const out: Record<string, unknown> = { id: card.id, name: card.name }
  for (const k of ['tagline', 'appearance', 'greeting', 'persona', 'voice'] as const) {
    if (card[k] !== undefined) out[k] = card[k]
  }
  if (card.looks && card.looks.length) {
    out.looks = card.looks.map((l) => ({ id: l.id, name: l.name, when: l.when }))
  }
  if (card.origin !== undefined) out.origin = card.origin
  return YAML.stringify(out)
}

/**
 * 保存一张卡。无 id 为新建：生成编号、建目录，同名目录已存在则抛 character-exists。
 * 有 id 为修改：保留编号，名字变了则目录跟着改名；未给 origin、looks 时沿用原有的。
 * 只写规格定义的栏目：手工加的未知顶层字段与注释不会保留。
 * 新建时若同名目录里是缺编号（missing-id）的手写卡，视为认领，补发编号写入。
 * 只写 character.yaml，不触碰同目录的 memory.md、参考图、音色文件。
 */
export async function saveCharacter(
  tavernDir: string,
  input: CharacterInput,
): Promise<{ card: CharacterCard; dir: string; dirName: string }> {
  const card = validateInput(input)
  const root = charactersRoot(tavernDir)
  const targetName = safeDirName(card.name)

  if (!input.id) {
    card.id = newCharacterId()
    const dir = path.join(root, targetName)
    await fs.mkdir(root, { recursive: true })
    let created = true
    try {
      await fs.mkdir(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // 目录里是缺编号的手写卡时认领它：补发编号并写入
      const occupant = await readEntry(tavernDir, targetName)
      if (occupant.ok || occupant.problem !== 'missing-id') {
        throw new AhaError('character-exists', `已有同名目录：${targetName}`)
      }
      created = false
    }
    try {
      await atomicWrite(path.join(dir, CARD_FILE), serializeCard(card))
    } catch (e) {
      if (created) await fs.rm(dir, { recursive: true, force: true })
      throw e
    }
    return { card, dir, dirName: targetName }
  }

  const existing = (await listCharacters(tavernDir)).find(
    (e) => (e.ok ? e.card.id === input.id : false),
  )
  if (!existing || !existing.ok) {
    throw new AhaError('character-not-found', `找不到编号为 ${input.id} 的角色`)
  }
  if (card.origin === undefined && existing.card.origin !== undefined) card.origin = existing.card.origin
  // 调用方没给 looks（只改文字的路径）时沿用盘上的，免得改一句人设就把形象冲掉
  if (input.looks === undefined && existing.card.looks !== undefined) card.looks = existing.card.looks

  let dir = existing.dir
  let dirName = existing.dirName
  if (targetName !== existing.dirName) {
    const target = path.join(root, targetName)
    // 大小写不敏感的文件系统上，只改大小写时 target 就是自己
    if ((await pathExists(target)) && !(await sameDir(target, existing.dir))) {
      throw new AhaError('character-exists', `已有同名目录：${targetName}`)
    }
    await fs.rename(existing.dir, target)
    dir = target
    dirName = targetName
  }
  await modifyFile(path.join(dir, CARD_FILE), () => serializeCard(card))
  return { card, dir, dirName }
}

/** 读某个角色目录里角色卡的 looks 一栏；卡读不出来返回 null。 */
export async function readCharacterLooks(charDir: string): Promise<CardLook[] | null> {
  const e = await readEntryAt(charDir, path.basename(charDir))
  return e.ok ? (e.card.looks ?? []) : null
}

/**
 * 在锁内读出角色卡的 looks，交给 mutate 得到新的一栏，再写回；其他栏原样保留（经 serializeCard 重写，规则同 saveCharacter）。
 * mutate 抛错则不写。卡读不出来抛 card-invalid。返回写入后的 looks。
 */
export async function updateCharacterLooks(
  charDir: string, mutate: (current: CardLook[]) => CardLook[],
): Promise<CardLook[]> {
  let result: CardLook[] = []
  await modifyFile(path.join(charDir, CARD_FILE), async () => {
    const e = await readEntryAt(charDir, path.basename(charDir))
    if (!e.ok) throw new AhaError('card-invalid', `角色卡读不出来（${e.problem}），不能改形象`)
    result = sanitizeLooks(mutate(e.card.looks ?? []))
    const next: CharacterCard = { ...e.card }
    if (result.length) next.looks = result
    else delete next.looks
    return serializeCard(next)
  })
  return result
}

export type NameMatch =
  | { kind: 'exact'; entry: CharacterEntry }
  | { kind: 'prefix'; entry: CharacterEntry }
  | { kind: 'contains'; entry: CharacterEntry }
  | { kind: 'ambiguous'; candidates: CharacterEntry[] }
  | { kind: 'none' }

const displayName = (e: CharacterEntry) => (e.ok ? e.card.name : e.dirName)

/**
 * 名字匹配（不分大小写，去首尾空白）：全名相等 > 开头匹配 > 包含匹配（仅 contains 为真时才有这一档）。
 * 取命中的第一档：该档唯一则采用，多个则 ambiguous，候选为该档全部；都没有为 none。坏卡以目录名参与匹配。
 */
export function matchCharacterName(
  entries: CharacterEntry[], input: string, opts: { contains?: boolean } = {},
): NameMatch {
  const q = input.trim().toLowerCase()
  if (!q) return { kind: 'none' }
  const tiers: Array<{ kind: 'exact' | 'prefix' | 'contains'; test: (n: string) => boolean }> = [
    { kind: 'exact', test: (n) => n === q },
    { kind: 'prefix', test: (n) => n.startsWith(q) },
  ]
  if (opts.contains) tiers.push({ kind: 'contains', test: (n) => n.includes(q) })
  for (const t of tiers) {
    const hit = entries.filter((e) => t.test(displayName(e).trim().toLowerCase()))
    if (hit.length === 1) return { kind: t.kind, entry: hit[0]! }
    if (hit.length > 1) return { kind: 'ambiguous', candidates: hit }
  }
  return { kind: 'none' }
}
