// 定妆原图的预处理：按文件头识别格式（PNG、JPEG）、限制大小与像素数、
// 长边超过上限时用面积平均缩小，统一输出 8 位 RGB 的 PNG。
// 纯函数加一次文件读取；不依赖 harness，home 目录由调用方注入。
import fs from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

/** 文件大小上限（字节）；超过就不读内容。 */
export const MAX_FILE_BYTES = 30 * 1024 * 1024
/** 输出图的长边上限（像素）。 */
export const MAX_LONG_SIDE = 2048
/** 解码前允许的最大像素数（宽 × 高）。 */
export const MAX_PIXELS = 50_000_000

/** 拒绝原因（固定标识，供调用方翻译成面向用户的说明）。 */
export type ImagePrepFailure =
  | 'bad-path' // 不是绝对路径或 ~/ 开头
  | 'not-found' // 不存在，或不是普通文件
  | 'too-large' // 文件超过 MAX_FILE_BYTES
  | 'too-many-pixels' // 宽 × 高超过 MAX_PIXELS
  | 'unsupported' // 不是 PNG 或 JPEG
  | 'corrupt' // 文件损坏、截断或读不出尺寸

export type ImagePrepResult =
  | { ok: true; png: Buffer; width: number; height: number }
  | { ok: false; reason: ImagePrepFailure }

export interface ImagePrepEnv {
  /** 用来展开 ~ 的 home 目录。 */
  homeDir: string
}

export interface ImageHeader {
  format: 'png' | 'jpeg'
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

/** JPEG 帧头标记：SOF0–SOF15，除去 DHT(C4)、JPG(C8)、DAC(CC)。 */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
}

function readJpegSize(buf: Buffer): { width: number; height: number } | null {
  let pos = 2
  while (pos + 3 < buf.length) {
    if (buf[pos] !== 0xff) return null
    const marker = buf[pos + 1] ?? 0
    if (marker === 0xff) { pos++; continue } // 填充字节
    // 无长度字段的独立标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue }
    // 结束或开始扫描之前还没遇到帧头，说明文件不对
    if (marker === 0xd9 || marker === 0xda) return null
    const len = buf.readUInt16BE(pos + 2)
    if (len < 2) return null
    if (isSofMarker(marker)) {
      if (pos + 9 > buf.length) return null
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) }
    }
    pos += 2 + len
  }
  return null
}

/** 只看文件头读出格式与宽高；不是 PNG/JPEG 或头部不完整返回 null。 */
export function readImageSize(buf: Buffer): ImageHeader | null {
  if (isPng(buf)) {
    // 签名 8 字节 + 块长 4 + 'IHDR' 4 + 宽高各 4
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (isJpeg(buf)) {
    const s = readJpegSize(buf)
    return s ? { format: 'jpeg', ...s } : null
  }
  return null
}

/** 长边不超过上限保持原样，否则长边缩到上限，短边按比例四舍五入（至少 1）。 */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= MAX_LONG_SIDE) return { width, height }
  const k = MAX_LONG_SIDE / long
  return width >= height
    ? { width: MAX_LONG_SIDE, height: Math.max(1, Math.round(height * k)) }
    : { width: Math.max(1, Math.round(width * k)), height: MAX_LONG_SIDE }
}

/**
 * 面积平均缩小（盒式滤波）：目标像素取它覆盖的源区域，按重叠面积加权平均。
 * 输入输出都是紧密排列的 8 位 RGB。
 */
