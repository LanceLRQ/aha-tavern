import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChat, readRecords } from '../../../src/core/chat'
import { createTavern } from '../../../src/core/tavern'
import {
  AttemptCollector, TranscriptRecorder, userRecordsOf, type ChatTarget,
} from '../../../src/shell/transcript'

const textBlock = (index: number, text: string) => ({ type: 'chunk', chunk: { type: 'block-end', index, block: { type: 'text', text } } }) as any
const reasoningBlock = (index: number, text: string) => ({ type: 'chunk', chunk: { type: 'block-end', index, block: { type: 'reasoning', text } } }) as any
const deltaText = (text: string) => ({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text } }) as any
const START = { type: 'start' } as any
const END = { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } } as any
const ATTEMPT_END = { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/attempt' } } as any
const ABANDONED = { type: 'end', outcome: { kind: 'abandoned' } } as any
const userMsg = (id: string, text: string, kind = 'user') =>
  ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind } }) as any

describe('AttemptCollector', () => {
  it('多个文本块合并为一条，在提交结束帧时给出', () => {
    const c = new AttemptCollector()
    expect(c.feed(START)).toBeNull()
    expect(c.feed(textBlock(0, '你好。'))).toBeNull()
    expect(c.feed(textBlock(2, '请坐。'))).toBeNull()
    expect(c.feed(END)).toBe('你好。\n\n请坐。')
  })
  it('思考块与文本分片不入档', () => {
    const c = new AttemptCollector()
    c.feed(START)
    c.feed(reasoningBlock(0, '内心想法'))
    c.feed(deltaText('分片'))
    c.feed(textBlock(1, '台词'))
    expect(c.feed(END)).toBe('台词')
  })
  it('assistant/attempt（失败、重试）不产出，重试成功的那次才产出', () => {
    const c = new AttemptCollector()
    c.feed(START)
    c.feed(textBlock(0, '失败那次'))
    expect(c.feed(ATTEMPT_END)).toBeNull()
    c.feed(START)
    c.feed(textBlock(0, '重试成功'))
    expect(c.feed(END)).toBe('重试成功')
  })
  it('只有思考时不产出；放弃的尝试丢弃；开始帧清空上一次残留', () => {
    const c = new AttemptCollector()
    c.feed(START)
    c.feed(reasoningBlock(0, '想'))
    expect(c.feed(END)).toBeNull()
    c.feed(START)
    c.feed(textBlock(0, '半截'))
    expect(c.feed(ABANDONED)).toBeNull()
    c.feed(START)
    c.feed(textBlock(0, '新的'))
    expect(c.feed(END)).toBe('新的')
  })
})

describe('userRecordsOf', () => {
  it('只取 user 来源，按编号去重', () => {
    const seen = new Set<string>()
    const msgs = [userMsg('m1', '你好'), userMsg('m2', '开场', 'aha-tavern'), userMsg('m3', '再见')]
    expect(userRecordsOf(msgs, seen).map((r) => r.text)).toEqual(['你好', '再见'])
    expect(userRecordsOf(msgs, seen)).toEqual([])
  })
  it('没有文字的消息跳过，多个文本块拼接', () => {
    const m = { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } as any
    const e = { id: 'm2', role: 'user', source: { kind: 'user' }, content: [] } as any
    expect(userRecordsOf([m, e], new Set()).map((r) => r.text)).toEqual(['a\nb'])
  })
})

