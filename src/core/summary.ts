// 群聊梗概 summary.md 的渲染与解析（二期规格 §10.2）：按场景分段，收场后带标题与时间参与行。
// 文件是我们自己渲染的，解析按同一种格式尽力还原；解析不了的部分原样丢弃不抛错。

export interface SceneSection {
  /** 第几个场景，从 1 起 */
  index: number
  /** 小节标题；没有为 null（渲染成「## 场景一」） */
  title: string | null
  /** 在场角色名（不含 user；渲染时补「我」） */
  cast: string[]
  text: string
}

export interface ShowSummary {
  /** 一场的标题；收场前为 null（此时没有 # 头与时间参与行） */
  title: string | null
  started?: string
  participants?: string[]
  scenes: SceneSection[]
}

const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 序号转中文（场景数到二十几足够；再往后退回阿拉伯数字）。 */
export function sceneLabel(index: number): string {
  if (index >= 1 && index <= 10) return NUMERALS[index - 1]!
  if (index > 10 && index < 20) return `十${NUMERALS[index - 11] ?? ''}`
  return String(index)
}

const castLine = (cast: readonly string[]): string => `在场：${[...cast, '我'].join('、')}`
const sceneHead = (s: SceneSection): string => `## 场景${sceneLabel(s.index)}${s.title ? `：${s.title}` : ''}`
/** 传入已去掉「## 」前缀的行。 */
const HEAD_RE = /^场景(.+?)(?:：|\s*$)/

function parseHead(line: string): number | null {
  const m = HEAD_RE.exec(line)
  if (!m) return null
  const word = (m[1] ?? '').trim()
  const byNumeral = NUMERALS.indexOf(word)
  if (byNumeral >= 0) return byNumeral + 1
  if (/^十[一二三四五六七八九]?$/.test(word)) {
    return word === '十' ? 10 : 11 + NUMERALS.indexOf(word.slice(1))
  }
  const n = Number(word)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 解析自己渲染的梗概文本；认不出的行按所在小节的正文保留。 */
export function parseSummaryText(text: string): ShowSummary {
  const show: ShowSummary = { title: null, scenes: [] }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let current: SceneSection | null = null
  let pendingTitle: string | null = null
  let inHeader = true
  for (const line of lines) {
    if (inHeader && line.startsWith('# ') && !line.startsWith('## ')) {
      pendingTitle = line.slice(2).trim() || null
      continue
    }
    if (inHeader && line.startsWith('时间：') && line.includes('参与：')) {
      const parts = line.split('参与：')
      show.started = (parts[0] ?? '').replace('时间：', '').trim() || undefined
      show.participants = (parts[1] ?? '').trim() ? (parts[1] ?? '').trim().split('、') : undefined
      continue
    }
    const head = line.startsWith('## ') ? parseHead(line.slice(3)) : null
    if (head !== null) {
      inHeader = false
      current = { index: head, title: null, cast: [], text: '' }
      const t = /^##[ \t]+场景.+?：(.*)$/.exec(line)
      if (t && (t[1] ?? '').trim() !== '') current.title = (t[1] ?? '').trim()
      show.scenes.push(current)
      continue
    }
    if (!inHeader && current && line.startsWith('在场：')) {
      current.cast = line.slice(3).replace('在场：', '').split('、').filter((n) => n !== '' && n !== '我')
      continue
    }
    if (!inHeader && current) current.text = current.text === '' ? line : `${current.text}\n${line}`
  }
  show.title = pendingTitle
  // 段间与段尾的空行不入正文
  show.scenes = show.scenes.map((s) => ({ ...s, text: s.text.trim() }))
  return show
}

export function renderSummaryText(show: ShowSummary): string {
  const parts: string[] = []
  if (show.title !== null) {
    parts.push(`# ${show.title}`)
    const when = show.started ?? ''
    const who = (show.participants ?? []).join('、')
    if (when !== '' || who !== '') parts.push(`时间：${when}　参与：${who}`)
    if (parts.length > 0) parts.push('')
  }
  show.scenes.forEach((s, i) => {
    parts.push(sceneHead(s))
    parts.push(castLine(s.cast))
    parts.push(s.text.trim())
    if (i < show.scenes.length - 1) parts.push('')
  })
  return `${parts.join('\n').trimEnd()}\n`
}

/** 追加或替换一个小节（同一序号替换；收场覆盖最后一段走这里）。 */
export function upsertScene(show: ShowSummary, scene: SceneSection): ShowSummary {
  const scenes = [...show.scenes]
  const at = scenes.findIndex((s) => s.index === scene.index)
  if (at >= 0) scenes[at] = scene
  else scenes.push(scene)
  return { ...show, scenes: scenes.sort((a, b) => a.index - b.index) }
}
