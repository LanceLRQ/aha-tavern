import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  TAVERN_COMPACTION_INSTRUCTION, createTavernEngine, summarizeWithTavernInstruction, summarizationTarget,
  type AgentLike, type LlmContextLike, type SummarizeInput,
} from '../../src/compaction'

const CONFIG = { summarizationProvider: '', summarizationModel: '', maxTokens: 4096 }

const agentOf = (over: Partial<AgentLike> = {}): AgentLike => ({
  session: { id: 's1', requestHeader: undefined, toolHistory: () => 'tool-history' },
  options: {},
  ...over,
})

describe('TAVERN_COMPACTION_INSTRUCTION', () => {
  it('是扮演向的中文剧情备忘，不是宿主的英文工程任务模板', () => {
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('## 场景与进展')
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('## 人物状态')
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('## 未决之事')
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('用中文写')
    for (const absent of ['coding assistant', 'Primary Request', 'Files and Code', 'English engineering prose']) {
      expect(TAVERN_COMPACTION_INSTRUCTION).not.toContain(absent)
    }
  })
  it('保留宿主模板的结构纪律：空节写（无）、不提压缩、不调工具、合并上一份备忘', () => {
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('（无）')
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('不调用任何工具')
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('不提这次压缩请求')
    expect(TAVERN_COMPACTION_INSTRUCTION).toContain('<compacted-summary>')
  })
})

describe('summarizationTarget', () => {
  it('显式配置最优先', () => {
    const agent = agentOf({ session: { id: 's', requestHeader: () => ({ config: { provider: 'latest', model: 'm2' } }) }, options: { provider: 'opt', model: 'm3' } })
    expect(summarizationTarget({ ...CONFIG, summarizationProvider: 'cfg', summarizationModel: 'm1' }, agent)).toEqual({ provider: 'cfg', model: 'm1' })
  })
  it('其次最近一次路由，再次 agent 自带', () => {
    const routed = agentOf({ session: { id: 's', requestHeader: () => ({ config: { provider: 'latest', model: 'm2' } }) } })
    expect(summarizationTarget(CONFIG, routed)).toEqual({ provider: 'latest', model: 'm2' })
    expect(summarizationTarget(CONFIG, agentOf({ options: { provider: 'opt', model: 'm3' } }))).toEqual({ provider: 'opt', model: 'm3' })
  })
  it('都没有：undefined', () => {
    expect(summarizationTarget(CONFIG, agentOf())).toBeUndefined()
  })
})

interface StreamChunkLike {
  type: string
  index?: number
  blockType?: string
  text?: string
  block?: { type: string; text: string }
}

/** 记录请求并把一段文字按 BlockAssembler 吃的流块形状吐回去。 */
function llmOf(text: string): { ctx: LlmContextLike; calls: unknown[] } {
  const calls: unknown[] = []
  const chunks: StreamChunkLike[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
  const stream = (options: unknown): AsyncIterable<never> => {
    calls.push(options)
    return (async function* () {
      yield* chunks as never[]
    })()
  }
  return { ctx: { llm: { stream } }, calls }
}

const inputOf = (): SummarizeInput => ({
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] as unknown as Message[],
})

describe('summarizeWithTavernInstruction', () => {
  it('把指令作为最后一条 user 消息附在重放前缀后面，走配置的模型', async () => {
    const { ctx, calls } = llmOf('## 场景与进展\n- 开场')
    const agent = agentOf({ options: { provider: 'p', model: 'm' } })
    const r = await summarizeWithTavernInstruction(ctx, CONFIG, inputOf(), agent, TAVERN_COMPACTION_INSTRUCTION)
    const options = calls[0] as { provider: string; model: string; messages: Message[]; maxTokens: number; purpose: string; sessionId: string; toolHistory: unknown }
    expect(options.provider).toBe('p')
    expect(options.model).toBe('m')
    expect(options.purpose).toBe('compaction')
    expect(options.sessionId).toBe('s1')
    expect(options.toolHistory).toBe('tool-history')
    expect(options.maxTokens).toBe(4096)
    const last = options.messages[options.messages.length - 1]!
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('角色扮演')
    expect(options.messages.length).toBe(2)
    expect(r.llmStreamCall).toBe(true)
    expect(r.summary).toHaveLength(1)
    expect((r.summary[0] as { text: string }).text).toContain('场景与进展')
    expect(r.provider).toBe('p')
  })
  it('没有可用的提供方与模型时抛错', async () => {
    const { ctx } = llmOf('x')
    await expect(summarizeWithTavernInstruction(ctx, CONFIG, inputOf(), agentOf(), TAVERN_COMPACTION_INSTRUCTION)).rejects.toThrow('no provider/model available')
  })
  it('产出没有可念的文本时抛错', async () => {
    const { ctx } = llmOf('  ')
    const agent = agentOf({ options: { provider: 'p', model: 'm' } })
    await expect(summarizeWithTavernInstruction(ctx, CONFIG, inputOf(), agent, TAVERN_COMPACTION_INSTRUCTION)).rejects.toThrow('no text summary content')
  })
})

describe('createTavernEngine', () => {
  it('包住的引擎只换 summarize，构造参数原样传给基类', async () => {
    const constructed: Array<{ ctx: unknown; config: unknown }> = []
    const Base = class {
      ctx: LlmContextLike
      config = CONFIG
      constructor(ctx: unknown, public readonly configArg: unknown) {
        this.ctx = ctx as LlmContextLike
        constructed.push({ ctx, config: configArg })
      }
      async summarize(): Promise<unknown> {
        throw new Error('should be overridden')
      }
    }
    const { ctx } = llmOf('## 场景与进展\n- x')
    const Engine = createTavernEngine(Base as unknown as Parameters<typeof createTavernEngine>[0])
    const engine = new Engine(ctx, { some: 'config' }) as InstanceType<typeof Base> & { summarize(i: SummarizeInput, a: AgentLike): Promise<unknown> }
    expect(constructed).toEqual([{ ctx, config: { some: 'config' } }])
    const r = (await engine.summarize(inputOf(), agentOf({ options: { provider: 'p', model: 'm' } }))) as { summary: Array<{ text: string }> }
    expect(r.summary[0]!.text).toContain('场景与进展')
  })
})
