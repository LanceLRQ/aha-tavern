import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { findConverter, findPlayer, play, PlayerError, type PlayerSpawn } from '../../../src/core/player'

/** 假子进程：手动触发退出或错误，记录 kill 次数。 */
class FakeChild extends EventEmitter {
  killed = 0
  kill(): boolean {
    this.killed++
    return true
  }
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: FakeChild[] = []
  const spawn: PlayerSpawn = (command, args) => {
    calls.push({ command, args })
    const c = new FakeChild()
    children.push(c)
    return c
  }
  return { spawn, calls, children }
}

/** 取数组第 i 项，不存在就让测试失败。 */
function at<T>(arr: T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`缺少第 ${i} 项`)
  return v
}

const whichOf = (found: string[]) => async (name: string) => (found.includes(name) ? `/bin/${name}` : null)

async function kindOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    return e instanceof PlayerError ? e.kind : `other:${String(e)}`
  }
  return undefined
}

describe('findPlayer', () => {
  it('macOS 用 afplay', async () => {
    const p = await findPlayer({ platform: 'darwin', which: whichOf(['afplay', 'ffplay']) })
    expect(p?.command).toBe('afplay')
    expect(p?.args('/a.wav')).toEqual(['/a.wav'])
  })

  it('macOS 上 afplay 不存在则为 null，不去找别的', async () => {
    expect(await findPlayer({ platform: 'darwin', which: whichOf(['ffplay']) })).toBeNull()
  })

  it('其他平台按 ffplay、paplay、aplay 的顺序', async () => {
    const all = await findPlayer({ platform: 'linux', which: whichOf(['aplay', 'paplay', 'ffplay']) })
    expect(all?.command).toBe('ffplay')
    expect(all?.args('/a.wav')).toEqual(['-nodisp', '-autoexit', '-loglevel', 'quiet', '/a.wav'])
    const pa = await findPlayer({ platform: 'linux', which: whichOf(['aplay', 'paplay']) })
    expect(pa?.command).toBe('paplay')
    expect(pa?.args('/a.wav')).toEqual(['/a.wav'])
    const ap = await findPlayer({ platform: 'win32', which: whichOf(['aplay']) })
    expect(ap?.command).toBe('aplay')
  })

  it('都没有返回 null；which 可以是同步函数', async () => {
    expect(await findPlayer({ platform: 'linux', which: () => null })).toBeNull()
    const p = await findPlayer({ platform: 'linux', which: (n) => (n === 'paplay' ? '/usr/bin/paplay' : null) })
    expect(p?.command).toBe('paplay')
  })
})

describe('play', () => {
  const player = { command: 'afplay', args: (f: string) => [f] }

  it('正常结束时 resolve，并按描述起进程', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const p = play(player, '/a.wav', { spawn })
    expect(calls).toEqual([{ command: 'afplay', args: ['/a.wav'] }])
    at(children, 0).emit('exit', 0, null)
    await expect(p).resolves.toBeUndefined()
  })

  it('非零退出归为播放失败', async () => {
    const { spawn, children } = fakeSpawn()
    const p = play(player, '/a.wav', { spawn })
    at(children, 0).emit('exit', 1, null)
    expect(await kindOf(p)).toBe('play-failed')
  })

  it('进程起不来（error 事件）归为 spawn-failed', async () => {
    const { spawn, children } = fakeSpawn()
    const p = play(player, '/a.wav', { spawn })
    at(children, 0).emit('error', new Error('spawn afplay ENOENT'))
    expect(await kindOf(p)).toBe('spawn-failed')
  })

  it('spawn 同步抛错也归为 spawn-failed', async () => {
    const spawn: PlayerSpawn = () => {
      throw new Error('boom')
    }
    expect(await kindOf(play(player, '/a.wav', { spawn }))).toBe('spawn-failed')
  })

  it('signal 已触发时不起进程，直接取消', async () => {
    const { spawn, calls } = fakeSpawn()
    const ac = new AbortController()
    ac.abort()
    expect(await kindOf(play(player, '/a.wav', { spawn, signal: ac.signal }))).toBe('cancelled')
    expect(calls).toHaveLength(0)
  })

  it('播放中 signal 触发：杀进程并以取消结束，不等进程自己退出', async () => {
    const { spawn, children } = fakeSpawn()
    const ac = new AbortController()
    const p = play(player, '/a.wav', { spawn, signal: ac.signal })
    ac.abort()
    expect(await kindOf(p)).toBe('cancelled')
    expect(at(children, 0).killed).toBe(1)
  })

  it('结束后摘掉监听器', async () => {
    const { spawn, children } = fakeSpawn()
    const ac = new AbortController()
    const p = play(player, '/a.wav', { spawn, signal: ac.signal })
    at(children, 0).emit('exit', 0, null)
    await p
    expect(at(children, 0).listenerCount('exit')).toBe(0)
    expect(at(children, 0).listenerCount('error')).toBe(0)
    ac.abort()
    expect(at(children, 0).killed).toBe(0)
  })

  it('被信号杀死（code 为 null）归为播放失败', async () => {
    const { spawn, children } = fakeSpawn()
    const p = play(player, '/a.wav', { spawn })
    at(children, 0).emit('exit', null, 'SIGKILL')
    expect(await kindOf(p)).toBe('play-failed')
  })
})

describe('findConverter', () => {
  it('非 macOS 返回 null', async () => {
    const { spawn } = fakeSpawn()
    expect(await findConverter({ platform: 'linux', which: whichOf(['afconvert']), spawn })).toBeNull()
  })

  it('macOS 上没有 afconvert 返回 null', async () => {
    const { spawn } = fakeSpawn()
    expect(await findConverter({ platform: 'darwin', which: whichOf([]), spawn })).toBeNull()
  })

  it('转换成功：命令与参数正确', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const convert = await findConverter({ platform: 'darwin', which: whichOf(['afconvert']), spawn })
    expect(convert).not.toBeNull()
    const p = convert!('/in.m4a', '/out.wav', {})
    expect(calls).toEqual([
      { command: 'afconvert', args: ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', '/in.m4a', '/out.wav'] },
    ])
    at(children, 0).emit('exit', 0, null)
    await expect(p).resolves.toBeUndefined()
  })

  it('转换失败（非零退出）归为 convert-failed', async () => {
    const { spawn, children } = fakeSpawn()
    const convert = await findConverter({ platform: 'darwin', which: whichOf(['afconvert']), spawn })
    const p = convert!('/in.m4a', '/out.wav', {})
    at(children, 0).emit('exit', 1, null)
    expect(await kindOf(p)).toBe('convert-failed')
  })

  it('转换时进程起不来归为 spawn-failed；取消时杀进程', async () => {
    const a = fakeSpawn()
    const convert = await findConverter({ platform: 'darwin', which: whichOf(['afconvert']), spawn: a.spawn })
    const p1 = convert!('/in.m4a', '/out.wav', {})
    at(a.children, 0).emit('error', new Error('ENOENT'))
    expect(await kindOf(p1)).toBe('spawn-failed')

    const ac = new AbortController()
    const p2 = convert!('/in.m4a', '/out.wav', { signal: ac.signal })
    ac.abort()
    expect(await kindOf(p2)).toBe('cancelled')
    expect(at(a.children, 1).killed).toBe(1)
  })
})
