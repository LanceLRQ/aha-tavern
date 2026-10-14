// 群聊的记忆（二期规格 §11）：指明角色的随手记与回忆、整理（当前场景梗概 + 在场角色前几栏）、手动记住。
// 与单聊共用 core 的写入函数与轮次计数；不同的地方：每个动作都指明是哪个 character，
// 回忆一场群聊只返回该角色在场的那些场景。
import path from 'node:path'
import { listCharacters, MEMORY_FILE, readCharacter, type CharacterEntry } from '../core/card'
import { readChatMeta, readRecords, readShowSummary, recallChat, writeShowSummary } from '../core/chat'
import { appendFact, appendPinned, readMemory, replaceSections, type SectionPatch } from '../core/memory'
import { sceneLabel, upsertScene } from '../core/summary'
import { buildContext, type CommandHandler, type HostAgent, type HostServices } from './context'
import type { GoodEntry } from './chat'
import { matchGroupNames } from './group-common'
import type { GroupTranscriptRecorder } from './group-transcript'
import { RememberTurns, LIMITS } from './remember'
import { ReviewReminder } from '../core/reminder'
import type { Runtime } from './runtime'
import { injectNotice, escapeClosingTag } from './steer'
import { READONLY_TOOL_MESSAGE, isReadonly } from './writable'
import { failureReceipt, readonlyReceipt, type Reply } from './receipts'
import type { Theme } from '../core/theme'
import type { CommandContext } from './context'

export interface GroupMemoryEnv {
  rt: Runtime
  getServices(): HostServices | undefined
  /** 随手记的每轮一次 */
  turns: RememberTurns
  /** 回忆的每轮一次 */
  recallTurns: RememberTurns
  /** 关键的事的提醒（间隔与单聊相同） */
  reminder: ReviewReminder
  /** 整理时写当前场景的梗概 */
  recorder: GroupTranscriptRecorder
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const len = (s: string): number => [...s].length

// ---------- 场景中的工具 ----------

export interface GroupRememberArgs {
  /** 谁记住了：在场角色的名字，一个或多个 */
  who: string[]
  text: string
}

export function parseGroupRememberArgs(args: unknown): GroupRememberArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (text === '') return 'error: text is required'
  if (len(text) > LIMITS.fact) return `error: text is too long (over ${LIMITS.fact} chars)`
  if (!Array.isArray(args.who) || args.who.length === 0) return 'error: who is required (names of the characters who remember)'
  const who: string[] = []
  for (const n of args.who) {
    if (typeof n !== 'string') return 'error: who must be an array of strings'
    const t = n.trim()
    if (t !== '' && !who.includes(t)) who.push(t)
  }
  if (who.length === 0) return 'error: who is required (names of the characters who remember)'
  return { who, text }
}

/** 在场名单（meta.present，缺省为 participants）。 */
async function presentOf(tavernDir: string, chatId: string): Promise<string[]> {
  const meta = await readChatMeta(tavernDir, chatId)
  return meta.present ?? meta.participants
}

/** 按编号取在场角色的好卡条目。 */
async function presentEntries(tavernDir: string, present: readonly string[]): Promise<GoodEntry[]> {
  const out: GoodEntry[] = []
  for (const id of present) {
    const e = await readCharacter(tavernDir, id).catch(() => null)
    if (e && e.ok) out.push(e)
  }
  return out
}

/** 名单匹配到在场角色（只在在场名单里匹配）；对不上给带在场名单的说明。 */
function presentMatchProblem(present: GoodEntry[], names: readonly string[]): string | null {
  const m = matchGroupNames(present, names)
  const onStage = present.map((e) => e.card.name).join(', ')
  if (m.kind === 'none') return `error: no character named ${m.name} on stage; on stage: ${onStage}`
  if (m.kind === 'ambiguous') return `error: ambiguous name ${m.name} on stage; candidates: ${m.candidates.map((e) => (e.ok ? e.card.name : e.dirName)).join(', ')}`
  if (m.kind === 'bad-card') return `error: card of "${m.entry.dirName}" is unreadable (${m.entry.problem})`
  return null
}

