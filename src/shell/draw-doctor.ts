// 自检的"生图"一段：逐项检查生图服务、工作流、节点、模型，可选试出一张图。
// 不依赖宿主：依赖全部注入，返回结构化结果；回执文字由 receipts.ts 渲染。不调用模型。
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ComfyError, type ComfyClient } from '../core/comfy'
import type { ImageServiceResult, ImageServiceSettings } from '../core/services'
import { fillWorkflow, loadWorkflow, requirementsOf } from '../core/workflow'
import { hostOf } from './draw'
import type { Log } from './runtime'

/** 自检里各请求的超时（毫秒）。 */
export const DOCTOR_PROBE_TIMEOUT_MS = 5000
export const DOCTOR_OBJECT_INFO_TIMEOUT_MS = 15_000
const TRIAL_POLL_MS = 1000
export const TRIAL_PROMPT = '一只橘猫趴在木质吧台上，暖色灯光'

export type DoctorFailKind = 'unreachable' | 'missing-node' | 'missing-model' | 'timeout' | 'cancelled' | 'save' | 'other'

export interface MissingModel {
  file: string
  dir?: string
  url?: string
}

export interface DrawDoctorReport {
  /** 检查中途收到取消信号。 */
  cancelled?: boolean
  configured: boolean
  /** 配置问题清单（未配置时是为什么没读成；已配置时是回落了默认值的字段）。 */
  problems: string[]
  service?: { host: string; connected: boolean; version?: string; failKind?: DoctorFailKind; credentials?: boolean }
  workflow?: { name: string; ok: boolean; reason?: string }
  /** error 有值表示没能读到节点信息，其余项不再检查。 */
  nodes?: { total: number; missing: string[]; error?: DoctorFailKind }
  models?: { missing: MissingModel[]; unsure: string[] }
  /** 没请求试出图时为 undefined。 */
  trial?:
    | { status: 'ok'; seconds: number; path: string }
    | { status: 'failed'; kind: DoctorFailKind }
    | { status: 'skipped' }
}

export interface DrawDoctorDeps {
  loadService(): Promise<ImageServiceResult>
  createClient(endpoint: string): ComfyClient
  builtinWorkflowDir: string
  tmpDir: string
  now(): number
  /** 0 到 1 之间的随机数 */
  random(): number
  log: Pick<Log, 'debug'>
}

export interface DrawDoctorOptions {
  /** 是否在全部通过后试出一张图。 */
  trial: boolean
  signal?: AbortSignal
}

/** 自检参数是否在要求试出图：`生图` 或 `image`（不分大小写）。 */
export function wantsTrial(args: string): boolean {
  const a = args.trim()
  return a === '生图' || a.toLowerCase() === 'image'
}

function failKindOf(e: unknown): DoctorFailKind {
  if (!(e instanceof ComfyError)) return 'other'
  switch (e.kind) {
    case 'unreachable':
    case 'missing-node':
    case 'missing-model':
    case 'timeout':
    case 'cancelled':
      return e.kind
    default:
      return 'other'
  }
}

/** 日志里不留地址中的用户名和密码。 */
export const redactUrls = (text: string): string => text.replace(/(https?:\/\/)[^\s/@]*@/gi, '$1')

const describe = (e: unknown): string => redactUrls(e instanceof ComfyError ? e.detail || e.message : (e as Error).message)

