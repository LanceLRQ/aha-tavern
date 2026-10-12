import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import {
  prepareImage, boxResize, readImageSize, targetSize,
  MAX_FILE_BYTES, MAX_LONG_SIDE, MAX_PIXELS,
} from '../../../src/core/image-prep'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-imgprep-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

/** 用代码生成一张 PNG；fill 给出每个像素的 RGBA。 */
function makePng(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number], opts: Record<string, unknown> = {}): Buffer {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * w + x) * 4
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a
    }
  }
  return PNG.sync.write(png, opts)
}

async function put(name: string, data: Buffer): Promise<string> {
  const f = path.join(dir, name)
  await fs.writeFile(f, data)
  return f
}

const decode = (b: Buffer) => PNG.sync.read(b)
const opts = () => ({ homeDir: dir })

// 8x8 的纯色 JPEG
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBtFFFeWeyf/9k=',
  'base64',
)

/** 只含合法文件头、声明指定宽高的 PNG（IHDR 之后什么都没有）。 */
function pngHeaderOnly(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8; b[25] = 2
  return b
}

/** 只含 SOI + 一个带宽高的 SOF0 段的 JPEG 头。 */
function jpegHeaderOnly(w: number, h: number, marker = 0xc0): Buffer {
  const b = Buffer.alloc(2 + 4 + 15)
  b[0] = 0xff; b[1] = 0xd8
  b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(2 + 0, 4) // 一个空的 APP0 段（长度 2 = 只含长度字段）
  const o = 6
  b[o] = 0xff; b[o + 1] = marker; b.writeUInt16BE(11, o + 2)
  b[o + 4] = 8
  b.writeUInt16BE(h, o + 5)
  b.writeUInt16BE(w, o + 7)
  b[o + 9] = 1
  return b
}

