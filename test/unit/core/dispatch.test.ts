import { describe, expect, it } from 'vitest'
import type { TavernMode } from '../../../src/config'
import { COMMAND_IDS, dispatch, type CommandId } from '../../../src/core/dispatch'
import type { SessionState } from '../../../src/core/state'

// 独立抄写规格 §4 与二期规格 §12 的表（列顺序：init card me world import start narrator scene wrap remember reroll speak doctor voice look book progress pause export；look 的各格与 card 相同）
// R=可用 I=init-first S=go-setup C=go-chat G=go-group N=new-session A=already-tavern M=meaningless U=unavailable
// B=go-book F=book-first O=book-open
const ORDER: CommandId[] = [
  'init', 'card', 'me', 'world', 'import', 'start', 'narrator', 'scene', 'wrap', 'remember', 'reroll', 'speak', 'doctor', 'voice', 'look',
  'book', 'progress', 'pause', 'export',
]
const SHEET: Record<string, string> = {
  'setup/outside':     'R I I I I C G G G M U U R R I B B B B',
  'setup/preparing':   'A R R R R C G G G M U U R R R B B B B',
  'chat/outside':      'S S S S S S G G G M U U R R S B B B B',
  'chat/picking':      'S S S S S R G G G M U U R R S B B B B',
  'chat/chatting':     'S S S S S N G G G R R R R R S B B B B',
  'group/outside':     'S S S S S S M M M M U U R R S B B B B',
  'group/gathering':   'S S S S S R M M M M U U R R S B B B B',
  'group/performing':  'S S S S S N R R R R R R R R S B B B B',
  'book/outside':      'S S S S S C G G G M M M R R S S S S S',
  'book/opening':      'S S S S S C G G G M M M R R S R F F F',
  'book/writing':      'S S S S S C G G G M M M R R S O R R R',
}
const REASON: Record<string, string> = {
  I: 'init-first', S: 'go-setup', C: 'go-chat', G: 'go-group', N: 'new-session', A: 'already-tavern', M: 'meaningless', U: 'unavailable',
  B: 'go-book', F: 'book-first', O: 'book-open',
}

describe('dispatch 逐格核对', () => {
  it('命令清单', () => {
    expect([...COMMAND_IDS]).toEqual(ORDER)
  })
  for (const [key, row] of Object.entries(SHEET)) {
    const [mode, state] = key.split('/') as [TavernMode, SessionState]
    const cells = row.split(' ')
    ORDER.forEach((cmd, i) => {
      it(`${key} ${cmd}`, () => {
        const expected = cells[i] === 'R' ? { run: true } : { run: false, reason: REASON[cells[i]!] }
        expect(dispatch(mode, state, cmd)).toEqual(expected)
      })
    })
  }
  it('speak 与 reroll 只有单聊·聊天中、群聊·场景中可用；写书模式里无意义', () => {
    for (const key of Object.keys(SHEET)) {
      const [mode, state] = key.split('/') as [TavernMode, SessionState]
      for (const cmd of ['speak', 'reroll'] as const) {
        expect(dispatch(mode, state, cmd)).toEqual(
          key === 'chat/chatting' || key === 'group/performing' ? { run: true }
            : key.startsWith('book/') ? { run: false, reason: 'meaningless' } : { run: false, reason: 'unavailable' },
        )
      }
    }
  })
  it('narrator、scene、wrap 只有群聊·场景中可用，别处都指点去群聊', () => {
    for (const key of Object.keys(SHEET)) {
      const [mode, state] = key.split('/') as [TavernMode, SessionState]
      for (const cmd of ['narrator', 'scene', 'wrap'] as const) {
        expect(dispatch(mode, state, cmd)).toEqual(
          key === 'group/performing' ? { run: true } : key.startsWith('group/')
            ? { run: false, reason: 'meaningless' }
            : { run: false, reason: 'go-group' },
        )
      }
    }
  })
  it('模式与状态不匹配的组合按无意义处理', () => {
    expect(dispatch('setup', 'chatting', 'card')).toEqual({ run: false, reason: 'meaningless' })
    expect(dispatch('chat', 'performing', 'narrator')).toEqual({ run: false, reason: 'meaningless' })
  })
})
