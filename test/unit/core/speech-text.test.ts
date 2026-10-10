import { describe, expect, it } from 'vitest'
import { planSpeech, speakableText, splitSentences } from '../../../src/core/speech-text'

describe('speakableText 图片行', () => {
  it('两种模式都去掉图片行，含尖括号、空格、中文路径', () => {
    const reply = '你好呀。\n![画面](<~/酒馆 a/images/一张 图.png>)'
    expect(speakableText(reply, 'lines')).toBe('你好呀。')
    expect(speakableText(reply, 'all')).toBe('你好呀。')
    expect(speakableText('![画面](/a/b.png)\n你好', 'all')).toBe('你好')
  })
  it('只有图片行时结果为空', () => {
    expect(speakableText('![画面](<a b/c.png>)', 'lines')).toBe('')
    expect(planSpeech('![画面](<a b/c.png>)', { mode: 'all' })).toEqual({ sentences: [], truncated: false })
  })
})

describe('speakableText Markdown 标记', () => {
  it('去标题、引用、列表符号', () => {
    expect(speakableText('# 标题\n> 引用的话\n- 第一项\n1. 第二项', 'all')).toBe('标题\n引用的话\n第一项\n第二项')
  })
  it('去强调、反引号，链接只留文字', () => {
    expect(speakableText('这是**重点**和`代码`，见[链接文字](https://x.y/z)。', 'all')).toBe('这是重点和代码，见链接文字。')
  })
  it('all 模式保留括号与单星号里的文字，只去符号', () => {
    expect(speakableText('（笑）你好*挥手*再见', 'all')).toBe('（笑）你好挥手再见')
  })
})

describe('speakableText lines 模式', () => {
  it('删全角、半角括号与方括号及其内容', () => {
    expect(speakableText('（笑）你好(挥手)啊【旁白】。', 'lines')).toBe('你好啊。')
  })
  it('单星号当作动作删掉，双星号只去符号', () => {
    expect(speakableText('*点头*好的，**一定**来。', 'lines')).toBe('好的，一定来。')
  })
  it('全角半角混用也算成对', () => {
    expect(speakableText('你好（笑)再见', 'lines')).toBe('你好再见')
  })
  it('不闭合的括号不删内容', () => {
    expect(speakableText('你好（笑着说', 'lines')).toBe('你好（笑着说')
    expect(speakableText('你好)再见', 'lines')).toBe('你好)再见')
  })
  it('嵌套括号按最外层删', () => {
    expect(speakableText('甲（乙（丙）丁）戊', 'lines')).toBe('甲戊')
  })
  it('删除后收拾多余空白与空行', () => {
    expect(speakableText('你好 （笑） 世界\n（沉默）\n\n再见', 'lines')).toBe('你好 世界\n再见')
  })
  it('全是动作描写时结果为空', () => {
    expect(speakableText('（她笑了）\n*转身*\n【场景切换】', 'lines')).toBe('')
    expect(planSpeech('（她笑了）\n*转身*', { mode: 'lines' }).sentences).toEqual([])
  })
  it('引号与其中的话保留', () => {
    expect(speakableText('他说：“我回来了”，「真的」。', 'lines')).toBe('他说：“我回来了”，「真的」。')
  })
  it('波浪号、破折号不特殊处理', () => {
    expect(speakableText('好呀~——真的', 'lines')).toBe('好呀~——真的')
  })
})

describe('splitSentences', () => {
  it('按句末标点和换行切，标点留在句尾', () => {
    expect(splitSentences('今天天气真不错。你吃饭了吗？我们一起去吧！\n好的好的好的')).toEqual([
      '今天天气真不错。',
      '你吃饭了吗？',
      '我们一起去吧！',
      '好的好的好的',
    ])
  })
  it('英文句子按 !? 切', () => {
    expect(splitSentences('How are you doing today? I am fine!')).toEqual(['How are you doing today?', 'I am fine!'])
  })
  it('省略号与连续标点算一个句尾', () => {
    expect(splitSentences('我真的不知道……你到底说什么呢？！那就这样吧好不好')).toEqual(['我真的不知道……', '你到底说什么呢？！', '那就这样吧好不好'])
  })
  it('收尾引号跟在句尾', () => {
    expect(splitSentences('他说“我们走吧。”然后离开了房间')).toEqual(['他说“我们走吧。”', '然后离开了房间'])
  })
  it('不足 6 字的并入下一句', () => {
    expect(splitSentences('好。我们现在就出发去海边吧。')).toEqual(['好。我们现在就出发去海边吧。'])
  })
  it('最后一句过短并入上一句；只有一句短句则保留', () => {
    expect(splitSentences('我们现在就出发去海边吧。好。')).toEqual(['我们现在就出发去海边吧。好。'])
    expect(splitSentences('好。')).toEqual(['好。'])
  })
  it('英文短句并入时补空格', () => {
    expect(splitSentences('Hi! How are you?')).toEqual(['Hi! How are you?'])
  })
  it('只含标点、空白、表情的句子丢弃', () => {
    expect(splitSentences('……\n！！\n😀\n   \n你好呀，欢迎光临。')).toEqual(['你好呀，欢迎光临。'])
  })
  it('超长句在逗号处再切', () => {
    const out = splitSentences('甲乙丙丁戊，己庚辛壬癸，子丑寅卯辰。', { maxChars: 12 })
    expect(out).toEqual(['甲乙丙丁戊，己庚辛壬癸，', '子丑寅卯辰。'])
  })
  it('仍超长就硬切，按码点计', () => {
    const out = splitSentences('😀'.repeat(5) + '一二三四五六七八', { maxChars: 6 })
    expect(out.map((s) => [...s].length)).toEqual([6, 6, 1])
    expect(out.join('')).toBe('😀'.repeat(5) + '一二三四五六七八')
  })
})

describe('planSpeech', () => {
  it('lines 模式：去动作、去图片、切句', () => {
    const plan = planSpeech('（笑）欢迎光临，今天想喝点什么？\n![画面](<a b.png>)', { mode: 'lines' })
    expect(plan).toEqual({ sentences: ['欢迎光临，今天想喝点什么？'], truncated: false })
  })
  it('总量超限时截到最后一个完整句子', () => {
    const reply = '第一句话有十个字呢。第二句话有十个字呢。第三句话有十个字呢。'
    const plan = planSpeech(reply, { mode: 'all', maxTotal: 25 })
    expect(plan.sentences).toEqual(['第一句话有十个字呢。', '第二句话有十个字呢。'])
    expect(plan.truncated).toBe(true)
  })
  it('刚好等于上限不算截断', () => {
    const plan = planSpeech('第一句话有十个字呢。', { mode: 'all', maxTotal: 10 })
    expect(plan.truncated).toBe(false)
    expect(plan.sentences).toHaveLength(1)
  })
})
