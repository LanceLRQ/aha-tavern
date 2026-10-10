// 服务配置的写入：校验页面传来的表单、用 YAML 文档模式只改动要改的字段，保留注释与页面不认识的字段。
// 读取与回落默认值在 services.ts；这里不做回落，写进去的值都是校验过的。
import fs from 'node:fs/promises'
import YAML from 'yaml'
import { expandHome, modifyFile } from './fsx'
import { LOCAL_HOSTS, MAX_VOICE_PAUSE_SECONDS, MAX_VOICE_TIMEOUT_SECONDS, MIN_VOICE_PAUSE_SECONDS } from './services'

export type ServicesSection = 'voice' | 'image'

/** 一次改动：set 的键可以是 `models.unet` 这样的点号路径；remove 里的键删除（不存在则忽略）。 */
export interface SectionEdit {
  set: Record<string, string | number | boolean>
  remove: string[]
}

export type FormResult = { ok: true; edit: SectionEdit } | { ok: false; errors: Record<string, string> }

export class ServicesEditError extends Error {
  readonly code: 'parse' | 'format' | 'invalid'
  /** code 为 invalid 时按字段给出的错误。 */
  readonly errors: Record<string, string>
  constructor(code: 'parse' | 'format' | 'invalid', message: string, errors: Record<string, string> = {}) {
    super(message)
    this.name = 'ServicesEditError'
    this.code = code
    this.errors = errors
  }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const URL_SHAPE = /^https?:\/\/\S+$/
const MODEL_ALIAS = /^(0\.6b|1\.7b)$/i
const MODEL_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
/** 简称（0.6b、1.7b）或 `组织/名字`；每段只含字母数字与 -_.，不以 . 开头（也就不会是 . 或 ..）。 */
const isModelName = (v: string): boolean => {
  if (MODEL_ALIAS.test(v)) return true
  const parts = v.split('/')
  return parts.length === 2 && parts.every((p) => MODEL_SEGMENT.test(p))
}
const BUILTIN_WORKFLOW = /^[A-Za-z0-9][\w.-]*$/
const LANGUAGE = /^[A-Za-z][A-Za-z_-]{0,29}$/
const MODEL_FILE = /^[\w][\w .()+/-]{0,199}$/

class Form {
  readonly set: Record<string, string | number | boolean> = {}
  readonly remove: string[] = []
  readonly errors: Record<string, string> = {}
  constructor(readonly input: Record<string, unknown>) {}

  /** 取表单值：没传（undefined）返回 undefined，空白字符串返回 ''。其余类型原样给校验函数处理。 */
  private raw(key: string): unknown {
    const v = this.input[key]
    return typeof v === 'string' ? v.trim() : v
  }
  has(key: string): boolean {
    return this.input[key] !== undefined
  }
  fail(key: string, msg: string): void {
    this.errors[key] = msg
  }
  /** 文字字段：空串表示恢复默认（删除）。check 返回错误说明，通过返回 null；map 可改写入的值。 */
  text(key: string, setKey: string, check: (v: string) => string | null, map: (v: string) => string = (v) => v): void {
    const v = this.raw(key)
    if (v === undefined) return
    if (v === '') return void this.remove.push(setKey)
    if (typeof v !== 'string') return this.fail(key, '应是文字')
    if (CONTROL.test(v)) return this.fail(key, '不能含控制字符')
    const err = check(v)
    if (err) return this.fail(key, err)
    this.set[setKey] = map(v)
  }
  choice<T extends string>(key: string, allowed: readonly T[]): void {
    const v = this.raw(key)
    if (v === undefined) return
    if (v === '') return void this.remove.push(key)
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      return this.fail(key, `只能是 ${allowed.join('、')}`)
    }
    this.set[key] = v
  }
  int(key: string, min: number, max: number): void {
    const v = this.raw(key)
    if (v === undefined) return
    if (v === '') return void this.remove.push(key)
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
    if (!Number.isInteger(n) || n < min || n > max) return this.fail(key, `应是 ${min} 到 ${max} 之间的整数`)
    this.set[key] = n
  }
  /** 非负小数（如 2.5）；不接受负号、指数写法、NaN。 */
  num(key: string, min: number, max: number): void {
    const v = this.raw(key)
    if (v === undefined) return
    if (v === '') return void this.remove.push(key)
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN
    if (!Number.isFinite(n) || n < min || n > max) return this.fail(key, `应是 ${min} 到 ${max} 之间的数字`)
    this.set[key] = n
  }
  bool(key: string): void {
    const v = this.raw(key)
    if (v === undefined) return
    if (v === '') return void this.remove.push(key)
    if (v === true || v === 'true') this.set[key] = true
    else if (v === false || v === 'false') this.set[key] = false
    else this.fail(key, '应是 true 或 false')
  }
  result(): FormResult {
    return Object.keys(this.errors).length > 0 ? { ok: false, errors: this.errors } : { ok: true, edit: { set: this.set, remove: this.remove } }
  }
}

