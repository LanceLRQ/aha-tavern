import { describe, expect, it } from 'vitest'
import { ComfyError, UPLOAD_TIMEOUT_MS, createComfyClient, type ComfyErrorKind } from '../../../src/core/comfy'

type Handler = (req: { method: string; path: string; body?: string; signal?: AbortSignal }) => Response | Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 按「方法 路径」匹配的假 fetch；路径不含查询串，匹配不到时返回 404。 */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; url: string; body?: string }> = []
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const u = new URL(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ method, path: u.pathname, url, body })
    const h = routes[`${method} ${u.pathname}`]
    if (!h) return new Response('not found', { status: 404 })
    return h({ method, path: u.pathname, body, signal: init?.signal ?? undefined })
  }) as unknown as typeof fetch
  return { f, calls }
}

/** 假时钟：sleep 不真等，只推进 now。 */
function fakeClock() {
  let t = 1_000_000
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

const ENDPOINT = 'http://comfy.test:8188'
const GRAPH = { '1': { class_type: 'X', inputs: {} } }
const IMG = { filename: 'aha_00001_.PNG', subfolder: 'sub', type: 'output' }
const doneEntry = (outputs: unknown, status = 'success') => ({
  p1: { status: { status_str: status, completed: true, messages: [['x', {}]] }, outputs },
})
const bytes = new Uint8Array([137, 80, 78, 71])

async function kindOf(p: Promise<unknown>): Promise<ComfyError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ComfyError)
    return e as ComfyError
  }
  throw new Error('应当抛出 ComfyError')
}

describe('probe', () => {
  it('成功返回版本号', async () => {
    const { f } = fakeFetch({ 'GET /system_stats': () => json({ system: { comfyui_version: '0.38.0' } }) })
    const c = createComfyClient({ endpoint: ENDPOINT + '/', fetch: f })
    expect(await c.probe(2000)).toBe('0.38.0')
  })

  it('连接被拒归 unreachable，原文进 detail 不进 message', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED secret-host')
    }) as unknown as typeof fetch
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).probe(2000))
    expect(err.kind).toBe('unreachable')
    expect(err.message).toBe('comfy: unreachable')
    expect(err.detail).toContain('ECONNREFUSED')
  })

  it('超时归 unreachable', async () => {
    const { f } = fakeFetch({
      'GET /system_stats': ({ signal }) =>
        new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    })
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).probe(10))
    expect(err.kind).toBe('unreachable')
  })

  it('非 2xx 或不是 JSON 都归 unreachable', async () => {
    const a = fakeFetch({ 'GET /system_stats': () => new Response('boom', { status: 502 }) })
    expect((await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: a.f }).probe(2000))).kind).toBe('unreachable')
    const b = fakeFetch({ 'GET /system_stats': () => new Response('<html>', { status: 200 }) })
    expect((await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: b.f }).probe(2000))).kind).toBe('unreachable')
  })
})

describe('objectInfo', () => {
  it('两种可选值写法都整理成数组，其他类型丢弃，required 与 optional 都看', async () => {
    const { f } = fakeFetch({
      'GET /object_info': () =>
        json({
          UnetLoaderGGUF: { input: { required: { unet_name: [['a.gguf', 'b.gguf']] } } },
          CLIPLoader: {
            input: {
              required: {
                clip_name: [['c.safetensors'], { tooltip: 't' }],
                type: ['COMBO', { options: ['qwen_image', 'sd3'] }],
                seed: ['INT', { default: 0 }],
                model: ['MODEL'],
              },
              optional: { device: [['default', 'cpu']] },
            },
          },
          Plain: { input: { required: { n: ['INT', {}] } } },
          NoInput: {},
        }),
    })
    const info = await createComfyClient({ endpoint: ENDPOINT, fetch: f }).objectInfo()
    expect(info.UnetLoaderGGUF).toEqual({ unet_name: ['a.gguf', 'b.gguf'] })
    expect(info.CLIPLoader).toEqual({
      clip_name: ['c.safetensors'],
      type: ['qwen_image', 'sd3'],
      device: ['default', 'cpu'],
    })
    expect(info.Plain).toEqual({})
    expect(info.NoInput).toEqual({})
    expect(Object.keys(info)).toHaveLength(4)
  })

  it('服务不可达归 unreachable', async () => {
    const f = (async () => {
      throw new TypeError('down')
    }) as unknown as typeof fetch
    expect((await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).objectInfo())).kind).toBe('unreachable')
  })
})

