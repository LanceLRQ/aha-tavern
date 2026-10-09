import { describe, expect, it, vi } from 'vitest'
import type { HostAgent } from '../../../src/shell/context'
import { SessionSections, type SectionPlan } from '../../../src/shell/sections'

const log = { debug: vi.fn(), warn: vi.fn() }
const agent = (id = 's1'): HostAgent => ({ id, ctx: {} })
const text = (t: string): (() => Promise<SectionPlan>) => async () => ({ kind: 'text', text: t })

describe('SessionSections', () => {
  it('ensure 每会话只做一次；refresh 换段并撤掉旧段', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const s = new SessionSections(log, register)
    await s.ensure(agent(), text('A'))
    await s.ensure(agent(), text('B'))
    expect(register).toHaveBeenCalledTimes(1)
    await s.refresh(agent(), text('C'))
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenLastCalledWith(expect.anything(), 'C')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(s.has('s1')).toBe(true)
  })
  it('wait 不记账可重试；skip 记账不再规划', async () => {
    const register = vi.fn(() => vi.fn())
    const s = new SessionSections(log, register)
    const plan = vi.fn<() => Promise<SectionPlan>>().mockResolvedValueOnce({ kind: 'wait' }).mockResolvedValueOnce({ kind: 'skip' })
    await s.ensure(agent(), plan)
    await s.ensure(agent(), plan)
    await s.ensure(agent(), plan)
    expect(plan).toHaveBeenCalledTimes(2)
    expect(register).not.toHaveBeenCalled()
  })
  it('新段注册失败：旧段原样放回；invalidate 后 ensure 重新规划', async () => {
    const register = vi.fn<(a: HostAgent, t: string) => () => void>()
    register.mockReturnValueOnce(vi.fn())
    const s = new SessionSections(log, register)
    await s.ensure(agent(), text('A'))
    register.mockImplementationOnce(() => { throw new Error('boom') })
    register.mockReturnValueOnce(vi.fn())
    await expect(s.refresh(agent(), text('B'))).rejects.toThrow('boom')
    expect(register).toHaveBeenLastCalledWith(expect.anything(), 'A')
    s.invalidate('s1')
    register.mockReturnValue(vi.fn())
    await s.ensure(agent(), text('C'))
    expect(register).toHaveBeenLastCalledWith(expect.anything(), 'C')
  })
  it('forget 后进行中的注册放弃，不泄漏', async () => {
    const register = vi.fn(() => vi.fn())
    const s = new SessionSections(log, register)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const p = s.ensure(agent(), async () => { await gate; return { kind: 'text', text: 'A' } })
    s.forget('s1')
    release()
    await p
    expect(register).not.toHaveBeenCalled()
    expect(s.has('s1')).toBe(false)
  })
  it('temporary：注册但不记账，下次 ensure 重新规划；文字相同不重复注册', async () => {
    const register = vi.fn(() => vi.fn())
    const s = new SessionSections(log, register)
    const tmp: SectionPlan = { kind: 'text', text: 'T', temporary: true }
    await s.ensure(agent(), async () => tmp)
    await s.ensure(agent(), async () => tmp)
    expect(register).toHaveBeenCalledTimes(1)
    await s.ensure(agent(), text('F'))
    expect(register).toHaveBeenCalledTimes(2)
    await s.ensure(agent(), text('G'))
    expect(register).toHaveBeenCalledTimes(2)
  })

})
