import { describe, it, expect } from 'vitest'
import { newCharacterId, newTavernId, newChatId } from '../../../src/core/ids'

describe('ids', () => {
  it('格式与长度', () => {
    expect(newCharacterId()).toMatch(/^c_[0-9a-z]{8}$/)
    expect(newTavernId()).toMatch(/^t_[0-9a-z]{8}$/)
    expect(newChatId()).toMatch(/^[0-9a-z]{4}$/)
  })
  it('不易撞', () => {
    const s = new Set(Array.from({ length: 2000 }, () => newCharacterId()))
    expect(s.size).toBe(2000)
  })
})

describe('形象编号', () => {
  it('格式与校验', async () => {
    const { newLookId, isLookId } = await import('../../../src/core/ids')
    expect(newLookId()).toMatch(/^l_[0-9a-z]{8}$/)
    expect(isLookId(newLookId())).toBe(true)
    for (const bad of ['l_ABCDEFGH', 'l_abc', 'l_abcdefghi', 'c_abcdefgh', '../x', '', 5, null]) {
      expect(isLookId(bad)).toBe(false)
    }
  })
})
