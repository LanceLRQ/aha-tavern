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

describe('DrawEcho 轮次收尾核对', () => {
  it('回复含路径：清除，收尾不补', () => {
    echo.onReply('s1', `好\n${imageLine(P)}`)
    echo.onTurnStopping('s1', undefined, nudge)
    expect(nudge).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
  it('回复提交时不补，只在收尾时补一次，内容含图片行', () => {
    echo.onReply('s1', '没图')
    expect(nudge).not.toHaveBeenCalled()
    echo.onTurnStopping('s1', undefined, nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge.mock.calls[0]![0]).toContain(imageLine(P))
    expect(warn).not.toHaveBeenCalled()
  })
  it('补救后的回复含路径：清除，无 warn', () => {
    echo.onTurnStopping('s1', undefined, nudge)
    echo.onReply('s1', imageLine(P))
    echo.onTurnStopping('s1', undefined, nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('补救后仍不含：warn 一次，不再补', () => {
    echo.onTurnStopping('s1', undefined, nudge)
    echo.onReply('s1', '还是没')
    echo.onTurnStopping('s1', undefined, nudge)
    echo.onTurnStopping('s1', undefined, nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('补过一次仍未贴出')
  })
  it('nudge 同步抛错：只 warn 不抛', () => {
    expect(() => echo.onTurnStopping('s1', undefined, () => { throw new Error('boom') })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('boom')
  })
  it('nudge 异步拒绝：只 warn', async () => {
    echo.onTurnStopping('s1', undefined, () => Promise.reject(new Error('nope')))
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('nope')
  })
  it('没有待核对项：什么都不做', () => {
    echo.onTurnStopping('other', undefined, nudge)
    expect(nudge).not.toHaveBeenCalled()
  })
})

describe('DrawEcho 用户停止', () => {
  let debug: ReturnType<typeof vi.fn>
  beforeEach(() => {
    debug = vi.fn()
    echo = new DrawEcho({ warn, debug })
    echo.onStep('s1', 4, 1)
    echo.expect('s1', P, 3)
  })
  it('出图成功后这一轮被停止：下一轮开始时清除，不补发', () => {
    echo.onReply('s1', '写到一半的前缀')
    // 被停止的轮次不经过 turn-stopping；下一轮 pre-step 进来
    echo.onStep('s1', 5, 1)
    echo.onTurnStopping('s1', 5, nudge)
    expect(nudge).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0]![0]).toContain('被停止')
    expect(warn).not.toHaveBeenCalled()
  })
  it('被停止后没有 pre-step，直接遇到别的轮次的收尾：也清除不补', () => {
    echo.onTurnStopping('s1', 5, nudge)
    expect(nudge).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })
  it('同一轮里用户插话：不清除，收尾照常补', () => {
    echo.onStep('s1', 4, 1)
    echo.onTurnStopping('s1', 4, nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('没有轮次号时退回旧判断：新用户消息到来则 warn 并清除', () => {
    const e = new DrawEcho({ warn })
    e.expect('s2', P, 1)
    e.onStep('s2', undefined, 0)
    e.onStep('s2', undefined, 1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('回复里没有图片路径')
    e.onTurnStopping('s2', undefined, nudge)
    expect(nudge).not.toHaveBeenCalled()
  })
})
