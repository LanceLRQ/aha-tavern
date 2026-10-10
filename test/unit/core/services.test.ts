import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_VOICE_PAUSE_SECONDS, MAX_VOICE_TIMEOUT_SECONDS,
  VOICE_DESIGN_MODEL,
  VOICE_MODELS,
  VOICE_SERVICE_DEFAULTS,
  hasUserInfo,
  loadImageService,
  loadVoiceService,
  type ImageServiceSettings,
  type VoiceServiceSettings,
} from '../../../src/core/services'

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

const DEFAULT_DIR = '/data/tavern/voice'

async function loadVoice(content: string | null) {
  const file = path.join(dir, 'services.yaml')
  if (content !== null) await fs.writeFile(file, content, 'utf8')
  return loadVoiceService(file, { defaultModelsDir: DEFAULT_DIR })
}

const voiceOk = (r: Awaited<ReturnType<typeof loadVoice>>): { settings: VoiceServiceSettings; problems: string[] } => {
  if (!r.configured) throw new Error('应为已配置')
  return r
}

describe('loadVoiceService：未配置', () => {
  it('文件不存在 / 空文件', async () => {
    expect(await loadVoice(null)).toEqual({ configured: false, problems: [] })
    expect(await loadVoice('  \n')).toEqual({ configured: false, problems: [] })
  })
  it('没有 voice', async () => {
    expect(await loadVoice('image:\n  endpoint: http://x\n')).toEqual({ configured: false, problems: [] })
  })
  it('没有 endpoint', async () => {
    expect(await loadVoice('voice:\n  launch: mlx\n')).toEqual({ configured: false, problems: [] })
  })
  it('voice 不是映射', async () => {
    const r = await loadVoice('voice: [a]\n')
    expect(r.configured).toBe(false)
    expect(r.problems[0]).toContain('voice')
  })
  it('endpoint 不是 http(s) 地址', async () => {
    const r = await loadVoice('voice:\n  endpoint: ftp://x\n')
    expect(r.configured).toBe(false)
    expect(r.problems[0]).toContain('voice.endpoint')
  })
  it('YAML 解析失败：两节都未配置并各自带解析失败', async () => {
    const text = 'voice: [unclosed\n  endpoint: : :\n'
    const v = await loadVoice(text)
    const i = await load(text)
    for (const r of [v, i]) {
      expect(r.configured).toBe(false)
      expect(r.problems[0]).toContain('解析失败')
    }
  })
})

describe('两节互不影响', () => {
  it('voice 写错不影响 image，image 写错不影响 voice', async () => {
    const text = 'image:\n  endpoint: http://i\n  steps: abc\nvoice:\n  endpoint: http://127.0.0.1:1\n  read: 5\n'
    const i = configured(await load(text))
    const v = voiceOk(await loadVoice(text))
    expect(i.problems).toHaveLength(1)
    expect(i.problems[0]).toContain('image.steps')
    expect(v.problems).toHaveLength(1)
    expect(v.problems[0]).toContain('voice.read')
  })
  it('只写了 voice 时 image 未配置，反之亦然', async () => {
    expect((await load('voice:\n  endpoint: http://x\n')).configured).toBe(false)
    expect((await loadVoice('image:\n  endpoint: http://x\n')).configured).toBe(false)
  })
})

describe('loadVoiceService：timeoutSeconds 封顶', () => {
  it('恰好等于上限时采用，超过上限按写错处理', async () => {
    const ok = voiceOk(await loadVoice(`voice:\n  endpoint: http://127.0.0.1:1\n  timeoutSeconds: ${MAX_VOICE_TIMEOUT_SECONDS}\n`))
    expect(ok.settings.timeoutSeconds).toBe(MAX_VOICE_TIMEOUT_SECONDS)
    expect(ok.problems).toEqual([])
    const bad = voiceOk(await loadVoice(`voice:\n  endpoint: http://127.0.0.1:1\n  timeoutSeconds: ${MAX_VOICE_TIMEOUT_SECONDS + 1}\n`))
    expect(bad.settings.timeoutSeconds).toBe(120)
    expect(bad.problems).toHaveLength(1)
    expect(bad.problems[0]).toContain('voice.timeoutSeconds')
    const huge = voiceOk(await loadVoice('voice:\n  endpoint: http://127.0.0.1:1\n  timeoutSeconds: 99999999\n'))
    expect(huge.settings.timeoutSeconds).toBe(120)
  })
})

