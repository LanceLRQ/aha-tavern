// 回执文字：纯函数，所有称呼与动作经主题取词。固定不随主题变的：模式名、命令的中英文名。
import type { TavernMode } from '../config'
import type { DispatchReason } from '../core/dispatch'
import type { OutsideReason } from '../core/state'
import type { Theme } from '../core/theme'
import type { AskItem } from './confirm'
import type { DoctorFailKind, DrawDoctorReport } from './draw-doctor'

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
  /** 用户敲的写法，用于"尚未提供"之类的提示，如 `/aha 重新生图`。 */
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
        ? `这个会话还没有选工作区。请先选一个工作区，再用 \`/aha 启动\` 把它变成一间${tavern}。`
        : `这里还不是${tavern}。先用 \`/aha 启动\` 把这里变成一间${tavern}。`
    case 'go-setup':
      if (info.outsideReason === 'not-tavern') {
        return `这里还不是${tavern}。请切换到「${MODE_LABEL.setup}」，用 \`/aha 启动\` 开${tavern}，由${theme.host().name}接待。`
      }
      if (info.outsideReason === 'no-workspace') {
        return `这个会话还没有选工作区，也就还没有${tavern}。请先选一个工作区，再切换到「${MODE_LABEL.setup}」用 \`/aha 启动\` 开${tavern}，由${theme.host().name}接待。`
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

/** 重新生图：这个会话没有画图能力。not-configured 指向安装文档，其余原因指向自检。 */
export function rerollUnavailableReceipt(reason: string): Reply {
  if (reason === 'not-configured') return guide('还没有配置生图服务。配置方法见 docs/image-setup.md，配好后用 /aha 自检 检查。')
  return fail(`生图服务当前不可用（${unavailableWhy(reason)}）。用 /aha 自检 看看哪里出了问题。`)
}

const UNAVAILABLE_WHY: Record<string, string> = {
  'not-configured': '还没有配置生图服务', unreachable: '连不上服务', error: '读取配置时出错', readonly: '酒馆数据比插件新，只读', 'not-chatting': '还没有开始聊天',
}

/** 画图能力不可用原因的中文说法。 */
export function unavailableWhy(reason: string): string {
  return UNAVAILABLE_WHY[reason] ?? '原因不明'
}

export function rerollNothingReceipt(): Reply {
  return guide('这次聊天里还没有画过图。')
}

export function rerollStartedReceipt(withChange: boolean): Reply {
  return guide(withChange ? '已请 TA 按你的修改重新画上一张。' : '已请 TA 重新画上一张。')
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
  /** 生图一行小结（放在模式之后、酒馆路径之前）。 */
  drawing?: string
  /** 行末是否提示"看详情"。 */
  drawingHint?: boolean
}

const WEB_LABEL: Record<WebSearchStatus, string> = { available: '可用', unavailable: '不可用', unknown: '未知' }

export function doctorLine(theme: Theme, info: DoctorInfo): string {
  const place = info.tavernDir
    ? `${theme.concept('tavern')} ${info.tavernDir}`
    : info.outsideReason === 'no-workspace'
      ? '门外（会话没有工作区）'
      : `门外（这里不是${theme.concept('tavern')}）`
  const draw = info.drawing ? `；${info.drawing}` : ''
  const hint = info.drawing && info.drawingHint ? DOCTOR_DETAIL_HINT : ''
  return `当前状态：模式 ${MODE_LABEL[info.mode]}${draw}；${place}；主题 ${theme.name}；联网搜索 ${WEB_LABEL[info.webSearch]}${info.readonly ? '；只读（数据版本较新）' : ''}${hint}`
}

// ---------- 自检的生图一段 ----------

const DOCTOR_FAIL_TEXT: Record<DoctorFailKind, string> = {
  unreachable: '连不上', 'missing-node': '缺少节点', 'missing-model': '缺少模型文件', timeout: '超时', cancelled: '已取消',
  save: '图片保存失败', other: '出错',
}

const GGUF_NODE = 'UnetLoaderGGUF'
const ITEM_CHARS = 120
const LIST_MAX = 10
export const DOCTOR_DETAIL_HINT = '（/aha 自检 生图 看详情）'

const clip = (s: string, max = ITEM_CHARS): string => {
  const chars = [...s.replace(/[\r\n]+/g, ' ')]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/** 最多列 LIST_MAX 项，超出的以"等 N 项"收尾（N 为总数）。 */
function capList<T>(items: T[]): { shown: T[]; more: string } {
  return items.length > LIST_MAX ? { shown: items.slice(0, LIST_MAX), more: `等 ${items.length} 项` } : { shown: items, more: '' }
}

interface DoctorItem {
  mark: string
  text: string
  /** 模型下载地址 */
  url?: string
}

/** 没通过的项的短说法，一项一条；按检查顺序。服务地址只显示主机与端口。 */
export function drawDoctorIssues(r: DrawDoctorReport): string[] {
  if (!r.configured) return ['未配置']
  const out: string[] = []
  if (r.service && !r.service.connected) {
    out.push(r.service.credentials ? '地址里带了用户名和密码' : `连不上 ${r.service.host}`)
  }
  if (r.workflow && !r.workflow.ok) out.push('工作流读不了')
  if (r.nodes?.error) out.push('读不到节点信息')
  for (const n of r.nodes?.missing ?? []) out.push(`缺少节点 ${clip(n)}`)
  for (const m of r.models?.missing ?? []) out.push(`缺少模型 ${clip(m.file)}`)
  return out
}

function drawDoctorItems(r: DrawDoctorReport): DoctorItem[] {
  const items: DoctorItem[] = []
  const problems = (): void => {
    const { shown, more } = capList(r.problems)
    for (const p of shown) items.push({ mark: '!', text: clip(p) })
    if (more) items.push({ mark: '!', text: more })
  }
  if (!r.configured) {
    items.push({ mark: '', text: '生图：未配置。配置方法见 docs/image-setup.md。' })
    problems()
    return items
  }
  const s = r.service
  if (s) {
    if (s.credentials) items.push({ mark: '✗', text: `生图服务 ${s.host} 地址里不要带用户名和密码` })
    else {
      items.push(s.connected
        ? { mark: '✓', text: `生图服务 ${s.host} 已连上（ComfyUI ${s.version || '版本未知'}）` }
        : { mark: '✗', text: `生图服务 ${s.host} 连不上` })
    }
  }
  if (r.workflow) {
    items.push(r.workflow.ok
      ? { mark: '✓', text: `工作流 ${clip(r.workflow.name)}` }
      : { mark: '✗', text: `工作流 ${clip(r.workflow.name)}：${clip(r.workflow.reason ?? '读不了')}` })
  }
  if (r.nodes) {
    if (r.nodes.error) items.push({ mark: '✗', text: '读不到节点信息' })
    else if (r.nodes.missing.length === 0) items.push({ mark: '✓', text: `节点齐全（${r.nodes.total} 种）` })
    else {
      const { shown, more } = capList(r.nodes.missing)
      items.push({ mark: '✗', text: `缺少节点：${shown.map((n) => clip(n)).join('、')}${more ? `${more}` : ''}` })
      if (r.nodes.missing.includes(GGUF_NODE)) {
        items.push({ mark: '', text: `${GGUF_NODE} 来自自定义节点 ComfyUI-GGUF；装上它，或把 workflow 改成 qwen-image-2.1（只用自带节点）。` })
      }
    }
  }
  if (r.models) {
    if (r.models.missing.length === 0 && r.models.unsure.length === 0) items.push({ mark: '✓', text: '模型文件齐全' })
    const miss = capList(r.models.missing)
    for (const m of miss.shown) {
      items.push({
        mark: '✗', text: `缺少模型 ${clip(m.file)}${m.dir ? `，放到 ComfyUI/models/${clip(m.dir)}/` : ''}`,
        ...(m.url ? { url: m.url } : {}),
      })
    }
    if (miss.more) items.push({ mark: '✗', text: `缺少模型${miss.more}` })
    const unsure = capList(r.models.unsure)
    for (const f of unsure.shown) items.push({ mark: '?', text: `无法确认模型 ${clip(f)}` })
    if (unsure.more) items.push({ mark: '?', text: `无法确认模型${unsure.more}` })
  }
  const t = r.trial
  if (t?.status === 'ok') items.push({ mark: '✓', text: `试出图成功，用时 ${t.seconds} 秒：${t.path}` })
  else if (t?.status === 'failed') items.push({ mark: '✗', text: `试出图失败（${DOCTOR_FAIL_TEXT[t.kind]}）` })
  else if (t?.status === 'skipped') items.push({ mark: '', text: '前面有未通过的项，没有试出图。' })
  problems()
  return items
}

/** 没有提问服务时的降级：全部项压成一行，用"；"连接。 */
export function drawDoctorOneLine(r: DrawDoctorReport): string {
  return drawDoctorItems(r)
    .flatMap((i) => [`${i.mark ? `${i.mark} ` : ''}${i.text}`, ...(i.url ? [`下载地址：${i.url}`] : [])])
    .join('；')
}

const SAFE_LINK = /^https?:\/\/[^\s()<>`]+$/

const mdText = (s: string): string => s.replace(/[`*_\[\]<>|\\]/g, (c) => `\\${c}`)

/** 卡片里的完整报告：Markdown 列表，一项一行，下载地址是可点击的链接。 */
export function drawDoctorMarkdown(r: DrawDoctorReport): string {
  return drawDoctorItems(r)
    .map((i) => {
      let line = `- ${i.mark ? `${i.mark} ` : ''}${mdText(i.text)}`
      if (i.url) line += SAFE_LINK.test(i.url) ? `\n  - [下载地址](${i.url})` : `\n  - 下载地址：${mdText(i.url)}`
      return line
    })
    .join('\n')
}

export interface DrawDoctorBrief {
  /** 如 `可用`、`未配置`、`不可用：连不上 10.0.0.1:8188 等 2 项` */
  status: string
  /** 括注里的提示 */
  notes: string[]
  /** 是否需要在行末提示"看详情" */
  flagged: boolean
}

/** 一行小结（不含"生图 "前缀）。 */
export function drawDoctorBrief(r: DrawDoctorReport): DrawDoctorBrief {
  if (!r.configured) return { status: '未配置', notes: [], flagged: true }
  const issues = drawDoctorIssues(r)
  if (issues.length > 0) {
    const more = issues.length > 1 ? ` 等 ${issues.length} 项` : ''
    return { status: `不可用：${issues[0]}${more}`, notes: [], flagged: true }
  }
  const notes: string[] = []
  if (r.problems.length > 0) notes.push(`配置有 ${r.problems.length} 处写法不对`)
  if ((r.models?.unsure.length ?? 0) > 0) notes.push(`有 ${r.models!.unsure.length} 个模型无法确认`)
  return { status: '可用', notes, flagged: notes.length > 0 }
}

/** 检查后会话画图能力与小结不一致时的括注。 */
export function drawSessionNote(briefOk: boolean, available: boolean, reason: string): string | null {
  if (available === briefOk) return null
  if (available) return '这个会话可以画图'
  return reason === 'readonly' ? '这个会话只读，不能画图' : `这个会话不能画图：${unavailableWhy(reason)}`
}

/** 拼成放进状态行的片段：`生图 可用（…）`。 */
export function drawBriefText(b: DrawDoctorBrief, sessionNote: string | null = null): string {
  const notes = sessionNote ? [...b.notes, sessionNote] : b.notes
  return `生图 ${b.status}${notes.length > 0 ? `（${notes.join('；')}）` : ''}`
}

/** 卡片自检结束的一行回执。 */
export function drawDoctorCardReceipt(r: DrawDoctorReport): Reply {
  const t = r.trial
  if (t?.status === 'ok') return guide(`生图自检：全部通过，试出图成功（${t.seconds} 秒）。`)
  if (t?.status === 'failed') return guide(`生图自检：全部通过，试出图失败（${DOCTOR_FAIL_TEXT[t.kind]}）。`)
  const n = drawDoctorIssues(r).length
  return guide(n === 0 ? '生图自检：全部通过。' : `生图自检：${n} 项未通过。`)
}

export const DOCTOR_CANCELLED_TEXT = '自检已取消。'
export const DOCTOR_CARD_BUSY_TEXT = '有一张卡片还没回答，先处理它再自检。'

/** 试出图结果卡片的正文（Markdown）。 */
export function drawTrialMarkdown(t: NonNullable<DrawDoctorReport['trial']>): string {
  if (t.status === 'ok') {
    // 卡片不渲染图片（实测只显示替代文字），所以只给路径
    return `- ✓ 试出图成功，用时 ${t.seconds} 秒\n- 图片存在：\`${t.path.replace(/`/g, "'")}\`\n- 可以打开这个文件看看效果；它在系统临时目录里，不用管它`
  }
  if (t.status === 'failed') return `- ✗ 试出图失败（${DOCTOR_FAIL_TEXT[t.kind]}）`
  return '- 前面有未通过的项，没有试出图。'
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

