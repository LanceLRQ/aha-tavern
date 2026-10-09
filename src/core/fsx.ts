// 文件系统辅助：原子写、带锁读改写、安全目录名。全部异步。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AhaError } from './errors'

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 先写同目录临时文件再改名；父目录不存在时自动创建。 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const h = await fs.open(tmp, 'w')
    try {
      await h.writeFile(content, 'utf8')
      await h.sync()
    } finally {
      await h.close()
    }
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

export interface LockOptions {
  /** 等锁的最长时间，默认 5 秒。 */
  timeoutMs?: number
  /** 锁文件超过这个年龄视为残留并清除，默认 30 秒。 */
  staleMs?: number
}

// 同进程内按路径排队；跨进程靠锁文件兜底。
const queues = new Map<string, Promise<unknown>>()

async function acquireLockFile(lock: string, timeoutMs: number, staleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const h = await fs.open(lock, 'wx')
      await h.close()
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    try {
      const st = await fs.stat(lock)
      if (Date.now() - st.mtimeMs > staleMs) {
        await fs.rm(lock, { force: true })
        continue
      }
    } catch {
      continue // 锁刚被释放，立刻重试
    }
    if (Date.now() >= deadline) throw new AhaError('lock-timeout', `等待文件锁超时：${lock}`)
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 20))
  }
}

/**
 * 读、改、写三步在锁内完成。mutate 收到当前内容（文件不存在为 null），
 * 返回新内容；函数返回写入后的内容。mutate 抛错则不写、释放锁。
 */
export async function modifyFile(
  file: string,
  mutate: (current: string | null) => string | Promise<string>,
  opts: LockOptions = {},
): Promise<string> {
  const key = path.resolve(file)
  const { timeoutMs = 5000, staleMs = 30_000 } = opts
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(key), { recursive: true })
    const lock = `${key}.lock`
    await acquireLockFile(lock, timeoutMs, staleMs)
    try {
      let current: string | null = null
      try {
        current = await fs.readFile(key, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      const next = await mutate(current)
      await atomicWrite(key, next)
      return next
    } finally {
      await fs.rm(lock, { force: true })
    }
  })
  queues.set(key, run)
  try {
    return await run
  } finally {
    if (queues.get(key) === run) queues.delete(key)
  }
}

/** 把任意名字变成安全目录名：去掉路径分隔符等不可用字符，保留中文。 */
export function safeDirName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .replace(/[.\s]+$/, '')
    .replace(/^\.+/, '')
    .trim()
  if (!cleaned) throw new AhaError('invalid-name', `名字清理后为空：${JSON.stringify(name)}`)
  return cleaned
}
