// 语音朗读的取字与切句：把角色的一条回复变成要念的句子列表（规格 3.3）。
// 纯函数，与宿主无关；字数一律按 Unicode 码点计。

/** 念哪些字：lines 去掉动作描写，all 只去图片行与 Markdown 标记。 */
export type SpeechReadMode = 'lines' | 'all'

/** 单句字数上限默认值。 */
export const DEFAULT_MAX_SENTENCE_CHARS = 80
/** 同一段里相邻两句的固定停顿（秒）；与可配置的段间停顿无关。 */
export const INLINE_PAUSE_SECONDS = 0.5
/** 段间停顿的基准字数：被跳过的字数等于它时，停顿正好是设置的 pauseSeconds。 */
export const PAUSE_BASE_CHARS = 12
/** 只有段落分界、没有被跳过的文字时，按这么多字算。 */
export const PARAGRAPH_PAUSE_CHARS = 4
/** 一次朗读字数上限默认值。 */
export const DEFAULT_MAX_TOTAL_CHARS = 1000
/** 短句合并阈值：不足该字数的句子并入相邻句。 */
export const MIN_SENTENCE_CHARS = 6

export interface SplitOptions {
  /** 单句上限，默认 80。 */
  maxChars?: number
}

export interface SpeechPlanOptions extends SplitOptions {
  mode: SpeechReadMode
  /** 一次朗读的总字数上限，默认 1000。 */
  maxTotal?: number
}

/**
 * 一句话与上一句之间的间隔种类。
 * none：第一句，前面没有；break：原文里隔着没念出来的文字或段落分界；inline：同一段连续要念的话里相邻的两句。
 */
export type SpeechGap = 'none' | 'break' | 'inline'

export interface SpeechPlan {
  sentences: string[]
  /** 与 sentences 等长：每句之前的间隔种类。 */
  gaps: SpeechGap[]
  /** 与 sentences 等长：这句与上一句之间被跳过没念的字数（不计空白与标点）；inline 与第一句为 0，只换段也是 0。 */
  skipped: number[]
  /** 总字数超限，后面的句子没有念。 */
  truncated: boolean
}

const len = (s: string): number => [...s].length

// 图片行：![说明](路径) 或 ![说明](<含空格的路径>)
const IMAGE_RE = /!\[[^\]]*\]\((?:<[^>]*>|[^)\n]*)\)/g
const OPENERS = '（(【'
const CLOSERS = '）)】'

/**
 * 内部标记：取字时被删掉的文字所在的位置。用一个私有区字符（U+E000 起）表示，
 * 偏移量就是被删文字的字数（不计空白与标点），正文里不会出现这个区间的字符。
 */
const MARK_BASE = 0xe000
const MARK_MAX = 0x18ff
const MARK_CLASS = '\\uE000-\\uF8FF'
const isMark = (c: string): boolean => c >= '\uE000' && c <= '\uF8FF'
const countSpoken = (s: string): number => (s.match(/[^\s\p{P}\p{S}]/gu) ?? []).length
const markFor = (removed: string): string => String.fromCharCode(MARK_BASE + Math.min(countSpoken(removed), MARK_MAX))
/** 取字时不留标记（speakableText 用）。 */
const NO_MARK = (): string => ''

/** 删除成对括号及其内容（原处换成 mark）；嵌套按最外层删，没有闭合的括号原样保留。 */
function removeBracketed(text: string, mark: (removed: string) => string): string {
  const chars = [...text]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? ''
    if (!OPENERS.includes(c)) {
      out += c
      continue
    }
    let depth = 0
    let end = -1
    for (let j = i; j < chars.length; j++) {
      const cj = chars[j] ?? ''
      if (OPENERS.includes(cj)) depth++
      else if (CLOSERS.includes(cj) && --depth === 0) {
        end = j
        break
      }
    }
    if (end < 0) out += c
    else {
      out += mark(chars.slice(i, end + 1).join(''))
      i = end
    }
  }
  return out
}