describe('generate：正常路径', () => {
  it('提交、两次未完成、一次完成、取图', async () => {
    let polls = 0
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1', number: 1, node_errors: {} }),
      'GET /history/p1': () => {
        polls++
        return json(polls < 3 ? {} : doneEntry({ '9': { images: [IMG] } }))
      },
      'GET /view': () => new Response(bytes),
    })
    const clock = fakeClock()
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...clock })
    const r = await c.generate(GRAPH, { outputNode: '9', timeoutMs: 180_000, pollMs: 1000 })
    expect(r.ext).toBe('png')
    expect(Array.from(r.bytes)).toEqual(Array.from(bytes))
    expect(polls).toBe(3)
    const submit = calls.find((x) => x.path === '/prompt')!
    expect(JSON.parse(submit.body!)).toEqual({ prompt: GRAPH, client_id: 'aha-tavern' })
    const view = new URL(calls.find((x) => x.path === '/view')!.url)
    expect(view.searchParams.get('filename')).toBe('aha_00001_.PNG')
    expect(view.searchParams.get('subfolder')).toBe('sub')
    expect(view.searchParams.get('type')).toBe('output')
    expect(calls.some((x) => x.path === '/interrupt')).toBe(false)
  })

  it('取不到扩展名时用 png', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({ '9': { images: [{ filename: 'noext', subfolder: '', type: 'output' }] } })),
      'GET /view': () => new Response(bytes),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    expect((await c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 })).ext).toBe('png')
  })
})

describe('generate：提交被拒', () => {
  const rejected = (body: unknown, status = 400) =>
    fakeFetch({ 'POST /prompt': () => json(body, status) })

  const run = (body: unknown, status?: number) => {
    const { f } = rejected(body, status)
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    return kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
  }

  it('取值不在列表里归 missing-model', async () => {
    const err = await run({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
      node_errors: {
        '1': {
          errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "unet_name: 'x.gguf' not in []" }],
          class_type: 'UnetLoaderGGUF',
        },
      },
    })
    expect(err.kind).toBe<ComfyErrorKind>('missing-model')
    expect(err.detail).toContain('x.gguf')
    expect(err.message).not.toContain('x.gguf')
  })

  it('节点类型不存在归 missing-node（invalid_prompt 与 missing_node_type）', async () => {
    const a = await run({
      error: { type: 'invalid_prompt', message: 'Cannot execute because node NoSuchNode does not exist.' },
      node_errors: {},
    })
    expect(a.kind).toBe('missing-node')
    const b = await run({ error: { type: 'missing_node_type', message: 'x' }, node_errors: {} })
    expect(b.kind).toBe('missing-node')
  })

  it('其他 4xx 归 rejected，认不出的正文也是', async () => {
    expect((await run({ error: { type: 'prompt_no_outputs', message: 'x' }, node_errors: {} })).kind).toBe('rejected')
    expect((await run('not json at all', 422)).kind).toBe('rejected')
  })

  it('detail 截断到 2000 字以内', async () => {
    const err = await run({ error: { type: 'other', message: 'x'.repeat(5000) }, node_errors: {} })
    expect(err.detail.length).toBeLessThanOrEqual(2000)
  })
})

