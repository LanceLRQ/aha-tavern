// 长聊天的压缩对策（M4）：宿主的默认压缩把对话改写成英文的工程任务清单，
// 对角色扮演是破坏性的——文风被带偏、剧情只剩任务条目。这里继承宿主的
// BasicCompactionEngine，只覆盖它官方留出的 summarize 定制钩子：触发时机、
// 保留尾部、工具配对、检查点落盘等机制全部照用宿主的，摘要指令换成中文的
// 扮演向剧情备忘。包 ./compaction 是独立入口，由各酒馆模式挂在隔离的
// compaction 服务组里（见 cordis.patch.yml），不与主入口的装配掺和。
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'

/**
 * 扮演向的摘要指令，作为重放的对话前缀之后的最后一条 user 消息发出
 * （与宿主的机制一致：复用同一前缀的 KV 缓存）。
 * 结构纪律照宿主的模板：分节、条目、空节写"（无）"、不提压缩本身、
 * 不调用工具、遇到上一份备忘时合并而不是照抄。
 */
export const TAVERN_COMPACTION_INSTRUCTION = [
  '你现在为这场角色扮演做一次上下文压缩：把上面的对话收进一份剧情备忘，让之后的扮演不丢必要的来龙去脉。',
  '',
  '只输出下面的 Markdown 结构：每个小节都保留、按顺序，用简洁的条目，不写连贯的大段文字。没有内容的小节写"（无）"，不要省略小节。',
  '',
  '## 场景与进展',
  '- [现在的时间地点、正在发生的事，剧情走到了哪里]',
  '',
  '## 人物状态',
  '- [在场每个角色此刻的状态、情绪、意图；与 user 以及彼此的关系有什么变化]',
  '',
  '## 已定的关键事件',
  '- [对之后有影响的言行与决定；确实需要引用原话时才引用]',
  '',
  '## 未决之事',
  '- [已经提起还没有下文的事、约好要做的事、悬着的问题]',
  '',
  '## 口吻备忘',
  '- [各角色说话的腔调与称呼习惯、user 表现出的偏好与忌讳]',
  '',
  '规则：',
  '- 用中文写；人名、地名、称呼保留原文。',
  '- 忠实记录 user 明确说过的话和纠正过的意思。',
  '- 不提这次压缩请求，也不提上下文被压缩过。',
  '- 只输出备忘文本，不调用任何工具。',
  '- 对话里已有的 <compacted-summary> 块是上一份备忘：不要照抄，把仍然成立的并进来、过时的去掉，合成一份。',
].join('\n')

/** summarize 钩子收到的重放前缀（形状依据 dsh-compaction-basic 的 SummarizationInput）。 */
export interface SummarizeInput {
  tools?: readonly ToolSchema[]
  messages: readonly Message[]
}

/** summarize 钩子的 agent 参数里本模块用到的最小子集。 */
export interface AgentLike {
  session: {
    id: string
    /** 最近一次路由请求的提供方与模型。 */
    requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
    toolHistory?: () => unknown
  }
  options: { provider?: string; model?: string }
}

/** summarize 钩子的返回（形状依据 dsh-compaction-basic 的 SummaryResult）。 */
export interface SummaryResult {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
  rawOutput: ContentBlock[]
  llmStreamCall: true
}

/** 本入口用到的宿主服务：只要 llm 流，类型上按最小形状收（流块形状跟 BlockAssembler 的入参走）。 */
export interface LlmContextLike {
  llm: { stream(options: unknown): AsyncIterable<Parameters<BlockAssembler['push']>[0]> }
}

interface EngineConfig {
  summarizationProvider: string
  summarizationModel: string
  maxTokens: number
}

/** 宿主引擎基类的最小结构（BasicCompactionEngine；不直接引用其类型，包缺席时也能编译）。 */
export type EngineBase = new (ctx: unknown, config?: unknown) => {
  /** 基类上是 protected；子类里本来就在自身实例上访问，放开成 public 只影响这个包装的类型。 */
  ctx: LlmContextLike
  config: EngineConfig
}

/** 求这次摘要用哪个提供方与模型：显式配置 > 最近一次路由 > agent 自带。 */
export function summarizationTarget(config: EngineConfig, agent: AgentLike): { provider: string; model: string } | undefined {
  if (config.summarizationProvider.length > 0) return { provider: config.summarizationProvider, model: config.summarizationModel }
  const latest = agent.session.requestHeader?.()?.config
  if (latest?.provider !== undefined && latest.provider !== '' && latest.model !== undefined && latest.model !== '') {
    return { provider: latest.provider, model: latest.model }
  }
  const { provider, model } = agent.options
  if (provider !== undefined && provider !== '' && model !== undefined && model !== '') return { provider, model }
  return undefined
}

/** 一次流式请求的收尾：错误原样抛，成功取文本块（拒绝图像输出）。 */
export async function summarizeWithTavernInstruction(
  ctx: LlmContextLike,
  config: EngineConfig,
  input: SummarizeInput,
  agent: AgentLike,
  instruction: string,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const target = summarizationTarget(config, agent)
  if (target === undefined) {
    throw new Error('no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields')
  }
  const assembler = new BlockAssembler()
  const messages = [...input.messages, { role: 'user', content: [{ type: 'text', text: instruction }] } as unknown as Message]
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent.session.toolHistory?.(),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
    ;(error as NodeJS.ErrnoException).code = 'MAX_TOKENS'
    throw error
  }
  const rawOutput = assembler.blocks()
  if (contentHasImage(rawOutput)) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  const summary = rawOutput.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  if (!summary.some((block) => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: target.provider,
    model: target.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** 包一个宿主引擎基类：只换 summarize 钩子，其余机制（触发、保留、落盘）照基类。 */
export function createTavernEngine(Base: EngineBase): new (ctx: unknown, config?: unknown) => object {
  return class TavernCompactionEngine extends Base {
    async summarize(input: SummarizeInput, agent: AgentLike, signal?: AbortSignal): Promise<SummaryResult> {
      return summarizeWithTavernInstruction(this.ctx, this.config, input, agent, TAVERN_COMPACTION_INSTRUCTION, signal)
    }
  }
}

export const name = 'aha-tavern-compaction'

export function apply(ctx: { plugin(definition: unknown): void; logger?: { warn(msg: string): void } }): void {
  // 宿主没带 dsh-compaction-basic（或加载失败）时不装配：压缩退回没有，聊天照常
  void import('@deepseek-ai/dsh-compaction-basic').then(
    (mod) => ctx.plugin(createTavernEngine(mod.BasicCompactionEngine as unknown as EngineBase)),
    (e) => ctx.logger?.warn(`酒馆的扮演向压缩没有装配（读不到 @deepseek-ai/dsh-compaction-basic）：${(e as Error).message}`),
  )
}
