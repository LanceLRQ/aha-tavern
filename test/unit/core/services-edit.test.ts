import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadImageService, loadVoiceService } from '../../../src/core/services'
import {
  ServicesEditError, parseImageForm, parseVoiceForm, readServicesForm, updateServicesFile,
} from '../../../src/core/services-edit'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-services-edit-'))
  file = path.join(dir, 'services.yaml')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const okEdit = (r: ReturnType<typeof parseVoiceForm>) => {
  if (!r.ok) throw new Error(`应通过：${JSON.stringify(r.errors)}`)
  return r.edit
}
const errorsOf = (r: ReturnType<typeof parseVoiceForm>) => {
  if (r.ok) throw new Error('应不通过')
  return r.errors
}

describe('parseVoiceForm：入参校验', () => {
  const base = { endpoint: 'http://127.0.0.1:18123' }

  it('不是对象就拒绝', () => {
    expect(parseVoiceForm(null).ok).toBe(false)
    expect(parseVoiceForm('x').ok).toBe(false)
    expect(parseVoiceForm([]).ok).toBe(false)
  })

  it('endpoint 必填，且必须是 http(s) 地址', () => {
    expect(errorsOf(parseVoiceForm({}))).toHaveProperty('endpoint')
    expect(errorsOf(parseVoiceForm({ endpoint: '' }))).toHaveProperty('endpoint')
    expect(errorsOf(parseVoiceForm({ endpoint: 'ftp://x' }))).toHaveProperty('endpoint')
    expect(errorsOf(parseVoiceForm({ endpoint: 'file:///etc/passwd' }))).toHaveProperty('endpoint')
    expect(errorsOf(parseVoiceForm({ endpoint: 'http://a b' }))).toHaveProperty('endpoint')
    expect(errorsOf(parseVoiceForm({ endpoint: 123 }))).toHaveProperty('endpoint')
  })

  it('地址带用户名密码被拒绝，错误信息不回显地址', () => {
    const e = errorsOf(parseVoiceForm({ endpoint: 'http://user:secret@127.0.0.1:1' }))
    expect(e.endpoint).toBeTruthy()
    expect(JSON.stringify(e)).not.toContain('secret')
  })

  it('地址里夹控制字符被拒绝', () => {
    expect(errorsOf(parseVoiceForm({ endpoint: 'http://127.0.0.1:1/\u0000x' }))).toHaveProperty('endpoint')
  })

  it('最小输入通过，去掉末尾斜杠，其余字段不写', () => {
    const edit = okEdit(parseVoiceForm({ endpoint: ' http://127.0.0.1:18123/// ' }))
    expect(edit.set).toEqual({ endpoint: 'http://127.0.0.1:18123' })
    expect(edit.remove).toEqual([])
  })

  it('launch 只认 mlx 与 none；mlx 要求本机地址', () => {
    expect(okEdit(parseVoiceForm({ ...base, launch: 'mlx' })).set.launch).toBe('mlx')
    expect(okEdit(parseVoiceForm({ ...base, launch: 'none' })).set.launch).toBe('none')
    expect(errorsOf(parseVoiceForm({ ...base, launch: 'docker' }))).toHaveProperty('launch')
    expect(errorsOf(parseVoiceForm({ endpoint: 'http://192.168.1.2:1', launch: 'mlx' }))).toHaveProperty('launch')
    expect(okEdit(parseVoiceForm({ endpoint: 'http://localhost:1', launch: 'mlx' })).set.launch).toBe('mlx')
  })

  it('model：简称、完整模型名可以，乱写不行；空串表示恢复默认', () => {
    expect(okEdit(parseVoiceForm({ ...base, model: '1.7b' })).set.model).toBe('1.7b')
    expect(okEdit(parseVoiceForm({ ...base, model: 'mlx-community/Some-Model_8bit' })).set.model).toBe('mlx-community/Some-Model_8bit')
    expect(errorsOf(parseVoiceForm({ ...base, model: '../../etc' }))).toHaveProperty('model')
    for (const bad of ['a/..', '../x', './x', 'a/.', '.hidden/x', 'org/.x', 'org/name/extra', 'plain', 'org/', '/name']) {
      expect(errorsOf(parseVoiceForm({ ...base, model: bad })), bad).toHaveProperty('model')
    }
    expect(errorsOf(parseVoiceForm({ ...base, model: 'a b' }))).toHaveProperty('model')
    expect(okEdit(parseVoiceForm({ ...base, model: '' })).remove).toContain('model')
  })

  it('modelsDir：绝对路径或 ~ 开头；相对路径、.. 、控制字符被拒绝', () => {
    expect(okEdit(parseVoiceForm({ ...base, modelsDir: '/data/voice' })).set.modelsDir).toBe('/data/voice')
    expect(okEdit(parseVoiceForm({ ...base, modelsDir: '~/voice' })).set.modelsDir).toBe('~/voice')
    expect(errorsOf(parseVoiceForm({ ...base, modelsDir: 'voice' }))).toHaveProperty('modelsDir')
    expect(errorsOf(parseVoiceForm({ ...base, modelsDir: '/data/../etc' }))).toHaveProperty('modelsDir')
    expect(errorsOf(parseVoiceForm({ ...base, modelsDir: '/data/\u0000x' }))).toHaveProperty('modelsDir')
    expect(okEdit(parseVoiceForm({ ...base, modelsDir: '  ' })).remove).toContain('modelsDir')
  })

  it('hfEndpoint：http(s) 地址、不带账号；空串表示不用镜像', () => {
    expect(okEdit(parseVoiceForm({ ...base, hfEndpoint: 'https://hf-mirror.com/' })).set.hfEndpoint).toBe('https://hf-mirror.com')
    expect(errorsOf(parseVoiceForm({ ...base, hfEndpoint: 'hf-mirror.com' }))).toHaveProperty('hfEndpoint')
    expect(errorsOf(parseVoiceForm({ ...base, hfEndpoint: 'https://u:p@hf-mirror.com' }))).toHaveProperty('hfEndpoint')
    expect(okEdit(parseVoiceForm({ ...base, hfEndpoint: '' })).remove).toContain('hfEndpoint')
  })

  it('read、language、timeoutSeconds', () => {
    const edit = okEdit(parseVoiceForm({ ...base, read: 'all', language: 'english', timeoutSeconds: '90' }))
    expect(edit.set).toMatchObject({ read: 'all', language: 'english', timeoutSeconds: 90 })
    expect(errorsOf(parseVoiceForm({ ...base, read: 'some' }))).toHaveProperty('read')
    expect(errorsOf(parseVoiceForm({ ...base, language: 'zh; rm -rf' }))).toHaveProperty('language')
    expect(errorsOf(parseVoiceForm({ ...base, timeoutSeconds: 0 }))).toHaveProperty('timeoutSeconds')
    expect(errorsOf(parseVoiceForm({ ...base, timeoutSeconds: 1.5 }))).toHaveProperty('timeoutSeconds')
    expect(errorsOf(parseVoiceForm({ ...base, timeoutSeconds: 99999 }))).toHaveProperty('timeoutSeconds')
    expect(errorsOf(parseVoiceForm({ ...base, timeoutSeconds: 'abc' }))).toHaveProperty('timeoutSeconds')
  })

  it('页面不认识的键被忽略，不会写进文件', () => {
    const edit = okEdit(parseVoiceForm({ ...base, evil: 'x', __proto__: { a: 1 } }))
    expect(Object.keys(edit.set)).toEqual(['endpoint'])
  })
})

