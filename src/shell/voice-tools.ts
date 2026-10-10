// 筹备模式里与角色音色有关的工具。返回值是给掌柜看的文字：英文固定标识加简短说明，
// 不带出文件系统的错误原文。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import { listCharacters, matchCharacterName } from '../core/card'
import {
  MAX_VOICE_BYTES, MAX_VOICE_SECONDS, MIN_VOICE_SECONDS, VOICE_TEXT_MAX_CHARS, readVoice, registerVoice,
  type VoiceConvert, type VoiceRegisterResult,
} from '../core/voice'
import { findConverter } from '../core/player'
import { answerItem, isAbort, type AskFn, type DeclineTracker, type SessionGate } from './confirm'
import type { HostAgent } from './context'
import { VOICE_SET_OPT_REPLACE, VOICE_SET_QUESTION_ID, voiceReplaceQuestion } from './receipts'
import type { Runtime } from './runtime'
import {
  checkReadiness, quietSpawn, realSpeakEnv, sharedSpeaker, type Readiness, type Speaker,
} from './speak'
import { flatText } from './steer'
import { whichOnPath } from './voice'
import { readonlyToolMessage } from './writable'

/** 登记成功后试念的固定一句。 */
export const VOICE_SET_TRIAL_TEXT = '你好，这是我现在的声音。'

const NOT_TAVERN = 'error: this workspace is not a tavern yet, voice not registered'
const CANCELLED = 'not registered: user cancelled the replacement'
const ABORTED = 'not registered: cancelled'
const ALREADY_DECLINED = 'not registered: already declined this turn; ask the user what to change first'
const DECLINE_KIND = 'voice-set'

export interface VoiceToolDeps {
  rt: Pick<Runtime, 'log'>
  getAsk(): AskFn | undefined
  /** 与保存类工具共用：同一会话的卡片整段排队。 */
  gate: SessionGate
  /** 同一轮内被拒绝后不再重复弹卡片。 */
  declines?: DeclineTracker
  speaker: Pick<Speaker, 'speak'>
  /** 现在能不能念：与朗读命令同一套检查。 */
  readiness(target: { tavernDir: string; characterId: string }): Promise<Readiness>
  /** 把非 wav 录音转成 wav 的函数；这个平台没有则为 null。 */
  findConverter(): Promise<VoiceConvert | null>
  homeDir(): string
  tavernDirOf(agent: HostAgent | undefined): Promise<string | undefined>
  /** 登记成功后调用（刷新掌柜看到的角色状态）；它的失败不影响工具返回。 */
  onRegistered(agent: HostAgent): Promise<void>
}

/** 真实环境下的依赖；酒馆目录与登记后的刷新由调用方给。 */
export function realVoiceToolDeps(
  rt: Runtime, shared: Pick<VoiceToolDeps, 'getAsk' | 'gate' | 'declines' | 'tavernDirOf' | 'onRegistered'>,
): VoiceToolDeps {
  const speaker = sharedSpeaker(rt.log)
  const env = realSpeakEnv(rt, speaker)
  return {
    ...shared,
    rt,
    speaker,
    readiness: (target) => checkReadiness(env, target),
    findConverter: () => findConverter({ platform: process.platform, which: whichOnPath, spawn: quietSpawn }),
    homeDir: os.homedir,
  }
}

/** 绝对路径，支持 ~ 开头；其他写法返回 null。 */
function resolveAudioPath(input: string, home: string): string | null {
  const p = input.trim()
  const expanded = p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p
  return path.isAbsolute(expanded) ? expanded : null
}

const fail = (message: string): string => `error: ${message}`

