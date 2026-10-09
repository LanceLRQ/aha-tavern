import { describe, expect, it } from 'vitest'
import { DEFAULTS, resolveConfig, tavernDataDir } from '../../src/config'

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

  it('数值配置要求整数：小数回落默认值', () => {
    const c = resolveConfig({ keyFactsMax: 2.5, worldBudget: 100.5, memoryMaxChars: 5000 })
    expect(c.keyFactsMax).toBe(100)
    expect(c.worldBudget).toBe(4000)
    expect(c.memoryMaxChars).toBe(5000)
  })

  it('非法类型回落默认值', () => {
    const c = resolveConfig({ mode: 'weird', worldBudget: 'a' })
    expect(c.mode).toBe('chat')
    expect(c.worldBudget).toBe(4000)
  })
})

describe('登记表默认路径跟随 DSH_HOME', () => {
  it('未设 DSH_HOME 时用 ~/.dsh', () => {
    expect(resolveConfig({}, {}).registryPath).toBe('~/.dsh/aha-tavern/taverns.yaml')
    expect(resolveConfig({}, { DSH_HOME: '  ' }).registryPath).toBe('~/.dsh/aha-tavern/taverns.yaml')
  })

  it('设了 DSH_HOME 时按它解析，去掉末尾斜杠', () => {
    expect(resolveConfig({}, { DSH_HOME: '/data/dsh' }).registryPath).toBe('/data/dsh/aha-tavern/taverns.yaml')
    expect(resolveConfig({}, { DSH_HOME: '/data/dsh/' }).registryPath).toBe('/data/dsh/aha-tavern/taverns.yaml')
  })

  it('用户显式配置的 registryPath 不受影响', () => {
    expect(resolveConfig({ registryPath: '/x/r.yaml' }, { DSH_HOME: '/data/dsh' }).registryPath).toBe('/x/r.yaml')
  })
})

describe('服务配置路径', () => {
  it('默认与登记表同目录', () => {
    expect(DEFAULTS.servicesPath).toBe('~/.dsh/aha-tavern/services.yaml')
    expect(resolveConfig({}, {}).servicesPath).toBe('~/.dsh/aha-tavern/services.yaml')
  })

  it('设了 DSH_HOME 时两者同时跟随', () => {
    const c = resolveConfig({}, { DSH_HOME: '/data/dsh/' })
    expect(c.registryPath).toBe('/data/dsh/aha-tavern/taverns.yaml')
    expect(c.servicesPath).toBe('/data/dsh/aha-tavern/services.yaml')
  })

  it('显式配置的 servicesPath 优先，支持 ~ 开头', () => {
    expect(resolveConfig({ servicesPath: '~/s.yaml' }, { DSH_HOME: '/data/dsh' }).servicesPath).toBe('~/s.yaml')
    expect(resolveConfig({ servicesPath: '' }, {}).servicesPath).toBe('~/.dsh/aha-tavern/services.yaml')
  })

  it('酒馆数据目录解析函数', () => {
    expect(tavernDataDir({})).toBe('~/.dsh/aha-tavern')
    expect(tavernDataDir({ DSH_HOME: '/d/' })).toBe('/d/aha-tavern')
  })
})
