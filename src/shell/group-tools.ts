// 群聊模式的工具：aha_start（群聊版）。
// 返回值是给模型看的文字，只用固定标识说事实；失败返回原因而不抛异常。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HostAgent } from './context'

export interface GroupStartArgs {
  names?: string[]
  scenario?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 校验 aha_start（群聊）的参数：names 与 scenario 都可选；names 去掉空白项后保序去重。 */
export function parseGroupStartArgs(args: unknown): GroupStartArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const out: GroupStartArgs = {}
  const rawNames = args.names
  if (rawNames !== undefined && rawNames !== null) {
    if (!Array.isArray(rawNames)) return 'error: names must be an array of strings'
    const names: string[] = []
    for (const n of rawNames) {
      if (typeof n !== 'string') return 'error: names must be an array of strings'
      const t = n.trim()
      if (t !== '' && !names.includes(t)) names.push(t)
    }
    if (names.length > 0) out.names = names
  }
  const rawScenario = args.scenario
  if (rawScenario !== undefined && rawScenario !== null) {
    if (typeof rawScenario !== 'string') return 'error: scenario must be a string'
    const t = rawScenario.trim()
    if (t !== '') out.scenario = t
  }
  return out
}

export interface GroupToolDeps {
  /** 开场（群聊）：返回给模型的文字。 */
  start(agent: HostAgent | undefined, args: GroupStartArgs, signal?: AbortSignal): Promise<string>
  /** 换场：确认卡片后写梗概、场景分界与人员进出。 */
  scene(agent: HostAgent | undefined, args: unknown, signal?: AbortSignal): Promise<string>
  /** 收场：写最后一段梗概与标题，更新往事索引行。 */
  wrap(agent: HostAgent | undefined, args: unknown): Promise<string>
}

interface ToolHost {
  tools: { register(def: ReturnType<typeof defineTool>): unknown }
}

export function registerGroupTools(ctx: Context, deps: GroupToolDeps): void {
  const host = ctx as unknown as ToolHost
  const text = (_a: unknown, v: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: String(v) }]
  const agentOf = (exec: unknown): HostAgent | undefined => (exec as { agent?: unknown } | null)?.agent as HostAgent | undefined
  const signalOf = (exec: unknown): AbortSignal | undefined => (exec as { signal?: AbortSignal } | null)?.signal

  host.tools.register(defineTool({
    name: 'aha_start',
    description: '开始这一场群聊，每个会话只能开始一次。user 的话里说到了谁，就把名字放进 names（可以是名字的一部分，由界面匹配）；'
      + 'scenario 是这一场的情景（user 对这一场的说法，user 顺带说了自己这次是谁也写进去）。'
      + '只说到人没说情景时，不要带 scenario 调用，返回会提醒你先问 user；只说到情景或什么都没说时，不带 names 调用，界面会弹出列表让 user 自己勾选。'
      + '成功返回 started with <ids>，之后这个会话由 narrator 与这些 character 接管；cancelled by user, still gathering 表示 user 没定下来，'
      + '简短回应即可，不要再次调用；其他失败返回原因。',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, description: 'user 提到的 character 名字或其一部分' },
      scenario: { type: 'string', description: '这一场的情景，一句话；user 说了自己这次是谁也包含在内' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: async (args, exec) => {
      const parsed = parseGroupStartArgs(args)
      if (typeof parsed === 'string') return parsed
      return deps.start(agentOf(exec), parsed, signalOf(exec))
    },
  }))

  host.tools.register(defineTool({
    name: 'aha_scene',
    description: '提议换一个 scene：地点或时间明显变化时用（去了后院、到了第二天）；同一个地方聊得再久也不提议。'
      + 'summary 写刚结束 scene 的梗概，title 给新 scene 起标题，场景一还没标题时在 ending_title 里给它起一个；'
      + 'user 说了谁来谁走就填 join / leave（名字）。会弹出确认卡片，切不切由 user 决定；user 选了不换，本 scene 内不再提议。'
      + '确认换场后按返回的指示，在同一轮回复里接着写新 scene 的开场（【旁白】开头）。其他返回是失败原因，照常继续当前 scene，不要重试。',
    parameters: {
      summary: { type: 'string', required: true, description: '刚结束的 scene 的梗概，两三句' },
      title: { type: 'string', required: true, description: '新 scene 的标题，几个字' },
      ending_title: { type: 'string', description: '刚结束 scene 的标题；场景一还没有标题时给它起一个' },
      scenario: { type: 'string', description: 'user 说的新 scene 的情景（如有）' },
      join: { type: 'array', items: { type: 'string' }, description: '新加入的 character 名单（如有）' },
      leave: { type: 'array', items: { type: 'string' }, description: '离开的 character 名单（如有）' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.scene(agentOf(exec), args, signalOf(exec)),
  }))

  host.tools.register(defineTool({
    name: 'aha_wrap',
    description: '收场：user 要求收场时调用。summary 写最后一个 scene 的梗概，title 给这一场 show 起个标题。'
      + '收场后 user 仍可以继续聊；再次收场会覆盖最后一段梗概和标题。',
    parameters: {
      summary: { type: 'string', required: true, description: '最后一个 scene 的梗概，两三句' },
      title: { type: 'string', required: true, description: '这一场 show 的标题，一句话' },
      ending_title: { type: 'string', description: '最后一个 scene 的标题（如它还没有）' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.wrap(agentOf(exec), args),
  }))
}
