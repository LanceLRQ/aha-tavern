import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { DEFAULTS } from '../../../src/config'
import { listCharacters, saveCharacter } from '../../../src/core/card'
import { createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import type { AskFn } from '../../../src/shell/confirm'
import { handleCommand, parseSubcommand } from '../../../src/shell/commands'
import { buildContext, type HostAgent } from '../../../src/shell/context'
import { doctorLine, readonlyReceipt } from '../../../src/shell/receipts'
import type { Runtime } from '../../../src/shell/runtime'
import { collectFacts } from '../../../src/shell/setup'
import { renderFacts } from '../../../src/shell/setup-prompt'
import { registerSetupTools } from '../../../src/shell/setup-tools'
import { isReadonly, openResolved, READONLY_TOOL_MESSAGE, readonlyToolMessage } from '../../../src/shell/writable'

const builtinDir = path.resolve(__dirname, '../../../themes')
let theme: Theme
let dir: string
beforeEach(async () => {
  theme = (await loadTheme({ name: 'plain', builtinDir })).theme
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-ro-'))
  await createTavern(dir, { name: 't', id: 't_1' })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const setVersion = (v: number) => fs.writeFile(path.join(dir, 'aha-tavern.yaml'), YAML.stringify({ version: v, id: 't_1', name: 't' }))
const rtOf = (): Runtime => ({
  config: { ...DEFAULTS, mode: 'setup', registryPath: path.join(dir, '.reg.yaml') },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  builtinThemeDir: builtinDir, tools: () => undefined, theme: async () => theme, handlers: {},
}) as Runtime
const agent: HostAgent = { id: 's1', ctx: {}, session: { header: { cwd: '' } } }
const agentAt = (): HostAgent => ({ id: 's1', ctx: {}, session: { header: { cwd: dir } } })
const services = { agentPresets: { composedPreset: () => 'tavern-setup' } }

describe('数据版本检查', () => {
  it('当前版本可写；版本过新只读', async () => {
    expect(isReadonly(await openResolved(dir))).toBe(false)
    await setVersion(99)
    expect(isReadonly(await openResolved(dir))).toBe(true)
    expect(await readonlyToolMessage(dir)).toBe(READONLY_TOOL_MESSAGE)
  })

  it('版本较旧但迁移失败：按只读处理并记日志', async () => {
    await setVersion(0)
    const log = { warn: vi.fn() }
    const info = await openResolved(dir, log)
    expect(info.access).toBe('readonly')
    expect(log.warn).toHaveBeenCalled()
  })

  it('buildContext 把最终的 access 带在 tavern 上', async () => {
    const ag = { ...agent, session: { header: { cwd: dir } } }
    expect((await buildContext(ag, services)).tavern?.access).toBe('readwrite')
    await setVersion(99)
    expect((await buildContext(ag, services)).tavern?.access).toBe('readonly')
  })
})

describe('命令入口', () => {
  it('只读：除自检外的命令不执行，回一行经主题取词的回执', async () => {
    await setVersion(99)
    const rt = rtOf()
    const h = vi.fn()
    rt.handlers.card = h
    rt.handlers.doctor = () => ({ kind: 'success', text: 'ok' })
    const r = await handleCommand(rt, services, agentAt(), parseSubcommand('建卡'), '/aha 建卡')
    expect(h).not.toHaveBeenCalled()
    expect(r).toEqual(readonlyReceipt(theme))
    expect(r.text).toContain('数据比插件新')
    expect((await handleCommand(rt, services, agentAt(), parseSubcommand('自检'), '/aha 自检')).text).toBe('ok')
  })

  it('可写时照常执行', async () => {
    const rt = rtOf()
    const h = vi.fn(() => ({ kind: 'success' as const, text: '好' }))
    rt.handlers.card = h
    await handleCommand(rt, services, agentAt(), parseSubcommand('建卡'), '/aha 建卡')
    expect(h).toHaveBeenCalled()
  })

  it('自检状态行标明只读；提示词状态事实带只读标记', async () => {
    expect(doctorLine(theme, { mode: 'setup', tavernDir: '/t', outsideReason: null, webSearch: 'unknown', readonly: true }))
      .toContain('只读（数据版本较新）')
    expect(doctorLine(theme, { mode: 'setup', tavernDir: '/t', outsideReason: null, webSearch: 'unknown' })).not.toContain('只读')
    await setVersion(99)
    const ag = agentAt()
    const cc = await buildContext(ag, services)
    const facts = await collectFacts(rtOf(), ag, cc)
    expect(facts.readonly).toBe(true)
    expect(renderFacts(facts)).toContain('read-only')
  })
})

describe('写盘工具', () => {
  async function setup(ask: AskFn) {
    const defs: Record<string, { execute(a: unknown, e: unknown): Promise<string> }> = {}
    const ctx = { tools: { register: (d: { name: string }) => { defs[d.name] = d as never } } }
    const onSaved = vi.fn(async () => {})
    registerSetupTools(ctx as never, rtOf(), onSaved, () => ask)
    return { defs, onSaved, exec: { agent: agentAt() } }
  }

  it('只读：所有写盘工具返回固定说明，不弹卡片、不写盘；只读工具照常', async () => {
    const a = await saveCharacter(dir, { name: '白狐', persona: 'x' })
    await setVersion(99)
    const ask = vi.fn<AskFn>(async () => ({ answers: [{ id: 'confirm', selected: ['保存'] }] }))
    const { defs, onSaved, exec } = await setup(ask)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['aha_save_card', { name: '新', persona: 'p' }],
      ['aha_save_card', { id: a.card.id, persona: 'q' }],
      ['aha_set_relation', { id: a.card.id, text: '老板' }],
      ['aha_save_profile', { text: '我' }],
      ['aha_save_world', { text: '界' }],
      ['aha_rewrite_memory', { id: a.card.id, address: 'x' }],
    ]
    for (const [n, args] of calls) expect(await defs[n]!.execute(args, exec)).toBe(READONLY_TOOL_MESSAGE)
    expect(ask).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect((await listCharacters(dir)).length).toBe(1)
    await expect(fs.stat(path.join(dir, 'me.md'))).rejects.toThrow()
    expect(await defs.aha_list_characters!.execute({}, exec)).toContain('白狐')
    expect(await defs.aha_read_card!.execute({ id: a.card.id }, exec)).toContain('白狐')
    expect(await defs.aha_read_memory!.execute({ id: a.card.id }, exec)).toContain('memory of')
  })
})