/** aha_remember（群聊）：指明谁记住了，写进各自的 facts。 */
export function groupRememberTool(env: GroupMemoryEnv): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return async (agent, args) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    const parsed = parseGroupRememberArgs(args)
    if (typeof parsed === 'string') return parsed
    const cc = await buildContext(agent, services, env.rt.log)
    if (cc.mode !== 'group' || cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return 'error: not in a show'
    if (isReadonly(cc.tavern)) return READONLY_TOOL_MESSAGE
    const chatId = cc.record.chatId
    const present = await presentOf(cc.tavern.dir, chatId)
    const presentGood = await presentEntries(cc.tavern.dir, present)
    const problem = presentMatchProblem(presentGood, parsed.who)
    if (problem) return problem
    const hit = matchGroupNames(presentGood, parsed.who)
    if (hit.kind !== 'ok') return 'error: match failed'
    const targets = hit.entries
    const token = env.turns.claim(agent.id)
    if (token === null) return 'already remembered this turn'
    let okCount = 0
    let duplicate = false
    for (const e of targets) {
      try {
        const r = await appendFact(path.join(e.dir, MEMORY_FILE), parsed.text, {
          characterName: e.card.name, maxFacts: env.rt.config.keyFactsMax,
        })
        if (r.written) okCount++
        if (r.reason === 'duplicate') duplicate = true
      } catch (err) {
        env.rt.log.warn(`群聊随手记（${e.card.name}）写盘失败：${(err as Error).message}`)
      }
    }
    if (okCount === 0) {
      env.turns.release(agent.id, token)
      return duplicate ? 'skipped: already known' : 'error: could not write to any core_memory'
    }
    env.reminder.onWrite(agent.id)
    return `remembered for ${targets.filter(() => true).length > 0 ? targets.map((e) => e.card.name).join(', ') : ''}`
  }
}

// ---------- 回忆 ----------

export interface GroupRecallArgs {
  /** 谁在回忆：在场角色名 */
  who: string
  id: string
}

export function parseGroupRecallArgs(args: unknown): GroupRecallArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const who = typeof args.who === 'string' ? args.who.trim() : ''
  if (who === '') return 'error: who is required (name of the character who is recalling)'
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (id === '') return 'error: id is required (chat id from the index line)'
  return { who, id }
}

/** 各场景的在场名单：分界记录带新场景的名单；场景一（或没有分界）用开场名单。 */
export function castByScene(records: readonly { type: string; scene?: unknown; cast?: unknown }[], initial: readonly string[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const r of records) {
    if (r.type === 'scene' && typeof r.scene === 'number' && Array.isArray(r.cast) && r.cast.every((x) => typeof x === 'string')) {
      out.set(r.scene, r.cast as string[])
    }
  }
  if (!out.has(1) && initial.length > 0) out.set(1, [...initial])
  return out
}

/** 一段原文节选：某个场景的记录按说话人排开，截到上限。 */
function sceneExcerpt(records: readonly { type: string; speaker?: string; text: string; scene?: unknown }[], scene: number, names: ReadonlyMap<string, string>, limit: number): string {
  const lines = records
    .filter((r) => r.scene === scene && typeof r.text === 'string' && r.text.trim() !== '')
    .map((r) => {
      const body = r.text.replace(/\r\n?|\n/g, '\n  ')
      if (r.type === 'narrator') return `【旁白】${body}`
      const who = typeof r.speaker === 'string' && r.speaker !== '' ? `${names.get(r.speaker) ?? r.speaker}：` : ''
      return `${who}${body}`
    })
  let text = ''
  for (const line of lines) {
    if ([...text].length + [...line].length + 1 > limit && text !== '') return `${text}\n……`
    text = text === '' ? line : `${text}\n${line}`
  }
  return text
}

