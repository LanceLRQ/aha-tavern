// 三期写书 B 层的原料（规格 §9）：按小说节引用的顺序读整理稿小节，
// 图片引用换回 [插图N] 占位符（写回时原样还原：novel/ 与 draft/ 同深度，相对路径不变）。
import { readSection } from './book'
import { fingerprintOf } from './book-source'
import { countChars } from './docs'

export function extractImages(body: string, startAt = 1): { text: string; images: Array<{ n: number; file: string }> } {
  const images: Array<{ n: number; file: string }> = []
  const text = body.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_all, file: string) => {
    const n = startAt + images.length
    images.push({ n, file })
    return `[插图${n}]`
  })
  return { text, images }
}

export type NovelSourceResult =
  | { ok: true; text: string; images: Array<{ n: number; file: string }>; chars: number; fingerprint: string }
  | { ok: false; error: string }

/** 错误文字是给模型看的英文固定标识。 */
export async function assembleNovelSource(bookDir: string, from: readonly string[]): Promise<NovelSourceResult> {
  const parts: string[] = []
  const images: Array<{ n: number; file: string }> = []
  for (const key of from) {
    const s = await readSection(bookDir, key)
    if (!s) return { ok: false, error: `draft section ${key} is not written` }
    const ex = extractImages(s.body.trim(), images.length + 1)
    images.push(...ex.images)
    parts.push(`【整理稿 ${key}】\n${ex.text}`)
  }
  const text = parts.join('\n\n')
  return { ok: true, text, images, chars: countChars(text), fingerprint: fingerprintOf(text) }
}
