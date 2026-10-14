// 群聊落盘接线（#kyi8、二期规格 §10）的单元测试：用户与回复的记录、场景序号、分界与旁白要求。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCharacter } from '../../../src/core/card'
import { createChat, readRecords } from '../../../src/core/chat'
import { saveSession } from '../../../src/core/state'
import { createTavern } from '../../../src/core/tavern'
import { GroupTranscriptRecorder, type GroupTarget } from '../../../src/shell/group-transcript'
import type { HostAgent } from '../../../src/shell/context'
import type { StreamFrameLike, UserMessageLike } from '../../../src/shell/transcript'

let dir: string
let chatId: string
let target: GroupTarget
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-glog-'))
  await createTavern(dir, { name: '甲', id: 't_1' })
  const c1 = (await saveCharacter(dir, { name: '白狐', persona: 'x' })).card
  const c2 = (await saveCharacter(dir, { name: '青衫', persona: 'x' })).card
  const chat = await createChat(dir, { kind: 'group', name: '群聊', participants: [c1.id, c2.id], sessionId: 's1', now: new Date() })
  chatId = chat.id
  await saveSession(path.join(dir, '.aha', 'sessions.yaml'), 's1', { mode: 'group', state: 'performing', chatId })
  target = {
    tavernDir: dir, chatId,
    known: [
      { id: c1.id, name: '白狐' },
      { id: c2.id, name: '青衫' },
    ],
    narratorLabels: ['旁白'],
  }
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const agent: HostAgent = { id: 's1', ctx: {}, session: { get header() { return { cwd: dir } } } }

const recorderOf = (t: GroupTarget | null = target) => new GroupTranscriptRecorder({ resolve: async () => t, log: { debug: vi.fn(), warn: vi.fn() } })

const userMsg = (id: string, text: string): UserMessageLike => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** 喂一轮完整的回复流，返回提交的整段文字。 */
const feedReply = (r: GroupTranscriptRecorder, text: string): void => {
  const frames: StreamFrameLike[] = [
    { type: 'start' },
    { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text', text } } },
    { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } },
  ]
  for (const f of frames) r.onFrame(agent, f)
}

const recordsOf = async () => (await readRecords(dir, chatId)).records

describe('GroupTranscriptRecorder', () => {
  it('用户的话：type user、说话人记"我"、带场景序号', async () => {
    const r = recorderOf()
    expect(r.onStep(agent, [userMsg('m1', '今天我过生日')])).toBe(1)
    await r.drain('s1')
    expect(await recordsOf()).toEqual([
      expect.objectContaining({ type: 'user', speaker: '我', text: '今天我过生日', scene: 1 }),
    ])
  })

  it('回复拆分落盘：旁白无说话人、台词带编号；点名轮的用户话照记', async () => {
    const r = recorderOf()
    r.onStep(agent, [userMsg('m1', '@白狐 你怎么看')])
    feedReply(r, '【旁白】烛火晃了晃。\n\n白狐：（想了想）挺好。\n\n青衫：我也觉得。')
    await r.drain('s1')
    expect(await recordsOf()).toEqual([
      expect.objectContaining({ type: 'user', speaker: '我', text: '@白狐 你怎么看', scene: 1 }),
      expect.objectContaining({ type: 'narrator', text: '烛火晃了晃。', scene: 1 }),
      expect.objectContaining({ type: 'character', speaker: target.known[0]!.id, text: '（想了想）挺好。', scene: 1 }),
      expect.objectContaining({ type: 'character', speaker: target.known[1]!.id, text: '我也觉得。', scene: 1 }),
    ])
  })

  it('代表用户的行：记为旁白并带越界标记', async () => {
    const r = recorderOf()
    feedReply(r, '我：我也来一口。')
    await r.drain('s1')
    expect(await recordsOf()).toEqual([
      expect.objectContaining({ type: 'narrator', text: '我也来一口。', userImpersonated: true, scene: 1 }),
    ])
  })

  it('场景分界：写入后记录归新场景；恢复会话按盘上分界还原序号', async () => {
    const r = recorderOf()
    r.onStep(agent, [userMsg('m1', '开始')])
    await r.drain('s1')
    await r.writeSceneBoundary(agent, { title: '后院夜话', cast: target.known.map((k) => k.id) })
    r.onStep(agent, [userMsg('m2', '换个地方')])
    feedReply(r, '【旁白】后院安静。')
    await r.drain('s1')
    const records = await recordsOf()
    expect(records[1]).toMatchObject({ type: 'scene', text: '后院夜话', scene: 2, cast: target.known.map((k) => k.id) })
    expect(records[2]).toMatchObject({ type: 'user', scene: 2 })
    expect(records[3]).toMatchObject({ type: 'narrator', scene: 2 })
    // 新建一个记录器（模拟重开会话）：场景序号从盘上还原
    const r2 = recorderOf()
    expect(await r2.currentScene(agent)).toBe(2)
    r2.onStep(agent, [userMsg('m3', '继续')])
    await r2.drain('s1')
    expect((await recordsOf()).at(-1)).toMatchObject({ type: 'user', scene: 2 })
  })

  it('旁白要求：单独一类记录，不算用户台词', async () => {
    const r = recorderOf()
    await r.writeNarratorRequest(agent, '让气氛紧张一点')
    await r.drain('s1')
    expect(await recordsOf()).toEqual([
      expect.objectContaining({ type: 'narrator-request', text: '让气氛紧张一点', scene: 1 }),
    ])
  })

  it('不在场景中（目标为 null）：什么都不写', async () => {
    const r = recorderOf(null)
    r.onStep(agent, [userMsg('m1', '你好')])
    feedReply(r, '【旁白】没人。')
    await r.drain('s1')
    expect(await recordsOf()).toEqual([])
  })

  it('只读目标：不写盘', async () => {
    const r = recorderOf({ ...target, readonly: true })
    r.onStep(agent, [userMsg('m1', '你好')])
    await r.drain('s1')
    expect(await recordsOf()).toEqual([])
  })

  it('同一消息编号不重复入档', async () => {
    const r = recorderOf()
    r.onStep(agent, [userMsg('m1', '第一句')])
    r.onStep(agent, [userMsg('m1', '第一句'), userMsg('m2', '第二句')])
    await r.drain('s1')
    expect(await recordsOf()).toHaveLength(2)
  })
})
