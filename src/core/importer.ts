// 导入：把另一间酒馆里的角色卡（连同参考图、音色文件）与主角档案复制过来。
// 纯文件操作；冲突时由调用方传入决定。记忆、聊天记录不随行。
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CARD_FILE, MEMORY_FILE, listCharacters, serializeCard, type CardProblem, type CharacterCard,
} from './card'
import { readMe, ME_FILE } from './docs'
import { AhaError } from './errors'
import { atomicWrite, pathExists, safeDirName } from './fsx'
import { newCharacterId } from './ids'
import { assertWritable, openTavern, type TavernInfo } from './tavern'

/** 单个附带文件的大小上限。 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export interface SourceCharacter {
  id: string
  name: string
  tagline?: string
  dirName: string
}

export interface SourceBroken {
  dirName: string
  /** symlink：来源里的角色目录、角色卡或 characters/ 本身是符号链接，一律不读。 */
  problem: CardProblem | 'symlink'
  detail: string
}

export interface SourceListing {
  tavernId: string
  tavernName: string
  characters: SourceCharacter[]
  /** 读不出来的卡：不可导入，只用于告知数量与原因。 */
  broken: SourceBroken[]
  hasProfile: boolean
  /** 来源的 me.md 是符号链接：不读，也不算有主角档案。 */
  profileUnsafe?: boolean
}

const isSymlink = (p: string): Promise<boolean> => fs.lstat(p).then((st) => st.isSymbolicLink(), () => false)

const symlinkError = (what: string): AhaError => new AhaError('import-source-symlink', `来源里的 ${what} 是符号链接，不读取`)

async function open(dir: string, what: string): Promise<TavernInfo> {
  try {
    return await openTavern(dir)
  } catch (e) {
    if (e instanceof AhaError) throw new AhaError(e.code, `${what}：${e.message}`, { cause: e })
    throw e
  }
}

/** 来源与目标必须是两间不同的酒馆（按目录真实路径与酒馆编号判断）。 */
async function openPair(sourceDir: string, targetDir: string | null): Promise<{ source: TavernInfo; target: TavernInfo | null }> {
  const source = await open(sourceDir, '来源')
  if (source.access === 'readonly') {
    throw new AhaError('version-too-new', `来源酒馆的数据版本 ${source.marker.version} 比插件新，请先升级插件`)
  }
  if (targetDir === null) return { source, target: null }
  const target = await open(targetDir, '目标')
  assertWritable(target)
  const [a, b] = await Promise.all([fs.realpath(sourceDir), fs.realpath(targetDir)])
  if (a === b || source.marker.id === target.marker.id) {
    throw new AhaError('import-same-tavern', '来源与目标是同一间酒馆')
  }
  return { source, target }
}

/** 列出来源酒馆里可导入的内容。符号链接（characters/、角色目录、character.yaml、me.md）一律不读。 */
export async function listImportable(sourceDir: string): Promise<SourceListing> {
  const { source } = await openPair(sourceDir, null)
  const characters: SourceCharacter[] = []
  const broken: SourceBroken[] = []
  if (await isSymlink(charactersRoot(sourceDir))) {
    broken.push({ dirName: 'characters', problem: 'symlink', detail: '' })
  } else {
    const names = await fs.readdir(charactersRoot(sourceDir), { withFileTypes: true }).catch(() => [])
    for (const d of names) {
      if (d.isSymbolicLink() && !d.name.startsWith('.')) broken.push({ dirName: d.name, problem: 'symlink', detail: '' })
    }
    for (const e of await listCharacters(sourceDir)) {
      if (!e.ok) {
        broken.push({ dirName: e.dirName, problem: e.problem, detail: e.detail })
      } else if (await isSymlink(path.join(e.dir, CARD_FILE))) {
        broken.push({ dirName: e.dirName, problem: 'symlink', detail: CARD_FILE })
      } else {
        characters.push({
          id: e.card.id, name: e.card.name, dirName: e.dirName,
          ...(e.card.tagline ? { tagline: e.card.tagline } : {}),
        })
      }
    }
  }
  const profileUnsafe = await isSymlink(path.join(sourceDir, ME_FILE))
  const me = profileUnsafe ? null : await readMe(sourceDir)
  return {
    tavernId: source.marker.id,
    tavernName: source.marker.name,
    characters,
    broken,
    hasProfile: me !== null && !me.empty,
    ...(profileUnsafe ? { profileUnsafe } : {}),
  }
}

export type CharacterDecision = 'overwrite' | 'skip' | 'copy'
export type ProfileDecision = 'overwrite' | 'skip'

export type ImportConflict =
  /** 目标里已有同编号的好卡。 */
  | { kind: 'id'; existing: { id: string; name: string; dirName: string }; overwriteBlocked: boolean }
  /** 编号不冲突，但目录名被另一个角色（或别的目录）占用。 */
  | { kind: 'name'; dirName: string }

