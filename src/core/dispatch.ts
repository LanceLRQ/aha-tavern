// 命令分流表：模式 -> 状态 -> 命令 -> 结果。照规格 §4 的表抄成数据。

import type { TavernMode } from '../config'
import type { SessionState } from './state'

export const COMMAND_IDS = [
  'init', 'card', 'me', 'world', 'import', 'start', 'narrator', 'scene', 'wrap', 'remember', 'reroll', 'speak',
  'doctor', 'voice', 'look',
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

export type DispatchResult = { run: true } | { run: false; reason: DispatchReason }

type Cell = 'run' | DispatchReason
type Row = Record<CommandId, Cell>

const run: Cell = 'run'

// 重新生图（reroll）与朗读（speak）只在单聊·聊天中、群聊·场景中可用；语音（voice）所有格子都可执行；
// 旁白（narrator）、换场（scene）、收场（wrap）只在群聊·场景中可用

const TABLE: Record<TavernMode, Partial<Record<SessionState, Row>>> = {
  setup: {
    outside: {
      init: run, card: 'init-first', me: 'init-first', world: 'init-first', import: 'init-first',
      start: 'go-chat', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'init-first',
    },
    preparing: {
      init: 'already-tavern', card: run, me: run, world: run, import: run,
      start: 'go-chat', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: run,
    },
  },
  chat: {
    // 规格 §4 表中没有单聊·门外一列；按 §3.2 "请用户用酒馆:筹备开店"补齐
    outside: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'go-setup', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup',
    },
    picking: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: run, narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup',
    },
    chatting: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'new-session', narrator: 'go-group', scene: 'go-group', wrap: 'go-group',
      remember: run, reroll: run, speak: run, doctor: run, voice: run, look: 'go-setup',
    },
  },
  group: {
    outside: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'go-setup', narrator: 'meaningless', scene: 'meaningless', wrap: 'meaningless',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup',
    },
    gathering: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: run, narrator: 'meaningless', scene: 'meaningless', wrap: 'meaningless',
      remember: 'meaningless', reroll: 'unavailable', speak: 'unavailable', doctor: run, voice: run, look: 'go-setup',
    },
    performing: {
      init: 'go-setup', card: 'go-setup', me: 'go-setup', world: 'go-setup', import: 'go-setup',
      start: 'new-session', narrator: run, scene: run, wrap: run,
      remember: run, reroll: run, speak: run, doctor: run, voice: run, look: 'go-setup',
    },
  },
}

export function dispatch(mode: TavernMode, state: SessionState, command: CommandId): DispatchResult {
  const cell = TABLE[mode][state]?.[command]
  if (cell === undefined) return { run: false, reason: 'meaningless' }
  return cell === 'run' ? { run: true } : { run: false, reason: cell }
}
