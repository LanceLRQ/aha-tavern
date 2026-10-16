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
  /** 随手记（群聊）：指明哪些在场角色记住了。 */
  remember(agent: HostAgent | undefined, args: unknown): Promise<string>
  /** 回忆（群聊）：指明哪个在场角色在回忆。 */
  recall(agent: HostAgent | undefined, args: unknown): Promise<string>
  /** 整理（群聊）：当前场景梗概 + 在场角色前几栏。 */
  review(agent: HostAgent | undefined, args: unknown): Promise<string>
  /** 画图（群聊）：场景图或单人特写，返回图片路径与复述说明，或固定的失败短语。 */
  draw(agent: HostAgent | undefined, args: unknown, signal?: AbortSignal): Promise<string>
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

  host.tools.register(defineTool({
    name: 'aha_draw',
    description: '把这一场的画面画成图，两种画法。场景图：不给 who，scene 只写环境与氛围（地点、时间、光线、陈设），'
      + '不写任何 character 的长相，画面里的人长相不保证。单人特写：给 who 填一个在场 character 的名字，只画 TA 一个人，'
      + '长相由参考图保持一致；scene 写 TA 此刻的动作神态与环境，不写 TA 固定的长相，不写对话内容；换了形象时在 look 里写形象名。'
      + '这一轮要画图时第一步就调用本工具，在它之前一个字都不要写（调用前写的字 user 看不到），工具返回后再写这一轮完整的回复；每一轮最多成功一次，出图要等几十秒。'
      + '不画多人同框且每个人都长相一致的图：user 想要几个人同框时改用场景图（人影可以模糊入画），或分别画单人特写。'
      + 'orientation 缺省 portrait，横构图 landscape，方形 square。look 只在单人特写时用，且只有画图规范里列出了形象名时才填。'
      + 'redo 为 true 时重画上一张：不给 scene 就沿用上一张的画面与方向，上一张是单人特写就照旧特写那个角色（who 不用再给）；'
      + 'user 想改动画面时把上一张的画面按要求改写成一段新的完整描述放进 scene：是改写，不是在后面追加，与修改要求冲突的旧内容要删掉。'
      + '成功返回 drawn 和一行 Markdown 图片：回复的第一行原样输出那一行，一个字符都不要改，再另起一段照常写完这一轮的回复（旁白与各角色的话照常），不解释，不提工具。'
      + '返回 unavailable、already drew this turn、nothing to redo、error: no character named ...（who 不在场）或 failed: <原因> 表示没画成，'
      + '照常写这一轮的回复，不要重试，不要向 user 提起。',
    parameters: {
      scene: { type: 'string', description: '这一刻的画面，最多 600 字；redo 为 true 且沿用上一张画面时可缺，改动画面时给改写后的完整描述' },
      orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: '构图方向，缺省 portrait；redo 时缺省沿用上一张的方向' },
      who: { type: 'string', description: '单人特写画哪个在场 character（名字或名字的一部分）；不给表示画场景图' },
      look: { type: 'string', description: '可缺。单人特写用哪一套形象；只有画图规范里列出了该角色的形象名时才填' },
      redo: { type: 'boolean', description: '重新生成上一张：不给 scene 时沿用上一张的画面、方向与形态，换种子' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.draw(agentOf(exec), args, signalOf(exec)),
  }))

  registerGroupMemoryTools(host, deps, text, agentOf)
}

function registerGroupMemoryTools(host: ToolHost, deps: GroupToolDeps, text: (a: unknown, v: unknown) => Array<{ type: 'text'; text: string }>, agentOf: (exec: unknown) => HostAgent | undefined): void {
  host.tools.register(defineTool({
    name: 'aha_remember',
    description: '把一件恒久的事实或重要的事记进 core_memory 的 facts 栏。who 填记住这件事的 character（在场的一个或几个的名字）；'
      + '只记要紧的，不记一次性的闲聊；每一轮最多调用一次。返回 remembered for <名单>；同一轮再次调用返回 already remembered this turn。',
    parameters: {
      who: { type: 'array', items: { type: 'string' }, required: true, description: '记住这件事的在场 character 的名字' },
      text: { type: 'string', required: true, description: '一句话，只写结论，不写经过' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.remember(agentOf(exec), args),
  }))

  host.tools.register(defineTool({
    name: 'aha_recall',
    description: '让某个在场的 character 回忆往事：who 填 TA 的名字，id 是 TA 的 core_memory 往事索引行行尾的聊天编号。'
      + '只能回忆 TA 自己索引里的聊天；回忆一场群聊时只返回 TA 在场的那些场景。'
      + '只在 user 提起某次往事、或话题明显与某一行有关时才用，寒暄不用；每一轮最多调用一次。'
      + '编号不在 TA 的索引里返回 not remembered by <名字>；同一轮再次调用返回 already recalled this turn。',
    parameters: {
      who: { type: 'string', required: true, description: '在回忆的 character 的名字' },
      id: { type: 'string', required: true, description: 'TA 的往事索引里的聊天编号（4 位）' },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.recall(agentOf(exec), args),
  }))

  host.tools.register(defineTool({
    name: 'aha_review',
    description: '整理：scene_summary 写当前 scene 到目前为止的梗概（换场或收场时会覆盖这段）；'
      + 'members 里给每个要整理的在场 character 更新 core_memory 的 address、impression、facts（给了哪栏改哪栏，facts 是字符串数组，只写结论；'
      + '没有要改的 character 就不放进 members，但 scene_summary 每次都要给）。收到"整理记忆"的通知时调用；平时不用。',
    parameters: {
      scene_summary: { type: 'string', required: true, description: '当前 scene 到目前为止的梗概' },
      members: {
        type: 'array',
        required: true,
        description: '要更新的在场 character 列表',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'character 的名字' },
            address: { type: 'string', description: 'address 栏的完整新正文' },
            impression: { type: 'string', description: 'impression 栏的完整新正文' },
            facts: { type: 'array', items: { type: 'string' }, description: 'facts 栏的完整新条目列表' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) => deps.review(agentOf(exec), args),
  }))
}
