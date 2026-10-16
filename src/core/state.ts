// 会话状态：判定当前状态，并读写 .aha/sessions.yaml（宿主会话编号 -> 记录）。

import fs from 'node:fs/promises'
import { parse, stringify } from 'yaml'
import type { TavernMode } from '../config'
import { AhaError } from './errors'
import { modifyFile } from './fsx'

export type SessionState = 'outside' | 'preparing' | 'picking' | 'chatting' | 'gathering' | 'performing' | 'opening' | 'writing'
export type OutsideReason = 'no-workspace' | 'not-tavern'

export interface SessionRecord {
  mode: TavernMode
  state: SessionState
  /** 聊天编号，进入聊天后才有 */
  chatId?: string
  characterId?: string
  /** 写书：绑定的书编号 */
  bookId?: string
  updated: string
}

export interface StateInput {
  mode: TavernMode
  workspaceExists: boolean
  isTavern: boolean
  stored?: SessionRecord | null
}

export interface StateResult {
  state: SessionState
  /** 仅当 state 为 outside 时有值 */
  reason?: OutsideReason
}

const VALID_STATES: readonly SessionState[] = ['outside', 'preparing', 'picking', 'chatting', 'gathering', 'performing', 'opening', 'writing']
const VALID_MODES: readonly TavernMode[] = ['setup', 'chat', 'group', 'book']
/** 已进入聊天（单聊）、场景中（群聊）或已绑定书（写书）的记录不可逆，不能再改成别的状态、模式或聊天编号。 */
const LOCKED_STATES: readonly SessionState[] = ['chatting', 'performing', 'writing']

export function resolveState(input: StateInput): StateResult {
  if (!input.workspaceExists) return { state: 'outside', reason: 'no-workspace' }
  if (!input.isTavern) return { state: 'outside', reason: 'not-tavern' }
  if (input.mode === 'setup') return { state: 'preparing' }
  if (input.mode === 'book') {
    const s = input.stored
    if (s && s.mode === 'book' && s.state === 'writing') return { state: 'writing' }
    return { state: 'opening' }
  }
  if (input.mode === 'group') {
    const s = input.stored
    if (s && s.mode === 'group' && s.state === 'performing') return { state: 'performing' }
    return { state: 'gathering' }
  }
  const s = input.stored
  if (s && s.mode === 'chat' && s.state === 'chatting') return { state: 'chatting' }
  return { state: 'picking' }
}

interface ParsedFile {
  sessions: Record<string, unknown>
  broken: boolean
}

function parseFile(text: string | null): ParsedFile {
  if (text === null) return { sessions: {}, broken: false }
  try {
    const doc = parse(text) as unknown
    if (doc === null || doc === undefined) return { sessions: {}, broken: false }
    if (typeof doc !== 'object' || Array.isArray(doc)) return { sessions: {}, broken: true }
    const sessions = (doc as { sessions?: unknown }).sessions
    if (sessions === undefined || sessions === null) return { sessions: {}, broken: false }
    if (typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {}, broken: true }
    return { sessions: sessions as Record<string, unknown>, broken: false }
  } catch {
    return { sessions: {}, broken: true }
  }
}

function toRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!VALID_MODES.includes(r.mode as TavernMode)) return null
  if (!VALID_STATES.includes(r.state as SessionState)) return null
  const rec: SessionRecord = {
    mode: r.mode as TavernMode,
    state: r.state as SessionState,
    updated: typeof r.updated === 'string' ? r.updated : '',
  }
  if (typeof r.chatId === 'string') rec.chatId = r.chatId
  if (typeof r.characterId === 'string') rec.characterId = r.characterId
  if (typeof r.bookId === 'string') rec.bookId = r.bookId
  return rec
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 查不到（文件缺失、损坏、记录无效）一律返回 record: null；文件损坏时 broken 为 true。 */
export async function readSession(
  file: string,
  sessionId: string,
): Promise<{ record: SessionRecord | null; broken: boolean }> {
  const { sessions, broken } = parseFile(await readText(file))
  return { record: toRecord(sessions[sessionId]), broken }
}

export interface SessionPatch {
  mode: TavernMode
  state: SessionState
  chatId?: string
  characterId?: string
  bookId?: string
}

/**
 * 写入（新建或更新）一条会话记录。不变式：已进入聊天（chatting）或场景中
 * （performing）的记录不可改成别的状态、模式或换聊天编号。原文件损坏时先改名备份再写新文件。
 */
export async function saveSession(
  file: string,
  sessionId: string,
  patch: SessionPatch,
  now: Date = new Date(),
): Promise<SessionRecord> {
  if (patch.state === 'writing' ? !patch.bookId : LOCKED_STATES.includes(patch.state) && !patch.chatId) {
    throw new AhaError('session-invalid', patch.state === 'writing' ? '进入写书状态必须带书编号' : '进入聊天状态必须带聊天编号')
  }
  let result!: SessionRecord
  await modifyFile(file, async (current) => {
    const { sessions, broken } = parseFile(current)
    if (broken) {
      await fs.rename(file, `${file}.broken-${now.getTime()}`)
    }
    const existing = toRecord(sessions[sessionId])
    if (
      existing && LOCKED_STATES.includes(existing.state) &&
      (patch.state !== existing.state || patch.mode !== existing.mode || patch.chatId !== existing.chatId || patch.bookId !== existing.bookId)
    ) {
      throw new AhaError('session-locked', `会话 ${sessionId} 已在聊天中，状态不可更改`)
    }
    const rec: SessionRecord = { mode: patch.mode, state: patch.state, updated: now.toISOString() }
    if (patch.chatId) rec.chatId = patch.chatId
    if (patch.characterId) rec.characterId = patch.characterId
    if (patch.bookId) rec.bookId = patch.bookId
    result = rec
    return stringify({ sessions: { ...sessions, [sessionId]: rec } })
  })
  return result
}
