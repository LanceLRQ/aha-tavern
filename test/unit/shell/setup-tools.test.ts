import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTavern } from '../../../src/core/tavern'
import { DEFAULTS } from '../../../src/config'
import type { HostAgent } from '../../../src/shell/context'
import type { Runtime } from '../../../src/shell/runtime'
import { NOT_TAVERN, registerSetupTools, saveProfileText, saveWorldText } from '../../../src/shell/setup-tools'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-setup-tools-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('保存主角档案', () => {
  it('写盘并返回字数', async () => {
    await createTavern(dir, { name: 't' })
    const r = await saveProfileText(dir, '我是无名客', 100)
    expect(r).toEqual({ ok: true, message: 'profile saved (5 chars)' })
    expect(await fs.readFile(path.join(dir, 'me.md'), 'utf8')).toBe('我是无名客')
  })

  it('空文本、非字符串不写盘', async () => {
    await createTavern(dir, { name: 't' })
    expect((await saveProfileText(dir, '   ', 100)).ok).toBe(false)
    const r = await saveProfileText(dir, 123, 100)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('must be a string')
    expect((await saveProfileText(dir, undefined, 100)).ok).toBe(false)
    await expect(fs.stat(path.join(dir, 'me.md'))).rejects.toThrow()
  })

  it('超上限：拒绝并给出当前字数与上限', async () => {
    await createTavern(dir, { name: 't' })
    const r = await saveProfileText(dir, 'a'.repeat(11), 10)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('11')
    expect(r.message).toContain('10')
    await expect(fs.stat(path.join(dir, 'me.md'))).rejects.toThrow()
  })

  it('目录不存在时返回失败说明而不抛异常', async () => {
    const r = await saveProfileText(path.join(dir, 'nope', 'x'), 'abc', 100)
    expect(typeof r.message).toBe('string')
  })
})

describe('保存世界观', () => {
  it('未超预算', async () => {
    await createTavern(dir, { name: 't' })
    expect((await saveWorldText(dir, 'abcde', 10)).message).toBe('world saved (5 chars), budget 10')
  })

  it('超预算但未超上限：保存并提醒', async () => {
    await createTavern(dir, { name: 't' })
    const r = await saveWorldText(dir, 'a'.repeat(12), 10)
    expect(r).toEqual({ ok: true, message: 'world saved (12 chars), over budget 10 — suggest trimming' })
  })

  it('超过预算的 3 倍：拒绝', async () => {
    await createTavern(dir, { name: 't' })
    const r = await saveWorldText(dir, 'a'.repeat(31), 10)
    expect(r.ok).toBe(false)
    await expect(fs.stat(path.join(dir, 'world.md'))).rejects.toThrow()
  })

  it('空文本、非字符串', async () => {
    await createTavern(dir, { name: 't' })
    expect((await saveWorldText(dir, '', 10)).ok).toBe(false)
    expect((await saveWorldText(dir, {}, 10)).ok).toBe(false)
  })
})

describe('工具注册与执行', () => {
  function setup() {
    const defs: Record<string, { execute(a: unknown, e: unknown): Promise<string> }> = {}
    const ctx = { tools: { register: (d: { name: string }) => { defs[d.name] = d as never } } }
    const rt = {
      config: { ...DEFAULTS, mode: 'setup' as const },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Runtime
    const onSaved = vi.fn(async () => {})
    registerSetupTools(ctx as never, rt, onSaved)
    return { defs, onSaved }
  }
  const agentAt = (cwd: string): HostAgent => ({ id: 's', ctx: {}, session: { header: { cwd } } })

  it('非酒馆工作区：失败说明，不写盘、不刷新', async () => {
    const { defs, onSaved } = setup()
    const r = await defs.aha_save_profile!.execute({ text: 'x' }, { agent: agentAt(dir) })
    expect(r).toBe(NOT_TAVERN)
    expect(onSaved).not.toHaveBeenCalled()
    expect(await defs.aha_save_world!.execute({ text: 'x' }, {})).toBe(NOT_TAVERN)
  })

  it('保存成功后刷新该会话的提示词段；失败不刷新', async () => {
    await createTavern(dir, { name: 't' })
    const { defs, onSaved } = setup()
    const a = agentAt(dir)
    expect(await defs.aha_save_profile!.execute({ text: 'hi' }, { agent: a })).toBe('profile saved (2 chars)')
    expect(onSaved).toHaveBeenCalledWith(a)
    await defs.aha_save_world!.execute({ text: '  ' }, { agent: a })
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('刷新抛错不影响工具返回', async () => {
    await createTavern(dir, { name: 't' })
    const { defs, onSaved } = setup()
    onSaved.mockRejectedValueOnce(new Error('x'))
    expect(await defs.aha_save_world!.execute({ text: 'hi' }, { agent: agentAt(dir) })).toContain('world saved')
  })
})
