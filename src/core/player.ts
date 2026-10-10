// 本机播放与音频转换：找播放器、播一个文件、macOS 上把任意音频转成 wav。
// 与宿主无关；起进程与探测可执行文件一律用调用方注入的 spawn / which / platform。错误原文只放 detail。

/** 'no-player' 本模块不抛，由调用方在 findPlayer 返回 null 时使用。 */
export type PlayerErrorKind = 'no-player' | 'spawn-failed' | 'play-failed' | 'cancelled' | 'convert-failed'

const DETAIL_MAX = 2000

export class PlayerError extends Error {
  readonly kind: PlayerErrorKind
  /** 进程退出码或系统错误原文，已截断；只给日志用。 */
  readonly detail: string

  constructor(kind: PlayerErrorKind, detail = '', options?: { cause?: unknown }) {
    super(`player: ${kind}`, options)
    this.name = 'PlayerError'
    this.kind = kind
    this.detail = detail.slice(0, DETAIL_MAX)
  }
}

/** 播放器用到的子进程最小形态，便于测试用假对象；node 的 ChildProcess 满足它。 */
export interface PlayerChild {
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown
  off(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown
  kill(): unknown
}

/** 注入的起进程函数；真实环境传 node:child_process 的 spawn。 */
export type PlayerSpawn = (command: string, args: string[]) => PlayerChild

/** 返回可执行文件路径，找不到返回 null；可同步可异步。 */
export type WhichFn = (name: string) => string | null | Promise<string | null>

/** 一个可用的播放器：命令名与「给定文件时的参数」。 */
export interface Player {
  command: string
  args: (file: string) => string[]
}

const FFPLAY_FLAGS = ['-nodisp', '-autoexit', '-loglevel', 'quiet']

/** 按平台挑播放器：macOS 只用 afplay；其他平台依次 ffplay、paplay、aplay。 */
export async function findPlayer(opts: { platform: string; which: WhichFn }): Promise<Player | null> {
  const candidates: Player[] =
    opts.platform === 'darwin'
      ? [{ command: 'afplay', args: (f) => [f] }]
      : [
          { command: 'ffplay', args: (f) => [...FFPLAY_FLAGS, f] },
          { command: 'paplay', args: (f) => [f] },
          { command: 'aplay', args: (f) => [f] },
        ]
  for (const c of candidates) {
    if (await opts.which(c.command)) return c
  }
  return null
}

const ignore = () => {}

/** 起进程跑到结束：非零退出归 failKind，起不来归 spawn-failed，signal 触发时杀进程并以取消结束。 */
function runProcess(
  spawn: PlayerSpawn,
  command: string,
  args: string[],
  failKind: 'play-failed' | 'convert-failed',
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new PlayerError('cancelled'))
    let child: ReturnType<PlayerSpawn>
    try {
      child = spawn(command, args)
    } catch (e) {
      return reject(new PlayerError('spawn-failed', String(e), { cause: e }))
    }

    const cleanup = () => {
      child.off('exit', onExit)
      child.off('error', onError)
      // 结算后进程仍可能再发 error（如 kill 失败），留一个空监听器吞掉，免得变成未捕获异常
      child.on('error', ignore)
      signal?.removeEventListener('abort', onAbort)
    }
    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      cleanup()
      if (code === 0) resolve()
      else reject(new PlayerError(failKind, `exit code=${code} signal=${sig}`))
    }
    const onError = (e: Error) => {
      cleanup()
      reject(new PlayerError('spawn-failed', String(e), { cause: e }))
    }
    const onAbort = () => {
      cleanup()
      reject(new PlayerError('cancelled'))
      try {
        child.kill()
      } catch {
        // 结束进程失败不影响取消的结果
      }
    }
    child.on('exit', onExit)
    child.on('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 播放一个文件，播完 resolve；被取消、起不来、播放失败都以 PlayerError 拒绝。 */
export function play(player: Player, file: string, opts: { spawn: PlayerSpawn; signal?: AbortSignal }): Promise<void> {
  return runProcess(opts.spawn, player.command, player.args(file), 'play-failed', opts.signal)
}

/** 把任意音频转成 24kHz 16 位单声道 wav 的函数。 */
export type AudioConverter = (src: string, dest: string, opts: { signal?: AbortSignal }) => Promise<void>

/** 仅 macOS 有（用 afconvert）；其他平台或找不到命令返回 null。 */
export async function findConverter(opts: {
  platform: string
  which: WhichFn
  spawn: PlayerSpawn
}): Promise<AudioConverter | null> {
  if (opts.platform !== 'darwin') return null
  if (!(await opts.which('afconvert'))) return null
  return (src, dest, { signal }) =>
    runProcess(
      opts.spawn,
      'afconvert',
      ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', src, dest],
      'convert-failed',
      signal,
    )
}
