// 换场与收场（二期规格 §8、§9）：aha_scene / aha_wrap 工具与 /aha 换场 / /aha 收场 命令。
// 换场在同一轮里完成：梗概入档（上一场景）、场景分界落盘（新场景）、人员进出（索引行、在场名单、重装提示词第 5 段），
// 然后由模型照工具返回的指示写新场景的开场（G3：做不成一轮拆两步也可，指示同样适用）。
import path from 'node:path'
import { listCharacters, MEMORY_FILE, readCharacter } from '../core/card'
import { patchChatMeta, readChatMeta, readShowSummary, setChatTitle, writeShowSummary } from '../core/chat'
import { appendIndexLine, setIndexTitle } from '../core/memory'
import { upsertScene } from '../core/summary'
import type { Theme } from '../core/theme'
import { answerItem, CARD_OPEN_MESSAGE, isAbort, type AskItem } from './confirm'
import { buildContext, localDate, type CommandHandler, type HostAgent } from './context'
import type { GoodEntry } from './chat'
import { matchGroupNames } from './group-common'
import type { GroupEnv } from './group'
import { flatText } from './steer'
import { isReadonly } from './writable'

export const OPT_CHANGE = '换场'
export const OPT_STAY = '不换场'
const SCENE_QUESTION_ID = 'group-scene'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface SceneArgs {
  /** 刚结束的场景的梗概 */
  summary: string
  /** 新场景的标题（写进场景分界） */
  title: string
  /** 刚结束场景的标题；场景一是开场没有标题，换它的时候由模型顺带起名 */
  endingTitle?: string
  /** 新场景的情景说法（给模型写开场用，不改这一场的情景段） */
  scenario?: string
  join?: string[]
  leave?: string[]
}

function nameList(v: unknown, key: string): string[] | string {
  if (!Array.isArray(v)) return `error: ${key} must be an array of strings`
  const out: string[] = []
  for (const n of v) {
    if (typeof n !== 'string') return `error: ${key} must be an array of strings`
    const t = n.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

export function parseSceneArgs(args: unknown): SceneArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (summary === '') return 'error: summary is required (what happened in the scene being closed)'
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title === '') return 'error: title is required (title of the new scene)'
  const out: SceneArgs = { summary, title }
  if (typeof args.endingTitle === 'string' && args.endingTitle.trim() !== '') out.endingTitle = args.endingTitle.trim()
  if (typeof args.scenario === 'string' && args.scenario.trim() !== '') out.scenario = args.scenario.trim()
  for (const key of ['join', 'leave'] as const) {
    const v = args[key]
    if (v === undefined || v === null) continue
    const list = nameList(v, key)
    if (typeof list === 'string') return list
    if (list.length > 0) out[key] = list
  }
  return out
}

export interface WrapArgs {
  /** 最后一个场景的梗概 */
  summary: string
  /** 这一场的标题 */
  title: string
  endingTitle?: string
}

export function parseWrapArgs(args: unknown): WrapArgs | string {
  if (!isRecord(args)) return 'error: arguments must be an object'
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (summary === '') return 'error: summary is required (what happened in the final scene)'
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title === '') return 'error: title is required (title of the whole show)'
  const out: WrapArgs = { summary, title }
  if (typeof args.endingTitle === 'string' && args.endingTitle.trim() !== '') out.endingTitle = args.endingTitle.trim()
  return out
}

/** 换场确认卡片：复述新场景与人员变化，用户决定切不切（规格 §8.1）。 */
export function buildSceneQuestion(theme: Theme, a: {
  title: string; scenario?: string; joinNames?: readonly string[]; leaveNames?: readonly string[]
}): AskItem {
  const changes: string[] = []
  if (a.joinNames?.length) changes.push(`${a.joinNames.join('、')}加入`)
  if (a.leaveNames?.length) changes.push(`${a.leaveNames.join('、')}离开`)
  return {
    id: SCENE_QUESTION_ID,
    header: theme.concept('show'),
    question: `换到新的${theme.concept('scene')}「${a.title}」？${changes.length ? `（${changes.join('，')}）` : ''}`,
    ...(a.scenario ? { detail: a.scenario } : {}),
    options: [
      { label: OPT_CHANGE, description: a.scenario ?? '换到新的场景' },
      { label: OPT_STAY, description: '不换，留在当前场景' },
    ],
  }
}