// ---------- 角色命令的回执 ----------

const CARD_PROBLEM: Record<string, string> = {
  'file-missing': '文件不存在',
  'yaml-invalid': '格式解析失败',
  'missing-required': '缺少必填栏',
  'missing-id': '缺少编号',
  unreadable: '读不出来',
}

/** 角色命令不带名字：请掌柜听用户描述。 */
export function cardAskReceipt(theme: Theme): Reply {
  return guide(`${theme.host().name}正在等你描述想要的${theme.concept('character')}。`)
}

/** 角色命令带名字且匹配到好卡：请掌柜进入修改流程。 */
export function cardEditReceipt(theme: Theme, name: string): Reply {
  return guide(`${theme.host().name}正在看「${name}」的${theme.concept('card')}。`)
}

export function cardAmbiguousReceipt(theme: Theme, names: readonly string[]): Reply {
  return guide(`有好几个${theme.concept('character')}都对得上：${names.join('、')}。请把名字写全一些再试。`)
}

/** 角色命令带名字但没有同名角色：按新建处理，名字用它。 */
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

// ---------- 语音命令的回执 ----------

export const VOICE_USAGE_TEXT = '用法：`/aha 语音 启动`、`/aha 语音 停止`、`/aha 语音 状态`（不带参数等同状态）。'
export const VOICE_CARD_BUSY_TEXT = '有一张卡片还没回答，先处理它再启动语音服务。'

