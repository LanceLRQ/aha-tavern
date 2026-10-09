// 全局登记表：只记酒馆编号、名字、路径。读取时顺手清掉失效项。
import fs from 'node:fs/promises'
import YAML from 'yaml'
import path from 'node:path'
import { AhaError } from './errors'
import { expandHome, modifyFile, pathExists } from './fsx'
import { MARKER_FILE } from './tavern'

export interface RegistryEntry {
  id: string
  name: string
  path: string
}

interface Parsed {
  entries: RegistryEntry[]
  /** 字段不合法、无法识别的条目：不返回给调用方，写回时原样保留。 */
  foreign: unknown[]
}

function parse(raw: string | null): Parsed {
  if (!raw || !raw.trim()) return { entries: [], foreign: [] }
  let doc: unknown
  try {
    doc = YAML.parse(raw)
  } catch (e) {
    throw new AhaError('registry-invalid', '登记表无法解析', { cause: e })
  }
  const list = (doc as { taverns?: unknown } | null)?.taverns
  if (!Array.isArray(list)) return { entries: [], foreign: [] }
  const entries: RegistryEntry[] = []
  const foreign: unknown[] = []
  for (const x of list) {
    if (x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.path === 'string') {
      entries.push({ id: x.id, name: x.name, path: x.path })
    } else {
      foreign.push(x)
    }
  }
  return { entries, foreign }
}

const dump = (p: Parsed) => YAML.stringify({ taverns: [...p.entries, ...p.foreign] })

/** 在锁内对登记表做一次读改写。 */
function edit<T>(registryPath: string, fn: (entries: RegistryEntry[]) => T | Promise<T>): Promise<T> {
  let result!: T
  return modifyFile(expandHome(registryPath), async (raw) => {
    const parsed = parse(raw)
    result = await fn(parsed.entries)
    return dump(parsed)
  }).then(() => result)
}

async function isLive(e: RegistryEntry): Promise<boolean> {
  return pathExists(path.join(e.path, MARKER_FILE))
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 先无锁读取；只有确有失效项时才加锁剔除并写回。 */
export async function readRegistry(registryPath: string): Promise<RegistryEntry[]> {
  const file = expandHome(registryPath)
  const { entries } = parse(await readRaw(file))
  const flags = await Promise.all(entries.map(isLive))
  if (flags.every(Boolean)) return entries
  return edit(registryPath, async (current) => {
    const live = await Promise.all(current.map(isLive))
    const keep = current.filter((_, i) => live[i])
    current.splice(0, current.length, ...keep)
    return keep.map((e) => ({ ...e }))
  })
}

/** 登记：同编号或同路径的旧项被新项取代。 */
export async function registerTavern(registryPath: string, entry: RegistryEntry): Promise<void> {
  await edit(registryPath, (entries) => {
    const rest = entries.filter((e) => e.id !== entry.id && e.path !== entry.path)
    entries.splice(0, entries.length, ...rest, { ...entry })
  })
}

/** 更新某编号的路径；编号未登记返回 false。 */
export async function updateTavernPath(registryPath: string, id: string, newPath: string): Promise<boolean> {
  return edit(registryPath, (entries) => {
    const hit = entries.find((e) => e.id === id)
    if (!hit) return false
    hit.path = newPath
    return true
  })
}
