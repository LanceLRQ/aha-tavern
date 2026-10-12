// 定妆图与形象的数据层：默认形象（reference.png）、额外形象（looks/<编号>.png，登记在角色卡的 looks 栏）、
// 定妆候选（.look-drafts/）。入口都以"角色目录的绝对路径"为参数；不拼酒馆路径，不抛异常给调用方（保存与删除）。
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_LOOK, MAX_LOOKS, normalizeLookName, normalizeLookWhen, readCharacterLooks, updateCharacterLooks, type CardLook,
} from './card'
import { atomicWrite } from './fsx'
import { isLookId, newLookId } from './ids'

/** 默认形象的定妆图文件名（一期规格预留的名字）。 */
export const REFERENCE_FILE = 'reference.png'
/** 额外形象图所在目录，里面是 <形象编号>.png。 */
export const LOOKS_DIR = 'looks'
/** 定妆候选所在目录（点开头：导入与附件复制都会跳过）。 */
export const DRAFTS_DIR = '.look-drafts'
export const DRAFTS_LOG_FILE = 'drafts.jsonl'
/** 候选最多留几张，超出时删最早的。 */
export const MAX_DRAFTS = 20

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ---------- 读 ----------

export interface DefaultLookState {
  /** 绝对路径；不管在不在都给出 */
  file: string
  exists: boolean
}

export interface ExtraLookState extends CardLook {
  file: string
  exists: boolean
}

export interface LooksState {
  default: DefaultLookState
  extras: ExtraLookState[]
}

const isFile = (p: string): Promise<boolean> =>
  fs.stat(p).then((st) => st.isFile(), () => false)

const defaultFile = (charDir: string) => path.join(charDir, REFERENCE_FILE)
const lookFile = (charDir: string, id: string) => path.join(charDir, LOOKS_DIR, `${id}.png`)

/** 这个角色有哪些形象：默认形象看 reference.png 在不在，额外形象以角色卡的 looks 为准。卡读不出来时额外形象按没有。 */
export async function readLooks(charDir: string): Promise<LooksState> {
  const dFile = defaultFile(charDir)
  const cardLooks = (await readCharacterLooks(charDir)) ?? []
  const extras = await Promise.all(
    cardLooks.map(async (l) => {
      const file = lookFile(charDir, l.id)
      return { ...l, file, exists: await isFile(file) }
    }),
  )
  return { default: { file: dFile, exists: await isFile(dFile) }, extras }
}

export type ResolveLookResult =
  | { ok: true; look: string; file: string }
  /** no-such-look：没有这个名字（或编号）的形象；file-missing：登记了但图片文件不在 */
  | { ok: false; reason: 'no-such-look' | 'file-missing' }

/**
 * 按"默认或形象名"找定妆图。不传、空白或 'default' 是默认形象；否则去首尾空白后与形象名完全相等，
 * 或直接是形象编号。look 为 'default' 或形象编号。图片文件不在算没有。
 */
export async function resolveLook(charDir: string, nameOrUndefined?: string | null): Promise<ResolveLookResult> {
  const key = (nameOrUndefined ?? '').trim()
  const state = await readLooks(charDir)
  if (!key || key === DEFAULT_LOOK) {
    return state.default.exists
      ? { ok: true, look: DEFAULT_LOOK, file: state.default.file }
      : { ok: false, reason: 'file-missing' }
  }
  const hit = state.extras.find((l) => l.name === key) ?? state.extras.find((l) => l.id === key)
  if (!hit) return { ok: false, reason: 'no-such-look' }
  return hit.exists ? { ok: true, look: hit.id, file: hit.file } : { ok: false, reason: 'file-missing' }
}

/** 读定妆图字节。文件头不是 PNG（或读不到）当作没有：用户酒馆里可能有不是插件生成的 reference.png。 */
export async function readPngBytes(file: string): Promise<Buffer | null> {
  let buf: Buffer
  try {
    buf = await fs.readFile(file)
  } catch {
    return null
  }
  return buf.length >= PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? buf : null
}

// ---------- 候选 ----------

/** images 原图；draft 以某张候选为底；look 以已保存的形象为底；text 按外貌文字 */
export type DraftOrigin = 'images' | 'draft' | 'look' | 'text'

export interface DraftMeta {
  origin: DraftOrigin
  note?: string
  prompt: string
  seed: number
  /** 起点为候选时，是基于哪一张 */
  basedOn?: number
  /** 起点为已保存的形象时，是哪一套：'default' 或形象编号 */
  basedOnLook?: string
}

export interface DraftRecord {
  n: number
  ts: string
  origin: DraftOrigin
  note: string
  prompt: string
  seed: number
  basedOn?: number
  basedOnLook?: string
}

const draftsDir = (charDir: string) => path.join(charDir, DRAFTS_DIR)
const draftsLog = (charDir: string) => path.join(draftsDir(charDir), DRAFTS_LOG_FILE)
const draftName = (n: number) => `${String(n).padStart(3, '0')}.png`
const draftFile = (charDir: string, n: number) => path.join(draftsDir(charDir), draftName(n))

const ORIGINS = new Set<string>(['images', 'draft', 'look', 'text'])

