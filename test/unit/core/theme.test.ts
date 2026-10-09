import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CONCEPT_IDS, ACTION_IDS } from '../../../src/core/terms'
import { loadTheme } from '../../../src/core/theme'

const builtinDir = path.resolve(__dirname, '../../../themes')
let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-theme-')) })
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

describe('terms', () => {
  it('标识清单与规格 15.2、15.3 一致', () => {
    expect([...CONCEPT_IDS]).toEqual([
      'tavern', 'host', 'character', 'card', 'user', 'profile', 'world', 'house_rules',
      'core_memory', 'recap', 'transcript', 'narrator', 'extra', 'scenario', 'show', 'scene',
    ])
    expect([...ACTION_IDS]).toEqual(['init', 'import', 'wrap'])
  })
})

describe('theme', () => {
  it('直白主题覆盖全部标识', async () => {
    const { theme, warnings } = await loadTheme({ name: 'plain', builtinDir })
    expect(warnings).toEqual([])
    for (const id of CONCEPT_IDS) expect(theme.concept(id), id).toBeTruthy()
    for (const id of ACTION_IDS) expect(theme.action(id), id).toBeTruthy()
    expect(theme.concept('host')).toBe('掌柜')
    expect(theme.host().name).toBe('掌柜')
    expect(theme.persona().length).toBeGreaterThan(0)
  })

  it('愚者主题逐项与规格表一致', async () => {
    const { theme, warnings } = await loadTheme({ name: 'fools', builtinDir })
    expect(warnings).toEqual([])
    const concepts: Record<string, string> = {
      tavern: '酒馆', host: '剧团长', character: '面具', card: '面具档案', user: '无名客',
      profile: '无名客档案', world: '剧本', house_rules: '酒馆宣言', core_memory: '光锥',
      recap: '忆泡', transcript: '忆质', narrator: '旁白', extra: 'NPC', scenario: '戏码',
      show: '即兴巡演', scene: '一幕',
    }
    for (const [id, v] of Object.entries(concepts)) expect(theme.concept(id as never), id).toBe(v)
    expect(theme.action('init')).toBe('开张')
    expect(theme.action('import')).toBe('跃迁')
    expect(theme.action('wrap')).toBe('谢幕')
    expect(theme.host()).toEqual({ name: '剧团长', aliases: ['虚照', '模糊二维马', '模糊老师', '马老师'] })
    expect(theme.persona().length).toBeGreaterThan(0)
  })

  it('自定义主题缺项回退到直白', async () => {
    const f = path.join(tmp, 'mine.yaml')
    await fs.writeFile(f, 'concepts:\n  card: 画皮\nactions:\n  wrap: 打烊\n')
    const { theme } = await loadTheme({ name: 'fools', file: f, builtinDir })
    expect(theme.concept('card')).toBe('画皮')
    expect(theme.concept('world')).toBe('世界观')
    expect(theme.action('wrap')).toBe('打烊')
    expect(theme.action('init')).toBe('开店')
    expect(theme.host().name).toBe('掌柜')
    expect(theme.persona()).toBeTruthy()
  })

  it('不存在的主题回退到直白并给出警告', async () => {
    const { theme, warnings } = await loadTheme({ name: 'guofeng', builtinDir })
    expect(theme.concept('card')).toBe('角色卡')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('guofeng')
  })

  it('不合法的主题名不读文件，回退并警告', async () => {
    const { theme, warnings } = await loadTheme({ name: '../x', builtinDir })
    expect(theme.concept('card')).toBe('角色卡')
    expect(warnings).toHaveLength(1)
  })

  it('自定义文件不存在或损坏时回退并警告', async () => {
    const r1 = await loadTheme({ name: 'plain', file: path.join(tmp, 'nope.yaml'), builtinDir })
    expect(r1.theme.concept('card')).toBe('角色卡')
    expect(r1.warnings).toHaveLength(1)
    const bad = path.join(tmp, 'bad.yaml')
    await fs.writeFile(bad, '- [unclosed\n: :')
    const r2 = await loadTheme({ name: 'plain', file: bad, builtinDir })
    expect(r2.warnings).toHaveLength(1)
  })

  it('主题文件里的未知标识被忽略', async () => {
    const f = path.join(tmp, 'x.yaml')
    await fs.writeFile(f, 'concepts:\n  card: 画皮\n  bogus: 啥\nactions:\n  nope: 啥\n')
    const { theme, warnings } = await loadTheme({ name: 'plain', file: f, builtinDir })
    expect(warnings).toEqual([])
    expect(theme.concept('card')).toBe('画皮')
    expect((theme.concept as (id: string) => string | undefined)('bogus')).toBeUndefined()
  })

  it('非字符串的值被忽略并回退', async () => {
    const f = path.join(tmp, 'y.yaml')
    await fs.writeFile(f, 'concepts:\n  card: 12\n  world: ""\n')
    const { theme } = await loadTheme({ name: 'plain', file: f, builtinDir })
    expect(theme.concept('card')).toBe('角色卡')
    expect(theme.concept('world')).toBe('世界观')
  })
})
