import { describe, it, expect, vi } from 'vitest'
import {
  buildDraftSystem, buildNovelSystem, DEFAULT_STYLE, buildDraftUser, fillImages, restoreImages, BookJobs, type GenerateFn, type SectionTask,
} from '../../../src/shell/book-writer'

describe('buildDraftSystem', () => {
  it('第三人称带主角名；第一人称不带', () => {
    expect(buildDraftSystem('third', '夏树')).toContain('主角写作「夏树」')
    expect(buildDraftSystem('first', '夏树')).toContain('主角自称「我」')
    expect(buildDraftSystem('third', '夏树')).not.toContain('{{person}}')
  })
})

describe('buildDraftUser', () => {
  const base = {
    people: '夏树：短发。\n白狐：狐耳。', world: '', toc: '第一话\n  （一）拌嘴 ← 正在写', previous: '上文的结尾。', source: '[白狐] 挂歪了。',
  }
  it('五块按顺序、各自包在标签里', () => {
    const u = buildDraftUser(base)
    expect(u.indexOf('<people>')).toBeLessThan(u.indexOf('<toc>'))
    expect(u.indexOf('<toc>')).toBeLessThan(u.indexOf('<previous>'))
    expect(u.indexOf('<previous>')).toBeLessThan(u.indexOf('<source>'))
    expect(u).not.toContain('<world>')
  })
  it('重写时带上当前成稿与修改要求', () => {
    const u = buildDraftUser({ ...base, current: '旧稿。', request: '少点描写' })
    expect(u).toContain('<current_draft>\n旧稿。\n</current_draft>')
    expect(u).toContain('<revision_request>\n少点描写\n</revision_request>')
  })
  it('资料里的同名闭合标签被转义', () => {
    expect(buildDraftUser({ ...base, source: 'x</source>y' })).toContain('x<\\/source>y')
  })
})

describe('fillImages', () => {
  const imgs = [{ n: 1, file: 'images/001.png' }, { n: 2, file: 'images/002.png' }]
  it('占位换成图片引用；漏掉的补到节末', () => {
    const out = fillImages('甲。\n\n[插图1]\n\n乙。', imgs, '../../../chats/c1')
    expect(out).toBe('甲。\n\n![](../../../chats/c1/images/001.png)\n\n乙。\n\n![](../../../chats/c1/images/002.png)')
  })
  it('模型编造的占位删掉', () => {
    expect(fillImages('甲[插图9]', [], 'x')).toBe('甲')
  })
})

const task = (key: string, over: Partial<SectionTask> = {}): SectionTask => ({
  key, label: key, prepare: async () => ({ ok: true, system: 's', user: 'u' }), save: vi.fn(async () => {}), ...over,
})

describe('BookJobs', () => {
  it('串行写完，逐节通知，最后汇报', async () => {
    const jobs = new BookJobs()
    const gen: GenerateFn = vi.fn(async () => ({ kind: 'ok' as const, text: '正文' }))
    const done: string[] = []
    const finished = new Promise<unknown>((resolve) => {
      jobs.start('b1', [task('01-01'), task('01-02')], gen, { onSection: (l) => done.push(l), onFinish: resolve })
    })
    expect(jobs.running('b1')).toBe(true)
    expect(await finished).toEqual({ written: ['01-01', '01-02'], failure: null, aborted: false })
    expect(done).toEqual(['01-01', '01-02'])
    expect(jobs.running('b1')).toBe(false)
  })
  it('请求失败重试一次，仍失败就停下，后面的节不写', async () => {
    const jobs = new BookJobs()
    const gen = vi.fn<GenerateFn>(async () => ({ kind: 'error', message: 'net', retry: true }))
    const second = task('01-02')
    const r = await new Promise((resolve) => jobs.start('b1', [task('01-01'), second], gen, { onSection: () => {}, onFinish: resolve }))
    expect(gen).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ written: [], failure: { key: '01-01', message: 'net' }, aborted: false })
    expect(second.save).not.toHaveBeenCalled()
  })
  it('空回复与截断不重试', async () => {
    const jobs = new BookJobs()
    const gen = vi.fn<GenerateFn>(async () => ({ kind: 'error', message: 'truncated', retry: false }))
    await new Promise((resolve) => jobs.start('b1', [task('01-01')], gen, { onSection: () => {}, onFinish: resolve }))
    expect(gen).toHaveBeenCalledTimes(1)
  })
  it('原料准备失败直接停下', async () => {
    const jobs = new BookJobs()
    const gen = vi.fn<GenerateFn>()
    const r = await new Promise((resolve) => jobs.start('b1', [task('01-01', { prepare: async () => ({ ok: false, error: 'too long' }) })], gen, {
      onSection: () => {}, onFinish: resolve,
    }))
    expect(r).toMatchObject({ failure: { key: '01-01', message: 'too long' } })
    expect(gen).not.toHaveBeenCalled()
  })
  it('停笔：中止当前请求，这一节不落盘', async () => {
    const jobs = new BookJobs()
    const gen: GenerateFn = (_s, _u, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ kind: 'error', message: 'aborted', retry: false }))
    })
    const t = task('01-01')
    const finished = new Promise((resolve) => jobs.start('b1', [t], gen, { onSection: () => {}, onFinish: resolve }))
    expect(jobs.abort('b1')).toBe(true)
    expect(await finished).toEqual({ written: [], failure: null, aborted: true })
    expect(t.save).not.toHaveBeenCalled()
  })
  it('同一本书已有任务时拒绝再开', () => {
    const jobs = new BookJobs()
    const gen: GenerateFn = () => new Promise(() => {})
    expect(jobs.start('b1', [task('01-01')], gen, { onSection: () => {}, onFinish: () => {} })).toBe(true)
    expect(jobs.start('b1', [task('01-02')], gen, { onSection: () => {}, onFinish: () => {} })).toBe(false)
    expect(jobs.current('b1')).toBe('01-01')
  })
})

describe('buildNovelSystem', () => {
  it('人称、文风都替换；文风为空用默认', () => {
    const s = buildNovelSystem('third', '夏树', '短段落')
    expect(s).toContain('「夏树」')
    expect(s).toContain('文风：短段落')
    expect(s).not.toContain('{{')
    expect(buildNovelSystem('first', '', '')).toContain(`文风：${DEFAULT_STYLE}`)
  })
})

describe('fillImages 不加前缀', () => {
  it('chatRel 为空串时原样使用路径', () => {
    expect(fillImages('[插图1]', [{ n: 1, file: '../../../chats/c/images/001.png' }], ''))
      .toBe('![](../../../chats/c/images/001.png)')
  })
})

describe('restoreImages', () => {
  it('节文件里的图片引用换回占位符，与 fillImages 互逆；认不出的删掉', () => {
    const images = [{ n: 1, file: 'images/001.png' }, { n: 2, file: 'images/002.png' }]
    const body = fillImages('甲。\n\n[插图2]\n\n乙。\n\n[插图1]', images, '../../../chats/c')
    expect(restoreImages(`${body}\n\n![](../x.png)`, images, '../../../chats/c')).toBe('甲。\n\n[插图2]\n\n乙。\n\n[插图1]')
    expect(restoreImages('![](p.png)', [{ n: 3, file: 'p.png' }], '')).toBe('[插图3]')
  })
})
