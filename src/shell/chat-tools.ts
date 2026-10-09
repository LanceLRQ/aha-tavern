// 单聊模式的工具。本任务只有 aha_start；对话落盘与记忆相关的工具由后续任务往 registerChatTools 里加。
// 返回值是给模型看的文字，只用固定标识说事实；失败返回原因而不抛异常。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HostAgent } from './context'

export interface StartArgs {
  id?: string
  name?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 校验 aha_start 的参数：id 与 name 至少给一个；两者都给时以 id 为准（调用方处理）。 */
export function parseStartArgs(args: unknown): StartArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const out: StartArgs = {}
  for (const k of ['id', 'name'] as const) {
    const v = args[k]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return `error: ${k} must be a string`
    if (v.trim() !== '') out[k] = v.trim()
  }
  if (out.id === undefined && out.name === undefined) return 'error: give id or name'
  return out
}

export interface ChatToolDeps {
  /** 开始聊天：返回给模型的文字。 */
  start(agent: HostAgent | undefined, args: StartArgs): Promise<string>
}

interface ToolHost {
  tools: { register(def: ReturnType<typeof defineTool>): unknown }
}

export function registerChatTools(ctx: Context, deps: ChatToolDeps): void {
  const host = ctx as unknown as ToolHost
  const text = (_a: unknown, v: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: String(v) }]
  const agentOf = (exec: unknown): HostAgent | undefined => (exec as { agent?: unknown } | null)?.agent as HostAgent | undefined

  host.tools.register(defineTool({
    name: 'aha_start',
    description: '选定 user 要聊的 character 并开始聊天，每个会话只能开始一次。优先传 id（来自 <pick_state>）；只知道名字时传 name。'
      + '成功返回 started with <id>，之后这个会话就由该 character 接管；失败返回原因。',
    parameters: {
      id: { type: 'string', description: 'character 的编号 id' },
      name: { type: 'string', description: 'character 的名字；与 id 同时给出时以 id 为准' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: async (args, exec) => {
      const parsed = parseStartArgs(args)
      if (typeof parsed === 'string') return parsed
      return deps.start(agentOf(exec), parsed)
    },
  }))
}
