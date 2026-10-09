import { describe, expect, it } from 'vitest'
import { DEFAULTS, resolveConfig } from '../../src/config'

describe('配置默认值', () => {
  it('与全局约束一致', () => {
    expect(DEFAULTS.theme).toBe('fools')
    expect(DEFAULTS.worldBudget).toBe(4000)
    expect(DEFAULTS.memoryMaxChars).toBe(3000)
    expect(DEFAULTS.keyFactsMax).toBe(100)
    expect(DEFAULTS.pastIndexMaxLines).toBe(100)
    expect(DEFAULTS.reviewIntervalTurns).toBe(30)
    expect(DEFAULTS.recallExcerptMaxChars).toBe(2000)
    expect(DEFAULTS.registryPath).toBe('~/.dsh/aha-tavern/taverns.yaml')
  })

  it('未给配置时回落默认值，mode 缺省为 chat', () => {
    const c = resolveConfig(undefined)
    expect(c.mode).toBe('chat')
    expect(c.theme).toBe('fools')
  })

  it('用户配置覆盖默认值，未知字段忽略', () => {
    const c = resolveConfig({ mode: 'setup', theme: 'x', keyFactsMax: 50, bogus: 1 })
    expect(c.mode).toBe('setup')
    expect(c.theme).toBe('x')
    expect(c.keyFactsMax).toBe(50)
    expect(c.worldBudget).toBe(4000)
    expect('bogus' in c).toBe(false)
  })

  it('非法类型回落默认值', () => {
    const c = resolveConfig({ mode: 'weird', worldBudget: 'a' })
    expect(c.mode).toBe('chat')
    expect(c.worldBudget).toBe(4000)
  })
})
