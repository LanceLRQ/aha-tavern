import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { AhaError } from '../../../src/core/errors'
import { handleCommand, parseSubcommand, type ParsedSubcommand } from '../../../src/shell/commands'
import type { HostAgent, HostServices } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { DEFAULTS, type TavernMode } from '../../../src/config'

const builtinDir = path.resolve(__dirname, '../../../themes')

function fakeRuntime(mode: TavernMode, theme: Promise<Theme>): Runtime {
  return {
    config: { ...DEFAULTS, mode },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    builtinThemeDir: builtinDir,
    tools: () => undefined,
    theme: () => theme,
    handlers: {},
  }
}
const themeOf = async (name: string): Promise<Theme> => (await loadTheme({ name, builtinDir })).theme
const services = (preset: string | undefined): HostServices => ({
  agentPresets: { composedPreset: () => preset },
})
const agent = (cwd?: string): HostAgent => ({ id: 's1', ctx: {}, session: { header: cwd ? { cwd } : {} } })
const cmd = (s: string): ParsedSubcommand => parseSubcommand(s)

describe('handleCommand', () => {
  it('未知子命令：error', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('跳舞'), '/aha 跳舞')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('跳舞')
  })

  it('空子命令：error', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    expect((await handleCommand(rt, services('tavern-setup'), agent(), cmd(''), '/aha')).kind).toBe('error')
  })

  it('取不到工作区：门外，先开店的回执为 success', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('建卡'), '/aha 建卡')
    expect(r.kind).toBe('success')
    expect(r.text).toContain('工作区')
  })

  it('分流为不执行：success 指引，处理函数不被调用', async () => {
    const rt = fakeRuntime('chat', themeOf('fools'))
    const h = vi.fn()
    rt.handlers.card = h
    const r = await handleCommand(rt, services('tavern-chat'), agent(), cmd('建卡'), '/aha 建卡')
    expect(r.kind).toBe('success')
    expect(r.text).toContain('剧团长')
    expect(h).not.toHaveBeenCalled()
  })

  it('处理函数不存在：占位 success', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('开店'), '/aha 开店')
    expect(r).toEqual({ kind: 'success', text: '/aha 开店：尚未接上。' })
  })

  it('处理函数被调用并拿到参数', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    rt.handlers.init = vi.fn(() => ({ kind: 'success' as const, text: '好' }))
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('init  x y'), '/aha init')
    expect(r.text).toBe('好')
    expect(rt.handlers.init).toHaveBeenCalledWith(expect.objectContaining({ args: 'x y', label: '/aha init' }))
  })

  it('处理函数抛 AhaError：error，带其消息', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    rt.handlers.init = () => { throw new AhaError('already-tavern', '已经开过了') }
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('开店'), '/aha 开店')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('已经开过了')
  })

  it('处理函数抛普通异常：error，并记日志', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    rt.handlers.init = async () => { throw new Error('boom') }
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('开店'), '/aha 开店')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('boom')
    expect(rt.log.error).toHaveBeenCalled()
  })

  it('主题加载失败：error', async () => {
    const failing = Promise.reject(new Error('主题坏了'))
    failing.catch(() => {})
    const rt = fakeRuntime('setup', failing)
    const r = await handleCommand(rt, services('tavern-setup'), agent(), cmd('开店'), '/aha 开店')
    expect(r.kind).toBe('error')
    expect(r.text).toContain('主题坏了')
  })

  it('实际模式映射不到：success，说明不在酒馆模式里', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    const r = await handleCommand(rt, services('standard'), agent(), cmd('开店'), '/aha 开店')
    expect(r).toEqual({ kind: 'success', text: '当前不在酒馆的模式里。' })
  })

  it('实际模式与实例不一致：静默，只记 debug', async () => {
    const rt = fakeRuntime('setup', themeOf('plain'))
    const h = vi.fn()
    rt.handlers.init = h
    const r = await handleCommand(rt, services('tavern-chat'), agent(), cmd('开店'), '/aha 开店')
    expect(r).toEqual({ kind: 'success' })
    expect(h).not.toHaveBeenCalled()
    expect(rt.log.debug).toHaveBeenCalled()
  })
})
