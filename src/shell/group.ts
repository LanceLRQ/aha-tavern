// 群聊模式的外壳：开局（定人、定情景、复述确认）、初始化、开场指令，以及 created / pre-step / disposed 的装配。
// 会话的提示词段只有一个：门外与开局阶段是掌柜（张罗）的文字，进入场景后整段换成五段。
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import houseRulesGroupText from '../prompts/house-rules-group.md'
import hostGatherGuide from '../prompts/host-gather.md'
import {
  listCharacters, matchCharacterName, MEMORY_FILE, readCharacter, type CharacterEntry,
} from '../core/card'
import { createChat, findChatDir, readChatMeta } from '../core/chat'
import { readMe, readWorld } from '../core/docs'
import { isAhaError } from '../core/errors'
import { appendIndexLine, memoryChars, readMemory, readMemoryText } from '../core/memory'
import { saveSession } from '../core/state'
import type { TavernInfo } from '../core/tavern'
import type { Theme } from '../core/theme'
import { answerItem, CARD_OPEN_MESSAGE, isAbort, SessionGate, shownName, type AskFn, type AskItem } from './confirm'
import {
  buildContext, localDate, sessionsFile, type CommandContext, type CommandHandler, type HostAgent, type HostServices,
} from './context'
import { checkRoster, collectNotes, rosterReceipt, type BadEntry, type GoodEntry, type InitNote } from './chat'
import {
  buildDegradedGroupPrompt, buildGatherPrompt, buildGroupPrompt, buildGroupStartCue, type GatherFacts,
  type GroupDegradeCause,
} from './group-prompt'
import { cardBrokenReceipt, dispatchReceipt, failureReceipt, MODE_LABEL, readonlyReceipt, type Reply } from './receipts'
import type { Runtime } from './runtime'
import { hostSectionRegister, SessionSections, type SectionPlan } from './sections'
import { flatText, makeNotice } from './steer'
import { registerGroupTools, type GroupStartArgs } from './group-tools'
import { GroupTranscriptRecorder, resolveGroupTarget } from './group-transcript'
import { narratorHandler } from './group-commands'
import { sceneHandler, sceneTool, wrapHandler, wrapTool } from './group-scene'
import { groupRememberHandler, groupRememberTool, groupRecallTool, groupReviewTool, onGroupMemoryStep, type GroupMemoryEnv } from './group-memory'
import { RememberTurns } from './remember'
import { ReviewReminder } from '../core/reminder'
import { isReadonly } from './writable'

const SECTION_NAME = 'aha:group'
const SECTION_ORDER = 5000
/** 多选卡片一次最多列多少人；更多时请用命令带名字（宿主的实际上限未知，30 是保守取值）。 */
export const CAST_CARD_MAX = 30
/** 复述确认卡片：自由输入算修改情景，最多改这么多次，超过按取消处理。 */
export const CONFIRM_ROUNDS_MAX = 5
const CAST_QUESTION_ID = 'group-cast'
const CONFIRM_QUESTION_ID = 'group-confirm'
const TAGLINE_MAX = 60

export const OPT_START = '开场'
export const OPT_CANCEL = '取消'

// ---------- 纯函数：拆参数、选项、匹配、文字 ----------

/**
 * 命令参数拆成（名字们，情景）：开头的词逐个按角色名匹配（与单聊同规则，只用全名相等与开头两档），
 * 第一个匹配不上的词起整段原样算情景。名字之间可以隔空格、顿号或逗号。
 */
export function splitOpeningArgs(entries: readonly CharacterEntry[], args: string): { names: string[]; scenario: string } {
  const names: string[] = []
  const chunks = args.trim().split(/([\s、，,]+)/).filter((c) => c !== '')
  let i = 0
  while (i < chunks.length) {
    const token = chunks[i]!
    if (/^[\s、，,]+$/.test(token)) {
      i++
      continue
    }
    const m = matchCharacterName([...entries], token)
    if (m.kind !== 'exact' && m.kind !== 'prefix') break
    names.push(token)
    i += 2
  }
  return { names, scenario: chunks.slice(i).join('').trim() }
}

/** 多选的在场名单卡片：全部可选角色一次列出（人数超上限时退回文字，由调用方说明）。 */
export function buildCastQuestion(theme: Theme, sorted: readonly GoodEntry[]): { item: AskItem; byLabel: Map<string, string> } {
  const used = new Set<string>()
  const byLabel = new Map<string, string>()
  const options: Array<{ label: string; description: string }> = []
  for (const e of sorted) {
    let label = shownName(e.card.name)
    if (used.has(label)) {
      for (let n = 2; ; n++) {
        label = `${shownName(e.card.name)}（${n}）`
        if (!used.has(label)) break
      }
    }
    used.add(label)
    byLabel.set(label, e.card.id)
    options.push({ label, description: e.card.tagline ? e.card.tagline.slice(0, TAGLINE_MAX) : '' })
  }
  return {
    item: {
      id: CAST_QUESTION_ID,
      header: theme.concept('show'),
      question: `谁在这一场${theme.concept('show')}？选好就定人。`,
      multiSelect: true,
      options,
    },
    byLabel,
  }
}