function parseDraft(line: string): DraftRecord | null {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (!v || typeof v !== 'object' || !Number.isInteger(v.n) || (v.n as number) <= 0) return null
    if (typeof v.origin !== 'string' || !ORIGINS.has(v.origin)) return null
    const rec: DraftRecord = {
      n: v.n as number,
      ts: typeof v.ts === 'string' ? v.ts : '',
      origin: v.origin as DraftOrigin,
      note: typeof v.note === 'string' ? v.note : '',
      prompt: typeof v.prompt === 'string' ? v.prompt : '',
      seed: typeof v.seed === 'number' ? v.seed : 0,
    }
    if (Number.isInteger(v.basedOn) && (v.basedOn as number) > 0) rec.basedOn = v.basedOn as number
    if (typeof v.basedOnLook === 'string' && v.basedOnLook !== '') rec.basedOnLook = v.basedOnLook
    return rec
  } catch {
    return null
  }
}

/** 读全部候选记录，按编号升序；坏行跳过，同编号留最后一行。 */
export async function listDrafts(charDir: string): Promise<DraftRecord[]> {
  let text: string
  try {
    text = await fs.readFile(draftsLog(charDir), 'utf8')
  } catch {
    return []
  }
  const byN = new Map<number, DraftRecord>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const r = parseDraft(line)
    if (r) byN.set(r.n, r)
  }
  return [...byN.values()].sort((a, b) => a.n - b.n)
}

// 同进程内按角色目录排队：一次存候选是"取编号、写图、追加、淘汰"几步
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

