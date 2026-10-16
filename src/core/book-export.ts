// 三期写书的导出（规格 §8）：拼成一整本 Markdown，插图路径换算到导出文件所在目录。
import path from 'node:path'
import { sceneLabel } from './summary'

export interface ExportChapter {
  title: string
  /** body 为 null 表示这一节还没写 */
  sections: Array<{ title: string; body: string | null }>
}

export const UNWRITTEN = '（本节未写）'

export function renderBook(title: string, chapters: readonly ExportChapter[]): string {
  const out: string[] = [`# ${title}`]
  for (const c of chapters) {
    out.push(`## ${c.title}`)
    c.sections.forEach((s, i) => {
      out.push(`### （${sceneLabel(i + 1)}）${s.title}`)
      out.push(s.body === null ? UNWRITTEN : s.body.trim())
    })
  }
  return out.join('\n\n') + '\n'
}

/** 正文里 ![..](相对路径) 的路径从 fromDir 换算到 toDir；带协议或以 / 开头的不动。 */
export function rebaseImages(body: string, fromDir: string, toDir: string): string {
  return body.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (all, head: string, p: string, tail: string) => {
    if (/^[a-z]+:/i.test(p) || p.startsWith('/')) return all
    return `${head}${path.relative(toDir, path.resolve(fromDir, p)).split(path.sep).join('/')}${tail}`
  })
}
