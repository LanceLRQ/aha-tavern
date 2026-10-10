// 语音服务客户端：mlx-audio 自带的 OpenAI 兼容服务的 HTTP 调用，并把各种失败归成固定的几类。
// 与宿主无关；网络请求一律用注入的 fetch。错误原文只放 detail（供日志），message 是固定短语。

export type TtsErrorKind = 'unreachable' | 'timeout' | 'cancelled' | 'bad-response' | 'other'

const DETAIL_MAX = 2000

export class TtsError extends Error {
  readonly kind: TtsErrorKind
  /** 服务端原文，已截断；只给日志用，不进模型。 */
  readonly detail: string
  /** 服务返回非 2xx 时的状态码。 */
  readonly status?: number

  constructor(kind: TtsErrorKind, detail = '', options?: { cause?: unknown; status?: number }) {
    super(`tts: ${kind}`, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TtsError'
    this.kind = kind
    this.detail = detail.slice(0, DETAIL_MAX)
    if (options?.status !== undefined) this.status = options.status
  }
}

export interface TtsClientOptions {
  endpoint: string
  fetch: typeof fetch
}

export interface CloneInput {
  kind: 'clone'
  model: string
  text: string
  /** 参考录音的路径，是服务所在机器上的路径。 */
  refAudio: string
  refText: string
  language: string
}

export interface DesignInput {
  kind: 'design'
  model: string
  text: string
  /** 音色描述。 */
  instruct: string
  language: string
}

export type SynthesizeInput = CloneInput | DesignInput

export interface SynthesizeOptions {
  /** 完全由调用方决定；模型没下载时第一次合成会阻塞很久。 */
  timeoutMs: number
  signal?: AbortSignal
}

export interface SynthesizedAudio {
  bytes: Uint8Array
  format: 'wav'
}

export interface TtsClient {
  /** 返回已加载的模型名；一个都没加载（空数组）也算探测成功。 */
  probe(timeoutMs: number): Promise<string[]>
  synthesize(input: SynthesizeInput, opts: SynthesizeOptions): Promise<SynthesizedAudio>
  unload(model: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>
}

const MAX_TOKENS_CAP = 1200
const WAV_HEADER_BYTES = 44

/** 每次合成按字数给生成长度封顶：min(1200, 字数 × 6 + 30)，字数按 Unicode 码点。 */
export function maxTokensFor(text: string): number {
  return Math.min(MAX_TOKENS_CAP, [...text].length * 6 + 30)
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 至少一个 44 字节的头，且以 RIFF…WAVE 开头。 */
function isWav(b: Uint8Array): boolean {
  if (b.length <= WAV_HEADER_BYTES) return false
  const tag = (from: number): string => String.fromCharCode(b[from]!, b[from + 1]!, b[from + 2]!, b[from + 3]!)
  return tag(0) === 'RIFF' && tag(8) === 'WAVE'
}

interface CallResult {
  status: number
  ok: boolean
  text: string
  bytes?: Uint8Array
}

export function createTtsClient(opts: TtsClientOptions): TtsClient {
  const base = opts.endpoint.replace(/\/+$/, '')
  const doFetch = opts.fetch

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
    if (o.signal?.aborted) throw new TtsError('cancelled')
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
      if (o.signal?.aborted) throw new TtsError('cancelled', describeError(e), { cause: e })
      if (timedOut) throw new TtsError('timeout', describeError(e), { cause: e })
      throw new TtsError('unreachable', describeError(e), { cause: e })
    } finally {
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
    }
  }

  const httpFailure = (res: CallResult): TtsError =>
    new TtsError('bad-response', `HTTP ${res.status} ${res.text}`, { status: res.status })

  async function probe(timeoutMs: number): Promise<string[]> {
    const res = await call('GET', '/v1/models', { timeoutMs })
    if (!res.ok) throw httpFailure(res)
    const body = parseJson(res.text)
    const data = isRecord(body) ? body.data : undefined
    if (!Array.isArray(data)) throw new TtsError('bad-response', `unexpected models body: ${res.text}`)
    const names: string[] = []
    for (const item of data) {
      if (!isRecord(item) || typeof item.id !== 'string') {
        throw new TtsError('bad-response', `unexpected model entry: ${res.text}`)
      }
      names.push(item.id)
    }
    return names
  }

  async function synthesize(input: SynthesizeInput, o: SynthesizeOptions): Promise<SynthesizedAudio> {
    if (input.text.trim() === '') throw new TtsError('other', 'empty text')
    const common = {
      model: input.model,
      input: input.text,
    }
    const tail = {
      lang_code: input.language,
      response_format: 'wav',
      stream: false,
      max_tokens: maxTokensFor(input.text),
    }
    const body =
      input.kind === 'clone'
        ? { ...common, ref_audio: input.refAudio, ref_text: input.refText, ...tail }
        : { ...common, instruct: input.instruct, ...tail }

    const res = await call('POST', '/v1/audio/speech', {
      body,
      signal: o.signal,
      timeoutMs: o.timeoutMs,
      binary: true,
    })
    if (!res.ok) throw httpFailure(res)
    const bytes = res.bytes ?? new Uint8Array(0)
    if (!isWav(bytes)) {
      throw new TtsError('bad-response', `not wav audio: ${bytes.length} bytes`)
    }
    return { bytes, format: 'wav' }
  }

  async function unload(model: string, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const res = await call('DELETE', `/v1/models?model_name=${encodeURIComponent(model)}`, {
      timeoutMs: o.timeoutMs,
      signal: o.signal,
    })
    if (!res.ok) throw httpFailure(res)
  }

  return { probe, synthesize, unload }
}
