import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  readChatLines, selectRange, transcribe, finalImages, fingerprintOf, assembleSource, listBookChats, surveyChat,
  type Names,
} from '../../../src/core/book-source'
import type { ImageRecord } from '../../../src/core/images'

let tavern: string
beforeEach(async () => { tavern = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-src-')) })
afterEach(async () => { await fs.rm(tavern, { recursive: true, force: true }) })

const names: Names = { character: (id) => ({ c_fox: '白狐', c_qs: '青衫' })[id] ?? id, protagonist: '夏树' }

async function mkChat(dirName: string, meta: object, lines: unknown[], images: Partial<ImageRecord>[] = [], summary = '') {
  const dir = path.join(tavern, 'chats', dirName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.yaml'), YAML.stringify(meta))
  await fs.writeFile(path.join(dir, 'chat.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  if (images.length) await fs.writeFile(path.join(dir, 'images.jsonl'), images.map((i) => JSON.stringify(i)).join('\n') + '\n')
  if (summary) await fs.writeFile(path.join(dir, 'summary.md'), summary)
  return dir
}

const T = (min: number) => new Date(Date.UTC(2026, 9, 10, 12, min)).toISOString()
const groupMeta = { kind: 'group', participants: ['c_fox', 'c_qs'], session: 's', started: T(0), title: '生日派对', initialPresent: ['c_fox', 'c_qs'] }
const groupLines = [
  { time: T(0), type: 'narrator', text: '灯笼晃。', scene: 1 },
  { time: T(1), type: 'character', speaker: 'c_fox', text: '（顿杯）挂歪了。', scene: 1 },
  { time: T(2), type: 'user', speaker: '我', text: '挺好看的。', scene: 1 },
  { time: T(3), type: 'narrator', text: '我也觉得好看。', scene: 1, userImpersonated: true },
  { time: T(4), type: 'narrator-request', text: '下雨', scene: 1 },
  { time: T(5), type: 'scene', text: '切蛋糕', cast: ['c_fox'], scene: 2 },
  { time: T(6), type: 'character', speaker: 'c_fox', text: '许愿吧。', scene: 2 },
]

describe('readChatLines', () => {
  it('物理行号；坏行与空行占位但不返回', async () => {
    const dir = await mkChat('a-0001', groupMeta, [groupLines[0], '{bad', '', groupLines[1]])
    const lines = await readChatLines(dir)
    expect(lines.map((l) => l.line)).toEqual([1, 4])
  })
})

describe('selectRange / transcribe', () => {
  it('群聊按场景取，过滤越界与非叙事类型，转写说话人', async () => {
    const dir = await mkChat('a-0001', groupMeta, groupLines)
    const lines = await readChatLines(dir)
    const sel = selectRange(lines, { scene: 1 })
    const t = transcribe(sel.picked, names, [], sel.endTime)
    expect(t.text).toBe('[旁白] 灯笼晃。\n[白狐] （顿杯）挂歪了。\n[我→夏树] 挺好看的。')
  })
  it('单聊按行号取；用户说话人 user 也转成主角', async () => {
    const dir = await mkChat('b-0002', { kind: 'chat', participants: ['c_fox'], session: 's', started: T(0), title: '' }, [
      { time: T(0), type: 'user', speaker: 'user', text: '在吗' },
      { time: T(1), type: 'character', speaker: 'c_fox', text: '在。' },
      { time: T(2), type: 'user', speaker: 'user', text: '走了' },
    ])
    const sel = selectRange(await readChatLines(dir), { from: 1, to: 2 })
    expect(transcribe(sel.picked, { ...names, protagonist: '' }, [], sel.endTime).text).toBe('[我] 在吗\n[白狐] 在。')
    expect(sel.endTime).toBe(T(2))
  })
  it('插图对位：只取最终版本，放在时间不晚于它的最后一条之后', async () => {
    const imgs = [
      { n: 1, ts: T(1) + '', file: 'images/001.png', redoOf: null },
      { n: 2, ts: new Date(Date.UTC(2026, 9, 10, 12, 1, 30)).toISOString(), file: 'images/002.png', redoOf: 1 },
      { n: 3, ts: T(30), file: 'images/003.png', redoOf: null },
    ] as ImageRecord[]
    const fin = finalImages(imgs)
    expect(fin.map((i) => i.n)).toEqual([2, 3])
    const dir = await mkChat('a-0001', groupMeta, groupLines)
    const sel = selectRange(await readChatLines(dir), { scene: 1 })
    const t = transcribe(sel.picked, names, fin, sel.endTime)
    expect(t.text.split('\n')).toEqual(['[旁白] 灯笼晃。', '[白狐] （顿杯）挂歪了。', '[插图1]', '[我→夏树] 挺好看的。'])
    expect(t.images).toEqual([{ n: 1, file: 'images/002.png' }])
  })
})

describe('fingerprintOf / assembleSource', () => {
  it('同样的原料同样的指纹，改一个字就变', () => {
    expect(fingerprintOf('abc')).toBe(fingerprintOf('abc'))
    expect(fingerprintOf('abc')).not.toBe(fingerprintOf('abd'))
    expect(fingerprintOf('abc')).toMatch(/^[0-9a-f]{16}$/)
  })
  it('聊天不存在、范围越界、空范围都报错', async () => {
    await mkChat('a-0001', groupMeta, groupLines)
    expect(await assembleSource(tavern, 'nope', { scene: 1 }, names)).toMatchObject({ ok: false })
    expect(await assembleSource(tavern, 'a-0001', { scene: 9 }, names)).toMatchObject({ ok: false })
    expect(await assembleSource(tavern, 'a-0001', { from: 100, to: 120 }, names)).toMatchObject({ ok: false })
    const ok = await assembleSource(tavern, 'a-0001', { scene: 2 }, names)
    expect(ok).toMatchObject({ ok: true, text: '[白狐] 许愿吧。', chars: 9 })
  })
})

describe('listBookChats / surveyChat', () => {
  it('列出聊天：新的在前，带场景数与字数；元数据坏的跳过', async () => {
    await mkChat('20261010-2000-群聊-a001', groupMeta, groupLines)
    await mkChat('20261011-2000-白狐-b002', { kind: 'chat', participants: ['c_fox'], session: 's', started: T(100), title: '' }, [
      { time: T(100), type: 'user', speaker: 'user', text: '在吗' },
    ])
    await fs.mkdir(path.join(tavern, 'chats', 'broken-c003'), { recursive: true })
    const list = await listBookChats(tavern, names)
    expect(list.map((c) => c.dirName)).toEqual(['20261011-2000-白狐-b002', '20261010-2000-群聊-a001'])
    expect(list[1]).toMatchObject({ kind: 'group', title: '生日派对', scenes: 2, cast: ['白狐', '青衫'] })
  })
  it('群聊 survey：每个场景的梗概、在场、字数与行号区间', async () => {
    const summary = '## 场景一\n在场：白狐、青衫、我\n拌嘴。\n\n## 场景二：切蛋糕\n在场：白狐、我\n许愿。\n'
    await mkChat('a-0001', groupMeta, groupLines, [], summary)
    const s = await surveyChat(tavern, 'a-0001', names)
    expect(s.parts).toEqual([
      expect.objectContaining({ range: { scene: 1 }, summary: '拌嘴。', cast: ['白狐', '青衫'], lines: [1, 3] }),
      expect.objectContaining({ range: { scene: 2 }, summary: '许愿。', cast: ['白狐'], lines: [7, 7] }),
    ])
  })
  it('单聊 survey：间隔 30 分钟以上切段', async () => {
    await mkChat('b-0002', { kind: 'chat', participants: ['c_fox'], session: 's', started: T(0), title: '' }, [
      { time: T(0), type: 'user', speaker: 'user', text: '在吗' },
      { time: T(1), type: 'character', speaker: 'c_fox', text: '在。' },
      { time: T(90), type: 'user', speaker: 'user', text: '我回来了' },
    ])
    const s = await surveyChat(tavern, 'b-0002', names)
    expect(s.parts.map((p) => p.range)).toEqual([{ from: 1, to: 2 }, { from: 3, to: 3 }])
    expect(s.parts[0]!.preview).toContain('[我→夏树] 在吗')
  })
})