/** aha_recall（群聊）：谁在回忆、回忆哪一场；群聊只返回该角色在场的场景。 */
export function groupRecallTool(env: GroupMemoryEnv): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return async (agent, args) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    const parsed = parseGroupRecallArgs(args)
    if (typeof parsed === 'string') return parsed
    const cc = await buildContext(agent, services, env.rt.log)
    if (cc.mode !== 'group' || cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return 'error: not in a show'
    // 谁在回忆：只认在场角色
    const present = await presentOf(cc.tavern.dir, cc.record.chatId)
    const presentGood = await presentEntries(cc.tavern.dir, present)
    const problem = presentMatchProblem(presentGood, [parsed.who])
    if (problem) return problem
    const who = matchGroupNames(presentGood, [parsed.who])
    if (who.kind !== 'ok') return 'error: match failed'
    const self = who.entries[0]!
    // 只能回忆自己往事索引里的聊天
    const memFile = path.join(self.dir, MEMORY_FILE)
    let index: Awaited<ReturnType<typeof readMemory>>
    try {
      index = await readMemory(memFile)
    } catch (e) {
      return `error: cannot read core_memory (${(e as Error).message})`
    }
    const token = env.recallTurns.claim(agent.id)
    if (token === null) return 'already recalled this turn'
    if (!index.index.some((e) => e.id === parsed.id)) {
      env.recallTurns.release(agent.id, token)
      return `not remembered by ${self.card.name}`
    }
    const meta = await readChatMeta(cc.tavern.dir, parsed.id).catch(() => null)
    if (!meta) {
      env.recallTurns.release(agent.id, token)
      return 'empty: no records of that chat'
    }
    if (meta.kind === 'chat') {
      const r = await recallChat(cc.tavern.dir, parsed.id, { speakerNames: { [self.card.id]: self.card.name } })
      if (r.kind === 'recap' || r.kind === 'excerpt') return r.text
      return r.kind === 'empty' ? 'empty' : 'missing'
    }
    // 群聊：只返回该角色在场的场景；缺梗概的场景用原文节选补（规格 §9、§11.3）
    const { records } = await readRecords(cc.tavern.dir, parsed.id)
    const casts = castByScene(records, meta.initialPresent ?? meta.participants)
    const show = await readShowSummary(cc.tavern.dir, parsed.id)
    const names = new Map((await listCharacters(cc.tavern.dir)).filter((e) => e.ok).map((e) => [(e as GoodEntry).card.id, (e as GoodEntry).card.name]))
    const scenesKnown = new Set(show.scenes.map((s) => s.index))
    for (const scene of casts.keys()) {
      const cast = casts.get(scene)!
      if (!cast.includes(self.card.id)) continue
      if (!scenesKnown.has(scene)) scenesKnown.add(scene)
    }
    const parts: string[] = []
    for (const scene of [...scenesKnown].sort((a, b) => a - b)) {
      const cast = casts.get(scene)
      if (cast && !cast.includes(self.card.id)) continue
      const section = show.scenes.find((s) => s.index === scene)
      const head = `场景${sceneLabel(scene)}${section?.title ? `：${section.title}` : ''}`
      const body = section && section.text.trim() !== ''
        ? section.text.trim()
        : sceneExcerpt(records, scene, names, env.rt.config.recallExcerptMaxChars)
      parts.push(body === '' ? head : `${head}\n${body}`)
    }
    if (parts.length === 0) return `${self.card.name} was not on stage in that show`
    return parts.join('\n\n')
  }
}

// ---------- 整理 ----------

export interface GroupReviewMember {
  name: string
  address?: string
  impression?: string
  facts?: string[]
}

export interface GroupReviewArgs {
  /** 当前场景到目前为止的梗概（换场或收场时会覆盖） */
  sceneSummary: string
  members: GroupReviewMember[]
}

export function parseGroupReviewArgs(args: unknown): GroupReviewArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const sceneSummary = typeof args.scene_summary === 'string' ? args.scene_summary.trim() : ''
  if (sceneSummary === '') return 'error: scene_summary is required (what happened in the current scene so far)'
  if (len(sceneSummary) > LIMITS.summary) return `error: scene_summary is too long (over ${LIMITS.summary} chars)`
  if (!Array.isArray(args.members) || args.members.length === 0) return 'error: members is required (which present characters to update)'
  const members: GroupReviewMember[] = []
  for (const raw of args.members) {
    if (!isRecord(raw)) return 'error: members must be objects'
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (name === '') return 'error: each member needs a name'
    const m: GroupReviewMember = { name }
    if (typeof raw.address === 'string' && raw.address.trim() !== '') {
      if (len(raw.address) > LIMITS.block) return `error: address of ${name} is too long`
      m.address = raw.address.trim()
    }
    if (typeof raw.impression === 'string' && raw.impression.trim() !== '') {
      if (len(raw.impression) > LIMITS.block) return `error: impression of ${name} is too long`
      m.impression = raw.impression.trim()
    }
    if (Array.isArray(raw.facts)) {
      const facts: string[] = []
      for (const f of raw.facts) {
        if (typeof f !== 'string') return `error: facts of ${name} must be strings`
        const t = f.trim()
        if (t === '') return `error: facts of ${name} must not be empty`
        if (len(t) > LIMITS.fact) return `error: a fact of ${name} is too long`
        facts.push(t)
      }
      m.facts = facts
    }
    members.push(m)
  }
  return { sceneSummary, members }
}