export function boxResize(src: Uint8Array, sw: number, sh: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th * 3)
  const sx = sw / tw
  const sy = sh / th
  const row = new Float64Array(tw * 3)
  const acc = new Float64Array(tw * 3)

  // 把源图第 y 行按水平方向压成 tw 个像素的加权和（权重总和为 sx）。
  const reduceRow = (y: number): void => {
    row.fill(0)
    const base = y * sw * 3
    for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * sx
      const x1 = (tx + 1) * sx
      const last = Math.min(sw - 1, Math.ceil(x1) - 1)
      for (let x = Math.floor(x0); x <= last; x++) {
        const w = Math.min(x + 1, x1) - Math.max(x, x0)
        if (w <= 0) continue
        const i = base + x * 3
        row[tx * 3]! += src[i]! * w
        row[tx * 3 + 1]! += src[i + 1]! * w
        row[tx * 3 + 2]! += src[i + 2]! * w
      }
    }
  }

  const norm = sx * sy
  for (let ty = 0; ty < th; ty++) {
    acc.fill(0)
    const y0 = ty * sy
    const y1 = (ty + 1) * sy
    const last = Math.min(sh - 1, Math.ceil(y1) - 1)
    for (let y = Math.floor(y0); y <= last; y++) {
      const w = Math.min(y + 1, y1) - Math.max(y, y0)
      if (w <= 0) continue
      reduceRow(y)
      for (let i = 0; i < acc.length; i++) acc[i]! += row[i]! * w
    }
    const o = ty * tw * 3
    for (let i = 0; i < acc.length; i++) out[o + i] = Math.round(acc[i]! / norm)
  }
  return out
}

/** RGBA 铺到白色背景上，得到紧密排列的 RGB。 */
function flattenOnWhite(rgba: Uint8Array, pixels: number): Uint8Array {
  const rgb = new Uint8Array(pixels * 3)
  for (let p = 0; p < pixels; p++) {
    const a = rgba[p * 4 + 3]!
    for (let c = 0; c < 3; c++) {
      const v = rgba[p * 4 + c]!
      rgb[p * 3 + c] = a === 255 ? v : Math.round((v * a + 255 * (255 - a)) / 255)
    }
  }
  return rgb
}

/** 绝对路径，支持 ~ 开头；其他写法返回 null。 */
function resolvePath(input: string, home: string): string | null {
  const p = input.trim()
  if (!p) return null
  const expanded = p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p
  return path.isAbsolute(expanded) ? expanded : null
}

function decodePixels(buf: Buffer, header: ImageHeader): Uint8Array {
  if (header.format === 'png') return PNG.sync.read(buf).data
  const img = jpeg.decode(buf, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 50,
    maxMemoryUsageInMB: 1024,
  })
  return img.data
}

/**
 * 读出一张图并整理成可上传的 PNG：识别格式、限制大小与像素数、
 * 长边超过上限时等比缩小、透明处铺白，输出 8 位 RGB。不抛异常。
 */
export async function prepareImage(input: string, env: ImagePrepEnv): Promise<ImagePrepResult> {
  const file = resolvePath(input, env.homeDir)
  if (!file) return { ok: false, reason: 'bad-path' }

  let buf: Buffer
  try {
    const st = await fs.stat(file)
    if (!st.isFile()) return { ok: false, reason: 'not-found' }
    if (st.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
    buf = await fs.readFile(file)
  } catch {
    return { ok: false, reason: 'not-found' }
  }

  if (buf.length === 0) return { ok: false, reason: 'corrupt' }
  if (!isPng(buf) && !isJpeg(buf)) return { ok: false, reason: 'unsupported' }

  const header = readImageSize(buf)
  if (!header || header.width < 1 || header.height < 1) return { ok: false, reason: 'corrupt' }
  if (header.width * header.height > MAX_PIXELS) return { ok: false, reason: 'too-many-pixels' }

  try {
    const rgba = decodePixels(buf, header)
    const pixels = header.width * header.height
    if (rgba.length < pixels * 4) return { ok: false, reason: 'corrupt' }
    let rgb = flattenOnWhite(rgba, pixels)
    const size = targetSize(header.width, header.height)
    if (size.width !== header.width || size.height !== header.height) {
      rgb = boxResize(rgb, header.width, header.height, size.width, size.height)
    }
    // pngjs 的编码输入是 RGBA；colorType 2 让它写出无透明通道的 RGB。
    const png = new PNG({ width: size.width, height: size.height })
    for (let p = 0; p < size.width * size.height; p++) {
      png.data[p * 4] = rgb[p * 3]!
      png.data[p * 4 + 1] = rgb[p * 3 + 1]!
      png.data[p * 4 + 2] = rgb[p * 3 + 2]!
      png.data[p * 4 + 3] = 255
    }
    const out = PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true })
    return { ok: true, png: out, width: size.width, height: size.height }
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
}