export interface SkippedFile {
  name: string
  reason: 'too-large' | 'failed'
  /** 失败时的系统错误码（如 ENOSPC），不带路径。 */
  code?: string
}

export type CharacterImportResult =
  | { status: 'needs-decision'; conflict: ImportConflict }
  | {
      status: 'imported'
      mode: 'new' | 'overwrite' | 'copy'
      card: CharacterCard
      dirName: string
      skippedFiles: SkippedFile[]
    }
  | { status: 'skipped' }

export interface ImportCharacterOptions {
  /** 来源酒馆里的角色编号。 */
  characterId: string
  /** 冲突时的决定；没冲突时忽略；有冲突又没给则返回 needs-decision。 */
  decision?: CharacterDecision
  /** ISO 时间，写入来源记录。 */
  now: string
  maxFileBytes?: number
}

export const fingerprintOf = (raw: string): string => createHash('sha256').update(raw).digest('hex').slice(0, 16)

const charactersRoot = (dir: string) => path.join(dir, 'characters')

interface Staged {
  name: string
  tmp: string
}

/**
 * 附带文件分两步：先复制成目标目录里的临时文件（stage），确认后再改名到位（commit）。
 * 复制的是角色目录里除 character.yaml、memory.md 以外的普通文件（不进子目录、不跟随符号链接、跳过点开头的文件）。
 * 覆盖时目标目录里来源没有的旧附件保留，同名文件被替换；任何一步失败都不留下半个文件。
 */