/** aha_review（群聊）：当前场景梗概 + 在场角色主线记忆的前几栏。 */
export function groupReviewTool(env: GroupMemoryEnv): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return async (agent, args) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    const parsed = parseGroupReviewArgs(args)
    if (typeof parsed === 'string') return parsed
    const cc = await buildContext(agent, services, env.rt.log)
    if (cc.mode !== 'group' || cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return 'error: not in a show'
    if (isReadonly(cc.tavern)) return READONLY_TOOL_MESSAGE
    const chatId = cc.record.chatId
    const present = await presentOf(cc.tavern.dir, chatId)
    const presentGood = await presentEntries(cc.tavern.dir, present)
    const problem = presentMatchProblem(presentGood, parsed.members.map((m) => m.name))
    if (problem) return problem
    const hit = matchGroupNames(presentGood, parsed.members.map((m) => m.name))
    if (hit.kind !== 'ok') return 'error: match failed'
    const byName = new Map(parsed.members.map((m) => [m.name, m]))
    // 1 当前场景的梗概：保留已有的小节标题（换场或收场时会覆盖这段）
    const scene = (await env.recorder.currentScene(agent)) ?? 1
    const show = await readShowSummary(cc.tavern.dir, chatId)
    const existing = show.scenes.find((s) => s.index === scene)
    const names = new Map((await listCharacters(cc.tavern.dir)).filter((e) => e.ok).map((e) => [(e as GoodEntry).card.id, (e as GoodEntry).card.name]))
    await writeShowSummary(cc.tavern.dir, chatId, upsertScene(show, {
      index: scene,
      title: existing?.title ?? null,
      cast: present.map((id) => names.get(id) ?? id),
      text: parsed.sceneSummary,
    }))
    // 2 各个在场角色的前几栏
    const updated: string[] = []
    for (const e of hit.entries) {
      const m = byName.get(e.card.name)
      if (!m) continue
      const patch: SectionPatch = {}
      if (m.address !== undefined) patch.address = m.address
      if (m.impression !== undefined) patch.impression = m.impression
      if (m.facts !== undefined) patch.facts = m.facts
      if (Object.keys(patch).length === 0) continue
      try {
        await replaceSections(path.join(e.dir, MEMORY_FILE), patch, { characterName: e.card.name })
        updated.push(e.card.name)
      } catch (err) {
        env.rt.log.warn(`群聊整理（${e.card.name}）写盘失败：${(err as Error).message}`)
      }
    }
    env.reminder.onWrite(agent.id)
    return `reviewed: scene summary saved (scene ${scene}); core_memory updated for ${updated.length > 0 ? updated.join(', ') : 'nobody'}`
  }
}

// ---------- 记忆 命令（手动） ----------

export const GROUP_REVIEW_REQUEST_TEXT = '（通知）user 想让你现在整理一下。请调用 aha_review 一次：'
  + 'scene_summary 写当前 scene 到目前为止的梗概；members 里给每个有值得整理的在场 character 更新 core_memory 的 '
  + 'address、impression、facts（只写结论；没有要改的就不放进 members）。然后以在场角色的身份用一句话自然地回应 user。不要提这条通知，也不要提工具。'

