// 外部服务配置：从独立的 services.yaml 读出生图（image）与语音（voice）两节的设置，两节互不影响。
// 文件不存在、没有对应一节、没有 endpoint 都算"没配置"；字段类型不对时回落默认值并记入问题清单。
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

/** 读文件并解析 YAML；不可用时直接给出"未配置"的结果。 */
async function readServicesDoc(
  file: string,
): Promise<{ ok: true; doc: unknown } | { ok: false; problems: string[] }> {
  let raw: string
  try {
    raw = await fs.readFile(expandHome(file), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, problems: [] }
    return { ok: false, problems: ['服务配置文件无法读取'] }
  }
  if (!raw.trim()) return { ok: false, problems: [] }
  try {
    return { ok: true, doc: YAML.parse(raw) }
  } catch {
    return { ok: false, problems: ['服务配置文件解析失败，请检查 YAML 语法'] }
  }
}

/** 地址里是否带了用户名或密码。 */
export function hasUserInfo(endpoint: string): boolean {
  try {
    const u = new URL(endpoint)
    return u.username !== '' || u.password !== ''
  } catch {
    return false
  }
}

/** 读取并校验生图服务配置。问题清单只写字段名，不回显字段值。 */
export async function loadImageService(file: string): Promise<ImageServiceResult> {
  const read = await readServicesDoc(file)
  if (!read.ok) return { configured: false, problems: read.problems }
  const doc = read.doc
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

export interface VoiceServiceSettings {
  /** 服务地址，已去掉末尾斜杠。 */
  endpoint: string
  /** mlx：允许插件代为启动本机服务；none：只连接。 */
  launch: 'mlx' | 'none'
  /** 解析后的完整模型名。 */
  model: string
  /** 用户写的是 0.6b / 1.7b 简称时保留简称，否则为 undefined。 */
  modelAlias?: string
  /** 运行环境与权重的存放目录，绝对路径。 */
  modelsDir: string
  /** 权重下载源，已去掉末尾斜杠；不写则用官方。 */
  hfEndpoint?: string
  read: 'lines' | 'all'
  language: string
  timeoutSeconds: number
  /** 从 endpoint 解析出的端口；没写端口时按协议取 80 / 443。 */
  port: number
  /** endpoint 是否本机地址。 */
  local: boolean
}

export type VoiceServiceResult =
  | { configured: false; problems: string[] }
  | { configured: true; settings: VoiceServiceSettings; problems: string[] }

export const VOICE_MODELS = {
  '0.6b': 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit',
  '1.7b': 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit',
} as const

/** 音色设计固定使用的模型。 */
export const VOICE_DESIGN_MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit'

export const VOICE_SERVICE_DEFAULTS = {
  launch: 'none',
  model: '0.6b',
  read: 'lines',
  language: 'chinese',
  timeoutSeconds: 120,
} as const

export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 读取并校验语音服务配置。问题清单只写字段名，不回显字段值。 */
export async function loadVoiceService(
  file: string,
  opts: { defaultModelsDir: string },
): Promise<VoiceServiceResult> {
  const read = await readServicesDoc(file)
  if (!read.ok) return { configured: false, problems: read.problems }
  const doc = read.doc
  const problems: string[] = []
  if (!isRecord(doc) || doc.voice === undefined || doc.voice === null) return { configured: false, problems }
  const voice = doc.voice
  if (!isRecord(voice)) return { configured: false, problems: ['voice 一节的格式不对'] }

  if (voice.endpoint === undefined || voice.endpoint === null || voice.endpoint === '') {
    return { configured: false, problems }
  }
  const endpoint = typeof voice.endpoint === 'string' ? voice.endpoint.trim() : ''
  let url: URL | undefined
  if (/^https?:\/\/\S+$/.test(endpoint)) {
    try {
      url = new URL(endpoint)
    } catch {
      url = undefined
    }
  }
  if (!url) return { configured: false, problems: ['voice.endpoint 必须是 http:// 或 https:// 开头的地址'] }

  const d = VOICE_SERVICE_DEFAULTS
  const pick = <T>(key: string, ok: (v: unknown) => v is T, fallback: T, hint: string): T => {
    const v = voice[key]
    if (v === undefined || v === null) return fallback
    if (ok(v)) return v
    problems.push(`voice.${key} ${hint}，已改用默认值`)
    return fallback
  }
  const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
  const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

  const local = LOCAL_HOSTS.has(url.hostname)
  let launch = pick('launch', (v): v is 'mlx' | 'none' => v === 'mlx' || v === 'none', d.launch, '应是 mlx 或 none')
  if (launch === 'mlx' && !local) {
    problems.push('voice.launch 为 mlx 时 endpoint 必须是本机地址，已改为 none')
    launch = 'none'
  }

  const modelText = pick('model', isText, d.model, '应是 0.6b、1.7b 或完整的模型名').trim()
  const alias = modelText.toLowerCase()
  const isAlias = alias === '0.6b' || alias === '1.7b'

  let hfEndpoint: string | undefined
  if (voice.hfEndpoint !== undefined && voice.hfEndpoint !== null) {
    const h = typeof voice.hfEndpoint === 'string' ? voice.hfEndpoint.trim() : ''
    if (/^https?:\/\/\S+$/.test(h)) hfEndpoint = h.replace(/\/+$/, '')
    else problems.push('voice.hfEndpoint 必须是 http:// 或 https:// 开头的地址，已忽略')
  }

  let modelsDir = expandHome(opts.defaultModelsDir)
  if (voice.modelsDir !== undefined && voice.modelsDir !== null) {
    const m = typeof voice.modelsDir === 'string' ? expandHome(voice.modelsDir.trim()) : ''
    if (path.isAbsolute(m)) modelsDir = m
    else problems.push('voice.modelsDir 应是绝对路径（可以用 ~ 开头），已改用默认值')
  }

  return {
    configured: true,
    problems,
    settings: {
      endpoint: endpoint.replace(/\/+$/, ''),
      launch,
      model: isAlias ? VOICE_MODELS[alias as keyof typeof VOICE_MODELS] : modelText,
      modelAlias: isAlias ? alias : undefined,
      modelsDir,
      hfEndpoint,
      read: pick('read', (v): v is 'lines' | 'all' => v === 'lines' || v === 'all', d.read, '应是 lines 或 all'),
      language: pick('language', isText, d.language, '应是非空文字'),
      timeoutSeconds: pick('timeoutSeconds', isPositiveInt, d.timeoutSeconds, '应是正整数'),
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      local,
    },
  }
}