export type CastAnswer =
  | { kind: 'ids'; ids: string[] }
  /** 自由输入：当作又一句话，重新拆人与情景 */
  | { kind: 'custom'; text: string }
  /** 跳过、取消、一个都没选 */
  | { kind: 'cancel' }

export function interpretCastAnswer(answer: unknown, byLabel: ReadonlyMap<string, string>): CastAnswer {
  const item = answerItem(answer, CAST_QUESTION_ID)
  if (!item) return { kind: 'cancel' }
  const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
  if (custom !== '') return { kind: 'custom', text: custom }
  const selected = Array.isArray(item.selected) ? item.selected : []
  const ids = selected.map((s) => byLabel.get(s)).filter((id): id is string => id !== undefined)
  return ids.length > 0 ? { kind: 'ids', ids } : { kind: 'cancel' }
}

/** 复述与确认的卡片（二期规格 §4.2）。 */
export function buildGroupConfirmQuestion(theme: Theme, names: readonly string[], scenario: string): AskItem {
  const list = names.map((n) => shownName(n)).join('、')
  return {
    id: CONFIRM_QUESTION_ID,
    header: theme.concept('show'),
    question: `这一场：${list}在场；${theme.concept('scenario')}：${shownName(scenario, 120)}。就这样开场？`,
    options: [
      { label: OPT_START, description: '按这个人和这个情景开始' },
      { label: OPT_CANCEL, description: '不开始，回去改' },
    ],
  }
}

export type ConfirmAnswer = { kind: 'start' } | { kind: 'cancel' } | { kind: 'custom'; text: string }

export function interpretGroupConfirm(answer: unknown): ConfirmAnswer {
  const item = answerItem(answer, CONFIRM_QUESTION_ID)
  if (!item) return { kind: 'cancel' }
  const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
  if (custom !== '') return { kind: 'custom', text: custom }
  const selected = Array.isArray(item.selected) ? item.selected : []
  if (selected.includes(OPT_START)) return { kind: 'start' }
  return { kind: 'cancel' }
}

export type { NameResolve } from './group-common'
export { matchGroupNames } from './group-common'
import { matchGroupNames } from './group-common'

// ---------- 初始化 ----------

export type GroupStepName = 'index' | 'prompt' | 'opening'
export type GroupRefusalWhy = 'readonly' | 'read-failed' | 'chat-dir-failed' | 'session-failed' | 'already-performing'

export type GroupInitNote =
  | { kind: 'profile-empty' }
  | { kind: 'memory-over'; name: string; chars: number; max: number }
  | { kind: 'world-over'; chars: number; budget: number }

export type GroupInitOutcome =
  | {
      kind: 'started'
      chatId: string
      names: string[]
      scenario: string
      notes: GroupInitNote[]
      /** 状态已不可逆之后没做成的步骤 */
      failed: GroupStepName[]
    }
  | { kind: 'refused'; why: GroupRefusalWhy; detail?: string }

/** 初始化第 2 至 6 步用到的动作；测试里可替换。setSection 与 steer 由调用方按会话接入。 */
export interface GroupInitSteps {
  createChat: typeof createChat
  saveSession: typeof saveSession
  readMemoryText: typeof readMemoryText
  appendIndexLine: typeof appendIndexLine
  removeDir(dir: string): Promise<void>
  /** 把会话的提示词段换成这段文字 */
  setSection(text: string): Promise<void>
  /** 提交开场指令 */
  steer(text: string, summary: string): void
}

export function realGroupSteps(io: Pick<GroupInitSteps, 'setSection' | 'steer'>): GroupInitSteps {
  return {
    createChat, saveSession, readMemoryText, appendIndexLine,
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    ...io,
  }
}

export interface GroupInitRequest {
  tavern: Pick<TavernInfo, 'dir' | 'access'>
  entries: GoodEntry[]
  scenario: string
  sessionId: string
  houseRules: string
  theme: Theme
  limits: { worldBudget: number; memoryMaxChars: number; pastIndexMaxLines: number }
  now: Date
  warn?: (message: string) => void
}

/**
 * 初始化一场群聊（二期规格 §4.4）。与单聊不同的关键点：往事索引在初始化时就写
 * （每人一行，标"未整理"），而不是等用户说第一句话。
 *  1 读取：失败 -> refused(read-failed)，盘上无改动。
 *  2 建聊天目录：失败 -> refused(chat-dir-failed)；可能留下只有 meta.yaml 的空目录，不影响任何功能。
 *  3 存会话状态：失败 -> refused(session-failed)，尽力删掉刚建的目录；
 *    已是 performing（session-locked）-> refused(already-performing)。
 *    —— 从这一步成功起状态不可逆，以下步骤失败都不回退，结果为 started 并列出没做成的步骤：
 *  4 往事索引：某个角色写不上 -> failed 含 index（之后该角色回忆不到这一场）。
 *  5 换提示词段：失败 -> failed 含 prompt（并跳过第 6 步）。
 *  6 提交开场指令：失败 -> failed 含 opening。
 */
