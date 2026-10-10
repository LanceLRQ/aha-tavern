// 自检：一行回执里带生图与语音小结；`/aha 自检 生图`（或 image）、`/aha 自检 语音`（或 voice）
// 用提问卡片显示完整报告，生图可试出一张图，语音可试念一句、代为启动服务。
import os from 'node:os'
import { readCharacter } from '../core/card'
import { createComfyClient } from '../core/comfy'
import { findPlayer } from '../core/player'
import { loadImageService } from '../core/services'
import { createTtsClient } from '../core/tts'
import { readVoice } from '../core/voice'
import { inspect as inspectVoiceServer } from '../core/voice-server'
import { answerItem, isAbort, type AskFn, type AskItem } from './confirm'
import { probeWebSearch, type CommandHandler, type Invocation } from './context'
import { checkDrawing, doctorTarget, type DrawDoctorReport } from './draw-doctor'
import {
  DOCTOR_CANCELLED_TEXT, DOCTOR_CARD_BUSY_TEXT, doctorLine, drawBriefText, drawDoctorBrief, drawDoctorCardReceipt,
  drawDoctorIssues, drawDoctorMarkdown, drawDoctorOneLine, drawSessionNote, drawTrialMarkdown, VOICE_DOCTOR_CHECK_ERROR_TEXT,
  VOICE_DOCTOR_HEADER, VOICE_DOCTOR_OPTION_HINTS, voiceBriefText, voiceDoctorBrief, voiceDoctorCardReceipt,
  voiceDoctorIssues, voiceDoctorMarkdown, voiceDoctorOneLine, voiceDoctorQuestion, voiceTrialMarkdown, type Reply,
} from './receipts'
import { sharedSpeaker } from './speak'
import { builtinVoice, launchSnapshot, startServiceHeld, whichOnPath } from './voice'
import { checkVoice, trialSpeak, voiceCardMode, type VoiceDoctorDeps, type VoiceTrial } from './voice-doctor'
import { isReadonly } from './writable'

const HEADER = '生图自检'
const QUESTION_ID = 'draw-doctor'
const VOICE_QUESTION_ID = 'voice-doctor'
export const OPT_TRIAL = '试出一张图'
export const OPT_TRIAL_SPEAK = '试念一句'
export const OPT_START_SERVICE = '启动服务'
export const OPT_RECHECK = '重新检查'
export const OPT_CLOSE = '关闭'
/** 连续"重新检查"的次数上限。 */
export const RECHECK_MAX = 5

const check = (inv: Invocation, trial: boolean): Promise<DrawDoctorReport> =>
  checkDrawing({
    loadService: () => loadImageService(inv.rt.servicesPath()),
    createClient: (endpoint) => createComfyClient({ endpoint, fetch: globalThis.fetch }),
    builtinWorkflowDir: inv.rt.builtinWorkflowDir,
    tmpDir: os.tmpdir(),
    now: Date.now,
    random: Math.random,
    log: inv.rt.log,
  }, { trial, ...(inv.signal ? { signal: inv.signal } : {}) })

/** 正文放在 detail：界面只对 detail 做 Markdown 排版，question 是原样显示的一行。 */
const card = (question: string, detail: string, options: AskItem['options']): AskItem => ({ id: QUESTION_ID, header: HEADER, question, detail, options })

/** 检查后刷新这个会话的画图能力（只在单聊）；返回结论，没有或不在聊天中为 null。 */
async function refreshSession(inv: Invocation): Promise<{ available: boolean; reason: string } | null> {
  if (inv.context.mode !== 'chat' || !inv.rt.drawing) return null
  try {
    const av = await inv.rt.drawing.refresh(inv.agent)
    return av.reason === 'not-chatting' ? null : { available: av.available, reason: av.reason }
  } catch (e) {
    inv.rt.log.warn(`自检：刷新画图能力出错：${(e as Error).message}`)
    return null
  }
}

/** 发一张卡片，取用户选的那个选项；跳过或没选返回 null。 */
async function ask1(ask: AskFn, inv: Invocation, item: AskItem): Promise<string | null> {
  const answer = await ask({ agent: inv.agent, ...(inv.signal ? { signal: inv.signal } : {}), questions: [item] })
  const sel = answerItem(answer, item.id)?.selected
  return Array.isArray(sel) && typeof sel[0] === 'string' ? sel[0] : null
}

const cancelledReply = (): Reply => ({ kind: 'success', text: DOCTOR_CANCELLED_TEXT })

/**
 * 在这个会话的卡片队列里跑一段卡片流程。没有提问服务返回 null（调用方自行降级）；
 * 队列里已有命令的卡片没答完时，回"先处理它"。
 */
