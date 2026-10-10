// 角色音色：角色目录下的参考录音（voice_ref.wav）与录音里说的话（voice_ref.txt）。
// 负责两个文件的读取、校验与成对登记；不接触宿主，格式转换由调用方注入。
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const VOICE_AUDIO_FILE = 'voice_ref.wav'
export const VOICE_TEXT_FILE = 'voice_ref.txt'

export const MIN_VOICE_SECONDS = 3
export const MAX_VOICE_SECONDS = 30
export const MAX_VOICE_BYTES = 20 * 1024 * 1024
/** 录音文字的上限，按 Unicode 码点计。 */
export const VOICE_TEXT_MAX_CHARS = 500

export type VoiceRead =
  | { ok: true; audioPath: string; text: string }
  | { ok: false; missing: 'audio' | 'text' | 'both' }

const readIfExists = (file: string): Promise<Buffer | null> =>
  fs.readFile(file).then((b) => b, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null
    throw e
  })

/** 两个文件都在、文字去空白后非空才算有音色；否则说明缺什么（文字为空算缺文字）。 */
export async function readVoice(characterDir: string): Promise<VoiceRead> {
  const audioPath = path.resolve(characterDir, VOICE_AUDIO_FILE)
  const [audio, raw] = await Promise.all([readIfExists(audioPath), readIfExists(path.join(characterDir, VOICE_TEXT_FILE))])
  const text = raw?.toString('utf8').trim() ?? ''
  const hasAudio = audio !== null
  const hasText = text !== ''
  if (hasAudio && hasText) return { ok: true, audioPath, text }
  return { ok: false, missing: !hasAudio && !hasText ? 'both' : hasAudio ? 'text' : 'audio' }
}

export interface WavInfo {
  seconds: number
  sampleRate: number
  channels: number
}

/**
 * 解析 wav 头：跳过 fmt 前后的其他块找到 data 块，时长 = data 字节数 / 字节率。
 * data 长度字段为 0 或超出文件实际长度时按文件实际剩余字节算。不是 wav、头不完整返回 null。
 */
export function wavInfo(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let fmt: { sampleRate: number; channels: number; byteRate: number } | null = null
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = tag(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return null
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
      }
    } else if (id === 'data') {
      if (!fmt || fmt.byteRate === 0) return null
      const remain = bytes.length - body
      const dataLen = size === 0 || size > remain ? remain : size
      return { seconds: dataLen / fmt.byteRate, sampleRate: fmt.sampleRate, channels: fmt.channels }
    }
    pos = body + size + (size & 1)
  }
  return null
}

export type VoiceRegisterResult =
  | { kind: 'registered'; replaced: boolean; seconds: number }
  /** 文件不存在、不是普通文件，或 wav 头损坏。 */
  | { kind: 'source-invalid' }
  | { kind: 'too-large' }
  | { kind: 'too-short'; seconds: number }
  | { kind: 'too-long'; seconds: number }
  /** 不是 wav，又没有可用的转换器。 */
  | { kind: 'needs-wav' }
  | { kind: 'text-empty' }
  | { kind: 'text-too-long' }
  | { kind: 'convert-failed' }

export type VoiceConvert = (src: string, dest: string, opts: { signal?: AbortSignal }) => Promise<void>

export interface RegisterVoiceOptions {
  characterDir: string
  sourcePath: string
  text: string
  /** 把非 wav 录音转成 wav；不传则非 wav 一律返回 needs-wav。 */
  convert?: VoiceConvert
  signal?: AbortSignal
}

export interface SaveDesignedVoiceOptions {
  characterDir: string
  /** 已生成的 wav 字节。 */
  wav: Uint8Array
  /** 试听台词，即录音里说的话。 */
  text: string
}

const textProblem = (text: string): 'text-empty' | 'text-too-long' | null => {
  if (text === '') return 'text-empty'
  return [...text].length > VOICE_TEXT_MAX_CHARS ? 'text-too-long' : null
}

const durationProblem = (seconds: number): VoiceRegisterResult | null => {
  if (seconds < MIN_VOICE_SECONDS) return { kind: 'too-short', seconds }
  if (seconds > MAX_VOICE_SECONDS) return { kind: 'too-long', seconds }
  return null
}

