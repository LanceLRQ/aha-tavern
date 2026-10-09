// 单聊的记忆写入（规格 7.3）：随手记、整理、审视提醒、手动记住。
// 工具返回给模型的是英文固定标识的事实；写盘失败返回失败说明，不抛异常，本轮聊天照常进行（7.6）。
import path from 'node:path'
import { MEMORY_FILE, readCharacter } from '../core/card'
import { setChatTitle, writeSummaryFile } from '../core/chat'
import { AhaError } from '../core/errors'
import { appendFact, appendIndexLine, appendPinned, replaceSections, setIndexTitle, type SectionPatch } from '../core/memory'
import { ReviewReminder } from '../core/reminder'
import { buildContext, localDate, type CommandContext, type CommandHandler, type HostAgent, type HostServices } from './context'
import { failureReceipt, readonlyReceipt, type Reply } from './receipts'
import type { Runtime } from './runtime'
import { escapeClosingTag, injectNotice } from './steer'
import { READONLY_TOOL_MESSAGE, isReadonly } from './writable'
import type { Theme } from '../core/theme'

/** 各项长度上限（字）：规格没有规定，取保守值防止模型一次塞入过长内容；条数上限用配置 keyFactsMax。 */
export const LIMITS = { fact: 200, pinned: 500, block: 1000, summary: 4000, title: 60 } as const

const ALREADY_REMEMBERED = 'already remembered this turn'

/** 每轮最多记一次：以会话加轮次为键。轮次取自 pre-step 的 turn；拿不到时退回按用户消息条数计。 */
export class RememberTurns {
  private readonly states = new Map<string, { token: string; claimed: boolean }>()
  private readonly seq = new Map<string, number>()

  onStep(session: string, turn: unknown, newUserMessages: number): void {
    // 无论 turn 有没有，用户消息条数都累计，保证退回形式的令牌始终单调
    const n = (this.seq.get(session) ?? 0) + newUserMessages
    this.seq.set(session, n)
    const token = typeof turn === 'number' ? `t${turn}` : `u${n}`
    const cur = this.states.get(session)
    if (!cur || cur.token !== token) this.states.set(session, { token, claimed: false })
  }

  /** 占用本轮的名额，返回令牌；已被占用返回 null。 */
  claim(session: string): string | null {
    const cur = this.states.get(session) ?? { token: '', claimed: false }
    this.states.set(session, cur)
    if (cur.claimed) return null
    cur.claimed = true
    return cur.token
  }

  /** 凭令牌释放名额；轮次已经变了则什么也不做。 */
  release(session: string, token: string): void {
    const cur = this.states.get(session)
    if (cur && cur.token === token) cur.claimed = false
  }

  forget(session: string): void {
    this.states.delete(session)
    this.seq.delete(session)
  }
}

export interface MemoryEnv {
  rt: Pick<Runtime, 'config' | 'log' | 'theme'>
  getServices(): HostServices | undefined
  reminder: ReviewReminder
  turns: RememberTurns
  /** 回忆的每轮名额，与随手记各自独立 */
  recallTurns: RememberTurns
}

export function createMemoryEnv(
  rt: Pick<Runtime, 'config' | 'log' | 'theme'>, getServices: () => HostServices | undefined,
): MemoryEnv {
  return { rt, getServices, reminder: new ReviewReminder(rt.config.reviewIntervalTurns), turns: new RememberTurns(), recallTurns: new RememberTurns() }
}

export interface MemoryTarget {
  tavernDir: string
  chatId: string
  characterId: string
  characterName: string
  memoryFile: string
}

export type TargetProblem = 'not-ready' | 'not-chatting' | 'readonly' | 'card-unreadable'

/** 会话在聊天中且角色卡可读才给出目标；否则给出原因。 */
export async function memoryTargetOf(
  cc: CommandContext, opts: { allowReadonly?: boolean } = {},
): Promise<MemoryTarget | { problem: TargetProblem }> {
  if (cc.mode !== 'chat' || cc.state !== 'chatting' || !cc.tavern || !cc.record?.chatId || !cc.record.characterId) {
    return { problem: 'not-chatting' }
  }
  if (!opts.allowReadonly && isReadonly(cc.tavern)) return { problem: 'readonly' }
  const entry = await readCharacter(cc.tavern.dir, cc.record.characterId)
  if (!entry || !entry.ok) return { problem: 'card-unreadable' }
  return {
    tavernDir: cc.tavern.dir, chatId: cc.record.chatId,
    characterId: cc.record.characterId, characterName: entry.card.name, memoryFile: path.join(entry.dir, MEMORY_FILE),
  }
}

