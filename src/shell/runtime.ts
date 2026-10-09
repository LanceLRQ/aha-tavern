// 插件实例级共享对象：配置、主题、日志、内置主题目录、命令处理函数表。
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, type TavernConfig } from '../config'
import { expandHome } from '../core/fsx'
import type { CommandId } from '../core/dispatch'
import { loadTheme, type Theme } from '../core/theme'
import type { CommandHandler, HostTools } from './context'
import type { AskFn, SessionGate } from './confirm'
import type { DrawAvailability } from './draw'

export interface Log {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface Runtime {
  readonly config: TavernConfig
  readonly log: Log
  readonly builtinThemeDir: string
  readonly builtinWorkflowDir: string
  /** 服务配置文件的实际路径（已展开 ~）；每次用到时再读取。 */
  servicesPath(): string
  /** 宿主工具运行时（顶层 inject 的 tools）；取不到为 undefined。 */
  tools(): HostTools | undefined
  /** 命令处理时 await 同一个 Promise；加载失败时拒绝。 */
  theme(): Promise<Theme>
  /** "执行"分支的处理函数表。在 handlers.ts 里往里登记。 */
  readonly handlers: Partial<Record<CommandId, CommandHandler>>
  /** 单聊模式的画图能力判定；由 installChat 创建后赋值，自检用它刷新当前会话。 */
  drawing?: DrawAvailability
  /** 本模式的提问服务与同会话卡片队列；由 installSetup / installChat 赋值，自检的卡片用它。 */
  cards?: { gate: SessionGate; getAsk(): AskFn | undefined }
}

/** dist/index.js 的上一级的 themes/；源码态（src/index.ts）下同样成立。 */
export function builtinThemeDirOf(entryUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(entryUrl)), '..', 'themes')
}

/** dist/index.js 的上一级的 workflows/；与内置主题目录同样的求法。 */
export function builtinWorkflowDirOf(entryUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(entryUrl)), '..', 'workflows')
}

const LOGGER_NAME = 'aha-tavern'

/** 宿主有 logger 服务就用，否则退回 console。 */
export function createLog(host: unknown): Log {
  const svc = (host as { logger?: unknown }).logger
  if (typeof svc === 'function') {
    try {
      const l = (svc as (name: string) => Partial<Log>).call(host, LOGGER_NAME)
      if (typeof l.info === 'function' && typeof l.debug === 'function' && typeof l.warn === 'function' && typeof l.error === 'function') {
        return { debug: (m) => l.debug!(m), info: (m) => l.info!(m), warn: (m) => l.warn!(m), error: (m) => l.error!(m) }
      }
    } catch {
      // 退回 console
    }
  }
  return {
    debug: (m) => console.debug(`[${LOGGER_NAME}] ${m}`),
    info: (m) => console.log(`[${LOGGER_NAME}] ${m}`),
    warn: (m) => console.warn(`[${LOGGER_NAME}] ${m}`),
    error: (m) => console.error(`[${LOGGER_NAME}] ${m}`),
  }
}

/** 调试用：设了环境变量 AHA_TAVERN_LOG 时，把每条日志另外追加到该文件。 */
function teeToFile(log: Log, file: string | undefined): Log {
  if (!file) return log
  const tee = (level: keyof Log) => (m: string) => {
    log[level](m)
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${m}\n`)
    } catch {
      // 调试日志写不进去不影响功能
    }
  }
  return { debug: tee('debug'), info: tee('info'), warn: tee('warn'), error: tee('error') }
}

export function createRuntime(host: unknown, rawConfig: unknown, entryUrl: string): Runtime {
  const config = resolveConfig(rawConfig)
  const log = teeToFile(createLog(host), process.env.AHA_TAVERN_LOG)
  const builtinThemeDir = builtinThemeDirOf(entryUrl)
  const themePromise = loadTheme({ name: config.theme, builtinDir: builtinThemeDir }).then(({ theme, warnings }) => {
    for (const w of warnings) log.warn(w)
    return theme
  })
  // 先挂一个空 catch，避免命令到来前被当作未处理的拒绝
  themePromise.catch((e) => log.error(`主题加载失败：${(e as Error).message}`))
  const tools = (): HostTools | undefined => {
    try {
      return (host as { tools?: HostTools }).tools
    } catch {
      return undefined
    }
  }
  const builtinWorkflowDir = builtinWorkflowDirOf(entryUrl)
  const servicesPath = () => expandHome(config.servicesPath)
  return { config, log, builtinThemeDir, builtinWorkflowDir, servicesPath, tools, theme: () => themePromise, handlers: {} }
}
