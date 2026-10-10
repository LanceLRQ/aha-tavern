// 语音朗读的取字与切句：把角色的一条回复变成要念的句子列表（规格 3.3）。
// 纯函数，与宿主无关；字数一律按 Unicode 码点计。

/** 念哪些字：lines 去掉动作描写，all 只去图片行与 Markdown 标记。 */
export type SpeechReadMode = 'lines' | 'all'

/** 单句字数上限默认值。 */
export const DEFAULT_MAX_SENTENCE_CHARS = 80
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
  /** 总字数超限，后面的句子没有念。 */
  truncated: boolean
}

const len = (s: string): number => [...s].length

// 图片行：![说明](路径) 或 ![说明](<含空格的路径>)
const IMAGE_RE = /!\[[^\]]*\]\((?:<[^>]*>|[^)\n]*)\)/g
const OPENERS = '（(【'
const CLOSERS = '）)】'

/** 内部标记：取字时被删掉的文字所在的位置（私有区字符，正文里不会出现）。 */
const SKIPPED = '\uE000'

/** 删除成对括号及其内容（原处换成 mark）；嵌套按最外层删，没有闭合的括号原样保留。 */
function removeBracketed(text: string, mark: string): string {
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
      out += mark
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
  return extractText(reply, mode, '')
}

/** 取字；被删掉的动作与括号内容原处换成 mark（mark 为空就是直接删）。 */
function extractText(reply: string, mode: SpeechReadMode, mark: string): string {
  let text = reply.replace(IMAGE_RE, '')
  text = text.split(/\r?\n/).map(stripBlockMarks).join('\n')
  if (mode === 'lines') {
    // 单星号包起来的是动作；双星号是强调，留给后面只去符号
    text = text.replace(/(?<!\*)\*(?![\s*])[^*\n]*?(?<![\s*])\*(?!\*)/g, mark)
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
}

/** 切句并记下每句与上一句之间隔着什么；规则见 splitSentences。 */
function splitWithGaps(text: string, options: SplitOptions): GappedSentence[] {
  const max = Math.max(1, options.maxChars ?? DEFAULT_MAX_SENTENCE_CHARS)
  // 句末标点连同紧跟的收尾引号、括号留在本句；换行与"被删文字"标记也是边界
  const re = /[^。！？!?…\n\uE000]*[。！？!?…]+[”’"'」』）)】]*|[^。！？!?…\n\uE000]+/g
  const pieces: GappedSentence[] = []
  let prevEnd = -1
  for (const m of text.matchAll(re)) {
    const piece = m[0].trim()
    if (!hasSpeech(piece)) continue
    const between = prevEnd < 0 ? '' : text.slice(prevEnd, m.index)
    pieces.push({ text: piece, gap: prevEnd < 0 || between.includes('\n') || between.includes(SKIPPED) ? 'break' : 'inline' })
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
    pending = pending ? { text: joinPieces(pending.text, p.text), gap: pending.gap } : p
    if (len(pending.text) >= MIN_SENTENCE_CHARS) {
      merged.push(pending)
      pending = null
    }
  }
  if (pending) settle(pending)
  return merged.flatMap((s) =>
    splitLong(s.text, max).map((t, i): GappedSentence => ({ text: t, gap: i === 0 ? s.gap : 'inline' })))
}

/** 切句：按 。！？!?… 和换行切，标点留在句尾；短句并入相邻句（不跨段）；超长句再切。 */
export function splitSentences(text: string, options: SplitOptions = {}): string[] {
  return splitWithGaps(text, options).map((s) => s.text)
}

/** 把一条回复变成要念的句子；总字数超限时截到最后一个完整句子。 */
export function planSpeech(reply: string, options: SpeechPlanOptions): SpeechPlan {
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL_CHARS
  const all = splitWithGaps(extractText(reply, options.mode, SKIPPED), options)
  const sentences: string[] = []
  const gaps: SpeechGap[] = []
  let total = 0
  for (const s of all) {
    if (total + len(s.text) > maxTotal) return { sentences, gaps, truncated: true }
    sentences.push(s.text)
    gaps.push(sentences.length === 1 ? 'none' : s.gap)
    total += len(s.text)
  }
  return { sentences, gaps, truncated: false }
}
