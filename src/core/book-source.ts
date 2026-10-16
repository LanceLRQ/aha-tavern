// 三期写书的原料（规格 §6.2）：按物理行号读聊天记录，按范围取出叙事记录，转写成 [说话人] 正文，
// 插图按时间对位成占位符；另给定纲用的聊天列表与 survey。
// 行号是 chat.jsonl 的物理行号（只追加，稳定）；坏行与空行占着行号但不返回。
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { CHAT_LOG_FILE, CHAT_META_FILE, CHAT_SUMMARY_FILE, CHATS_DIR, type ChatMeta } from './chat'
import { countChars } from './docs'
import { IMAGES_LOG_FILE, type ImageRecord } from './images'
import { parseSummaryText } from './summary'
import { isChatDirName, SECTION_SOURCE_MAX, type SectionRange } from './book'

export interface SourceLine {
  line: number
  time: string
  type: string
  speaker?: string
  text: string
  scene?: number
  cast?: string[]
  userImpersonated?: boolean
}

/** 转写时的名字：角色编号 -> 名字；主角名为空时用户写成 [我]。 */
export interface Names {
  character(id: string): string
  protagonist: string
}

const NARRATIVE = new Set(['user', 'character', 'narrator'])
const isNarrative = (l: SourceLine) => NARRATIVE.has(l.type) && !(l.type === 'narrator' && l.userImpersonated)

export const chatDirOf = (tavernDir: string, dirName: string) => path.join(tavernDir, CHATS_DIR, dirName)

export async function readChatLines(chatDir: string): Promise<SourceLine[]> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(chatDir, CHAT_LOG_FILE), 'utf8')
  } catch {
    return []
  }
  const out: SourceLine[] = []
  raw.split('\n').forEach((text, i) => {
    if (!text.trim()) return
    try {
      const v = JSON.parse(text) as Record<string, unknown>
      if (!v || typeof v !== 'object' || typeof v.type !== 'string' || typeof v.text !== 'string') return
      out.push({
        line: i + 1, time: typeof v.time === 'string' ? v.time : '', type: v.type, text: v.text,
        ...(typeof v.speaker === 'string' ? { speaker: v.speaker } : {}),
        ...(typeof v.scene === 'number' ? { scene: v.scene } : {}),
        ...(Array.isArray(v.cast) ? { cast: v.cast.filter((x): x is string => typeof x === 'string') } : {}),
        ...(v.userImpersonated === true ? { userImpersonated: true } : {}),
      })
    } catch {
      // 坏行跳过，行号照占
    }
  })
  return out
}

/** 取范围内的叙事记录；endTime 是范围之后第一条叙事记录的时间（没有为 null），插图对位用。 */
export function selectRange(lines: readonly SourceLine[], range: SectionRange): { picked: SourceLine[]; endTime: string | null } {
  const inRange = (l: SourceLine) => ('scene' in range ? (l.scene ?? 1) === range.scene : l.line >= range.from && l.line <= range.to)
  const picked = lines.filter((l) => inRange(l) && isNarrative(l))
  const lastLine = picked.length ? picked[picked.length - 1]!.line : Infinity
  const after = lines.find((l) => l.line > lastLine && isNarrative(l) && !inRange(l))
  return { picked, endTime: after?.time ?? null }
}

/** 被重画过的图（n 出现在别的图的 redoOf 里）不要，只留最终版本。 */
export function finalImages(records: readonly ImageRecord[]): ImageRecord[] {
  const redone = new Set(records.map((r) => r.redoOf).filter((n): n is number => typeof n === 'number'))
  return records.filter((r) => !redone.has(r.n))
}

function speakerLabel(l: SourceLine, names: Names): string {
  if (l.type === 'narrator') return '旁白'
  if (l.type === 'user') return names.protagonist ? `我→${names.protagonist}` : '我'
  return names.character(l.speaker ?? '')
}

export function transcribe(
  picked: readonly SourceLine[], names: Names, images: readonly ImageRecord[], endTime: string | null,
): { text: string; images: Array<{ n: number; file: string }> } {
  const start = picked[0]?.time ?? ''
  const mine = images
    .filter((i) => i.ts >= start && (endTime === null || i.ts < endTime))
    .sort((a, b) => a.ts.localeCompare(b.ts))
  const out: string[] = []
  const placed: Array<{ n: number; file: string }> = []
  let k = 0
  const flush = (until: string | null) => {
    while (k < mine.length && (until === null || mine[k]!.ts < until)) {
      placed.push({ n: placed.length + 1, file: mine[k]!.file })
      out.push(`[插图${placed.length}]`)
      k++
    }
  }
  picked.forEach((l, i) => {
    out.push(`[${speakerLabel(l, names)}] ${l.text.replace(/\s*\n\s*/g, ' ')}`)
    flush(picked[i + 1]?.time ?? null)
  })
  return { text: out.join('\n'), images: placed }
}

export const fingerprintOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

async function readImages(chatDir: string): Promise<ImageRecord[]> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(chatDir, IMAGES_LOG_FILE), 'utf8')
  } catch {
    return []
  }
  const out: ImageRecord[] = []
  for (const line of raw.split('\n')) {
    try {
      const v = JSON.parse(line) as ImageRecord
      if (v && typeof v.n === 'number' && typeof v.ts === 'string' && typeof v.file === 'string') out.push(v)
    } catch {
      // 跳过
    }
  }
  return out
}

export type SourceResult =
  | { ok: true; text: string; images: Array<{ n: number; file: string }>; chars: number; fingerprint: string }
  | { ok: false; error: string }