/** 登记失败的种类 -> 给掌柜的说明，让他能据此告诉用户怎么办。 */
function failureText(r: Exclude<VoiceRegisterResult, { kind: 'registered' }>): string {
  const secs = (n: number) => `${Math.round(n * 10) / 10}s`
  switch (r.kind) {
    case 'source-invalid':
      return fail('source-invalid, the file does not exist, is not a regular file, or is not a valid audio file; ask the user to check the path')
    case 'too-large':
      return fail(`too-large, the file is over ${MAX_VOICE_BYTES / 1024 / 1024}MB; ask for a shorter recording`)
    case 'too-short':
      return fail(`too-short, the recording is ${secs(r.seconds)}, minimum ${MIN_VOICE_SECONDS}s; ask for a longer one`)
    case 'too-long':
      return fail(`too-long, the recording is ${secs(r.seconds)}, maximum ${MAX_VOICE_SECONDS}s; ask for a shorter one`)
    case 'needs-wav':
      return fail('needs-wav, the file is not wav and cannot be converted here; ask the user to convert it to wav first')
    case 'text-empty':
      return fail('text-empty, the text of what is said in the recording is empty; ask the user for it')
    case 'text-too-long':
      return fail(`text-too-long, the text is over ${VOICE_TEXT_MAX_CHARS} characters; the recording should be a short passage`)
    case 'convert-failed':
      return fail('convert-failed, converting the file to wav failed; ask the user to convert it to wav first')
  }
}

type VoiceSetArgs = { character: unknown; audioPath: unknown; text: unknown }

/** 确认覆盖：同意返回 null，否则返回给掌柜的说明。 */
async function confirmReplace(
  deps: VoiceToolDeps, agent: HostAgent | undefined, name: string, signal?: AbortSignal,
): Promise<string | null> {
  const ask = deps.getAsk()
  if (!ask) {
    deps.rt.log.warn('确认卡片不可用（没有 userQuestions 服务），不登记音色')
    return 'not registered: confirmation unavailable'
  }
  const session = agent?.id
  if (session !== undefined && deps.declines?.has(session, DECLINE_KIND)) return ALREADY_DECLINED
  if (signal?.aborted) return ABORTED
  try {
    const shown = name.replace(/[「」]/g, '').replace(/\s+/g, ' ').trim()
    const answer = await ask({ agent, ...(signal ? { signal } : {}), questions: [voiceReplaceQuestion(shown)] })
    const item = answerItem(answer, VOICE_SET_QUESTION_ID)
    const selected = Array.isArray(item?.selected) ? item.selected : []
    const custom = typeof item?.custom === 'string' ? item.custom.trim() : ''
    if (custom === '' && selected.includes(VOICE_SET_OPT_REPLACE)) return null
    // 自由输入是修改意见，不算拒绝
    if (custom === '' && session !== undefined) deps.declines?.mark(session, DECLINE_KIND)
    return CANCELLED
  } catch (e) {
    if (isAbort(e, signal)) return ABORTED
    deps.rt.log.warn(`确认卡片失败：${(e as Error).message}`)
    return CANCELLED
  }
}

/** 登记成功后试念；服务不可用、没有播放器都只是没念，不算失败。 */
async function trial(deps: VoiceToolDeps, agent: HostAgent | undefined, tavernDir: string, characterId: string): Promise<boolean> {
  try {
    const ready = await deps.readiness({ tavernDir, characterId })
    if (!ready.ok) {
      deps.rt.log.debug(`登记音色后不试念：${ready.block}`)
      return false
    }
    deps.speaker.speak({
      sentences: [VOICE_SET_TRIAL_TEXT], voice: ready.voice, settings: ready.settings, player: ready.player,
      owner: agent?.id ?? 'voice-set',
    })
    return true
  } catch (e) {
    deps.rt.log.warn(`登记音色后试念失败：${(e as Error).message}`)
    return false
  }
}