export async function initializeGroup(req: GroupInitRequest, steps: GroupInitSteps): Promise<GroupInitOutcome> {
  const { tavern, entries, theme, limits } = req
  if (isReadonly(tavern)) return { kind: 'refused', why: 'readonly' }
  const ids = entries.map((e) => e.card.id)

  // 1 读齐所需内容
  let world: Awaited<ReturnType<typeof readWorld>>
  let me: Awaited<ReturnType<typeof readMe>>
  let memChars: number[]
  try {
    ;[world, me] = await Promise.all([readWorld(tavern.dir), readMe(tavern.dir)])
    memChars = await Promise.all(entries.map((e) => memoryChars(path.join(e.dir, MEMORY_FILE))))
  } catch (e) {
    return { kind: 'refused', why: 'read-failed', detail: (e as Error).message }
  }
  const notes: GroupInitNote[] = collectNotes({
    profileEmpty: me.empty, memoryChars: 0, memoryMax: limits.memoryMaxChars,
    worldChars: world.length, worldBudget: limits.worldBudget,
  }).flatMap((n: InitNote): GroupInitNote[] => {
    if (n.kind === 'profile-empty') return [{ kind: 'profile-empty' }]
    if (n.kind === 'world-over') return [{ kind: 'world-over', chars: n.chars, budget: n.budget }]
    return []
  })
  entries.forEach((e, i) => {
    if (memChars[i]! > limits.memoryMaxChars) notes.push({ kind: 'memory-over', name: e.card.name, chars: memChars[i]!, max: limits.memoryMaxChars })
  })

  // 2 建聊天目录
  let chat: Awaited<ReturnType<typeof createChat>>
  try {
    chat = await steps.createChat(tavern.dir, {
      kind: 'group', name: '群聊', participants: ids, sessionId: req.sessionId, now: req.now,
      scenario: req.scenario, present: ids,
    })
  } catch (e) {
    return { kind: 'refused', why: 'chat-dir-failed', detail: (e as Error).message }
  }

  // 3 会话记为场景中
  try {
    await steps.saveSession(sessionsFile(tavern.dir), req.sessionId, {
      mode: 'group', state: 'performing', chatId: chat.id,
    }, req.now)
  } catch (e) {
    await steps.removeDir(chat.dir).catch(() => undefined)
    return isAhaError(e, 'session-locked')
      ? { kind: 'refused', why: 'already-performing' }
      : { kind: 'refused', why: 'session-failed', detail: (e as Error).message }
  }

  // 此后状态不可逆
  const failed: GroupStepName[] = []

  // 4 每个在场角色的往事索引追加一行（不经过模型）
  for (const e of entries) {
    try {
      await steps.appendIndexLine(
        path.join(e.dir, MEMORY_FILE),
        { date: localDate(req.now), kind: 'group', id: chat.id, title: null },
        { characterName: e.card.name, maxIndexLines: limits.pastIndexMaxLines },
      )
    } catch (err) {
      req.warn?.(`初始化第 4 步（往事索引，${e.card.name}）失败：${(err as Error).message}`)
      if (!failed.includes('index')) failed.push('index')
    }
  }

  // 5 五段提示词替换掌柜的段；记忆重读一次，使其与恢复会话时读到的一致
  let promptOk = true
  try {
    const memoryRaw = await Promise.all(entries.map((e) => steps.readMemoryText(path.join(e.dir, MEMORY_FILE))))
    await steps.setSection(buildGroupPrompt({
      theme, houseRules: req.houseRules, world: world.text, scenario: req.scenario, profile: me.text,
      members: entries.map((e, i) => ({ card: e.card, memory: memoryRaw[i]! })),
    }))
  } catch (e) {
    req.warn?.(`初始化第 5 步（提示词段）失败：${(e as Error).message}`)
    promptOk = false
    failed.push('prompt')
  }

  // 6 开场指令
  if (promptOk) {
    try {
      steps.steer(buildGroupStartCue(), `${MODE_LABEL.group}：开场`)
    } catch (e) {
      req.warn?.(`初始化第 6 步（开场指令）失败：${(e as Error).message}`)
      failed.push('opening')
    }
  }
  return { kind: 'started', chatId: chat.id, names: entries.map((e) => e.card.name), scenario: req.scenario, notes, failed }
}

// ---------- 回执与工具返回 ----------

const guide = (text: string): Reply => ({ kind: 'success', text })

export function needScenarioReceipt(theme: Theme, names: readonly string[]): Reply {
  const list = names.map((n) => shownName(n)).join('、')
  return guide(`人齐了：${list}。这一场是什么${theme.concept('scenario')}？直接说说（说清人和情景），或用 \`/aha 开场 名字… ${theme.concept('scenario')}\` 一次说全。`)
}

export function overLimitReceipt(theme: Theme, count: number, max: number): Reply {
  return guide(`一场最多 ${max} 个${theme.concept('character')}在场，现在定了 ${count} 个，请减一些再试。`)
}

export function groupCancelledReceipt(): Reply {
  return guide('已取消，没有开场。')
}

