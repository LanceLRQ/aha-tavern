// 聊天目录、原始记录、梗概与回忆节选（规格 §9.1、§7.4）。
// 原始记录每行一个 JSON 对象：time / type / speaker / text，读取时容忍未知字段与未知类型，
// 以便二期群聊在同一格式上追加场景序号等字段。

import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { AhaError } from './errors'
import { atomicWrite, modifyFile, pathExists, safeDirName } from './fsx'
import { isChatId, newChatId } from './ids'
import { countChars } from './docs'
import type { ChatKind } from './memory'

export const CHATS_DIR = 'chats'
export const CHAT_LOG_FILE = 'chat.jsonl'
export const CHAT_SUMMARY_FILE = 'summary.md'
export const CHAT_META_FILE = 'meta.yaml'

export const DEFAULT_EXCERPT_LIMIT = 2000

export interface ChatMeta {
  kind: ChatKind
  /** 参与者的角色编号 */
  participants: string[]
  /** 宿主会话编号 */
  session: string
  /** 开始时间（ISO） */
  started: string
  title: string
}

export interface ChatRecord {
  time: string
  /** 单聊用 user / character；未知类型原样保留 */
  type: string
  /** user 或角色编号；旁白等无说话人的类型可缺省 */
  speaker?: string
  text: string
  [extra: string]: unknown
}

export interface ChatHandle {
  id: string
  dirName: string
  dir: string
}

export interface CreateChatInput {
  kind: ChatKind
  /** 目录名里的名称部分 */
  name: string
  participants: string[]
  sessionId: string
  now: Date
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function dirTimeStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

const chatsRoot = (tavernDir: string) => path.join(tavernDir, CHATS_DIR)

/** 按目录名最后一个 `-` 之后的整段做相等比较；编号格式不合格、同名后缀的普通文件都不命中。 */
export async function findChatDir(tavernDir: string, chatId: string): Promise<string | null> {
  if (!isChatId(chatId)) return null
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(chatsRoot(tavernDir), { withFileTypes: true })
  } catch {
    return null
  }
  const hit = entries.find((e) => e.isDirectory() && e.name.slice(e.name.lastIndexOf('-') + 1) === chatId)
  return hit ? path.join(chatsRoot(tavernDir), hit.name) : null
}

async function requireChatDir(tavernDir: string, chatId: string): Promise<string> {
  const dir = await findChatDir(tavernDir, chatId)
  if (!dir) throw new AhaError('chat-not-found', `找不到聊天：${chatId}`)
  return dir
}

export async function createChat(tavernDir: string, input: CreateChatInput): Promise<ChatHandle> {
  const stamp = dirTimeStamp(input.now)
  const name = safeDirName(input.name)
  let id = newChatId()
  for (let i = 0; i < 50 && (await findChatDir(tavernDir, id)); i++) id = newChatId()
  if (await findChatDir(tavernDir, id)) throw new AhaError('chat-invalid', '无法生成不重复的聊天编号')
  const dirName = `${stamp}-${name}-${id}`
  const dir = path.join(chatsRoot(tavernDir), dirName)
  await fs.mkdir(dir, { recursive: true })
  const meta: ChatMeta = {
    kind: input.kind,
    participants: input.participants,
    session: input.sessionId,
    started: input.now.toISOString(),
    title: '',
  }
  await atomicWrite(path.join(dir, CHAT_META_FILE), YAML.stringify(meta))
  return { id, dirName, dir }
}

function parseMeta(text: string, chatId: string): ChatMeta {
  let v: unknown
  try {
    v = YAML.parse(text)
  } catch (e) {
    throw new AhaError('chat-invalid', `聊天元数据无法解析：${chatId}`, { cause: e })
  }
  const m = v as Partial<ChatMeta> | null
  const ok =
    !!m &&
    typeof m === 'object' &&
    (m.kind === 'chat' || m.kind === 'group') &&
    Array.isArray(m.participants) &&
    m.participants.every((x) => typeof x === 'string') &&
    typeof m.session === 'string' &&
    typeof m.started === 'string' &&
    typeof m.title === 'string'
  if (!ok) throw new AhaError('chat-invalid', `聊天元数据格式不对：${chatId}`)
  return m as ChatMeta
}

async function readMetaIn(dir: string, chatId: string): Promise<ChatMeta> {
  let text: string
  try {
    text = await fs.readFile(path.join(dir, CHAT_META_FILE), 'utf8')
  } catch (e) {
    throw new AhaError('chat-invalid', `聊天元数据无法读取：${chatId}`, { cause: e })
  }
  return parseMeta(text, chatId)
}

export async function readChatMeta(tavernDir: string, chatId: string): Promise<ChatMeta> {
  return readMetaIn(await requireChatDir(tavernDir, chatId), chatId)
}

async function endsWithoutNewline(file: string): Promise<boolean> {
  let h: fs.FileHandle
  try {
    h = await fs.open(file, 'r')
  } catch {
    return false
  }
  try {
    const { size } = await h.stat()
    if (size === 0) return false
    const buf = Buffer.alloc(1)
    await h.read(buf, 0, 1, size - 1)
    return buf[0] !== 0x0a
  } finally {
    await h.close()
  }
}

/** 纯追加一行；time 缺省取当前时间。 */
export async function appendRecord(
  tavernDir: string,
  chatId: string,
  record: Omit<ChatRecord, 'time'> & { time?: string },
): Promise<void> {
  const dir = await requireChatDir(tavernDir, chatId)
  const line = { ...record, time: record.time ?? new Date().toISOString() }
  const file = path.join(dir, CHAT_LOG_FILE)
  // 上次崩溃可能留下没有结尾换行的半行：只看末 1 字节，必要时先补换行，免得新记录并进残行
  const prefix = (await endsWithoutNewline(file)) ? '\n' : ''
  await fs.appendFile(file, prefix + JSON.stringify(line) + '\n', 'utf8')
}