describe('generate：执行与等待', () => {
  it('执行状态为错误归 failed', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({}, 'error')),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
    expect(err.kind).toBe('failed')
  })

  it('超过期限归 timeout 并调用一次中断', async () => {
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json({}),
      'POST /interrupt': () => new Response(''),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 5000, pollMs: 1000 }))
    expect(err.kind).toBe('timeout')
    expect(calls.filter((x) => x.path === '/interrupt')).toHaveLength(1)
  })

  it('取消信号归 cancelled 并调用一次中断', async () => {
    const ctl = new AbortController()
    let polls = 0
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => {
        if (++polls === 2) ctl.abort()
        return json({})
      },
      'POST /interrupt': () => new Response(''),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 1000, signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    expect(calls.filter((x) => x.path === '/interrupt')).toHaveLength(1)
  })

  it('提交前已取消：归 cancelled，不提交', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { f, calls } = fakeFetch({ 'POST /interrupt': () => new Response('') })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10, signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    expect(calls.some((x) => x.path === '/prompt')).toBe(false)
  })

  it('成功但指定节点没有图归 no-output', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({ '3': { images: [IMG] }, '9': {} })),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
    expect(err.kind).toBe('no-output')
  })

  it('取图失败归 failed', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({ '9': { images: [IMG] } })),
      'GET /view': () => new Response('gone', { status: 404 }),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
    expect(err.kind).toBe('failed')
  })

  it('服务中途连不上归 unreachable', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => {
        throw new TypeError('socket hang up')
      },
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
    expect(err.kind).toBe('unreachable')
  })
})

describe('interrupt', () => {
  it('发 POST /interrupt，失败不抛', async () => {
    const ok = fakeFetch({ 'POST /interrupt': () => new Response('') })
    await createComfyClient({ endpoint: ENDPOINT, fetch: ok.f }).interrupt()
    expect(ok.calls.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /interrupt'])
    const bad = (async () => {
      throw new TypeError('down')
    }) as unknown as typeof fetch
    await expect(createComfyClient({ endpoint: ENDPOINT, fetch: bad }).interrupt()).resolves.toBeUndefined()
  })
})

/** 只在 signal 中止时才 reject 的挂起响应。 */
const hang: Handler = ({ signal }) =>
  new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

const stopCalls = (calls: Array<{ method: string; path: string; body?: string }>) =>
  calls.filter((x) => x.path === '/queue' || x.path === '/interrupt').map((x) => `${x.path} ${x.body ?? ''}`)

describe('generate：挂起与收尾', () => {
  it('请求挂住：总期限到了归 timeout，并先撤队列再带任务编号打断', async () => {
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': hang,
      'POST /queue': () => new Response('{}'),
      'POST /interrupt': () => new Response(''),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 30, pollMs: 5 }))
    expect(err.kind).toBe('timeout')
    expect(stopCalls(calls)).toEqual(['/queue {"delete":["p1"]}', '/interrupt {"prompt_id":"p1"}'])
  })

  it('提交阶段挂住并超时：没有任务编号，不发撤队列与打断', async () => {
    const { f, calls } = fakeFetch({ 'POST /prompt': hang })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 30, pollMs: 5 }))
    expect(err.kind).toBe('timeout')
    expect(stopCalls(calls)).toEqual([])
  })

  it('提交阶段取消：归 cancelled，不发撤队列与打断', async () => {
    const ctl = new AbortController()
    const { f, calls } = fakeFetch({ 'POST /prompt': hang })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    setTimeout(() => ctl.abort(), 10)
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 5000, pollMs: 5, signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    expect(stopCalls(calls)).toEqual([])
  })

  it('读正文时被取消：归 cancelled 并收尾', async () => {
    const ctl = new AbortController()
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': ({ signal }) =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_, reject) => {
              signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
              setTimeout(() => ctl.abort(), 5)
            }),
        }) as unknown as Response,
      'POST /queue': () => new Response('{}'),
      'POST /interrupt': () => new Response(''),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 5000, pollMs: 5, signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    expect(stopCalls(calls)).toEqual(['/queue {"delete":["p1"]}', '/interrupt {"prompt_id":"p1"}'])
  })

  it('传图中途断网：归 unreachable', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({ '9': { images: [IMG] } })),
      'GET /view': () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.reject(new TypeError('terminated')),
        }) as unknown as Response,
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
    expect(err.kind).toBe('unreachable')
  })

  it('在 sleep 中取消：归 cancelled 并收尾', async () => {
    const ctl = new AbortController()
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json({}),
      'POST /queue': () => new Response('{}'),
      'POST /interrupt': () => new Response(''),
    })
    const clock = fakeClock()
    const c = createComfyClient({
      endpoint: ENDPOINT,
      fetch: f,
      now: clock.now,
      sleep: async () => ctl.abort(),
    })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 1000, signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    expect(stopCalls(calls)).toEqual(['/queue {"delete":["p1"]}', '/interrupt {"prompt_id":"p1"}'])
  })

  it('收尾请求自己挂住：generate 仍在有限时间内抛 timeout', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json({}),
      'POST /queue': hang,
      'POST /interrupt': hang,
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, stopTimeoutMs: 20 })
    const t = Date.now()
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 30, pollMs: 5 }))
    expect(err.kind).toBe('timeout')
    expect(Date.now() - t).toBeLessThan(1000)
  })
})

