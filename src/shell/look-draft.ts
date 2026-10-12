// 定妆候选的生成流程：现读生图配置并探测 -> 准备起点材料 -> 拼提示词 -> 上传参考图 -> 出图 -> 存为候选。
// 不碰会话、卡片与名额（那些在 look.ts）；所有依赖都由调用方传入，便于测试。
// 返回值是给主持人看的文字：英文固定短语，不带服务端原文，也不带用户给的路径。
import { ComfyError, type ComfyClient } from '../core/comfy'
import { prepareImage, type ImagePrepFailure } from '../core/image-prep'
import { addDraft, getDraft, readPngBytes, resolveLook, type DraftOrigin } from '../core/looks'
import type { ImageServiceResult } from '../core/services'
import { fillWorkflow, loadWorkflow } from '../core/workflow'
import { failKindOf, hostOf, imageLine, PROBE_TIMEOUT_MS, type DrawFailKind } from './draw'
import type { RefUploader } from './ref-upload'
import type { Runtime } from './runtime'

/** 工具名。 */
export const LOOK_DRAFT_TOOL = 'aha_look_draft'
/** 至多给几张原图。 */
export const MAX_LOOK_IMAGES = 4
/** note 的字数上限。 */
export const NOTE_MAX = 400
const POLL_MS = 1000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ---------- 已定稿的提示词（逐字使用） ----------

const SHEET_TAIL = '同一个角色的三个全身立绘从左到右并排，依次是正面、侧面、背面，站姿自然，双手下垂，表情平静，'
const SHEET_PLAIN_TAIL = '纯浅灰色背景，没有其他物体，没有文字。'
const SHEET_REF_TAIL = '保持参考图的画风、长相、发型、服装和配饰，纯浅灰色背景，没有其他物体，没有文字。'

/** 文字起点的第三段。 */
export const SHEET_FROM_TEXT = `把这个角色画成角色设定三视图：${SHEET_TAIL}${SHEET_PLAIN_TAIL}`
/** 一张原图。 */
export const SHEET_FROM_ONE_IMAGE = `把参考图里的这个角色画成角色设定三视图：${SHEET_TAIL}${SHEET_REF_TAIL}`
/** 多张原图。 */
export const SHEET_FROM_MANY_IMAGES = `几张参考图是同一个角色。把这个角色画成角色设定三视图：${SHEET_TAIL}${SHEET_REF_TAIL}`
/** 以某张候选为底。 */
export const SHEET_FROM_DRAFT = '按下面的要求修改这张设定图，其余保持不变。'

export type DraftStart =
  | { kind: 'text' }
  | { kind: 'images'; paths: string[] }
  | { kind: 'draft'; basedOn: number }
  | { kind: 'look'; look: string }

/** 拼提示词：文字起点是 画风 / 外貌 / 句子 三段换行连接（空的跳过）；其余起点只有句子。note 直接接在句子后面。 */
export function lookPrompt(start: DraftStart, p: { style: string; appearance: string; note: string }): string {
  const note = p.note.trim()
  switch (start.kind) {
    case 'text':
      return [p.style, p.appearance, SHEET_FROM_TEXT + note].map((s) => s.trim()).filter((s) => s !== '').join('\n')
    case 'images':
      return (start.paths.length > 1 ? SHEET_FROM_MANY_IMAGES : SHEET_FROM_ONE_IMAGE) + note
    case 'draft':
    case 'look':
      return SHEET_FROM_DRAFT + note
  }
}

/** 定妆图是横图：配置里宽高较大者为宽，较小者为高。 */
export function sheetSize(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(width, height), height: Math.min(width, height) }
}

// ---------- 固定短语 ----------

const HOW_TO_CHECK = 'tell the user to run /aha 自检 生图'
export const LOOK_TEXT = {
  notConfigured: `unavailable: the image service is not configured; tell the user to see docs/image-setup.md, then ${HOW_TO_CHECK}`,
  unreachable: `unavailable: the image service cannot be reached; ${HOW_TO_CHECK}`,
  noRefs: `unavailable: the current image workflow cannot take reference pictures, so it cannot start from pictures or from a candidate; `
    + `draw from the card's appearance text instead (omit images and basedOn), or ${HOW_TO_CHECK}`,
  noSuchCandidate: (n: number) => `error: no candidate numbered ${n}, look not drawn; omit basedOn or use a number from an earlier result`,
  noSuchLook: 'error: no saved look matches that name, look not drawn; omit basedOnLook, or ask the user which look to start from',
  tooManyRefs: (max: number) => `error: the current image workflow takes at most ${max} reference pictures, look not drawn; give fewer images`,
} as const