describe('parseVoiceForm：只提交改动过的字段', () => {
  it('没传 endpoint 但给了当前地址：不写 endpoint，也不报必填', () => {
    const r = parseVoiceForm({ read: 'all' }, { currentEndpoint: 'http://127.0.0.1:18123' })
    expect(okEdit(r).set).toEqual({ read: 'all' })
  })
  it('launch 为 mlx 时按当前地址判断是否本机', () => {
    expect(errorsOf(parseVoiceForm({ launch: 'mlx' }, { currentEndpoint: 'http://192.168.1.2:1' }))).toHaveProperty('launch')
    expect(okEdit(parseVoiceForm({ launch: 'mlx' }, { currentEndpoint: 'http://localhost:1' })).set.launch).toBe('mlx')
  })
  it('没有当前地址、也没传：仍然必填', () => {
    expect(errorsOf(parseVoiceForm({ read: 'all' }, { currentEndpoint: '' }))).toHaveProperty('endpoint')
  })
  it('传了空 endpoint 是错误，不会被当成"没改"', () => {
    expect(errorsOf(parseVoiceForm({ endpoint: '' }, { currentEndpoint: 'http://127.0.0.1:1' }))).toHaveProperty('endpoint')
  })
  it('生图同理', () => {
    expect(okEdit(parseImageForm({ width: 640 }, { currentEndpoint: 'http://h:1' }) as any).set).toEqual({ width: 640 })
  })
})