describe('prepareImage 通过', () => {
  it('小图原样通过，尺寸不变', async () => {
    const f = await put('a.png', makePng(8, 5, (x, y) => [x * 10, y * 20, 7, 255]))
    const r = await prepareImage(f, opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([r.width, r.height]).toEqual([8, 5])
    const out = decode(r.png)
    expect([out.width, out.height]).toEqual([8, 5])
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([0, 0, 7])
    const i = (3 * 8 + 4) * 4
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([40, 60, 7])
  })

  it('长边正好 2048 的图不缩', async () => {
    const f = await put('b.png', makePng(2048, 3, () => [1, 2, 3, 255]))
    const r = await prepareImage(f, opts())
    expect(r.ok && [r.width, r.height]).toEqual([2048, 3])
  })

  it('大图缩到长边 2048 且比例不变（横图与竖图）', async () => {
    const wide = await put('w.png', makePng(4096, 2000, () => [10, 20, 30, 255]))
    const rw = await prepareImage(wide, opts())
    expect(rw.ok && [rw.width, rw.height]).toEqual([2048, 1000])
    if (rw.ok) {
      const out = decode(rw.png)
      expect([out.width, out.height]).toEqual([2048, 1000])
      expect([out.data[0], out.data[1], out.data[2]]).toEqual([10, 20, 30])
    }
    const tall = await put('t.png', makePng(1500, 3001, () => [0, 0, 0, 255]))
    const rt = await prepareImage(tall, opts())
    // 1500 * 2048 / 3001 = 1023.66 -> 1024
    expect(rt.ok && [rt.width, rt.height]).toEqual([1024, 2048])
  })

  it('扩展名与内容不符时按内容判断', async () => {
    const png = await put('fake.jpg', makePng(4, 4, () => [9, 9, 9, 255]))
    expect((await prepareImage(png, opts())).ok).toBe(true)
    const jpg = await put('fake.png', TINY_JPEG)
    const r = await prepareImage(jpg, opts())
    expect(r.ok && [r.width, r.height]).toEqual([8, 8])
  })

  it('JPEG 解码后输出 PNG', async () => {
    const r = await prepareImage(await put('j.jpg', TINY_JPEG), opts())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('带透明通道的 PNG 铺到白色背景上，输出无透明通道', async () => {
    const f = await put('alpha.png', makePng(2, 1, (x) => (x === 0 ? [255, 0, 0, 0] : [0, 0, 0, 128])))
    const r = await prepareImage(f, opts())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = decode(r.png)
    // 全透明 -> 纯白；半透明黑 -> 约 127
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([255, 255, 255])
    expect(out.data[4]).toBeGreaterThanOrEqual(126)
    expect(out.data[4]).toBeLessThanOrEqual(128)
    expect(out.data[3]).toBe(255)
    // 文件本身是 RGB（colorType 2）
    expect(r.png[25]).toBe(2)
  })

  it('16 位、调色板 PNG 也能处理', async () => {
    const f = await put('p16.png', makePng(3, 3, () => [200, 100, 50, 255], { bitDepth: 16, colorType: 2, inputColorType: 6, inputHasAlpha: true }))
    const r = await prepareImage(f, opts())
    expect(r.ok).toBe(true)
  })

  it('~/ 开头的路径按注入的 home 展开', async () => {
    await put('home.png', makePng(2, 2, () => [1, 1, 1, 255]))
    expect((await prepareImage('~/home.png', opts())).ok).toBe(true)
  })
})

describe('prepareImage 拒绝', () => {
  it('相对路径、空路径', async () => {
    expect(await prepareImage('a/b.png', opts())).toEqual({ ok: false, reason: 'bad-path' })
    expect(await prepareImage('  ', opts())).toEqual({ ok: false, reason: 'bad-path' })
  })

  it('不存在的路径与目录', async () => {
    expect(await prepareImage(path.join(dir, 'nope.png'), opts())).toEqual({ ok: false, reason: 'not-found' })
    expect(await prepareImage(dir, opts())).toEqual({ ok: false, reason: 'not-found' })
  })

  it('空文件算损坏', async () => {
    expect(await prepareImage(await put('e.png', Buffer.alloc(0)), opts())).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('截断的 PNG 与 JPEG 算损坏', async () => {
    const png = makePng(32, 32, (x, y) => [x * 7, y * 7, 0, 255])
    expect(await prepareImage(await put('t1.png', png.subarray(0, png.length - 20)), opts())).toEqual({ ok: false, reason: 'corrupt' })
    expect(await prepareImage(await put('t2.png', png.subarray(0, 20)), opts())).toEqual({ ok: false, reason: 'corrupt' })
    expect(await prepareImage(await put('t3.jpg', TINY_JPEG.subarray(0, 40)), opts())).toEqual({ ok: false, reason: 'corrupt' })
    // 帧头完整但扫描数据被截断
    const r = await prepareImage(await put('t4.jpg', TINY_JPEG.subarray(0, TINY_JPEG.length - 60)), opts())
    expect(r.ok).toBe(false)
  })

  it('超过 30MB 不读内容直接拒绝', async () => {
    const f = path.join(dir, 'huge.png')
    await fs.writeFile(f, Buffer.alloc(0))
    await fs.truncate(f, MAX_FILE_BYTES + 1)
    expect(await prepareImage(f, opts())).toEqual({ ok: false, reason: 'too-large' })
  })

  it('恰好 30MB 不因大小被拒（走到格式判断）', async () => {
    const f = path.join(dir, 'edge.bin')
    await fs.writeFile(f, Buffer.alloc(0))
    await fs.truncate(f, MAX_FILE_BYTES)
    expect(await prepareImage(f, opts())).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('不支持的格式：GIF、WebP、BMP、文本', async () => {
    const cases: Record<string, Buffer> = {
      'a.gif': Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]),
      'a.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]),
      'a.bmp': Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)]),
      'a.txt': Buffer.from('hello world, not an image'),
    }
    for (const [name, data] of Object.entries(cases)) {
      expect(await prepareImage(await put(name, data), opts())).toEqual({ ok: false, reason: 'unsupported' })
    }
  })

  it('声明的像素数超过上限：PNG 与 JPEG，不进入解码', async () => {
    expect(await prepareImage(await put('big.png', pngHeaderOnly(10000, 5001)), opts())).toEqual({ ok: false, reason: 'too-many-pixels' })
    expect(await prepareImage(await put('big.jpg', jpegHeaderOnly(10000, 5001)), opts())).toEqual({ ok: false, reason: 'too-many-pixels' })
  })

  it('像素数恰好等于上限不因此被拒', async () => {
    // 头部合法但没有图像数据：越过像素检查后在解码处判损坏
    expect(MAX_PIXELS).toBe(50_000_000)
    expect(await prepareImage(await put('edge.png', pngHeaderOnly(10000, 5000)), opts())).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('拒绝结果里不带库的错误原文', async () => {
    const r = await prepareImage(await put('c.png', pngHeaderOnly(4, 4)), opts())
    expect(Object.keys(r).sort()).toEqual(['ok', 'reason'])
  })
})

describe('readImageSize', () => {
  it('读 PNG 的 IHDR', () => {
    expect(readImageSize(pngHeaderOnly(123, 456))).toEqual({ format: 'png', width: 123, height: 456 })
  })

  it('JPEG 跳过其他段后读到 SOF0 / SOF2', () => {
    expect(readImageSize(jpegHeaderOnly(640, 480))).toEqual({ format: 'jpeg', width: 640, height: 480 })
    expect(readImageSize(jpegHeaderOnly(640, 480, 0xc2))).toEqual({ format: 'jpeg', width: 640, height: 480 })
  })

  it('跳过 0xC4 / 0xC8 / 0xCC，不把它们当帧头', () => {
    for (const m of [0xc4, 0xc8, 0xcc]) expect(readImageSize(jpegHeaderOnly(640, 480, m))).toBeNull()
  })

  it('头部不完整读不出宽高', () => {
    expect(readImageSize(pngHeaderOnly(1, 1).subarray(0, 20))).toBeNull()
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
  })

  it('其他格式返回 null', () => {
    expect(readImageSize(Buffer.from('GIF89a......'))).toBeNull()
  })
})

describe('targetSize', () => {
  it('长边不超过 2048 保持原样', () => {
    expect(targetSize(2048, 100)).toEqual({ width: 2048, height: 100 })
    expect(targetSize(5, 5)).toEqual({ width: 5, height: 5 })
  })

  it('长边超过时缩到 2048，短边四舍五入且至少为 1', () => {
    expect(targetSize(4096, 2000)).toEqual({ width: 2048, height: 1000 })
    expect(targetSize(1500, 3001)).toEqual({ width: 1024, height: 2048 })
    expect(targetSize(40000, 3)).toEqual({ width: MAX_LONG_SIDE, height: 1 })
  })
})

describe('boxResize', () => {
  it('4x4 缩成 2x2，每格取 4 个源像素的平均', () => {
    const src = new Uint8Array(4 * 4 * 3)
    // 左上 2x2 块的红色通道：0, 10, 20, 30 -> 平均 15
    const set = (x: number, y: number, r: number) => { src[(y * 4 + x) * 3] = r }
    set(0, 0, 0); set(1, 0, 10); set(0, 1, 20); set(1, 1, 30)
    // 右上块：全 100
    for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]] as const) set(x, y, 100)
    const out = boxResize(src, 4, 4, 2, 2)
    expect(out.length).toBe(2 * 2 * 3)
    expect(out[0]).toBe(15)
    expect(out[3]).toBe(100)
    expect(out[6]).toBe(0)
  })

  it('非整数倍：3x1 缩成 2x1，按重叠面积加权', () => {
    // 目标像素 0 覆盖源 [0,1.5)：= (a0*1 + a1*0.5)/1.5；像素 1 覆盖 [1.5,3)
    const src = Uint8Array.from([30, 0, 0, 60, 0, 0, 90, 0, 0])
    const out = boxResize(src, 3, 1, 2, 1)
    expect(out[0]).toBe(40) // (30 + 30) / 1.5
    expect(out[3]).toBe(80) // (30 + 90) / 1.5
  })

  it('同尺寸原样返回内容', () => {
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6])
    expect(Array.from(boxResize(src, 2, 1, 2, 1))).toEqual([1, 2, 3, 4, 5, 6])
  })
})
