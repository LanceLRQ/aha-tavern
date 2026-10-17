import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTavern } from '../../../src/core/tavern'
import { buildContext, type HostAgent } from '../../../src/shell/context'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-context-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const services = { agentPresets: { composedPreset: () => 'tavern-setup' } }
const agentAt = (cwd?: string, ctx: unknown = {}): HostAgent => ({ id: 's', ctx, session: { header: { cwd } } })

describe('会话当前工作目录', () => {
  it('通过公开服务读取当前酒馆，不受会话初始目录影响，也不缓存目录', async () => {
    const first = path.join(dir, 'first')
    const second = path.join(dir, 'second')
    await fs.mkdir(first)
    await fs.mkdir(second)
    await createTavern(first, { name: 'first' })
    await createTavern(second, { name: 'second' })
    let current = first
    const workingDirectory = { get: vi.fn(() => current) }
    const ctx = {
      get(name: string) {
        expect(this).toBe(ctx)
        expect(name).toBe('workingDirectory')
        return workingDirectory
      },
      get workingDirectory(): never { throw new Error('requires inject') },
    }
    const agent = agentAt(dir, ctx)
    expect((await buildContext(agent, services)).tavern?.dir).toBe(first)
    current = second
    const context = await buildContext(agent, services)
    expect(context.cwd).toBe(second)
    expect(context.tavern?.dir).toBe(second)
    expect(workingDirectory.get).toHaveBeenNthCalledWith(2, agent.session)
  })

  it.each([{}, { get: () => undefined }])('旧宿主没有服务时仍读取 header.cwd：%j', async (ctx) => {
    expect((await buildContext(agentAt(dir, ctx), services)).cwd).toBe(dir)
  })

  it('没有会话时不调用工作目录服务', async () => {
    const get = vi.fn(() => { throw new Error('no session') })
    const context = await buildContext({ id: 's', ctx: { get } }, services)
    expect(context.cwd).toBeUndefined()
    expect(context.outsideReason).toBe('no-workspace')
    expect(get).not.toHaveBeenCalled()
  })

  it.each(['', undefined, 123])('服务返回无效目录时不退回旧目录：%j', async (cwd) => {
    const agent = agentAt(dir, { get: () => ({ get: () => cwd }) })
    expect((await buildContext(agent, services)).cwd).toBeUndefined()
  })

  it('服务抛错时传播错误，不使用旧目录', async () => {
    const agent = agentAt(dir, { get: () => ({ get: () => { throw new Error('cwd unavailable') } }) })
    await expect(buildContext(agent, services)).rejects.toThrow('cwd unavailable')
  })

  it('服务查询抛错时传播错误', async () => {
    const agent = agentAt(dir, { get: () => { throw new Error('lookup unavailable') } })
    await expect(buildContext(agent, services)).rejects.toThrow('lookup unavailable')
  })
})
