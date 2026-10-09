// 回执文字：纯函数，所有称呼与动作经主题取词。固定不随主题变的：模式名、命令的中英文名。
import type { TavernMode } from '../config'
import type { DispatchReason } from '../core/dispatch'
import type { OutsideReason } from '../core/state'
import type { Theme } from '../core/theme'

export const MODE_LABEL: Record<TavernMode, string> = { setup: '酒馆:筹备', chat: '酒馆:单聊' }

/** 回执：宿主只有 success / error 两种，error 在界面上是红色的 Failed，只给真正的错误用。 */
export type Reply = { kind: 'success' | 'error'; text: string }

const guide = (text: string): Reply => ({ kind: 'success', text })
const fail = (text: string): Reply => ({ kind: 'error', text })

export interface SubcommandName {
  zh: string
  en: string
}

export interface DispatchReceiptInfo {
  /** 用户敲的写法，用于"尚未提供"之类的提示，如 `/aha 重掷`。 */
  label?: string
  outsideReason?: OutsideReason | null
}

/** 分流不执行时的指引回执（success）。 */
export function dispatchReceipt(theme: Theme, reason: DispatchReason, info: DispatchReceiptInfo = {}): Reply {
  return guide(dispatchText(theme, reason, info))
}

function dispatchText(theme: Theme, reason: DispatchReason, info: DispatchReceiptInfo): string {
  const tavern = theme.concept('tavern')
  const label = info.label ?? '这条命令'
  switch (reason) {
    case 'init-first':
      return info.outsideReason === 'no-workspace'
        ? `这个会话还没有选工作区。请先选一个工作区，再用 \`/aha 开店\` 把它变成一间${tavern}。`
        : `这里还不是${tavern}。先用 \`/aha 开店\` 把这里变成一间${tavern}。`
    case 'go-setup':
      if (info.outsideReason === 'not-tavern') {
        return `这里还不是${tavern}。请切换到「${MODE_LABEL.setup}」，用 \`/aha 开店\` 开${tavern}，由${theme.host().name}接待。`
      }
      if (info.outsideReason === 'no-workspace') {
        return `这个会话还没有选工作区，也就还没有${tavern}。请先选一个工作区，再切换到「${MODE_LABEL.setup}」用 \`/aha 开店\` 开${tavern}，由${theme.host().name}接待。`
      }
      return `这件事归${theme.host().name}在「${MODE_LABEL.setup}」里办，请切换到那个模式再试。`
    case 'go-chat':
      return `开场要在「${MODE_LABEL.chat}」里进行，请切换到那个模式再用 \`/aha 开场\`。`
    case 'new-session':
      return `这场聊天正在进行。要和别的${theme.concept('character')}聊，请新开一个会话再用 \`/aha 开场\`。`
    case 'already-tavern':
      return `这里已经是一间${tavern}了，不用再${theme.action('init')}。`
    case 'meaningless':
      return `${label}：在现在的状态下用不上。`
    case 'unavailable':
      return `${label}：此功能尚未提供。`
  }
}

const listSubs = (subs: readonly SubcommandName[]): string => subs.map((s) => `${s.zh}/${s.en}`).join('、')

export function unknownReceipt(word: string, subs: readonly SubcommandName[]): Reply {
  return fail(`没有「${word}」这个子命令。可用的有：${listSubs(subs)}。`)
}

export function emptyReceipt(subs: readonly SubcommandName[]): Reply {
  return fail(`\`/aha\` 后面要跟子命令。可用的有：${listSubs(subs)}。`)
}

export function pendingReceipt(label: string): Reply {
  return guide(`${label}：尚未接上。`)
}

export function failureReceipt(message: string): Reply {
  return fail(`没能完成：${message}`)
}

/** 实际模式不是酒馆的模式（映射不到）。 */
export function notTavernModeReceipt(): Reply {
  return guide('当前不在酒馆的模式里。')
}

export type WebSearchStatus = 'available' | 'unavailable' | 'unknown'

/** 酒馆数据比插件新：除自检外的命令都不执行。 */
export function readonlyReceipt(theme: Theme): Reply {
  return guide(`这间${theme.concept('tavern')}的数据比插件新，请升级插件后再来；现在只能查看。`)
}