/** 检查 http(s) 地址：不带用户名密码，返回错误说明或 null；ok 时第二项是去掉末尾斜杠的规范写法。 */
function checkEndpoint(v: string): { error: string } | { value: string; url: URL } {
  if (v.length > 300 || !URL_SHAPE.test(v)) return { error: '必须是 http:// 或 https:// 开头的地址' }
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return { error: '必须是 http:// 或 https:// 开头的地址' }
  }
  if (url.username !== '' || url.password !== '') return { error: '地址里不能带用户名或密码' }
  return { value: v.replace(/\/+$/, ''), url }
}

/** 解析选项：partial 表示页面只提交了改动的字段，没带 endpoint 就是没改（必填与关联校验改在写文件的锁内做）。 */
export interface ParseOptions {
  partial?: boolean
}

function requireEndpoint(form: Form, opts: ParseOptions): URL | null {
  if (form.input.endpoint === undefined) {
    if (!opts.partial) form.fail('endpoint', '必填')
    return null
  }
  const raw = typeof form.input.endpoint === 'string' ? form.input.endpoint.trim() : ''
  if (raw === '') {
    form.fail('endpoint', '必填')
    return null
  }
  if (CONTROL.test(raw)) {
    form.fail('endpoint', '不能含控制字符')
    return null
  }
  const r = checkEndpoint(raw)
  if ('error' in r) {
    form.fail('endpoint', r.error)
    return null
  }
  form.set.endpoint = r.value
  return r.url
}

const isAbsoluteLike = (v: string): boolean => v === '~' || v.startsWith('~/') || v.startsWith('/')
const hasDotDot = (v: string): boolean => v.split('/').includes('..')

function toForm(input: unknown): Form | null {
  return input && typeof input === 'object' && !Array.isArray(input) ? new Form(input as Record<string, unknown>) : null
}

const NOT_OBJECT: FormResult = { ok: false, errors: { _: '提交的内容格式不对' } }

/** 校验语音表单。没传的字段不动，空串表示恢复默认（删除该字段）。页面不认识的键一律忽略。 */
export function parseVoiceForm(input: unknown, opts: ParseOptions = {}): FormResult {
  const form = toForm(input)
  if (!form) return NOT_OBJECT
  const url = requireEndpoint(form, opts)
  form.choice('launch', ['mlx', 'none'] as const)
  if (form.set.launch === 'mlx' && url && !LOCAL_HOSTS.has(url.hostname)) {
    form.fail('launch', '代为启动时地址必须是本机地址（127.0.0.1 或 localhost）')
  }
  form.text('model', 'model', (v) => (isModelName(v) && v.length <= 200 ? null : '应是 0.6b、1.7b 或完整的模型名'))
  form.text('modelsDir', 'modelsDir', (v) => {
    if (v.length > 500) return '太长'
    if (!isAbsoluteLike(v)) return '应是绝对路径（可以用 ~ 开头）'
    return hasDotDot(v) ? '路径里不能有 ..' : null
  })
  form.text('hfEndpoint', 'hfEndpoint', (v) => {
    const r = checkEndpoint(v)
    return 'error' in r ? r.error : null
  }, (v) => v.replace(/\/+$/, ''))
  form.choice('read', ['lines', 'all'] as const)
  form.text('language', 'language', (v) => (LANGUAGE.test(v) ? null : '只能是英文字母，如 chinese'))
  form.int('timeoutSeconds', 1, MAX_VOICE_TIMEOUT_SECONDS)
  form.num('pauseSeconds', MIN_VOICE_PAUSE_SECONDS, MAX_VOICE_PAUSE_SECONDS)
  return form.result()
}

