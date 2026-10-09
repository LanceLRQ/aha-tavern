import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DrawEcho, echoNotice, imageLine } from '../../../src/shell/draw'

const P = '/tmp/酒馆 a/img (1).png'
let warn: ReturnType<typeof vi.fn>
let echo: DrawEcho
let nudge: ReturnType<typeof vi.fn>

beforeEach(() => {
  warn = vi.fn()
  echo = new DrawEcho({ warn })
  nudge = vi.fn()
  echo.expect('s1', P, 3)
})

describe('echoNotice', () => {
  it('含 imageLine 的结果，特殊字符按现有规则处理', () => {
    const t = echoNotice('/a<b>/c.png')
    expect(t).toContain(imageLine('/a<b>/c.png'))
    expect(t).toContain('%3C')
    expect(t).toContain('<image_line>\n![画面](<')
  })
})

describe('DrawEcho.onReply 补救', () => {
  it('含路径：清除且不补', () => {
    echo.onReply('s1', `好\n${imageLine(P)}`, nudge)
    expect(nudge).not.toHaveBeenCalled()
    echo.onUser('s1', 1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('不含路径首次：补一次，内容含图片行', () => {
    echo.onReply('s1', '没图', nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge.mock.calls[0]![0]).toContain(imageLine(P))
    expect(warn).not.toHaveBeenCalled()
  })
  it('补救后的回复含路径：清除，无 warn', () => {
    echo.onReply('s1', '没图', nudge)
    echo.onReply('s1', imageLine(P), nudge)
    echo.onUser('s1', 1)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('补救后仍不含：warn 一次，不再补', () => {
    echo.onReply('s1', '没图', nudge)
    echo.onReply('s1', '还是没', nudge)
    echo.onReply('s1', '再没', nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('补过一次仍未贴出')
    echo.onUser('s1', 1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('补救前用户先发新消息：走 onUser 的 warn', () => {
    echo.onUser('s1', 1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('回复里没有图片路径')
    echo.onReply('s1', '没图', nudge)
    expect(nudge).not.toHaveBeenCalled()
  })
  it('补救后用户发新消息：warn 并清除', () => {
    echo.onReply('s1', '没图', nudge)
    echo.onUser('s1', 1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('nudge 同步抛错：只 warn 不抛', () => {
    expect(() => echo.onReply('s1', '没图', () => { throw new Error('boom') })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('boom')
  })
  it('nudge 异步拒绝：只 warn', async () => {
    echo.onReply('s1', '没图', () => Promise.reject(new Error('nope')))
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('nope')
  })
  it('没有待核对项：什么都不做', () => {
    echo.onReply('other', '没图', nudge)
    expect(nudge).not.toHaveBeenCalled()
  })
})
