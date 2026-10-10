// 裁掉合成语音首尾的静音：模型每句开头自带 0.35 到 0.85 秒长短不一的静音，句间停顿要由我们自己控制。
// 纯函数；只处理 16-bit PCM wav，其他一律原样返回。

/** 判定为"有声"的最小振幅（16-bit 满幅 32768）。开头偶有约 10ms 的微小残留，远低于这个值。 */
export const SILENCE_THRESHOLD = 300
/** 首尾各保留的余量（秒）。 */
export const TRIM_MARGIN_SECONDS = 0.03

/** 裁掉首尾静音，返回新的 wav 字节；不是 16-bit PCM、解析失败、没有有声内容、无可裁时原样返回传入的对象。 */
export function trimWavSilence(bytes: Uint8Array): Uint8Array {
  const parsed = parse(bytes)
  if (!parsed) return bytes
  const { dataStart, dataLen, channels, sampleRate } = parsed
  const frameBytes = channels * 2
  const frames = Math.floor(dataLen / frameBytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const loud = (frame: number): boolean => {
    for (let c = 0; c < channels; c++) {
      if (Math.abs(view.getInt16(dataStart + frame * frameBytes + c * 2, true)) >= SILENCE_THRESHOLD) return true
    }
    return false
  }
  let first = 0
  while (first < frames && !loud(first)) first++
  if (first === frames) return bytes
  let last = frames - 1
  while (last > first && !loud(last)) last--
  const margin = Math.round(sampleRate * TRIM_MARGIN_SECONDS)
  const from = Math.max(0, first - margin)
  const to = Math.min(frames, last + 1 + margin)
  // 没有可裁的，且 data 块后也没有多余内容：原样返回
  if (from === 0 && to === frames && dataStart + dataLen === bytes.length) return bytes

  const body = bytes.subarray(dataStart + from * frameBytes, dataStart + to * frameBytes)
  const out = new Uint8Array(dataStart + body.length)
  out.set(bytes.subarray(0, dataStart), 0)
  out.set(body, dataStart)
  const dv = new DataView(out.buffer)
  dv.setUint32(4, out.length - 8, true)
  dv.setUint32(dataStart - 4, body.length, true)
  return out
}

interface Parsed {
  /** data 块内容的起点 */
  dataStart: number
  dataLen: number
  channels: number
  sampleRate: number
}

function parse(bytes: Uint8Array): Parsed | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let fmt: { channels: number; sampleRate: number } | null = null
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = tag(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return null
      const channels = view.getUint16(body + 2, true)
      // 只认 16-bit 整数 PCM
      if (view.getUint16(body, true) !== 1 || view.getUint16(body + 14, true) !== 16 || channels < 1) return null
      fmt = { channels, sampleRate: view.getUint32(body + 4, true) }
    } else if (id === 'data') {
      if (!fmt || fmt.sampleRate === 0) return null
      const remain = bytes.length - body
      const dataLen = size === 0 || size > remain ? remain : size
      return { dataStart: body, dataLen, ...fmt }
    }
    pos = body + size + (size & 1)
  }
  return null
}
