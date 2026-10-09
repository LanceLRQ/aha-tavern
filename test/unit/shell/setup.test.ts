import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../../../src/config'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { isTavern } from '../../../src/core/tavern'
import type { CommandContext, HostAgent, Invocation } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { initHandler, SetupSections } from '../../../src/shell/setup'
import type { SetupFacts } from '../../../src/shell/setup-prompt'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let tmp: string
beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-setup-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const rtOf = (): Runtime => ({
  config: { ...DEFAULTS, mode: 'setup', registryPath: path.join(tmp, 'reg.yaml') },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  builtinThemeDir: builtinDir,
  tools: () => undefined,
  theme: async () => theme,
  handlers: {},
}) as Runtime

const facts: SetupFacts = {
  place: { kind: 'outside', reason: 'not-tavern' }, otherTaverns: [], characters: [], brokenCards: [],
  profile: { empty: true, length: 0 }, world: { empty: true, length: 0, budget: 4000 }, webSearch: 'unknown',
}
const ctxOf = (mode: 'setup' | 'chat' | null): CommandContext => ({
  mode, cwd: '/w', sessionId: 's1', tavern: null, state: 'outside', outsideReason: 'not-tavern', record: null,
})
const agent = (id = 's1'): HostAgent => ({ id, ctx: {} })
const svc = { agentPresets: { composedPreset: () => 'tavern-setup' } }

describe('SetupSections', () => {
  it('apply 失败后不记账，可以重试', async () => {
    const register = vi.fn(() => vi.fn())
    const collect = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(facts)
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf('setup'), collect, register })
    await expect(s.ensure(agent(), svc, theme)).rejects.toThrow('boom')
    expect(s.has('s1')).toBe(false)
    await s.ensure(agent(), svc, theme)
    expect(register).toHaveBeenCalledTimes(1)
    await s.ensure(agent(), svc, theme)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('register 抛错同样可重试', async () => {
    const register = vi.fn().mockImplementationOnce(() => { throw new Error('dup') }).mockReturnValue(vi.fn())
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf('setup'), collect: async () => facts, register })
    await expect(s.ensure(agent(), svc, theme)).rejects.toThrow('dup')
    await s.ensure(agent(), svc, theme)
    expect(s.has('s1')).toBe(true)
  })

  it('取不到实际模式：不注册也不记账；非筹备模式记账但不注册', async () => {
    const register = vi.fn(() => vi.fn())
    let mode: 'setup' | 'chat' | null = null
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf(mode), collect: async () => facts, register })
    await s.ensure(agent(), svc, theme)
    expect(register).not.toHaveBeenCalled()
    mode = 'setup'
    await s.ensure(agent(), svc, theme)
    expect(register).toHaveBeenCalledTimes(1)
    mode = 'chat'
    await s.ensure(agent('s2'), svc, theme)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('forget 与进行中的 apply 竞态：不注册、不记账', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const register = vi.fn(() => vi.fn())
    const s = new SetupSections(rtOf(), 'G', {
      loadContext: async () => ctxOf('setup'),
      collect: async () => { await gate; return facts },
      register,
    })
    const p = s.ensure(agent(), svc, theme)
    await new Promise((r) => setTimeout(r, 5))
    s.forget('s1')
    release()
    await p
    expect(register).not.toHaveBeenCalled()
    expect(s.has('s1')).toBe(false)
    // 同编号的会话恢复后可以重新注册
    await s.ensure(agent(), svc, theme)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('入队后销毁：排队中的 ensure / refresh 不注册不记账；同编号恢复后可注册', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const register = vi.fn(() => vi.fn())
    let first = true
    const s = new SetupSections(rtOf(), 'G', {
      loadContext: async () => ctxOf('setup'),
      collect: async () => { if (first) { first = false; await gate } return facts },
      register,
    })
    const p1 = s.ensure(agent(), svc, theme)
    await new Promise((r) => setTimeout(r, 5))
    const p2 = s.refresh(agent(), svc, theme)
    const p3 = s.ensure(agent(), svc, theme)
    s.forget('s1')
    release()
    await Promise.all([p1, p2, p3])
    expect(register).not.toHaveBeenCalled()
    expect(s.has('s1')).toBe(false)
    await s.ensure(agent(), svc, theme)
    expect(register).toHaveBeenCalledTimes(1)
    expect(s.has('s1')).toBe(true)
  })

  it('refresh 注册新段失败：旧段放回，保持已注册', async () => {
    const disposeOld = vi.fn()
    const registered: string[] = []
    let fail = false
    const register = vi.fn((_a: HostAgent, text: string) => {
      if (fail && !registered.includes(text + '#restore') && register.mock.calls.length === 2) throw new Error('dup')
      registered.push(text)
      return disposeOld
    })
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf('setup'), collect: async () => facts, register })
    await s.ensure(agent(), svc, theme)
    fail = true
    await expect(s.refresh(agent(), svc, theme)).rejects.toThrow('dup')
    expect(register).toHaveBeenCalledTimes(3) // 初次、失败的新段、放回旧段
    expect(s.has('s1')).toBe(true)
    await s.ensure(agent(), svc, theme)
    expect(register).toHaveBeenCalledTimes(3)
  })

  it('refresh 新段与旧段都注册不上：清掉记账，下一次 ensure 恢复', async () => {
    let n = 0
    const register = vi.fn(() => {
      n++
      if (n === 2 || n === 3) throw new Error('boom')
      return vi.fn()
    })
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf('setup'), collect: async () => facts, register })
    await s.ensure(agent(), svc, theme)
    await expect(s.refresh(agent(), svc, theme)).rejects.toThrow('boom')
    expect(s.has('s1')).toBe(false)
    await s.ensure(agent(), svc, theme)
    expect(s.has('s1')).toBe(true)
    expect(register).toHaveBeenCalledTimes(4)
  })

  it('refresh 收集失败：旧段原样保留', async () => {
    const dispose = vi.fn()
    const collect = vi.fn().mockResolvedValueOnce(facts).mockRejectedValueOnce(new Error('x'))
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf('setup'), collect, register: () => dispose })
    await s.ensure(agent(), svc, theme)
    await expect(s.refresh(agent(), svc, theme)).rejects.toThrow('x')
    expect(dispose).not.toHaveBeenCalled()
    expect(s.has('s1')).toBe(true)
  })

  it('已知上下文模式为空：按筹备处理', async () => {
    const register = vi.fn(() => vi.fn())
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf(null), collect: async () => facts, register })
    await s.refresh(agent(), svc, theme, ctxOf(null))
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('refresh 撤销旧段并注册新段；forget 撤销', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const s = new SetupSections(rtOf(), 'G', { loadContext: async () => ctxOf('setup'), collect: async () => facts, register })
    await s.ensure(agent(), svc, theme)
    await s.refresh(agent(), svc, theme)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(2)
    s.forget('s1')
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('refresh 给了已知上下文就不再取', async () => {
    const loadContext = vi.fn(async () => ctxOf(null))
    const register = vi.fn(() => vi.fn())
    const s = new SetupSections(rtOf(), 'G', { loadContext, collect: async () => facts, register })
    await s.refresh(agent(), svc, theme, ctxOf('setup'))
    expect(loadContext).not.toHaveBeenCalled()
    expect(register).toHaveBeenCalledTimes(1)
  })
})

