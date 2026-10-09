// 主线记忆 memory.md：五栏的解析、写入与代码兜底（规格 7.2、7.6、11）。
// 文件被切成"已知栏"和"其他片段"的有序列表，写入只动目标栏，其余原样放回。
import fs from 'node:fs/promises'
import { AhaError } from './errors'
import { countChars } from './docs'
import { modifyFile } from './fsx'

export type MemorySection = 'address' | 'impression' | 'pinned' | 'facts' | 'index'

/** 栏目标题是数据的一部分，不随主题变（规格 15.1）。 */
export const SECTION_TITLES: Record<MemorySection, string> = {
  address: '称呼与关系',
  impression: '对我的印象',
  pinned: '我让 TA 记住的',
  facts: '关键的事',
  index: '往事索引',
}
const SECTION_ORDER: MemorySection[] = ['address', 'impression', 'pinned', 'facts', 'index']
const KIND_LABEL = { chat: '单聊', group: '群聊' } as const
const UNORGANIZED = '（未整理）'

export const DEFAULT_MAX_FACTS = 100
export const DEFAULT_MAX_INDEX_LINES = 100

export type ChatKind = 'chat' | 'group'

export interface IndexEntry {
  date: string
  kind: ChatKind
  /** 未整理为 null */
  title: string | null
  id: string
}

export interface Memory {
  address: string
  impression: string
  pinned: string[]
  facts: string[]
  index: IndexEntry[]
}

export interface WriteResult {
  written: boolean
  reason?: 'duplicate' | 'empty' | 'not-found' | 'unchanged'
  /** 因超出上限被丢弃的最旧条目数 */
  trimmed: number
}

export interface WriteOptions {
  /** 文件不存在时骨架标题用的角色名 */
  characterName?: string
}

// ---------- 切片 ----------

type Segment =
  | { type: 'raw'; lines: string[] }
  | { type: 'sec'; key: MemorySection; lines: string[] } // lines[0] 是标题行

const TITLE_TO_KEY = new Map<string, MemorySection>(
  SECTION_ORDER.map((k) => [SECTION_TITLES[k], k]),
)

function knownHeading(line: string): MemorySection | null {
  const m = /^##[ \t]+(.+?)\s*$/.exec(line)
  return m ? (TITLE_TO_KEY.get(m[1] ?? '') ?? null) : null
}

function parseDoc(text: string): Segment[] {
  const segs: Segment[] = []
  const seen = new Set<MemorySection>()
  for (const line of text.split('\n')) {
    const key = knownHeading(line)
    const last = segs[segs.length - 1]
    if (key && !seen.has(key)) {
      seen.add(key)
      segs.push({ type: 'sec', key, lines: [line] })
    } else if (last?.type === 'sec' && /^#{1,2}[ \t]/.test(line)) {
      // 未知栏或重复的已知栏：终结当前已知栏，整段原样保留
      segs.push({ type: 'raw', lines: [line] })
    } else if (last) {
      last.lines.push(line)
    } else {
      segs.push({ type: 'raw', lines: [line] })
    }
  }
  return segs
}

function serializeDoc(segs: Segment[]): string {
  return segs.flatMap((s) => s.lines).join('\n')
}

/** 解析再写回，用于验证原样保留。 */
export function roundTrip(text: string): string {
  return serializeDoc(parseDoc(text))
}
type SecSegment = Segment & { type: 'sec' }

function trailingBlanks(lines: string[]): number {
  let n = 0
  while (n < lines.length && (lines[lines.length - 1 - n] ?? '').trim() === '') n++
  return n
}

/** 栏目正文（不含标题行、不含尾部空行）。 */
function contentOf(seg: SecSegment): string[] {
  const body = seg.lines.slice(1)
  return body.slice(0, body.length - trailingBlanks(body))
}

/** 一次写入的工作上下文：文件的换行风格与被改动过的片段。 */
interface Ctx {
  segs: Segment[]
  /** CRLF 文件为 '\r'，否则为 ''（切片后每行行尾是否带 \r） */
  cr: string
  touched: Set<Segment>
}

function setContent(ctx: Ctx, seg: SecSegment, content: string[]): void {
  const body = seg.lines.slice(1)
  const trail = trailingBlanks(body)
  const hasNext = ctx.segs.indexOf(seg) < ctx.segs.length - 1
  const trailLines = trail === 0 && hasNext ? [ctx.cr] : body.slice(body.length - trail)
  // 新写入的行沿用文件的换行风格；已有的行不动
  const lines = content.map((l) => (ctx.cr && !l.endsWith('\r') ? l + ctx.cr : l))
  seg.lines = [seg.lines[0] ?? '', ...lines, ...trailLines]
  ctx.touched.add(seg)
}

