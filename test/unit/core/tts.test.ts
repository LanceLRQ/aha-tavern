import { afterEach, describe, expect, it, vi } from 'vitest'
import { TtsError, createTtsClient, maxTokensFor, type TtsErrorKind } from '../../../src/core/tts'

type Handler = (req: { method: string; url: string; body?: string; signal?: AbortSignal }) => Response | Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 按「方法 路径」匹配的假 fetch；匹配不到返回 404。 */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; url: string; body?: string }> = []
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ method, url, body })
    const h = routes[`${method} ${new URL(url).pathname}`]
    if (!h) return new Response('not found', { status: 404 })
    return h({ method, url, body, signal: init?.signal ?? undefined })
  }) as unknown as typeof fetch
  return { f, calls }
}

/** 只在被取消时才结束的挂起响应。 */
const hang: Handler = ({ signal }) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

/** 合法的最小 wav：44 字节头 + 若干字节数据。 */
function wav(dataBytes = 16): Uint8Array {
  const out = new Uint8Array(44 + dataBytes)
  out.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  out.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  return out
}
const audio = (b: Uint8Array = wav()): Response => new Response(b as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'audio/wav' } })

const ENDPOINT = 'http://tts.test:8000'

async function errOf(p: Promise<unknown>): Promise<TtsError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TtsError)
    return e as TtsError
  }
  throw new Error('应当抛出 TtsError')
}

afterEach(() => vi.useRealTimers())

describe('maxTokensFor', () => {
  it('按码点数 ×6+30，封顶 1200', () => {
    expect(maxTokensFor('你好')).toBe(42)
    expect(maxTokensFor('a'.repeat(10))).toBe(90)
    expect(maxTokensFor('a'.repeat(195))).toBe(1200)
    expect(maxTokensFor('a'.repeat(1000))).toBe(1200)
  })

  it('补充平面字符按一个码点算', () => {
    expect(maxTokensFor('😀😀')).toBe(42)
  })
})

describe('probe', () => {
  it('返回已加载的模型名，端点末尾斜杠不影响', async () => {
    const { f, calls } = fakeFetch({ 'GET /v1/models': () => json({ data: [{ id: 'm-a' }, { id: 'm-b' }] }) })
    const c = createTtsClient({ endpoint: ENDPOINT + '/', fetch: f })
    expect(await c.probe(2000)).toEqual(['m-a', 'm-b'])
    expect(calls[0]!.url).toBe(`${ENDPOINT}/v1/models`)
  })

  it('没加载任何模型（空数组）也算成功', async () => {
    const { f } = fakeFetch({ 'GET /v1/models': () => json({ data: [] }) })
    expect(await createTtsClient({ endpoint: ENDPOINT, fetch: f }).probe(2000)).toEqual([])
  })

  it('连不上归 unreachable，原文进 detail 不进 message', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED secret-host')
    }) as unknown as typeof fetch
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).probe(2000))
    expect(err.kind).toBe('unreachable')
    expect(err.message).toBe('tts: unreachable')
    expect(err.detail).toContain('ECONNREFUSED')
  })

  it('超时归 timeout', async () => {
    const { f } = fakeFetch({ 'GET /v1/models': hang })
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).probe(10))
    expect(err.kind).toBe('timeout')
  })

  it('响应形状不对或状态码不对归 bad-response', async () => {
    const shapes: Response[] = [json({ data: 'x' }), json({ nope: 1 }), json([]), new Response('<html>'), json({ data: [{ id: 1 }] })]
    for (const r of shapes) {
      const { f } = fakeFetch({ 'GET /v1/models': () => r.clone() })
      const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).probe(2000))
      expect(err.kind).toBe('bad-response')
    }
    const b = fakeFetch({ 'GET /v1/models': () => new Response('boom', { status: 502 }) })
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: b.f }).probe(2000))
    expect(err.kind).toBe('bad-response')
    expect(err.status).toBe(502)
  })
})

