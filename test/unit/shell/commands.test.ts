import { describe, expect, it } from 'vitest'
import { COMMAND_IDS } from '../../../src/core/dispatch'
import { SUBCOMMANDS, parseSubcommand } from '../../../src/shell/commands'

describe('parseSubcommand', () => {
  it('对照表覆盖全部命令标识且中英文各不重复', () => {
    expect(SUBCOMMANDS.map((s) => s.id)).toEqual([...COMMAND_IDS])
    expect(new Set(SUBCOMMANDS.map((s) => s.zh)).size).toBe(SUBCOMMANDS.length)
  })

  it('中文子命令', () => {
    expect(parseSubcommand('开店')).toEqual({ kind: 'command', id: 'init', args: '' })
    expect(parseSubcommand('世界观')).toEqual({ kind: 'command', id: 'world', args: '' })
    expect(parseSubcommand('自检')).toEqual({ kind: 'command', id: 'doctor', args: '' })
  })

  it('英文子命令', () => {
    expect(parseSubcommand('init')).toEqual({ kind: 'command', id: 'init', args: '' })
    expect(parseSubcommand('remember')).toEqual({ kind: 'command', id: 'remember', args: '' })
  })

  it('大小写不敏感', () => {
    expect(parseSubcommand('INIT')).toEqual({ kind: 'command', id: 'init', args: '' })
    expect(parseSubcommand('Doctor')).toEqual({ kind: 'command', id: 'doctor', args: '' })
  })

  it('带参数：剩余部分原样保留（去首尾空白）', () => {
    expect(parseSubcommand('开场 白狐')).toEqual({ kind: 'command', id: 'start', args: '白狐' })
    expect(parseSubcommand('  start   白  狐  ')).toEqual({ kind: 'command', id: 'start', args: '白  狐' })
    expect(parseSubcommand('记住\n明天要早起')).toEqual({ kind: 'command', id: 'remember', args: '明天要早起' })
  })

  it('未知子命令', () => {
    expect(parseSubcommand('跳舞')).toEqual({ kind: 'unknown', word: '跳舞' })
    expect(parseSubcommand('foo bar')).toEqual({ kind: 'unknown', word: 'foo' })
  })

  it('空输入', () => {
    expect(parseSubcommand('')).toEqual({ kind: 'empty' })
    expect(parseSubcommand('   \n ')).toEqual({ kind: 'empty' })
  })
})
