import { describe, expect, it, vi } from 'vitest'
import { refFileName, RefUploader } from '../../../src/shell/ref-upload'

const bytes = new Uint8Array([1, 2, 3])
const other = new Uint8Array([9, 9])

describe('refFileName', () => {
  it('内容 SHA-256 的前 16 位十六进制，同内容同名字', () => {
    expect(refFileName(bytes)).toMatch(/^aha-ref-[0-9a-f]{16}\.png$/)
    expect(refFileName(bytes)).toBe(refFileName(new Uint8Array([1, 2, 3])))
    expect(refFileName(bytes)).not.toBe(refFileName(other))
  })
})

describe('RefUploader', () => {
  it('同一服务上同一张只传一次，缓存里存服务端返回的名字', async () => {
    const up = vi.fn(async () => 'server-name.png')
    const u = new RefUploader()
    expect(await u.ensure('http://a', bytes, up)).toBe('server-name.png')
    expect(await u.ensure('http://a', bytes, up)).toBe('server-name.png')
    expect(up).toHaveBeenCalledTimes(1)
    expect(up).toHaveBeenCalledWith(bytes, refFileName(bytes), {})
  })
  it('不同服务地址、不同内容各传各的', async () => {
    const up = vi.fn(async (_d: Uint8Array, n: string) => n)
    const u = new RefUploader()
    await u.ensure('http://a', bytes, up)
    await u.ensure('http://b', bytes, up)
    await u.ensure('http://a', other, up)
    expect(up).toHaveBeenCalledTimes(3)
  })
  it('并发的两次请求只发一次上传', async () => {
    let done!: (n: string) => void
    const up = vi.fn(() => new Promise<string>((r) => { done = r }))
    const u = new RefUploader()
    const a = u.ensure('http://a', bytes, up)
    const b = u.ensure('http://a', bytes, up)
    done('x.png')
    expect(await Promise.all([a, b])).toEqual(['x.png', 'x.png'])
    expect(up).toHaveBeenCalledTimes(1)
  })
  it('失败的不缓存，下一次重新上传', async () => {
    const up = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok.png')
    const u = new RefUploader()
    await expect(u.ensure('http://a', bytes, up)).rejects.toThrow('boom')
    expect(await u.ensure('http://a', bytes, up)).toBe('ok.png')
    expect(up).toHaveBeenCalledTimes(2)
  })
  it('forget 之后重传', async () => {
    const up = vi.fn(async () => 'x.png')
    const u = new RefUploader()
    await u.ensure('http://a', bytes, up)
    u.forget('http://a', bytes)
    await u.ensure('http://a', bytes, up)
    expect(up).toHaveBeenCalledTimes(2)
  })
})