describe('TranscriptRecorder', () => {
  let dir: string
  let target: ChatTarget
  const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  const agent = { id: 's1' } as any
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-transcript-'))
    await createTavern(dir, { name: '甲', id: 't_1' })
    const chat = await createChat(dir, { kind: 'chat', name: '白', participants: ['c_1'], sessionId: 's1', now: new Date() })
    target = { tavernDir: dir, chatId: chat.id, characterId: 'c_1' }
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const rows = async () => (await readRecords(dir, target.chatId)).records.map((r) => [r.type, r.speaker, r.text])

  it('用户的话先于同一轮角色的回复，多来回保序', async () => {
    const r = new TranscriptRecorder({ resolve: async () => target, log: log() })
    r.onStep(agent, [userMsg('m1', '一')])
    r.onFrame(agent, START); r.onFrame(agent, textBlock(0, 'A')); r.onFrame(agent, END)
    r.onStep(agent, [userMsg('m2', '二')])
    r.onFrame(agent, START); r.onFrame(agent, textBlock(0, 'B')); r.onFrame(agent, END)
    await r.drain(agent.id)
    expect(await rows()).toEqual([
      ['user', 'user', '一'], ['character', 'c_1', 'A'], ['user', 'user', '二'], ['character', 'c_1', 'B'],
    ])
  })
  it('同一条用户消息重复进入不重复写；非 user 来源不写', async () => {
    const r = new TranscriptRecorder({ resolve: async () => target, log: log() })
    r.onStep(agent, [userMsg('m1', '一'), userMsg('n1', '开场指令', 'aha-tavern')])
    r.onStep(agent, [userMsg('m1', '一')])
    await r.drain(agent.id)
    expect(await rows()).toEqual([['user', 'user', '一']])
  })
  it('非聊天中不写', async () => {
    const r = new TranscriptRecorder({ resolve: async () => null, log: log() })
    r.onStep(agent, [userMsg('m1', '一')])
    r.onFrame(agent, START); r.onFrame(agent, textBlock(0, 'A')); r.onFrame(agent, END)
    await r.drain(agent.id)
    await expect(fs.access(path.join(dir, 'chats'))).resolves.toBeUndefined()
    expect((await readRecords(dir, target.chatId)).records).toEqual([])
  })
  it('写盘失败不抛出，同类错误只提示一次，后续恢复照常写', async () => {
    const l = log()
    let fail = true
    const append = vi.fn(async (...a: Parameters<typeof import('../../../src/core/chat').appendRecord>) => {
      if (fail) throw new Error('disk full')
      return (await import('../../../src/core/chat')).appendRecord(...a)
    })
    const r = new TranscriptRecorder({ resolve: async () => target, log: l, append })
    expect(() => r.onStep(agent, [userMsg('m1', '一'), userMsg('m2', '二')])).not.toThrow()
    await r.drain(agent.id)
    expect(l.warn).toHaveBeenCalledTimes(1)
    fail = false
    r.onStep(agent, [userMsg('m3', '三')])
    await r.drain(agent.id)
    expect(await rows()).toEqual([['user', 'user', '三']])
  })
  it('解析会话抛错也不外泄；forget 后状态清空', async () => {
    const l = log()
    const r = new TranscriptRecorder({ resolve: async () => { throw new Error('boom') }, log: l })
    r.onStep(agent, [userMsg('m1', '一')])
    await r.drain(agent.id)
    expect(l.warn).toHaveBeenCalled()
    r.forget(agent.id)
  })
  it('事件到达时还在选角、队列执行前变成聊天中：不入档', async () => {
    let chatting = false
    const r = new TranscriptRecorder({ resolve: async () => (chatting ? target : null), log: log() })
    r.onStep(agent, [userMsg('m1', '选角的话')])
    r.onFrame(agent, START); r.onFrame(agent, textBlock(0, '掌柜的话')); r.onFrame(agent, END)
    chatting = true
    await r.drain(agent.id)
    expect(await rows()).toEqual([])
    r.onStep(agent, [userMsg('m2', '聊天的话')])
    await r.drain(agent.id)
    expect(await rows()).toEqual([['user', 'user', '聊天的话']])
  })
  it('每写一条记一行 debug，不含内容', async () => {
    const l = log()
    const r = new TranscriptRecorder({ resolve: async () => target, log: l })
    r.onStep(agent, [userMsg('m1', '秘密内容')])
    await r.drain(agent.id)
    expect(l.debug).toHaveBeenCalledTimes(1)
    expect(String(l.debug.mock.calls[0]![0])).not.toContain('秘密内容')
  })
})