describe('parseImageForm：入参校验', () => {
  const base = { endpoint: 'http://192.168.1.5:8188' }
  const okI = (r: ReturnType<typeof parseImageForm>) => {
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return r.edit
  }

  it('endpoint 必填，不带账号', () => {
    expect(parseImageForm({}).ok).toBe(false)
    expect(parseImageForm({ endpoint: 'http://u:p@h:1' }).ok).toBe(false)
    expect(okI(parseImageForm(base)).set).toEqual({ endpoint: 'http://192.168.1.5:8188' })
  })

  it('workflow：内置名或绝对路径；带分隔符的相对写法被拒绝', () => {
    expect(okI(parseImageForm({ ...base, workflow: 'qwen-image-2.1' })).set.workflow).toBe('qwen-image-2.1')
    expect(okI(parseImageForm({ ...base, workflow: '/data/wf.json' })).set.workflow).toBe('/data/wf.json')
    expect(parseImageForm({ ...base, workflow: '../wf' }).ok).toBe(false)
    expect(parseImageForm({ ...base, workflow: 'a/b' }).ok).toBe(false)
    expect(parseImageForm({ ...base, workflow: '/data/../wf.json' }).ok).toBe(false)
  })

  it('auto 必须是布尔值', () => {
    expect(okI(parseImageForm({ ...base, auto: false })).set.auto).toBe(false)
    expect(okI(parseImageForm({ ...base, auto: 'true' })).set.auto).toBe(true)
    expect(parseImageForm({ ...base, auto: 'maybe' }).ok).toBe(false)
  })

  it('数值范围', () => {
    expect(okI(parseImageForm({ ...base, width: 832, height: '1216', steps: 8, timeoutSeconds: 60 })).set).toMatchObject({
      width: 832, height: 1216, steps: 8, timeoutSeconds: 60,
    })
    expect(parseImageForm({ ...base, width: 100 }).ok).toBe(false)
    expect(parseImageForm({ ...base, width: 100000 }).ok).toBe(false)
    expect(parseImageForm({ ...base, steps: 0 }).ok).toBe(false)
    expect(parseImageForm({ ...base, steps: 1000 }).ok).toBe(false)
  })

  it('style 不能含控制字符或过长；空串恢复默认', () => {
    expect(okI(parseImageForm({ ...base, style: '水彩风' })).set.style).toBe('水彩风')
    expect(parseImageForm({ ...base, style: 'a\u0000b' }).ok).toBe(false)
    expect(parseImageForm({ ...base, style: 'x'.repeat(2000) }).ok).toBe(false)
    expect(okI(parseImageForm({ ...base, style: '' })).remove).toContain('style')
  })

  it('models 三个文件名写成 models.xxx，空串删除', () => {
    const edit = okI(parseImageForm({ ...base, unet: 'a.gguf', clip: '', vae: 'sub/v.safetensors' }))
    expect(edit.set).toMatchObject({ 'models.unet': 'a.gguf', 'models.vae': 'sub/v.safetensors' })
    expect(edit.remove).toContain('models.clip')
    expect(parseImageForm({ ...base, unet: '../x.safetensors' }).ok).toBe(false)
    expect(parseImageForm({ ...base, unet: '/abs/x.safetensors' }).ok).toBe(false)
  })
})

