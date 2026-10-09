// 插件配置：类型、默认值与合并逻辑。

/** 模式：筹备 / 单聊。 */
export type TavernMode = 'setup' | 'chat'

export interface TavernConfig {
  /** 本插件实例挂在哪个酒馆模式里。 */
  mode: TavernMode
  /** 主题（文案风格），默认 fools。 */
  theme: string
  /** 世界观预算（字）。 */
  worldBudget: number
  /** 主线记忆篇幅上限（字）。 */
  memoryMaxChars: number
  /** 主线记忆"关键的事"条数上限。 */
  keyFactsMax: number
  /** 往事梗概"往事索引"行数上限。 */
  pastIndexMaxLines: number
  /** 每隔多少轮审视一次记忆。 */
  reviewIntervalTurns: number
  /** 回忆工具单次节选上限（字）。 */
  recallExcerptMaxChars: number
  /** 全局登记表路径，支持 ~ 开头。 */
  registryPath: string
}

export const DEFAULTS: TavernConfig = {
  mode: 'chat',
  theme: 'fools',
  worldBudget: 4000,
  memoryMaxChars: 3000,
  keyFactsMax: 100,
  pastIndexMaxLines: 100,
  reviewIntervalTurns: 30,
  recallExcerptMaxChars: 2000,
  registryPath: '~/.dsh/aha-tavern/taverns.yaml',
}

const MODES: readonly TavernMode[] = ['setup', 'chat']

/** 把用户配置与默认值合并：未知字段丢弃，类型不对的字段回落默认值。 */
export function resolveConfig(input: unknown): TavernConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: TavernConfig = { ...DEFAULTS }

  if (MODES.includes(raw.mode as TavernMode)) out.mode = raw.mode as TavernMode
  if (typeof raw.theme === 'string' && raw.theme) out.theme = raw.theme
  if (typeof raw.registryPath === 'string' && raw.registryPath) out.registryPath = raw.registryPath

  const numericKeys = [
    'worldBudget',
    'memoryMaxChars',
    'keyFactsMax',
    'pastIndexMaxLines',
    'reviewIntervalTurns',
    'recallExcerptMaxChars',
  ] as const
  for (const key of numericKeys) {
    const v = raw[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = v
  }
  return out
}