async function stageAttachments(
  srcDir: string, dstDir: string, maxBytes: number,
): Promise<{ staged: Staged[]; skipped: SkippedFile[] }> {
  const staged: Staged[] = []
  const skipped: SkippedFile[] = []
  for (const e of await fs.readdir(srcDir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    if (e.name === CARD_FILE || e.name.toLowerCase() === MEMORY_FILE) continue
    const from = path.join(srcDir, e.name)
    const tmp = path.join(dstDir, `.${e.name}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      if ((await fs.lstat(from)).size > maxBytes) {
        skipped.push({ name: e.name, reason: 'too-large' })
        continue
      }
      await fs.copyFile(from, tmp)
      staged.push({ name: e.name, tmp })
    } catch (err) {
      await fs.rm(tmp, { force: true })
      skipped.push({ name: e.name, reason: 'failed', ...codeOf(err) })
    }
  }
  return { staged, skipped }
}

const codeOf = (e: unknown): { code?: string } => {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' ? { code: c } : {}
}

async function discardStaged(staged: readonly Staged[]): Promise<void> {
  await Promise.all(staged.map((s) => fs.rm(s.tmp, { force: true })))
}

async function commitStaged(staged: readonly Staged[], dstDir: string, skipped: SkippedFile[]): Promise<void> {
  for (const s of staged) {
    try {
      await fs.rename(s.tmp, path.join(dstDir, s.name))
    } catch (err) {
      await fs.rm(s.tmp, { force: true })
      skipped.push({ name: s.name, reason: 'failed', ...codeOf(err) })
    }
  }
}

/** 另存时的名字：目录已被占用就在名字后加序号。 */
async function freeName(targetDir: string, name: string): Promise<string> {
  const root = charactersRoot(targetDir)
  let candidate = name
  for (let n = 2; await pathExists(path.join(root, safeDirName(candidate))); n++) candidate = `${name} ${n}`
  return candidate
}

/** 导入一个角色。来源卡读不出来时抛 character-not-found / card-invalid。 */
export async function importCharacter(
  sourceDir: string, targetDir: string, opts: ImportCharacterOptions,
): Promise<CharacterImportResult> {
  const { source, target } = await openPair(sourceDir, targetDir)
  if (await isSymlink(charactersRoot(sourceDir))) throw symlinkError('characters/')
  const entry = (await listCharacters(sourceDir)).find((e) => e.ok && e.card.id === opts.characterId)
  if (!entry || !entry.ok) throw new AhaError('character-not-found', `来源里找不到编号为 ${opts.characterId} 的角色`)
  if (await isSymlink(path.join(charactersRoot(sourceDir), entry.dirName))) throw symlinkError(entry.dirName)
  if (await isSymlink(path.join(entry.dir, CARD_FILE))) throw symlinkError(`${entry.dirName}/${CARD_FILE}`)
  const raw = await fs.readFile(path.join(entry.dir, CARD_FILE), 'utf8')
  const incoming: CharacterCard = {
    ...entry.card,
    origin: { tavern: source.marker.id, fingerprint: fingerprintOf(raw), at: opts.now },
  }
  const maxBytes = opts.maxFileBytes ?? MAX_ATTACHMENT_BYTES

  const existingList = await listCharacters(target!.dir)
  const sameId = existingList.find((e) => e.ok && e.card.id === incoming.id)
  const wantedDir = path.join(charactersRoot(targetDir), safeDirName(incoming.name))
  const dirTaken = await pathExists(wantedDir)

  // 覆盖时新名字对应的目录若已被别的角色占用，就不能覆盖
  let overwriteBlocked = false
  if (sameId && sameId.ok && safeDirName(incoming.name) !== sameId.dirName && dirTaken) {
    const [a, b] = await Promise.all([fs.realpath(sameId.dir), fs.realpath(wantedDir).catch(() => null)])
    overwriteBlocked = b !== a
  }

  let conflict: ImportConflict | null = null
  if (sameId && sameId.ok) {
    conflict = {
      kind: 'id', existing: { id: sameId.card.id, name: sameId.card.name, dirName: sameId.dirName }, overwriteBlocked,
    }
  } else if (dirTaken) {
    conflict = { kind: 'name', dirName: safeDirName(incoming.name) }
  }

  if (!conflict) return writeNew(entry.dir, targetDir, incoming, 'new', maxBytes)

  const decision = opts.decision
  if (!decision) return { status: 'needs-decision', conflict }
  if (decision === 'skip') return { status: 'skipped' }
  if (decision === 'copy') {
    const name = await freeName(targetDir, incoming.name)
    return writeNew(entry.dir, targetDir, { ...incoming, id: newCharacterId(), name }, 'copy', maxBytes)
  }
  if (!sameId || !sameId.ok) {
    throw new AhaError('import-invalid-decision', '名字冲突时只能跳过或另存为新角色')
  }
  if (overwriteBlocked) throw new AhaError('character-exists', `已有同名目录：${safeDirName(incoming.name)}`)

  // 覆盖：只换卡和附带文件，memory.md 不动。顺序：附件先放成临时文件 -> 原子写新卡 -> 附件到位 -> 最后才改目录名；
  // 改目录名失败时把旧卡写回，保证目录里永远是一张完整、可读的卡。
  const oldRaw = await fs.readFile(path.join(sameId.dir, CARD_FILE), 'utf8')
  const { staged, skipped } = await stageAttachments(entry.dir, sameId.dir, maxBytes)
  try {
    await atomicWrite(path.join(sameId.dir, CARD_FILE), serializeCard(incoming))
  } catch (e) {
    await discardStaged(staged)
    throw e
  }
  await commitStaged(staged, sameId.dir, skipped)
  let dirName = sameId.dirName
  const newDirName = safeDirName(incoming.name)
  if (newDirName !== dirName) {
    try {
      await fs.rename(sameId.dir, path.join(charactersRoot(targetDir), newDirName))
      dirName = newDirName
    } catch (e) {
      await atomicWrite(path.join(sameId.dir, CARD_FILE), oldRaw).catch(() => undefined)
      throw e
    }
  }
  return { status: 'imported', mode: 'overwrite', card: incoming, dirName, skippedFiles: skipped }
}

async function writeNew(
  srcDir: string, targetDir: string, card: CharacterCard, mode: 'new' | 'copy', maxBytes: number,
): Promise<CharacterImportResult> {
  const dirName = safeDirName(card.name)
  const dir = path.join(charactersRoot(targetDir), dirName)
  await fs.mkdir(charactersRoot(targetDir), { recursive: true })
  await fs.mkdir(dir)
  try {
    const { staged, skipped } = await stageAttachments(srcDir, dir, maxBytes)
    try {
      await atomicWrite(path.join(dir, CARD_FILE), serializeCard(card))
    } catch (e) {
      await discardStaged(staged)
      throw e
    }
    await commitStaged(staged, dir, skipped)
    return { status: 'imported', mode, card, dirName, skippedFiles: skipped }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true })
    throw e
  }
}

export type ProfileImportResult =
  | { status: 'needs-decision' }
  | { status: 'imported'; mode: 'new' | 'overwrite' }
  | { status: 'skipped' }
  | { status: 'no-source' }

/** 导入主角档案：来源没有（或只有空白）为 no-source；目标已有且没给决定为 needs-decision。 */
export async function importProfile(
  sourceDir: string, targetDir: string, decision?: ProfileDecision,
): Promise<ProfileImportResult> {
  await openPair(sourceDir, targetDir)
  if (await isSymlink(path.join(sourceDir, ME_FILE))) throw symlinkError(ME_FILE)
  const src = await readMe(sourceDir)
  if (src.empty) return { status: 'no-source' }
  const dst = await readMe(targetDir)
  const hasOwn = !dst.empty
  if (hasOwn) {
    if (!decision) return { status: 'needs-decision' }
    if (decision === 'skip') return { status: 'skipped' }
  }
  await atomicWrite(path.join(targetDir, ME_FILE), src.text)
  return { status: 'imported', mode: hasOwn ? 'overwrite' : 'new' }
}
