// 三期写书的书目录：book.yaml、目录（outline.yaml）、节文件与状态（三期规格 §5）。
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { atomicWrite, pathExists, safeDirName } from './fsx'
import { isChatId, newChatId } from './ids'

export const BOOKS_DIR = 'books'
export const BOOK_FILE = 'book.yaml'
export const OUTLINE_FILE = 'outline.yaml'
export const DRAFT_DIR = 'draft'
export const UNUSED_DIR = '.unused'
/** 一节原料的上限（字）。 */
export const SECTION_SOURCE_MAX = 30000

export type BookPerson = 'third' | 'first'

export interface BookMeta {
  title: string
  person: BookPerson
  protagonist: string
  /** 收入的聊天（chats/ 下的目录名） */
  chats: string[]
  session: string
  created: string
  /** B 层的文风描述；A 层不用 */
  style: string
}

export type SectionRange = { scene: number } | { from: number; to: number }
export interface OutlineSection { title: string; brief: string; range: SectionRange }
export interface OutlineChapter { title: string; chat: string; sections: OutlineSection[] }
export interface Outline { title: string; protagonist: string; chapters: OutlineChapter[] }

export interface SectionFrontmatter {
  chat: string
  range: SectionRange
  fingerprint: string
  model: string
  written: string
}

export type SectionStatus = 'written' | 'stale' | 'missing'

export interface BookHandle { id: string; dirName: string; dir: string }

const pad = (n: number) => String(n).padStart(2, '0')
const booksRoot = (tavernDir: string) => path.join(tavernDir, BOOKS_DIR)

/** 第 ci 话第 si 节（都从 0 起）的文件名主干。 */
export const sectionKey = (ci: number, si: number): string => `${pad(ci + 1)}-${pad(si + 1)}`

/** 聊天目录名只能是 chats/ 下的一层名字。 */
export const isChatDirName = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && v !== '.' && v !== '..' && !/[\\/]/.test(v)

export async function findBookDir(tavernDir: string, bookId: string): Promise<string | null> {
  if (!isChatId(bookId)) return null
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(booksRoot(tavernDir), { withFileTypes: true })
  } catch {
    return null
  }
  const hit = entries.find((e) => e.isDirectory() && e.name.slice(e.name.lastIndexOf('-') + 1) === bookId)
  return hit ? path.join(booksRoot(tavernDir), hit.name) : null
}

export async function createBook(
  tavernDir: string,
  input: { title: string; person: BookPerson; chats: string[]; sessionId: string; now: Date },
): Promise<BookHandle> {
  const d = input.now
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  let id = newChatId()
  for (let i = 0; i < 50 && (await findBookDir(tavernDir, id)); i++) id = newChatId()
  if (await findBookDir(tavernDir, id)) throw new Error('无法生成不重复的书编号')
  const dirName = `${stamp}-${safeDirName(input.title.trim() || '未命名')}-${id}`
  const dir = path.join(booksRoot(tavernDir), dirName)
  await fs.mkdir(dir, { recursive: true })
  await writeBookMeta(dir, {
    title: input.title.trim(), person: input.person, protagonist: '', chats: [...input.chats],
    session: input.sessionId, created: d.toISOString(), style: '',
  })
  return { id, dirName, dir }
}

export async function readBookMeta(bookDir: string): Promise<BookMeta> {
  const v = YAML.parse(await fs.readFile(path.join(bookDir, BOOK_FILE), 'utf8')) as Partial<BookMeta> | null
  if (!v || typeof v !== 'object') throw new Error('book.yaml 格式不对')
  const str = (x: unknown) => (typeof x === 'string' ? x : '')
  return {
    title: str(v.title),
    person: v.person === 'first' ? 'first' : 'third',
    protagonist: str(v.protagonist),
    chats: Array.isArray(v.chats) ? v.chats.filter(isChatDirName) : [],
    session: str(v.session),
    created: str(v.created),
    style: str(v.style),
  }
}

export async function writeBookMeta(bookDir: string, meta: BookMeta): Promise<void> {
  await atomicWrite(path.join(bookDir, BOOK_FILE), YAML.stringify(meta))
}

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

function parseRange(v: unknown): SectionRange | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if ('scene' in r) return isPosInt(r.scene) ? { scene: r.scene } : null
  if (isPosInt(r.from) && isPosInt(r.to) && r.from <= r.to) return { from: r.from, to: r.to }
  return null
}

/** 解析目录的 YAML 全文：只做结构校验（聊天是否存在、范围是否越界由原料组装校验）。 */
export function parseOutline(text: string): { ok: true; outline: Outline } | { ok: false; error: string } {
  let v: unknown
  try {
    v = YAML.parse(text)
  } catch (e) {
    return { ok: false, error: `invalid yaml (${(e as Error).message.split('\n')[0]})` }
  }
  const o = v as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return { ok: false, error: 'invalid yaml: top level must be a mapping' }
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  if (!Array.isArray(o.chapters) || o.chapters.length === 0) return { ok: false, error: 'chapters must be a non-empty list' }
  const chapters: OutlineChapter[] = []
  for (const [ci, c] of (o.chapters as unknown[]).entries()) {
    const ch = c as Record<string, unknown> | null
    const where = `chapter ${ci + 1}`
    if (!ch || typeof ch !== 'object') return { ok: false, error: `${where}: must be a mapping` }
    if (!isChatDirName(ch.chat)) return { ok: false, error: `${where}: chat must be a directory name under chats/` }
    if (!Array.isArray(ch.sections) || ch.sections.length === 0) return { ok: false, error: `${where}: sections must be a non-empty list` }
    const sections: OutlineSection[] = []
    for (const [si, s] of (ch.sections as unknown[]).entries()) {
      const sec = s as Record<string, unknown> | null
      const range = sec && typeof sec === 'object' ? parseRange(sec.range) : null
      if (!range) return { ok: false, error: `${where} section ${si + 1}: range must be { scene: N } or { from: A, to: B } with A <= B` }
      sections.push({ title: str(sec!.title), brief: str(sec!.brief), range })
    }
    chapters.push({ title: str(ch.title), chat: ch.chat, sections })
  }
  return { ok: true, outline: { title: str(o.title), protagonist: str(o.protagonist), chapters } }
}