describe('generate：轮询重试', () => {
  const setup = (seq: Array<'throw' | 'e503' | 'e404' | 'pending' | 'done'>) => {
    let i = 0
    let polls = 0
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => {
        polls++
        const step = seq[Math.min(i++, seq.length - 1)]
        if (step === 'throw') throw new TypeError('reset')
        if (step === 'e503') return new Response('busy', { status: 503 })
        if (step === 'e404') return new Response('nope', { status: 404 })
        return json(step === 'done' ? doneEntry({ '9': { images: [IMG] } }) : {})
      },
      'GET /view': () => new Response(bytes),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    return { run: () => c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 10 }), polls: () => polls }
  }

  it('失败两次后成功，计数清零：再失败两次仍能完成', async () => {
    const s = setup(['throw', 'throw', 'pending', 'e503', 'throw', 'done'])
    expect((await s.run()).ext).toBe('png')
    expect(s.polls()).toBe(6)
  })

  it('连续三次网络层失败归 unreachable', async () => {
    const s = setup(['throw'])
    expect((await kindOf(s.run())).kind).toBe('unreachable')
    expect(s.polls()).toBe(3)
  })

  it('连续三次 5xx 归 failed', async () => {
    const s = setup(['e503'])
    expect((await kindOf(s.run())).kind).toBe('failed')
    expect(s.polls()).toBe(3)
  })

  it('4xx 立刻归 failed', async () => {
    const s = setup(['e404'])
    expect((await kindOf(s.run())).kind).toBe('failed')
    expect(s.polls()).toBe(1)
  })
})

describe('objectInfo 超时与取消', () => {
  it('挂住时按 timeoutMs 归 unreachable', async () => {
    const { f } = fakeFetch({ 'GET /object_info': hang })
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).objectInfo({ timeoutMs: 20 }))
    expect(err.kind).toBe('unreachable')
  })

  it('调用方取消归 cancelled', async () => {
    const ctl = new AbortController()
    const { f } = fakeFetch({ 'GET /object_info': hang })
    setTimeout(() => ctl.abort(), 10)
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).objectInfo({ signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
  })
})

describe('interrupt 带任务编号', () => {
  it('请求体为 {"prompt_id"}，不带编号时无请求体', async () => {
    const { f, calls } = fakeFetch({ 'POST /interrupt': () => new Response('') })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    await c.interrupt('abc')
    await c.interrupt()
    expect(calls.map((x) => x.body)).toEqual(['{"prompt_id":"abc"}', undefined])
  })
})