describe('synthesize', () => {
  const clone = {
    kind: 'clone' as const,
    model: 'base-model',
    text: '你好，世界。',
    refAudio: '/abs/voice_ref.wav',
    refText: '参考台词',
    language: 'zh',
  }
  const design = { kind: 'design' as const, model: 'design-model', text: 'Hello there.', instruct: '低沉的男声', language: 'en' }

  it('克隆：请求体字段齐全，文本原样发，非流式 wav', async () => {
    const { f, calls } = fakeFetch({ 'POST /v1/audio/speech': () => audio() })
    const out = await createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 5000 })
    expect(out.format).toBe('wav')
    expect(out.bytes.length).toBe(60)
    expect(calls[0]!.method).toBe('POST')
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      model: 'base-model',
      input: '你好，世界。',
      ref_audio: '/abs/voice_ref.wav',
      ref_text: '参考台词',
      lang_code: 'zh',
      response_format: 'wav',
      stream: false,
      max_tokens: maxTokensFor('你好，世界。'),
    })
  })

  it('音色设计：请求体用 instruct，不带参考录音', async () => {
    const { f, calls } = fakeFetch({ 'POST /v1/audio/speech': () => audio() })
    await createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(design, { timeoutMs: 5000 })
    const body = JSON.parse(calls[0]!.body!)
    expect(body).toEqual({
      model: 'design-model',
      input: 'Hello there.',
      instruct: '低沉的男声',
      lang_code: 'en',
      response_format: 'wav',
      stream: false,
      max_tokens: maxTokensFor('Hello there.'),
    })
    expect(body).not.toHaveProperty('ref_audio')
  })

  it('服务返回错误状态归 bad-response，状态码进 status，正文截断进 detail', async () => {
    const { f } = fakeFetch({ 'POST /v1/audio/speech': () => new Response('x'.repeat(5000), { status: 400 }) })
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 5000 }))
    expect(err.kind).toBe('bad-response')
    expect(err.status).toBe(400)
    expect(err.detail.length).toBeLessThanOrEqual(2000)
    expect(err.message).toBe('tts: bad-response')
  })

  it('返回非音频、空、过短、头不对都归 bad-response', async () => {
    const notWave = wav()
    notWave.set([0x41, 0x56, 0x49, 0x20], 8) // "AVI "
    const bodies: Uint8Array[] = [new Uint8Array(0), new TextEncoder().encode('{"error":"x"}'), wav(0), notWave]
    for (const b of bodies) {
      const { f } = fakeFetch({ 'POST /v1/audio/speech': () => audio(b) })
      const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 5000 }))
      expect(err.kind).toBe('bad-response')
    }
  })

  it('超时归 timeout', async () => {
    const { f } = fakeFetch({ 'POST /v1/audio/speech': hang })
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 10 }))
    expect(err.kind).toBe('timeout')
  })

  it('超时完全由 timeoutMs 决定：不到点不会自己放弃', async () => {
    vi.useFakeTimers()
    const { f } = fakeFetch({ 'POST /v1/audio/speech': hang })
    const p = errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 30 * 60_000 }))
    let settled = false
    void p.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect((await p).kind).toBe('timeout')
  })

  it('外部取消归 cancelled，与超时可区分', async () => {
    const { f } = fakeFetch({ 'POST /v1/audio/speech': hang })
    const ctl = new AbortController()
    const p = errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 60_000, signal: ctl.signal }))
    setTimeout(() => ctl.abort(), 10)
    expect((await p).kind).toBe('cancelled')
  })

  it('开始前信号已取消：不发请求，直接 cancelled', async () => {
    const { f, calls } = fakeFetch({ 'POST /v1/audio/speech': () => audio() })
    const ctl = new AbortController()
    ctl.abort()
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 5000, signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    expect(calls).toHaveLength(0)
  })

  it('连不上归 unreachable', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).synthesize(clone, { timeoutMs: 5000 }))
    expect(err.kind).toBe('unreachable')
  })

  it('文本去空白后为空：不发请求，抛 other', async () => {
    const { f, calls } = fakeFetch({ 'POST /v1/audio/speech': () => audio() })
    const c = createTtsClient({ endpoint: ENDPOINT, fetch: f })
    const err = await errOf(c.synthesize({ ...clone, text: ' \n\t ' }, { timeoutMs: 5000 }))
    expect(err.kind).toBe('other')
    expect(calls).toHaveLength(0)
  })
})

describe('unload', () => {
  it('DELETE 带 URL 编码的模型名，204 算成功', async () => {
    const { f, calls } = fakeFetch({ 'DELETE /v1/models': () => new Response(null, { status: 204 }) })
    await createTtsClient({ endpoint: ENDPOINT, fetch: f }).unload('org/model name')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe(`${ENDPOINT}/v1/models?model_name=org%2Fmodel%20name`)
  })

  it('非 2xx 归 bad-response 并带状态码', async () => {
    const { f } = fakeFetch({ 'DELETE /v1/models': () => new Response('no such model', { status: 404 }) })
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).unload('m'))
    expect(err.kind).toBe('bad-response')
    expect(err.status).toBe(404)
  })

  it('连不上归 unreachable', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const err = await errOf(createTtsClient({ endpoint: ENDPOINT, fetch: f }).unload('m'))
    expect(err.kind satisfies TtsErrorKind).toBe('unreachable')
  })
})
