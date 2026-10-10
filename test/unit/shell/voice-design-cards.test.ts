import { describe, expect, it } from 'vitest'
import {
  voiceDesignDownloadQuestion, voiceDesignListQuestion, voiceDesignPickQuestion, type VoiceDesignListInfo,
} from '../../../src/shell/receipts'

/** 宿主对 detail 做 Markdown 排版：相邻的非空行只有都是列表项时才会分行，否则折成一段。 */
function collapsedPairs(detail: string): string[] {
  const lines = detail.split('\n')
  const bad: string[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1]!
    const b = lines[i]!
    if (a !== '' && b !== '' && !(a.startsWith('- ') && b.startsWith('- '))) bad.push(`${a} / ${b}`)
  }
  return bad
}

const base = (over: Partial<VoiceDesignListInfo> = {}): VoiceDesignListInfo => ({
  name: '白狐', description: '清冷的少女声', sampleText: '今晚月色很好。',
  clips: [{ seconds: 5, file: '/t/1.wav' }, { seconds: 6, file: '/t/2.wav' }, { seconds: 7, file: '/t/3.wav' }],
  replacing: false, canPlay: true, canRegenerate: true, ...over,
})

describe('音色设计卡片的 detail 排版', () => {
  it.each([
    ['新角色', base()],
    ['已有音色', base({ replacing: true })],
    ['无播放器', base({ canPlay: false })],
    ['无播放器且已有音色', base({ canPlay: false, replacing: true })],
  ])('试听列表卡（%s）：没有会被折成一段的相邻行', (_n, info) => {
    expect(collapsedPairs(voiceDesignListQuestion(info).detail ?? '')).toEqual([])
  })

  it('试听卡：角色、描述、台词各占一个列表项', () => {
    const d = voiceDesignListQuestion(base()).detail ?? ''
    expect(d).toContain('- 角色：白狐')
    expect(d).toContain('- 音色描述：清冷的少女声')
    expect(d).toContain('- 试听台词：今晚月色很好。')
  })

  it('已有音色的提醒并进已有的一行，不增加行数；选项顺序与文案不变', () => {
    const plain = voiceDesignListQuestion(base())
    const rep = voiceDesignListQuestion(base({ replacing: true }))
    expect((rep.detail ?? '').split('\n').length).toBe((plain.detail ?? '').split('\n').length)
    expect(rep.detail).toContain('采用后会替换现有的声音')
    expect(plain.detail).not.toContain('替换')
    expect(rep.options.map((o) => o.label)).toEqual(plain.options.map((o) => o.label))
    expect(rep.options.map((o) => o.label)).toEqual(['第 1 段', '第 2 段', '第 3 段', '重新生成', '取消'])
  })

  it.each([[true, true], [true, false], [false, true], [false, false]])('单段卡片（canPlay=%s，replacing=%s）排版正常', (canPlay, replacing) => {
    const q = voiceDesignPickQuestion({ n: 2, seconds: 6, file: '/t/2.wav', canPlay, replacing })
    expect(collapsedPairs(q.detail ?? '')).toEqual([])
    if (replacing) expect(q.detail).toContain('采用后会替换现有的声音')
  })

  it('下载确认卡排版正常', () => {
    expect(collapsedPairs(voiceDesignDownloadQuestion({ modelsDir: '/d', hfEndpoint: undefined }).detail ?? '')).toEqual([])
  })
})
