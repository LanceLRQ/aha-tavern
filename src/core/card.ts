// 角色卡：列出、读取、保存（含改名）、按名字匹配。读卡宽容，坏卡以结果返回而不抛异常。
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { AhaError } from './errors'
import { atomicWrite, modifyFile, pathExists, safeDirName } from './fsx'
import { newCharacterId } from './ids'

export const CARD_FILE = 'character.yaml'
export const MEMORY_FILE = 'memory.md'

export interface CharacterCard {
  id: string
  name: string
  tagline?: string
  appearance?: string
  greeting?: string
  persona: string
  voice?: string
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

async function readEntry(tavernDir: string, dirName: string): Promise<CharacterEntry> {
  const dir = path.join(charactersRoot(tavernDir), dirName)
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
  if (input.origin !== undefined && input.origin !== null) card.origin = input.origin
  return card
}

export function serializeCard(card: CharacterCard): string {
  // 固定栏目顺序，便于人读
  const out: Record<string, unknown> = { id: card.id, name: card.name }
  for (const k of ['tagline', 'appearance', 'greeting', 'persona', 'voice'] as const) {
    if (card[k] !== undefined) out[k] = card[k]
  }
  if (card.origin !== undefined) out.origin = card.origin
  return YAML.stringify(out)
}

/**
 * 保存一张卡。无 id 为新建：生成编号、建目录，同名目录已存在则抛 character-exists。
 * 有 id 为修改：保留编号，名字变了则目录跟着改名；未给 origin 时沿用原有的。
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

export type NameMatch =
  | { kind: 'exact'; entry: CharacterEntry }
  | { kind: 'prefix'; entry: CharacterEntry }
  | { kind: 'ambiguous'; candidates: CharacterEntry[] }
  | { kind: 'none' }

const displayName = (e: CharacterEntry) => (e.ok ? e.card.name : e.dirName)

/** 名字匹配：精确优先；否则前缀，唯一则采用，不唯一给候选，没有为 none。坏卡以目录名参与匹配。 */
export function matchCharacterName(entries: CharacterEntry[], input: string): NameMatch {
  const q = input.trim()
  if (!q) return { kind: 'none' }
  const exact = entries.filter((e) => displayName(e) === q)
  if (exact.length === 1) return { kind: 'exact', entry: exact[0]! }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact }
  const pre = entries.filter((e) => displayName(e).startsWith(q))
  if (pre.length === 1) return { kind: 'prefix', entry: pre[0]! }
  if (pre.length > 1) return { kind: 'ambiguous', candidates: pre }
  return { kind: 'none' }
}