describe('initHandler', () => {
  const invOf = (cwd: string, sections: SetupSections, steer: Invocation['steer']): Invocation => ({
    agent: { id: 's1', ctx: {}, session: { header: { cwd } } },
    services: svc, rt: rtOf(), theme, steer, args: '', label: '/aha 开店',
    context: { mode: 'setup', cwd, sessionId: 's1', tavern: null, state: 'outside', outsideReason: 'not-tavern', record: null },
  } as Invocation)

  it('后半段失败：盘上已是酒馆，回执说明引导没发出', async () => {
    const ws = path.join(tmp, '老街')
    await fs.mkdir(ws)
    const sections = { refresh: vi.fn().mockRejectedValue(new Error('x')) } as unknown as SetupSections
    const inv = invOf(ws, sections, vi.fn())
    const r = await initHandler(sections)(inv)
    expect(await isTavern(ws)).toBe(true)
    expect(r.kind).toBe('success')
    expect(r.text).toContain('已开张'.replace('开张', '开店'))
    expect(r.text).toContain('引导没发出')
    expect(r.text).toContain('掌柜')
    expect(inv.rt.log.error).toHaveBeenCalled()
  })

  it('成功：用已知上下文刷新段，steer 一次，回执一行', async () => {
    const ws = path.join(tmp, 'w')
    await fs.mkdir(ws)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const sections = { refresh } as unknown as SetupSections
    const steer = vi.fn()
    const r = await initHandler(sections)(invOf(ws, sections, steer))
    expect(steer).toHaveBeenCalledTimes(1)
    const known = refresh.mock.calls[0]![3] as CommandContext
    expect(known.tavern?.dir).toBe(ws)
    expect(known.mode).toBe('setup')
    expect(r.text).not.toContain('引导没发出')
  })

  it('没有工作区：先选工作区', async () => {
    const sections = {} as SetupSections
    const inv = invOf('/x', sections, vi.fn())
    const r = await initHandler(sections)({ ...inv, context: { ...inv.context, cwd: undefined } })
    expect(r.text).toContain('工作区')
  })
})
