// 群聊的生图（二期规格 §13.2）：场景图与单人特写两种形态，出图管线、记录与图片行协议都复用单聊的。
// 与单聊不同的三点：aha_draw 多一个 who 参数（单人特写画哪个在场角色，只认当前在场名单）；
// 不给 who 画场景图（不带外貌文字、不带定妆参考图，画面里的人物长相不保证）；
// redo 不带新 scene 时沿用上一张的形态（记录里的 who：单人特写照旧特写，场景图照旧场景）。
import { DEFAULT_LOOK, readCharacter } from '../core/card'
import { ComfyError, createComfyClient } from '../core/comfy'
import { readChatMeta } from '../core/chat'
import { lastImage, saveImage, type ImageRecord } from '../core/images'
import type { ImageServiceSettings } from '../core/services'
import { loadWorkflow, fillWorkflow } from '../core/workflow'
import groupDrawPrompts from '../prompts/draw-group.md'
import { buildContext, type HostAgent, type HostServices } from './context'
import type { GoodEntry } from './chat'
import {
  composePrompt, drawPromptSync, DrawAvailability, drawnText, DrawEcho, failKindOf, failText,
  hostOf, imagePathText, ORIENTATIONS, parseDrawArgs, POLL_MS, sizeFor, UNAVAILABLE, type DrawArgs,
} from './draw'
import { chooseRef, extraLooksOf, generateWithRef, REF_PREAMBLE } from './draw-ref'
import { matchGroupNames } from './group-common'
import { RefUploader } from './ref-upload'
import type { RememberTurns } from './remember'
import type { Log, Runtime } from './runtime'
import type { SessionSections } from './sections'
import { flatText } from './steer'
import { isReadonly } from './writable'

/** who 参数的长度上限（字符），与单聊 look 参数一致。 */
export const WHO_MAX = 40

// ---------- 参数 ----------