/** 一节的原料。错误文字是给模型看的英文固定标识。 */
export async function assembleSource(tavernDir: string, chat: string, range: SectionRange, names: Names): Promise<SourceResult> {
  if (!isChatDirName(chat)) return { ok: false, error: `no chat ${chat}` }
  const dir = chatDirOf(tavernDir, chat)
  try {
    await fs.access(path.join(dir, CHAT_META_FILE))
  } catch {
    return { ok: false, error: `no chat ${chat}; call aha_book_chats for valid names` }
  }
  const lines = await readChatLines(dir)
  const sel = selectRange(lines, range)
  if (sel.picked.length === 0) return { ok: false, error: `chat ${chat} has nothing in range ${JSON.stringify(range)}` }
  const t = transcribe(sel.picked, names, finalImages(await readImages(dir)), sel.endTime)
  return { ok: true, text: t.text, images: t.images, chars: countChars(t.text), fingerprint: fingerprintOf(t.text) }
}

export interface BookChatInfo {
  dirName: string
  kind: 'chat' | 'group'
  title: string
  started: string
  cast: string[]
  scenes: number
  chars: number
  lines: number
}

async function readMeta(dir: string): Promise<ChatMeta | null> {
  try {
    const m = YAML.parse(await fs.readFile(path.join(dir, CHAT_META_FILE), 'utf8')) as ChatMeta
    return m && (m.kind === 'chat' || m.kind === 'group') && Array.isArray(m.participants) ? m : null
  } catch {
    return null
  }
}

/** 酒馆里的聊天，按开始时间新的在前；元数据读不出来的跳过。 */
export async function listBookChats(tavernDir: string, names: Names): Promise<BookChatInfo[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(path.join(tavernDir, CHATS_DIR), { withFileTypes: true })
  } catch {
    return []
  }
  const out: BookChatInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = chatDirOf(tavernDir, e.name)
    const meta = await readMeta(dir)
    if (!meta) continue
    const lines = await readChatLines(dir)
    const narrative = lines.filter(isNarrative)
    out.push({
      dirName: e.name, kind: meta.kind, title: meta.title ?? '', started: meta.started ?? '',
      cast: meta.participants.map((id) => names.character(id)),
      scenes: meta.kind === 'group' ? Math.max(1, ...lines.map((l) => l.scene ?? 1)) : 0,
      chars: narrative.reduce((n, l) => n + countChars(l.text), 0),
      lines: lines.length ? lines[lines.length - 1]!.line : 0,
    })
  }
  return out.sort((a, b) => b.started.localeCompare(a.started))
}

export interface SurveyPart {
  range: SectionRange
  /** 第一条与最后一条叙事记录的行号 */
  lines: [number, number]
  chars: number
  preview: string
  summary?: string
  cast?: string[]
}

export interface Survey { kind: 'chat' | 'group'; summary: string; parts: SurveyPart[] }

/** 单聊切段：相邻两条间隔达到这个分钟数就切。 */
const GAP_MINUTES = 30
/** 单聊一段超过这个字数时，在下一条用户的话之前切开。 */
const PART_CHARS = 8000
const PREVIEW_LINES = 2

function partOf(range: SectionRange, picked: SourceLine[], names: Names): SurveyPart {
  const text = transcribe(picked, names, [], null).text
  return {
    range,
    lines: [picked[0]!.line, picked[picked.length - 1]!.line],
    chars: countChars(text),
    preview: text.split('\n').slice(0, PREVIEW_LINES).map((s) => [...s].slice(0, 60).join('')).join('\n'),
  }
}

export async function surveyChat(tavernDir: string, chat: string, names: Names): Promise<Survey> {
  if (!isChatDirName(chat)) throw new Error(`no chat ${chat}`)
  const dir = chatDirOf(tavernDir, chat)
  const meta = await readMeta(dir)
  if (!meta) throw new Error(`no chat ${chat}`)
  const lines = await readChatLines(dir)
  const narrative = lines.filter(isNarrative)
  let summaryText = ''
  try {
    summaryText = await fs.readFile(path.join(dir, CHAT_SUMMARY_FILE), 'utf8')
  } catch {
    // 没有梗概
  }
  if (meta.kind === 'group') {
    const show = parseSummaryText(summaryText)
    const max = Math.max(1, ...lines.map((l) => l.scene ?? 1))
    const parts: SurveyPart[] = []
    for (let n = 1; n <= max; n++) {
      const picked = narrative.filter((l) => (l.scene ?? 1) === n)
      if (picked.length === 0) continue
      const boundary = lines.find((l) => l.type === 'scene' && l.scene === n)
      const castIds = n === 1 ? meta.initialPresent ?? meta.participants : boundary?.cast ?? []
      const sec = show.scenes.find((s) => s.index === n)
      parts.push({
        ...partOf({ scene: n }, picked, names),
        cast: castIds.map((id) => names.character(id)),
        ...(sec ? { summary: sec.text.trim() } : {}),
      })
    }
    return { kind: 'group', summary: '', parts }
  }
  const groups: SourceLine[][] = []
  let cur: SourceLine[] = []
  let chars = 0
  for (const l of narrative) {
    const prev = cur[cur.length - 1]
    const gap = prev ? (Date.parse(l.time) - Date.parse(prev.time)) / 60000 : 0
    if (prev && (gap >= GAP_MINUTES || (chars >= PART_CHARS && l.type === 'user'))) {
      groups.push(cur)
      cur = []
      chars = 0
    }
    cur.push(l)
    chars += countChars(l.text)
  }
  if (cur.length) groups.push(cur)
  return {
    kind: 'chat',
    summary: summaryText.trim(),
    parts: groups.map((g) => partOf({ from: g[0]!.line, to: g[g.length - 1]!.line }, g, names)),
  }
}

export { SECTION_SOURCE_MAX }