/** 校验生图表单；规则同语音。三个模型文件名写成 `models.unet` 等点号路径。 */
export function parseImageForm(input: unknown, opts: ParseOptions = {}): FormResult {
  const form = toForm(input)
  if (!form) return NOT_OBJECT
  requireEndpoint(form, opts)
  form.text('workflow', 'workflow', (v) => {
    if (v.length > 500) return '太长'
    if (v.startsWith('/')) return hasDotDot(v) ? '路径里不能有 ..' : null
    return BUILTIN_WORKFLOW.test(v) ? null : '应是内置工作流名或绝对路径'
  })
  form.bool('auto')
  form.text('style', 'style', (v) => (v.length > 500 ? '太长（最多 500 字）' : null))
  form.int('width', 256, 4096)
  form.int('height', 256, 4096)
  form.int('steps', 1, 200)
  form.int('timeoutSeconds', 1, 3600)
  for (const key of ['unet', 'clip', 'vae'] as const) {
    form.text(key, `models.${key}`, (v) => (MODEL_FILE.test(v) && !hasDotDot(v) && !v.startsWith('/') ? null : '应是模型文件名（可带子目录，不能是绝对路径）'))
    // 错误要记在表单字段名上，不是点号路径
    const dotted = `models.${key}`
    if (form.errors[dotted]) {
      form.errors[key] = form.errors[dotted]!
      delete form.errors[dotted]
    }
  }
  return form.result()
}

// ---------- 写文件 ----------

const isMap = (v: unknown): v is YAML.YAMLMap => YAML.isMap(v)

/**
 * 在锁内读、改、原子写。只改 edit 里的字段：文件里的注释、别的节、页面不认识的字段都原样保留。
 * 文件有语法错误、根不是映射、目标节不是映射时拒绝改写（原文件不动）。
 */
export async function updateServicesFile(file: string, section: ServicesSection, edit: SectionEdit): Promise<void> {
  await modifyFile(expandHome(file), (current) => {
    const doc = current && current.trim() !== '' ? YAML.parseDocument(current) : new YAML.Document({})
    if (doc.errors.length > 0) throw new ServicesEditError('parse', '服务配置文件解析失败，请检查 YAML 语法')
    if (doc.contents === null) doc.contents = new YAML.YAMLMap() as unknown as typeof doc.contents
    if (!isMap(doc.contents)) throw new ServicesEditError('format', '服务配置文件的最外层应是键值映射')
    const existing = doc.get(section, true)
    if (existing === undefined || existing === null || (YAML.isScalar(existing) && existing.value === null)) {
      doc.set(section, doc.createNode({}))
    } else if (!isMap(existing)) {
      throw new ServicesEditError('format', `${section} 一节的格式不对，请先手工改成键值映射`)
    }
    for (const key of edit.remove) {
      const pathParts = [section, ...key.split('.')]
      if (doc.hasIn(pathParts)) doc.deleteIn(pathParts)
    }
    for (const [key, value] of Object.entries(edit.set)) {
      const parts = key.split('.')
      if (parts.length > 1) {
        const parent = [section, ...parts.slice(0, -1)]
        const node = doc.getIn(parent, true)
        if (node === undefined || node === null || (YAML.isScalar(node) && node.value === null)) doc.setIn(parent, doc.createNode({}))
        else if (!isMap(node)) throw new ServicesEditError('format', `${parent.join('.')} 的格式不对，请先手工改成键值映射`)
      }
      doc.setIn([section, ...parts], value)
    }
    checkRelations(doc, section, edit)
    // 删光了的 models 整段去掉
    const models = doc.getIn([section, 'models'], true)
    if (isMap(models) && models.items.length === 0) doc.deleteIn([section, 'models'])
    // lineWidth: 0 不折行，否则长字符串与长注释会被重排
    return doc.toString({ lineWidth: 0 })
  })
}