export interface DoctorInfo {
  mode: TavernMode
  tavernDir: string | null
  outsideReason: OutsideReason | null
  webSearch: WebSearchStatus
  /** 酒馆数据版本较新，只能查看。 */
  readonly?: boolean
}

const WEB_LABEL: Record<WebSearchStatus, string> = { available: '可用', unavailable: '不可用', unknown: '未知' }

export function doctorLine(theme: Theme, info: DoctorInfo): string {
  const place = info.tavernDir
    ? `${theme.concept('tavern')} ${info.tavernDir}`
    : info.outsideReason === 'no-workspace'
      ? '门外（会话没有工作区）'
      : `门外（这里不是${theme.concept('tavern')}）`
  return `当前状态：模式 ${MODE_LABEL[info.mode]}；${place}；主题 ${theme.name}；联网搜索 ${WEB_LABEL[info.webSearch]}${info.readonly ? '；只读（数据版本较新）' : ''}`
}

/** 开店时会话没有工作区。 */
export function initNeedsWorkspaceReceipt(theme: Theme): Reply {
  return dispatchReceipt(theme, 'init-first', { outsideReason: 'no-workspace' })
}

/** 开店成功：一行，掌柜马上会开口。 */
export function initDoneReceipt(
  theme: Theme,
  name: string,
  opts: { registryWarning?: string | undefined; guidanceFailed?: boolean } = {},
): Reply {
  const base = `${theme.concept('tavern')}「${name}」已${theme.action('init')}。`
  const reg = opts.registryWarning ? `（登记表没写成：${opts.registryWarning}）` : ''
  const gd = opts.guidanceFailed ? `不过引导没发出来，直接和${theme.host().name}说话就行。` : ''
  return guide(base + reg + gd)
}

// ---------- 建卡命令的回执 ----------

const CARD_PROBLEM: Record<string, string> = {
  'file-missing': '文件不存在',
  'yaml-invalid': '格式解析失败',
  'missing-required': '缺少必填栏',
  'missing-id': '缺少编号',
  unreadable: '读不出来',
}

/** 建卡不带名字：请掌柜听用户描述。 */
export function cardAskReceipt(theme: Theme): Reply {
  return guide(`${theme.host().name}正在等你描述想要的${theme.concept('character')}。`)
}

/** 建卡带名字且匹配到好卡：请掌柜进入修改流程。 */
export function cardEditReceipt(theme: Theme, name: string): Reply {
  return guide(`${theme.host().name}正在看「${name}」的${theme.concept('card')}。`)
}

export function cardAmbiguousReceipt(theme: Theme, names: readonly string[]): Reply {
  return guide(`有好几个${theme.concept('character')}都对得上：${names.join('、')}。请把名字写全一些再试。`)
}

/** 建卡带名字但没有同名角色：按新建处理，名字用它。 */
export function cardNewNamedReceipt(theme: Theme, input: string): Reply {
  return guide(`还没有叫「${input}」的${theme.concept('character')}，${theme.host().name}会按这个名字新建，等你描述一下 TA。`)
}

/** 匹配到的是坏卡：说明哪个文件、什么问题。 */
export function cardBrokenReceipt(
  theme: Theme,
  b: { dirName: string; file: string; problem: string; detail: string },
): Reply {
  const what = CARD_PROBLEM[b.problem] ?? b.problem
  const detail = b.detail ? `（${b.detail}）` : ''
  return fail(`「${b.dirName}」的${theme.concept('card')}读不出来：${b.file}，${what}${detail}。请先用编辑器修好这个文件。`)
}

// ---------- 导入命令的回执 ----------

export function importNoSourceReceipt(theme: Theme): Reply {
  return guide(`登记表里没有别的${theme.concept('tavern')}，没有可以${theme.action('import')}的来源。`)
}

export function importCancelledReceipt(theme: Theme): Reply {
  return guide(`已取消${theme.action('import')}，什么都没有改动。`)
}

export function importNothingReceipt(theme: Theme, sourceName: string, brokenCount: number): Reply {
  const broken = brokenCount > 0 ? `（另有 ${brokenCount} 张${theme.concept('card')}读不出来）` : ''
  return guide(`「${sourceName}」里没有可以${theme.action('import')}的${theme.concept('character')}或${theme.concept('profile')}${broken}。`)
}
