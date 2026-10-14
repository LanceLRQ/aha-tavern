// 群聊梗概渲染与解析（#b5j3、二期规格 §10.2）的单元测试。
import { describe, expect, it } from 'vitest'
import { parseSummaryText, renderSummaryText, sceneLabel, upsertScene, type ShowSummary } from '../../../src/core/summary'

describe('sceneLabel', () => {
  it('一到二十用中文，再往后退回数字', () => {
    expect(sceneLabel(1)).toBe('一')
    expect(sceneLabel(10)).toBe('十')
    expect(sceneLabel(11)).toBe('十一')
    expect(sceneLabel(19)).toBe('十九')
    expect(sceneLabel(21)).toBe('21')
  })
})

describe('renderSummaryText / parseSummaryText', () => {
  it('收场前：只有场景小节，没有 # 头', () => {
    const show: ShowSummary = {
      title: null,
      scenes: [
        { index: 1, title: '酒馆大堂布置', cast: ['白狐', '青衫'], text: '白狐嫌青衫挂的灯笼歪。' },
      ],
    }
    const text = renderSummaryText(show)
    expect(text).toBe('## 场景一：酒馆大堂布置\n在场：白狐、青衫、我\n白狐嫌青衫挂的灯笼歪。\n')
    expect(parseSummaryText(text)).toEqual(show)
  })

  it('收场后：带标题与时间参与行；多场景往返', () => {
    const show: ShowSummary = {
      title: '生日派对',
      started: '2026-10-10',
      participants: ['白狐', '青衫'],
      scenes: [
        { index: 1, title: '酒馆大堂布置', cast: ['白狐', '青衫'], text: '布置大堂，拌了几句嘴。' },
        { index: 2, title: null, cast: ['白狐'], text: '切蛋糕，青衫不在场。' },
      ],
    }
    const text = renderSummaryText(show)
    expect(text).toContain('# 生日派对')
    expect(text).toContain('时间：2026-10-10　参与：白狐、青衫')
    expect(text).toContain('## 场景二\n')
    expect(parseSummaryText(text)).toEqual(show)
  })

  it('小节标题带冒号、正文多行也能还原', () => {
    const show: ShowSummary = {
      title: null,
      scenes: [{ index: 1, title: '夜话：下半场', cast: [], text: '第一行\n第二行' }],
    }
    expect(parseSummaryText(renderSummaryText(show))).toEqual(show)
  })

  it('upsertScene：同序号替换，异序号追加后按序号排序', () => {
    const base: ShowSummary = { title: null, scenes: [{ index: 1, title: '一', cast: [], text: 'a' }] }
    const replaced = upsertScene(base, { index: 1, title: '一改', cast: [], text: 'b' })
    expect(replaced.scenes).toHaveLength(1)
    expect(replaced.scenes[0]!.text).toBe('b')
    const appended = upsertScene(replaced, { index: 3, title: '三', cast: [], text: 'c' })
    const middle = upsertScene(appended, { index: 2, title: '二', cast: [], text: 'd' })
    expect(middle.scenes.map((s) => s.index)).toEqual([1, 2, 3])
  })
})