export function voiceNotConfiguredReceipt(): Reply {
  return guide('还没有配置语音服务，配置方法见 docs/voice-setup.md。')
}

export function voiceUserInfoReceipt(): Reply {
  return guide('语音服务地址里不能带用户名或密码，请去掉后再试。')
}

export function voiceAlreadyRunningReceipt(ours: boolean): Reply {
  return guide(ours ? '语音服务已在运行。' : '语音服务已在运行（不是由插件启动的）。')
}

export function voiceSelfLaunchReceipt(why: 'launch' | 'platform'): Reply {
  return guide(
    why === 'launch'
      ? '配置里的 launch 不是 mlx，插件不会代为启动，请自己启动语音服务。'
      : '这台机器不是苹果芯片的 Mac，插件不能代为启动，请自己启动语音服务。',
  )
}

export function voiceNoUvReceipt(): Reply {
  return guide('没有找到 uv，请先安装 uv（见 docs/voice-setup.md）再启动。')
}

export function voiceBusyReceipt(): Reply {
  return guide('语音服务正在启动中，请稍候。')
}

export function voiceNeedsCardReceipt(): Reply {
  return guide('启动前要先安装运行环境或下载模型，需要你确认，请在界面里操作。')
}

export function voiceDeclinedReceipt(): Reply {
  return guide('已取消，什么都没有安装。')
}