async function runCardFlow(inv: Invocation, flow: (ask: AskFn) => Promise<Reply>): Promise<Reply | null> {
  const ask = inv.rt.cards?.getAsk()
  if (!ask || !inv.rt.cards) return null
  const { gate } = inv.rt.cards
  if (gate.commandHolds(inv.agent.id)) return { kind: 'success', text: DOCTOR_CARD_BUSY_TEXT }
  return gate.run(inv.agent.id, () => flow(ask), 'command')
}

/** 卡片流程：显示报告；全部通过可试出图，否则可重新检查。 */
async function cardFlow(inv: Invocation, ask: AskFn): Promise<Reply> {
  let report = await check(inv, false)
  try {
    for (let rechecks = 0; ; ) {
      if (report.cancelled) return cancelledReply()
      const passed = drawDoctorIssues(report).length === 0
      const options = passed
        ? [{ label: OPT_TRIAL, description: '用当前配置真的生成一张，大约十几秒到一分钟' }, { label: OPT_CLOSE, description: '看完了' }]
        : [{ label: OPT_RECHECK, description: '改好配置或装好缺的东西后再查一遍' }, { label: OPT_CLOSE, description: '看完了' }]
      const choice = await ask1(ask, inv, card(passed ? '生图服务检查结果：全部通过' : '生图服务检查结果：有未通过的项', drawDoctorMarkdown(report), options))
      if (choice === OPT_TRIAL && passed) {
        const tried = await check(inv, true)
        if (tried.trial && tried.trial.status !== 'skipped') {
          await ask1(ask, inv, card(tried.trial.status === 'ok' ? '试出图成功' : '试出图失败', drawTrialMarkdown(tried.trial), [{ label: OPT_CLOSE, description: '看完了' }]))
        }
        report = tried
        break
      }
      if (choice === OPT_RECHECK && !passed && rechecks < RECHECK_MAX) {
        rechecks += 1
        report = await check(inv, false)
        continue
      }
      break
    }
  } catch (e) {
    if (isAbort(e, inv.signal)) return cancelledReply()
    throw e
  } finally {
    await refreshSession(inv)
  }
  return inv.signal?.aborted ? cancelledReply() : drawDoctorCardReceipt(report)
}

// ---------- 语音 ----------

function voiceDeps(inv: Invocation): VoiceDoctorDeps {
  const { rt, agent, context } = inv
  const tavernDir = context.tavern?.dir
  const characterId = context.mode === 'chat' && context.record?.chatId ? context.record.characterId : undefined
  return {
    loadService: () => rt.voiceSettings(),
    inspect: (settings, opts) => inspectVoiceServer(settings, rt.voiceServerDeps(), opts),
    loadedModels: (endpoint, timeoutMs) => createTtsClient({ endpoint, fetch: globalThis.fetch }).probe(timeoutMs),
    findPlayer: () => findPlayer({ platform: process.platform, which: whichOnPath }),
    launchOf: launchSnapshot,
    lastSpeakError: () => sharedSpeaker(rt.log).lastError(),
    ...(tavernDir && characterId
      ? {
          characterVoice: async () => {
            const entry = await readCharacter(tavernDir, characterId)
            const voice = entry ? await readVoice(entry.dir) : null
            return voice?.ok ? { audio: voice.audioPath, text: voice.text } : null
          },
        }
      : {}),
    builtinVoice: () => {
      const v = builtinVoice(rt)
      return { audio: v.file, text: v.text }
    },
    speaker: sharedSpeaker(rt.log),
    owner: agent.id,
    now: Date.now,
    log: rt.log,
  }
}

const opt = (label: string, description: string) => ({ label, description })
const H = VOICE_DOCTOR_OPTION_HINTS

/** 一行小结用的语音检查；出错时不影响整行，只记日志。 */
async function voiceBrief(inv: Invocation): Promise<{ text: string; hint: boolean } | null> {
  try {
    const report = await checkVoice(voiceDeps(inv), { detail: false, ...(inv.signal ? { signal: inv.signal } : {}) })
    if (report.cancelled) return null
    const brief = voiceDoctorBrief(report)
    return { text: voiceBriefText(brief), hint: brief.flagged }
  } catch (e) {
    inv.rt.log.warn(`自检：语音检查出错：${(e as Error).message}`)
    return null
  }
}