/** 行首的块级标记：标题、引用、列表、分隔线。 */
function stripBlockMarks(line: string): string {
  if (/^\s*([-*_]\s*){3,}$/.test(line)) return ''
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:>\s?)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
}

/** 行内的 Markdown 标记：链接只留文字，去掉强调与反引号。 */
function stripInlineMarks(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
}

/**
 * 按规格 3.3 取出可念的字。
 * 两种模式都去图片行与 Markdown 标记；lines 另删单星号动作、成对括号及其内容。
 */
export function speakableText(reply: string, mode: SpeechReadMode): string {
  return extractText(reply, mode, NO_MARK)
}

/** 取字；被删掉的动作与括号内容原处换成 mark（mark 为空就是直接删）。 */
function extractText(reply: string, mode: SpeechReadMode, mark: (removed: string) => string): string {
  let text = reply.replace(IMAGE_RE, '')
  text = text.split(/\r?\n/).map(stripBlockMarks).join('\n')
  if (mode === 'lines') {
    // 单星号包起来的是动作；双星号是强调，留给后面只去符号
    text = text.replace(/(?<!\*)\*(?![\s*])[^*\n]*?(?<![\s*])\*(?!\*)/g, (m) => mark(m))
    text = removeBracketed(text, mark)
  }
  return text
    .split('\n')
    .map((line) => stripInlineMarks(line).replace(/[ \t　]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

const hasSpeech = (s: string): boolean => /[\p{L}\p{N}]/u.test(s)

/** 并入相邻句时，两侧都是 ASCII 字符才补一个空格。 */
function joinPieces(a: string, b: string): string {
  const x = a.charCodeAt(a.length - 1)
  const y = b.charCodeAt(0)
  return x > 32 && x < 128 && y > 32 && y < 128 ? `${a} ${b}` : a + b
}

/** 超长句：先在逗号、顿号、分号处切，仍超长就硬切。 */
function splitLong(sentence: string, max: number): string[] {
  if (len(sentence) <= max) return [sentence]
  const tokens = sentence.match(/[^，,、；;]+[，,、；;]*|[，,、；;]+/g) ?? [sentence]
  const out: string[] = []
  let cur = ''
  const flush = (): void => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const tok of tokens) {
    if (len(cur) + len(tok) <= max) {
      cur += tok
      continue
    }
    flush()
    if (len(tok) <= max) {
      cur = tok
    } else {
      const cps = [...tok]
      for (let i = 0; i < cps.length; i += max) out.push(cps.slice(i, i + max).join(''))
    }
  }
  flush()
  return out
}

interface GappedSentence {
  text: string
  /** 与上一句之间的间隔；第一句的值没有意义。 */
  gap: 'break' | 'inline'
  /** 与上一句之间被跳过的字数。 */
  skipped: number
}

/** 切句并记下每句与上一句之间隔着什么；规则见 splitSentences。 */
function splitWithGaps(text: string, options: SplitOptions): GappedSentence[] {
  const max = Math.max(1, options.maxChars ?? DEFAULT_MAX_SENTENCE_CHARS)
  // 句末标点连同紧跟的收尾引号、括号留在本句；换行与"被删文字"标记也是边界
  const re = new RegExp(`[^。！？!?…\\n${MARK_CLASS}]*[。！？!?…]+[”’"'」』）)】]*|[^。！？!?…\\n${MARK_CLASS}]+`, 'g')
  const pieces: GappedSentence[] = []
  let prevEnd = -1
  for (const m of text.matchAll(re)) {
    const piece = m[0].trim()
    if (!hasSpeech(piece)) continue
    const between = prevEnd < 0 ? '' : text.slice(prevEnd, m.index)
    const marks = [...between].filter(isMark)
    const skipped = marks.reduce((sum, c) => sum + c.charCodeAt(0) - MARK_BASE, 0)
    const isBreak = prevEnd < 0 || between.includes('\n') || marks.length > 0
    pieces.push({ text: piece, gap: isBreak ? 'break' : 'inline', skipped: prevEnd < 0 ? 0 : skipped })
    prevEnd = m.index + m[0].length
  }

  // 短句并入相邻句，但不跨过 break：停顿比凑够字数重要
  const merged: GappedSentence[] = []
  let pending: GappedSentence | null = null
  const settle = (p: GappedSentence): void => {
    const last = merged[merged.length - 1]
    if (last && p.gap === 'inline') last.text = joinPieces(last.text, p.text)
    else merged.push(p)
  }
  for (const p of pieces) {
    if (pending && p.gap === 'break') {
      settle(pending)
      pending = null
    }
    pending = pending ? { text: joinPieces(pending.text, p.text), gap: pending.gap, skipped: pending.skipped } : p
    if (len(pending.text) >= MIN_SENTENCE_CHARS) {
      merged.push(pending)
      pending = null
    }
  }
  if (pending) settle(pending)
  return merged.flatMap((s) =>
    splitLong(s.text, max).map((t, i): GappedSentence =>
      (i === 0 ? { text: t, gap: s.gap, skipped: s.skipped } : { text: t, gap: 'inline', skipped: 0 })))
}

/** 切句：按 。！？!?… 和换行切，标点留在句尾；短句并入相邻句（不跨段）；超长句再切。 */
export function splitSentences(text: string, options: SplitOptions = {}): string[] {
  return splitWithGaps(text, options).map((s) => s.text)
}

/** 把一条回复变成要念的句子；总字数超限时截到最后一个完整句子。 */
export function planSpeech(reply: string, options: SpeechPlanOptions): SpeechPlan {
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL_CHARS
  const all = splitWithGaps(extractText(reply, options.mode, markFor), options)
  const sentences: string[] = []
  const gaps: SpeechGap[] = []
  const skipped: number[] = []
  let total = 0
  for (const s of all) {
    if (total + len(s.text) > maxTotal) return { sentences, gaps, skipped, truncated: true }
    sentences.push(s.text)
    gaps.push(sentences.length === 1 ? 'none' : s.gap)
    skipped.push(sentences.length === 1 ? 0 : s.skipped)
    total += len(s.text)
  }
  return { sentences, gaps, skipped, truncated: false }
}

/** 段间停顿的三个设置值（秒）。 */
export interface PauseRange {
  /** 基准：被跳过的字数为 PAUSE_BASE_CHARS 时的停顿；0 表示不停 */
  pause: number
  /** 最短：字很少时向它靠近 */
  min: number
  /** 最长：字很多时向它靠近 */
  max: number
}

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback)

/**
 * 段间停顿（秒）：随两段话之间被跳过的字数 n 平滑变化。
 * 在 [min, max] 之间走指数曲线，n 等于 PAUSE_BASE_CHARS 时正好是 pause；n 为 0（只是换段）按 PARAGRAPH_PAUSE_CHARS 个字算。
 * pause 不大于 0 或不是有限数时不停；min/max 不满足 min ≤ pause ≤ max 时按 pause 收拢；曲线退化（两端相等或 pause 在端点）时返回 pause。
 */
export function breakPauseSeconds(skippedChars: number, range: PauseRange): number {
  const pause = finiteOr(range.pause, 0)
  if (pause <= 0) return 0
  const lo = Math.min(finiteOr(range.min, pause), pause)
  const hi = Math.max(finiteOr(range.max, pause), pause)
  if (hi <= lo || pause <= lo || pause >= hi) return pause
  const m = skippedChars > 0 && Number.isFinite(skippedChars) ? skippedChars : PARAGRAPH_PAUSE_CHARS
  const k = -Math.log(1 - (pause - lo) / (hi - lo)) / PAUSE_BASE_CHARS
  return Math.max(lo, Math.min(hi, lo + (hi - lo) * (1 - Math.exp(-k * m))))
}
