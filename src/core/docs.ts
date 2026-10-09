// 主角档案 me.md 与世界观 world.md 的读写。
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from './fsx'

export const ME_FILE = 'me.md'
export const WORLD_FILE = 'world.md'

/** 按 Unicode 字符数计数（不是字节数，也不是 UTF-16 长度）。 */
export function countChars(text: string): number {
  return [...text].length
}

export interface DocContent {
  /** 文件是否存在 */
  exists: boolean
  /** 原文；不存在时为空串 */
  text: string
  /** 字数 */
  length: number
  /** 不存在或只有空白 */
  empty: boolean
}

async function readDoc(tavernDir: string, file: string): Promise<DocContent> {
  let text = ''
  let exists = true
  try {
    text = await fs.readFile(path.join(tavernDir, file), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    exists = false
  }
  return { exists, text, length: countChars(text), empty: text.trim() === '' }
}

async function writeDoc(tavernDir: string, file: string, text: string): Promise<number> {
  await atomicWrite(path.join(tavernDir, file), text)
  return countChars(text)
}

export const readMe = (tavernDir: string) => readDoc(tavernDir, ME_FILE)
export const readWorld = (tavernDir: string) => readDoc(tavernDir, WORLD_FILE)
/** 返回写入后的字数。 */
export const writeMe = (tavernDir: string, text: string) => writeDoc(tavernDir, ME_FILE, text)
export const writeWorld = (tavernDir: string, text: string) => writeDoc(tavernDir, WORLD_FILE, text)