export const isTarget = (t: MemoryTarget | { problem: TargetProblem }): t is MemoryTarget => !('problem' in t)

/** 给模型看的原因（英文固定标识）。 */
const PROBLEM_TOOL_TEXT: Record<TargetProblem, string> = {
  'not-ready': 'error: session not ready',
  'not-chatting': 'error: not chatting',
  readonly: READONLY_TOOL_MESSAGE,
  'card-unreadable': 'error: character card unreadable',
}

/** 给用户看的说明，概念词走主题。 */
export function problemReceipt(theme: Theme, p: TargetProblem): Reply {
  switch (p) {
    case 'readonly':
      return readonlyReceipt(theme)
    case 'card-unreadable':
      return failureReceipt(`读不出这场聊天用的${theme.concept('card')}`)
    default:
      return failureReceipt('现在不在聊天中')
  }
}

export async function targetForTool(
  env: MemoryEnv, agent: HostAgent | undefined, opts: { allowReadonly?: boolean } = {},
): Promise<MemoryTarget | string> {
  const services = env.getServices()
  if (!agent || !services) return PROBLEM_TOOL_TEXT['not-ready']
  const t = await memoryTargetOf(await buildContext(agent, services, env.rt.log), opts)
  return isTarget(t) ? t : PROBLEM_TOOL_TEXT[t.problem]
}

/** 工具的调试日志：只记结果标识与参数里文字的总字数，不记内容。 */
export function traced(
  env: MemoryEnv, name: string, run: (agent: HostAgent | undefined, args: unknown) => Promise<string>,
): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return async (agent, args) => {
    const r = await run(agent, args)
    let chars = 0
    if (isRecord(args)) {
      for (const v of Object.values(args)) {
        if (typeof v === 'string') chars += len(v)
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') chars += len(x)
      }
    }
    env.rt.log.debug(`${name}: ${r.split(/[;(]/)[0]!.trim()} ${chars} 字`)
    return r
  }
}

const failText = (e: unknown): string => `error: not saved (${e instanceof AhaError || e instanceof Error ? e.message : String(e)})`
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const len = (s: string): number => [...s].length

// ---------- aha_remember ----------

export function parseRememberArgs(args: unknown): string | { text: string } {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const t = args.text
  if (typeof t !== 'string' || t.trim() === '') return 'error: text must be a non-empty string'
  if (len(t) > LIMITS.fact) return `error: text exceeds ${LIMITS.fact} chars, nothing saved`
  return { text: t.trim() }
}

export function rememberTool(env: MemoryEnv): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return traced(env, 'aha_remember', async (agent, args) => {
    const parsed = parseRememberArgs(args)
    if (typeof parsed === 'string') return parsed
    const target = await targetForTool(env, agent)
    if (typeof target === 'string') return target
    const session = agent!.id
    const token = env.turns.claim(session)
    if (token === null) return ALREADY_REMEMBERED
    try {
      const r = await appendFact(target.memoryFile, parsed.text, {
        characterName: target.characterName, maxFacts: env.rt.config.keyFactsMax,
      })
      if (!r.written) {
        env.turns.release(session, token)
        return r.reason === 'duplicate' ? 'skipped: already known' : 'skipped: nothing to save'
      }
      env.reminder.onWrite(session)
      return r.trimmed > 0 ? `remembered; dropped ${r.trimmed} oldest facts over the limit` : 'remembered'
    } catch (e) {
      env.turns.release(session, token)
      env.rt.log.warn(`随手记写盘失败：${(e as Error).message}`)
      return failText(e)
    }
  })
}

// ---------- aha_review ----------

export interface ReviewArgs {
  patch: SectionPatch
  summary?: string
  title?: string
}