export async function readRecords(
  tavernDir: string,
  chatId: string,
): Promise<{ records: ChatRecord[]; skipped: number }> {
  const dir = await requireChatDir(tavernDir, chatId)
  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, CHAT_LOG_FILE), 'utf8')
  } catch {
    return { records: [], skipped: 0 }
  }
  const records: ChatRecord[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) records.push(v as ChatRecord)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { records, skipped }
}

/** 只写梗概文件。 */
export async function writeSummaryFile(tavernDir: string, chatId: string, summary: string): Promise<void> {
  const dir = await requireChatDir(tavernDir, chatId)
  await atomicWrite(path.join(dir, CHAT_SUMMARY_FILE), summary)
}

/** 只改 meta.yaml 里的标题（带锁读改写）。 */
export async function setChatTitle(tavernDir: string, chatId: string, title: string): Promise<void> {
  const dir = await requireChatDir(tavernDir, chatId)
  await modifyFile(path.join(dir, CHAT_META_FILE), (current) => {
    if (current === null) throw new AhaError('chat-invalid', `聊天元数据缺失：${chatId}`)
    return YAML.stringify({ ...parseMeta(current, chatId), title })
  })
}

/** 写梗概，并把标题同步进 meta.yaml；两步分别由 writeSummaryFile 与 setChatTitle 完成。 */
export async function writeSummary(
  tavernDir: string,
  chatId: string,
  input: { summary: string; title: string },
): Promise<void> {
  await writeSummaryFile(tavernDir, chatId, input.summary)
  await setChatTitle(tavernDir, chatId, input.title)
}

export type RecallResult =
  | { kind: 'recap'; text: string }
  | { kind: 'excerpt'; text: string; omitted: number; skipped: number; truncated: boolean }
  | { kind: 'empty' }
  | { kind: 'missing' }

export interface RecallOptions {
  /** 节选字数上限，默认 2000 */
  limit?: number
  /** 说话人标识 → 显示名；缺省用标识本身 */
  speakerNames?: Record<string, string>
  /** 中间省略处的说明行 */
  omitMarker?: (omitted: number) => string
}

const defaultOmitMarker = (n: number) => `……（中间省略 ${n} 条）……`

interface Line {
  prefix: string
  body: string
  full: string
}

function renderRecord(r: ChatRecord, names: Record<string, string>): Line {
  const body = typeof r.text === 'string' ? r.text : ''
  const prefix = typeof r.speaker === 'string' && r.speaker ? `${names[r.speaker] ?? r.speaker}：` : ''
  return { prefix, body, full: prefix + body }
}

const ELLIPSIS = '…'

/** 取开头与结尾若干条，交替贪心收入，总字数（含说明行）不超过 limit。放不下任何前缀时返回 null。 */
function buildExcerpt(lines: Line[], limit: number, marker: (n: number) => string) {
  const total = lines.reduce((s, l) => s + countChars(l.full), 0) + Math.max(0, lines.length - 1)
  if (total <= limit) return { text: lines.map((l) => l.full).join('\n'), omitted: 0, truncated: false }

  // 说明行的条数位数最多与总条数一致，按最坏情形预留
  const markerCost = countChars(marker(lines.length)) + 2
  const budget = Math.max(0, limit - markerCost)
  const head: string[] = []
  const tail: string[] = []
  let used = 0
  let i = 0
  let j = lines.length - 1
  let progressed = true
  while (i <= j && progressed) {
    progressed = false
    const cost = (l: Line, count: number) => countChars(l.full) + (count > 0 ? 1 : 0)
    if (i <= j) {
      const c = cost(lines[i]!, head.length + tail.length)
      if (used + c <= budget) {
        head.push(lines[i++]!.full)
        used += c
        progressed = true
      }
    }
    if (i <= j) {
      const c = cost(lines[j]!, head.length + tail.length)
      if (used + c <= budget) {
        tail.unshift(lines[j--]!.full)
        used += c
        progressed = true
      }
    }
  }
  if (head.length + tail.length === 0) {
    // 连一条都放不下：保留第一条的开头，末尾加省略号
    const first = lines[0]!
    const room = limit - countChars(first.prefix) - 1
    if (room < 1) return null
    const text = first.prefix + [...first.body].slice(0, room).join('') + ELLIPSIS
    return { text, omitted: lines.length - 1, truncated: true }
  }
  const omitted = lines.length - head.length - tail.length
  return { text: [...head, marker(omitted), ...tail].join('\n'), omitted, truncated: true }
}

/** 回忆：有梗概给梗概，否则给原始记录节选。 */
export async function recallChat(
  tavernDir: string,
  chatId: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const dir = await findChatDir(tavernDir, chatId)
  if (!dir) return { kind: 'missing' }

  const summaryFile = path.join(dir, CHAT_SUMMARY_FILE)
  if (await pathExists(summaryFile)) {
    const text = await fs.readFile(summaryFile, 'utf8')
    if (text.trim()) return { kind: 'recap', text }
  }

  const { records, skipped } = await readRecords(tavernDir, chatId)
  const names = options.speakerNames ?? {}
  const lines = records.map((r) => renderRecord(r, names)).filter((l) => l.full.length > 0)
  if (lines.length === 0) return { kind: 'empty' }

  const limit = options.limit ?? DEFAULT_EXCERPT_LIMIT
  const ex = buildExcerpt(lines, limit, options.omitMarker ?? defaultOmitMarker)
  if (!ex) return { kind: 'empty' }
  return { kind: 'excerpt', text: ex.text, omitted: ex.omitted, skipped, truncated: ex.truncated }
}