const groupFailedText: Record<GroupStepName, string> = {
  index: '有人的往事索引没写上（之后回忆不到这一场）',
  prompt: '提示词没装好（你发下一句话时会再试一次）',
  opening: '开场指令没发出来（直接说话就行）',
}

function groupNoteText(theme: Theme, n: GroupInitNote): string {
  const setup = `「${MODE_LABEL.setup}」`
  switch (n.kind) {
    case 'profile-empty':
      return `你的${theme.concept('profile')}还是空的，可以去${setup}补上。`
    case 'memory-over':
      return `${shownName(n.name)}的${theme.concept('core_memory')}有 ${n.chars} 字，超过了 ${n.max} 字的上限，建议去${setup}精简。`
    case 'world-over':
      return `${theme.concept('world')}有 ${n.chars} 字，超过了 ${n.budget} 字的预算，建议精简。`
  }
}

export function startedGroupReceipt(theme: Theme, o: Extract<GroupInitOutcome, { kind: 'started' }>): Reply {
  const list = o.names.map((n) => shownName(n)).join('、')
  const head = o.failed.length
    ? `这一场开始了（${list}在场；${theme.concept('scenario')}：${shownName(o.scenario, 80)}），但有 ${o.failed.length} 步没做成：${o.failed.map((f) => groupFailedText[f]).join('；')}。`
    : `这一场开始了：${list}在场；${theme.concept('scenario')}：${shownName(o.scenario, 80)}。`
  return guide([head, ...o.notes.map((n) => groupNoteText(theme, n))].join('\n'))
}

export function refusedGroupReceipt(theme: Theme, o: Extract<GroupInitOutcome, { kind: 'refused' }>): Reply {
  switch (o.why) {
    case 'readonly':
      return readonlyReceipt(theme)
    case 'already-performing':
      return dispatchReceipt(theme, 'new-session')
    case 'read-failed':
      return failureReceipt(`读不了开场要用的内容（${o.detail ?? ''}）`)
    case 'chat-dir-failed':
      return failureReceipt(`建不了聊天目录（${o.detail ?? ''}），还在开局`)
    case 'session-failed':
      return failureReceipt(`没能记下会话状态（${o.detail ?? ''}），还在开局`)
  }
}

/** 给模型看的返回：成功是一句事实；失败给原因。 */
export function startedGroupToolText(o: GroupInitOutcome): string {
  if (o.kind === 'started') {
    const ids = o.names.join(', ')
    return o.failed.length ? `started with ${ids}; not done: ${o.failed.join(', ')}` : `started with ${ids}`
  }
  switch (o.why) {
    case 'readonly':
      return 'error: tavern data is newer than this plugin (read-only), cannot start'
    case 'already-performing':
      return 'already performing'
    case 'read-failed':
      return `error: cannot read show materials (${o.detail ?? ''}), still gathering`
    case 'chat-dir-failed':
      return `error: cannot create chat directory (${o.detail ?? ''}), still gathering`
    case 'session-failed':
      return `error: cannot save session state (${o.detail ?? ''}), still gathering`
  }
}

// ---------- 外壳：环境、开局、命令与工具 ----------

export interface GroupEnv {
  rt: Runtime
  sections: SessionSections
  /** 同一会话的开局与初始化排队执行 */
  gate: SessionGate
  getAsk(): AskFn | undefined
  getServices(): HostServices | undefined
  now(): Date
  /** 已记过日志的降级原因（会话 + 原因），同一原因只记一次 */
  warned?: Set<string>
  /** 对话落盘：换场写分界、收场读当前场景都用它 */
  recorder: GroupTranscriptRecorder
  /** 每个会话里用户已拒绝换场的场景号：同一场景内不再问（规格 §8.1） */
  declinedScenes: Map<string, Set<number>>
}

/** 开局阶段（含门外）掌柜段用的状态事实；读取失败降级为空。 */
export async function collectGatherFacts(rt: Pick<Runtime, 'log'>, cc: CommandContext, castMax: number): Promise<GatherFacts> {
  const tavern = cc.tavern
  const facts: GatherFacts = {
    place: tavern ? { kind: 'inside', name: tavern.marker.name } : { kind: 'outside', reason: cc.outsideReason ?? 'not-tavern' },
    characterCount: 0, brokenCards: [], profile: { empty: true, length: 0 }, castMax,
    ...(isReadonly(tavern) ? { readonly: true } : {}),
  }
  if (!tavern) return facts
  try {
    for (const e of await listCharacters(tavern.dir)) {
      if (e.ok) facts.characterCount += 1
      else facts.brokenCards.push({ dirName: e.dirName, problem: e.problem })
    }
  } catch (e) {
    rt.log.warn(`读取角色列表失败：${(e as Error).message}`)
  }
  try {
    const me = await readMe(tavern.dir)
    facts.profile = { empty: me.empty, length: me.length }
  } catch (e) {
    rt.log.warn(`读取主角档案失败：${(e as Error).message}`)
  }
  return facts
}

