// ComfyUI 客户端：提交工作流、等结果、取图，并把各种失败归成固定的几类。
// 与宿主无关；网络请求一律用注入的 fetch。错误原文只放 detail（供日志），message 是固定短语。

export type ComfyErrorKind =
  | 'unreachable'
  | 'missing-node'
  | 'missing-model'
  | 'rejected'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'no-output'

const DETAIL_MAX = 2000

export class ComfyError extends Error {
  readonly kind: ComfyErrorKind
  /** 服务端原文，已截断；只给日志用，不进模型。 */
  readonly detail: string

  constructor(kind: ComfyErrorKind, detail = '', options?: { cause?: unknown }) {
    super(`comfy: ${kind}`, options)
    this.name = 'ComfyError'
    this.kind = kind
    this.detail = detail.slice(0, DETAIL_MAX)
  }
}

export interface ComfyClientOptions {
  endpoint: string
  fetch: typeof fetch
  /** 可被取消信号打断的等待；被打断时直接返回。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** 取消或超时后「撤队列、打断任务」各自的超时，默认 3000。 */
  stopTimeoutMs?: number
}

export interface GenerateOptions {
  /** 工作流里产出图片的节点编号。 */
  outputNode: string
  timeoutMs: number
  pollMs: number
  signal?: AbortSignal
}

export interface GeneratedImage {
  bytes: Uint8Array
  ext: string
}

/** 节点类型 → 输入名 → 可选值。 */
export type ObjectInfo = Record<string, Record<string, string[]>>

export interface ComfyClient {
  probe(timeoutMs: number): Promise<string>
  objectInfo(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ObjectInfo>
  generate(graph: Record<string, unknown>, opts: GenerateOptions): Promise<GeneratedImage>
  /** 打断服务端任务；给出 promptId 时新版服务只打断这一个。失败不抛。 */
  interrupt(promptId?: string): Promise<void>
}

const CLIENT_ID = 'aha-tavern'
const POLL_FAIL_LIMIT = 3
const DEFAULT_STOP_TIMEOUT_MS = 3000

interface CallResult {
  status: number
  ok: boolean
  text: string
  bytes?: Uint8Array
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 提交被拒时按错误类型字段归类，认不出的归 rejected。 */
function classifyRejection(text: string): ComfyErrorKind {
  const body = parseJson(text)
  if (!isRecord(body)) return 'rejected'
  const nodeErrors = isRecord(body.node_errors) ? Object.values(body.node_errors) : []
  for (const ne of nodeErrors) {
    const errors = isRecord(ne) && Array.isArray(ne.errors) ? ne.errors : []
    if (errors.some((x) => isRecord(x) && x.type === 'value_not_in_list')) return 'missing-model'
  }
  const top = isRecord(body.error) ? body.error : {}
  if (top.type === 'missing_node_type') return 'missing-node'
  if (top.type === 'invalid_prompt' && typeof top.message === 'string' && top.message.includes('does not exist')) {
    return 'missing-node'
  }
  return 'rejected'
}

/** 把一个输入的规格整理成可选值列表；不是列表型的返回 undefined。 */
function optionsOf(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined
  const [first, extra] = spec
  let list: unknown
  if (Array.isArray(first)) list = first
  else if (first === 'COMBO' && isRecord(extra)) list = extra.options
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : undefined
}

function extOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename)
  return m ? m[1]!.toLowerCase() : 'png'
}