describe('loadVoiceService：pauseSeconds', () => {
  const pause = async (v: string) => voiceOk(await loadVoice(`voice:\n  endpoint: http://127.0.0.1:1\n  pauseSeconds: ${v}\n`))
  it('没写用默认 2，且不记问题', async () => {
    const r = voiceOk(await loadVoice('voice:\n  endpoint: http://127.0.0.1:1\n'))
    expect(r.settings.pauseSeconds).toBe(2)
    expect(r.settings.pauseMinSeconds).toBe(1)
    expect(r.settings.pauseMaxSeconds).toBe(4)
    expect(r.problems).toEqual([])
  })
  it('0 到 10 之间的数字（含小数）采用', async () => {
    for (const [text, n] of [['0', 0], ['3', 3], ['1.5', 1.5]] as const) {
      const r = await pause(text)
      expect(r.settings.pauseSeconds).toBe(n)
      expect(r.problems).toEqual([])
    }
  })
  it('非数字或越界用默认值并记一条问题，不回显字段值', async () => {
    for (const text of ['abc', '-1', '10.5', '100', '"3"', '.nan']) {
      const r = await pause(text)
      expect(r.settings.pauseSeconds).toBe(2)
      expect(r.problems).toHaveLength(1)
      expect(r.problems[0]).toContain('voice.pauseSeconds')
    }
  })
})

describe('loadVoiceService：pauseMinSeconds / pauseMaxSeconds', () => {
  const load3 = async (body: string) => voiceOk(await loadVoice(`voice:\n  endpoint: http://127.0.0.1:1\n${body}`))
  it('合法值采用，不记问题', async () => {
    const r = await load3('  pauseSeconds: 3\n  pauseMinSeconds: 0.5\n  pauseMaxSeconds: 8\n')
    expect(r.settings).toMatchObject({ pauseSeconds: 3, pauseMinSeconds: 0.5, pauseMaxSeconds: 8 })
    expect(r.problems).toEqual([])
  })
  it('各自非数字或越界：用各自的默认值并记一条问题', async () => {
    for (const key of ['pauseMinSeconds', 'pauseMaxSeconds']) {
      for (const bad of ['abc', '-1', '10.5', '"2"']) {
        const r = await load3(`  ${key}: ${bad}\n`)
        expect(r.settings.pauseMinSeconds).toBe(1)
        expect(r.settings.pauseMaxSeconds).toBe(4)
        expect(r.problems).toHaveLength(1)
        expect(r.problems[0]).toContain(`voice.${key}`)
      }
    }
  })
  it('关系不对：记一条问题，min/max 按 pause 收拢，其余值保留', async () => {
    const r = await load3('  pauseSeconds: 2\n  pauseMinSeconds: 3\n  pauseMaxSeconds: 1.5\n')
    expect(r.settings).toMatchObject({ pauseSeconds: 2, pauseMinSeconds: 2, pauseMaxSeconds: 2 })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('voice.pauseMinSeconds / pauseMaxSeconds')
    expect(r.problems[0]).toContain('已按 pauseSeconds 收拢')
  })
  it('只有 min 偏大：只收拢 min', async () => {
    const r = await load3('  pauseSeconds: 0.5\n')
    expect(r.settings).toMatchObject({ pauseSeconds: 0.5, pauseMinSeconds: 0.5, pauseMaxSeconds: 4 })
    expect(r.problems).toHaveLength(1)
  })
  it('pauseSeconds 为 0 时不检查关系', async () => {
    const r = await load3('  pauseSeconds: 0\n  pauseMinSeconds: 3\n  pauseMaxSeconds: 1\n')
    expect(r.settings).toMatchObject({ pauseSeconds: 0, pauseMinSeconds: 3, pauseMaxSeconds: 1 })
    expect(r.problems).toEqual([])
  })
})

