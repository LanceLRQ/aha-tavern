// 自检：一行回执里带生图小结；`/aha 自检 生图`（或 image）用提问卡片显示完整报告，并可试出一张图。
import os from 'node:os'
import { createComfyClient } from '../core/comfy'
import { loadImageService } from '../core/services'
import { answerItem, isAbort, type AskFn, type AskItem } from './confirm'
import { probeWebSearch, type CommandHandler, type Invocation } from './context'
import { checkDrawing, wantsTrial, type DrawDoctorReport } from './draw-doctor'
import {
  DOCTOR_CANCELLED_TEXT, DOCTOR_CARD_BUSY_TEXT, doctorLine, drawBriefText, drawDoctorBrief, drawDoctorCardReceipt,
  drawDoctorIssues, drawDoctorMarkdown, drawDoctorOneLine, drawSessionNote, drawTrialMarkdown, type Reply,
} from './receipts'
import { isReadonly } from './writable'

const HEADER = '生图自检'
const QUESTION_ID = 'draw-doctor'
export const OPT_TRIAL = '试出一张图'
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

async function ask1(ask: AskFn, inv: Invocation, item: AskItem): Promise<string | null> {
  const answer = await ask({ agent: inv.agent, ...(inv.signal ? { signal: inv.signal } : {}), questions: [item] })
  const sel = answerItem(answer, QUESTION_ID)?.selected
  return Array.isArray(sel) && typeof sel[0] === 'string' ? sel[0] : null
}

/** 卡片流程：显示报告；全部通过可试出图，否则可重新检查。 */
async function cardFlow(inv: Invocation, ask: AskFn): Promise<Reply> {
  let report = await check(inv, false)
  try {
    for (let rechecks = 0; ; ) {
      if (report.cancelled) return { kind: 'success', text: DOCTOR_CANCELLED_TEXT }
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
    if (isAbort(e, inv.signal)) return { kind: 'success', text: DOCTOR_CANCELLED_TEXT }
    throw e
  } finally {
    await refreshSession(inv)
  }
  return inv.signal?.aborted ? { kind: 'success', text: DOCTOR_CANCELLED_TEXT } : drawDoctorCardReceipt(report)
}

export const doctorHandler: CommandHandler = async (inv) => {
  const { agent, rt, theme, context, args } = inv
  const base = {
    mode: context.mode!, // 分流表保证到这里时不为 null
    tavernDir: context.tavern?.dir ?? null,
    outsideReason: context.outsideReason,
    webSearch: probeWebSearch(rt.tools(), agent),
    readonly: isReadonly(context.tavern),
  }
  try {
    if (wantsTrial(args)) {
      const ask = rt.cards?.getAsk()
      if (ask && rt.cards) {
        const { gate } = rt.cards
        if (gate.commandHolds(agent.id)) return { kind: 'success', text: DOCTOR_CARD_BUSY_TEXT }
        return await gate.run(agent.id, () => cardFlow(inv, ask), 'command')
      }
      // 没有提问服务：完整结果压成一行
      const report = await check(inv, true)
      await refreshSession(inv)
      return { kind: 'success', text: report.cancelled ? DOCTOR_CANCELLED_TEXT : drawDoctorOneLine(report) }
    }
    const report = await check(inv, false)
    const session = await refreshSession(inv)
    if (report.cancelled || inv.signal?.aborted) return { kind: 'success', text: DOCTOR_CANCELLED_TEXT }
    const brief = drawDoctorBrief(report)
    const note = session ? drawSessionNote(drawDoctorIssues(report).length === 0 && report.configured, session.available, session.reason) : null
    return {
      kind: 'success',
      text: doctorLine(theme, { ...base, drawing: drawBriefText(brief, note), drawingHint: brief.flagged || note !== null }),
    }
  } catch (e) {
    rt.log.warn(`自检：生图检查出错：${(e as Error).message}`)
    return { kind: 'success', text: doctorLine(theme, { ...base, drawing: '生图 检查出错', drawingHint: false }) }
  }
}
