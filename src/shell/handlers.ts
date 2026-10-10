// 命令处理函数的登记处：在 installHandlers 里往 rt.handlers 添一行即可，
// 不必改 commands.ts。表里没有的命令，入口回"尚未接上"。
import type { Context } from '@deepseek-ai/cordis'
import { doctorHandler } from './doctor'
import type { Runtime } from './runtime'
import { installChat } from './chat'
import { installSettings } from './settings-remote'
import { installSetup } from './setup'
import { installVoice } from './voice'

export function installHandlers(rt: Runtime, ctx: Context): void {
  // 根层的设置页实例：不注册命令与工具，只提供语音服务的启停操作和页面用的远程服务
  if (rt.config.mode === 'settings') {
    installVoice(rt, ctx)
    installSettings(rt, ctx)
    return
  }
  rt.handlers.doctor = doctorHandler
  installVoice(rt, ctx)
  if (rt.config.mode === 'setup') installSetup(ctx, rt)
  if (rt.config.mode === 'chat') installChat(ctx, rt)
}