describe('loadVoiceService：已配置', () => {
  it('只给 endpoint：其余取默认值', async () => {
    const { settings, problems } = voiceOk(await loadVoice('voice:\n  endpoint: http://127.0.0.1:18123/\n'))
    expect(problems).toEqual([])
    expect(settings).toEqual({
      endpoint: 'http://127.0.0.1:18123',
      launch: 'none',
      model: VOICE_MODELS['0.6b'],
      modelAlias: '0.6b',
      modelsDir: DEFAULT_DIR,
      hfEndpoint: undefined,
      read: 'lines',
      language: 'chinese',
      timeoutSeconds: 120,
      pauseSeconds: 2,
      pauseMinSeconds: 1,
      pauseMaxSeconds: 4,
      port: 18123,
      local: true,
    })
    expect(VOICE_SERVICE_DEFAULTS).toMatchObject({ launch: 'none', model: '0.6b', read: 'lines', language: 'chinese', timeoutSeconds: 120, pauseSeconds: 2, pauseMinSeconds: 1, pauseMaxSeconds: 4 })
    expect(VOICE_DESIGN_MODEL).toBe('mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit')
  })

  it('全部字段有效时原样采用', async () => {
    const { settings, problems } = voiceOk(
      await loadVoice(
        [
          'voice:',
          '  endpoint: http://localhost:9000',
          '  launch: mlx',
          '  model: 1.7B',
          '  modelsDir: /abs/voice',
          '  hfEndpoint: https://hf-mirror.com/',
          '  read: all',
          '  language: english',
          '  timeoutSeconds: 30',
        ].join('\n'),
      ),
    )
    expect(problems).toEqual([])
    expect(settings).toMatchObject({
      launch: 'mlx',
      model: VOICE_MODELS['1.7b'],
      modelAlias: '1.7b',
      modelsDir: '/abs/voice',
      hfEndpoint: 'https://hf-mirror.com',
      read: 'all',
      language: 'english',
      timeoutSeconds: 30,
      port: 9000,
      local: true,
    })
  })

  it('模型名三种写法：简称（不分大小写）、完整名（去空白）、类型不对', async () => {
    expect(voiceOk(await loadVoice('voice:\n  endpoint: http://h\n  model: 0.6B\n')).settings).toMatchObject({
      model: VOICE_MODELS['0.6b'],
      modelAlias: '0.6b',
    })
    const full = voiceOk(await loadVoice('voice:\n  endpoint: http://h\n  model: " org/Some-Model "\n'))
    expect(full.settings.model).toBe('org/Some-Model')
    expect(full.settings.modelAlias).toBeUndefined()
    const bad = voiceOk(await loadVoice('voice:\n  endpoint: http://h\n  model: 5\n'))
    expect(bad.settings.model).toBe(VOICE_MODELS['0.6b'])
    expect(bad.problems.some((p) => p.includes('voice.model'))).toBe(true)
  })

  it('字段类型或取值不对：回落默认值并逐条记录', async () => {
    const { settings, problems } = voiceOk(
      await loadVoice(
        [
          'voice:',
          '  endpoint: http://h',
          '  launch: docker',
          '  read: some',
          '  language: 5',
          '  timeoutSeconds: 0',
          '  hfEndpoint: ftp://secret-mirror',
          '  modelsDir: relative/dir',
        ].join('\n'),
      ),
    )
    expect(settings).toMatchObject({
      launch: 'none',
      read: 'lines',
      language: 'chinese',
      timeoutSeconds: 120,
      hfEndpoint: undefined,
      modelsDir: DEFAULT_DIR,
    })
    for (const key of ['launch', 'read', 'language', 'timeoutSeconds', 'hfEndpoint', 'modelsDir']) {
      expect(problems.some((p) => p.includes(`voice.${key}`))).toBe(true)
    }
    expect(problems).toHaveLength(6)
    expect(problems.join('')).not.toContain('secret-mirror')
    expect(problems.join('')).not.toContain('relative/dir')
  })

  it('launch: mlx 配远程地址：改为 none 并记问题', async () => {
    const { settings, problems } = voiceOk(await loadVoice('voice:\n  endpoint: http://10.0.0.5:18123\n  launch: mlx\n'))
    expect(settings.launch).toBe('none')
    expect(settings.local).toBe(false)
    expect(problems.some((p) => p.includes('voice.launch'))).toBe(true)
  })

  it('本机地址：127.0.0.1、localhost、[::1]', async () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const { settings, problems } = voiceOk(await loadVoice(`voice:\n  endpoint: http://${host}:18123\n  launch: mlx\n`))
      expect(settings.local).toBe(true)
      expect(settings.launch).toBe('mlx')
      expect(problems).toEqual([])
    }
  })

  it('端口：没写时按协议默认', async () => {
    expect(voiceOk(await loadVoice('voice:\n  endpoint: http://h\n')).settings.port).toBe(80)
    expect(voiceOk(await loadVoice('voice:\n  endpoint: https://h\n')).settings.port).toBe(443)
  })

  it('modelsDir：默认值来自调用方，写了就用写的，~ 展开', async () => {
    expect(voiceOk(await loadVoice('voice:\n  endpoint: http://h\n')).settings.modelsDir).toBe(DEFAULT_DIR)
    const { settings, problems } = voiceOk(await loadVoice('voice:\n  endpoint: http://h\n  modelsDir: ~/aha-voice\n'))
    expect(settings.modelsDir).toBe(path.join(os.homedir(), 'aha-voice'))
    expect(problems).toEqual([])
  })

  it('带用户名密码的 endpoint 仍算已配置', async () => {
    expect(voiceOk(await loadVoice('voice:\n  endpoint: http://u:p@h:1\n')).settings.endpoint).toBe('http://u:p@h:1')
  })
})

describe('hasUserInfo', () => {
  it('识别地址里的用户名密码', () => {
    expect(hasUserInfo('http://u:p@h')).toBe(true)
    expect(hasUserInfo('http://u@h')).toBe(true)
    expect(hasUserInfo('http://h:80')).toBe(false)
    expect(hasUserInfo('not a url')).toBe(false)
  })
})
