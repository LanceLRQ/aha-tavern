import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageServiceResult, ImageServiceSettings } from '../../../src/core/services'
import { IMAGE_SERVICE_DEFAULTS } from '../../../src/core/services'
import type { HostAgent } from '../../../src/shell/context'
import {
  DRAW_TOOL, DrawAvailability, hideDrawTool, hostOf, PROBE_CACHE_MS, PROBE_TIMEOUT_MS, type SessionFacts,
} from '../../../src/shell/draw'

const settings = (endpoint = 'http://10.0.0.1:8188'): ImageServiceSettings => ({ ...IMAGE_SERVICE_DEFAULTS, endpoint })
const configured = (endpoint?: string): ImageServiceResult => ({ configured: true, settings: settings(endpoint), problems: [] })
const agentOf = (id: string): HostAgent => ({ id, ctx: {} })

let clock: number
let facts: Map<string, SessionFacts>
let service: ImageServiceResult | Error
let probeResult: 'ok' | 'fail'
let probe: ReturnType<typeof vi.fn>
let hidden: Set<string>
let hideCalls: string[]
let releaseCalls: string[]
let onChange: ReturnType<typeof vi.fn>
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }

function make(): DrawAvailability {
  return new DrawAvailability({
    log,
    inspect: async (a) => facts.get(a.id) ?? { chatting: true, readonly: false },
    loadService: async () => {
      if (service instanceof Error) throw service
      return service
    },
    probe: (endpoint, timeoutMs) => probe(endpoint, timeoutMs),
    now: () => clock,
    hide: (a) => {
      hideCalls.push(a.id)
      hidden.add(a.id)
      return () => {
        releaseCalls.push(a.id)
        hidden.delete(a.id)
      }
    },
    onChange,
  })
}

beforeEach(() => {
  clock = 1_000_000
  facts = new Map()
  service = configured()
  probeResult = 'ok'
  probe = vi.fn(async () => {
    if (probeResult === 'fail') throw new Error('connect refused')
  })
  hidden = new Set()
  hideCalls = []
  releaseCalls = []
  onChange = vi.fn()
  log = { info: vi.fn(), warn: vi.fn() }
})