export type SceneAnswer = { kind: 'change' } | { kind: 'stay' }

export function interpretSceneAnswer(answer: unknown): SceneAnswer {
  const item = answerItem(answer, SCENE_QUESTION_ID)
  if (!item) return { kind: 'stay' }
  const selected = Array.isArray(item.selected) ? item.selected : []
  return selected.includes(OPT_CHANGE) ? { kind: 'change' } : { kind: 'stay' }
}

/** 交给换场与收场工具的依赖：重装提示词第 5 段的回调（installGroup 里接上 groupPlan）。 */
export interface SceneDeps {
  rebuild(agent: HostAgent): Promise<void>
}

const namesOf = (byId: ReadonlyMap<string, string>, ids: readonly string[]): string[] =>
  ids.map((id) => byId.get(id) ?? id)

async function nameIndex(tavernDir: string): Promise<{ entries: Awaited<ReturnType<typeof listCharacters>>; byId: ReadonlyMap<string, string> }> {
  const entries = await listCharacters(tavernDir)
  const byId = new Map<string, string>()
  for (const e of entries) byId.set(e.ok ? e.card.id : e.dirName, e.ok ? e.card.name : e.dirName)
  return { entries, byId }
}

/** aha_scene 工具的实现：返回给模型的文字。 */
export function sceneTool(env: GroupEnv, deps: SceneDeps): (agent: HostAgent | undefined, args: unknown, signal?: AbortSignal) => Promise<string> {
  return async (agent, args, signal) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    if (env.gate.commandHolds(agent.id)) return CARD_OPEN_MESSAGE
    return env.gate.run(agent.id, async () => {
      const theme = await env.rt.theme()
      const cc = await buildContext(agent, services, env.rt.log)
      if (cc.mode !== 'group') return 'error: not available in this mode'
      if (cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return 'error: not in a show'
      const tavernDir = cc.tavern.dir
      const chatId = cc.record.chatId
      if (isReadonly(cc.tavern)) return 'error: tavern is read-only, cannot change scene'
      const parsed = parseSceneArgs(args)
      if (typeof parsed === 'string') return parsed
      const scene = (await env.recorder.currentScene(agent)) ?? 1
      if (env.declinedScenes.get(agent.id)?.has(scene)) {
        return 'error: the user already declined a scene change in this scene; do not propose again; keep playing the current scene'
      }

      // 名单：join / leave 都按名字匹配
      const { entries, byId } = await nameIndex(tavernDir)
      let join: GoodEntry[] = []
      if (parsed.join?.length) {
        const m = matchGroupNames(entries, parsed.join)
        if (m.kind === 'none') return `error: no character named ${flatText(m.name, 'available')}`
        if (m.kind === 'ambiguous') return `error: ambiguous name ${flatText(m.name, 'available')}; candidates: ${m.candidates.map((e) => flatText(e.ok ? e.card.name : e.dirName, 'available')).join(', ')}`
        if (m.kind === 'bad-card') return `error: card of "${flatText(m.entry.dirName, 'available')}" is unreadable (${m.entry.problem})`
        join = m.entries
      }
      let leaveIds: string[] = []
      if (parsed.leave?.length) {
        const m = matchGroupNames(entries, parsed.leave)
        if (m.kind === 'none') return `error: no character named ${flatText(m.name, 'available')}`
        if (m.kind === 'ambiguous') return `error: ambiguous name ${flatText(m.name, 'available')}; candidates: ${m.candidates.map((e) => flatText(e.ok ? e.card.name : e.dirName, 'available')).join(', ')}`
        if (m.kind === 'bad-card') return `error: card of "${flatText(m.entry.dirName, 'available')}" is unreadable (${m.entry.problem})`
        leaveIds = m.entries.map((e) => e.card.id)
      }
      const meta = await readChatMeta(tavernDir, chatId)
      const present = meta.present ?? meta.participants
      const offStage = leaveIds.filter((id) => !present.includes(id))
      if (offStage.length > 0) {
        return `error: not on stage: ${namesOf(byId, offStage).join(', ')}; on stage: ${namesOf(byId, present).join(', ')}`
      }
      const joinIds = join.map((e) => e.card.id).filter((id) => !present.includes(id))
      const nextPresent = [...present.filter((id) => !leaveIds.includes(id)), ...joinIds]
      if (nextPresent.length === 0) return 'error: at least one character must stay on stage'
      const castMax = env.rt.config.groupCastMax
      if (nextPresent.length > castMax) return `error: too many on stage (${nextPresent.length} > ${castMax}); ask the user to reduce the cast`

      // 确认卡片：切不切由用户决定（规格 §8.1）
      const ask = env.getAsk()
      if (!ask) {
        env.rt.log.warn('换场：确认卡片不可用（没有 userQuestions 服务）')
        return 'error: selection card unavailable; the user cannot confirm the scene change here'
      }
      let answer: unknown
      try {
        answer = await ask({
          agent, ...(signal ? { signal } : {}),
          questions: [buildSceneQuestion(theme, {
            title: parsed.title,
            ...(parsed.scenario ? { scenario: parsed.scenario } : {}),
            ...(joinIds.length ? { joinNames: namesOf(byId, joinIds) } : {}),
            ...(leaveIds.length ? { leaveNames: namesOf(byId, leaveIds) } : {}),
          })],
        })
      } catch (e) {
        if (isAbort(e, signal)) return 'cancelled by user'
        env.rt.log.warn(`换场确认卡片失败：${(e as Error).message}`)
        return `error: selection card failed (${(e as Error).message})`
      }
      if (interpretSceneAnswer(answer).kind !== 'change') {
        const set = env.declinedScenes.get(agent.id) ?? new Set<number>()
        set.add(scene)
        env.declinedScenes.set(agent.id, set)
        return 'scene change declined by user; do not propose again in this scene; keep playing the current scene'
      }

      // 1 刚结束场景的梗概入档
      const show = await readShowSummary(tavernDir, chatId)
      await writeShowSummary(tavernDir, chatId, upsertScene(show, {
        index: scene,
        title: parsed.endingTitle ?? null,
        cast: namesOf(byId, present),
        text: parsed.summary,
      }))
      // 2 场景分界（含新在场名单），之后的记录归新场景
      await env.recorder.writeSceneBoundary(agent, { title: parsed.title, cast: nextPresent })
      // 3 人员进出：新来的写往事索引、更新在场名单与参与者，重装提示词第 5 段
      if (joinIds.length > 0 || leaveIds.length > 0) {
        for (const e of join.filter((x) => joinIds.includes(x.card.id))) {
          try {
            await appendIndexLine(
              path.join(e.dir, MEMORY_FILE),
              { date: localDate(env.now()), kind: 'group', id: chatId, title: null },
              { characterName: e.card.name, maxIndexLines: env.rt.config.pastIndexMaxLines },
            )
          } catch (err) {
            env.rt.log.warn(`换场：${e.card.name} 的往事索引没写上：${(err as Error).message}`)
          }
        }
        await patchChatMeta(tavernDir, chatId, {
          present: nextPresent,
          participants: [...new Set([...meta.participants, ...joinIds])],
        })
        try {
          await deps.rebuild(agent)
        } catch (e) {
          env.rt.log.warn(`换场：重装提示词第 5 段失败：${(e as Error).message}`)
        }
      }
      env.rt.log.info(`换场：场景 ${scene} -> ${scene + 1}「${parsed.title}」在场 ${nextPresent.length} 人（chatId=${chatId}）`)
      const notes = [`scene changed to "${flatText(parsed.title, 'available')}" (scene ${scene + 1}); now write the opening of the new scene in this same reply: one narrator paragraph starting with 【${theme.concept('narrator')}】 that sets the place and time`]
      if (joinIds.length > 0) notes.push(`just joined: ${namesOf(byId, joinIds).join(', ')}`)
      if (leaveIds.length > 0) notes.push(`left: ${namesOf(byId, leaveIds).join(', ')}`)
      notes.push('do not speak for user; do not mention this tool')
      return notes.join('; ')
    })
  }
}

