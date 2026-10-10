import { describe, expect, it } from 'vitest'
import { changedFields, guard, isActionResult, isSaveResult, isSettingsState, isStartResult, isTestResult, isVoiceStatus } from '../../../src/client/logic'

const CALL_FAILED = { ok: true, value: { ok: false, text: '操作出错，详情见日志。' } }

describe('远程结果的形状判别', () => {
  it('插件端出错时的固定值不是状态/测试结果，判别失败而不是当成对象用', () => {
    const v = CALL_FAILED
    expect(() => guard(v, isSettingsState)).toThrow('插件端返回的内容不对')
    expect(() => guard(v, isVoiceStatus)).toThrow()
    expect(() => guard(v, isTestResult)).toThrow()
    expect(() => guard(v, isStartResult)).toThrow()
  })
  it('固定值对只要 ok/text 的调用是合法的', () => {
    expect(guard(CALL_FAILED, isActionResult)).toEqual({ ok: false, text: '操作出错，详情见日志。' })
    expect(guard(CALL_FAILED, isSaveResult).ok).toBe(false)
  })
  it('通信失败（ok:false）也抛出中文说明', () => {
    expect(() => guard({ ok: false, error: 'x' }, isActionResult)).toThrow('和插件通信失败')
    expect(() => guard(null, isActionResult)).toThrow('和插件通信失败')
  })
  it('合法形状通过', () => {
    expect(guard({ ok: true, value: { ok: true, lines: [{ mark: '✓', text: 'a' }] } }, isTestResult).lines).toHaveLength(1)
    expect(guard({ ok: true, value: { state: 'stopped', text: 't', canStart: true, canStop: false } }, isVoiceStatus).state).toBe('stopped')
    expect(guard({ ok: true, value: { result: 'done', ok: true, text: 't' } }, isStartResult).result).toBe('done')
  })
  it('lines 里有坏项也判不通过', () => {
    expect(() => guard({ ok: true, value: { ok: true, lines: [{ mark: 1 }] } }, isTestResult)).toThrow()
  })
})

describe('changedFields', () => {
  it('只返回与已保存值不同的字段', () => {
    expect(changedFields({ a: '1', b: '2', c: '' }, { a: '1', b: '3', c: '' })).toEqual({ b: '2' })
  })
  it('清空一个字段（空串）也算改动', () => {
    expect(changedFields({ a: '' }, { a: 'x' })).toEqual({ a: '' })
  })
  it('没有改动返回空对象', () => {
    expect(changedFields({ a: '1' }, { a: '1' })).toEqual({})
  })
})
