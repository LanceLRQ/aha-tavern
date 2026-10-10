import { describe, expect, it } from 'vitest'
import { TRIM_MARGIN_SECONDS, trimWavSilence } from '../../../src/core/wav-trim'
import { wavInfo } from '../../../src/core/voice'

const RATE = 1000

/** 单声道 16-bit PCM wav；rate 取 1000 方便按毫秒数样本。 */
function wav(samples: number[], over: { format?: number; bits?: number; channels?: number; dataSize?: number; trailer?: boolean } = {}): Uint8Array {
  const channels = over.channels ?? 1
  const bits = over.bits ?? 16
  const data = new Uint8Array(samples.length * 2)
  const dv = new DataView(data.buffer)
  samples.forEach((v, i) => dv.setInt16(i * 2, v, true))
  const trailer = over.trailer ? new TextEncoder().encode('LIST\x04\x00\x00\x00abcd') : new Uint8Array(0)
  const out = new Uint8Array(44 + data.length + trailer.length)
  const v = new DataView(out.buffer)
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  tag(0, 'RIFF'); v.setUint32(4, out.length - 8, true); tag(8, 'WAVE')
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, over.format ?? 1, true); v.setUint16(22, channels, true)
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * channels * (bits / 8), true); v.setUint16(32, channels * (bits / 8), true); v.setUint16(34, bits, true)
  tag(36, 'data'); v.setUint32(40, over.dataSize ?? data.length, true)
  out.set(data, 44); out.set(trailer, 44 + data.length)
  return out
}

const pcm = (bytes: Uint8Array): number[] => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  for (let i = 44; i + 1 < bytes.length; i += 2) out.push(dv.getInt16(i, true))
  return out
}
const MARGIN = Math.round(RATE * TRIM_MARGIN_SECONDS) // 30

describe('trimWavSilence', () => {
  it('裁掉首尾的全 0 静音，各留 30ms 余量', () => {
    const s = [...Array(500).fill(0), ...Array(100).fill(5000), ...Array(400).fill(0)]
    const out = trimWavSilence(wav(s))
    expect(pcm(out)).toEqual([...Array(MARGIN).fill(0), ...Array(100).fill(5000), ...Array(MARGIN).fill(0)])
    expect(wavInfo(out)!.seconds).toBeCloseTo((100 + 2 * MARGIN) / RATE, 5)
  })
  it('开头有微小残留（低于阈值）时仍切到真正的起音', () => {
    const s = [...Array(200).fill(0), ...Array(10).fill(40), ...Array(300).fill(0), ...Array(50).fill(-8000), ...Array(100).fill(0)]
    const out = pcm(trimWavSilence(wav(s)))
    expect(out.slice(0, MARGIN)).toEqual(Array(MARGIN).fill(0))
    expect(out[MARGIN]).toBe(-8000)
    expect(out).toHaveLength(MARGIN + 50 + MARGIN)
  })
  it('余量不够 30ms 时只留到文件边界', () => {
    const s = [...Array(10).fill(0), ...Array(50).fill(3000), ...Array(5).fill(0)]
    expect(pcm(trimWavSilence(wav(s)))).toEqual(s)
  })
  it('没有可裁的内容时原样返回同一份字节', () => {
    const w = wav(Array(100).fill(3000))
    expect(trimWavSilence(w)).toBe(w)
  })
  it('全静音原样返回', () => {
    const w = wav(Array(300).fill(0))
    expect(trimWavSilence(w)).toBe(w)
  })
  it('不是 16-bit PCM 原样返回', () => {
    const f = wav([0, 0, 5000, 0, 0], { format: 3 })
    expect(trimWavSilence(f)).toBe(f)
    const b8 = wav([0, 0, 5000, 0, 0], { bits: 8 })
    expect(trimWavSilence(b8)).toBe(b8)
  })
  it('解析失败原样返回', () => {
    const junk = new Uint8Array([1, 2, 3, 4])
    expect(trimWavSilence(junk)).toBe(junk)
    const noData = wav([0, 0, 0]).slice(0, 36)
    expect(trimWavSilence(noData)).toBe(noData)
  })
  it('多声道按帧判断，data 长度字段为 0 时按实际剩余算，结果的头部长度字段正确', () => {
    const frames = [...Array(200).fill([0, 0]), ...Array(40).fill([0, 7000]), ...Array(200).fill([0, 0])].flat()
    const out = trimWavSilence(wav(frames, { channels: 2, dataSize: 0 }))
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
    expect(dv.getUint32(40, true)).toBe(out.length - 44)
    expect(dv.getUint32(4, true)).toBe(out.length - 8)
    expect(pcm(out)).toHaveLength((40 + 2 * MARGIN) * 2)
  })
  it('data 块之后的其他块被丢弃', () => {
    const s = [...Array(100).fill(0), ...Array(20).fill(4000), ...Array(100).fill(0)]
    const out = trimWavSilence(wav(s, { trailer: true }))
    expect(out).toHaveLength(44 + (20 + 2 * MARGIN) * 2)
  })
})
