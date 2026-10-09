import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAhaError } from '../../../src/core/errors'
import { readSession, resolveState, saveSession, type SessionRecord } from '../../../src/core/state'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-state-'))
  file = path.join(dir, '.aha', 'sessions.yaml')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const chatting: SessionRecord = { mode: 'chat', state: 'chatting', chatId: 'c1', updated: '' }
const picking: SessionRecord = { mode: 'chat', state: 'picking', updated: '' }

describe('resolveState', () => {
  it('没有工作区 -> outside / no-workspace（两种模式）', () => {
    for (const mode of ['setup', 'chat'] as const) {
      expect(resolveState({ mode, workspaceExists: false, isTavern: false })).toEqual({
        state: 'outside', reason: 'no-workspace',
      })
      // 工作区不存在时，isTavern 无意义
      expect(resolveState({ mode, workspaceExists: false, isTavern: true, stored: chatting }).reason).toBe('no-workspace')
    }
  })
  it('不是酒馆 -> outside / not-tavern', () => {
    for (const mode of ['setup', 'chat'] as const) {
      expect(resolveState({ mode, workspaceExists: true, isTavern: false, stored: chatting })).toEqual({
        state: 'outside', reason: 'not-tavern',
      })
    }
  })
  it('筹备模式是酒馆 -> preparing', () => {
    expect(resolveState({ mode: 'setup', workspaceExists: true, isTavern: true })).toEqual({ state: 'preparing' })
    expect(resolveState({ mode: 'setup', workspaceExists: true, isTavern: true, stored: chatting })).toEqual({ state: 'preparing' })
  })
  it('单聊模式：无记录/选角记录 -> picking；聊天记录 -> chatting', () => {
    const base = { mode: 'chat', workspaceExists: true, isTavern: true } as const
    expect(resolveState(base).state).toBe('picking')
    expect(resolveState({ ...base, stored: null }).state).toBe('picking')
    expect(resolveState({ ...base, stored: picking }).state).toBe('picking')
    expect(resolveState({ ...base, stored: chatting }).state).toBe('chatting')
  })
  it('其他模式留下的聊天记录不影响单聊判定', () => {
    expect(resolveState({
      mode: 'chat', workspaceExists: true, isTavern: true, stored: { ...chatting, mode: 'setup' },
    }).state).toBe('picking')
  })
})

describe('sessions.yaml 读写', () => {
  it('文件不存在 -> 查不到，不算损坏', async () => {
    expect(await readSession(file, 's1')).toEqual({ record: null, broken: false })
  })
  it('写入后可读回', async () => {
    const now = new Date('2026-01-02T03:04:05Z')
    await saveSession(file, 's1', { mode: 'chat', state: 'picking' }, now)
    const { record, broken } = await readSession(file, 's1')
    expect(broken).toBe(false)
    expect(record).toEqual({ mode: 'chat', state: 'picking', updated: now.toISOString() })
  })
  it('内容损坏 -> 查不到并标记 broken', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'sessions: [unclosed\n  : :')
    expect(await readSession(file, 's1')).toEqual({ record: null, broken: true })
    await fs.writeFile(file, 'just a string')
    expect((await readSession(file, 's1')).broken).toBe(true)
  })
  it('写入时原文件损坏：先备份再写新文件', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'sessions: [unclosed\n  : :')
    await saveSession(file, 's1', { mode: 'setup', state: 'preparing' }, new Date(1234))
    const files = await fs.readdir(path.dirname(file))
    const bak = files.find((f) => f.startsWith('sessions.yaml.broken-'))
    expect(bak).toBe('sessions.yaml.broken-1234')
    expect(await fs.readFile(path.join(path.dirname(file), bak!), 'utf8')).toContain('unclosed')
    expect((await readSession(file, 's1')).record?.state).toBe('preparing')
  })
  it('chatting 不可被改成其他状态、模式或聊天编号', async () => {
    await saveSession(file, 's1', { mode: 'chat', state: 'chatting', chatId: 'c1', characterId: 'k1' })
    const attempts = [
      { mode: 'chat', state: 'picking' },
      { mode: 'chat', state: 'outside' },
      { mode: 'setup', state: 'preparing' },
      { mode: 'chat', state: 'chatting', chatId: 'c2' },
    ] as const
    for (const a of attempts) {
      await expect(saveSession(file, 's1', a)).rejects.toSatisfy((e) => isAhaError(e, 'session-locked'))
    }
    const { record } = await readSession(file, 's1')
    expect(record).toMatchObject({ state: 'chatting', chatId: 'c1', characterId: 'k1' })
  })
  it('chatting 用相同聊天编号重写允许（刷新时间）', async () => {
    await saveSession(file, 's1', { mode: 'chat', state: 'chatting', chatId: 'c1' }, new Date(1000))
    const r = await saveSession(file, 's1', { mode: 'chat', state: 'chatting', chatId: 'c1' }, new Date(2000))
    expect(r.updated).toBe(new Date(2000).toISOString())
  })
  it('进入 chatting 必须带聊天编号；不同会话互不影响', async () => {
    await expect(saveSession(file, 's1', { mode: 'chat', state: 'chatting' })).rejects.toSatisfy((e) =>
      isAhaError(e, 'session-invalid'))
    await saveSession(file, 's1', { mode: 'chat', state: 'chatting', chatId: 'c1' })
    await saveSession(file, 's2', { mode: 'chat', state: 'picking' })
    expect((await readSession(file, 's1')).record?.state).toBe('chatting')
    expect((await readSession(file, 's2')).record?.state).toBe('picking')
  })
})