export function createComfyClient(opts: ComfyClientOptions): ComfyClient {
  const base = opts.endpoint.replace(/\/+$/, '')
  const doFetch = opts.fetch
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  /**
   * 发请求并读完正文。信号 = 调用方信号 + 超时；
   * 调用方取消抛 cancelled，超时抛 timeout，其余网络层失败抛 unreachable。
   */
  async function call(
    method: string,
    path: string,
    o: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; binary?: boolean } = {},
  ): Promise<CallResult> {
    const ctl = new AbortController()
    let timedOut = false
    const onAbort = (): void => ctl.abort()
    if (o.signal?.aborted) throw new ComfyError('cancelled')
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const timer =
      o.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            ctl.abort()
          }, Math.max(1, o.timeoutMs))
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        signal: ctl.signal,
        ...(o.body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.body) }
          : {}),
      })
      if (o.binary && res.ok) {
        return { status: res.status, ok: true, text: '', bytes: new Uint8Array(await res.arrayBuffer()) }
      }
      return { status: res.status, ok: res.ok, text: await res.text() }
    } catch (e) {
      if (o.signal?.aborted) throw new ComfyError('cancelled', describeError(e), { cause: e })
      if (timedOut) throw new ComfyError('timeout', describeError(e), { cause: e })
      throw new ComfyError('unreachable', describeError(e), { cause: e })
    } finally {
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
    }
  }

  async function interrupt(promptId?: string): Promise<void> {
    try {
      await call('POST', '/interrupt', {
        ...(promptId ? { body: { prompt_id: promptId } } : {}),
        timeoutMs: stopTimeoutMs,
      })
    } catch {
      // 尽力而为
    }
  }

  async function dequeue(promptId: string): Promise<void> {
    try {
      await call('POST', '/queue', { body: { delete: [promptId] }, timeoutMs: stopTimeoutMs })
    } catch {
      // 尽力而为
    }
  }

  /** 把「超时」当成连不上：探测与取配置用。 */
  const asUnreachable = (e: unknown): never => {
    if (e instanceof ComfyError && e.kind === 'timeout') throw new ComfyError('unreachable', e.detail, { cause: e })
    throw e
  }

  async function probe(timeoutMs: number): Promise<string> {
    let res: CallResult
    try {
      res = await call('GET', '/system_stats', { timeoutMs })
    } catch (e) {
      return asUnreachable(e)
    }
    if (!res.ok) throw new ComfyError('unreachable', `HTTP ${res.status} ${res.text}`)
    const body = parseJson(res.text)
    if (!isRecord(body)) throw new ComfyError('unreachable', `not json: ${res.text}`)
    const system = isRecord(body.system) ? body.system : {}
    return typeof system.comfyui_version === 'string' ? system.comfyui_version : 'unknown'
  }

  async function objectInfo(o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ObjectInfo> {
    let res: CallResult
    try {
      res = await call('GET', '/object_info', { timeoutMs: o.timeoutMs, signal: o.signal })
    } catch (e) {
      return asUnreachable(e)
    }
    if (!res.ok) throw new ComfyError('unreachable', `HTTP ${res.status} ${res.text}`)
    const body = parseJson(res.text)
    if (!isRecord(body)) throw new ComfyError('unreachable', `not json: ${res.text}`)
    const out: ObjectInfo = {}
    for (const [type, def] of Object.entries(body)) {
      const inputs: Record<string, string[]> = {}
      const input = isRecord(def) && isRecord(def.input) ? def.input : {}
      for (const group of [input.required, input.optional]) {
        if (!isRecord(group)) continue
        for (const [name, spec] of Object.entries(group)) {
          const list = optionsOf(spec)
          if (list) inputs[name] = list
        }
      }
      out[type] = inputs
    }
    return out
  }

  async function generate(graph: Record<string, unknown>, o: GenerateOptions): Promise<GeneratedImage> {
    const { signal } = o
    const deadline = now() + o.timeoutMs
    let promptId: string | undefined

    /** 取消或超时：尽力撤掉排队项并打断任务（还没有任务编号就什么都不做），再抛。 */
    const stop = async (kind: 'cancelled' | 'timeout'): Promise<never> => {
      if (promptId) {
        await dequeue(promptId)
        await interrupt(promptId)
      }
      throw new ComfyError(kind)
    }
    /** 请求受调用方信号与总截止时间约束；超时与取消统一走 stop。 */
    const step = async (method: string, path: string, body?: unknown, binary?: boolean): Promise<CallResult> => {
      const remaining = deadline - now()
      if (remaining <= 0) return stop('timeout')
      try {
        return await call(method, path, { body, signal, timeoutMs: remaining, binary })
      } catch (e) {
        if (e instanceof ComfyError && (e.kind === 'timeout' || e.kind === 'cancelled')) return stop(e.kind)
        throw e
      }
    }

    if (signal?.aborted) throw new ComfyError('cancelled')

    const sub = await step('POST', '/prompt', { prompt: graph, client_id: CLIENT_ID })
    if (!sub.ok) {
      const kind = sub.status >= 400 && sub.status < 500 ? classifyRejection(sub.text) : 'failed'
      throw new ComfyError(kind, `HTTP ${sub.status} ${sub.text}`)
    }
    const subBody = parseJson(sub.text)
    promptId = isRecord(subBody) && typeof subBody.prompt_id === 'string' ? subBody.prompt_id : undefined
    if (!promptId) throw new ComfyError('failed', `no prompt_id: ${sub.text}`)

    let failures = 0
    for (;;) {
      if (signal?.aborted) return stop('cancelled')
      if (now() >= deadline) return stop('timeout')

      let hist: CallResult | undefined
      let failure: ComfyError | undefined
      try {
        hist = await step('GET', `/history/${encodeURIComponent(promptId)}`)
        if (hist.status >= 500) failure = new ComfyError('failed', `history HTTP ${hist.status} ${hist.text}`)
        else if (!hist.ok) throw new ComfyError('failed', `history HTTP ${hist.status} ${hist.text}`)
      } catch (e) {
        // 网络层失败可重试；其余（含 stop 抛出的 timeout/cancelled、4xx）直接抛
        if (e instanceof ComfyError && e.kind === 'unreachable') failure = e
        else throw e
      }
      if (failure) {
        if (++failures >= POLL_FAIL_LIMIT) throw failure
        await sleep(o.pollMs, signal)
        continue
      }
      failures = 0

      const parsed = parseJson(hist!.text)
      const entry = isRecord(parsed) ? parsed[promptId] : undefined
      if (isRecord(entry)) {
        const status = isRecord(entry.status) ? entry.status : {}
        if (status.status_str !== 'success') {
          throw new ComfyError('failed', JSON.stringify(status.messages ?? status))
        }
        return fetchImage(entry, o.outputNode, step)
      }
      await sleep(o.pollMs, signal)
    }
  }

  async function fetchImage(
    entry: Record<string, unknown>,
    outputNode: string,
    step: (method: string, path: string, body?: unknown, binary?: boolean) => Promise<CallResult>,
  ): Promise<GeneratedImage> {
    const outputs = isRecord(entry.outputs) ? entry.outputs : {}
    const node = outputs[outputNode]
    const images = isRecord(node) && Array.isArray(node.images) ? node.images : []
    const img = images[0]
    if (!isRecord(img) || typeof img.filename !== 'string') {
      throw new ComfyError('no-output', `node ${outputNode}: ${JSON.stringify(outputs)}`)
    }
    const qs = new URLSearchParams({
      filename: img.filename,
      subfolder: typeof img.subfolder === 'string' ? img.subfolder : '',
      type: typeof img.type === 'string' ? img.type : 'output',
    })
    const res = await step('GET', `/view?${qs.toString()}`, undefined, true)
    if (!res.ok || !res.bytes) throw new ComfyError('failed', `view HTTP ${res.status} ${res.text}`)
    return { bytes: res.bytes, ext: extOf(img.filename) }
  }

  return { probe, objectInfo, generate, interrupt }
}
