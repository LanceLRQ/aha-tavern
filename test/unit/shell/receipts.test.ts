import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadTheme, type Theme } from '../../../src/core/theme'
import type { DispatchReason } from '../../../src/core/dispatch'
import {
  dispatchReceipt, doctorLine, emptyReceipt, failureReceipt, notTavernModeReceipt, pendingReceipt, unknownReceipt,
} from '../../../src/shell/receipts'

const builtinDir = path.resolve(__dirname, '../../../themes')
const load = async (name: string): Promise<Theme> => (await loadTheme({ name, builtinDir })).theme

const REASONS: DispatchReason[] = [
  'init-first', 'go-setup', 'go-chat', 'new-session', 'already-tavern', 'meaningless', 'unavailable',
]
const subs = [{ zh: '启动', en: 'init' }, { zh: '角色', en: 'card' }]

describe('回执文字', () => {
  it('每种原因都有一句非空文字', async () => {
    const t = await load('plain')
    for (const r of REASONS) {
      expect(dispatchReceipt(t, r, { label: '/aha 启动' }).text.length).toBeGreaterThan(0)
    }
  })

  it('先开店：门外两种原因文字不同，且指向开店命令', async () => {
    const t = await load('plain')
    const none = dispatchReceipt(t, 'init-first', { outsideReason: 'no-workspace' }).text
    const not = dispatchReceipt(t, 'init-first', { outsideReason: 'not-tavern' }).text
    expect(none).not.toBe(not)
    expect(none).toContain('工作区')
    expect(not).toContain('/aha 启动')
  })

  it('单聊在门外：先说明这里还不是酒馆，再请去筹备开店', async () => {
    const t = await load('plain')
    const not = dispatchReceipt(t, 'go-setup', { outsideReason: 'not-tavern' }).text
    expect(not).toContain('这里还不是酒馆')
    expect(not).toContain('酒馆:筹备')
    expect(not).toContain('/aha 启动')
    const none = dispatchReceipt(t, 'go-setup', { outsideReason: 'no-workspace' }).text
    expect(none).toContain('工作区')
    expect(none).toContain('酒馆:筹备')
    expect(none).not.toBe(not)
  })

  it('换主题后称呼跟着换', async () => {
    const plain = await load('plain')
    const fools = await load('fools')
    const a = dispatchReceipt(plain, 'already-tavern', {}).text
    const b = dispatchReceipt(fools, 'already-tavern', {}).text
    expect(a).toContain('开店')
    expect(b).toContain('开张')
    expect(b).not.toContain('开店')
    const c = dispatchReceipt(plain, 'go-setup', {}).text
    const d = dispatchReceipt(fools, 'go-setup', {}).text
    expect(c).toContain('掌柜')
    expect(d).toContain('剧团长')
    expect(d).not.toContain('掌柜')
    expect(dispatchReceipt(plain, 'new-session', {}).text).toContain('角色')
    expect(dispatchReceipt(fools, 'new-session', {}).text).toContain('面具')
  })

  it('自检一行带出模式、路径、主题、联网状态', async () => {
    const t = await load('fools')
    const line = doctorLine(t, { mode: 'chat', tavernDir: '/tmp/t', outsideReason: null, webSearch: 'available' })
    expect(line).toContain('酒馆:单聊')
    expect(line).toContain('/tmp/t')
    expect(line).toContain('fools')
    expect(line).toContain('可用')
    const out = doctorLine(t, { mode: 'setup', tavernDir: null, outsideReason: 'no-workspace', webSearch: 'unknown' })
    expect(out).toContain('门外')
    expect(out).toContain('未知')
    const out2 = doctorLine(t, { mode: 'setup', tavernDir: null, outsideReason: 'not-tavern', webSearch: 'unavailable' })
    expect(out2).not.toBe(out)
    expect(out2).toContain('不可用')
  })

  it('回执种类：只有未知、空、失败是 error，其余指引一律 success', async () => {
    const t = await load('plain')
    for (const r of REASONS) expect(dispatchReceipt(t, r, {}).kind).toBe('success')
    expect(unknownReceipt('跳舞', subs).kind).toBe('error')
    expect(emptyReceipt(subs).kind).toBe('error')
    expect(failureReceipt('坏了').kind).toBe('error')
    expect(pendingReceipt('/aha 开场').kind).toBe('success')
    expect(notTavernModeReceipt().kind).toBe('success')
  })

  it('措辞带分隔符', async () => {
    const t = await load('plain')
    const text = dispatchReceipt(t, 'unavailable', { label: '/aha 朗读' }).text
    expect(text).toContain('/aha 朗读：')
    expect(text).not.toContain('尚未提供')
    expect(text).toContain('酒馆:单聊')
    expect(dispatchReceipt(t, 'meaningless', { label: '/aha 记忆' }).text).toContain('/aha 记忆：')
    expect(pendingReceipt('/aha 开场').text).toBe('/aha 开场：尚未接上。')
  })

  it('未知、空', () => {
    const u = unknownReceipt('跳舞', subs).text
    expect(u).toContain('跳舞')
    expect(u).toContain('启动')
    expect(u).toContain('card')
    expect(emptyReceipt(subs).text).toContain('角色')
  })
})
