// 单聊模式的外壳：选角（三个入口）、前置检查、初始化、开场指令，以及 created / pre-step / disposed 的装配。
// 会话的提示词段只有一个：门外与选角阶段是掌柜（选角）的文字，进入聊天后整段换成五段。
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import houseRulesText from '../prompts/house-rules.md'
import hostPickGuide from '../prompts/host-pick.md'
import {
  listCharacters, matchCharacterName, MEMORY_FILE, readCharacter, type CharacterEntry,
} from '../core/card'
import { createChat, findChatDir } from '../core/chat'
import { readMe, readWorld } from '../core/docs'
import { isAhaError } from '../core/errors'
import { appendIndexLine, memoryChars, readMemory, readMemoryText } from '../core/memory'
import { saveSession } from '../core/state'
import type { TavernInfo } from '../core/tavern'
import type { Theme } from '../core/theme'
import {
  answerItem, isAbort, SessionGate, shownName, type AskFn, type AskItem,
} from './confirm'
import { buildContext, sessionsFile, type CommandContext, type CommandHandler, type HostAgent, type HostServices } from './context'
import { clip, uniqueLabel, type Labeled } from './importing'
import { buildChatPrompt, buildDegradedPrompt, buildPickPrompt, type DegradeCause, type PickFacts } from './prompt'
import {
  cardAmbiguousReceipt, cardBrokenReceipt, dispatchReceipt, failureReceipt, MODE_LABEL, readonlyReceipt, type Reply,
} from './receipts'
import type { Runtime } from './runtime'
import { hostSectionRegister, SessionSections, type SectionPlan } from './sections'
import { makeNotice } from './steer'
import { registerChatTools, type StartArgs } from './chat-tools'
import { createMemoryEnv, onChatStep, rememberHandler, rememberTool, reviewTool } from './remember'
import { recallTool } from './recall'
import { resolveChatTarget, TranscriptRecorder } from './transcript'
import { isReadonly } from './writable'

const SECTION_NAME = 'aha:chat'
const SECTION_ORDER = 5000
/** 选择卡片一页最多的选项数（含"更多…"）。宿主的实际上限没有查到，12 是保守取值。 */
export const PICK_PAGE = 12
const TAGLINE_MAX = 60
export const OPT_MORE = '更多…'

// ---------- 纯函数：排序、选项、前置检查、文字 ----------

export type GoodEntry = Extract<CharacterEntry, { ok: true }>
export type BadEntry = Extract<CharacterEntry, { ok: false }>

/** 最近聊过的排前面（日期新的在前，同日按名字）；没聊过的排后面按名字。 */
export function sortCandidates(entries: readonly GoodEntry[], lastDate: ReadonlyMap<string, string>): GoodEntry[] {
  const byName = (a: GoodEntry, b: GoodEntry) => a.card.name.localeCompare(b.card.name, 'zh')
  return [...entries].sort((a, b) => {
    const da = lastDate.get(a.card.id)
    const db = lastDate.get(b.card.id)
    if (da && db) return da === db ? byName(a, b) : da < db ? 1 : -1
    if (da) return -1
    if (db) return 1
    return byName(a, b)
  })
}

export type PickValue = { kind: 'character'; id: string } | { kind: 'more' }

/**
 * 选角卡片：超过一页时分批，每批最后一项是"更多…"，最后一批放完剩下的。
 * 选项文字就是名字（重名加序号），说明是简介。
 */
