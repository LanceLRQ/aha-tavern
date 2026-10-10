import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveCharacter } from '../../../src/core/card'
import { createTavern } from '../../../src/core/tavern'
import { MAX_VOICE_SECONDS, MIN_VOICE_SECONDS, VOICE_AUDIO_FILE, VOICE_TEXT_FILE } from '../../../src/core/voice'
import { DeclineTracker, SessionGate } from '../../../src/shell/confirm'
import type { HostAgent } from '../../../src/shell/context'
import type { Readiness } from '../../../src/shell/speak'
import {
  VOICE_SET_TRIAL_TEXT, registerVoiceTools, type VoiceToolDeps,
} from '../../../src/shell/voice-tools'

/** 现场生成指定时长的静音 wav（8kHz 单声道 16 位）。 */
function makeWav(seconds: number): Buffer {
  const byteRate = 16000
  const dataLen = Math.round(seconds * byteRate)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + dataLen, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(8000, 24)
  head.writeUInt32LE(byteRate, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(dataLen, 40)
  return Buffer.concat([head, Buffer.alloc(dataLen)])
}

const READY: Readiness = {
  ok: true,
  settings: { endpoint: 'http://127.0.0.1:1', model: 'm', language: 'chinese', timeoutSeconds: 5 } as never,
  voice: { audio: '/x/a.wav', text: 'x' },
  player: { command: 'afplay', args: (f) => [f] },
}

let root: string
let tavern: string
let charDir: string
let src: string
let ask: ReturnType<typeof vi.fn>
let speak: ReturnType<typeof vi.fn>
let readiness: ReturnType<typeof vi.fn>
let convert: ReturnType<typeof vi.fn>
let onRegistered: ReturnType<typeof vi.fn>
let declines: DeclineTracker
let exec: (args: unknown, agent?: HostAgent | null) => Promise<string>
let defs: Record<string, { description: string; parameters: Record<string, { required?: boolean }>; execute(a: unknown, e: unknown): Promise<string> }>

const agentAt = (cwd: string): HostAgent => ({ id: 's', ctx: {}, session: { header: { cwd } } })

function build(over: Partial<VoiceToolDeps> = {}) {
  defs = {}
  const ctx = { tools: { register: (d: { name: string }) => { defs[d.name] = d as never } } }
  registerVoiceTools(ctx as never, {
    rt: { log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    getAsk: () => ask as never,
    gate: new SessionGate(),
    declines,
    speaker: { speak } as never,
    readiness: readiness as never,
    findConverter: async () => convert as never,
    homeDir: () => root,
    tavernDirOf: async (a) => a?.session?.header?.cwd as string | undefined,
    onRegistered,
    ...over,
  })
  exec = (args, agent = agentAt(tavern)) => defs.aha_voice_set!.execute(args, { agent })
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-voice-tools-'))
  tavern = path.join(root, 'tavern')
  await fs.mkdir(tavern)
  await createTavern(tavern, { name: 't' })
  charDir = (await saveCharacter(tavern, { name: '白狐', persona: 'p' })).dir
  src = path.join(root, 'ref.wav')
  await fs.writeFile(src, makeWav(5))
  ask = vi.fn(async () => ({ answers: [{ id: 'voice-replace', selected: ['覆盖'] }] }))
  speak = vi.fn()
  declines = new DeclineTracker()
  readiness = vi.fn(async () => READY)
  convert = vi.fn()
  onRegistered = vi.fn(async () => {})
  build()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const args = (over: Record<string, unknown> = {}) => ({ character: '白狐', audioPath: src, text: '你好呀', ...over })
const exists = (p: string) => fs.access(p).then(() => true, () => false)

describe('aha_voice_set 注册', () => {
  it('参数都必填，描述写明调用条件', () => {
    const d = defs.aha_voice_set!
    const schema = d.parameters as unknown as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(['character', 'audioPath', 'text'])
    expect(schema.required).toEqual(['character', 'audioPath', 'text'])
    expect(d.description).toContain('逐字')
    expect(d.description).toContain('绝对路径')
  })
})

describe('登记成功', () => {
  it('写入两个文件，试念一句固定的话，返回 spoken: true', async () => {
    const r = await exec(args())
    expect(r).toContain('voice registered')
    expect(r).toContain('replaced: false')
    expect(r).toContain('spoken: true')
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe('你好呀')
    expect(await exists(path.join(charDir, VOICE_AUDIO_FILE))).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0]![0]).toMatchObject({ sentences: [VOICE_SET_TRIAL_TEXT], owner: 's' })
    expect(VOICE_SET_TRIAL_TEXT).toBe('你好，这是我现在的声音。')
    expect(onRegistered).toHaveBeenCalledTimes(1)
  })

  it('支持 ~ 开头的路径', async () => {
    const r = await exec(args({ audioPath: '~/ref.wav' }))
    expect(r).toContain('voice registered')
  })

  it('试念检查的目标是刚登记的角色', async () => {
    await exec(args())
    expect(readiness).toHaveBeenCalledWith(expect.objectContaining({ tavernDir: tavern, characterId: expect.any(String) }))
  })

  it('服务不可用：仍然登记成功，spoken: false', async () => {
    readiness.mockResolvedValueOnce({ ok: false, block: 'unreachable' })
    const r = await exec(args())
    expect(r).toContain('voice registered')
    expect(r).toContain('spoken: false')
    expect(speak).not.toHaveBeenCalled()
    expect(await exists(path.join(charDir, VOICE_AUDIO_FILE))).toBe(true)
  })

  it('就绪检查抛错：仍然登记成功，spoken: false', async () => {
    readiness.mockRejectedValueOnce(new Error('boom'))
    const r = await exec(args())
    expect(r).toContain('spoken: false')
    expect(r).not.toContain('boom')
  })
})

describe('覆盖现有音色', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(charDir, VOICE_AUDIO_FILE), makeWav(4))
    await fs.writeFile(path.join(charDir, VOICE_TEXT_FILE), '旧的话')
  })

  it('弹确认卡片，写明角色名与替换提示；同意后覆盖', async () => {
    const r = await exec(args())
    expect(ask).toHaveBeenCalledTimes(1)
    const q = ask.mock.calls[0]![0].questions[0]
    expect(q.id).toBe('voice-replace')
    expect(q.detail).toContain('白狐')
    expect(q.detail).toContain('会替换现有的声音')
    expect(q.options.map((o: { label: string }) => o.label)).toEqual(['覆盖', '取消'])
    expect(r).toContain('replaced: true')
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe('你好呀')
  })

  it('源文件不存在：先校验，直接回 source-invalid，不弹覆盖卡', async () => {
    const r = await exec(args({ audioPath: path.join(root, 'nope.wav') }))
    expect(r).toContain('source-invalid')
    expect(ask).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe('旧的话')
  })

  it('源路径是目录：先校验，不弹覆盖卡', async () => {
    const r = await exec(args({ audioPath: root }))
    expect(r).toContain('source-invalid')
    expect(ask).not.toHaveBeenCalled()
  })

  it('源文件超上限：先校验，回 too-large，不弹覆盖卡', async () => {
    const big = path.join(root, 'huge.wav')
    await fs.writeFile(big, Buffer.alloc(0))
    await fs.truncate(big, 21 * 1024 * 1024)
    const r = await exec(args({ audioPath: big }))
    expect(r).toContain('too-large')
    expect(ask).not.toHaveBeenCalled()
  })

  it('取消：不改文件、不试念', async () => {
    ask.mockResolvedValueOnce({ answers: [{ id: 'voice-replace', selected: ['取消'] }] })
    const r = await exec(args())
    expect(r).toBe('not registered: user cancelled the replacement')
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe('旧的话')
    expect(speak).not.toHaveBeenCalled()
  })

  it('取消后同一轮不再弹卡，下一轮可以再弹', async () => {
    ask.mockResolvedValueOnce({ answers: [{ id: 'voice-replace', selected: ['取消'] }] })
    declines.onStep('s', 1)
    await exec(args())
    expect(ask).toHaveBeenCalledTimes(1)
    const r = await exec(args())
    expect(r).toBe('not registered: already declined this turn; ask the user what to change first')
    expect(ask).toHaveBeenCalledTimes(1)
    declines.onStep('s', 2)
    expect(await exec(args())).toContain('voice registered')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('自由输入不算拒绝', async () => {
    ask.mockResolvedValueOnce({ answers: [{ id: 'voice-replace', custom: '换一段' }] })
    declines.onStep('s', 1)
    await exec(args())
    expect(await exec(args())).toContain('voice registered')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('卡片被中止：返回 cancelled 短语，不算拒绝', async () => {
    ask.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    declines.onStep('s', 1)
    expect(await exec(args())).toBe('not registered: cancelled')
    expect(await exec(args())).toContain('voice registered')
  })

  it('没有确认服务：不覆盖', async () => {
    build({ getAsk: () => undefined })
    const r = await exec(args())
    expect(r).toContain('not registered')
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe('旧的话')
  })

  it('用户在卡片里自由输入：当作取消', async () => {
    ask.mockResolvedValueOnce({ answers: [{ id: 'voice-replace', custom: '换一段' }] })
    expect(await exec(args())).toContain('not registered')
    expect(await fs.readFile(path.join(charDir, VOICE_TEXT_FILE), 'utf8')).toBe('旧的话')
  })
})

describe('失败短语', () => {
  it('只读酒馆', async () => {
    const marker = path.join(tavern, 'aha-tavern.yaml')
    const raw = await fs.readFile(marker, 'utf8')
    await fs.writeFile(marker, raw.replace(/version:\s*\d+/, 'version: 9999'))
    const r = await exec(args())
    expect(r).toContain('read-only')
    expect(ask).not.toHaveBeenCalled()
    expect(await exists(path.join(charDir, VOICE_AUDIO_FILE))).toBe(false)
  })

  it('不是酒馆', async () => {
    build({ tavernDirOf: async () => undefined })
    expect(await exec(args())).toContain('not a tavern')
  })

  it('角色不存在', async () => {
    const r = await exec(args({ character: '黑猫' }))
    expect(r).toContain('error: no character named')
    expect(r).toContain('aha_list_characters')
  })

  it('角色名不唯一', async () => {
    await saveCharacter(tavern, { name: '白狐二号', persona: 'p' })
    await saveCharacter(tavern, { name: '白狐三号', persona: 'p' })
    const r = await exec(args({ character: '白' }))
    expect(r).toContain('matches several')
  })

  it('相对路径', async () => {
    expect(await exec(args({ audioPath: 'ref.wav' }))).toContain('audioPath must be an absolute path')
  })

  it('参数类型不对', async () => {
    expect(await exec(args({ character: '' }))).toContain('error:')
  })

  it('source-invalid：文件不存在', async () => {
    const r = await exec(args({ audioPath: path.join(root, 'nope.wav') }))
    expect(r).toContain('source-invalid')
  })

  it('too-large', async () => {
    const big = path.join(root, 'big.wav')
    await fs.writeFile(big, '')
    await fs.truncate(big, 20 * 1024 * 1024 + 1)
    expect(await exec(args({ audioPath: big }))).toContain('too-large')
  })

  it('too-short 带下限', async () => {
    await fs.writeFile(src, makeWav(MIN_VOICE_SECONDS - 1))
    const r = await exec(args())
    expect(r).toContain('too-short')
    expect(r).toContain(`${MIN_VOICE_SECONDS}s`)
  })

  it('too-long 带上限 15 秒', async () => {
    await fs.writeFile(src, makeWav(MAX_VOICE_SECONDS + 1))
    const r = await exec(args())
    expect(r).toContain('too-long')
    expect(r).toContain('15s')
  })

  it('needs-wav：没有转换器', async () => {
    const mp3 = path.join(root, 'a.mp3')
    await fs.writeFile(mp3, 'not wav')
    build({ findConverter: async () => null })
    const r = await exec(args({ audioPath: mp3 }))
    expect(r).toContain('needs-wav')
    expect(r).toContain('wav')
  })

  it('convert-failed：转换器失败', async () => {
    const mp3 = path.join(root, 'a.mp3')
    await fs.writeFile(mp3, 'not wav')
    convert.mockRejectedValueOnce(new Error('/secret/path exploded'))
    const r = await exec(args({ audioPath: mp3 }))
    expect(r).toContain('convert-failed')
    expect(r).not.toContain('exploded')
  })

  it('text-empty / text-too-long', async () => {
    expect(await exec(args({ text: '   ' }))).toContain('text-empty')
    expect(await exec(args({ text: '字'.repeat(501) }))).toContain('text-too-long')
  })

  it('写盘意外失败：返回通用说明，不带出系统错误原文', async () => {
    await fs.chmod(charDir, 0o500)
    try {
      const r = await exec(args())
      expect(r.startsWith('error:')).toBe(true)
      expect(r).not.toContain('EACCES')
      expect(r).not.toContain(charDir)
    } finally {
      await fs.chmod(charDir, 0o700)
    }
  })
})