/** 会话结束：清掉该会话的降级日志记录（key 以会话编号加 NUL 开头）。 */
export function clearGroupWarned(env: GroupEnv, sessionId: string): void {
  if (!env.warned) return
  const prefix = `${sessionId}\u0000`
  for (const k of env.warned) if (k.startsWith(prefix)) env.warned.delete(k)
}

/** 会话提示词段的规划：场景中按盘上内容装五段（恢复会话也走这里），否则装掌柜（张罗）的段。 */
export function groupPlan(env: GroupEnv, agent: HostAgent, services: HostServices, theme: Theme): () => Promise<SectionPlan> {
  return async () => {
    const cc = await buildContext(agent, services, env.rt.log)
    if (cc.mode === null) return { kind: 'wait' }
    if (cc.mode !== 'group') return { kind: 'skip', note: `实际模式 ${cc.mode}` }
    if (cc.state === 'performing' && cc.tavern) {
      const degrade = (cause: GroupDegradeCause, reason: string): SectionPlan => {
        const warned = (env.warned ??= new Set<string>())
        const key = `${agent.id}\u0000${reason}`
        if (!warned.has(key)) {
          warned.add(key)
          const what = cause === 'card-unreadable' ? '有在场角色的卡读不出来' : '绑定的聊天目录不存在'
          env.rt.log.warn(`会话 ${agent.id}：${what}（${reason}），暂用降级提示词段，修好后下一步会恢复`)
        }
        return { kind: 'text', text: buildDegradedGroupPrompt(theme, cause, reason), temporary: true, note: '降级' }
      }
      // 聊天目录被删：对话记不下来，不装五段（场景中不可逆，也不退回开局）
      const chatId = cc.record?.chatId
      if (!chatId || !(await findChatDir(cc.tavern.dir, chatId))) {
        return degrade('chat-missing', `chatId=${chatId ?? '（无）'}`)
      }
      let meta: Awaited<ReturnType<typeof readChatMeta>>
      try {
        meta = await readChatMeta(cc.tavern.dir, chatId)
      } catch (e) {
        return degrade('chat-missing', `meta 读不出来：${(e as Error).message}`)
      }
      const present = meta.present ?? meta.participants
      const members: GoodEntry[] = []
      for (const id of present) {
        let entry: CharacterEntry | null
        try {
          entry = await readCharacter(cc.tavern.dir, id)
        } catch (e) {
          return degrade('card-unreadable', (e as Error).message)
        }
        if (!entry) return degrade('card-unreadable', `找不到角色 ${id}`)
        if (!entry.ok) return degrade('card-unreadable', `${entry.dirName}/ ${entry.problem}`)
        members.push(entry)
      }
      const [world, me] = await Promise.all([readWorld(cc.tavern.dir), readMe(cc.tavern.dir)])
      const memoryRaw = await Promise.all(members.map((e) => readMemoryText(path.join(e.dir, MEMORY_FILE))))
      return {
        kind: 'text', note: `场景中 ${members.map((m) => m.card.name).join('、')}`,
        text: buildGroupPrompt({
          theme, houseRules: houseRulesGroupText, world: world.text, scenario: meta.scenario ?? '', profile: me.text,
          members: members.map((e, i) => ({ card: e.card, memory: memoryRaw[i]! })),
        }),
      }
    }
    const facts = await collectGatherFacts(env.rt, cc, env.rt.config.groupCastMax)
    return { kind: 'text', text: buildGatherPrompt(theme, hostGatherGuide, facts), note: `开局 place=${facts.place.kind}` }
  }
}

export interface GroupStartInput {
  names?: string[]
  scenario?: string
}

/** 开局的结果：命令与工具共用，各自按自己的方式说明。 */
export type GroupStartResolution =
  | { kind: 'ready'; entries: GoodEntry[]; scenario: string }
  /** 用户在卡片上跳过、取消，或会话被中止 */
  | { kind: 'cancelled' }
  /** 人定了但情景还空着：请用户补一句话 */
  | { kind: 'need-scenario'; entries: GoodEntry[] }
  /** 卡片不可用（没有 userQuestions 服务），退回文字说明 */
  | { kind: 'no-card' }
  | { kind: 'name-none'; name: string }
  | { kind: 'name-ambiguous'; name: string; candidates: CharacterEntry[] }
  /** 名字对上的是坏卡 */
  | { kind: 'bad-card'; entry: BadEntry }
  | { kind: 'over-limit'; count: number; max: number }
  | { kind: 'card-failed'; message: string }

interface GroupInvocation {
  agent: HostAgent
  theme: Theme
  signal?: AbortSignal | undefined
}

/**
 * 开局（二期规格 §4.1、§4.2，命令与工具共用）：
 *  给了名字 -> 逐个按单聊的规则匹配；没给 -> 弹多选卡片定人。
 *  人定了但情景还空 -> need-scenario，由调用方请用户补。
 *  人与情景都齐 -> 复述确认卡片；自由输入算修改情景，再确认一轮（最多五轮）。
 */