/** 二进制的"临时文件 + 改名"写入；父目录不存在时创建。 */
async function writeBytesAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/** 目录里已有的最大编号（图片文件与记录两处都看）。 */
async function maxDraftNumber(charDir: string, records: DraftRecord[]): Promise<number> {
  let max = records.reduce((m, r) => Math.max(m, r.n), 0)
  try {
    for (const f of await fs.readdir(draftsDir(charDir))) {
      const m = /^(\d+)\.png$/.exec(f)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {
    // 目录还没有
  }
  return max
}

const toLine = (r: DraftRecord): string => JSON.stringify(r)

/**
 * 存一张候选。编号三位数字，接续现有最大编号（删掉旧的之后也不回头复用）。
 * 超过 20 张时删最早的（图片和记录行都去掉）。返回新记录与图片的绝对路径。
 */
export async function addDraft(
  charDir: string, png: Uint8Array, meta: DraftMeta,
): Promise<{ record: DraftRecord; file: string }> {
  return serialize(path.resolve(charDir), async () => {
    const records = await listDrafts(charDir)
    const n = (await maxDraftNumber(charDir, records)) + 1
    const file = draftFile(charDir, n)
    await writeBytesAtomic(file, png)
    const record: DraftRecord = {
      n,
      ts: new Date().toISOString(),
      origin: meta.origin,
      note: meta.note ?? '',
      prompt: meta.prompt,
      seed: meta.seed,
      ...(meta.basedOn !== undefined ? { basedOn: meta.basedOn } : {}),
      ...(meta.basedOnLook !== undefined ? { basedOnLook: meta.basedOnLook } : {}),
    }
    const all = [...records, record]
    const evict = all.length > MAX_DRAFTS ? all.slice(0, all.length - MAX_DRAFTS) : []
    if (evict.length === 0) {
      // 平时只追加一行；上一行没有以换行结尾时先补一个
      let prefix = ''
      try {
        const cur = await fs.readFile(draftsLog(charDir), 'utf8')
        if (cur && !cur.endsWith('\n')) prefix = '\n'
      } catch {
        // 还没有记录文件
      }
      await fs.appendFile(draftsLog(charDir), prefix + toLine(record) + '\n', 'utf8')
    } else {
      const keep = all.slice(evict.length)
      await atomicWrite(draftsLog(charDir), keep.map(toLine).join('\n') + '\n')
      await Promise.all(evict.map((r) => fs.rm(draftFile(charDir, r.n), { force: true })))
    }
    return { record, file }
  })
}

/** 按编号取一张候选（接受 '3'、'003'、3）；记录或图片不在返回 null。 */
export async function getDraft(
  charDir: string, n: string | number,
): Promise<{ record: DraftRecord; file: string } | null> {
  const num = typeof n === 'number' ? n : /^\d{1,6}$/.test(n.trim()) ? Number(n.trim()) : NaN
  if (!Number.isInteger(num) || num <= 0) return null
  const record = (await listDrafts(charDir)).find((r) => r.n === num)
  if (!record) return null
  const file = draftFile(charDir, num)
  return (await isFile(file)) ? { record, file } : null
}

/** 清空全部候选：删掉整个 .look-drafts/。 */
export async function clearDrafts(charDir: string): Promise<void> {
  await serialize(path.resolve(charDir), () => fs.rm(draftsDir(charDir), { recursive: true, force: true }))
}

// ---------- 保存 ----------

export type SaveLookFailure = 'draft-not-found' | 'bad-name' | 'bad-when' | 'too-many' | 'write-failed'

export type SaveLookResult =
  | { ok: true; look: string; replaced: boolean }
  | {
      ok: false
      reason: SaveLookFailure
      /** 替换同名形象时，图片已经换了而角色卡没改成（when 没更新）；卡里的条目仍指向同一个编号，不是半截状态 */
      imageReplaced?: boolean
    }

export interface LooksDeps {
  /** 改角色卡 looks 栏的函数；测试里注入它来模拟写卡失败 */
  updateLooks?: typeof updateCharacterLooks
}

class LooksRuleError extends Error {
  constructor(readonly reason: 'too-many' | 'bad-name') {
    super(reason)
  }
}

/**
 * 把一张候选定下来。
 * 不给 name：成为默认形象（reference.png，已有则替换）。
 * 给了 name：同名形象已有则替换它的图（编号不变，给了 when 就更新）；没有则新建一条（新编号，when 必须非空），已有 8 套时拒绝。
 * 顺序：先写新图片，再改角色卡；改卡失败时新建的要把刚写的图删掉。
 * 保存后不清空候选，由调用方在成功后调用 clearDrafts。
 */
export async function saveLook(
  charDir: string,
  opts: { draft: string | number; name?: string; when?: string },
  deps: LooksDeps = {},
): Promise<SaveLookResult> {
  const update = deps.updateLooks ?? updateCharacterLooks
  const draft = await getDraft(charDir, opts.draft)
  if (!draft) return { ok: false, reason: 'draft-not-found' }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(draft.file)
  } catch {
    return { ok: false, reason: 'draft-not-found' }
  }

  if (opts.name === undefined) {
    try {
      const existed = await isFile(defaultFile(charDir))
      await writeBytesAtomic(defaultFile(charDir), bytes)
      return { ok: true, look: DEFAULT_LOOK, replaced: existed }
    } catch {
      return { ok: false, reason: 'write-failed' }
    }
  }

  const name = normalizeLookName(opts.name)
  if (name === null) return { ok: false, reason: 'bad-name' }
  const when = opts.when === undefined ? undefined : normalizeLookWhen(opts.when)
  if (when === null) return { ok: false, reason: 'bad-when' }

  const current = await readCharacterLooks(charDir)
  if (current === null) return { ok: false, reason: 'write-failed' }
  const existing = current.find((l) => l.name === name)
  if (!existing) {
    if (!when) return { ok: false, reason: 'bad-when' }
    if (current.length >= MAX_LOOKS) return { ok: false, reason: 'too-many' }
  }
  const id = existing ? existing.id : newLookId()
  const target = lookFile(charDir, id)

  try {
    await writeBytesAtomic(target, bytes)
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
  try {
    await update(charDir, (cur) => {
      const at = cur.findIndex((l) => l.id === id)
      if (existing) {
        // 并发时条目可能被删掉：补回去，保证图片和登记一致
        const entry = { id, name, when: when !== undefined ? when : at >= 0 ? cur[at]!.when : existing.when }
        if (at >= 0) return cur.map((l, i) => (i === at ? entry : l))
        return [...cur, entry]
      }
      if (cur.length >= MAX_LOOKS) throw new LooksRuleError('too-many')
      if (cur.some((l) => l.name === name)) throw new LooksRuleError('bad-name')
      return [...cur, { id, name, when: when! }]
    })
  } catch (e) {
    const reason: SaveLookFailure = e instanceof LooksRuleError ? e.reason : 'write-failed'
    if (!existing) await fs.rm(target, { force: true })
    return { ok: false, reason, ...(existing ? { imageReplaced: true } : {}) }
  }
  return { ok: true, look: id, replaced: !!existing }
}

// ---------- 删除 ----------

export type RemoveLookResult =
  | { ok: true; look: string }
  | { ok: false; reason: 'not-found' | 'write-failed' }

/**
 * 删除一套形象。'default'（或空白）删 reference.png；否则按形象名（或编号）删图片并从角色卡去掉那一条。
 * 先改角色卡再删图片：图片没删成只留下一个无人引用的文件，角色卡不会指向不存在的编号。
 */
export async function removeLook(
  charDir: string, nameOrDefault: string, deps: LooksDeps = {},
): Promise<RemoveLookResult> {
  const update = deps.updateLooks ?? updateCharacterLooks
  const key = nameOrDefault.trim()
  if (!key || key === DEFAULT_LOOK) {
    const file = defaultFile(charDir)
    if (!(await isFile(file))) return { ok: false, reason: 'not-found' }
    try {
      await fs.rm(file)
    } catch {
      return { ok: false, reason: 'write-failed' }
    }
    return { ok: true, look: DEFAULT_LOOK }
  }
  const current = await readCharacterLooks(charDir)
  const hit = current?.find((l) => l.name === key) ?? current?.find((l) => l.id === key)
  if (!hit) return { ok: false, reason: 'not-found' }
  try {
    await update(charDir, (cur) => cur.filter((l) => l.id !== hit.id))
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
  // 编号来自角色卡且已校验，不会越出 looks/
  if (isLookId(hit.id)) await fs.rm(lookFile(charDir, hit.id), { force: true }).catch(() => undefined)
  return { ok: true, look: hit.id }
}