const tmpName = (name: string) => `.${name}.${randomBytes(4).toString('hex')}.tmp`

const exists = (p: string) => fs.access(p).then(() => true, () => false)

/**
 * 把音频与文字成对写入角色目录：先各写成同目录临时文件，再依次改名；
 * 第二次改名失败时把音频恢复原状（原来没有就删掉），然后抛出错误。
 */
async function commitVoice(characterDir: string, wav: Uint8Array, text: string): Promise<boolean> {
  const audioFile = path.join(characterDir, VOICE_AUDIO_FILE)
  const textFile = path.join(characterDir, VOICE_TEXT_FILE)
  const tmpAudio = path.join(characterDir, tmpName(VOICE_AUDIO_FILE))
  const tmpText = path.join(characterDir, tmpName(VOICE_TEXT_FILE))
  const backup = path.join(characterDir, tmpName(`${VOICE_AUDIO_FILE}.bak`))
  const replaced = (await exists(audioFile)) && (await exists(textFile))
  const hadAudio = await exists(audioFile)
  let audioMoved = false
  try {
    await fs.writeFile(tmpAudio, wav)
    await fs.writeFile(tmpText, text, 'utf8')
    if (hadAudio) await fs.copyFile(audioFile, backup)
    await fs.rename(tmpAudio, audioFile)
    audioMoved = true
    await fs.rename(tmpText, textFile)
  } catch (e) {
    if (audioMoved) {
      if (hadAudio) await fs.rename(backup, audioFile).catch(() => undefined)
      else await fs.rm(audioFile, { force: true })
    }
    throw e
  } finally {
    await Promise.all([tmpAudio, tmpText, backup].map((p) => fs.rm(p, { force: true })))
  }
  return replaced
}

/** 登记音色。校验不通过时返回带种类的结果、不动任何文件；只有 IO 意外才抛错。 */
export async function registerVoice(opts: RegisterVoiceOptions): Promise<VoiceRegisterResult> {
  const text = opts.text.trim()
  const bad = textProblem(text)
  if (bad) return { kind: bad }

  const st = await fs.stat(opts.sourcePath).catch(() => null)
  if (!st || !st.isFile()) return { kind: 'source-invalid' }
  if (st.size > MAX_VOICE_BYTES) return { kind: 'too-large' }

  let bytes = await fs.readFile(opts.sourcePath)
  if (wavInfo(bytes) === null) {
    if (!opts.convert) return { kind: 'needs-wav' }
    const converted = path.join(opts.characterDir, tmpName('voice_convert.wav'))
    try {
      await opts.convert(opts.sourcePath, converted, { signal: opts.signal })
      const out = await fs.stat(converted)
      if (out.size > MAX_VOICE_BYTES) return { kind: 'too-large' }
      bytes = await fs.readFile(converted)
    } catch {
      return { kind: 'convert-failed' }
    } finally {
      await fs.rm(converted, { force: true })
    }
  }
  return finish(opts.characterDir, bytes, text, 'convert-failed')
}

/** 把一段已生成的 wav 字节与试听台词存为角色音色，校验与写入同 registerVoice。 */
export async function saveDesignedVoice(opts: SaveDesignedVoiceOptions): Promise<VoiceRegisterResult> {
  const text = opts.text.trim()
  const bad = textProblem(text)
  if (bad) return { kind: bad }
  if (opts.wav.length > MAX_VOICE_BYTES) return { kind: 'too-large' }
  return finish(opts.characterDir, opts.wav, text, 'source-invalid')
}

async function finish(
  characterDir: string, wav: Uint8Array, text: string, invalid: 'source-invalid' | 'convert-failed',
): Promise<VoiceRegisterResult> {
  const info = wavInfo(wav)
  if (info === null) return { kind: invalid }
  const problem = durationProblem(info.seconds)
  if (problem) return problem
  const replaced = await commitVoice(characterDir, wav, text)
  return { kind: 'registered', replaced, seconds: info.seconds }
}