export function buildPickBatches(theme: Theme, sorted: readonly GoodEntry[], page = PICK_PAGE): Array<Labeled<PickValue>> {
  const used = new Set<string>([OPT_MORE])
  const rows = sorted.map((e) => ({
    label: uniqueLabel(shownName(e.card.name), used),
    description: e.card.tagline ? clip(e.card.tagline, TAGLINE_MAX) : '',
    value: { kind: 'character', id: e.card.id } as PickValue,
  }))
  const batches: Array<Labeled<PickValue>> = []
  let rest = rows
  for (let n = 1; ; n++) {
    const more = rest.length > page
    const part = more ? rest.slice(0, page - 1) : rest
    rest = more ? rest.slice(page - 1) : []
    const options = part.map((r) => ({ label: r.label, description: r.description }))
    const byLabel = new Map<string, PickValue>(part.map((r) => [r.label, r.value]))
    if (more) {
      options.push({ label: OPT_MORE, description: `还有 ${rest.length} 个${theme.concept('character')}` })
      byLabel.set(OPT_MORE, { kind: 'more' })
    }
    const only = sorted.length === 1 ? sorted[0]! : null
    batches.push({
      item: {
        id: `pick-${n}`,
        header: theme.concept('character'),
        question: only
          ? `和「${shownName(only.card.name)}」聊聊？`
          : `和哪位${theme.concept('character')}聊？${batches.length > 0 || more ? `（第 ${n} 批）` : ''}`,
        options,
      },
      byLabel,
    })
    if (!more) break
  }
  return batches
}

export type PickAnswer =
  | { kind: 'character'; id: string }
  | { kind: 'more' }
  /** 自由输入：规格 11 规定选角时按角色名匹配 */
  | { kind: 'name'; text: string }
  | { kind: 'cancel' }

/** 卡片回答 -> 结果；跳过、没选、选了不认识的都是取消。 */
export function interpretPick(answer: unknown, q: Labeled<PickValue>): PickAnswer {
  const item = answerItem(answer, q.item.id)
  if (!item) return { kind: 'cancel' }
  const custom = typeof item.custom === 'string' ? item.custom.trim() : ''
  const selected = Array.isArray(item.selected) ? item.selected : []
  if (custom !== '') return selected.length === 0 ? { kind: 'name', text: custom } : { kind: 'cancel' }
  if (selected.length !== 1) return { kind: 'cancel' }
  const v = q.byLabel.get(selected[0]!)
  return v ? (v.kind === 'more' ? { kind: 'more' } : { kind: 'character', id: v.id }) : { kind: 'cancel' }
}

export type RosterProblem = { kind: 'no-characters' } | { kind: 'no-usable'; broken: BadEntry[] }

/** 前置检查之一：酒馆里没有角色，或有但全是坏卡。 */
export function checkRoster(entries: readonly CharacterEntry[]): RosterProblem | null {
  if (entries.length === 0) return { kind: 'no-characters' }
  const broken = entries.filter((e): e is BadEntry => !e.ok)
  return broken.length === entries.length ? { kind: 'no-usable', broken } : null
}

export type InitNote =
  | { kind: 'profile-empty' }
  | { kind: 'memory-over'; chars: number; max: number }
  | { kind: 'world-over'; chars: number; budget: number }

/** 前置检查之二：照常初始化、只在回执里提醒的几项（规格 6.1、6.2、7.6）。 */
export function collectNotes(i: {
  profileEmpty: boolean; memoryChars: number; memoryMax: number; worldChars: number; worldBudget: number
}): InitNote[] {
  const notes: InitNote[] = []
  if (i.profileEmpty) notes.push({ kind: 'profile-empty' })
  if (i.memoryChars > i.memoryMax) notes.push({ kind: 'memory-over', chars: i.memoryChars, max: i.memoryMax })
  if (i.worldChars > i.worldBudget) notes.push({ kind: 'world-over', chars: i.worldChars, budget: i.worldBudget })
  return notes
}