async function setVoice(
  deps: VoiceToolDeps, agent: HostAgent | undefined, dir: string, args: VoiceSetArgs, signal?: AbortSignal,
): Promise<string> {
  const { character, audioPath, text } = args
  if (typeof character !== 'string' || character.trim() === '') return fail('character must be a non-empty string, voice not registered')
  if (typeof audioPath !== 'string' || audioPath.trim() === '') return fail('audioPath must be a non-empty string, voice not registered')
  if (typeof text !== 'string') return fail('text must be a string, voice not registered')
  const source = resolveAudioPath(audioPath, deps.homeDir())
  if (!source) return fail('audioPath must be an absolute path (or start with ~/), voice not registered; ask the user for the full path')

  const match = matchCharacterName(await listCharacters(dir), character)
  if (match.kind === 'none') return fail(`no character named "${flatText(character, 'voice')}"; call aha_list_characters for valid names`)
  if (match.kind === 'ambiguous') {
    const names = match.candidates.map((e) => flatText(e.ok ? e.card.name : e.dirName, 'voice')).join(', ')
    return fail(`the name matches several characters: ${names}; use the full name`)
  }
  const entry = match.entry
  if (!entry.ok) return fail(`the character card of ${flatText(entry.dirName, 'voice')} is unreadable; fix the card first`)

  if ((await readVoice(entry.dir)).ok) {
    const no = await confirmReplace(deps, agent, entry.card.name, signal)
    if (no) return no
  }
  const convert = await deps.findConverter()
  const r = await registerVoice({
    characterDir: entry.dir, sourcePath: source, text, ...(convert ? { convert } : {}), ...(signal ? { signal } : {}),
  })
  if (r.kind !== 'registered') return failureText(r)

  if (agent) {
    try {
      await deps.onRegistered(agent)
    } catch (e) {
      deps.rt.log.warn(`登记音色后刷新提示词段失败：${(e as Error).message}`)
    }
  }
  const spoken = await trial(deps, agent, dir, entry.card.id)
  const secs = Math.round(r.seconds * 10) / 10
  return `voice registered for ${flatText(entry.card.name, 'voice')} (${secs}s, replaced: ${r.replaced}); spoken: ${spoken}`
    + (spoken ? '' : ' (the voice service cannot speak right now; the voice is saved and will be used once it can)')
}

interface ToolHost {
  tools: { register(def: ReturnType<typeof defineTool>): unknown }
}

const outText = (_a: unknown, v: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: String(v) }]

export function registerVoiceTools(ctx: Context | ToolHost, deps: VoiceToolDeps): void {
  const host = ctx as unknown as ToolHost
  const run = async (exec: unknown, args: VoiceSetArgs): Promise<string> => {
    const agent = (exec as { agent?: unknown } | null)?.agent as HostAgent | undefined
    const sg = (exec as { signal?: unknown } | null)?.signal
    const signal = sg instanceof AbortSignal ? sg : undefined
    const go = async (): Promise<string> => {
      const dir = await deps.tavernDirOf(agent)
      if (!dir) return NOT_TAVERN
      const ro = await readonlyToolMessage(dir, deps.rt.log)
      if (ro) return ro.replace('not saved', 'voice not registered')
      try {
        const msg = await setVoice(deps, agent, dir, args, signal)
        deps.rt.log.debug(`工具 aha_voice_set：${msg}`)
        return msg
      } catch (e) {
        deps.rt.log.warn(`工具 aha_voice_set 出错：${(e as Error).message}`)
        return fail('voice not registered, internal error; try again or tell the user to check the files')
      }
    }
    return agent ? deps.gate.run(agent.id, go) : go()
  }

  host.tools.register(defineTool({
    name: 'aha_voice_set',
    description: '给某个 character 登记音色：把一段参考录音存成它的声音，之后朗读都用这个声音。'
      + '只有 user 明确给出了录音文件的绝对路径（可以以 ~/ 开头，相对路径会被拒绝）、并说出了录音里的原话，才调用本工具。'
      + 'text 必须是录音里逐字说的话，不要改写，不要自己编，也不要拿 character 的台词或别的文字顶替。'
      + '录音要求 3 到 15 秒、一个人说话、背景干净；文件不是 wav 时可能需要 user 先转成 wav。'
      + '该 character 已有音色时界面会请 user 确认覆盖。返回值会说明是否登记成功，以及是否已用新声音试念了一句。',
    parameters: {
      character: { type: 'string', required: true, description: 'character 的名字，来自 aha_list_characters' },
      audioPath: { type: 'string', required: true, description: '录音文件的绝对路径，可以以 ~/ 开头' },
      text: { type: 'string', required: true, description: '录音里说的话，必须与录音逐字一致' },
    },
    output: { schema: { type: 'string' }, render: outText },
    execute: (args, exec) => run(exec, args as VoiceSetArgs),
  }))
}

