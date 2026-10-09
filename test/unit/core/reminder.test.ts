import { describe, expect, it } from 'vitest'
import { ReviewReminder } from '../../../src/core/reminder'

const feed = (r: ReviewReminder, s: string, n: number): boolean[] => Array.from({ length: n }, () => r.onUserMessage(s))

describe('ReviewReminder', () => {
  it('未到阈值不提醒', () => {
    expect(feed(new ReviewReminder(3), 's', 2)).toEqual([false, false])
  })
  it('到阈值提醒一次并清零，之后重新计数', () => {
    expect(feed(new ReviewReminder(3), 's', 7)).toEqual([false, false, true, false, false, true, false])
  })
  it('中途有记忆写入则重新计数', () => {
    const r = new ReviewReminder(3)
    feed(r, 's', 2)
    r.onWrite('s')
    expect(feed(r, 's', 3)).toEqual([false, false, true])
  })
  it('阈值可配置：1 每条都提醒；小于 1 或非数字永不提醒', () => {
    expect(feed(new ReviewReminder(1), 's', 2)).toEqual([true, true])
    expect(feed(new ReviewReminder(0), 's', 5).some(Boolean)).toBe(false)
    expect(feed(new ReviewReminder(Number.NaN), 's', 5).some(Boolean)).toBe(false)
  })
  it('会话之间互不影响；forget 清掉计数', () => {
    const r = new ReviewReminder(2)
    r.onUserMessage('a')
    expect(r.onUserMessage('b')).toBe(false)
    r.forget('a')
    expect(r.onUserMessage('a')).toBe(false)
    expect(r.onUserMessage('a')).toBe(true)
  })
  it('retry：提醒没送出时，下一条用户消息再次触发', () => {
    const r = new ReviewReminder(3)
    expect(feed(r, 's', 3)).toEqual([false, false, true])
    r.retry('s')
    expect(r.onUserMessage('s')).toBe(true)
    expect(r.onUserMessage('s')).toBe(false)
  })
})
