// 酒馆目录：标记文件、开店、数据版本判定与迁移。
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { AhaError } from './errors'
import { atomicWrite, pathExists } from './fsx'
import { newTavernId } from './ids'

export const MARKER_FILE = 'aha-tavern.yaml'
export const DATA_VERSION = 1

export interface TavernMarker {
  version: number
  id: string
  name: string
}

/** readwrite：可读写；migrate：版本较旧需迁移；readonly：版本过新，只允许查看。 */
export type TavernAccess = 'readwrite' | 'migrate' | 'readonly'

export interface TavernInfo {
  dir: string
  marker: TavernMarker
  access: TavernAccess
}

/** 按"源版本号"分派的迁移表：每项把标记文件升一级。现在没有历史版本。 */
export type Migrations = Record<number, (marker: TavernMarker, dir: string) => Promise<TavernMarker>>
const MIGRATIONS: Migrations = {}

const markerPath = (dir: string) => path.join(dir, MARKER_FILE)

export const isTavern = (dir: string): Promise<boolean> => pathExists(markerPath(dir))

export async function createTavern(dir: string, opts: { name: string; id?: string }): Promise<TavernMarker> {
  if (await isTavern(dir)) throw new AhaError('already-tavern', `已经是酒馆：${dir}`)
  const marker: TavernMarker = { version: DATA_VERSION, id: opts.id ?? newTavernId(), name: opts.name }
  for (const sub of ['characters', 'chats', '.aha']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  await atomicWrite(markerPath(dir), YAML.stringify(marker))
  return marker
}

function parseMarker(raw: string, dir: string): TavernMarker {
  let doc: unknown
  try {
    doc = YAML.parse(raw)
  } catch (e) {
    throw new AhaError('marker-invalid', `标记文件无法解析：${dir}`, { cause: e })
  }
  const o = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>
  if (!Number.isInteger(o.version) || typeof o.id !== 'string' || !o.id || typeof o.name !== 'string') {
    throw new AhaError('marker-invalid', `标记文件缺少必要字段：${dir}`)
  }
  return { version: o.version as number, id: o.id, name: o.name }
}

export async function openTavern(dir: string): Promise<TavernInfo> {
  let raw: string
  try {
    raw = await fs.readFile(markerPath(dir), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AhaError('not-tavern', `不是酒馆：${dir}`)
    throw e
  }
  const marker = parseMarker(raw, dir)
  const access: TavernAccess =
    marker.version === DATA_VERSION ? 'readwrite' : marker.version < DATA_VERSION ? 'migrate' : 'readonly'
  return { dir, marker, access }
}

/** 写入前调用：版本过新的酒馆拒绝写入。 */
export function assertWritable(info: TavernInfo): void {
  if (info.access === 'readonly') {
    throw new AhaError('version-too-new', `酒馆数据版本 ${info.marker.version} 比插件新（${DATA_VERSION}），请升级插件`)
  }
}

/** 就地迁移：先备份标记文件，再逐级升版本。任一环节失败不改动标记文件。 */
export async function migrateTavern(dir: string, migrations: Migrations = MIGRATIONS): Promise<TavernInfo> {
  const info = await openTavern(dir)
  assertWritable(info)
  if (info.access === 'readwrite') return info

  let marker = info.marker
  const steps: Array<(m: TavernMarker) => Promise<TavernMarker>> = []
  for (let v = marker.version; v < DATA_VERSION; v++) {
    const step = migrations[v]
    if (!step) throw new AhaError('marker-invalid', `缺少从数据版本 ${v} 开始的迁移`)
    steps.push((m) => step(m, dir))
  }

  await fs.copyFile(markerPath(dir), `${markerPath(dir)}.bak-v${marker.version}`)
  for (const step of steps) {
    const next = await step(marker)
    if (next.version <= marker.version) throw new AhaError('marker-invalid', '迁移没有提升数据版本')
    marker = next
  }
  await atomicWrite(markerPath(dir), YAML.stringify(marker))
  return openTavern(dir)
}