export async function resolveGroupStart(
  env: GroupEnv, inv: GroupInvocation, entries: readonly CharacterEntry[], input: GroupStartInput,
): Promise<GroupStartResolution> {
  const { theme, agent, signal } = inv
  const castMax = env.rt.config.groupCastMax
  const ask = env.getAsk()

  let picked: GoodEntry[] | undefined
  if (input.names && input.names.length > 0) {
    const m = matchGroupNames(entries, input.names)
    if (m.kind === 'none') return { kind: 'name-none', name: m.name }
    if (m.kind === 'ambiguous') return { kind: 'name-ambiguous', name: m.name, candidates: m.candidates }
    if (m.kind === 'bad-card') return { kind: 'bad-card', entry: m.entry }
    picked = m.entries
  }
  if (!picked) {
    if (!ask) {
      env.rt.log.warn('开局：选择卡片不可用（没有 userQuestions 服务）')
      return { kind: 'no-card' }
    }
    const good = entries.filter((e): e is GoodEntry => e.ok)
    if (good.length > CAST_CARD_MAX) {
      return { kind: 'no-card' }
    }
    const q = buildCastQuestion(theme, good)
    let answer: unknown
    try {
      answer = await ask({ agent, ...(signal ? { signal } : {}), questions: [q.item] })
    } catch (e) {
      if (isAbort(e, signal)) return { kind: 'cancelled' }
      env.rt.log.warn(`定人卡片失败：${(e as Error).message}`)
      return { kind: 'card-failed', message: (e as Error).message }
    }
    const r = interpretCastAnswer(answer, q.byLabel)
    if (r.kind === 'cancel') return { kind: 'cancelled' }
    if (r.kind === 'custom') {
      const sp = splitOpeningArgs(entries, r.text)
      return resolveGroupStart(env, inv, entries, {
        names: sp.names.length > 0 ? sp.names : undefined,
        scenario: sp.scenario !== '' ? sp.scenario : input.scenario,
      })
    }
    const byId = new Map(good.map((e) => [e.card.id, e]))
    picked = r.ids.map((id) => byId.get(id)).filter((e): e is GoodEntry => e !== undefined)
    if (picked.length === 0) return { kind: 'cancelled' }
  }

  if (picked.length > castMax) return { kind: 'over-limit', count: picked.length, max: castMax }

  let scenario = input.scenario?.trim() ?? ''
  if (scenario === '') return { kind: 'need-scenario', entries: picked }

  if (!ask) {
    env.rt.log.warn('开局：确认卡片不可用（没有 userQuestions 服务）')
    return { kind: 'no-card' }
  }
  for (let round = 0; round < CONFIRM_ROUNDS_MAX; round++) {
    if (signal?.aborted) return { kind: 'cancelled' }
    let answer: unknown
    try {
      answer = await ask({
        agent, ...(signal ? { signal } : {}),
        questions: [buildGroupConfirmQuestion(theme, picked.map((e) => e.card.name), scenario)],
      })
    } catch (e) {
      if (isAbort(e, signal)) return { kind: 'cancelled' }
      env.rt.log.warn(`复述确认卡片失败：${(e as Error).message}`)
      return { kind: 'card-failed', message: (e as Error).message }
    }
    const r = interpretGroupConfirm(answer)
    if (r.kind === 'start') return { kind: 'ready', entries: picked, scenario }
    if (r.kind === 'cancel') return { kind: 'cancelled' }
    // 自由输入：当作改过的情景，再确认一轮
    scenario = r.text
  }
  return { kind: 'cancelled' }
}

const displayOf = (e: CharacterEntry): string => (e.ok ? e.card.name : e.dirName)

/** 命令对开局结果的说明（用户可见，概念词走主题）；定好返回 null。 */
function groupResolutionReply(theme: Theme, entries: readonly CharacterEntry[], r: GroupStartResolution): Reply | null {
  switch (r.kind) {
    case 'ready':
      return null
    case 'cancelled':
      return groupCancelledReceipt()
    case 'need-scenario':
      return needScenarioReceipt(theme, r.entries.map((e) => e.card.name))
    case 'no-card':
      return failureReceipt('选择卡片不可用，请敲 `/aha 开场 名字… 情景`')
    case 'name-none':
      return guide(`没有叫「${shownName(r.name)}」的${theme.concept('character')}。现有的有：${entries.map(displayOf).map((n) => shownName(n)).join('、')}。`)
    case 'name-ambiguous':
      return guide(`「${shownName(r.name)}」对得上好几个：${r.candidates.map(displayOf).map((n) => shownName(n)).join('、')}。请把名字写全再试。`)
    case 'bad-card':
      return cardBrokenReceipt(theme, r.entry)
    case 'over-limit':
      return overLimitReceipt(theme, r.count, r.max)
    case 'card-failed':
      return failureReceipt(`选择卡片没弹出来（${r.message}）`)
  }
}

