// 插件配置：类型、默认值与合并逻辑。

/** 模式：筹备 / 单聊 / 群聊 / 写书。 */
export type TavernMode = 'setup' | 'chat' | 'group' | 'book'

/** 插件实例的角色：四个酒馆模式，外加挂在根层、只为"插件"页的设置页服务的 settings。 */
export type PluginMode = TavernMode | 'settings'

export interface TavernConfig {
  /** 本插件实例挂在哪个酒馆模式里；settings 是根层的设置页实例，不注册命令与工具。 */
  mode: PluginMode
  /** 主题（文案风格），默认 fools。 */
  theme: string
  /** 世界观预算（字）。 */
  worldBudget: number
  /** 主线记忆篇幅上限（字）。 */
  memoryMaxChars: number
  /** 主线记忆"关键的事"条数上限。 */
  keyFactsMax: number
  /** 主线记忆"往事索引"行数上限。 */
  pastIndexMaxLines: number
  /** 每隔多少轮审视一次记忆。 */
  reviewIntervalTurns: number
  /** 回忆工具单次节选上限（字）。 */
  recallExcerptMaxChars: number
  /** 群聊一场的在场角色上限。 */
  groupCastMax: number
  /** 全局登记表路径，支持 ~ 开头。 */
  registryPath: string
  /** 外部服务（生图等）的配置文件路径，支持 ~ 开头。 */
  servicesPath: string
  /** 群聊旁白音色所在目录（含 voice_ref.wav 与 voice_ref.txt，与角色音色同样的约定），支持 ~ 开头；空串用随包自带的旁白音色。 */
  narratorVoiceDir: string
}

/** 酒馆数据目录：跟随宿主的数据目录（DSH_HOME，未设时是 ~/.dsh）。 */
export function tavernDataDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME?.trim()
  return home ? `${home.replace(/\/+$/, '')}/aha-tavern` : '~/.dsh/aha-tavern'
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
  groupCastMax: 5,
  registryPath: '~/.dsh/aha-tavern/taverns.yaml',
  servicesPath: '~/.dsh/aha-tavern/services.yaml',
  narratorVoiceDir: '',
}

const MODES: readonly PluginMode[] = ['setup', 'chat', 'group', 'book', 'settings']

/** 把用户配置与默认值合并：未知字段丢弃，类型不对的字段回落默认值。 */
export function resolveConfig(input: unknown, env: Record<string, string | undefined> = process.env): TavernConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const out: TavernConfig = { ...DEFAULTS }

  if (MODES.includes(raw.mode as PluginMode)) out.mode = raw.mode as PluginMode
  if (typeof raw.theme === 'string' && raw.theme) out.theme = raw.theme
  // 默认的登记表与服务配置跟随酒馆数据目录；用户显式配置的路径优先
  const dataDir = tavernDataDir(env)
  out.registryPath = `${dataDir}/taverns.yaml`
  out.servicesPath = `${dataDir}/services.yaml`
  if (typeof raw.registryPath === 'string' && raw.registryPath) out.registryPath = raw.registryPath
  if (typeof raw.servicesPath === 'string' && raw.servicesPath) out.servicesPath = raw.servicesPath
  // 空白不算指定：旁白音色回落到随包自带的那段参考录音
  if (typeof raw.narratorVoiceDir === 'string' && raw.narratorVoiceDir.trim()) out.narratorVoiceDir = raw.narratorVoiceDir

  const numericKeys = [
    'worldBudget',
    'memoryMaxChars',
    'keyFactsMax',
    'pastIndexMaxLines',
    'reviewIntervalTurns',
    'recallExcerptMaxChars',
    'groupCastMax',
  ] as const
  for (const key of numericKeys) {
    const v = raw[key]
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[key] = v
  }
  return out
}