const IMAGE_REASON: Record<ImagePrepFailure, string> = {
  'bad-path': 'path must be absolute or start with ~/; ask the user for the full path',
  'not-found': 'file not found; ask the user to check the path',
  'too-large': 'file is too large; ask the user for a smaller picture',
  'too-many-pixels': 'picture has too many pixels; ask the user for a smaller picture',
  unsupported: 'unsupported format, convert to PNG or JPG first',
  corrupt: 'file is corrupt or unreadable',
}
/** 第 n 张（从 1 起）原图被拒的说明。 */
export const imageRejectText = (n: number, reason: ImagePrepFailure): string => `image ${n}: ${IMAGE_REASON[reason]}`

export type LookFailKind = DrawFailKind | 'upload'

const FAIL_ADVICE: Record<LookFailKind, string> = {
  unreachable: 'the image service stopped answering',
  'missing-node': 'the image service lacks a node the workflow needs',
  'missing-model': 'the image service lacks a model the workflow needs',
  timeout: 'drawing took too long',
  cancelled: 'drawing was cancelled',
  upload: 'the reference picture could not be uploaded',
  other: 'drawing failed',
}
/** 出图失败：先说类别，再说怎么办（不带服务端原文）。 */
export const lookFailText = (kind: LookFailKind): string =>
  `failed: ${kind} (${FAIL_ADVICE[kind]}); tell the user, and ${HOW_TO_CHECK} for details. Do not retry on your own.`

/** 成功：候选编号、图片行、怎么跟用户说。 */
export function lookDrawnText(n: number, absPath: string, remindBack: boolean): string {
  return `look candidate ${n} drawn. Now write your reply to the user and put the line below alone as the last line of it, exactly as it is, `
    + 'then ask whether to use this one or what to change. '
    + (remindBack ? 'Also remind the user to check the side and back views against what they have in mind. ' : '')
    + 'Do not call aha_look_save until the user says it is fine.\n'
    + imageLine(absPath)
}

// ---------- 流程 ----------

export interface DraftEnv {
  rt: Pick<Runtime, 'log' | 'builtinWorkflowDir'>
  /** 现读生图配置。 */
  loadService(): Promise<ImageServiceResult>
  /** 探测服务；不可达时抛出。 */
  probe(endpoint: string, timeoutMs: number): Promise<void>
  createClient(endpoint: string): Pick<ComfyClient, 'generate' | 'uploadImage'>
  uploader: RefUploader
  /** 展开 ~ 用的 home 目录。 */
  homeDir: string
  /** 0 到 1 之间的随机数 */
  random?: () => number
  now?: () => number
}

export interface DraftInput {
  session: string
  charDir: string
  appearance: string
  start: DraftStart
  /** 已去首尾空白；可为空串 */
  note: string
  signal?: AbortSignal
}

export type DraftOutcome =
  | { ok: true; text: string; n: number; absPath: string }
  | { ok: false; text: string }

const no = (text: string): DraftOutcome => ({ ok: false, text })
const isPng = (b: Uint8Array): boolean => b.length >= PNG_SIGNATURE.length && Buffer.from(b.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE)

function failKind(e: unknown, signal?: AbortSignal): LookFailKind {
  if (e instanceof ComfyError && e.kind === 'upload-failed') return 'upload'
  if (signal?.aborted) return 'cancelled'
  return failKindOf(e)
}

const detailOf = (e: unknown): string => (e instanceof ComfyError ? e.detail || e.message : (e as Error)?.message ?? String(e))

