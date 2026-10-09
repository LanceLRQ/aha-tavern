// 单聊模式的工具：aha_start、aha_remember、aha_review、aha_recall、aha_draw。
// 返回值是给模型看的文字，只用固定标识说事实；失败返回原因而不抛异常。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HostAgent } from './context'

export interface StartArgs {
  id?: string
  name?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 校验 aha_start 的参数：id 与 name 都可选；两者都给时以 id 为准，都不给由界面弹出选角卡片（调用方处理）。 */
export function parseStartArgs(args: unknown): StartArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const out: StartArgs = {}
  for (const k of ['id', 'name'] as const) {
    const v = args[k]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return `error: ${k} must be a string`
    if (v.trim() !== '') out[k] = v.trim()
  }
  return out
}

export interface ChatToolDeps {
  /** 开始聊天：返回给模型的文字。 */
  start(agent: HostAgent | undefined, args: StartArgs, signal?: AbortSignal): Promise<string>
  /** 随手记：一句话追加到关键的事。 */
  remember(agent: HostAgent | undefined, args: unknown): Promise<string>
  /** 整理：替换三栏、写本次梗概与标题。 */
  review(agent: HostAgent | undefined, args: unknown): Promise<string>
  /** 回忆：按往事索引里的聊天编号取梗概或原文节选。 */
  recall(agent: HostAgent | undefined, args: unknown): Promise<string>
  /** 画图：等图出来，返回图片路径与复述说明，或固定的失败短语。 */
  draw(agent: HostAgent | undefined, args: unknown, signal?: AbortSignal): Promise<string>
}

interface ToolHost {
  tools: { register(def: ReturnType<typeof defineTool>): unknown }
}

export function registerChatTools(ctx: Context, deps: ChatToolDeps): void {
  const host = ctx as unknown as ToolHost
  const text = (_a: unknown, v: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: String(v) }]
  const agentOf = (exec: unknown): HostAgent | undefined => (exec as { agent?: unknown } | null)?.agent as HostAgent | undefined

  const signalOf = (exec: unknown): AbortSignal | undefined => (exec as { signal?: AbortSignal } | null)?.signal

  host.tools.register(defineTool({
    name: 'aha_start',
    description: '开始聊天，每个会话只能开始一次。user 说了名字就传 name（可以是名字的一部分，由界面匹配）；'
      + 'user 没说清要聊谁、问有谁、只是打招呼时，不带参数调用，界面会弹出 character 列表让 user 自己点。'
      + '成功返回 started with <id>，之后这个会话就由该 character 接管；cancelled by user, still picking 表示 user 没选，'
      + '简短回应即可，不要再次调用；其他失败返回原因。',
    parameters: {
      id: { type: 'string', description: 'character 的编号 id，已知时才传' },
      name: { type: 'string', description: 'user 说的名字或其一部分；与 id 同时给出时以 id 为准' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: async (args, exec) => {
      const parsed = parseStartArgs(args)
      if (typeof parsed === 'string') return parsed
      return deps.start(agentOf(exec), parsed, signalOf(exec))
    },
  }))

  host.tools.register(defineTool({
    name: 'aha_remember',
    description: '把一件恒久的事实或重要的事记进 core_memory 的 facts 栏。只记要紧的，不记一次性的闲聊；每一轮最多调用一次。'
      + '返回 remembered；同一轮再次调用返回 already remembered this turn。',
    parameters: { text: { type: 'string', required: true, description: '一句话，只写结论，不写经过' } },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.remember(agentOf(exec), args),
  }))

  host.tools.register(defineTool({
    name: 'aha_review',
    description: '整理记忆：整体替换 core_memory 的 address、impression、facts 三栏（给了哪栏改哪栏，facts 是字符串数组，只写结论），'
      + '并提交这次聊天到目前为止的 summary 和一句话 title（两者要一起给）。pinned 栏改不了。summary 和 title 每次都要给，没有要改的栏就只给这两项。',
    parameters: {
      address: { type: 'string', description: 'address 栏的完整新正文' },
      impression: { type: 'string', description: 'impression 栏的完整新正文' },
      facts: { type: 'array', items: { type: 'string' }, description: 'facts 栏的完整新条目列表' },
      summary: { type: 'string', description: '这次聊天到目前为止的梗概' },
      title: { type: 'string', description: '这次聊天的一句话标题' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.review(agentOf(exec), args),
  }))

  host.tools.register(defineTool({
    name: 'aha_recall',
    description: '回忆往事索引里的某一次聊天：参数是索引行行尾的聊天编号。返回那次聊天的梗概，没有梗概时返回原文节选。'
      + '只在 user 提起某次往事、或话题明显与索引里某一行有关时才用，寒暄不用；每一轮最多调用一次。'
      + '编号不在索引里返回 not remembered；同一轮再次调用返回 already recalled this turn。',
    parameters: { id: { type: 'string', required: true, description: '往事索引里的聊天编号（4 位）' } },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.recall(agentOf(exec), args),
  }))

  host.tools.register(defineTool({
    name: 'aha_draw',
    description: '把剧情里的一个画面画成图。这一轮要画图时，先调用本工具，再写这一轮完整的回复；不要先说话再调用。每一轮最多成功一次，出图要等几十秒。'
      + 'scene 只写这一刻的画面（谁、在做什么、在哪、光线与氛围），不写 character 的长相，不写对话内容；redo 为 true 时可以不给 scene。'
      + 'orientation 缺省 portrait，横构图用 landscape，方形用 square。'
      + 'user 要“换一张”“重画”时传 redo=true，沿用上一张的画面与方向；user 想改动画面时再给 change（追加在原画面描述后的修改词）。'
      + '成功返回 drawn 和一行 Markdown 图片：照常写完这一轮的回复，在回复最后单独一行原样输出那一行，一个字符都不要改，不解释，不提工具。'
      + '返回 unavailable、already drew this turn、nothing to redo 或 failed: <原因> 表示没画成，照常写这一轮的回复，不要重试，不要向 user 提起。',
    parameters: {
      scene: { type: 'string', description: '这一刻的画面，最多 600 字；redo 为 true 时可缺' },
      orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: '构图方向，缺省 portrait' },
      redo: { type: 'boolean', description: '重新生成上一张：沿用上一张的画面与方向，换种子' },
      change: { type: 'string', description: '只在 redo 为 true 时有意义：追加在上一张画面描述后的修改词，最多 200 字' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.draw(agentOf(exec), args, signalOf(exec)),
  }))
}