/** 在合并后的结果上做需要两个字段一起看的校验；不通过就抛错，调用方不会写文件。 */
function checkRelations(doc: YAML.Document, section: ServicesSection, edit: SectionEdit): void {
  const endpoint = doc.getIn([section, 'endpoint'])
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new ServicesEditError('invalid', '没有服务地址', { endpoint: '必填' })
  }
  if (section !== 'voice') return
  const touched = (k: string) => k in edit.set || edit.remove.includes(k)
  if (!touched('endpoint') && !touched('launch')) return // 现有值本来矛盾而没碰：读取端会降级，允许保存
  if (doc.getIn([section, 'launch']) !== 'mlx') return
  let host: string
  try {
    host = new URL(endpoint.trim()).hostname
  } catch {
    return
  }
  if (!LOCAL_HOSTS.has(host)) {
    const field = touched('launch') ? 'launch' : 'endpoint'
    throw new ServicesEditError('invalid', '代为启动时地址必须是本机地址', {
      [field]: '代为启动时地址必须是本机地址（127.0.0.1 或 localhost）',
    })
  }
}

// ---------- 读给表单用的原始取值 ----------

const VOICE_KEYS = ['endpoint', 'launch', 'model', 'modelsDir', 'hfEndpoint', 'read', 'language', 'timeoutSeconds', 'pauseSeconds'] as const
const IMAGE_KEYS = ['endpoint', 'workflow', 'auto', 'style', 'width', 'height', 'steps', 'timeoutSeconds'] as const
const MODEL_KEYS = ['unet', 'clip', 'vae'] as const

export interface ServicesForm {
  voice: Record<(typeof VOICE_KEYS)[number], string>
  image: Record<(typeof IMAGE_KEYS)[number] | (typeof MODEL_KEYS)[number], string>
  /** 读取失败的原因（文件坏了等）；一切正常为空。 */
  problems: string[]
}

const asText = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''

/** 把文件里各字段原样（字符串化）读出来给表单显示；不回落默认值，没写的就是空串。 */
export async function readServicesForm(file: string): Promise<ServicesForm> {
  const empty = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, ''])) as Record<string, string>
  const out: ServicesForm = {
    voice: empty(VOICE_KEYS) as ServicesForm['voice'],
    image: empty([...IMAGE_KEYS, ...MODEL_KEYS]) as ServicesForm['image'],
    problems: [],
  }
  let raw: string
  try {
    raw = await fs.readFile(expandHome(file), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.problems.push('服务配置文件无法读取')
    return out
  }
  let doc: unknown
  try {
    doc = raw.trim() ? YAML.parse(raw) : null
  } catch {
    out.problems.push('服务配置文件解析失败，请检查 YAML 语法')
    return out
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return out
  const d = doc as Record<string, unknown>
  const voice = d.voice
  if (voice && typeof voice === 'object' && !Array.isArray(voice)) {
    for (const k of VOICE_KEYS) out.voice[k] = asText((voice as Record<string, unknown>)[k])
  }
  const image = d.image
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    const im = image as Record<string, unknown>
    for (const k of IMAGE_KEYS) out.image[k] = asText(im[k])
    const models = im.models
    if (models && typeof models === 'object' && !Array.isArray(models)) {
      for (const k of MODEL_KEYS) out.image[k] = asText((models as Record<string, unknown>)[k])
    }
  }
  return out
}