describe('三种判定结果下的显隐', () => {
  it('没配置：不探测，保持隐藏', async () => {
    service = { configured: false, problems: [] }
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const r = await d.ensure(a)
    expect(r).toEqual({ available: false, settings: null, reason: 'not-configured' })
    expect(probe).not.toHaveBeenCalled()
    expect(hidden.has('s1')).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('探测失败：不可用，保持隐藏，探测带 2 秒超时', async () => {
    probeResult = 'fail'
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const r = await d.ensure(a)
    expect(r.reason).toBe('unreachable')
    expect(r.available).toBe(false)
    expect(probe).toHaveBeenCalledWith('http://10.0.0.1:8188', PROBE_TIMEOUT_MS)
    expect(hidden.has('s1')).toBe(true)
  })

  it('探测成功：可用，解除隐藏并回调一次；再次 ensure 不重复操作', async () => {
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const r = await d.ensure(a)
    expect(r.available).toBe(true)
    expect(r.settings?.endpoint).toBe('http://10.0.0.1:8188')
    expect(hidden.has('s1')).toBe(false)
    expect(releaseCalls).toEqual(['s1'])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(a, true, r.settings)
    await d.ensure(a)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(releaseCalls).toEqual(['s1'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('同一状态不重复隐藏', async () => {
    probeResult = 'fail'
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    await d.ensure(a)
    await d.refresh(a)
    expect(hideCalls).toEqual(['s1'])
  })

  it('选角阶段不判定、保持隐藏，进入聊天后才判定', async () => {
    facts.set('s1', { chatting: false, readonly: false })
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    expect((await d.ensure(a)).reason).toBe('not-chatting')
    expect(probe).not.toHaveBeenCalled()
    facts.set('s1', { chatting: true, readonly: false })
    expect((await d.ensure(a)).available).toBe(true)
  })

  it('没有 conceal 直接判定为不可用时也会隐藏', async () => {
    service = { configured: false, problems: [] }
    const d = make()
    await d.ensure(agentOf('s1'))
    expect(hidden.has('s1')).toBe(true)
  })
})

describe('缓存', () => {
  it('60 秒内第二个会话不再探测，过期后重新探测', async () => {
    const d = make()
    await d.ensure(agentOf('s1'))
    await d.ensure(agentOf('s2'))
    expect(probe).toHaveBeenCalledTimes(1)
    clock += PROBE_CACHE_MS + 1
    await d.ensure(agentOf('s3'))
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('失败结果也缓存', async () => {
    probeResult = 'fail'
    const d = make()
    await d.ensure(agentOf('s1'))
    probeResult = 'ok'
    expect((await d.ensure(agentOf('s2'))).available).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('refresh 无视缓存，并按新结果更新会话', async () => {
    probeResult = 'fail'
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    await d.ensure(a)
    probeResult = 'ok'
    const r = await d.refresh(a)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(r.available).toBe(true)
    expect(hidden.has('s1')).toBe(false)
    probeResult = 'fail'
    const r2 = await d.refresh(a)
    expect(r2.available).toBe(false)
    expect(hidden.has('s1')).toBe(true)
    expect(onChange.mock.calls.map((c) => c[1])).toEqual([true, false])
  })

  it('同一地址的并发探测合并成一次', async () => {
    let finish!: () => void
    probe = vi.fn(() => new Promise<void>((res) => { finish = res }))
    const d = make()
    const p1 = d.ensure(agentOf('s1'))
    const p2 = d.ensure(agentOf('s2'))
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    finish()
    await Promise.all([p1, p2])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('同一会话并发 ensure 只判定一次', async () => {
    const d = make()
    const a = agentOf('s1')
    await Promise.all([d.ensure(a), d.ensure(a)])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('drop', () => {
  it('撤掉该会话的能力，缓存同时失效', async () => {
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    await d.ensure(a)
    d.drop(a)
    expect(hidden.has('s1')).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith(a, false, null)
    expect((await d.ensure(a)).available).toBe(false)
    // 缓存已失效：别的会话要重新探测
    await d.ensure(agentOf('s2'))
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('判定进行中的竞态', () => {
  const deferred = () => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('drop 发生在判定进行中：迟到的"可用"不覆盖 drop', async () => {
    const gate = deferred()
    probe = vi.fn(() => gate.promise)
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const p = d.ensure(a)
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    d.drop(a)
    gate.resolve()
    await p
    expect(hidden.has('s1')).toBe(true)
    expect(releaseCalls).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
    expect((await d.ensure(a)).available).toBe(false)
  })

  it('并发两次 refresh：以最新发起的为准，即使先发起的后返回', async () => {
    const first = deferred()
    const second = deferred()
    probe = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const p1 = d.refresh(a)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    // 第二次 refresh 复用进行中的探测会得到同一结果，所以先让第一个探测落地缓存失效
    first.reject(new Error('down'))
    await p1
    const p2 = d.refresh(a)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    const p3 = d.refresh(a)
    second.resolve()
    const [, r3] = await Promise.all([p2, p3])
    expect(r3.available).toBe(true)
    expect(hidden.has('s1')).toBe(false)
  })

  it('旧判定后返回时不覆盖新判定', async () => {
    const slow = deferred()
    let call = 0
    service = configured('http://slow:1')
    const d = new DrawAvailability({
      log, inspect: async () => ({ chatting: true, readonly: false }),
      loadService: async () => (call++ === 0 ? configured('http://slow:1') : configured('http://fast:1')),
      probe: (endpoint) => (endpoint.includes('slow') ? slow.promise : Promise.resolve()),
      hide: (a) => { hidden.add(a.id); return () => { hidden.delete(a.id) } },
      onChange,
    })
    const a = agentOf('s1')
    d.conceal(a)
    const p1 = d.ensure(a)
    await vi.waitFor(() => expect(call).toBe(1))
    const r2 = await d.refresh(a)
    expect(r2.available).toBe(true)
    slow.reject(new Error('late failure'))
    await p1
    expect(hidden.has('s1')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((await d.ensure(a)).available).toBe(true)
  })

  it('判定进行中被 forget：结果丢弃，不再隐藏或回调', async () => {
    const gate = deferred()
    probe = vi.fn(() => gate.promise)
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    hideCalls.length = 0
    const p = d.ensure(a)
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    d.forget('s1')
    gate.resolve()
    await p
    expect(releaseCalls).toEqual([])
    expect(hideCalls).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('只读酒馆', () => {
  it('一律不可用，不读配置不探测', async () => {
    facts.set('s1', { chatting: true, readonly: true })
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const r = await d.ensure(a)
    expect(r.reason).toBe('readonly')
    expect(probe).not.toHaveBeenCalled()
    expect(hidden.has('s1')).toBe(true)
  })
})

describe('出错按不可用处理', () => {
  it('读配置抛异常：记 warn，不抛出，保持隐藏', async () => {
    service = new Error('boom')
    const d = make()
    const a = agentOf('s1')
    d.conceal(a)
    const r = await d.ensure(a)
    expect(r).toEqual({ available: false, settings: null, reason: 'error' })
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(hidden.has('s1')).toBe(true)
  })

  it('判定出错后不再每步重试', async () => {
    service = new Error('boom')
    const d = make()
    const a = agentOf('s1')
    await d.ensure(a)
    await d.ensure(a)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('隐藏函数抛异常只记 warn', async () => {
    const d = new DrawAvailability({
      log, inspect: async () => ({ chatting: true, readonly: false }),
      loadService: async () => ({ configured: false, problems: [] }), probe, hide: () => { throw new Error('no restrict') },
    })
    await expect(d.ensure(agentOf('s1'))).resolves.toMatchObject({ available: false })
    expect(log.warn).toHaveBeenCalled()
  })

  it('回调抛异常不影响结论', async () => {
    onChange.mockImplementation(() => { throw new Error('cb') })
    const d = make()
    await expect(d.ensure(agentOf('s1'))).resolves.toMatchObject({ available: true })
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('forget 与日志', () => {
  it('forget 后同一会话号重新判定', async () => {
    const d = make()
    await d.ensure(agentOf('s1'))
    d.forget('s1')
    await d.ensure(agentOf('s1'))
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('能力变化的日志只写主机与端口', async () => {
    const d = make()
    await d.ensure(agentOf('s1'))
    const line = log.info.mock.calls.map((c) => c[0] as string).find((m) => m.includes('开启'))
    expect(line).toContain('10.0.0.1:8188')
    expect(line).not.toContain('http://')
  })

  it('hostOf 处理无效地址', () => {
    expect(hostOf('http://a.b:1/x')).toBe('a.b:1')
    expect(hostOf('not a url')).toBe('（无效地址）')
  })
})

describe('hideDrawTool', () => {
  it('在 agent.ctx.tools 上以 deny 调用 restrict 并返回解除函数', () => {
    const release = vi.fn()
    const restrict = vi.fn(() => release)
    const a: HostAgent = { id: 's1', ctx: { tools: { restrict } } }
    expect(hideDrawTool(a)).toBe(release)
    expect(restrict).toHaveBeenCalledWith({ deny: [DRAW_TOOL] })
  })

  it('宿主没有 restrict 时抛出', () => {
    expect(() => hideDrawTool({ id: 's1', ctx: {} })).toThrow()
  })
})
