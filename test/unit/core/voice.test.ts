import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_VOICE_BYTES, MAX_VOICE_SECONDS, MIN_VOICE_SECONDS, VOICE_AUDIO_FILE, VOICE_TEXT_FILE, VOICE_TEXT_MAX_CHARS,
  readVoice, registerVoice, saveDesignedVoice, wavInfo,
} from '../../../src/core/voice'

/** 现场生成指定时长的静音 wav（16 位），可在 fmt 与 data 之间插入其他块。 */
function makeWav(seconds: number, opts: { sampleRate?: number; channels?: number; listChunk?: boolean; dataSize?: 'zero' | 'oversize' } = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 8000
  const channels = opts.channels ?? 1
  const byteRate = sampleRate * channels * 2
  const dataLen = Math.round(seconds * byteRate)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(byteRate, 16)
  fmt.writeUInt16LE(channels * 2, 20)
  fmt.writeUInt16LE(16, 22)
  const parts: Buffer[] = [fmt]
  if (opts.listChunk) {
    const list = Buffer.alloc(8 + 5 + 1) // 奇数长度，补一个字节
    list.write('LIST', 0, 'ascii')
    list.writeUInt32LE(5, 4)
    parts.push(list)
  }
  const head = Buffer.alloc(8)
  head.write('data', 0, 'ascii')
  head.writeUInt32LE(opts.dataSize === 'zero' ? 0 : opts.dataSize === 'oversize' ? 0x7fffffff : dataLen, 4)
  parts.push(head, Buffer.alloc(dataLen))
  const body = Buffer.concat(parts)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length + 4, 4)
  riff.write('WAVE', 8, 'ascii')
  return Buffer.concat([riff, body])
}

let root: string
let dir: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-voice-'))
  dir = path.join(root, 'char')
  await fs.mkdir(dir)
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const exists = (p: string) => fs.access(p).then(() => true, () => false)
const write = async (name: string, data: Buffer | string) => {
  const p = path.join(root, name)
  await fs.writeFile(p, data)
  return p
}

describe('readVoice', () => {
  it('两个文件都在且文字非空：返回绝对路径与文字', async () => {
    await fs.writeFile(path.join(dir, VOICE_AUDIO_FILE), makeWav(4))
    await fs.writeFile(path.join(dir, VOICE_TEXT_FILE), '  你好呀\n')
    expect(await readVoice(dir)).toEqual({
      ok: true,
      audioPath: path.join(dir, VOICE_AUDIO_FILE),
      text: '你好呀',
    })
  })

  it('零字节音频不算有音色', async () => {
    await fs.writeFile(path.join(dir, VOICE_AUDIO_FILE), '')
    await fs.writeFile(path.join(dir, VOICE_TEXT_FILE), '你好')
    expect(await readVoice(dir)).toEqual({ ok: false, missing: 'audio' })
  })

  it('缺音频、缺文字、文字为空白、两个都缺', async () => {
    expect(await readVoice(dir)).toEqual({ ok: false, missing: 'both' })
    await fs.writeFile(path.join(dir, VOICE_TEXT_FILE), '你好')
    expect(await readVoice(dir)).toEqual({ ok: false, missing: 'audio' })
    await fs.rm(path.join(dir, VOICE_TEXT_FILE))
    await fs.writeFile(path.join(dir, VOICE_AUDIO_FILE), makeWav(4))
    expect(await readVoice(dir)).toEqual({ ok: false, missing: 'text' })
    await fs.writeFile(path.join(dir, VOICE_TEXT_FILE), ' \n\t ')
    expect(await readVoice(dir)).toEqual({ ok: false, missing: 'text' })
  })
})

describe('wavInfo', () => {
  it('正常：时长、采样率、声道', () => {
    const r = wavInfo(makeWav(5, { sampleRate: 16000, channels: 2 }))
    expect(r).toEqual({ seconds: 5, sampleRate: 16000, channels: 2 })
  })

  it('跳过 fmt 与 data 之间的其他块', () => {
    expect(wavInfo(makeWav(4, { listChunk: true }))?.seconds).toBe(4)
  })

  it('data 长度字段为 0 或超出实际：按文件实际剩余字节算', () => {
    expect(wavInfo(makeWav(4, { dataSize: 'zero' }))?.seconds).toBe(4)
    expect(wavInfo(makeWav(4, { dataSize: 'oversize' }))?.seconds).toBe(4)
  })

  it('音频数据被截断：按实际剩余字节算', () => {
    const full = makeWav(4)
    expect(wavInfo(full.subarray(0, full.length - 16000))?.seconds).toBe(3)
  })

  it('头部截断或不是 wav：返回 null', () => {
    const full = makeWav(4)
    expect(wavInfo(full.subarray(0, 10))).toBeNull()
    expect(wavInfo(full.subarray(0, 30))).toBeNull() // 有 fmt，没有 data 块
    expect(wavInfo(Buffer.from('ID3 this is an mp3 file, not a wave one'))).toBeNull()
    expect(wavInfo(Buffer.alloc(0))).toBeNull()
  })
})