describe('generate：收尾边界', () => {
  const stopRoutes = {
    'POST /queue': () => new Response('{}'),
    'POST /interrupt': () => new Response(''),
  }

  it('任务已完成后取图失败（HTTP 500）：不撤队列也不打断，仍归 failed', async () => {
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({ '9': { images: [IMG] } })),
      'GET /view': () => new Response('boom', { status: 500 }),
      ...stopRoutes,
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 10 }))
    expect(err.kind).toBe('failed')
    expect(stopCalls(calls)).toEqual([])
  })

  it('任务已完成后取图超时：不撤队列也不打断，仍归 timeout', async () => {
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => json(doneEntry({ '9': { images: [IMG] } })),
      'GET /view': hang,
      ...stopRoutes,
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 30, pollMs: 5 }))
    expect(err.kind).toBe('timeout')
    expect(stopCalls(calls)).toEqual([])
  })

  it('轮询连续失败放弃：撤队列并打断，抛原错误', async () => {
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => { throw new TypeError('reset') },
      ...stopRoutes,
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 10 }))
    expect(err.kind).toBe('unreachable')
    expect(stopCalls(calls)).toEqual(['/queue {"delete":["p1"]}', '/interrupt {"prompt_id":"p1"}'])
  })

  it('history 返回 4xx 放弃：撤队列并打断', async () => {
    const { f, calls } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => new Response('nope', { status: 404 }),
      ...stopRoutes,
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 10 }))
    expect(err.kind).toBe('failed')
    expect(stopCalls(calls)).toEqual(['/queue {"delete":["p1"]}', '/interrupt {"prompt_id":"p1"}'])
  })

  it('放弃时清理请求本身失败：仍抛原错误', async () => {
    const { f } = fakeFetch({
      'POST /prompt': () => json({ prompt_id: 'p1' }),
      'GET /history/p1': () => new Response('busy', { status: 503 }),
      'POST /queue': () => { throw new TypeError('down') },
      'POST /interrupt': () => { throw new TypeError('down') },
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    const err = await kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 100_000, pollMs: 10 }))
    expect(err.kind).toBe('failed')
  })
})

describe('uploadImage', () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])

  /** 记录收到的表单。 */
  function uploadFetch(respond: () => Response | Promise<Response>) {
    const seen: Array<{ method: string; path: string; form?: FormData; headers?: unknown }> = []
    const f = (async (input: unknown, init?: RequestInit) => {
      const u = new URL(String(input))
      seen.push({
        method: init?.method ?? 'GET',
        path: u.pathname,
        form: init?.body instanceof FormData ? init.body : undefined,
        headers: init?.headers,
      })
      void init?.signal
      return respond()
    }) as unknown as typeof fetch
    return { f, seen }
  }

  it('发 multipart：image 带文件名与内容，overwrite=true；返回服务端给的名字', async () => {
    const { f, seen } = uploadFetch(() => json({ name: 'renamed (1).png', subfolder: '', type: 'input' }))
    const name = await createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'ref.png')
    expect(name).toBe('renamed (1).png')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.path).toBe('/upload/image')
    const file = seen[0]!.form!.get('image') as File
    expect(file.name).toBe('ref.png')
    expect(file.type).toBe('image/png')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
    expect(seen[0]!.form!.get('overwrite')).toBe('true')
    // 不能手写 Content-Type，边界由运行时生成
    expect(seen[0]!.headers).toBeUndefined()
  })

  it('超时归 timeout', async () => {
    const { f } = fakeFetch({ 'POST /upload/image': hang })
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'a.png', { timeoutMs: 20 }))
    expect(err.kind).toBe('timeout')
  })

  it('默认超时为 60 秒', () => {
    expect(UPLOAD_TIMEOUT_MS).toBe(60_000)
  })

  it('取消归 cancelled；已取消的信号不发请求', async () => {
    const ctl = new AbortController()
    const { f } = fakeFetch({ 'POST /upload/image': hang })
    setTimeout(() => ctl.abort(), 10)
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'a.png', { signal: ctl.signal }))
    expect(err.kind).toBe('cancelled')
    const { f: f2, seen } = uploadFetch(() => json({ name: 'x.png' }))
    const err2 = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f2 }).uploadImage(PNG, 'a.png', { signal: ctl.signal }))
    expect(err2.kind).toBe('cancelled')
    expect(seen).toHaveLength(0)
  })

  it('连不上归 unreachable', async () => {
    const f = (async () => {
      throw new TypeError('down')
    }) as unknown as typeof fetch
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'a.png'))
    expect(err.kind).toBe('unreachable')
  })

  it('HTTP 500 归 upload-failed，原文只在 detail', async () => {
    const { f } = uploadFetch(() => new Response('disk full secret', { status: 500 }))
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'a.png'))
    expect(err.kind).toBe<ComfyErrorKind>('upload-failed')
    expect(err.detail).toContain('disk full secret')
    expect(err.message).not.toContain('disk full')
  })

  it.each([
    ['缺 name', { subfolder: '' }],
    ['name 不是字符串', { name: 5 }],
    ['name 为空', { name: '' }],
    ['不是对象', ['x']],
  ])('返回体不对（%s）归 upload-failed', async (_n, body) => {
    const { f } = uploadFetch(() => json(body))
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'a.png'))
    expect(err.kind).toBe('upload-failed')
  })

  it('返回体不是 JSON 归 upload-failed', async () => {
    const { f } = uploadFetch(() => new Response('ok'))
    const err = await kindOf(createComfyClient({ endpoint: ENDPOINT, fetch: f }).uploadImage(PNG, 'a.png'))
    expect(err.kind).toBe('upload-failed')
  })
})

