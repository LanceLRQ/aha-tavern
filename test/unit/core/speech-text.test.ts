import { describe, expect, it } from 'vitest'
import {
  MIN_PAUSE_SECONDS, PARAGRAPH_PAUSE_CHARS, PAUSE_BASE_CHARS, breakPauseSeconds, planSpeech, speakableText, splitSentences,
} from '../../../src/core/speech-text'

describe('speakableText 图片行', () => {
  it('两种模式都去掉图片行，含尖括号、空格、中文路径', () => {
    const reply = '你好呀。\n![画面](<~/酒馆 a/images/一张 图.png>)'
    expect(speakableText(reply, 'lines')).toBe('你好呀。')
    expect(speakableText(reply, 'all')).toBe('你好呀。')
    expect(speakableText('![画面](/a/b.png)\n你好', 'all')).toBe('你好')
  })
  it('只有图片行时结果为空', () => {
    expect(speakableText('![画面](<a b/c.png>)', 'lines')).toBe('')
    expect(planSpeech('![画面](<a b/c.png>)', { mode: 'all' })).toEqual({ sentences: [], gaps: [], skipped: [], truncated: false })
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
    expect(plan).toEqual({ sentences: ['欢迎光临，今天想喝点什么？'], gaps: ['none'], skipped: [0], truncated: false })
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

describe('planSpeech 的间隔种类', () => {
  it('第一句没有间隔；台词（动作）台词得到 break', () => {
    const plan = planSpeech('“欢迎光临，请坐吧。”（她擦了擦杯子）“今天想喝点什么？”', { mode: 'lines' })
    expect(plan.sentences).toHaveLength(2)
    expect(plan.gaps).toEqual(['none', 'break'])
  })
  it('星号动作与引号外的叙述同样得到 break', () => {
    const plan = planSpeech('欢迎光临，请坐吧。*她擦了擦杯子*今天想喝点什么？', { mode: 'lines' })
    expect(plan.gaps).toEqual(['none', 'break'])
  })
  it('同一段里相邻的两句得到 inline', () => {
    const plan = planSpeech('“欢迎光临，请坐吧。今天想喝点什么？”', { mode: 'lines' })
    expect(plan.sentences).toHaveLength(2)
    expect(plan.gaps).toEqual(['none', 'inline'])
  })
  it('长句被切开的两半是 inline', () => {
    const plan = planSpeech('甲乙丙丁戊己，庚辛壬癸子丑。', { mode: 'all', maxChars: 8 })
    expect(plan.sentences.length).toBeGreaterThan(1)
    expect(plan.gaps[0]).toBe('none')
    expect(plan.gaps.slice(1).every((g) => g === 'inline')).toBe(true)
  })
  it('all 模式换段得到 break，同段是 inline', () => {
    const plan = planSpeech('第一句话有十个字呢。第二句话有十个字呢。\n\n第三句话有十个字呢。', { mode: 'all' })
    expect(plan.gaps).toEqual(['none', 'inline', 'break'])
  })
  it('lines 模式下换行也是 break', () => {
    const plan = planSpeech('第一句话有十个字呢。\n第二句话有十个字呢。', { mode: 'lines' })
    expect(plan.gaps).toEqual(['none', 'break'])
  })
  it('gaps 与 sentences 等长，截断后仍等长', () => {
    const plan = planSpeech('第一句话有十个字呢。第二句话有十个字呢。第三句话有十个字呢。', { mode: 'all', maxTotal: 25 })
    expect(plan.gaps).toEqual(['none', 'inline'])
  })
  it('speakableText 的结果不受标记影响', () => {
    expect(speakableText('你好呀（笑）朋友', 'lines')).toBe('你好呀朋友')
  })
})

describe('planSpeech 的跳过字数', () => {
  const skipped = (text: string, mode: 'lines' | 'all' = 'lines') => planSpeech(text, { mode }).skipped
  it('括号动作：不计括号与标点、空白', () => {
    expect(skipped('欢迎光临，请坐吧。（她擦了擦杯子， 笑了）今天想喝点什么？')).toEqual([0, 8])
  })
  it('星号动作', () => {
    expect(skipped('欢迎光临，请坐吧。*她擦杯子*今天想喝点什么？')).toEqual([0, 4])
  })
  it('一个间隔里有多段被跳过的文字时累加', () => {
    expect(skipped('欢迎光临，请坐吧。（她笑了）*点头*（转身）今天想喝点什么？')).toEqual([0, 3 + 2 + 2])
  })
  it('只换段没有被跳过的文字：0（gap 仍是 break）', () => {
    const plan = planSpeech('第一句话有十个字呢。\n第二句话有十个字呢。', { mode: 'lines' })
    expect(plan.gaps).toEqual(['none', 'break'])
    expect(plan.skipped).toEqual([0, 0])
  })
  it('inline 与第一句为 0；all 模式没有被跳过的文字', () => {
    expect(skipped('欢迎光临，请坐吧。今天想喝点什么？')).toEqual([0, 0])
    expect(skipped('第一句话有十个字呢。\n\n第二句话有十个字呢。', 'all')).toEqual([0, 0])
  })
  it('开头的动作不计入第一句；截断时与 sentences 等长', () => {
    const plan = planSpeech('（笑）第一句话有十个字呢。（挥手）第二句话有十个字呢。第三句话有十个字呢。', { mode: 'lines', maxTotal: 25 })
    expect(plan.sentences).toHaveLength(2)
    expect(plan.skipped).toEqual([0, 2])
  })
})

describe('breakPauseSeconds', () => {
  const near = (m: number, want: number, P = 2.5) => expect(Math.abs(breakPauseSeconds(m, P) - want)).toBeLessThan(0.001)
  it('P=2.5 的参考点', () => {
    near(3, 1.11497); near(4, 1.30068); near(6, 1.64590); near(12, 2.5); near(24, 3.61111); near(40, 4.36569)
    expect(breakPauseSeconds(200, 2.5)).toBeGreaterThan(4.99)
    expect(breakPauseSeconds(200, 2.5)).toBeLessThanOrEqual(5)
  })
  it('n=0 按 4 个字算', () => {
    expect(PARAGRAPH_PAUSE_CHARS).toBe(4)
    expect(breakPauseSeconds(0, 2.5)).toBe(breakPauseSeconds(4, 2.5))
    expect(PAUSE_BASE_CHARS).toBe(12)
  })
  it('单调不减、不低于下限、不超过上限', () => {
    let prev = 0
    for (let n = 1; n <= 500; n++) {
      const v = breakPauseSeconds(n, 2.5)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(v).toBeGreaterThanOrEqual(MIN_PAUSE_SECONDS)
      expect(v).toBeLessThanOrEqual(5)
      prev = v
    }
  })
  it('P=0 不停；P 不大于下限时一律停 P', () => {
    expect(breakPauseSeconds(30, 0)).toBe(0)
    expect(breakPauseSeconds(0, 0)).toBe(0)
    expect(breakPauseSeconds(30, 0.3)).toBe(0.3)
    expect(breakPauseSeconds(2, MIN_PAUSE_SECONDS)).toBe(MIN_PAUSE_SECONDS)
  })
  it('P=5 时上限为 10；P=10 时恒为 10；P=9 不超过 10', () => {
    near(12, 5, 5)
    expect(breakPauseSeconds(100000, 5)).toBeLessThanOrEqual(10)
    expect(breakPauseSeconds(100000, 5)).toBeGreaterThan(9.99)
    expect(breakPauseSeconds(0, 10)).toBe(10)
    expect(breakPauseSeconds(100000, 9)).toBeLessThanOrEqual(10)
    near(12, 9, 9)
  })
})