describe('updateServicesFile：改写服务配置', () => {
  const ORIGINAL = [
    '# 阿哈酒馆服务配置（用户手写的说明）',
    'image:',
    '  endpoint: http://192.168.1.5:8188  # 3090 上的 ComfyUI',
    '  style: 动漫风格',
    '  extraImage: keep-me',
    '',
    '# 语音一节',
    'voice:',
    '  endpoint: http://127.0.0.1:18123 # 本机',
    '  launch: none',
    '  hfEndpoint: https://hf-mirror.com',
    '  unknownField: 42',
    'other:',
    '  a: 1',
    '',
  ].join('\n')

  it('只改动要改的字段，注释、未知字段、其他节原样保留', async () => {
    await fs.writeFile(file, ORIGINAL, 'utf8')
    await updateServicesFile(file, 'voice', { set: { launch: 'mlx', timeoutSeconds: 90 }, remove: ['hfEndpoint'] })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('# 阿哈酒馆服务配置（用户手写的说明）')
    expect(text).toContain('# 3090 上的 ComfyUI')
    expect(text).toContain('# 语音一节')
    expect(text).toContain('# 本机')
    expect(text).toContain('unknownField: 42')
    expect(text).toContain('extraImage: keep-me')
    expect(text).toContain('other:')
    expect(text).toContain('launch: mlx')
    expect(text).toContain('timeoutSeconds: 90')
    expect(text).not.toContain('hfEndpoint')
    const r = await loadVoiceService(file, { defaultModelsDir: '/d' })
    expect(r.configured && r.settings.launch).toBe('mlx')
  })

  it('文件不存在时创建（含父目录），写出的内容能被读取逻辑读回', async () => {
    const f = path.join(dir, 'nested', 'services.yaml')
    await updateServicesFile(f, 'image', { set: { endpoint: 'http://h:8188', width: 640, auto: false }, remove: [] })
    const r = await loadImageService(f)
    expect(r.configured && r.settings.endpoint).toBe('http://h:8188')
    expect(r.configured && r.settings.width).toBe(640)
    expect(r.configured && r.settings.auto).toBe(false)
  })

  it('另一节不存在时新增，不动已有的一节', async () => {
    await fs.writeFile(file, 'image:\n  endpoint: http://h:1 # 保留\n', 'utf8')
    await updateServicesFile(file, 'voice', { set: { endpoint: 'http://127.0.0.1:18123' }, remove: [] })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('# 保留')
    expect(text).toContain('voice:')
  })

  it('voice 是空值时换成映射', async () => {
    await fs.writeFile(file, 'voice:\nimage:\n  endpoint: http://h:1\n', 'utf8')
    await updateServicesFile(file, 'voice', { set: { endpoint: 'http://127.0.0.1:1' }, remove: [] })
    const r = await loadVoiceService(file, { defaultModelsDir: '/d' })
    expect(r.configured).toBe(true)
  })

  it('models 的点号路径：新增与删除，删光后整段去掉', async () => {
    await fs.writeFile(file, 'image:\n  endpoint: http://h:1\n  models:\n    unet: a.gguf\n', 'utf8')
    await updateServicesFile(file, 'image', { set: { 'models.clip': 'c.gguf' }, remove: [] })
    let r = await loadImageService(file)
    expect(r.configured && r.settings.models).toEqual({ unet: 'a.gguf', clip: 'c.gguf' })
    await updateServicesFile(file, 'image', { set: {}, remove: ['models.unet', 'models.clip'] })
    r = await loadImageService(file)
    expect(r.configured && r.settings.models).toEqual({})
    expect(await fs.readFile(file, 'utf8')).not.toContain('models')
  })

  it('删除不存在的字段不报错', async () => {
    await fs.writeFile(file, 'voice:\n  endpoint: http://127.0.0.1:1\n', 'utf8')
    await updateServicesFile(file, 'voice', { set: {}, remove: ['hfEndpoint', 'models.unet'] })
    expect(await fs.readFile(file, 'utf8')).toContain('endpoint')
  })

  it('YAML 语法错误：拒绝改写，原文件一个字不动', async () => {
    const broken = 'image: [unclosed\n  endpoint: : :\n'
    await fs.writeFile(file, broken, 'utf8')
    await expect(updateServicesFile(file, 'voice', { set: { endpoint: 'http://x:1' }, remove: [] })).rejects.toMatchObject({
      name: 'ServicesEditError', code: 'parse',
    })
    expect(await fs.readFile(file, 'utf8')).toBe(broken)
  })

  it('根不是映射：拒绝改写', async () => {
    await fs.writeFile(file, '- a\n- b\n', 'utf8')
    await expect(updateServicesFile(file, 'voice', { set: { endpoint: 'http://x:1' }, remove: [] })).rejects.toBeInstanceOf(ServicesEditError)
    expect(await fs.readFile(file, 'utf8')).toBe('- a\n- b\n')
  })

  it('节本身不是映射（比如写成了文字）：拒绝改写', async () => {
    await fs.writeFile(file, 'voice: hello\n', 'utf8')
    await expect(updateServicesFile(file, 'voice', { set: { endpoint: 'http://x:1' }, remove: [] })).rejects.toMatchObject({ code: 'format' })
  })

  it('长字符串与长注释保存后不被折行', async () => {
    const longStyle = '很长的画风描述 '.repeat(40).trim()
    const longComment = `# ${'这是一条很长的注释 '.repeat(30).trim()}`
    await fs.writeFile(file, `${longComment}\nimage:\n  endpoint: http://h:1\n  style: ${longStyle}\n`, 'utf8')
    await updateServicesFile(file, 'image', { set: { steps: 8 }, remove: [] })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain(longComment)
    expect(text).toContain(`style: ${longStyle}\n`)
  })

  it('原子写：目录里不留临时文件与锁', async () => {
    await updateServicesFile(file, 'voice', { set: { endpoint: 'http://127.0.0.1:1' }, remove: [] })
    expect(await fs.readdir(dir)).toEqual(['services.yaml'])
  })

  it('并发的两次改写都生效', async () => {
    await fs.writeFile(file, 'voice:\n  endpoint: http://127.0.0.1:1\n', 'utf8')
    await Promise.all([
      updateServicesFile(file, 'voice', { set: { read: 'all' }, remove: [] }),
      updateServicesFile(file, 'voice', { set: { language: 'english' }, remove: [] }),
    ])
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('read: all')
    expect(text).toContain('language: english')
  })
})