/** aha_wrap 工具的实现：收场（写最后一段梗概与标题、更新往事索引行），收场后仍可继续（规格 §9）。 */
export function wrapTool(env: GroupEnv): (agent: HostAgent | undefined, args: unknown) => Promise<string> {
  return async (agent, args) => {
    const services = env.getServices()
    if (!agent || !services) return 'error: session not ready'
    return env.gate.run(agent.id, async () => {
      const cc = await buildContext(agent, services, env.rt.log)
      if (cc.mode !== 'group') return 'error: not available in this mode'
      if (cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return 'error: not in a show'
      const tavernDir = cc.tavern.dir
      const chatId = cc.record.chatId
      if (isReadonly(cc.tavern)) return 'error: tavern is read-only, cannot wrap'
      const parsed = parseWrapArgs(args)
      if (typeof parsed === 'string') return parsed
      const scene = (await env.recorder.currentScene(agent)) ?? 1
      const meta = await readChatMeta(tavernDir, chatId)
      const present = meta.present ?? meta.participants
      const { byId } = await nameIndex(tavernDir)
      // 最后一个场景的梗概；再次收场覆盖同一段（规格 §9）。收场后文件带头：标题与时间参与行。
      const show = await readShowSummary(tavernDir, chatId)
      await writeShowSummary(tavernDir, chatId, {
        ...upsertScene(show, {
          index: scene,
          title: parsed.endingTitle ?? null,
          cast: namesOf(byId, present),
          text: parsed.summary,
        }),
        title: parsed.title,
        started: meta.started.slice(0, 10),
        participants: namesOf(byId, meta.participants),
      })
      await setChatTitle(tavernDir, chatId, parsed.title)
      // 每个参与过的角色的往事索引行换成这一场的标题；写不上的记日志继续
      for (const id of meta.participants) {
        let entry: Awaited<ReturnType<typeof readCharacter>>
        try {
          entry = await readCharacter(tavernDir, id)
        } catch {
          entry = null
        }
        if (!entry || !entry.ok) {
          env.rt.log.warn(`收场：角色 ${id} 的卡读不出来，往事索引起不了标题`)
          continue
        }
        try {
          await setIndexTitle(path.join(entry.dir, MEMORY_FILE), chatId, parsed.title)
        } catch (e) {
          env.rt.log.warn(`收场：${entry.card.name} 的往事索引起标题失败：${(e as Error).message}`)
        }
      }
      env.rt.log.info(`收场：标题「${parsed.title}」（chatId=${chatId}）`)
      return `wrapped with title "${flatText(parsed.title, 'available')}"; the show can go on if user keeps talking; do not mention this tool`
    })
  }
}

// ---------- 命令 ----------

const guide = (text: string): { kind: 'success'; text: string } => ({ kind: 'success', text })

/** `/aha 换场 [新情景] [谁来谁走]`：转告旁白调用 aha_scene。 */
export function sceneHandler(): CommandHandler {
  return async (inv) => {
    const extra = inv.args.trim()
    inv.steer(buildSceneNotice(extra), '换场')
    return guide('已请旁白张罗换场，会先给你一张确认卡片。')
  }
}

export function buildSceneNotice(extra: string): string {
  return '（通知）user 要换场。请调用 aha_scene：summary 写刚结束场景的梗概，title 给新场景起个标题，'
    + '场景一还没有标题的话顺手在 ending_title 里给它起一个；user 说了新情景或谁来谁走，照着填 scenario / join / leave'
    + `${extra ? `（user 原话：${flatText(extra, 'notice')}）` : ''}。`
    + '调用后按返回的指示写新场景的开场。不要提这条通知。'
}

/** `/aha 收场`：转告旁白调用 aha_wrap。 */
export function wrapHandler(): CommandHandler {
  return async (inv) => {
    inv.steer(buildWrapNotice(), '收场')
    return guide('已请旁白收场。')
  }
}

export function buildWrapNotice(): string {
  return '（通知）user 要收场。请调用 aha_wrap：summary 写最后一个场景的梗概，title 给这一场起个标题。'
    + '收场后 user 仍可以继续聊。不要提这条通知。'
}