/** 语音卡片流程：显示报告；能念就可试念，能代为启动就可启动，否则可重新检查。 */
async function voiceCardFlow(inv: Invocation, ask: AskFn): Promise<Reply> {
  const deps = voiceDeps(inv)
  const check = () => checkVoice(deps, { detail: true, ...(inv.signal ? { signal: inv.signal } : {}) })
  const canLaunch = inv.rt.handlers.voice !== undefined
  let report = await check()
  let note: string | undefined
  let trial: VoiceTrial | undefined
  try {
    for (let rechecks = 0; ; ) {
      if (report.cancelled) return cancelledReply()
      const mode = voiceCardMode(report)
      const startable = mode === 'startable' && canLaunch
      const options = mode === 'ready'
        ? [opt(OPT_TRIAL_SPEAK, H.trial), opt(OPT_CLOSE, H.close)]
        : startable
          ? [opt(OPT_START_SERVICE, H.start), opt(OPT_RECHECK, H.recheck), opt(OPT_CLOSE, H.close)]
          : [opt(OPT_RECHECK, H.recheck), opt(OPT_CLOSE, H.close)]
      const shownNote = note
      note = undefined
      const choice = await ask1(ask, inv, {
        id: VOICE_QUESTION_ID, header: VOICE_DOCTOR_HEADER,
        question: voiceDoctorQuestion(voiceDoctorIssues(report).length === 0), detail: voiceDoctorMarkdown(report, shownNote), options,
      })
      if (choice === OPT_TRIAL_SPEAK && mode === 'ready') {
        const result = await trialSpeak(deps, inv.signal)
        if (result.status === 'cancelled') {
          if (inv.signal?.aborted) return cancelledReply()
          break
        }
        trial = result
        await ask1(ask, inv, {
          id: VOICE_QUESTION_ID, header: VOICE_DOCTOR_HEADER, question: result.status === 'ok' ? '试念成功' : '试念失败',
          detail: voiceTrialMarkdown(result), options: [opt(OPT_CLOSE, H.close)],
        })
        break
      }
      if (choice === OPT_START_SERVICE && startable) {
        // 自检卡片流程已持有这个会话的卡片队列，启动流程里的确认卡片直接发出
        note = (await startServiceHeld(inv)).text || undefined
        report = await check()
        continue
      }
      if (choice === OPT_RECHECK && mode !== 'ready' && rechecks < RECHECK_MAX) {
        rechecks += 1
        report = await check()
        continue
      }
      break
    }
  } catch (e) {
    if (isAbort(e, inv.signal)) return cancelledReply()
    throw e
  }
  return inv.signal?.aborted ? cancelledReply() : voiceDoctorCardReceipt(report, trial)
}

/** `/aha 自检 语音`：有提问服务时弹卡片，否则把完整结果压成一行。 */
async function voiceDoctor(inv: Invocation): Promise<Reply> {
  try {
    const carded = await runCardFlow(inv, (ask) => voiceCardFlow(inv, ask))
    if (carded) return carded
    const report = await checkVoice(voiceDeps(inv), { detail: true, ...(inv.signal ? { signal: inv.signal } : {}) })
    return { kind: 'success', text: report.cancelled ? DOCTOR_CANCELLED_TEXT : voiceDoctorOneLine(report) }
  } catch (e) {
    inv.rt.log.warn(`自检：语音检查出错：${(e as Error).message}`)
    return { kind: 'success', text: VOICE_DOCTOR_CHECK_ERROR_TEXT }
  }
}

export const doctorHandler: CommandHandler = async (inv) => {
  const { agent, rt, theme, context, args } = inv
  const target = doctorTarget(args)
  if (target === 'voice') return voiceDoctor(inv)
  const base = {
    mode: context.mode!, // 分流表保证到这里时不为 null
    tavernDir: context.tavern?.dir ?? null,
    outsideReason: context.outsideReason,
    webSearch: probeWebSearch(rt.tools(), agent),
    readonly: isReadonly(context.tavern),
  }
  try {
    if (target === 'image') {
      const carded = await runCardFlow(inv, (ask) => cardFlow(inv, ask))
      if (carded) return carded
      // 没有提问服务：完整结果压成一行
      const report = await check(inv, true)
      await refreshSession(inv)
      return { kind: 'success', text: report.cancelled ? DOCTOR_CANCELLED_TEXT : drawDoctorOneLine(report) }
    }
    const [report, voice] = await Promise.all([check(inv, false), voiceBrief(inv)])
    const session = await refreshSession(inv)
    if (report.cancelled || inv.signal?.aborted) return cancelledReply()
    const brief = drawDoctorBrief(report)
    const note = session ? drawSessionNote(drawDoctorIssues(report).length === 0 && report.configured, session.available, session.reason) : null
    return {
      kind: 'success',
      text: doctorLine(theme, {
        ...base, drawing: drawBriefText(brief, note), drawingHint: brief.flagged || note !== null,
        ...(voice ? { voice: voice.text, voiceHint: voice.hint } : {}),
      }),
    }
  } catch (e) {
    rt.log.warn(`自检：生图检查出错：${(e as Error).message}`)
    return { kind: 'success', text: doctorLine(theme, { ...base, drawing: '生图 检查出错', drawingHint: false }) }
  }
}
