import { describe, expect, it } from 'vitest'
import { COMMAND_IDS, dispatch, type CommandId } from '../../../src/core/dispatch'

// 独立抄写规格 §4 的表（列顺序：init card me world import start remember reroll speak doctor）
// R=可用 I=init-first S=go-setup C=go-chat N=new-session A=already-tavern M=meaningless U=unavailable
const ORDER: CommandId[] = ['init', 'card', 'me', 'world', 'import', 'start', 'remember', 'reroll', 'speak', 'doctor']
const SHEET: Record<string, string> = {
  'setup/outside':    'R I I I I C M U U R',
  'setup/preparing':  'A R R R R C M U U R',
  'chat/outside':     'S S S S S S M U U R',
  'chat/picking':     'S S S S S R M U U R',
  'chat/chatting':    'S S S S S N R U U R',
}
const REASON: Record<string, string> = {
  I: 'init-first', S: 'go-setup', C: 'go-chat', N: 'new-session', A: 'already-tavern', M: 'meaningless', U: 'unavailable',
}

describe('dispatch 逐格核对', () => {
  it('命令清单', () => {
    expect([...COMMAND_IDS]).toEqual(ORDER)
  })
  for (const [key, row] of Object.entries(SHEET)) {
    const [mode, state] = key.split('/') as ['setup' | 'chat', 'outside' | 'preparing' | 'picking' | 'chatting']
    const cells = row.split(' ')
    ORDER.forEach((cmd, i) => {
      it(`${key} ${cmd}`, () => {
        const expected = cells[i] === 'R' ? { run: true } : { run: false, reason: REASON[cells[i]!] }
        expect(dispatch(mode, state, cmd)).toEqual(expected)
      })
    })
  }
  it('reroll / speak 任何组合都 unavailable', () => {
    for (const key of Object.keys(SHEET)) {
      const [mode, state] = key.split('/') as ['setup' | 'chat', 'outside']
      for (const cmd of ['reroll', 'speak'] as const) {
        expect(dispatch(mode, state, cmd)).toEqual({ run: false, reason: 'unavailable' })
      }
    }
  })
  it('模式与状态不匹配的组合按无意义处理', () => {
    expect(dispatch('setup', 'chatting', 'card')).toEqual({ run: false, reason: 'meaningless' })
  })
})