export function voiceCancelledReceipt(): Reply {
  return guide('语音服务的启动已取消。')
}

export function voiceStartedReceipt(model: string, modelsDir: string): Reply {
  return guide(`语音服务已启动，模型 ${model}，权重目录 ${modelsDir}。`)
}

/** 确认卡片：要装的环境与要下的模型。已装好、已下载的项传 null 不列出。 */
export interface VoiceCardInfo {
  env: boolean
  model: { name: string; size: string } | null
  modelsDir: string
  hfEndpoint: string | undefined
}

export const VOICE_ENV_SIZE = '约 0.5GB'
export const VOICE_MEMORY_NOTE = '加载模型时内存占用峰值约 9GB。'
export const VOICE_CARD_HEADER = '语音服务'
export const VOICE_CARD_QUESTION = '启动语音服务前需要先准备下面这些，现在开始吗？'
export const VOICE_OPT_GO = '开始'
export const VOICE_OPT_CANCEL = '取消'

export function voiceCardMarkdown(c: VoiceCardInfo): string {
  const lines: string[] = []
  if (c.env) lines.push(`- 运行环境（${VOICE_ENV_SIZE}）`)
  if (c.model) lines.push(`- 模型 ${c.model.name}（${c.model.size}）`)
  lines.push(`- 存放目录：${c.modelsDir}`)
  lines.push(`- 下载源：${c.hfEndpoint ?? '官方'}`)
  lines.push('', VOICE_MEMORY_NOTE)
  return lines.join('\n')
}