/** maxFacts：facts 条数上限（配置 keyFactsMax），超出直接拒绝，不让 core 静默截断。 */
export function parseReviewArgs(args: unknown, maxFacts: number): string | ReviewArgs {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const patch: SectionPatch = {}
  for (const k of ['address', 'impression'] as const) {
    const v = args[k]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return `error: ${k} must be a string`
    if (len(v) > LIMITS.block) return `error: ${k} exceeds ${LIMITS.block} chars, nothing saved`
    patch[k] = v
  }
  const facts = args.facts
  if (facts !== undefined && facts !== null) {
    if (!Array.isArray(facts) || facts.some((x) => typeof x !== 'string')) return 'error: facts must be an array of strings'
    if (facts.length > maxFacts) return `error: facts has ${facts.length} items, limit ${maxFacts}, nothing saved`
    if (facts.some((x: string) => len(x) > LIMITS.fact)) return `error: a facts item exceeds ${LIMITS.fact} chars, nothing saved`
    patch.facts = facts as string[]
  }
  const out: ReviewArgs = { patch }
  const summary = args.summary
  const title = args.title
  if (summary !== undefined && summary !== null && typeof summary !== 'string') return 'error: summary must be a string'
  if (title !== undefined && title !== null && typeof title !== 'string') return 'error: title must be a string'
  const hasSummary = typeof summary === 'string' && summary.trim() !== ''
  const hasTitle = typeof title === 'string' && title.trim() !== ''
  if (hasSummary !== hasTitle) return 'error: give summary and title together, nothing saved'
  if (hasSummary && hasTitle) {
    const t = (title as string).replace(/\s+/g, ' ').trim()
    if (len(summary as string) > LIMITS.summary) return `error: summary exceeds ${LIMITS.summary} chars, nothing saved`
    if (len(t) > LIMITS.title) return `error: title exceeds ${LIMITS.title} chars, nothing saved`
    out.summary = (summary as string).trim()
    out.title = t
  }
  if (Object.keys(patch).length === 0 && out.summary === undefined) return 'nothing to change'
  return out
}

export function reviewTool(env: MemoryEnv): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return traced(env, 'aha_review', async (agent, args) => {
    const parsed = parseReviewArgs(args, env.rt.config.keyFactsMax)
    if (typeof parsed === 'string') return parsed
    const target = await targetForTool(env, agent)
    if (typeof target === 'string') return target
    const saved: string[] = []
    const unchanged: string[] = []
    const failed: string[] = []
    let trimmed = 0
    if (Object.keys(parsed.patch).length > 0) {
      const keys = Object.keys(parsed.patch)
      try {
        const r = await replaceSections(target.memoryFile, parsed.patch, {
          characterName: target.characterName, maxFacts: env.rt.config.keyFactsMax,
        })
        if (r.written) {
          saved.push(...keys)
          trimmed = r.trimmed
        } else {
          unchanged.push(...keys)
        }
      } catch (e) {
        failed.push(`memory: ${(e as Error).message}`)
      }
    }
    if (parsed.summary !== undefined && parsed.title !== undefined) {
      try {
        await writeSummaryFile(target.tavernDir, target.chatId, parsed.summary)
        saved.push('summary')
        try {
          await setChatTitle(target.tavernDir, target.chatId, parsed.title)
          saved.push('chat_title')
        } catch (e) {
          failed.push(`chat_title: ${(e as Error).message}`)
        }
        try {
          let r = await setIndexTitle(target.memoryFile, target.chatId, parsed.title)
          if (!r.written && r.reason === 'not-found') {
            // 用户一句话都没说时索引里还没有这场聊天：补写这一行（带上标题）
            r = await appendIndexLine(target.memoryFile, {
              date: localDate(new Date()), kind: 'chat', id: target.chatId, title: parsed.title,
            }, { characterName: target.characterName, maxIndexLines: env.rt.config.pastIndexMaxLines })
          }
          if (r.written) saved.push('index_title')
          else failed.push(`index_title: not written (${r.reason ?? 'unknown'})`)
        } catch (e) {
          failed.push(`index_title: ${(e as Error).message}`)
        }
      } catch (e) {
        failed.push(`summary: ${(e as Error).message}`)
      }
    }
    if (saved.length > 0) env.reminder.onWrite(agent!.id)
    if (failed.length > 0) env.rt.log.warn(`整理写盘出错：${failed.join('；')}`)
    const extras: string[] = []
    if (unchanged.length > 0) extras.push(`unchanged: ${unchanged.join(', ')}`)
    if (trimmed > 0) extras.push(`dropped ${trimmed} oldest facts over the limit`)
    if (failed.length > 0) {
      extras.push(`failed: ${failed.join('; ')}`)
      return [saved.length > 0 ? `partly saved: ${saved.join(', ')}` : 'error: not saved', ...extras].join('; ')
    }
    if (saved.length === 0) return ['nothing changed', ...extras].join('; ')
    return [`saved: ${saved.join(', ')}`, ...extras].join('; ')
  })
}