describe('registerVoice', () => {
  it('成功：写入两个文件，文字去首尾空白，replaced 为 false', async () => {
    const src = await write('a.wav', makeWav(5))
    const r = await registerVoice({ characterDir: dir, sourcePath: src, text: '  今天天气真好。 ' })
    expect(r).toMatchObject({ kind: 'registered', replaced: false, seconds: 5 })
    expect(await fs.readFile(path.join(dir, VOICE_TEXT_FILE), 'utf8')).toBe('今天天气真好。')
    expect((await fs.readFile(path.join(dir, VOICE_AUDIO_FILE))).equals(makeWav(5))).toBe(true)
    expect((await fs.readdir(dir)).sort()).toEqual([VOICE_TEXT_FILE, VOICE_AUDIO_FILE])
  })

  it('已有音色时覆盖，replaced 为 true', async () => {
    const a = await write('a.wav', makeWav(5))
    const b = await write('b.wav', makeWav(6))
    await registerVoice({ characterDir: dir, sourcePath: a, text: '旧' })
    const r = await registerVoice({ characterDir: dir, sourcePath: b, text: '新' })
    expect(r).toMatchObject({ kind: 'registered', replaced: true, seconds: 6 })
    expect(await fs.readFile(path.join(dir, VOICE_TEXT_FILE), 'utf8')).toBe('新')
  })

  it('源文件不存在或是目录：source-invalid', async () => {
    expect((await registerVoice({ characterDir: dir, sourcePath: path.join(root, 'no.wav'), text: '好' })).kind).toBe('source-invalid')
    expect((await registerVoice({ characterDir: dir, sourcePath: root, text: '好' })).kind).toBe('source-invalid')
  })

  it('过大：too-large（不读内容）', async () => {
    const big = path.join(root, 'big.wav')
    await fs.writeFile(big, '')
    await fs.truncate(big, MAX_VOICE_BYTES + 1)
    expect((await registerVoice({ characterDir: dir, sourcePath: big, text: '好' })).kind).toBe('too-large')
  })

  it('时长过短、过长：分别报告并带秒数', async () => {
    const s = await write('s.wav', makeWav(MIN_VOICE_SECONDS - 1))
    const l = await write('l.wav', makeWav(MAX_VOICE_SECONDS + 1))
    expect(await registerVoice({ characterDir: dir, sourcePath: s, text: '好' })).toEqual({ kind: 'too-short', seconds: 2 })
    expect(await registerVoice({ characterDir: dir, sourcePath: l, text: '好' })).toEqual({ kind: 'too-long', seconds: 31 })
    expect(await exists(path.join(dir, VOICE_AUDIO_FILE))).toBe(false)
  })

  it('时长恰好在边界上可以通过', async () => {
    const s = await write('s.wav', makeWav(MIN_VOICE_SECONDS))
    const l = await write('l.wav', makeWav(MAX_VOICE_SECONDS))
    expect((await registerVoice({ characterDir: dir, sourcePath: s, text: '好' })).kind).toBe('registered')
    expect((await registerVoice({ characterDir: dir, sourcePath: l, text: '好' })).kind).toBe('registered')
  })

  it('文字为空或过长（按码点）：不动文件', async () => {
    const src = await write('a.wav', makeWav(5))
    expect((await registerVoice({ characterDir: dir, sourcePath: src, text: '  \n ' })).kind).toBe('text-empty')
    expect((await registerVoice({ characterDir: dir, sourcePath: src, text: '字'.repeat(VOICE_TEXT_MAX_CHARS + 1) })).kind).toBe('text-too-long')
    expect((await registerVoice({ characterDir: dir, sourcePath: src, text: '😀'.repeat(VOICE_TEXT_MAX_CHARS) })).kind).toBe('registered')
  })

  it('非 wav 且没有转换器：needs-wav', async () => {
    const src = await write('a.mp3', Buffer.from('ID3 not a wave'))
    expect((await registerVoice({ characterDir: dir, sourcePath: src, text: '好' })).kind).toBe('needs-wav')
  })

  it('非 wav 经转换器：转到角色目录里的临时文件，校验后登记，临时文件被清理', async () => {
    const src = await write('a.m4a', Buffer.from('fake m4a'))
    const seen: string[] = []
    const convert = vi.fn(async (from: string, to: string) => {
      seen.push(from, to)
      await fs.writeFile(to, makeWav(5))
    })
    const r = await registerVoice({ characterDir: dir, sourcePath: src, text: '好', convert })
    expect(r).toMatchObject({ kind: 'registered', seconds: 5 })
    expect(seen[0]).toBe(src)
    expect(path.dirname(seen[1]!)).toBe(dir)
    expect((await fs.readdir(dir)).sort()).toEqual([VOICE_TEXT_FILE, VOICE_AUDIO_FILE])
  })

  it('转换器抛错、或产出的不是 wav：convert-failed，临时文件被清理', async () => {
    const src = await write('a.m4a', Buffer.from('fake m4a'))
    const boom = await registerVoice({ characterDir: dir, sourcePath: src, text: '好', convert: async () => { throw new Error('x') } })
    expect(boom.kind).toBe('convert-failed')
    const junk = await registerVoice({
      characterDir: dir, sourcePath: src, text: '好', convert: async (_f, to) => { await fs.writeFile(to, 'junk') },
    })
    expect(junk.kind).toBe('convert-failed')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('转换后的 wav 同样检查时长', async () => {
    const src = await write('a.m4a', Buffer.from('fake m4a'))
    const r = await registerVoice({
      characterDir: dir, sourcePath: src, text: '好', convert: async (_f, to) => { await fs.writeFile(to, makeWav(1)) },
    })
    expect(r.kind).toBe('too-short')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('取消信号传给转换器', async () => {
    const src = await write('a.m4a', Buffer.from('fake m4a'))
    const ac = new AbortController()
    let got: AbortSignal | undefined
    await registerVoice({
      characterDir: dir, sourcePath: src, text: '好', signal: ac.signal,
      convert: async (_f, to, o) => { got = o.signal; await fs.writeFile(to, makeWav(5)) },
    })
    expect(got).toBe(ac.signal)
  })

  it('没有转换器且扩展名是 .wav（不分大小写）但头部损坏：source-invalid', async () => {
    const bad = await write('bad.WAV', Buffer.from('RIFF\0\0\0\0WAVE'))
    expect((await registerVoice({ characterDir: dir, sourcePath: bad, text: '好' })).kind).toBe('source-invalid')
  })

  it('已取消的信号：转换器失败时把取消原样抛出，不当成 convert-failed', async () => {
    const src = await write('a.m4a', Buffer.from('fake m4a'))
    const ac = new AbortController()
    const err = new Error('aborted')
    await expect(registerVoice({
      characterDir: dir, sourcePath: src, text: '好', signal: ac.signal,
      convert: async () => { ac.abort(); throw err },
    })).rejects.toBe(err)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('转换器没有产出文件：convert-failed', async () => {
    const src = await write('a.m4a', Buffer.from('fake m4a'))
    expect((await registerVoice({ characterDir: dir, sourcePath: src, text: '好', convert: async () => undefined })).kind).toBe('convert-failed')
  })

  it('同一角色并发登记两次：最终两个文件来自同一次调用', async () => {
    const a = await write('a.wav', makeWav(4))
    const b = await write('b.wav', makeWav(8))
    await Promise.all([
      registerVoice({ characterDir: dir, sourcePath: a, text: 'A' }),
      registerVoice({ characterDir: dir, sourcePath: b, text: 'B' }),
      saveDesignedVoice({ characterDir: dir, wav: makeWav(12), text: 'C' }),
    ])
    const text = await fs.readFile(path.join(dir, VOICE_TEXT_FILE), 'utf8')
    const secs = { A: 4, B: 8, C: 12 }[text as 'A' | 'B' | 'C']
    expect(wavInfo(await fs.readFile(path.join(dir, VOICE_AUDIO_FILE)))?.seconds).toBe(secs)
    expect((await fs.readdir(dir)).sort()).toEqual([VOICE_TEXT_FILE, VOICE_AUDIO_FILE])
  })

  describe('写入中途失败', () => {
    it('恢复也失败：保留旧音频备份，错误信息写明备份文件名', async () => {
      const old = await write('old.wav', makeWav(5))
      await registerVoice({ characterDir: dir, sourcePath: old, text: '旧' })
      const next = await write('new.wav', makeWav(7))
      // 第二次改名（文字）与恢复改名（备份 -> 音频）都失败
      const rename = vi.fn(async (from: string, to: string) => {
        if (to.endsWith(VOICE_TEXT_FILE) || from.includes('.bak')) throw new Error('disk gone')
        await fs.rename(from, to)
      })
      const err = await registerVoice({ characterDir: dir, sourcePath: next, text: '新', rename }).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      const bak = (await fs.readdir(dir)).find((n) => n.includes('.bak'))
      expect(bak).toBeDefined()
      expect((err as Error).message).toContain(bak!)
      expect((await fs.readFile(path.join(dir, bak!))).equals(makeWav(5))).toBe(true)
      expect((await fs.readFile(path.join(dir, VOICE_TEXT_FILE), 'utf8'))).toBe('旧')
      expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp') && !n.includes('.bak'))).toEqual([])
    })

    it('恢复成功时备份被清理', async () => {
      const old = await write('old.wav', makeWav(5))
      await registerVoice({ characterDir: dir, sourcePath: old, text: '旧' })
      const next = await write('new.wav', makeWav(7))
      const rename = async (from: string, to: string) => {
        if (to.endsWith(VOICE_TEXT_FILE)) throw new Error('boom')
        await fs.rename(from, to)
      }
      await expect(registerVoice({ characterDir: dir, sourcePath: next, text: '新', rename })).rejects.toThrow('boom')
      expect((await fs.readFile(path.join(dir, VOICE_AUDIO_FILE))).equals(makeWav(5))).toBe(true)
      expect((await fs.readdir(dir)).sort()).toEqual([VOICE_TEXT_FILE, VOICE_AUDIO_FILE])
    })

    it('已有音色：第二个文件改名失败，原有两个文件不变，不留临时文件', async () => {
      const old = await write('old.wav', makeWav(5))
      await registerVoice({ characterDir: dir, sourcePath: old, text: '旧' })
      // 让文字文件的位置变成非空目录，改名必然失败
      await fs.rm(path.join(dir, VOICE_TEXT_FILE))
      await fs.mkdir(path.join(dir, VOICE_TEXT_FILE))
      await fs.writeFile(path.join(dir, VOICE_TEXT_FILE, 'x'), '1')
      const next = await write('new.wav', makeWav(7))
      await expect(registerVoice({ characterDir: dir, sourcePath: next, text: '新' })).rejects.toThrow()
      expect((await fs.readFile(path.join(dir, VOICE_AUDIO_FILE))).equals(makeWav(5))).toBe(true)
      expect((await fs.stat(path.join(dir, VOICE_TEXT_FILE))).isDirectory()).toBe(true)
      expect((await fs.readdir(dir)).sort()).toEqual([VOICE_TEXT_FILE, VOICE_AUDIO_FILE])
    })

    it('原来没有音色：失败后不留下音频文件', async () => {
      await fs.mkdir(path.join(dir, VOICE_TEXT_FILE))
      await fs.writeFile(path.join(dir, VOICE_TEXT_FILE, 'x'), '1')
      const next = await write('new.wav', makeWav(7))
      await expect(registerVoice({ characterDir: dir, sourcePath: next, text: '新' })).rejects.toThrow()
      expect((await fs.readdir(dir)).sort()).toEqual([VOICE_TEXT_FILE])
    })
  })
})

describe('saveDesignedVoice', () => {
  it('把生成的 wav 字节与试听台词存为音色', async () => {
    const r = await saveDesignedVoice({ characterDir: dir, wav: makeWav(6), text: ' 试听台词 ' })
    expect(r).toMatchObject({ kind: 'registered', replaced: false, seconds: 6 })
    expect(await readVoice(dir)).toEqual({ ok: true, audioPath: path.join(dir, VOICE_AUDIO_FILE), text: '试听台词' })
    const again = await saveDesignedVoice({ characterDir: dir, wav: makeWav(6), text: '再来' })
    expect(again).toMatchObject({ kind: 'registered', replaced: true })
  })

  it('不是 wav、时长不合、文字为空：拒绝且不动文件', async () => {
    expect((await saveDesignedVoice({ characterDir: dir, wav: Buffer.from('nope'), text: '好' })).kind).toBe('source-invalid')
    expect((await saveDesignedVoice({ characterDir: dir, wav: makeWav(1), text: '好' })).kind).toBe('too-short')
    expect((await saveDesignedVoice({ characterDir: dir, wav: makeWav(5), text: '' })).kind).toBe('text-empty')
    expect(await fs.readdir(dir)).toEqual([])
  })
})
