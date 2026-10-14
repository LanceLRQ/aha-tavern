// 群聊场景中的命令处理：旁白要求（规格 §7.2）。换场与收场随后接上。
import type { Reply } from './receipts'
import type { CommandHandler } from './context'
import type { GroupTranscriptRecorder } from './group-transcript'
import { escapeClosingTag } from './steer'

const guide = (text: string): Reply => ({ kind: 'success', text })

export const NARRATOR_USAGE = '用法：`/aha 旁白 <要求>`，例如 `/aha 旁白 让气氛紧张一点`、`/aha 旁白 来个意外`。'

/** 给旁白的通知：只对 narrator 说，character 听不到；当前场景内持续有效（规格 §7.2）。 */
export function buildNarratorNotice(request: string): string {
  return '（通知）user 向旁白提了一个要求，这句话只给你（narrator），character 们都听不到，也不要把它当成 user 在场景里说的话：'
    + `<narrator_request>\n${escapeClosingTag(request, 'narrator_request')}\n</narrator_request>\n`
    + '请在接下来的场面里照此办理；它在当前场景内持续有效，换场后就失效。不要向 user 提这条通知。'
}

export interface NarratorDeps {
  recorder: GroupTranscriptRecorder
}

/** `旁白 要求` 命令。 */
export function narratorHandler(deps: NarratorDeps): CommandHandler {
  return async (inv) => {
    const request = inv.args.trim()
    if (request === '') return guide(NARRATOR_USAGE)
    // 先落盘再转告：转告失败时记录还在，下一个要求来之前模型按上一次的做
    await deps.recorder.writeNarratorRequest(inv.agent, request)
    inv.steer(buildNarratorNotice(request), '旁白要求')
    return guide('已转告旁白，这一场里会照着办。')
  }
}