const INSTALL_FAIL: Record<string, string> = {
  network: '安装运行环境时网络不通，请检查网络后重试。',
  unsupported: '这台机器不是苹果芯片的 Mac，插件不能代为安装。',
  'no-uv': '没有找到 uv，请先安装 uv（见 docs/voice-setup.md）。',
  failed: '安装运行环境失败，详情见语音目录下的 server.log。',
}

export function voiceInstallFailedReceipt(kind: string): Reply {
  return fail(INSTALL_FAIL[kind] ?? INSTALL_FAIL.failed!)
}

const START_FAIL: Record<string, string> = {
  unsupported: '这台机器不是苹果芯片的 Mac，插件不能代为启动。',
  'not-installed': '运行环境还没装好，请重新启动一次。',
  occupied: '端口已被别的服务占用（不是由插件启动的），请换一个端口或先关掉它。',
  timeout: '等待语音服务启动超时，详情见语音目录下的 server.log。',
  exited: '语音服务启动后马上退出了，详情见语音目录下的 server.log。',
  failed: '语音服务启动失败，详情见语音目录下的 server.log。',
}

export function voiceStartFailedReceipt(kind: string): Reply {
  return fail(START_FAIL[kind] ?? START_FAIL.failed!)
}

const WARMUP_FAIL: Record<string, string> = {
  unreachable: '服务连不上',
  timeout: '等待超时',
  'bad-response': '服务返回了无法使用的结果',
  other: '未知原因',
}

export function voiceWarmupFailedReceipt(kind: string, modelsDir: string): Reply {
  return fail(`语音服务已启动，但模型加载失败：${WARMUP_FAIL[kind] ?? WARMUP_FAIL.other}。详情见 ${modelsDir}/server.log。`)
}

/** 启动的三个阶段，回执与状态里都用这些名字。 */
export type VoiceStage = 'install' | 'start' | 'warmup'
export const VOICE_STAGE_NAME: Record<VoiceStage, string> = {
  install: '安装运行环境',
  start: '启动服务',
  warmup: '下载并加载模型',
}

/** 启动转入后台后的回执。 */
export function voiceStartingReceipt(stage: VoiceStage): Reply {
  return guide(`语音服务正在启动（${VOICE_STAGE_NAME[stage]}），用 /aha 语音 状态 查看进度。`)
}

export function voiceProgressReceipt(stage: VoiceStage, seconds: number): Reply {
  return guide(`语音服务正在启动：${VOICE_STAGE_NAME[stage]}，已用 ${seconds} 秒。`)
}

export function voiceLastFailedReceipt(reason: string, modelsDir: string): Reply {
  return guide(`上次启动失败：${reason}（日志 ${modelsDir}/server.log）。`)
}

const INSTALL_REASON: Record<string, string> = {
  network: '安装运行环境时网络不通', unsupported: '这台机器不是苹果芯片的 Mac', 'no-uv': '没有找到 uv', busy: '已有安装或启动在进行',
}
const START_REASON: Record<string, string> = {
  unsupported: '这台机器不是苹果芯片的 Mac', 'not-installed': '运行环境没装好', occupied: '端口被别的服务占用',
  timeout: '等待服务启动超时', exited: '服务启动后马上退出', busy: '已有安装或启动在进行',
}

/** 状态里"上次启动失败"的简短原因。 */
export function voiceFailureReason(stage: VoiceStage, kind: string): string {
  if (stage === 'warmup') return `服务已启动，但模型加载失败：${WARMUP_FAIL[kind] ?? WARMUP_FAIL.other}`
  if (stage === 'install') return INSTALL_REASON[kind] ?? '安装运行环境失败'
  return START_REASON[kind] ?? '服务启动失败'
}