/** `/aha 记住 [@谁] [内容]`（群聊，规格 §11.5）。 */
export function groupRememberHandler(env: GroupMemoryEnv): CommandHandler {
  return async (inv) => {
    const { theme, agent } = inv as { theme: Theme; agent: HostAgent }
    const args = inv.args.trim()
    const m = /^@(\S+)\s*([\s\S]*)$/.exec(args)
    const whoName = m ? (m[1] ?? '') : ''
    const text = (m ? (m[2] ?? '') : args).trim()
    const cc = inv.context
    if (cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) {
      return failureReceipt('要在开场之后才能记事。')
    }
    if (isReadonly(cc.tavern)) return readonlyReceipt(theme)
    if (text === '') {
      inv.steer(GROUP_REVIEW_REQUEST_TEXT, '整理记忆')
      return { kind: 'success' }
    }
    if (len(text) > LIMITS.pinned) return failureReceipt(`内容太长了（超过 ${LIMITS.pinned} 字），请精简后再记`)
    const chatId = cc.record.chatId
    const present = await presentOf(cc.tavern.dir, chatId)
    const entries = await listCharacters(cc.tavern.dir)
    let targets: GoodEntry[]
    if (whoName !== '') {
      const hit = matchGroupNames(entries, [whoName])
      if (hit.kind === 'none') {
        return { kind: 'success' as const, text: `没有叫「${whoName}」的${theme.concept('character')}。现有的有：${entries.map((e) => (e.ok ? e.card.name : e.dirName)).join('、')}。` }
      }
      if (hit.kind === 'ambiguous') {
        return { kind: 'success' as const, text: `「${whoName}」对得上好几个：${hit.candidates.map((e) => (e.ok ? e.card.name : e.dirName)).join('、')}。请把名字写全再试。` }
      }
      if (hit.kind === 'bad-card') return failureReceipt(`「${hit.entry.dirName}」的卡读不出来（${hit.entry.problem}）。`)
      targets = hit.entries
    } else {
      targets = await presentEntries(cc.tavern.dir, present)
      if (targets.length === 0) return failureReceipt('在场没有能记事的' + theme.concept('character'))
    }
    let ok = 0
    for (const e of targets) {
      try {
        if ((await appendPinned(path.join(e.dir, MEMORY_FILE), text, { characterName: e.card.name })).written) ok++
      } catch (err) {
        env.rt.log.warn(`记住（${e.card.name}）写盘失败：${(err as Error).message}`)
      }
    }
    if (ok === 0) return failureReceipt(`没能写进${theme.concept('core_memory')}`)
    env.reminder.onWrite(agent.id)
    const note = `（通知）user 让你记住下面这件事，已记进 core_memory 的 pinned 栏。从现在起把它当作已知，不用回应这条通知。\n<pinned_note>\n${escapeClosingTag(text, 'pinned_note')}\n</pinned_note>`
    const told = injectNotice(agent, note, '手动记住')
    const list = targets.map((e) => `「${e.card.name}」`).join('、')
    return {
      kind: 'success',
      text: `已记入${list}的${theme.concept('core_memory')}：${text}${told ? '' : `（这场${theme.concept('show')}里${theme.concept('character')}暂时还不知道，下次开聊才会读到）`}`,
    }
  }
}

// ---------- pre-step：轮次与关键的事的提醒 ----------

export const GROUP_FACT_REMINDER_TEXT = '（通知）已经聊了一阵。有恒久的、值得记进 core_memory 的关键的事吗？'
  + '有就调用 aha_remember（who 填记住这件事的在场 character，text 只写结论）；没有就不用调用。不要向 user 提起这条通知。'

/** pre-step 里调用：登记轮次；到阈值用不唤醒的 inject 提醒一次关键的事（规格 §11.4）。 */
export async function onGroupMemoryStep(env: GroupMemoryEnv, agent: HostAgent, turn: unknown, newUserMessages: number): Promise<boolean> {
  env.turns.onStep(agent.id, turn, newUserMessages)
  env.recallTurns.onStep(agent.id, turn, newUserMessages)
  if (newUserMessages <= 0) return false
  const services = env.getServices()
  if (!services) return false
  let due = false
  try {
    const cc: CommandContext = await buildContext(agent, services, env.rt.log)
    if (cc.mode !== 'group' || cc.state !== 'performing') return false
    for (let i = 0; i < newUserMessages; i++) if (env.reminder.onUserMessage(agent.id)) due = true
    if (due && !injectNotice(agent, GROUP_FACT_REMINDER_TEXT, '关键的事提醒')) {
      env.rt.log.warn('关键的事提醒没能送出，下一条消息再补')
      env.reminder.retry(agent.id)
      return false
    }
  } catch (e) {
    env.rt.log.warn(`关键的事提醒出错：${(e as Error).message}`)
  }
  return due
}