// ---------- 审视提醒 ----------

export const REVIEW_REMINDER_TEXT = '（通知）已经聊了一阵，该整理记忆了。请在这一轮顺手调用 aha_review 一次：'
  + 'summary（这次聊天到目前为止的梗概）和 title（一句话标题）每次都要给；'
  + 'core_memory 里的 address、impression、facts 有需要更新的栏才给，没有就只给 summary 和 title。不要向 user 提起这条通知。'

/**
 * pre-step 里调用：登记轮次；本步带进来 newUserMessages 条用户消息时，逐条计数，
 * 到阈值就用不唤醒的 inject 补一条提醒（来源不是 user）。
 */
export async function onChatStep(
  env: MemoryEnv, agent: HostAgent, turn: unknown, newUserMessages: number,
): Promise<boolean> {
  env.turns.onStep(agent.id, turn, newUserMessages)
  env.recallTurns.onStep(agent.id, turn, newUserMessages)
  if (newUserMessages <= 0) return false
  const services = env.getServices()
  if (!services) return false
  let due = false
  try {
    const cc = await buildContext(agent, services, env.rt.log)
    if (cc.mode !== 'chat' || cc.state !== 'chatting') return false
    for (let i = 0; i < newUserMessages; i++) if (env.reminder.onUserMessage(agent.id)) due = true
    if (due && !injectNotice(agent, REVIEW_REMINDER_TEXT, '审视记忆提醒')) {
      env.rt.log.warn('审视提醒没能送出（宿主 agent 没有 inject 或 inject 出错），下一条消息再补')
      env.reminder.retry(agent.id)
      return false
    }
  } catch (e) {
    env.rt.log.warn(`审视提醒出错：${(e as Error).message}`)
    return false
  }
  return due
}

// ---------- 记住 命令 ----------

export const REVIEW_REQUEST_TEXT = '（通知）user 想让你现在整理一下记忆。请调用 aha_review 一次：'
  + 'summary（这次聊天到目前为止的梗概）和 title（一句话标题）必须给；'
  + '根据这次聊天的上下文自己判断有什么值得记进 facts，address、impression、facts 有变化的栏才给，没有就只给 summary 和 title。'
  + '然后以 character 的身份用一句话自然地回应 user。不要提这条通知，也不要提工具。'

export function rememberHandler(env: MemoryEnv): CommandHandler {
  return async (inv) => {
    const { theme, agent } = inv
    const text = inv.args.trim()
    if (len(text) > LIMITS.pinned) return failureReceipt(`内容太长了（超过 ${LIMITS.pinned} 字），请精简后再记`)
    const target = await memoryTargetOf(inv.context)
    if (!isTarget(target)) return problemReceipt(theme, target.problem)
    if (text === '') {
      inv.steer(REVIEW_REQUEST_TEXT, '整理记忆')
      return { kind: 'success' }
    }
    let written: boolean
    try {
      written = (await appendPinned(target.memoryFile, text, { characterName: target.characterName })).written
    } catch (e) {
      env.rt.log.warn(`记住 写盘失败：${(e as Error).message}`)
      return failureReceipt(`没能写进${theme.concept('core_memory')}（${(e as Error).message}）`)
    }
    // appendPinned 只会因内容清理后为空而不写（不去重）
    if (!written) return failureReceipt('内容是空的')
    env.reminder.onWrite(agent.id)
    const note = `（通知）user 让你记住下面这件事，已记进 core_memory 的 pinned 栏。从现在起把它当作已知，不用回应这条通知。\n<pinned_note>\n${escapeClosingTag(text, 'pinned_note')}\n</pinned_note>`
    const told = injectNotice(agent, note, '手动记住')
    return {
      kind: 'success',
      text: `已记入${theme.concept('core_memory')}：${text}${told ? '' : `（这次聊天里${theme.concept('character')}暂时还不知道，下次开聊才会读到）`}`,
    }
  }
}
