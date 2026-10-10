// 阿哈酒馆插件入口：按 config.mode 区分筹备 / 单聊两个模式，以及根层的设置页实例（settings）。
import type { Context } from '@deepseek-ai/cordis'
import { registerCommands } from './shell/commands'
import { installHandlers } from './shell/handlers'
import { createRuntime } from './shell/runtime'

export const name = 'aha-tavern'
// tools 供自检探测联网工具，注册工具时也要用
export const inject = ['tools']

export function apply(ctx: Context, config?: unknown): void {
  const rt = createRuntime(ctx, config, import.meta.url)
  rt.log.info(`已加载，模式：${rt.config.mode}`)
  installHandlers(rt, ctx)
  if (rt.config.mode !== 'settings') registerCommands(ctx, rt)
}
