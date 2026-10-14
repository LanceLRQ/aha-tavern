// 群聊回复拆分（#kyi8、二期规格 §6、§15）的单元测试。
import { describe, expect, it } from 'vitest'
import { parseGroupReply, type KnownCharacter } from '../../../src/core/group-log'

const KNOWN: KnownCharacter[] = [
  { id: 'c1', name: '白狐' },
  { id: 'c2', name: '白狐妖' },
  { id: 'c3', name: '青衫' },
]

describe('parseGroupReply', () => {
  it('规格 §6 的示例：旁白与台词分段，说话人映射成编号', () => {
    const reply = [
      '【旁白】月光洒在后院的青石板上，老槐树下摆了一张小桌。',
      '',
      '白狐：（把酒坛往桌上一放）就这儿吧，比里头清净。',
      '',
      '青衫：清净是清净，蚊子可不少。（拍了一下脖子）',
    ].join('\n')
    expect(parseGroupReply(reply, KNOWN)).toEqual([
      { kind: 'narrator', text: '月光洒在后院的青石板上，老槐树下摆了一张小桌。' },
      { kind: 'character', speaker: 'c1', text: '（把酒坛往桌上一放）就这儿吧，比里头清净。' },
      { kind: 'character', speaker: 'c3', text: '清净是清净，蚊子可不少。（拍了一下脖子）' },
    ])
  })

  it('主题称呼也认：narrator 的概念词可以不是"旁白"', () => {
    const reply = '【说书人】正是黄昏。\n\n白狐：来了。'
    expect(parseGroupReply(reply, KNOWN, ['说书人', '旁白'])).toEqual([
      { kind: 'narrator', text: '正是黄昏。' },
      { kind: 'character', speaker: 'c1', text: '来了。' },
    ])
  })

  it('不以空行分隔也拆得开；台词里的续行并入该段', () => {
    const reply = '【旁白】入夜了。\n白狐：这坛酒\n埋了三年。\n青衫：好酒。'
    expect(parseGroupReply(reply, KNOWN)).toEqual([
      { kind: 'narrator', text: '入夜了。' },
      { kind: 'character', speaker: 'c1', text: '这坛酒\n埋了三年。' },
      { kind: 'character', speaker: 'c3', text: '好酒。' },
    ])
  })

  it('拆不出合法行首的段落整段记为旁白（规格 §6）', () => {
    const reply = '夜深了，四下只剩虫鸣。\n白狐：睡吧。'
    expect(parseGroupReply(reply, KNOWN)).toEqual([
      { kind: 'narrator', text: '夜深了，四下只剩虫鸣。' },
      { kind: 'character', speaker: 'c1', text: '睡吧。' },
    ])
  })

  it('不在场的角色也照记（规格 §15）：按名字匹配酒馆里的角色', () => {
    const reply = '白狐妖：诸位，我路过。\n白狐：你怎么来了。'
    expect(parseGroupReply(reply, KNOWN)).toEqual([
      { kind: 'character', speaker: 'c2', text: '诸位，我路过。' },
      { kind: 'character', speaker: 'c1', text: '你怎么来了。' },
    ])
  })

  it('名字对不上任何角色：整行记为旁白', () => {
    const reply = '路过的商人：卖酒吗？'
    const lines = parseGroupReply(reply, KNOWN)
    expect(lines).toEqual([{ kind: 'narrator', text: '路过的商人：卖酒吗？' }])
  })

  it('歧义的名字（前缀对上多个）不当台词，整行记为旁白', () => {
    const reply = '白：大家好吗？'
    expect(parseGroupReply(reply, KNOWN)).toEqual([{ kind: 'narrator', text: '白：大家好吗？' }])
  })

  it('代表用户的行：记为旁白并打越界标记（规格 §15）', () => {
    for (const label of ['我', 'user', '用户']) {
      const lines = parseGroupReply(`${label}：我也要喝。`, KNOWN)
      expect(lines).toEqual([{ kind: 'narrator', text: '我也要喝。', userImpersonated: true }])
    }
  })

  it('全名相等优先于前缀：写"白狐妖"是 c2 不是 c1', () => {
    expect(parseGroupReply('白狐妖：我在。', KNOWN)[0]).toMatchObject({ kind: 'character', speaker: 'c2' })
    expect(parseGroupReply('白狐：我在。', KNOWN)[0]).toMatchObject({ kind: 'character', speaker: 'c1' })
  })

  it('空回复与纯空白：拆不出任何段', () => {
    expect(parseGroupReply('', KNOWN)).toEqual([])
    expect(parseGroupReply('  \n\n  ', KNOWN)).toEqual([])
  })

  it('冒号前太长的不当名字（防误吞正文）', () => {
    const long = '一'.repeat(50)
    expect(parseGroupReply(`${long}：这样写不是台词。`, KNOWN)).toEqual([
      { kind: 'narrator', text: `${long}：这样写不是台词。` },
    ])
  })
})