export async function readOutline(bookDir: string): Promise<Outline | null> {
  let text: string
  try {
    text = await fs.readFile(path.join(bookDir, OUTLINE_FILE), 'utf8')
  } catch {
    return null
  }
  const r = parseOutline(text)
  return r.ok ? r.outline : null
}

export async function writeOutline(bookDir: string, outline: Outline): Promise<void> {
  await atomicWrite(path.join(bookDir, OUTLINE_FILE), YAML.stringify(outline))
}

const sectionFile = (bookDir: string, key: string) => path.join(bookDir, DRAFT_DIR, `${key}.md`)

function parseSectionText(text: string): { fm: SectionFrontmatter | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text)
  if (!m) return { fm: null, body: text }
  // writeSection 在正文后补了一个换行，读回时去掉
  const body = m[2]!.replace(/\n$/, '')
  try {
    const v = YAML.parse(m[1]!) as Record<string, unknown>
    const range = parseRange(v.range)
    if (typeof v.chat !== 'string' || !range || typeof v.fingerprint !== 'string') return { fm: null, body }
    return {
      fm: { chat: v.chat, range, fingerprint: v.fingerprint, model: String(v.model ?? ''), written: String(v.written ?? '') },
      body,
    }
  } catch {
    return { fm: null, body }
  }
}

export async function readSection(bookDir: string, key: string): Promise<{ fm: SectionFrontmatter | null; body: string } | null> {
  try {
    return parseSectionText(await fs.readFile(sectionFile(bookDir, key), 'utf8'))
  } catch {
    return null
  }
}

/** 先写临时文件再改名：中断不会留下半截的节文件。 */
export async function writeSection(bookDir: string, key: string, fm: SectionFrontmatter, body: string): Promise<void> {
  await atomicWrite(sectionFile(bookDir, key), `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n${body}\n`)
}

const rangeId = (chat: string, r: SectionRange): string =>
  'scene' in r ? `${chat}|s${r.scene}` : `${chat}|${r.from}-${r.to}`

export function sectionStatus(
  fm: SectionFrontmatter | null, chat: string, range: SectionRange, fingerprint: string,
): SectionStatus {
  if (!fm) return 'missing'
  return rangeId(fm.chat, fm.range) === rangeId(chat, range) && fm.fingerprint === fingerprint ? 'written' : 'stale'
}

/**
 * 保存新目录前搬动节文件：按"聊天 + 范围"把已有的节对到新编号；
 * 新目录里没有对应项的移到 draft/.unused/，不删除。先全部改成临时名再落位，避免互相覆盖。
 */
export async function relocateSections(bookDir: string, outline: Outline): Promise<{ moved: number; unused: number }> {
  const draft = path.join(bookDir, DRAFT_DIR)
  let names: string[]
  try {
    names = (await fs.readdir(draft)).filter((n) => /^\d{2}-\d{2}\.md$/.test(n))
  } catch {
    return { moved: 0, unused: 0 }
  }
  const target = new Map<string, string>()
  outline.chapters.forEach((c, ci) => c.sections.forEach((s, si) => {
    const id = rangeId(c.chat, s.range)
    if (!target.has(id)) target.set(id, `${sectionKey(ci, si)}.md`)
  }))
  const staged: Array<{ tmp: string; dest: string | null }> = []
  for (const n of names) {
    const { fm } = parseSectionText(await fs.readFile(path.join(draft, n), 'utf8'))
    const dest = fm ? target.get(rangeId(fm.chat, fm.range)) ?? null : null
    if (fm && dest) target.delete(rangeId(fm.chat, fm.range))
    const tmp = path.join(draft, `.${n}.moving`)
    await fs.rename(path.join(draft, n), tmp)
    staged.push({ tmp, dest: dest ?? null })
  }
  let moved = 0
  let unused = 0
  for (const s of staged) {
    if (s.dest) {
      await fs.rename(s.tmp, path.join(draft, s.dest))
      moved++
    } else {
      const dir = path.join(draft, UNUSED_DIR)
      await fs.mkdir(dir, { recursive: true })
      const base = path.basename(s.tmp).replace(/^\./, '').replace(/\.moving$/, '')
      let dest = path.join(dir, base)
      for (let i = 2; await pathExists(dest); i++) dest = path.join(dir, base.replace(/\.md$/, `-${i}.md`))
      await fs.rename(s.tmp, dest)
      unused++
    }
  }
  return { moved, unused }
}