describe('readServicesForm：给页面表单用的原始取值', () => {
  it('文件不存在：全部为空串', async () => {
    const f = await readServicesForm(file)
    expect(f.voice.endpoint).toBe('')
    expect(f.image.endpoint).toBe('')
    expect(f.problems).toEqual([])
  })

  it('字符串化取值；布尔、数字、models 展平；不认识的键不返回', async () => {
    await fs.writeFile(
      file,
      'voice:\n  endpoint: http://127.0.0.1:1\n  timeoutSeconds: 90\n  unknownField: x\nimage:\n  endpoint: http://h:1\n  auto: false\n  models:\n    unet: a.gguf\n',
      'utf8',
    )
    const f = await readServicesForm(file)
    expect(f.voice).toMatchObject({ endpoint: 'http://127.0.0.1:1', timeoutSeconds: '90', launch: '' })
    expect(f.voice).not.toHaveProperty('unknownField')
    expect(f.image).toMatchObject({ endpoint: 'http://h:1', auto: 'false', unet: 'a.gguf', clip: '' })
  })

  it('YAML 写坏了：返回空表单并说明问题', async () => {
    await fs.writeFile(file, 'voice: [oops\n', 'utf8')
    const f = await readServicesForm(file)
    expect(f.voice.endpoint).toBe('')
    expect(f.problems.join('')).toContain('解析失败')
  })
})