/** 工具对开局结果的返回（给模型看，固定标识）；定好返回 null。 */
function groupResolutionToolText(entries: readonly CharacterEntry[], r: GroupStartResolution): string | null {
  const one = (t: string): string => flatText(t, 'available')
  const names = entries.map((e) => one(displayOf(e))).join(', ')
  switch (r.kind) {
    case 'ready':
      return null
    case 'cancelled':
      return 'cancelled by user, still gathering'
    case 'need-scenario':
      return 'scenario missing: ask the user what this show is about, then call again with names and scenario'
    case 'no-card':
      return `error: selection card unavailable; available: ${names}`
    case 'name-none':
      return `error: no character named ${one(r.name)}; available: ${names}`
    case 'name-ambiguous':
      return `error: ambiguous name ${one(r.name)}; candidates: ${r.candidates.map((e) => one(displayOf(e))).join(', ')}`
    case 'bad-card':
      return `error: card of "${one(r.entry.dirName)}" is unreadable (${r.entry.problem})`
    case 'over-limit':
      return `error: too many characters for one show (${r.count} > ${r.max}); ask the user to reduce the cast`
    case 'card-failed':
      return `error: selection card failed (${one(r.message)}), still gathering; available: ${names}`
  }
}

function groupRequestOf(env: GroupEnv, tavern: TavernInfo, entries: GoodEntry[], scenario: string, sessionId: string, theme: Theme): GroupInitRequest {
  const c = env.rt.config
  return {
    tavern, entries, scenario, sessionId, theme, houseRules: houseRulesGroupText, now: env.now(),
    warn: (m) => env.rt.log.warn(m),
    limits: { worldBudget: c.worldBudget, memoryMaxChars: c.memoryMaxChars, pastIndexMaxLines: c.pastIndexMaxLines },
  }
}

/** 把"换段"接到会话的段管理器；失败时让下一次 pre-step 重新规划，并把错误抛给 initializeGroup 记为第 5 步失败。 */
function groupSectionSetter(env: GroupEnv, agent: HostAgent): GroupInitSteps['setSection'] {
  return async (text) => {
    try {
      await env.sections.refresh(agent, async () => ({ kind: 'text', text, note: '五段' }))
    } catch (e) {
      env.sections.invalidate(agent.id)
      throw e
    }
  }
}

/** `开场` 命令（群聊）。 */
export function groupStartHandler(env: GroupEnv): CommandHandler {
  return async (inv) => {
    const tavern = inv.context.tavern
    const { theme, agent, rt } = inv
    if (!tavern) return failureReceipt(`这里还不是${theme.concept('tavern')}`)
    return env.gate.run(agent.id, async () => {
      // 排队期间状态可能变了（前一次已开场）：在弹卡片之前按盘上重新读
      const fresh = await buildContext(agent, inv.services, rt.log)
      if (fresh.state === 'performing') return dispatchReceipt(theme, 'new-session')
      if (isReadonly(fresh.tavern)) return readonlyReceipt(theme)
      const entries = await listCharacters(tavern.dir)
      const problem = checkRoster(entries)
      if (problem) return rosterReceipt(theme, problem)
      const sp = splitOpeningArgs(entries, inv.args)
      const res = await resolveGroupStart(env, inv, entries, {
        names: sp.names.length > 0 ? sp.names : undefined,
        scenario: sp.scenario !== '' ? sp.scenario : undefined,
      })
      const reply = groupResolutionReply(theme, entries, res)
      if (reply || res.kind !== 'ready') return reply ?? groupCancelledReceipt()
      const outcome = await initializeGroup(
        groupRequestOf(env, tavern, res.entries, res.scenario, agent.id, theme),
        realGroupSteps({ setSection: groupSectionSetter(env, agent), steer: inv.steer }),
      )
      rt.log.info(`开场（群聊）：${outcome.kind === 'started' ? `${outcome.names.join('、')}（${outcome.chatId}）未完成=${outcome.failed.join(',') || '无'}` : `拒绝 ${outcome.why}`}`)
      return outcome.kind === 'started' ? startedGroupReceipt(theme, outcome) : refusedGroupReceipt(theme, outcome)
    }, 'command')
  }
}

/** aha_start（群聊）工具的实现：返回给模型的文字。 */
export function groupStartTool(
  env: GroupEnv,
): (agent: HostAgent | undefined, args: GroupStartArgs, signal?: AbortSignal) => Promise<string> {
  return async (agent, args, signal) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    // 命令的卡片还开着：用户没回答之前排在后面会一直卡住，直接告诉模型等一等
    if (env.gate.commandHolds(agent.id)) return CARD_OPEN_MESSAGE
    return env.gate.run(agent.id, async () => {
      const theme = await env.rt.theme()
      const cc = await buildContext(agent, services, env.rt.log)
      if (cc.mode !== 'group') return 'error: not available in this mode'
      if (cc.state === 'performing') return 'already performing'
      if (!cc.tavern) return 'error: this workspace is not a tavern'
      const entries = await listCharacters(cc.tavern.dir)
      const problem = checkRoster(entries)
      if (problem) return problem.kind === 'no-characters' ? 'error: no characters in this tavern' : 'error: every card is unreadable'
      const res = await resolveGroupStart(env, { agent, theme, signal }, entries, args)
      const text = groupResolutionToolText(entries, res)
      if (text !== null || res.kind !== 'ready') return text ?? 'error: start failed'
      const steer = (text: string, summary: string): void => {
        if (typeof agent.steer !== 'function') throw new Error('宿主 agent 没有 steer')
        agent.steer(makeNotice(text, summary))
      }
      const outcome = await initializeGroup(
        groupRequestOf(env, cc.tavern, res.entries, res.scenario, agent.id, theme),
        realGroupSteps({ setSection: groupSectionSetter(env, agent), steer }),
      )
      env.rt.log.info(`aha_start（群聊）：${outcome.kind === 'started' ? `${outcome.names.join('、')}（${outcome.chatId}）未完成=${outcome.failed.join(',') || '无'}` : `拒绝 ${outcome.why}`}`)
      return startedGroupToolText(outcome)
    })
  }
}