function findSec(segs: Segment[], key: MemorySection) {
  return segs.find((s): s is SecSegment => s.type === 'sec' && s.key === key)
}

// ---------- 条目 ----------

const BULLET = /^\s*[-*+•·]\s+/
/** 条目的开头：行首无缩进的项目符号 */
const TOP_BULLET = /^[-*+][ \t]+/

const stripBullet = (line: string) => line.replace(BULLET, '').trim()
const nonBlank = (lines: string[]) => lines.filter((l) => l.trim() !== '')

/** 去重比较用：去首尾空白、项目符号、内部空白。 */
function dedupeKey(text: string): string {
  return stripBullet(text).replace(/\s+/g, '')
}

/**
 * 去掉每行开头的 Markdown 标题记号（一个或多个 # 加空白），保留文字。
 * 防止写入的文字伪造栏标题或截断栏目（规格 7.6 专属栏保护）。
 */
function stripHeadingMarks(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/^(?:\s*#+(?:[ \t]+|$))+/, ''))
    .join('\n')
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new AhaError('memory-invalid', `${what}必须是字符串`)
  return value
}

/** 写入前清理成单行条目：去标题记号与项目符号，换行折成空格。 */
function cleanItem(text: string): string {
  return stripHeadingMarks(text)
    .split('\n')
    .map((l, i) => (i === 0 ? stripBullet(l) : l.trim()))
    .filter(Boolean)
    .join(' ')
    .trim()
}

/** 多行正文（称呼、印象）：去标题记号，保留换行。 */
function cleanBlock(text: string): string[] {
  const t = stripHeadingMarks(text).trim()
  return t ? t.split('\n').map((l) => l.trimEnd()) : []
}

function resolveLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 顶层条目的起始行下标。 */
function itemStarts(lines: string[]): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    if (TOP_BULLET.test(l)) out.push(i)
  })
  return out
}

/** 读取用：第一条之前的手写行各算一条；之后每条含其缩进行与续行。 */
function itemTexts(lines: string[]): string[] {
  const starts = itemStarts(lines)
  const first = starts[0] ?? lines.length
  const out = nonBlank(lines.slice(0, first)).map(stripBullet)
  starts.forEach((s, k) => {
    const group = lines.slice(s, starts[k + 1] ?? lines.length)
    out.push([stripBullet(group[0] ?? ''), ...nonBlank(group.slice(1)).map((l) => l.trim())].join('\n'))
  })
  return out
}

/** 已有条目首行的去重键。 */
function itemKeys(lines: string[]): Set<string> {
  return new Set(itemStarts(lines).map((s) => dedupeKey(lines[s] ?? '')))
}

/** 丢掉最旧的整条（含其子项、续行），直到条数不超过上限，返回丢弃条数。 */
function capItems(content: string[], limit: number): number {
  const starts = itemStarts(content)
  const drop = starts.length - limit
  if (drop <= 0) return 0
  const from = starts[0] ?? 0
  content.splice(from, (starts[drop] ?? content.length) - from)
  return drop
}

const INDEX_LINE =
  /^\s*[-*+•·]\s+(\d{4}-\d{2}-\d{2})\s+(单聊|群聊)(?:（未整理）|：(.*?))\s*〔([^〔〕]+)〕\s*$/

function parseIndexLine(line: string): IndexEntry | null {
  const m = INDEX_LINE.exec(line)
  if (!m) return null
  const title = m[3]?.trim()
  return { date: m[1] ?? '', kind: m[2] === '群聊' ? 'group' : 'chat', title: title ? title : null, id: m[4] ?? '' }
}

function lineEndsWithId(line: string, id: string): boolean {
  return line.trimEnd().endsWith(`〔${id}〕`)
}

function formatIndexLine(e: IndexEntry): string {
  const label = KIND_LABEL[e.kind]
  return e.title ? `- ${e.date} ${label}：${e.title} 〔${e.id}〕` : `- ${e.date} ${label}${UNORGANIZED}〔${e.id}〕`
}

// ---------- 读取 ----------

