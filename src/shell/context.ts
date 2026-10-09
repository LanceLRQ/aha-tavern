// 命令上下文：从宿主 agent 取出模式、工作区、会话编号，再调 core 得到酒馆与会话状态。
// 依赖宿主的部分写薄，判定逻辑都是纯函数或 core 调用。
import path from 'node:path'
import type { TavernMode } from '../config'
import { isTavern, type TavernInfo } from '../core/tavern'
import { readSession, resolveState, type OutsideReason, type SessionRecord, type SessionState } from '../core/state'
import type { Theme } from '../core/theme'
import type { Log, Runtime } from './runtime'
import { openResolved } from './writable'
import type { WebSearchStatus } from './receipts'

/** 宿主 agent 里本插件用到的最小子集。 */
export interface HostAgent {
  readonly id: string
  readonly ctx: unknown
  readonly session?: {
    readonly header?: { readonly cwd?: string }
    /** 已有消息的数组；全新会话为空。 */
    deriveMessages?(): readonly unknown[]
  }
  steer?(message: unknown): unknown
  /** 不唤醒的上下文补充：随下一步一起送达模型。 */
  inject?(message: unknown): unknown
}

/** 本插件用到的宿主服务（命令注册时 inject 进来）。 */
export interface HostServices {
  agentPresets: { composedPreset(ctx: unknown): string | undefined }
  /** 其余服务（userQuestions 等）由后续任务按需取用。 */
  [service: string]: unknown
}

/** 宿主工具运行时里本插件用到的最小子集。 */
export interface HostTools {
  schemas(scope?: object): ReadonlyArray<{ name: string }>
}

/** 模式登记服务里的模式标识 -> 本插件的模式。映射不到为 null。 */
const PRESET_TO_MODE: Record<string, TavernMode> = {
  'tavern-setup': 'setup',
  'tavern-chat': 'chat',
}

export function modeFromPreset(presetId: string | undefined): TavernMode | null {
  return presetId !== undefined && Object.hasOwn(PRESET_TO_MODE, presetId) ? PRESET_TO_MODE[presetId]! : null
}

export function sessionsFile(tavernDir: string): string {
  return path.join(tavernDir, '.aha', 'sessions.yaml')
}

export interface CommandContext {
  /** 当前会话实际运行的模式；不是酒馆模式时为 null。 */
  mode: TavernMode | null
  /** 会话工作区路径，可能为空。 */
  cwd: string | undefined
  /** 宿主会话编号。 */
  sessionId: string
  tavern: TavernInfo | null
  /** mode 为 null 时为 null。 */
  state: SessionState | null
  outsideReason: OutsideReason | null
  /** 会话状态记录（仅单聊·酒馆内会读）。 */
  record: SessionRecord | null
}

export async function buildContext(
  agent: HostAgent, services: HostServices, log?: Pick<Log, 'warn'>,
): Promise<CommandContext> {
  const mode = modeFromPreset(services.agentPresets.composedPreset(agent.ctx))
  const rawCwd = agent.session?.header?.cwd
  const cwd = typeof rawCwd === 'string' && rawCwd !== '' ? rawCwd : undefined
  const base = { mode, cwd, sessionId: agent.id }
  if (mode === null) {
    return { ...base, tavern: null, state: null, outsideReason: null, record: null }
  }
  const tavernHere = cwd !== undefined && (await isTavern(cwd))
  const tavern = tavernHere ? await openResolved(cwd, log) : null
  let record: SessionRecord | null = null
  if (tavern && mode === 'chat') {
    record = (await readSession(sessionsFile(tavern.dir), agent.id)).record
  }
  const { state, reason } = resolveState({
    mode,
    workspaceExists: cwd !== undefined,
    isTavern: tavernHere,
    stored: record,
  })
  return { ...base, tavern, state, outsideReason: reason ?? null, record }
}

const WEBSEARCH_PREFIX = 'mcp__websearch__'

/** 到宿主工具运行时查已注册工具（按该 agent 的可见范围）；接口不在则回"未知"。 */
export function probeWebSearch(tools: HostTools | undefined, agent: HostAgent): WebSearchStatus {
  try {
    if (!tools || typeof tools.schemas !== 'function') return 'unknown'
    const names = tools.schemas(agent as unknown as object).map((t) => t.name)
    return names.some((n) => n.startsWith(WEBSEARCH_PREFIX)) ? 'available' : 'unavailable'
  } catch {
    return 'unknown'
  }
}

/** 命令回执：与宿主命令处理器的返回值同形。 */
/** text 缺省表示不显示回执（静默）。 */
export type CommandReply = { kind: 'success' | 'error'; text?: string }

export interface Invocation {
  agent: HostAgent
  /** 命令注册时 inject 进来的服务。 */
  services: HostServices
  rt: Runtime
  theme: Theme
  context: CommandContext
  /** 向掌柜提交一条通知；处理函数一律用它，不直接调 agent.steer（用于判断本次是否 steer 过）。 */
  steer(text: string, summary: string): void
  /** 子命令后面的参数（已去首尾空白）。 */
  args: string
  /** 用户敲的写法，如 `/aha 开店` 或 `/aha-init`。 */
  label: string
  /** 命令调用所属 UI 请求的取消信号（宿主 CommandInvocation.signal）；拿不到为 undefined。 */
  signal?: AbortSignal
}

export type CommandHandler = (inv: Invocation) => CommandReply | Promise<CommandReply>

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 本地日期 YYYY-MM-DD，往事索引用。 */
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