/** 开场指令（规格 6.3）：第一次见面说出场白，否则带着记忆自然地打招呼。 */
export function buildStartCue(firstMeeting: boolean): string {
  return firstMeeting
    ? '（通知）聊天开始了，你和 user 第一次见面。请以 character 的身份先开口：说出 <card> 里 greeting 的出场白；'
      + '没有 greeting 就用角色的口吻打个招呼。不要提这条通知。'
    : '（通知）聊天开始了，你和 user 以前聊过（见 <core_memory>）。请以 character 的身份先开口，自然地打个招呼，'
      + '不要复述记忆，也不要重复出场白。不要提这条通知。'
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 本地日期 YYYY-MM-DD，往事索引用。 */
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// ---------- 初始化 ----------

export type StepName = 'index' | 'prompt' | 'opening'
export type RefusalWhy = 'readonly' | 'broken' | 'read-failed' | 'chat-dir-failed' | 'session-failed' | 'already-chatting'

export type InitOutcome =
  | {
      kind: 'started'
      chatId: string
      characterId: string
      name: string
      notes: InitNote[]
      /** 状态已不可逆之后没做成的步骤 */
      failed: StepName[]
    }
  | { kind: 'refused'; why: RefusalWhy; detail?: string; broken?: BadEntry }

/** 初始化第 2 至 6 步用到的动作；测试里可替换。setSection 与 steer 由调用方按会话接入。 */
export interface InitSteps {
  createChat: typeof createChat
  saveSession: typeof saveSession
  appendIndexLine: typeof appendIndexLine
  readMemoryText: typeof readMemoryText
  removeDir(dir: string): Promise<void>
  /** 把会话的提示词段换成这段文字 */
  setSection(text: string): Promise<void>
  /** 提交开场指令 */
  steer(text: string, summary: string): void
}

export function realSteps(io: Pick<InitSteps, 'setSection' | 'steer'>): InitSteps {
  return {
    createChat, saveSession, appendIndexLine, readMemoryText,
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    ...io,
  }
}

export interface InitRequest {
  tavern: Pick<TavernInfo, 'dir' | 'access'>
  entry: CharacterEntry
  sessionId: string
  houseRules: string
  theme: Theme
  limits: { worldBudget: number; memoryMaxChars: number; pastIndexMaxLines: number }
  now: Date
}

/**
 * 初始化一次聊天（规格 6.1）。任何一步失败的结果与盘上状态：
 *  1 读取：失败 -> refused(read-failed)，盘上无改动。
 *  2 建聊天目录：失败 -> refused(chat-dir-failed)；可能留下一个只有（或没有）meta.yaml 的空聊天目录，
 *    没有索引行、没有会话记录，不影响任何功能。仍在选角状态。
 *  3 存会话状态：失败 -> refused(session-failed)；刚建的聊天目录尽力删掉（里面只有 meta.yaml）。
 *    会话已是聊天中（session-locked）-> refused(already-chatting)。仍在选角状态。
 *    —— 从这一步成功起，会话状态不可逆，以下步骤失败都不回退，结果为 started 并列出没做成的步骤：
 *  4 追加往事索引：失败 -> failed 含 index；盘上有聊天目录和会话记录，主线记忆里缺这一行
 *    （回忆时找不到本次聊天，其余照常）。继续 5、6。
 *  5 换提示词段：失败 -> failed 含 prompt（并跳过第 6 步，没有角色提示词时不该让模型开口）；
 *    盘上状态完整，会话还挂着掌柜的段。调用方应让下一次 pre-step 重新规划（此时状态是聊天中，会按盘上内容装五段）。
 *  6 提交开场指令：失败 -> failed 含 opening；一切就绪，只是角色没有先开口，用户说话即可。
 */
export async function initialize(req: InitRequest, steps: InitSteps): Promise<InitOutcome> {
  const { tavern, entry, theme, limits } = req
  if (isReadonly(tavern)) return { kind: 'refused', why: 'readonly' }
  if (!entry.ok) return { kind: 'refused', why: 'broken', broken: entry }
  const card = entry.card
  const memFile = path.join(entry.dir, MEMORY_FILE)

  // 1 读齐五段所需内容
  let world: Awaited<ReturnType<typeof readWorld>>
  let me: Awaited<ReturnType<typeof readMe>>
  let memory: Awaited<ReturnType<typeof readMemory>>
  let memChars: number
  try {
    ;[world, me, memory, memChars] = await Promise.all([
      readWorld(tavern.dir), readMe(tavern.dir), readMemory(memFile), memoryChars(memFile),
    ])
  } catch (e) {
    return { kind: 'refused', why: 'read-failed', detail: (e as Error).message }
  }
  const notes = collectNotes({
    profileEmpty: me.empty, memoryChars: memChars, memoryMax: limits.memoryMaxChars,
    worldChars: world.length, worldBudget: limits.worldBudget,
  })
  const firstMeeting = memory.index.length === 0

  // 2 建聊天目录
  let chat: Awaited<ReturnType<typeof createChat>>
  try {
    chat = await steps.createChat(tavern.dir, {
      kind: 'chat', name: card.name, participants: [card.id], sessionId: req.sessionId, now: req.now,
    })
  } catch (e) {
    return { kind: 'refused', why: 'chat-dir-failed', detail: (e as Error).message }
  }

  // 3 会话记为聊天中
  try {
    await steps.saveSession(sessionsFile(tavern.dir), req.sessionId, {
      mode: 'chat', state: 'chatting', chatId: chat.id, characterId: card.id,
    }, req.now)
  } catch (e) {
    await steps.removeDir(chat.dir).catch(() => undefined)
    return isAhaError(e, 'session-locked')
      ? { kind: 'refused', why: 'already-chatting' }
      : { kind: 'refused', why: 'session-failed', detail: (e as Error).message }
  }

  // 此后状态不可逆
  const failed: StepName[] = []

  // 4 往事索引追加"未整理"一行（不经过模型）
  try {
    await steps.appendIndexLine(memFile, { date: localDate(req.now), kind: 'chat', id: chat.id }, {
      characterName: card.name, maxIndexLines: limits.pastIndexMaxLines,
    })
  } catch {
    failed.push('index')
  }

  // 5 五段提示词替换掌柜的段；记忆重读一次，使其与恢复会话时读到的一致
  let promptOk = true
  try {
    const memoryRaw = await steps.readMemoryText(memFile)
    await steps.setSection(buildChatPrompt({
      theme, houseRules: req.houseRules, world: world.text, card, profile: me.text, memory: memoryRaw,
    }))
  } catch {
    promptOk = false
    failed.push('prompt')
  }

  // 6 开场指令
  if (promptOk) {
    try {
      steps.steer(buildStartCue(firstMeeting), `${MODE_LABEL.chat}：开场`)
    } catch {
      failed.push('opening')
    }
  }
  return { kind: 'started', chatId: chat.id, characterId: card.id, name: card.name, notes, failed }
}

// ---------- 回执与工具返回 ----------

const guide = (text: string): Reply => ({ kind: 'success', text })

export function rosterReceipt(theme: Theme, p: RosterProblem): Reply {
  if (p.kind === 'no-characters') {
    return guide(`这间${theme.concept('tavern')}里还没有${theme.concept('character')}。请切换到「${MODE_LABEL.setup}」建${theme.concept('card')}。`)
  }
  const names = p.broken.map((b) => `「${b.dirName}」`).join('、')
  return {
    kind: 'error',
    text: `这间${theme.concept('tavern')}里的${theme.concept('card')}都读不出来：${names}。请先用编辑器修好，或到「${MODE_LABEL.setup}」处理。`,
  }
}

export function pickNoneReceipt(theme: Theme, input: string, available: readonly string[]): Reply {
  return guide(`没有叫「${shownName(input)}」的${theme.concept('character')}。现有的有：${available.map((n) => shownName(n)).join('、')}。`)
}

export function pickCancelledReceipt(): Reply {
  return guide('已取消，没有开始聊天。')
}

const failedText = (theme: Theme): Record<StepName, string> => ({
  index: `这次聊天没记进${theme.concept('core_memory')}的往事里`,
  prompt: '提示词没装好（你发下一句话时会再试一次）',
  opening: '开场指令没发出来（直接和 TA 说话就行）',
})

function noteText(theme: Theme, n: InitNote): string {
  const setup = `「${MODE_LABEL.setup}」`
  switch (n.kind) {
    case 'profile-empty':
      return `你的${theme.concept('profile')}还是空的，可以去${setup}补上。`
    case 'memory-over':
      return `这位${theme.concept('character')}的${theme.concept('core_memory')}有 ${n.chars} 字，超过了 ${n.max} 字的上限，建议去${setup}精简。`
    case 'world-over':
      return `${theme.concept('world')}有 ${n.chars} 字，超过了 ${n.budget} 字的预算，建议精简。`
  }
}

export function startedReceipt(theme: Theme, o: Extract<InitOutcome, { kind: 'started' }>): Reply {
  const name = shownName(o.name)
  const head = o.failed.length
    ? `和「${name}」的聊天已经开始，但有 ${o.failed.length} 步没做成：${o.failed.map((f) => failedText(theme)[f]).join('；')}。`
    : `和「${name}」的聊天开始了。`
  return guide([head, ...o.notes.map((n) => noteText(theme, n))].join('\n'))
}

export function refusedReceipt(theme: Theme, o: Extract<InitOutcome, { kind: 'refused' }>): Reply {
  switch (o.why) {
    case 'readonly':
      return readonlyReceipt(theme)
    case 'broken':
      return cardBrokenReceipt(theme, o.broken!)
    case 'already-chatting':
      return dispatchReceipt(theme, 'new-session')
    case 'read-failed':
      return failureReceipt(`读不了开聊要用的内容（${o.detail ?? ''}）`)
    case 'chat-dir-failed':
      return failureReceipt(`建不了聊天目录（${o.detail ?? ''}），还在选${theme.concept('character')}`)
    case 'session-failed':
      return failureReceipt(`没能记下会话状态（${o.detail ?? ''}），还在选${theme.concept('character')}`)
  }
}

/** 给模型看的返回：成功是一句事实；失败给原因。 */
export function startedToolText(o: InitOutcome): string {
  if (o.kind === 'started') {
    return o.failed.length ? `started with ${o.characterId}; not done: ${o.failed.join(', ')}` : `started with ${o.characterId}`
  }
  switch (o.why) {
    case 'readonly':
      return 'error: tavern data is newer than this plugin (read-only), cannot start'
    case 'broken':
      return `error: card of "${o.broken!.dirName}" is unreadable (${o.broken!.problem}${o.broken!.detail ? `: ${o.broken!.detail}` : ''})`
    case 'already-chatting':
      return 'already chatting'
    case 'read-failed':
      return `error: cannot read chat materials (${o.detail ?? ''}), still picking`
    case 'chat-dir-failed':
      return `error: cannot create chat directory (${o.detail ?? ''}), still picking`
    case 'session-failed':
      return `error: cannot save session state (${o.detail ?? ''}), still picking`
  }
}

// ---------- 外壳：环境、选角、命令与工具 ----------

export interface ChatEnv {
  rt: Runtime
  sections: SessionSections
  /** 同一会话的选角与初始化排队执行 */
  gate: SessionGate
  getAsk(): AskFn | undefined
  getServices(): HostServices | undefined
  now(): Date
  /** 已记过日志的降级原因（会话 + 原因），同一原因只记一次 */
  warned?: Set<string>
}

/** 各角色最近一次聊天的日期（往事索引最后一行）；读不出来的不列入。 */
async function lastTalkedDates(entries: readonly GoodEntry[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(entries.map(async (e) => {
    try {
      const last = (await readMemory(path.join(e.dir, MEMORY_FILE))).index.at(-1)
      if (last) out.set(e.card.id, last.date)
    } catch {
      // 读不出来按没聊过处理
    }
  }))
  return out
}

/** 选角阶段（含门外）掌柜段用的状态事实；读取失败降级为空。 */
export async function collectPickFacts(rt: Pick<Runtime, 'log'>, cc: CommandContext): Promise<PickFacts> {
  const tavern = cc.tavern
  const facts: PickFacts = {
    place: tavern ? { kind: 'inside', name: tavern.marker.name } : { kind: 'outside', reason: cc.outsideReason ?? 'not-tavern' },
    characters: [], brokenCards: [], profile: { empty: true, length: 0 },
    ...(isReadonly(tavern) ? { readonly: true } : {}),
  }
  if (!tavern) return facts
  try {
    for (const e of await listCharacters(tavern.dir)) {
      if (e.ok) facts.characters.push({ id: e.card.id, name: e.card.name, ...(e.card.tagline ? { tagline: e.card.tagline } : {}) })
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

/** 会话提示词段的规划：聊天中按盘上内容装五段（恢复会话也走这里），否则装掌柜（选角）的段。 */
export function chatPlan(env: ChatEnv, agent: HostAgent, services: HostServices, theme: Theme): () => Promise<SectionPlan> {
  return async () => {
    const cc = await buildContext(agent, services, env.rt.log)
    if (cc.mode === null) return { kind: 'wait' }
    if (cc.mode !== 'chat') return { kind: 'skip', note: `实际模式 ${cc.mode}` }
    if (cc.state === 'chatting' && cc.tavern) {
      const id = cc.record?.characterId
      const degrade = (cause: DegradeCause, reason: string): SectionPlan => {
        const warned = (env.warned ??= new Set<string>())
        const key = `${agent.id}\u0000${reason}`
        if (!warned.has(key)) {
          warned.add(key)
          const what = cause === 'card-unreadable' ? '绑定的角色卡读不出来' : '绑定的聊天目录不存在'
          env.rt.log.warn(`会话 ${agent.id}：${what}（${reason}），暂用降级提示词段，修好后下一步会恢复`)
        }
        return { kind: 'text', text: buildDegradedPrompt(theme, cause, reason), temporary: true, note: '降级' }
      }
      if (!id) return degrade('card-unreadable', '会话记录里没有角色编号')
      let entry: CharacterEntry | null
      try {
        entry = await readCharacter(cc.tavern.dir, id)
      } catch (e) {
        return degrade('card-unreadable', (e as Error).message)
      }
      if (!entry) return degrade('card-unreadable', `找不到角色 ${id}`)
      if (!entry.ok) return degrade('card-unreadable', `${entry.dirName}/ ${entry.problem}`)
      // 聊天目录被删：对话记不下来，不装五段（聊天中不可逆，也不退回选角）
      const chatId = cc.record?.chatId
      if (!chatId || !(await findChatDir(cc.tavern.dir, chatId))) {
        return degrade('chat-missing', `chatId=${chatId ?? '（无）'}`)
      }
      const [world, me, memory] = await Promise.all([
        readWorld(cc.tavern.dir), readMe(cc.tavern.dir), readMemoryText(path.join(entry.dir, MEMORY_FILE)),
      ])
      return {
        kind: 'text', note: `聊天中 ${entry.card.name}`,
        text: buildChatPrompt({ theme, houseRules: houseRulesText, world: world.text, card: entry.card, profile: me.text, memory }),
      }
    }
    const facts = await collectPickFacts(env.rt, cc)
    return { kind: 'text', text: buildPickPrompt(theme, hostPickGuide, facts), note: `选角 place=${facts.place.kind}` }
  }
}

type Resolution =
  | { kind: 'entry'; entry: CharacterEntry }
  | { kind: 'reply'; reply: Reply }

const displayOf = (e: CharacterEntry): string => (e.ok ? e.card.name : e.dirName)

/** 名字 -> 要初始化的条目，或应回的说明。 */
function resolveByName(theme: Theme, entries: readonly CharacterEntry[], input: string): Resolution {
  const m = matchCharacterName([...entries], input)
  switch (m.kind) {
    case 'exact':
    case 'prefix':
      return { kind: 'entry', entry: m.entry }
    case 'ambiguous':
      return { kind: 'reply', reply: cardAmbiguousReceipt(theme, m.candidates.map(displayOf)) }
    case 'none':
      return { kind: 'reply', reply: pickNoneReceipt(theme, input, entries.map(displayOf)) }
  }
}

/** 不带名字：弹单选卡片（不经过模型）。 */
async function pickByCard(
  env: ChatEnv, inv: Pick<Parameters<CommandHandler>[0], 'agent' | 'theme' | 'signal'>, entries: readonly CharacterEntry[],
): Promise<Resolution> {
  const { theme, agent, signal } = inv
  const ask = env.getAsk()
  if (!ask) {
    env.rt.log.warn('选角：选择卡片不可用（没有 userQuestions 服务）')
    return { kind: 'reply', reply: failureReceipt('选择卡片不可用，请敲 `/aha 开场 名字`') }
  }
  const good = entries.filter((e): e is GoodEntry => e.ok)
  const batches = buildPickBatches(theme, sortCandidates(good, await lastTalkedDates(good)))
  for (const q of batches) {
    if (signal?.aborted) return { kind: 'reply', reply: pickCancelledReceipt() }
    let answer: unknown
    try {
      answer = await ask({ agent, ...(signal ? { signal } : {}), questions: [q.item] })
    } catch (e) {
      if (isAbort(e, signal)) return { kind: 'reply', reply: pickCancelledReceipt() }
      env.rt.log.warn(`选角卡片失败：${(e as Error).message}`)
      return { kind: 'reply', reply: failureReceipt(`选择卡片没弹出来（${(e as Error).message}）`) }
    }
    const r = interpretPick(answer, q)
    if (r.kind === 'more') continue
    if (r.kind === 'cancel') return { kind: 'reply', reply: pickCancelledReceipt() }
    if (r.kind === 'name') return resolveByName(theme, entries, r.text)
    const hit = good.find((e) => e.card.id === r.id)
    return hit ? { kind: 'entry', entry: hit } : { kind: 'reply', reply: pickCancelledReceipt() }
  }
  return { kind: 'reply', reply: pickCancelledReceipt() }
}

function requestOf(env: ChatEnv, tavern: TavernInfo, entry: CharacterEntry, sessionId: string, theme: Theme): InitRequest {
  const c = env.rt.config
  return {
    tavern, entry, sessionId, theme, houseRules: houseRulesText, now: env.now(),
    limits: { worldBudget: c.worldBudget, memoryMaxChars: c.memoryMaxChars, pastIndexMaxLines: c.pastIndexMaxLines },
  }
}

/** 把"换段"接到会话的段管理器；失败时让下一次 pre-step 重新规划，并把错误抛给 initialize 记为第 5 步失败。 */
function sectionSetter(env: ChatEnv, agent: HostAgent): InitSteps['setSection'] {
  return async (text) => {
    try {
      await env.sections.refresh(agent, async () => ({ kind: 'text', text, note: '五段' }))
    } catch (e) {
      env.sections.invalidate(agent.id)
      throw e
    }
  }
}

/** `开场` 命令。 */
export function startHandler(env: ChatEnv): CommandHandler {
  return async (inv) => {
    const tavern = inv.context.tavern
    const { theme, agent, rt } = inv
    if (!tavern) return failureReceipt(`这里还不是${theme.concept('tavern')}`)
    return env.gate.run(agent.id, async () => {
      // 排队期间状态可能变了（前一次已开聊）：在弹卡片之前按盘上重新读
      const fresh = await buildContext(agent, inv.services, rt.log)
      if (fresh.state === 'chatting') return dispatchReceipt(theme, 'new-session')
      if (isReadonly(fresh.tavern)) return readonlyReceipt(theme)
      const entries = await listCharacters(tavern.dir)
      const problem = checkRoster(entries)
      if (problem) return rosterReceipt(theme, problem)
      const res = inv.args.trim() !== ''
        ? resolveByName(theme, entries, inv.args)
        : await pickByCard(env, inv, entries)
      if (res.kind === 'reply') return res.reply
      const outcome = await initialize(
        requestOf(env, tavern, res.entry, agent.id, theme),
        realSteps({ setSection: sectionSetter(env, agent), steer: inv.steer }),
      )
      rt.log.info(`开场：${outcome.kind === 'started' ? `${outcome.name}（${outcome.chatId}）未完成=${outcome.failed.join(',') || '无'}` : `拒绝 ${outcome.why}`}`)
      return outcome.kind === 'started' ? startedReceipt(theme, outcome) : refusedReceipt(theme, outcome)
    })
  }
}

/** aha_start 工具的实现：返回给模型的文字。 */
export function startTool(env: ChatEnv): (agent: HostAgent | undefined, args: StartArgs) => Promise<string> {
  return async (agent, args) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    return env.gate.run(agent.id, async () => {
      const theme = await env.rt.theme()
      const cc = await buildContext(agent, services, env.rt.log)
      if (cc.mode !== 'chat') return 'error: not available in this mode'
      if (cc.state === 'chatting') return 'already chatting'
      if (!cc.tavern) return 'error: this workspace is not a tavern'
      const entries = await listCharacters(cc.tavern.dir)
      const problem = checkRoster(entries)
      if (problem) return problem.kind === 'no-characters' ? 'error: no characters in this tavern' : 'error: every card is unreadable'
      const names = entries.map(displayOf).join(', ')
      let entry: CharacterEntry | undefined
      if (args.id !== undefined) {
        entry = entries.find((e) => e.ok && e.card.id === args.id)
        if (!entry) return `error: no character with id ${args.id}; available: ${names}`
      } else {
        const m = matchCharacterName(entries, args.name!)
        if (m.kind === 'ambiguous') return `error: ambiguous name; candidates: ${m.candidates.map(displayOf).join(', ')}`
        if (m.kind === 'none') return `error: no character named ${args.name}; available: ${names}`
        entry = m.entry
      }
      const steer = (text: string, summary: string): void => {
        if (typeof agent.steer !== 'function') throw new Error('宿主 agent 没有 steer')
        agent.steer(makeNotice(text, summary))
      }
      const outcome = await initialize(
        requestOf(env, cc.tavern, entry, agent.id, theme),
        realSteps({ setSection: sectionSetter(env, agent), steer }),
      )
      env.rt.log.info(`aha_start：${outcome.kind === 'started' ? `${outcome.name}（${outcome.chatId}）未完成=${outcome.failed.join(',') || '无'}` : `拒绝 ${outcome.why}`}`)
      return startedToolText(outcome)
    })
  }
}

interface ChatHost {
  inject(keys: readonly string[], cb: (c: ChatInjected) => void): void
  on(event: string, listener: (...args: any[]) => unknown): unknown
}
interface ChatInjected extends HostServices, ChatHost {}

/** 只在单聊实例里装配：选角命令与工具，created / pre-step / disposed 监听。 */
export function installChat(ctx: Context, rt: Runtime): void {
  const sections = new SessionSections(rt.log, hostSectionRegister(SECTION_NAME, SECTION_ORDER), '单聊提示词段')
  let services: HostServices | undefined
  let ask: AskFn | undefined
  const env: ChatEnv = {
    rt, sections, gate: new SessionGate(), getAsk: () => ask, getServices: () => services, now: () => new Date(),
  }
  const host = ctx as unknown as ChatHost
  host.inject(['userQuestions'], (c) => {
    const uq = (c as unknown as { userQuestions: { ask: AskFn } }).userQuestions
    ask = (req) => uq.ask(req)
  })
  const memoryEnv = createMemoryEnv(rt, () => services)
  registerChatTools(ctx, { start: startTool(env), remember: rememberTool(memoryEnv), review: reviewTool(memoryEnv), recall: recallTool(memoryEnv) })
  rt.handlers.start = startHandler(env)
  rt.handlers.remember = rememberHandler(memoryEnv)
  host.inject(['agentPresets'], (c) => {
    services = c
    const ensure = async (agent: HostAgent, via: string): Promise<void> => {
      try {
        await sections.ensure(agent, chatPlan(env, agent, c, await rt.theme()))
      } catch (e) {
        rt.log.error(`注册单聊提示词段失败（${via}）：${(e as Error).stack ?? e}`)
      }
    }
    // 新建与恢复会话时就注册（恢复的聊天中会话在这里还原五段，规格 9.3）；pre-step 兜底，且必须 return next()
    c.on('agent/created', (payload: { agent: HostAgent }) => {
      void ensure(payload.agent, 'created')
    })
    const recorder = new TranscriptRecorder({ resolve: (agent) => resolveChatTarget(agent, c, rt.log), log: rt.log })
    c.on('agent/pre-step', async (payload: { agent: HostAgent; messages?: readonly unknown[]; turn?: unknown }, next: () => Promise<unknown>) => {
      await ensure(payload.agent, 'pre-step')
      const newUsers = recorder.onStep(payload.agent, (payload.messages ?? []) as never)
      await onChatStep(memoryEnv, payload.agent, payload.turn, newUsers)
      return next()
    })
    // 通知类事件，不带 next
    c.on('agent/assistant-stream', (payload: { agent: HostAgent; frame: unknown }) => {
      recorder.onFrame(payload.agent, payload.frame as never)
    })
    c.on('agent/disposed', (payload: { agent: { id: string } }) => {
      sections.forget(payload.agent.id)
      recorder.forget(payload.agent.id)
      memoryEnv.reminder.forget(payload.agent.id)
      memoryEnv.turns.forget(payload.agent.id)
      memoryEnv.recallTurns.forget(payload.agent.id)
    })
    rt.log.info('单聊外壳已装配（created / pre-step / disposed 监听）')
  })
}
