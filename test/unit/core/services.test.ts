import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadImageService, type ImageServiceSettings } from '../../../src/core/services'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-services-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function load(content: string | null) {
  const file = path.join(dir, 'services.yaml')
  if (content !== null) await fs.writeFile(file, content, 'utf8')
  return loadImageService(file)
}

const configured = (r: Awaited<ReturnType<typeof load>>): { settings: ImageServiceSettings; problems: string[] } => {
  if (!r.configured) throw new Error('应为已配置')
  return r
}

describe('loadImageService：未配置', () => {
  it('文件不存在', async () => {
    expect(await load(null)).toEqual({ configured: false, problems: [] })
  })
  it('空文件', async () => {
    expect(await load('')).toEqual({ configured: false, problems: [] })
    expect(await load('  \n')).toEqual({ configured: false, problems: [] })
  })
  it('没有 image', async () => {
    expect(await load('voice:\n  endpoint: http://x\n')).toEqual({ configured: false, problems: [] })
  })
  it('没有 endpoint', async () => {
    expect(await load('image:\n  steps: 8\n')).toEqual({ configured: false, problems: [] })
  })
  it('endpoint 不是 http(s) 地址：未配置并给出问题', async () => {
    const r = await load('image:\n  endpoint: ftp://x\n')
    expect(r.configured).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('endpoint')
  })
  it('YAML 语法错误：未配置，问题里说明解析失败', async () => {
    const r = await load('image: [unclosed\n  endpoint: : :\n')
    expect(r.configured).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('解析失败')
  })
})

describe('loadImageService：已配置', () => {
  it('只给 endpoint：其余取默认值', async () => {
    const { settings, problems } = configured(await load('image:\n  endpoint: http://127.0.0.1:8188\n'))
    expect(problems).toEqual([])
    expect(settings).toEqual({
      endpoint: 'http://127.0.0.1:8188',
      workflow: 'qwen-image-2.1',
      auto: true,
      style: '动漫风格插画，线条干净，光影柔和',
      width: 832,
      height: 1216,
      steps: 12,
      timeoutSeconds: 180,
      models: {},
    })
  })

  it('endpoint 去掉末尾斜杠', async () => {
    const { settings } = configured(await load('image:\n  endpoint: https://h:8188//\n'))
    expect(settings.endpoint).toBe('https://h:8188')
  })

  it('全部字段有效时原样采用', async () => {
    const { settings, problems } = configured(
      await load(
        [
          'image:',
          '  endpoint: http://h',
          '  workflow: /abs/wf.json',
          '  auto: false',
          '  style: 水彩',
          '  width: 1024',
          '  height: 768',
          '  steps: 20',
          '  timeoutSeconds: 60',
          '  models:',
          '    unet: a.gguf',
          '    clip: b.safetensors',
          '    vae: c.safetensors',
        ].join('\n'),
      ),
    )
    expect(problems).toEqual([])
    expect(settings).toMatchObject({
      workflow: '/abs/wf.json',
      auto: false,
      style: '水彩',
      width: 1024,
      height: 768,
      steps: 20,
      timeoutSeconds: 60,
      models: { unet: 'a.gguf', clip: 'b.safetensors', vae: 'c.safetensors' },
    })
  })

  it('宽高向下取到 32 的倍数且不小于 256', async () => {
    const a = configured(await load('image:\n  endpoint: http://h\n  width: 850\n  height: 1230\n'))
    expect(a.settings.width).toBe(832)
    expect(a.settings.height).toBe(1216)
    const b = configured(await load('image:\n  endpoint: http://h\n  width: 100\n  height: 255\n'))
    expect(b.settings.width).toBe(256)
    expect(b.settings.height).toBe(256)
  })

  it('字段类型不对：回落默认值，问题清单逐条记录', async () => {
    const { settings, problems } = configured(
      await load(
        [
          'image:',
          '  endpoint: http://h',
          '  workflow: 123',
          '  auto: "yes"',
          '  style: 5',
          '  width: 1.5',
          '  height: -3',
          '  steps: abc',
          '  timeoutSeconds: 0',
        ].join('\n'),
      ),
    )
    expect(settings).toMatchObject({
      workflow: 'qwen-image-2.1',
      auto: true,
      style: '动漫风格插画，线条干净，光影柔和',
      width: 832,
      height: 1216,
      steps: 12,
      timeoutSeconds: 180,
    })
    for (const key of ['workflow', 'auto', 'style', 'width', 'height', 'steps', 'timeoutSeconds']) {
      expect(problems.some((p) => p.includes(key))).toBe(true)
    }
    expect(problems).toHaveLength(7)
  })

  it('workflow 既不是内置名也不是绝对路径时，作为内置名保留（由使用处判断是否存在）', async () => {
    const { settings } = configured(await load('image:\n  endpoint: http://h\n  workflow: qwen-image-2.1-gguf\n'))
    expect(settings.workflow).toBe('qwen-image-2.1-gguf')
  })

  it('workflow 是相对路径：回落默认值并提示', async () => {
    const { settings, problems } = configured(await load('image:\n  endpoint: http://h\n  workflow: ./wf.json\n'))
    expect(settings.workflow).toBe('qwen-image-2.1')
    expect(problems.some((p) => p.includes('workflow'))).toBe(true)
  })

  it('models 只接受 unet / clip / vae 三个字符串键', async () => {
    const { settings, problems } = configured(
      await load('image:\n  endpoint: http://h\n  models:\n    unet: a.gguf\n    lora: x\n    vae: 3\n'),
    )
    expect(settings.models).toEqual({ unet: 'a.gguf' })
    expect(problems.some((p) => p.includes('models.vae'))).toBe(true)
    expect(problems.some((p) => p.includes('models.lora'))).toBe(true)
  })

  it('models 不是映射：忽略并提示', async () => {
    const { settings, problems } = configured(await load('image:\n  endpoint: http://h\n  models: [a]\n'))
    expect(settings.models).toEqual({})
    expect(problems.some((p) => p.includes('models'))).toBe(true)
  })

  it('问题清单不回显字段值：问题文字里不出现字段值', async () => {
    const { problems } = configured(await load('image:\n  endpoint: http://h\n  style: 5\n  steps: secret-token\n'))
    expect(problems.join('')).not.toContain('secret-token')
  })
})
