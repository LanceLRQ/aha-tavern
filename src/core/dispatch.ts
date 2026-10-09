// 命令分流表：模式 -> 状态 -> 命令 -> 结果。照规格 §4 的表抄成数据。

import type { TavernMode } from '../config'
import type { SessionState } from './state'

export const COMMAND_IDS = [
  'init', 'card', 'me', 'world', 'import', 'start', 'remember', 'reroll', 'speak', 'doctor',
] as const
export type CommandId = (typeof COMMAND_IDS)[number]

export type DispatchReason =
  | 'init-first'
  | 'go-setup'
  | 'go-chat'
  | 'new-session'
  | 'already-tavern'
  | 'meaningless'
  | 'unavailable'

export type DispatchResult = { run: true } | { run: false; reason: DispatchReason }

type Cell = 'run' | DispatchReason
type Row = Record<CommandId, Cell>

const run: Cell = 'run'

// 重新生图（reroll）只在单聊·聊天中可用；说话（speak）尚未提供，表里每一格都是 unavailable

const TABLE: Record<TavernMode, Partial<Record<SessionState, Row>>> = {
  setup: {
    outside: {
      init: run, card: 'init-first', me: 'init-first', world: 'init-first', import: 'init-first',
      start: 'go-chat', remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run,
    },
    preparing: {
      init: 'already-tavern', card: run, me: run, world: run, import: run,
      start: 'go-chat', remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run,
    },
  },
  chat: {
    // 规格 §4 表中没有单聊·门外一列；按 §3.2 "请用户用酒馆:筹备开店"补齐
    outside: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'go-setup', remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run,
    },
    picking: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: run, remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run,
    },
    chatting: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'new-session', remember: run, reroll: run, speak: 'unavailable', doctor: run,
    },
  },
}

export function dispatch(mode: TavernMode, state: SessionState, command: CommandId): DispatchResult {
  const cell = TABLE[mode][state]?.[command]
  if (cell === undefined) return { run: false, reason: 'meaningless' }
  return cell === 'run' ? { run: true } : { run: false, reason: cell }
}
