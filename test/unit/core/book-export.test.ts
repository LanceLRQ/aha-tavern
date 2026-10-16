import { describe, it, expect } from 'vitest'
import { renderBook, rebaseImages } from '../../../src/core/book-export'

describe('renderBook', () => {
  it('书名、话标题、（一）小标题；未写的节占位', () => {
    const md = renderBook('生日那天', [
      { title: '第一话　灯笼', sections: [{ title: '', body: '甲。' }, { title: '切蛋糕', body: null }] },
    ])
    expect(md).toBe('# 生日那天\n\n## 第一话　灯笼\n\n### （一）\n\n甲。\n\n### （二）切蛋糕\n\n（本节未写）\n')
  })
})

describe('rebaseImages', () => {
  it('把相对节文件的图片路径换成相对导出文件的', () => {
    const body = '甲\n\n![](../../../chats/c1/images/001.png)\n\n乙'
    expect(rebaseImages(body, '/t/books/b1/draft', '/t/books/b1')).toBe('甲\n\n![](../../chats/c1/images/001.png)\n\n乙')
  })
  it('外部链接与绝对路径不动', () => {
    const body = '![](https://x/y.png) ![](/abs/z.png)'
    expect(rebaseImages(body, '/a/b', '/a')).toBe(body)
  })
})