export function voiceStopReceipt(status: 'stopped' | 'not-ours' | 'not-running'): Reply {
  switch (status) {
    case 'stopped':
      return guide('语音服务已停止。')
    case 'not-ours':
      return guide('这是外部启动的服务，插件不会停它。')
    case 'not-running':
      return guide('语音服务没有在运行。')
  }
}

export interface VoiceStatusInfo {
  reachable: boolean
  ours: boolean
  busy: boolean
  /** 配置的模型（简称或名字）。 */
  model: string
  /** 服务里是否已加载所配模型；查不到为 null。 */
  loaded: boolean | null
}

export function voiceStatusReceipt(s: VoiceStatusInfo): Reply {
  if (!s.reachable) return guide(s.busy ? '语音服务：正在启动中。' : '语音服务：未启动。')
  const who = s.ours ? '由插件启动' : '外部启动'
  const model = s.loaded === null ? '' : s.loaded ? `，模型 ${s.model}` : `，模型尚未加载（配置为 ${s.model}）`
  return guide(`语音服务：已在运行（${who}）${model}${s.busy ? '，正在启动中' : ''}。`)
}

export function voiceStatusNotConfiguredReceipt(): Reply {
  return guide('语音服务：未配置（见 docs/voice-setup.md）。')
}

// ---------- 朗读 ----------

/** 朗读开始不了的原因；检查按这个顺序进行。 */
export type SpeakBlock = 'not-configured' | 'user-info' | 'unreachable' | 'starting' | 'no-voice' | 'no-player'

/** 不能朗读的原因，一句话、不带句号；回执与"自动朗读已打开"的补充说明共用。 */
export function speakBlockReason(block: SpeakBlock, theme: Theme): string {
  switch (block) {
    case 'not-configured':
      return '还没有配置语音服务，配置方法见 docs/voice-setup.md'
    case 'user-info':
      return '语音服务地址里不能带用户名或密码，请去掉后再试'
    case 'unreachable':
      return '语音服务连不上，可以用 /aha 语音 启动'
    case 'starting':
      return '语音服务还在启动中，稍后再试'
    case 'no-voice':
      return `这个${theme.concept('character')}还没有声音，请到「${MODE_LABEL.setup}」给它配声音`
    case 'no-player':
      return '没有找到播放器（macOS 需要 afplay，其他系统需要 ffplay、paplay 或 aplay 之一）'
  }
}

export function speakBlockedReceipt(block: SpeakBlock, theme: Theme): Reply {
  return guide(`${speakBlockReason(block, theme)}。`)
}

export function speakStartedReceipt(count: number, truncated: boolean): Reply {
  return guide(`开始朗读，共 ${count} 句${truncated ? '，超出的部分没有念' : ''}。`)
}

export function speakNothingReceipt(): Reply {
  return guide('没有可念的字。')
}

export function speakNoReplyReceipt(): Reply {
  return guide('这场聊天里还没有角色的话可念。')
}

export function speakStoppedReceipt(): Reply {
  return guide('已停止朗读。')
}

export function autoReadOnReceipt(block: SpeakBlock | null, theme: Theme): Reply {
  return guide(block === null ? '自动朗读已打开。' : `自动朗读已打开；现在还念不了：${speakBlockReason(block, theme)}。`)
}

export function autoReadOffReceipt(): Reply {
  return guide('自动朗读已关闭。')
}

export function autoReadReadonlyReceipt(theme: Theme): Reply {
  return guide(`这间${theme.concept('tavern')}的数据比插件新，不能改自动朗读的开关；朗读本身可以用。`)
}

// ---------- 登记音色 ----------

export const VOICE_SET_QUESTION_ID = 'voice-replace'
export const VOICE_SET_OPT_REPLACE = '覆盖'
export const VOICE_SET_OPT_CANCEL = '取消'

/** 角色已有音色时的覆盖确认卡片；名字由调用方先压平、去掉引号类符号。 */
export function voiceReplaceQuestion(name: string): AskItem {
  return {
    id: VOICE_SET_QUESTION_ID,
    header: '角色音色',
    question: `给「${name}」换一个声音？`,
    detail: `角色「${name}」已经有音色了，登记新的录音会替换现有的声音。`,
    options: [
      { label: VOICE_SET_OPT_REPLACE, description: '用新的录音替换现有的声音' },
      { label: VOICE_SET_OPT_CANCEL, description: '保留现有的声音，不登记' },
    ],
  }
}