export function parseMemory(text: string): Memory {
  const segs = parseDoc(text)
  const lines = (k: MemorySection) => {
    const s = findSec(segs, k)
    return s ? contentOf(s) : []
  }
  const index: IndexEntry[] = []
  for (const l of lines('index')) {
    const e = parseIndexLine(l)
    if (e) index.push(e)
  }
  return {
    address: lines('address').join('\n').trim(),
    impression: lines('impression').join('\n').trim(),
    pinned: itemTexts(lines('pinned')),
    facts: itemTexts(lines('facts')),
    index,
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function readMemory(file: string): Promise<Memory> {
  return parseMemory((await readText(file)) ?? '')
}

/** 聊天编号是否在往事索引里（手写的、解析不了的行也认行尾编号）。 */
export async function hasChatInIndex(file: string, chatId: string): Promise<boolean> {
  const text = await readText(file)
  if (text === null) return false
  const sec = findSec(parseDoc(text), 'index')
  return !!sec && contentOf(sec).some((l) => lineEndsWithId(l, chatId))
}

/** 整份文件的字数（Unicode 字符）。文件不存在为 0。 */
export async function memoryChars(file: string): Promise<number> {
  const text = await readText(file)
  return text === null ? 0 : countChars(text)
}

// ---------- 写入 ----------

function skeleton(characterName?: string): string {
  const head = characterName ? `# ${characterName} 与 我\n\n` : ''
  return head + SECTION_ORDER.map((k) => `## ${SECTION_TITLES[k]}\n`).join('\n')
}

/** 目标栏不存在（文件缺这一栏或标题被改坏）时在文件末尾补建；只追加，不改动原有内容。 */
function ensureSections(text: string, keys: MemorySection[], eol: string): Segment[] {
  let segs = parseDoc(text)
  for (const k of keys) {
    if (findSec(segs, k)) continue
    const t = serializeDoc(segs)
    const sep = t === '' || t.endsWith(eol + eol) ? '' : t.endsWith(eol) ? eol : eol + eol
    segs = parseDoc(`${t}${sep}## ${SECTION_TITLES[k]}${eol}`)
  }
  return segs
}

function finish(ctx: Ctx): string {
  const t = serializeDoc(ctx.segs)
  const last = ctx.segs[ctx.segs.length - 1]
  // 只有被改动的末段才补末尾换行
  if (last && ctx.touched.has(last) && !t.endsWith('\n')) return t + (t.endsWith('\r') ? '\n' : ctx.cr + '\n')
  return t
}

async function edit(
  file: string,
  keys: MemorySection[],
  opts: WriteOptions,
  change: (ctx: Ctx) => WriteResult,
): Promise<WriteResult> {
  let result: WriteResult = { written: false, reason: 'unchanged', trimmed: 0 }
  await modifyFile(file, (current) => {
    const fresh = current === null || current.trim() === ''
    const text = fresh ? skeleton(opts.characterName) : current
    const cr = !fresh && text.includes('\r\n') ? '\r' : ''
    const ctx: Ctx = { segs: ensureSections(text, keys, cr + '\n'), cr, touched: new Set() }
    result = change(ctx)
    // 没有改动时原样写回，不把用户的文件规整化
    return result.written ? finish(ctx) : (current ?? text)
  })
  return result
}

export interface FactOptions extends WriteOptions {
  maxFacts?: number
}

/** 追加一条关键的事：去重、超出上限丢最旧。 */
export async function appendFact(file: string, text: string, opts: FactOptions = {}): Promise<WriteResult> {
  const item = cleanItem(requireText(text, '关键的事'))
  if (!item) return { written: false, reason: 'empty', trimmed: 0 }
  return edit(file, ['facts'], opts, (ctx) => {
    const sec = findSec(ctx.segs, 'facts')!
    const content = contentOf(sec)
    if (itemKeys(content).has(dedupeKey(item))) return { written: false, reason: 'duplicate', trimmed: 0 }
    content.push(`- ${item}`)
    const trimmed = capItems(content, resolveLimit(opts.maxFacts, DEFAULT_MAX_FACTS))
    setContent(ctx, sec, content)
    return { written: true, trimmed }
  })
}

/** 追加一条"我让 TA 记住的"：只追加，不去重、不裁剪。 */
export async function appendPinned(file: string, text: string, opts: WriteOptions = {}): Promise<WriteResult> {
  const item = cleanItem(requireText(text, '记住的内容'))
  if (!item) return { written: false, reason: 'empty', trimmed: 0 }
  return edit(file, ['pinned'], opts, (ctx) => {
    const sec = findSec(ctx.segs, 'pinned')!
    setContent(ctx, sec, [...contentOf(sec), `- ${item}`])
    return { written: true, trimmed: 0 }
  })
}

/** 整体替换可以交给模型的三栏；类型上不接受 pinned 与 index。 */
export interface SectionPatch {
  address?: string
  impression?: string
  facts?: string[]
}

export async function replaceSections(
  file: string,
  patch: SectionPatch,
  opts: FactOptions = {},
): Promise<WriteResult> {
  // 只取三个允许的键，运行时多传的 pinned / index 一概忽略
  const { address, impression, facts } = patch
  const keys: MemorySection[] = []
  if (address !== undefined) { requireText(address, '称呼与关系'); keys.push('address') }
  if (impression !== undefined) { requireText(impression, '对我的印象'); keys.push('impression') }
  let factItems: string[] | undefined
  if (facts !== undefined) {
    if (!Array.isArray(facts)) throw new AhaError('memory-invalid', '关键的事必须是字符串数组')
    factItems = facts.map((f) => cleanItem(requireText(f, '关键的事')))
    keys.push('facts')
  }
  if (keys.length === 0) return { written: false, reason: 'unchanged', trimmed: 0 }

  return edit(file, keys, opts, (ctx) => {
    let trimmed = 0
    if (address !== undefined) setContent(ctx, findSec(ctx.segs, 'address')!, cleanBlock(address))
    if (impression !== undefined) setContent(ctx, findSec(ctx.segs, 'impression')!, cleanBlock(impression))
    if (factItems) {
      const seen = new Set<string>()
      const items: string[] = []
      for (const item of factItems) {
        const k = dedupeKey(item)
        if (!item || seen.has(k)) continue
        seen.add(k)
        items.push(`- ${item}`)
      }
      trimmed = capItems(items, resolveLimit(opts.maxFacts, DEFAULT_MAX_FACTS))
      setContent(ctx, findSec(ctx.segs, 'facts')!, items)
    }
    return { written: true, trimmed }
  })
}

export interface IndexLineInput {
  /** YYYY-MM-DD */
  date: string
  kind: ChatKind
  id: string
}

export interface IndexOptions extends WriteOptions {
  maxIndexLines?: number
}

/** 追加一行往事索引（标为未整理）。同一编号已在索引里则不写。 */
export async function appendIndexLine(
  file: string,
  entry: IndexLineInput,
  opts: IndexOptions = {},
): Promise<WriteResult> {
  const { date, kind, id } = entry
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AhaError('memory-invalid', `往事索引的日期格式不对：${String(date)}`)
  }
  if (typeof id !== 'string' || !id || /[\s〔〕]/.test(id)) {
    throw new AhaError('memory-invalid', `聊天编号不合法：${String(id)}`)
  }
  if (kind !== 'chat' && kind !== 'group') throw new AhaError('memory-invalid', `聊天类型不合法：${String(kind)}`)
  return edit(file, ['index'], opts, (ctx) => {
    const sec = findSec(ctx.segs, 'index')!
    const content = contentOf(sec)
    if (content.some((l) => lineEndsWithId(l, id))) return { written: false, reason: 'duplicate', trimmed: 0 }
    content.push(formatIndexLine({ date, kind, title: null, id }))
    const trimmed = capItems(content, resolveLimit(opts.maxIndexLines, DEFAULT_MAX_INDEX_LINES))
    setContent(ctx, sec, content)
    return { written: true, trimmed }
  })
}

/** 按行尾聊天编号把索引行改成带标题的。编号不存在时不报错、不新增。 */
export async function setIndexTitle(file: string, chatId: string, title: string): Promise<WriteResult> {
  const clean = cleanItem(requireText(title, '标题')).replace(/[〔〕]/g, '')
  if (!clean) return { written: false, reason: 'empty', trimmed: 0 }
  const text = await readText(file)
  if (text === null) return { written: false, reason: 'not-found', trimmed: 0 }
  return edit(file, [], {}, (ctx) => {
    const sec = findSec(ctx.segs, 'index')
    if (!sec) return { written: false, reason: 'not-found', trimmed: 0 }
    const content = contentOf(sec)
    const i = content.findIndex((l) => lineEndsWithId(l, chatId) && parseIndexLine(l) !== null)
    if (i < 0) return { written: false, reason: 'not-found', trimmed: 0 }
    const old = parseIndexLine(content[i] ?? '')!
    content[i] = formatIndexLine({ ...old, title: clean })
    setContent(ctx, sec, content)
    return { written: true, trimmed: 0 }
  })
}
