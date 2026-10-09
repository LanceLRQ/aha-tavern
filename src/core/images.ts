// 生成图片的落盘与记录：图片存进聊天目录的 images/，参数追加到同目录的 images.jsonl。
import fs from 'node:fs/promises'
import path from 'node:path'
import { requireChatDir, findChatDir } from './chat'

export const IMAGES_DIR = 'images'
export const IMAGES_LOG_FILE = 'images.jsonl'

export type ImageOrientation = 'portrait' | 'landscape' | 'square'

export interface ImageRecord {
  n: number
  ts: string
  /** 相对聊天目录，如 images/001.png */
  file: string
  scene: string
  prompt: string
  seed: number
  width: number
  height: number
  steps: number
  workflow: string
  /** 重新生成时记被重画那张的 n，否则 null */
  redoOf: number | null
  /** 重新生成时沿用上一张的方向 */
  orientation: ImageOrientation
}

export type NewImageRecord = Omit<ImageRecord, 'n' | 'ts' | 'file'> & { ts?: string }

export interface SavedImage {
  n: number
  file: string
  absPath: string
  record: ImageRecord
}

const EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])

// 同进程内按 images.jsonl 的绝对路径排队：一次保存是"取编号、写图、追加"三步，不是整文件改写
const queues = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(task)
  queues.set(key, run)
  const clear = () => {
    if (queues.get(key) === run) queues.delete(key)
  }
  run.then(clear, clear)
  return run
}

function parseRecord(line: string): ImageRecord | null {
  try {
    const v = JSON.parse(line) as ImageRecord
    if (v && typeof v === 'object' && Number.isInteger(v.n) && v.n > 0) return v
  } catch {
    // 损坏行跳过
  }
  return null
}

async function readLast(logFile: string): Promise<ImageRecord | null> {
  let text: string
  try {
    text = await fs.readFile(logFile, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    const r = parseRecord(line)
    if (r) return r
  }
  return null
}

async function endsWithoutNewline(file: string): Promise<boolean> {
  let h: fs.FileHandle
  try {
    h = await fs.open(file, 'r')
  } catch {
    return false
  }
  try {
    const { size } = await h.stat()
    if (size === 0) return false
    const buf = Buffer.alloc(1)
    await h.read(buf, 0, 1, size - 1)
    return buf[0] !== 0x0a
  } finally {
    await h.close()
  }
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  )

/** 编号相同、扩展名不同的文件也算占用，免得 001.png 与 001.webp 并存。 */
async function isTaken(imagesDir: string, n: number): Promise<boolean> {
  const stem = String(n).padStart(3, '0')
  for (const e of EXTS) {
    if (await exists(path.join(imagesDir, `${stem}.${e}`))) return true
  }
  return false
}

export async function saveImage(
  tavernDir: string,
  chatId: string,
  bytes: Uint8Array,
  ext: string,
  record: NewImageRecord,
): Promise<SavedImage> {
  const chatDir = await requireChatDir(tavernDir, chatId)
  const logFile = path.join(chatDir, IMAGES_LOG_FILE)
  const imagesDir = path.join(chatDir, IMAGES_DIR)
  const safeExt = EXTS.has(ext) ? ext : 'png'

  return serialize(logFile, async () => {
    let n = ((await readLast(logFile))?.n ?? 0) + 1
    await fs.mkdir(imagesDir, { recursive: true })
    while (await isTaken(imagesDir, n)) n++

    const name = `${String(n).padStart(3, '0')}.${safeExt}`
    const absPath = path.join(imagesDir, name)
    const tmp = `${absPath}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, absPath)
    } catch (e) {
      await fs.rm(tmp, { force: true })
      throw e
    }

    // 逐个字段挑出来：调用方若把上一张的整条记录展开传入，旧的 n、file、ts 不能混进新记录
    const full: ImageRecord = {
      n,
      ts: record.ts ?? new Date().toISOString(),
      file: `${IMAGES_DIR}/${name}`,
      scene: record.scene,
      prompt: record.prompt,
      seed: record.seed,
      width: record.width,
      height: record.height,
      steps: record.steps,
      workflow: record.workflow,
      redoOf: record.redoOf,
      orientation: record.orientation,
    }
    const prefix = (await endsWithoutNewline(logFile)) ? '\n' : ''
    await fs.appendFile(logFile, prefix + JSON.stringify(full) + '\n', 'utf8')
    return { n, file: full.file, absPath, record: full }
  })
}

/** 最后一条可解析的记录；聊天目录不存在或没有记录返回 null。 */
export async function lastImage(tavernDir: string, chatId: string): Promise<ImageRecord | null> {
  const chatDir = await findChatDir(tavernDir, chatId)
  if (!chatDir) return null
  return readLast(path.join(chatDir, IMAGES_LOG_FILE))
}