const VERSION_MAX = 40
/** 服务端返回的版本号：去掉控制字符，截断。 */
function cleanVersion(v: string): string {
  const s = [...v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')].slice(0, VERSION_MAX).join('').trim()
  // 只认版本号的样子；别的内容（比如网址，卡片里会变成可点击的链接）一律当作版本未知
  return /^v?\d[0-9A-Za-z.+_-]*$/.test(s) ? s : ''
}

function hasUserInfo(endpoint: string): boolean {
  try {
    const u = new URL(endpoint)
    return u.username !== '' || u.password !== ''
  } catch {
    return false
  }
}

export async function checkDrawing(deps: DrawDoctorDeps, opts: DrawDoctorOptions): Promise<DrawDoctorReport> {
  const svc = await deps.loadService()
  if (!svc.configured) return { configured: false, problems: svc.problems }
  const settings = svc.settings
  const report: DrawDoctorReport = { configured: true, problems: svc.problems }
  const host = hostOf(settings.endpoint)
  const stopped = (): boolean => {
    if (opts.signal?.aborted) report.cancelled = true
    return report.cancelled === true
  }
  if (hasUserInfo(settings.endpoint)) {
    report.service = { host, connected: false, credentials: true }
    return report
  }
  if (stopped()) return report
  const client = deps.createClient(settings.endpoint)

  try {
    const version = await client.probe(DOCTOR_PROBE_TIMEOUT_MS)
    report.service = { host, connected: true, version: cleanVersion(version) }
  } catch (e) {
    deps.log.debug(`自检：探测 ${host} 失败：${describe(e)}`)
    if (stopped()) return report
    report.service = { host, connected: false, failKind: failKindOf(e) }
    return report
  }
  if (stopped()) return report

  let wf: Awaited<ReturnType<typeof loadWorkflow>>
  const wfName = path.isAbsolute(settings.workflow) ? path.basename(settings.workflow) : settings.workflow
  try {
    wf = await loadWorkflow(settings.workflow, deps.builtinWorkflowDir)
    report.workflow = { name: wfName, ok: true }
  } catch (e) {
    report.workflow = { name: wfName, ok: false, reason: (e as Error).message.split(settings.workflow).join(wfName) }
    return report
  }
  if (stopped()) return report
  const req = requirementsOf(wf, { models: settings.models })

  let info: Awaited<ReturnType<ComfyClient['objectInfo']>>
  try {
    info = await client.objectInfo({
      timeoutMs: DOCTOR_OBJECT_INFO_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (e) {
    deps.log.debug(`自检：读取节点信息失败：${describe(e)}`)
    if (stopped()) return report
    report.nodes = { total: req.nodeTypes.length, missing: [], error: failKindOf(e) }
    return report
  }
  if (stopped()) return report
  const missingNodes = req.nodeTypes.filter((t) => !(t in info))
  report.nodes = { total: req.nodeTypes.length, missing: missingNodes }

  if (missingNodes.length === 0) {
    const missing: MissingModel[] = []
    const unsure: string[] = []
    for (const m of req.models) {
      const options = info[m.nodeType]?.[m.input]
      if (!Array.isArray(options)) unsure.push(m.file)
      else if (!options.includes(m.file)) {
        missing.push({ file: m.file, ...(m.dir ? { dir: m.dir } : {}), ...(m.url ? { url: m.url } : {}) })
      }
    }
    report.models = { missing, unsure }
  }

  if (opts.trial) {
    if (stopped()) return report
    const allPassed = missingNodes.length === 0 && report.models!.missing.length === 0
    report.trial = allPassed ? await trialDraw(deps, client, settings, wf, opts.signal) : { status: 'skipped' }
  }
  return report
}

async function trialDraw(
  deps: DrawDoctorDeps, client: ComfyClient, settings: ImageServiceSettings,
  wf: Awaited<ReturnType<typeof loadWorkflow>>, signal: AbortSignal | undefined,
): Promise<NonNullable<DrawDoctorReport['trial']>> {
  const started = deps.now()
  try {
    const graph = fillWorkflow(wf, {
      prompt: TRIAL_PROMPT, width: settings.width, height: settings.height, steps: settings.steps,
      seed: Math.floor(deps.random() * 2 ** 32), models: settings.models,
    })
    const image = await client.generate(graph, {
      outputNode: wf.output, timeoutMs: settings.timeoutSeconds * 1000, pollMs: TRIAL_POLL_MS, ...(signal ? { signal } : {}),
    })
    const finished = deps.now()
    const file = path.join(deps.tmpDir, `aha-tavern-doctor-${finished}-${randomBytes(4).toString('hex')}.${image.ext}`)
    try {
      await fs.writeFile(file, image.bytes, { flag: 'wx' })
    } catch (e) {
      deps.log.debug(`自检：试出图写盘失败：${describe(e)}`)
      return { status: 'failed', kind: 'save' }
    }
    return { status: 'ok', seconds: Math.max(0, Math.round((finished - started) / 1000)), path: file }
  } catch (e) {
    deps.log.debug(`自检：试出图失败：${describe(e)}`)
    return { status: 'failed', kind: failKindOf(e) }
  }
}
