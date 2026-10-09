// 阿哈酒馆插件入口：按 config.mode 区分筹备 / 单聊两个模式。
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config'

export const name = 'aha-tavern'
export const inject: string[] = []

export function apply(ctx: Context, config?: unknown): void {
  const cfg = resolveConfig(config)
  const logger = (ctx as unknown as { logger?: (n: string) => { info(m: string): void } }).logger
  const line = `[aha-tavern] 已加载，模式：${cfg.mode}`
  if (typeof logger === 'function') logger.call(ctx, name).info(line)
  else console.log(line)
}