/** 在已校验的参数上生成一张候选。日志里不出现用户给的路径。 */
export async function runDraft(env: DraftEnv, p: DraftInput): Promise<DraftOutcome> {
  const log = env.rt.log
  const now = env.now ?? Date.now
  const random = env.random ?? Math.random
  const started = now()

  const svc = await env.loadService()
  if (!svc.configured) return no(LOOK_TEXT.notConfigured)
  const s = svc.settings
  try {
    await env.probe(s.endpoint, PROBE_TIMEOUT_MS)
  } catch (e) {
    log.info(`会话 ${p.session}：定妆探测生图服务 ${hostOf(s.endpoint)} 失败`)
    log.debug(`定妆探测失败原文：${detailOf(e)}`)
    return no(LOOK_TEXT.unreachable)
  }

  let wf
  try {
    wf = await loadWorkflow(s.workflow, env.rt.builtinWorkflowDir)
  } catch (e) {
    log.warn(`会话 ${p.session}：定妆读取工作流失败：${(e as Error).message}`)
    return no(lookFailText('other'))
  }
  const needRefs = p.start.kind !== 'text'
  if (needRefs && !wf.refs) return no(LOOK_TEXT.noRefs)
  if (p.start.kind === 'images' && wf.refs && p.start.paths.length > wf.refs.max) return no(LOOK_TEXT.tooManyRefs(wf.refs.max))

  // 起点材料：原图逐张预处理，任一张被拒就整体返回；候选读字节
  let refs: Uint8Array[] = []
  let lookId: string | undefined
  if (p.start.kind === 'images') {
    for (const [i, file] of p.start.paths.entries()) {
      const r = await prepareImage(file, { homeDir: env.homeDir })
      if (!r.ok) return no(imageRejectText(i + 1, r.reason))
      refs.push(r.png)
    }
  } else if (p.start.kind === 'draft') {
    const d = await getDraft(p.charDir, p.start.basedOn)
    const bytes = d ? await readPngBytes(d.file) : null
    if (!bytes) return no(LOOK_TEXT.noSuchCandidate(p.start.basedOn))
    refs = [bytes]
  } else if (p.start.kind === 'look') {
    const r = await resolveLook(p.charDir, p.start.look)
    const bytes = r.ok ? await readPngBytes(r.file) : null
    if (!r.ok || !bytes) return no(LOOK_TEXT.noSuchLook)
    refs = [bytes]
    lookId = r.look
  }

  const { width, height } = sheetSize(s.width, s.height)
  const seed = Math.floor(random() * 2 ** 32)
  const prompt = lookPrompt(p.start, { style: s.style, appearance: p.appearance, note: p.note })
  const summary = `${width}x${height} steps=${s.steps} start=${p.start.kind} refs=${refs.length}`
  const client = env.createClient(s.endpoint)
  const sig = p.signal ? { signal: p.signal } : {}
  const upload = (d: Uint8Array, n: string, o?: { timeoutMs?: number; signal?: AbortSignal }) => client.uploadImage(d, n, o)
  const names = (): Promise<string[]> => Promise.all(refs.map((b) => env.uploader.ensure(s.endpoint, b, upload, sig)))
  const draw = async (refNames: string[]) => client.generate(
    fillWorkflow(wf, {
      prompt, width, height, seed, steps: s.steps, models: s.models, ...(refNames.length > 0 ? { refs: refNames } : {}),
    }),
    { outputNode: wf.output, timeoutMs: s.timeoutSeconds * 1000, pollMs: POLL_MS, ...sig },
  )

  try {
    let image
    if (refs.length === 0) image = await draw([])
    else {
      try {
        image = await draw(await names())
      } catch (e) {
        if (!(e instanceof ComfyError && e.kind === 'missing-ref')) throw e
        // 服务端说参考图不存在：忘掉记账，重传再来一次
        log.debug(`会话 ${p.session}（${hostOf(s.endpoint)}）：服务端说参考图不存在，重传一次`)
        for (const b of refs) env.uploader.forget(s.endpoint, b)
        image = await draw(await names())
      }
    }
    if (!isPng(image.bytes)) {
      log.warn(`会话 ${p.session}：定妆出的图不是 PNG（${image.ext}），不存为候选`)
      return no(lookFailText('other'))
    }
    const origin: DraftOrigin = p.start.kind === 'text' ? 'text' : p.start.kind
    const saved = await addDraft(p.charDir, image.bytes, {
      origin, prompt, seed, ...(p.note !== '' ? { note: p.note } : {}), ...(p.start.kind === 'draft' ? { basedOn: p.start.basedOn } : {}),
      ...(lookId !== undefined ? { basedOnLook: lookId } : {}),
    })
    if (/[\r\n]/.test(saved.file)) throw new Error('图片路径含换行符')
    log.info(`会话 ${p.session}：定妆候选 n=${saved.record.n} ${now() - started}ms ${summary}`)
    const remindBack = p.start.kind === 'text' || (p.start.kind === 'images' && p.start.paths.length === 1)
    return { ok: true, text: lookDrawnText(saved.record.n, saved.file, remindBack), n: saved.record.n, absPath: saved.file }
  } catch (e) {
    const kind = failKind(e, p.signal)
    log.info(`会话 ${p.session}：定妆出图失败 ${kind} ${now() - started}ms ${summary}`)
    log.debug(`定妆出图失败原文：${detailOf(e)}`)
    return no(lookFailText(kind))
  }
}
