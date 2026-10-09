// 称呼主题：加载主题文件，按固定标识取给用户看的称呼；缺项回退到直白主题。
// core 不打日志，回退通过返回值里的 warnings 告知调用方。
import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { AhaError } from './errors'
import { ACTION_IDS, CONCEPT_IDS, type ActionId, type ConceptId } from './terms'

const FALLBACK_THEME = 'plain'
const THEME_NAME_RE = /^[a-z0-9_-]+$/i

export interface HostInfo {
  name: string
  aliases: string[]
}

export interface Theme {
  readonly name: string
  concept(id: ConceptId): string
  action(id: ActionId): string
  /** 掌柜的名字与别称。名字取自 concepts.host。 */
  host(): HostInfo
  persona(): string
}

interface RawTheme {
  concepts: Partial<Record<ConceptId, string>>
  actions: Partial<Record<ActionId, string>>
  aliases?: string[]
  persona?: string
}

export interface LoadThemeOptions {
  /** 内置主题名；也可与 file 同给，file 优先。 */
  name: string
  /** 用户自定义主题文件路径（已展开 ~）。 */
  file?: string
  /** 内置主题目录，由外壳传入。 */
  builtinDir: string
}

export interface LoadThemeResult {
  theme: Theme
  warnings: string[]
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function pick<K extends string>(ids: readonly K[], src: unknown): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (src === null || typeof src !== 'object') return out
  const rec = src as Record<string, unknown>
  for (const id of ids) {
    const v = rec[id]
    if (nonEmptyString(v)) out[id] = v.trim()
  }
  return out
}

async function readRaw(file: string): Promise<RawTheme> {
  const doc: unknown = parse(await fs.readFile(file, 'utf8'))
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('主题文件顶层必须是映射')
  }
  const d = doc as Record<string, unknown>
  const host = d.host as Record<string, unknown> | null | undefined
  const rawAliases = host && typeof host === 'object' ? host.aliases : undefined
  return {
    concepts: pick(CONCEPT_IDS, d.concepts),
    actions: pick(ACTION_IDS, d.actions),
    aliases: Array.isArray(rawAliases) ? rawAliases.filter(nonEmptyString).map((s) => s.trim()) : undefined,
    persona: nonEmptyString(d.persona) ? d.persona.trim() : undefined,
  }
}

function build(name: string, base: RawTheme, over?: RawTheme): Theme {
  const concepts = { ...base.concepts, ...over?.concepts } as Record<ConceptId, string>
  const actions = { ...base.actions, ...over?.actions } as Record<ActionId, string>
  const aliases = over?.aliases ?? base.aliases ?? []
  const persona = over?.persona ?? base.persona ?? ''
  return {
    name,
    concept: (id) => concepts[id],
    action: (id) => actions[id],
    host: () => ({ name: concepts.host, aliases: [...aliases] }),
    persona: () => persona,
  }
}

async function loadPlain(builtinDir: string): Promise<RawTheme> {
  const file = path.join(builtinDir, `${FALLBACK_THEME}.yaml`)
  let raw: RawTheme
  try {
    raw = await readRaw(file)
  } catch (e) {
    throw new AhaError('theme-invalid', `内置直白主题无法读取：${file}`, { cause: e })
  }
  const missing = [
    ...CONCEPT_IDS.filter((id) => !raw.concepts[id]),
    ...ACTION_IDS.filter((id) => !raw.actions[id]),
  ]
  if (missing.length > 0) {
    throw new AhaError('theme-invalid', `内置直白主题缺少标识：${missing.join(', ')}`)
  }
  return raw
}

export async function loadTheme(opts: LoadThemeOptions): Promise<LoadThemeResult> {
  const warnings: string[] = []
  const plain = await loadPlain(opts.builtinDir)

  let file: string | undefined
  let label = opts.name
  if (opts.file) {
    file = opts.file
    label = opts.file
  } else if (opts.name !== FALLBACK_THEME) {
    if (!THEME_NAME_RE.test(opts.name)) {
      warnings.push(`主题名不合法：${opts.name}，已回退到直白主题`)
    } else {
      file = path.join(opts.builtinDir, `${opts.name}.yaml`)
    }
  }
  if (!file) return { theme: build(FALLBACK_THEME, plain), warnings }

  try {
    const over = await readRaw(file)
    return { theme: build(opts.file ? 'custom' : opts.name, plain, over), warnings }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    warnings.push(
      code === 'ENOENT'
        ? `主题不存在：${label}，已回退到直白主题`
        : `主题文件无法解析：${label}（${(e as Error).message}），已回退到直白主题`,
    )
    return { theme: build(FALLBACK_THEME, plain), warnings }
  }
}