describe('generate：参考图不存在', () => {
  const run = (body: unknown, status = 400) => {
    const { f } = fakeFetch({ 'POST /prompt': () => json(body, status) })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f, ...fakeClock() })
    return kindOf(c.generate(GRAPH, { outputNode: '9', timeoutMs: 1000, pollMs: 10 }))
  }
  const body = (nodeErrors: unknown) => ({
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
    node_errors: nodeErrors,
  })

  it('LoadImage 的 image 输入校验失败归 missing-ref，不依赖措辞', async () => {
    const err = await run(
      body({
        aha_ref_1: {
          class_type: 'LoadImage',
          dependent_outputs: ['9'],
          errors: [
            { type: 'custom_validation_failed', message: 'x', details: '图片文件无效 xxx.png', extra_info: { input_name: 'image' } },
          ],
        },
      }),
    )
    expect(err.kind).toBe<ComfyErrorKind>('missing-ref')
    expect(err.detail).toContain('xxx.png')
  })

  it('其他节点的同类错误、LoadImage 的其他输入、其他错误类型都不算', async () => {
    const mk = (cls: string, type: string, input: string) =>
      body({ n: { class_type: cls, errors: [{ type, extra_info: { input_name: input } }] } })
    expect((await run(mk('Other', 'custom_validation_failed', 'image'))).kind).toBe('rejected')
    expect((await run(mk('LoadImage', 'custom_validation_failed', 'upload'))).kind).toBe('rejected')
    expect((await run(mk('LoadImage', 'required_input_missing', 'image'))).kind).toBe('rejected')
  })

  it('并存的模型缺失仍归 missing-model', async () => {
    const err = await run(
      body({
        a: { class_type: 'UnetLoaderGGUF', errors: [{ type: 'value_not_in_list' }] },
        b: { class_type: 'LoadImage', errors: [{ type: 'custom_validation_failed', extra_info: { input_name: 'image' } }] },
      }),
    )
    expect(err.kind).toBe('missing-model')
  })
})

describe('objectInfo：全部输入名', () => {
  it('默认丢弃非列表型；all 为真时保留全部输入名，非列表型给空数组', async () => {
    const { f } = fakeFetch({
      'GET /object_info': () =>
        json({
          TextEncodeQwenImage21: {
            input: { required: { prompt: ['STRING', {}], images: ['COMFY_AUTOGROW_V3', { template: {} }] }, optional: { clip: [['a']] } },
          },
        }),
    })
    const c = createComfyClient({ endpoint: ENDPOINT, fetch: f })
    expect((await c.objectInfo()).TextEncodeQwenImage21).toEqual({ clip: ['a'] })
    expect((await c.objectInfo({ allInputs: true })).TextEncodeQwenImage21).toEqual({ prompt: [], images: [], clip: ['a'] })
  })
})