interface GroupHost {
  inject(keys: readonly string[], cb: (c: GroupInjected) => void): void
  on(event: string, listener: (...args: any[]) => unknown): unknown
}
interface GroupInjected extends HostServices, GroupHost {}

/** 只在群聊实例里装配：开场命令与工具，created / pre-step / disposed 监听。 */
export function installGroup(ctx: Context, rt: Runtime): void {
  const sections = new SessionSections(rt.log, hostSectionRegister(SECTION_NAME, SECTION_ORDER), '群聊提示词段')
  let services: HostServices | undefined
  let ask: AskFn | undefined
  const host = ctx as unknown as GroupHost
  host.inject(['userQuestions'], (c) => {
    const uq = (c as unknown as { userQuestions: { ask: AskFn } }).userQuestions
    ask = (req) => uq.ask(req)
  })
  // 对话逐段落盘：用户的话取自入步消息，回复按行首标记拆分（规格 §6、§10）。
  // resolve 在事件里才会被调，那时 services 已由下面的 inject 赋上。
  const recorder = new GroupTranscriptRecorder({
    resolve: (agent) => (services ? resolveGroupTarget(agent, services, rt) : Promise.resolve(null)),
    log: rt.log,
  })
  const env: GroupEnv = {
    rt, sections, gate: new SessionGate(), getAsk: () => ask, getServices: () => services, now: () => new Date(),
    recorder, declinedScenes: new Map(),
  }
  rt.cards = { gate: env.gate, getAsk: () => ask }
  const rebuild = async (agent: HostAgent): Promise<void> => {
    if (!services) return
    await sections.refresh(agent, groupPlan(env, agent, services, await rt.theme()))
  }
  const memoryEnv: GroupMemoryEnv = {
    rt, getServices: () => services,
    turns: new RememberTurns(), recallTurns: new RememberTurns(),
    reminder: new ReviewReminder(rt.config.reviewIntervalTurns),
    recorder,
  }
  registerGroupTools(ctx, {
    start: groupStartTool(env), scene: sceneTool(env, { rebuild }), wrap: wrapTool(env),
    remember: groupRememberTool(memoryEnv), recall: groupRecallTool(memoryEnv), review: groupReviewTool(memoryEnv),
  })
  rt.handlers.start = groupStartHandler(env)
  rt.handlers.narrator = narratorHandler({ recorder })
  rt.handlers.scene = sceneHandler()
  rt.handlers.wrap = wrapHandler()
  rt.handlers.remember = groupRememberHandler(memoryEnv)
  host.inject(['agentPresets'], (c) => {
    services = c
    const ensure = async (agent: HostAgent, via: string): Promise<void> => {
      try {
        await sections.ensure(agent, groupPlan(env, agent, c, await rt.theme()))
      } catch (e) {
        rt.log.error(`注册群聊提示词段失败（${via}）：${(e as Error).stack ?? e}`)
      }
    }
    // 新建与恢复会话时就注册（恢复的场景中会话在这里还原五段）；pre-step 兜底，且必须 return next()
    c.on('agent/created', (payload: { agent: HostAgent }) => {
      void ensure(payload.agent, 'created')
    })
    c.on('agent/pre-step', async (payload: { agent: HostAgent; messages?: readonly unknown[]; turn?: unknown }, next: () => Promise<unknown>) => {
      await ensure(payload.agent, 'pre-step')
      const newUsers = recorder.onStep(payload.agent, (payload.messages ?? []) as never)
      void onGroupMemoryStep(memoryEnv, payload.agent, payload.turn, newUsers)
      return next()
    })
    c.on('agent/assistant-stream', (payload: { agent: HostAgent; frame: unknown }) => {
      recorder.onFrame(payload.agent, payload.frame as never)
    })
    c.on('agent/disposed', (payload: { agent: { id: string } }) => {
      sections.forget(payload.agent.id)
      clearGroupWarned(env, payload.agent.id)
      recorder.forget(payload.agent.id)
      env.declinedScenes.delete(payload.agent.id)
      memoryEnv.turns.forget(payload.agent.id)
      memoryEnv.recallTurns.forget(payload.agent.id)
      memoryEnv.reminder.forget(payload.agent.id)
    })
    rt.log.info('群聊外壳已装配（created / pre-step / disposed 监听）')
  })
}
