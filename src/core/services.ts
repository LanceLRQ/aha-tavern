// 外部服务配置：从独立的 services.yaml 读出生图服务的设置。
// 文件不存在、没有 image、没有 endpoint 都算"没配置"；字段类型不对时回落默认值并记入问题清单。
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { expandHome } from './fsx'

export interface ImageServiceSettings {
  /** 服务地址，已去掉末尾斜杠。 */
  endpoint: string
  /** 内置工作流名，或工作流文件的绝对路径。 */
  workflow: string
  /** 角色能否自己决定出图；false 时只响应用户要求。 */
  auto: boolean
  /** 拼在每个提示词最前面的画风。 */
  style: string
  width: number
  height: number
  steps: number
  timeoutSeconds: number
  /** 覆盖工作流里的默认模型文件名。 */
  models: { unet?: string; clip?: string; vae?: string }
}

export type ImageServiceResult =
  | { configured: false; problems: string[] }
  | { configured: true; settings: ImageServiceSettings; problems: string[] }

export const IMAGE_SERVICE_DEFAULTS: Omit<ImageServiceSettings, 'endpoint'> = {
  workflow: 'qwen-image-2.1',
  auto: true,
  style: '动漫风格插画，线条干净，光影柔和',
  width: 832,
  height: 1216,
  steps: 12,
  timeoutSeconds: 180,
  models: {},
}

const MODEL_KEYS = ['unet', 'clip', 'vae'] as const
const MIN_SIDE = 256
const SIDE_STEP = 32
const BUILTIN_NAME = /^[A-Za-z0-9][\w.-]*$/

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 读取并校验生图服务配置。问题清单只写字段名，不回显字段值。 */
export async function loadImageService(file: string): Promise<ImageServiceResult> {
  let raw: string
  try {
    raw = await fs.readFile(expandHome(file), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { configured: false, problems: [] }
    return { configured: false, problems: ['服务配置文件无法读取'] }
  }
  if (!raw.trim()) return { configured: false, problems: [] }

  let doc: unknown
  try {
    doc = YAML.parse(raw)
  } catch {
    return { configured: false, problems: ['服务配置文件解析失败，请检查 YAML 语法'] }
  }
  const problems: string[] = []
  if (!isRecord(doc) || doc.image === undefined || doc.image === null) return { configured: false, problems }
  const image = doc.image
  if (!isRecord(image)) return { configured: false, problems: ['image 一节的格式不对'] }

  if (image.endpoint === undefined || image.endpoint === null || image.endpoint === '') {
    return { configured: false, problems }
  }
  const endpoint = typeof image.endpoint === 'string' ? image.endpoint.trim() : ''
  if (!/^https?:\/\/\S+$/.test(endpoint)) {
    return { configured: false, problems: ['image.endpoint 必须是 http:// 或 https:// 开头的地址'] }
  }

  const d = IMAGE_SERVICE_DEFAULTS
  const pick = <T>(key: string, ok: (v: unknown) => v is T, fallback: T, hint: string): T => {
    const v = image[key]
    if (v === undefined || v === null) return fallback
    if (ok(v)) return v
    problems.push(`image.${key} ${hint}，已改用默认值`)
    return fallback
  }
  const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
  const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
  const isWorkflow = (v: unknown): v is string =>
    typeof v === 'string' && (path.isAbsolute(v) || BUILTIN_NAME.test(v))
  const snap = (n: number) => Math.max(MIN_SIDE, Math.floor(n / SIDE_STEP) * SIDE_STEP)

  return {
    configured: true,
    problems,
    settings: {
      endpoint: endpoint.replace(/\/+$/, ''),
      workflow: pick('workflow', isWorkflow, d.workflow, '应是内置工作流名或绝对路径'),
      auto: pick('auto', isBool, d.auto, '应是 true 或 false'),
      style: pick('style', isText, d.style, '应是非空文字'),
      width: snap(pick('width', isPositiveInt, d.width, '应是正整数')),
      height: snap(pick('height', isPositiveInt, d.height, '应是正整数')),
      steps: pick('steps', isPositiveInt, d.steps, '应是正整数'),
      timeoutSeconds: pick('timeoutSeconds', isPositiveInt, d.timeoutSeconds, '应是正整数'),
      models: readModels(image.models, problems),
    },
  }
}

function readModels(v: unknown, problems: string[]): ImageServiceSettings['models'] {
  if (v === undefined || v === null) return {}
  if (!isRecord(v)) {
    problems.push('image.models 应是键值映射，已忽略')
    return {}
  }
  const out: ImageServiceSettings['models'] = {}
  for (const [k, val] of Object.entries(v)) {
    if (!(MODEL_KEYS as readonly string[]).includes(k)) {
      problems.push(`image.models.${k} 不是可识别的键（只认 unet、clip、vae），已忽略`)
    } else if (typeof val === 'string' && val.trim()) {
      out[k as (typeof MODEL_KEYS)[number]] = val.trim()
    } else {
      problems.push(`image.models.${k} 应是文件名文字，已忽略`)
    }
  }
  return out
}
