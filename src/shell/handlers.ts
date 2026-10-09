// 命令处理函数的登记处：后续任务在 installHandlers 里往 rt.handlers 添一行即可，
// 不必改 commands.ts。表里没有的命令，入口回"尚未接上"。
import { doctorHandler } from './doctor'
import type { Runtime } from './runtime'

export function installHandlers(rt: Runtime): void {
  rt.handlers.doctor = doctorHandler
}