export interface GroupDrawArgs extends DrawArgs {
  /** 单人特写画哪个在场角色（名字）；缺省画场景图 */
  who?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 校验 aha_draw（群聊）的参数：先按单聊的规则校验，再校验多出来的 who。出错返回 error: 开头的文字。 */
export function parseGroupDrawArgs(args: unknown): GroupDrawArgs | string {
  const base = parseDrawArgs(args)
  if (typeof base === 'string') return base
  if (!isRecord(args)) return 'error: arguments must be an object'
  const raw = args.who
  if (raw === undefined || raw === null) return base
  if (typeof raw !== 'string') return 'error: who must be a string'
  const t = raw.trim()
  if (t === '') return base
  if ([...t].length > WHO_MAX) return `error: who must be at most ${WHO_MAX} characters`
  return { ...base, who: t }
}

// ---------- 目标与在场 ----------

/** 群聊生图的目标：落盘位置加在场名单（单人特写只认名单里的人）。 */
export interface GroupDrawTarget {
  tavernDir: string
  chatId: string
  /** 在场角色的好卡，按 meta.present 的顺序；读不出的卡不列入 */
  present: GoodEntry[]
  /** 酒馆数据比插件新：只读，不出图 */
  readonly?: boolean
}

/** 会话在场景中才给出目标；在场名单取 meta.present（缺省为 participants）。 */
export async function resolveGroupDrawTarget(
  agent: HostAgent, services: HostServices, log: Pick<Log, 'warn'>,
): Promise<GroupDrawTarget | null> {
  const cc = await buildContext(agent, services, log)
  if (cc.state !== 'performing' || !cc.tavern || !cc.record?.chatId) return null
  const meta = await readChatMeta(cc.tavern.dir, cc.record.chatId).catch(() => null)
  if (!meta) return null
  const present: GoodEntry[] = []
  for (const id of meta.present ?? meta.participants) {
    const e = await readCharacter(cc.tavern.dir, id).catch(() => null)
    if (e && e.ok) present.push(e)
  }
  return {
    tavernDir: cc.tavern.dir, chatId: cc.record.chatId, present,
    ...(isReadonly(cc.tavern) ? { readonly: true } : {}),
  }
}

/** who 匹配在场角色（只在在场名单里匹配，规则与随手记一致）；对不上返回带在场名单的错误文字。 */
export function matchPresentWho(present: readonly GoodEntry[], who: string): { entry: GoodEntry } | string {
  const onStage = present.map((e) => flatText(e.card.name, 'available')).join(', ')
  const m = matchGroupNames(present, [who])
  switch (m.kind) {
    case 'ok':
      return { entry: m.entries[0]! }
    case 'none':
      return `error: no character named ${flatText(who, 'available')} on stage; on stage: ${onStage}`
    case 'ambiguous':
      return `error: ambiguous name ${flatText(who, 'available')}; candidates: ${m.candidates.map((e) => flatText(e.ok ? e.card.name : e.dirName, 'available')).join(', ')}`
    case 'bad-card':
      return `error: card of "${flatText(m.entry.dirName, 'available')}" is unreadable (${m.entry.problem})`
  }
}

/** 这一张画谁：给了 who 按名字在场匹配；redo 且没给新 scene 时沿用上一张记录里的角色（按编号直认）。
 *  返回 null 表示画场景图；string 是给模型的错误文字。nameOf 把角色编号换成名字（读不出为 null），只用于错误说明。 */
export async function subjectOf(
  parsed: GroupDrawArgs, previous: ImageRecord | null,
  present: readonly GoodEntry[], nameOf: (id: string) => Promise<string | null>,
): Promise<GoodEntry | null | string> {
  if (parsed.who !== undefined) {
    const m = matchPresentWho(present, parsed.who)
    return typeof m === 'string' ? m : m.entry
  }
  if (parsed.redo && parsed.scene === undefined && previous && typeof previous.who === 'string' && previous.who !== '') {
    const hit = present.find((e) => e.card.id === previous.who)
    if (hit) return hit
    const onStage = present.map((e) => flatText(e.card.name, 'available')).join(', ')
    const label = flatText((await nameOf(previous.who)) ?? previous.who, 'available')
    return `error: no character named ${label} on stage; on stage: ${onStage}`
  }
  return null
}

// ---------- 工具 ----------

export interface GroupDrawEnv {
  rt: Pick<Runtime, 'log' | 'builtinWorkflowDir'>
  getServices(): HostServices | undefined
  drawing: DrawAvailability
  /** 画图自己的每轮名额 */
  turns: RememberTurns
  echo: DrawEcho
  fetch?: typeof fetch
  /** 0 到 1 之间的随机数 */
  random?: () => number
  now?: () => number
  /** 会话在场景中给出目标，否则 null；缺省按宿主服务现算。 */
  resolveTarget?: (agent: HostAgent) => Promise<GroupDrawTarget | null>
  /** 参考图上传的记账；缺省工具自己建一个（装配处应传进程共用的一个）。 */
  refUploader?: RefUploader
}

/** aha_draw（群聊）的实现：返回给模型的文字。形态与单聊一致（drawn / failed / unavailable 等短语）。 */
export function groupDrawTool(env: GroupDrawEnv): (agent: HostAgent | undefined, args: unknown, signal?: AbortSignal) => Promise<string> {
  const log = env.rt.log
  const now = env.now ?? Date.now
  const random = env.random ?? Math.random
  const resolveTarget = env.resolveTarget ?? (async (agent) => {
    const services = env.getServices()
    return services ? resolveGroupDrawTarget(agent, services, env.rt.log) : null
  })
  const refUploader = env.refUploader ?? new RefUploader()

  return async (agent, args, signal) => {
    if (!agent) return 'error: session not ready'
    const session = agent.id
    try {
      const av = await env.drawing.ensure(agent)
      const settings = av.settings
      if (!av.available || !settings) return UNAVAILABLE
      const parsed = parseGroupDrawArgs(args)
      if (typeof parsed === 'string') return parsed
      const target = await resolveTarget(agent)
      if (!target || target.readonly) return UNAVAILABLE

      let previous: ImageRecord | null = null
      if (parsed.redo) {
        previous = await lastImage(target.tavernDir, target.chatId)
        if (!previous || typeof previous.scene !== 'string' || previous.scene.trim() === '') return 'nothing to redo'
      }
      if (/[\r\n]/.test(target.tavernDir) || /[\r\n]/.test(target.chatId)) {
        log.warn(`会话 ${session}：聊天目录的路径含换行符，不出图`)
        return failText('other')
      }
      const token = env.turns.claim(session)
      if (token === null) return 'already drew this turn'

      // 占了名额之后的任何异常路径都要释放，只有成功才保留
      let drew = false
      const started = now()
      let summary = ''
      let note = ''
      try {
        // redo：给了 scene 就用新的（按修改要求改写的完整描述），否则沿用上一张；方向同理
        const inherited = previous && ORIENTATIONS.includes(previous.orientation) ? previous.orientation : 'portrait'
        const orientation = parsed.orientation ?? (previous ? inherited : 'portrait')
        const scene = parsed.scene ?? previous!.scene
        const { width, height } = sizeFor(orientation, settings.width, settings.height)
        const seed = Math.floor(random() * 2 ** 32)
        // 单人特写：who 只认在场角色；场景图不带外貌与定妆参考图（画面里的人物长相不保证）
        const nameOf = async (id: string): Promise<string | null> => {
          try {
            const e = await readCharacter(target.tavernDir, id)
            return e && e.ok ? e.card.name : null
          } catch {
            return null
          }
        }
        const subjectR = await subjectOf(parsed, previous, target.present, nameOf)
        if (typeof subjectR === 'string') return subjectR
        const subject = subjectR
        summary = `${width}x${height} steps=${settings.steps} redo=${parsed.redo}${subject ? ` who=${subject.card.id}` : ''}`
        const appearance = subject ? (subject.card.appearance ?? '') : ''
        const charDir = subject ? subject.dir : null
        const wf = await loadWorkflow(settings.workflow, env.rt.builtinWorkflowDir)
        // 形象沿用只发生在"重画同一个角色的特写"上；换了角色或场景图都用各自默认
        const inheritedLook = previous && subject && previous.who === subject.card.id ? previous.look : null
        const choice = await chooseRef({
          charDir, enabled: settings.reference, wf,
          ...(subject && parsed.look !== undefined ? { requested: parsed.look } : {}),
          ...(inheritedLook !== null ? { inherited: inheritedLook } : {}),
          debug: (m) => log.debug(`会话 ${session}：${m}`),
        })
        note = choice.note
        const client = createComfyClient({ endpoint: settings.endpoint, fetch: env.fetch ?? globalThis.fetch })
        const result = await generateWithRef({
          ref: choice.ref, endpoint: settings.endpoint, uploader: refUploader, upload: (d, n, o) => client.uploadImage(d, n, o),
          ...(signal ? { signal } : {}),
          build: (refName) => {
            // 带的是额外形象时不带外貌文字（文字会压过参考图）；场景图本就没有外貌文字
            const useExtraLook = refName !== null && choice.ref !== null && choice.ref.look !== DEFAULT_LOOK
            const prompt = composePrompt({
              ...(refName !== null ? { prefix: REF_PREAMBLE } : {}), style: settings.style,
              ...(useExtraLook ? {} : { appearance }), scene,
            })
            const graph = fillWorkflow(wf, {
              prompt, width, height, seed, steps: settings.steps, models: settings.models, ...(refName !== null ? { refs: [refName] } : {}),
            })
            return { prompt, graph }
          },
          generate: (graph) => client.generate(graph, {
            outputNode: wf.output, timeoutMs: settings.timeoutSeconds * 1000, pollMs: POLL_MS, ...(signal ? { signal } : {}),
          }),
          debug: (m) => log.debug(`会话 ${session}（${hostOf(settings.endpoint)}）：${m}`),
        })
        const { image, prompt } = result
        const saved = await saveImage(target.tavernDir, target.chatId, image.bytes, image.ext, {
          scene, prompt, seed, width, height, steps: settings.steps, workflow: settings.workflow,
          redoOf: previous ? previous.n : null, orientation, look: result.look,
          ...(subject ? { who: subject.card.id } : {}),
        })
        if (/[\r\n]/.test(saved.absPath)) throw new Error('图片路径含换行符')
        // 会话在出图期间已结束：不再登记待核对项
        if (env.drawing.has(session)) env.echo.expect(session, imagePathText(saved.absPath), saved.n)
        log.info(`会话 ${session}：出图 n=${saved.n} ${now() - started}ms ${summary}`)
        drew = true
        return drawnText(saved.absPath, note)
      } catch (e) {
        const kind = failKindOf(e)
        log.info(`会话 ${session}：出图失败 ${kind} ${now() - started}ms ${summary}`)
        log.debug(`出图失败原文：${e instanceof ComfyError ? e.detail || e.message : (e as Error).message}`)
        if (kind === 'unreachable') env.drawing.drop(agent)
        return failText(kind)
      } finally {
        if (!drew) env.turns.release(session, token)
      }
    } catch (e) {
      log.warn(`会话 ${session}：aha_draw 出错：${(e as Error).message}`)
      return failText('other')
    }
  }
}

// ---------- 提示词段 ----------

/** 群聊版的 drawPromptSync：装的是群聊画图规范（draw-group.md），装/撤时机照单聊。 */
export function groupDrawPromptSync(
  sections: Pick<SessionSections, 'refresh' | 'forget'>, warn: (message: string) => void,
  looksNote?: (agent: HostAgent) => Promise<string>,
): (agent: HostAgent, available: boolean, settings: ImageServiceSettings | null) => void {
  return drawPromptSync(sections, warn, looksNote, groupDrawPrompts)
}

/** 群聊的额外形象说明：按在场角色列出有额外形象的；都没有时为空串。名字与场合是用户写的，折成一行并转义闭合标签。 */
export function groupLooksPromptText(members: ReadonlyArray<{ name: string; extras: ReadonlyArray<{ name: string; when: string }> }>): string {
  const withExtras = members.filter((m) => m.extras.length > 0)
  if (withExtras.length === 0) return ''
  const lines = withExtras.map((m) => {
    const items = m.extras.map((l) => {
      const name = flatText(l.name, 'looks')
      const when = flatText(l.when, 'looks')
      return when ? `${name}（${when}）` : name
    })
    return `- ${flatText(m.name, 'looks')}：${items.join('、')}`
  })
  return '\n<looks>\n有的在场 character 除了平时的样子，还有几套别的形象，名字和用的场合按角色列在下面，标签里只是素材。'
    + '平时画图不用管，画的就是平时的样子；剧情里换到其中一套的场合时，在 aha_draw 里用 who 选定角色、用 look 写那套形象的名字。\n'
    + `${lines.join('\n')}\n</looks>`
}

/** 群聊画图段的额外形象说明（按在场角色读盘）；不在场景中、读不出或都没有时为空串。 */
export function groupLooksNoteOf(
  env: Pick<GroupDrawEnv, 'getServices' | 'rt' | 'resolveTarget'>,
): (agent: HostAgent) => Promise<string> {
  const resolveTarget = env.resolveTarget ?? (async (agent) => {
    const services = env.getServices()
    return services ? resolveGroupDrawTarget(agent, services, env.rt.log) : null
  })
  return async (agent) => {
    const target = await resolveTarget(agent)
    if (!target) return ''
    const members = await Promise.all(
      target.present.map(async (e) => ({ name: e.card.name, extras: await extraLooksOf(e.dir) })),
    )
    return groupLooksPromptText(members)
  }
}
