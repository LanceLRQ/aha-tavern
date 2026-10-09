// 自检：回一行当前状态。
import { probeWebSearch, type CommandHandler } from './context'
import { doctorLine } from './receipts'

export const doctorHandler: CommandHandler = ({ agent, rt, theme, context }) => {
  return {
    kind: 'success',
    text: doctorLine(theme, {
      mode: context.mode!, // 分流表保证到这里时不为 null
      tavernDir: context.tavern?.dir ?? null,
      outsideReason: context.outsideReason,
      webSearch: probeWebSearch(rt.tools(), agent),
    }),
  }
}
