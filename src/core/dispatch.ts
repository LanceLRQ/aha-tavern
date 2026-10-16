// 命令分流表：模式 -> 状态 -> 命令 -> 结果。照规格 §4 的表抄成数据。

import type { TavernMode } from '../config'
import type { SessionState } from './state'

export const COMMAND_IDS = [
  'init', 'card', 'me', 'world', 'import', 'start', 'narrator', 'scene', 'wrap', 'remember', 'reroll', 'speak',
  'doctor', 'voice', 'look', 'book', 'progress', 'pause', 'export',
] as const
export type CommandId = (typeof COMMAND_IDS)[number]

export type DispatchReason =
  | 'init-first'
  | 'go-setup'
  | 'go-chat'
  | 'go-group'
  | 'new-session'
  | 'already-tavern'
  | 'meaningless'
  | 'unavailable'
  | 'go-book'
  /** 写书模式里还没开书 */
  | 'book-first'
  /** 这个会话已经绑定了一本书 */
  | 'book-open'

export type DispatchResult = { run: true } | { run: false; reason: DispatchReason }

type Cell = 'run' | DispatchReason
type Row = Record<CommandId, Cell>

const run: Cell = 'run'

// 重新生图（reroll）与朗读（speak）只在单聊·聊天中、群聊·场景中可用；语音（voice）所有格子都可执行；
// 旁白（narrator）、换场（scene）、收场（wrap）只在群聊·场景中可用

/** 写书的四个命令在别的模式里一律指点去写书模式。 */
const GO_BOOK = { book: 'go-book', progress: 'go-book', pause: 'go-book', export: 'go-book' } as const

/** 写书模式里，非写书命令的去向（三个状态相同）。 */
const BOOK_OTHERS = {
  init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
  start: 'go-chat', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
  remember: 'meaningless', reroll: 'meaningless', speak: 'meaningless', doctor: run, voice: run, look: 'go-setup',
} as const

const TABLE: Record<TavernMode, Partial<Record<SessionState, Row>>> = {
  setup: {
    outside: {
      init: run, card: 'init-first', me: 'init-first', world: 'init-first', import: 'init-first',
      start: 'go-chat', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'init-first', ...GO_BOOK,
    },
    preparing: {
      init: 'already-tavern', card: run, me: run, world: run, import: run,
      start: 'go-chat', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: run, ...GO_BOOK,
    },
  },
  chat: {
    // 规格 §4 表中没有单聊·门外一列；按 §3.2 "请用户用酒馆:筹备开店"补齐
    outside: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'go-setup', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup', ...GO_BOOK,
    },
    picking: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: run, narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup', ...GO_BOOK,
    },
    chatting: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'new-session', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: run, reroll: run, speak: run, doctor: run, voice: run, look: 'go-setup', ...GO_BOOK,
    },
  },
  group: {
    outside: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'go-setup', narrator: 'meaningless', scene: 'meaningless', wrap: 'meaningless',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup', ...GO_BOOK,
    },
    gathering: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: run, narrator: 'meaningless', scene: 'meaningless', wrap: 'meaningless',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup', ...GO_BOOK,
    },
    performing: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'new-session', narrator: run, scene: run, wrap: run,
      remember: run, reroll: run, speak: run, doctor: run, voice: run, look: 'go-setup', ...GO_BOOK,
    },
  },
  book: {
    outside: { ...BOOK_OTHERS, book: 'go-setup', progress: 'go-setup', pause: 'go-setup', export: 'go-setup' },
    opening: { ...BOOK_OTHERS, book: run, progress: 'book-first', pause: 'book-first', export: 'book-first' },
    writing: { ...BOOK_OTHERS, book: 'book-open', progress: run, pause: run, export: run },
  },
}

export function dispatch(mode: TavernMode, state: SessionState, command: CommandId): DispatchResult {
  const cell = TABLE[mode][state]?.[command]
  if (cell === undefined) return { run: false, reason: 'meaningless' }
  return cell === 'run' ? { run: true } : { run: false, reason: cell }
}
