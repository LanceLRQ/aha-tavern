// 出图时带定妆图：决定用哪张、上传、降级重试。与 harness 的具体事件无关，依赖都由 draw.ts 传入。
import { ComfyError, type GeneratedImage } from '../core/comfy'
import { DEFAULT_LOOK } from '../core/card'
import { readLooks, readPngBytes, resolveLook } from '../core/looks'
import type { Workflow } from '../core/workflow'
import type { RefUploader, UploadFn } from './ref-upload'

/** 带定妆图时放在提示词最前面的固定句子（批量实测：画风放到它前面时失败率从 7% 升到 20%）。 */
export const REF_PREAMBLE = '参考图是同一个角色的三个角度，只用来了解长相和衣着。新画面是一张完整的单幅插画，画面铺满整个画幅，不留白边；画面里有且只有一个人，只出现一次，不要画成设定图、多视图或拼贴。'

/** 点名的形象找不到、改用默认形象时，附在工具返回末尾的说明。 */
export const NOTE_LOOK_FALLBACK = 'note: look not found, used the default look'
/** 点名的形象找不到、默认形象也没有时的说明。 */
export const NOTE_LOOK_NONE = 'note: look not found'

export interface LoadedRef {
  /** DEFAULT_LOOK 或形象编号 */
  look: string
  bytes: Uint8Array
}

export interface RefChoice {
  ref: LoadedRef | null
  /** 附在工具返回末尾的说明；空串表示没有 */
  note: string
}

export interface ChooseRefInput {
  /** 角色目录；读不到角色卡时为 null */
  charDir: string | null
  /** settings.reference */
  enabled: boolean
  wf: Pick<Workflow, 'refs'>
  /** 角色这次点名的形象 */
  requested?: string
  /** redo 时上一张记录里的形象 */
  inherited?: string | null
  debug: (msg: string) => void
}

async function load(charDir: string, key: string | undefined): Promise<LoadedRef | null> {
  const r = await resolveLook(charDir, key)
  if (!r.ok) return null
  const bytes = await readPngBytes(r.file)
  return bytes ? { look: r.look, bytes } : null
}

/** 决定这一张带哪张定妆图。条件不满足或文件不可用时 ref 为 null，并记一条 debug 日志。 */
export async function chooseRef(p: ChooseRefInput): Promise<RefChoice> {
  const none = (why: string): RefChoice => {
    p.debug(`这一张不带定妆图：${why}`)
    return { ref: null, note: '' }
  }
  if (!p.enabled) return none('image.reference 已关闭')
  if (!p.wf.refs) return none('工作流不支持参考图')
  if (!p.charDir) return none('读不到角色目录')
  const key = p.requested ?? (p.inherited ? p.inherited : undefined)
  let ref = await load(p.charDir, key)
  let note = ''
  if (!ref && key !== undefined && key !== DEFAULT_LOOK) {
    ref = await load(p.charDir, undefined)
    if (p.requested !== undefined) note = ref ? NOTE_LOOK_FALLBACK : NOTE_LOOK_NONE
  }
  if (!ref) {
    p.debug('这一张不带定妆图：定妆图不存在或不是 PNG')
    return { ref: null, note }
  }
  return { ref, note }
}

/** 角色有哪几套额外形象（图片文件在的）；读不出来按没有。 */
export async function extraLooksOf(charDir: string): Promise<Array<{ name: string; when: string }>> {
  try {
    return (await readLooks(charDir)).extras.filter((l) => l.exists).map((l) => ({ name: l.name, when: l.when }))
  } catch {
    return []
  }
}

export interface GenerateWithRefInput {
  ref: LoadedRef | null
  endpoint: string
  uploader: RefUploader
  upload: UploadFn
  signal?: AbortSignal
  /** 按参考图的服务端文件名（null 为不带）组装提示词与提交的图 */
  build: (refName: string | null) => { prompt: string; graph: Record<string, unknown> }
  generate: (graph: Record<string, unknown>) => Promise<GeneratedImage>
  debug: (msg: string) => void
}

export interface GenerateWithRefResult {
  image: GeneratedImage
  prompt: string
  /** 实际带上的形象；没带为 null */
  look: string | null
}

const detailOf = (e: unknown): string => (e instanceof ComfyError ? e.detail || e.message : (e as Error)?.message ?? String(e))

/**
 * 出图，带定妆图时按规格 3.3 降级：上传失败 -> 不带；参考图不存在 -> 忘掉记账、重传、再出一次，
 * 仍不行 -> 不带再出一次。取消与出图期间的其他错误照常抛出，不继续降级。
 *
 * 超时说明：这里没有整次出图的总截止时间。上传自带 60 秒超时，不计入出图的 timeoutSeconds，
 * 出图本身另有自己的超时，所以最坏要多等约两分钟；全程可以取消。
 */
export async function generateWithRef(p: GenerateWithRefInput): Promise<GenerateWithRefResult> {
  const tryUpload = async (ref: LoadedRef): Promise<string | null> => {
    try {
      return await p.uploader.ensure(p.endpoint, ref.bytes, p.upload, p.signal ? { signal: p.signal } : {})
    } catch (e) {
      // 只有自己被取消才当取消；共享的那次上传被别的会话取消了，对自己只是上传失败
      if (p.signal?.aborted) throw e
      p.debug(`定妆图上传失败，这一张不带定妆图：${detailOf(e)}`)
      return null
    }
  }
  const attempt = async (refName: string | null): Promise<GenerateWithRefResult | null> => {
    const { prompt, graph } = p.build(refName)
    try {
      const image = await p.generate(graph)
      return { image, prompt, look: refName !== null && p.ref ? p.ref.look : null }
    } catch (e) {
      if (refName !== null && e instanceof ComfyError && e.kind === 'missing-ref') return null
      throw e
    }
  }

  if (p.ref) {
    const name = await tryUpload(p.ref)
    if (name !== null) {
      const first = await attempt(name)
      if (first) return first
      p.debug('服务端说参考图不存在，重传一次')
      p.uploader.forget(p.endpoint, p.ref.bytes)
      const again = await tryUpload(p.ref)
      if (again !== null) {
        const second = await attempt(again)
        if (second) return second
        p.debug('重传后服务端仍说参考图不存在，这一张不带定妆图')
      }
    }
  }
  const plain = await attempt(null)
  return plain!
}
