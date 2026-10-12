import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadWorkflow, fillWorkflow, requirementsOf, refsUsed, refsRequirementsOf } from '../../../src/core/workflow'

const builtinDir = path.resolve(__dirname, '../../../workflows')
let tmp: string
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-wf-')) })
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

async function writeJson(name: string, doc: unknown): Promise<string> {
  const file = path.join(tmp, name)
  await fs.writeFile(file, typeof doc === 'string' ? doc : JSON.stringify(doc))
  return file
}

const minimal = () => ({
  _aha: { slots: { prompt: ['1', 'text'] }, output: '2' },
  '1': { class_type: 'A', inputs: { text: '' } },
  '2': { class_type: 'B', inputs: {} },
})

describe('loadWorkflow', () => {
  it.each(['qwen-image-2.1', 'qwen-image-2.1-gguf'])('内置 %s 可加载', async (name) => {
    const wf = await loadWorkflow(name, builtinDir)
    expect(wf.name).toBe(name)
    expect(wf.output).toBe('9')
    expect(wf.slots.prompt).toEqual(['5', 'prompt'])
  })

  it('绝对路径直接读，名字为路径', async () => {
    const file = await writeJson('mine.json', minimal())
    const wf = await loadWorkflow(file, builtinDir)
    expect(wf.name).toBe(file)
  })

  it('不存在', async () => {
    await expect(loadWorkflow('nope', builtinDir)).rejects.toThrow('工作流不存在：nope')
  })

  it('不是 JSON，且不泄露文件内容', async () => {
    const file = await writeJson('bad.json', 'secret-content {')
    const err = await loadWorkflow(file, builtinDir).catch((e: Error) => e)
    expect((err as Error).message).toContain('不是合法的 JSON')
    expect((err as Error).message).not.toContain('secret-content')
  })

  it('顶层不是对象', async () => {
    const file = await writeJson('arr.json', '[]')
    await expect(loadWorkflow(file, builtinDir)).rejects.toThrow('顶层必须是对象')
  })

  it('缺 _aha', async () => {
    const { _aha, ...rest } = minimal()
    void _aha
    const file = await writeJson('a.json', rest)
    await expect(loadWorkflow(file, builtinDir)).rejects.toThrow('缺少 _aha 说明块')
  })

  it('缺 slots.prompt', async () => {
    const doc = minimal()
    doc._aha.slots = {} as never
    await expect(loadWorkflow(await writeJson('a.json', doc), builtinDir)).rejects.toThrow('缺少 slots.prompt')
  })

  it('缺 output', async () => {
    const doc = minimal() as Record<string, any>
    delete doc._aha.output
    await expect(loadWorkflow(await writeJson('a.json', doc), builtinDir)).rejects.toThrow('缺少 output')
  })

  it('output 指向不存在的节点', async () => {
    const doc = minimal()
    doc._aha.output = '99'
    await expect(loadWorkflow(await writeJson('a.json', doc), builtinDir)).rejects.toThrow('output 指向不存在的节点 99')
  })

  it('slots 指向不存在的节点', async () => {
    const doc = minimal()
    doc._aha.slots = { prompt: ['7', 'text'] } as never
    await expect(loadWorkflow(await writeJson('a.json', doc), builtinDir)).rejects.toThrow('slots.prompt 指向不存在的节点 7')
  })

  it('slots 指向不存在的输入', async () => {
    const doc = minimal()
    doc._aha.slots = { prompt: ['1', 'nope'] } as never
    await expect(loadWorkflow(await writeJson('a.json', doc), builtinDir)).rejects.toThrow('slots.prompt 指向不存在的输入 1.nope')
  })

  it.each([null, 'x', { inputs: {} }, { class_type: '', inputs: {} }, { class_type: 'A' }, { class_type: 'A', inputs: null }])(
    '节点格式不对：%j',
    async (bad) => {
      const doc = { ...minimal(), x: bad }
      const file = await writeJson('a.json', doc)
      await expect(loadWorkflow(file, builtinDir)).rejects.toThrow(`节点 x 的格式不对：${file}`)
    },
  )

  it('错误信息统一带工作流名', async () => {
    const doc = minimal() as Record<string, any>
    delete doc._aha.output
    const file = await writeJson('a.json', doc)
    await expect(loadWorkflow(file, builtinDir)).rejects.toThrow(`缺少 output：${file}`)
    doc._aha.slots = {}
    await expect(loadWorkflow(await writeJson('b.json', doc), builtinDir)).rejects.toThrow(/缺少 slots\.prompt：.*b\.json/)
  })

  it('slots 形状不对', async () => {
    const doc = minimal()
    doc._aha.slots = { prompt: 'x' } as never
    await expect(loadWorkflow(await writeJson('a.json', doc), builtinDir)).rejects.toThrow('slots.prompt 应是 [节点编号, 输入名]')
  })
})

describe('内置工作流的连线与固定参数', () => {
  const names = ['qwen-image-2.1', 'qwen-image-2.1-gguf']
  it.each(names)('%s', async (name) => {
    const g = (await loadWorkflow(name, builtinDir)).graph as Record<string, any>
    expect(g['2'].class_type).toBe('QwenImage21Cache')
    expect(g['2'].inputs).toMatchObject({ model: ['1', 0], device: 'auto', dtype: 'default' })
    expect(g['3'].class_type).toBe('CLIPLoader')
    expect(g['3'].inputs.type).toBe('qwen_image')
    expect(g['5'].class_type).toBe('TextEncodeQwenImage21')
    expect(g['5'].inputs).toMatchObject({ clip: ['3', 0], negative_prompt: '', resolution: 1024 })
    expect(g['7'].class_type).toBe('KSampler')
    expect(g['7'].inputs).toMatchObject({
      model: ['2', 0], positive: ['5', 0], negative: ['5', 1], latent_image: ['6', 0],
      cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
    })
    expect(g['8'].class_type).toBe('VAEDecode')
    expect(g['8'].inputs).toMatchObject({ samples: ['7', 0], vae: ['4', 0] })
    expect(g['9'].class_type).toBe('SaveImage')
    expect(g['9'].inputs.images).toEqual(['8', 0])
  })

  it('两份除节点 1 外相等', async () => {
    const a = (await loadWorkflow(names[0]!, builtinDir)).graph as Record<string, any>
    const b = (await loadWorkflow(names[1]!, builtinDir)).graph as Record<string, any>
    const { '1': a1, ...ra } = a
    const { '1': b1, ...rb } = b
    expect(ra).toEqual(rb)
    expect(a1.class_type).not.toBe(b1.class_type)
  })
})

describe('fillWorkflow', () => {
  it('填值、去掉 _aha、不改原对象', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    const before = JSON.stringify(wf)
    const out = fillWorkflow(wf, { prompt: '一只猫', width: 640, height: 960, seed: 42, steps: 8 }) as Record<string, any>
    expect(out._aha).toBeUndefined()
    expect(out['5'].inputs.prompt).toBe('一只猫')
    expect(out['6'].inputs).toMatchObject({ width: 640, height: 960 })
    expect(out['7'].inputs).toMatchObject({ seed: 42, steps: 8 })
    expect(JSON.stringify(wf)).toBe(before)
  })

  it('缺可选位置时跳过', async () => {
    const wf = await loadWorkflow(await writeJson('m.json', minimal()), builtinDir)
    const out = fillWorkflow(wf, { prompt: 'p', width: 1, seed: 2, steps: 3, models: { unet: 'x' } }) as Record<string, any>
    expect(out['1'].inputs.text).toBe('p')
    expect(out['2'].inputs).toEqual({})
  })

  it('不给的值沿用写死的默认', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    const out = fillWorkflow(wf, { prompt: 'p' }) as Record<string, any>
    expect(out['6'].inputs).toMatchObject({ width: 832, height: 1216 })
    expect(out['7'].inputs).toMatchObject({ seed: 0, steps: 12 })
  })

  it('models 覆盖文件名', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    const out = fillWorkflow(wf, { prompt: 'p', models: { unet: 'u.safetensors', clip: 'c.safetensors' } }) as Record<string, any>
    expect(out['1'].inputs.unet_name).toBe('u.safetensors')
    expect(out['3'].inputs.clip_name).toBe('c.safetensors')
    expect(out['4'].inputs.vae_name).toBe('qwen_image_2.1_vae_bf16.safetensors')
  })
})

describe('requirementsOf', () => {
  it('节点类型去重', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    const r = requirementsOf(wf, {})
    expect(r.nodeTypes).toHaveLength(new Set(r.nodeTypes).size)
    expect(r.nodeTypes).toEqual(expect.arrayContaining(['UNETLoader', 'QwenImage21Cache', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']))
    expect(r.nodeTypes).not.toContain('UnetLoaderGGUF')
  })

  it('模型清单含目录与地址', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    const r = requirementsOf(wf, {})
    expect(r.models).toHaveLength(3)
    expect(r.models[0]).toEqual({
      slot: 'unet', file: 'qwen_image_2.1_int8_convrot.safetensors', nodeType: 'UNETLoader', input: 'unet_name',
      dir: 'diffusion_models',
      url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
    })
    expect(r.models[2]).toMatchObject({ slot: 'vae', dir: 'vae', nodeType: 'VAELoader', input: 'vae_name' })
  })

  it('GGUF 版主模型无地址，节点类型含 UnetLoaderGGUF', async () => {
    const wf = await loadWorkflow('qwen-image-2.1-gguf', builtinDir)
    const r = requirementsOf(wf, {})
    expect(r.nodeTypes).toContain('UnetLoaderGGUF')
    expect(r.models[0]).toEqual({ slot: 'unet', file: 'qwen-image-2.1-UC-Q8_0.gguf', nodeType: 'UnetLoaderGGUF', input: 'unet_name', dir: 'unet' })
    expect(r.models[0]).not.toHaveProperty('url')
  })

  it('models 覆盖后给出最终文件名', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    const r = requirementsOf(wf, { models: { clip: 'mine.safetensors' } })
    expect(r.models.find((m) => m.slot === 'clip')?.file).toBe('mine.safetensors')
  })

  it('没有 models 说明、没有模型位置时清单为空', async () => {
    const wf = await loadWorkflow(await writeJson('m.json', minimal()), builtinDir)
    expect(requirementsOf(wf, {}).models).toEqual([])
  })

  it('有模型位置但无说明时仍列出，目录与地址缺省', async () => {
    const doc = minimal() as Record<string, any>
    doc._aha.slots.vae = ['1', 'vae']
    doc['1'].inputs.vae = 'v.safetensors'
    const wf = await loadWorkflow(await writeJson('m.json', doc), builtinDir)
    expect(requirementsOf(wf, {}).models).toEqual([{ slot: 'vae', file: 'v.safetensors', nodeType: 'A', input: 'vae' }])
  })
})

/** 带参考图能力的最小工作流：编码节点 E、VAE 节点 V。 */
const withRefs = (refs: unknown = { encoder: 'E', vae: ['V', 0], max: 3 }) => ({
  _aha: { slots: { prompt: ['E', 'prompt'] }, output: '2', refs },
  E: { class_type: 'Enc', inputs: { prompt: '', images: {} } },
  V: { class_type: 'VaeLoad', inputs: {} },
  '2': { class_type: 'B', inputs: {} },
})

describe('参考图：读取说明块', () => {
  it.each(['qwen-image-2.1', 'qwen-image-2.1-gguf'])('内置 %s 读出 refs', async (name) => {
    const wf = await loadWorkflow(name, builtinDir)
    expect(wf.refs).toEqual({ encoder: '5', vae: ['4', 0], max: 16 })
    expect(wf.refsProblem).toBeUndefined()
  })

  it('refs 缺失：两个字段都没有', async () => {
    const wf = await loadWorkflow(await writeJson('m.json', minimal()), builtinDir)
    expect(wf).not.toHaveProperty('refs')
    expect(wf).not.toHaveProperty('refsProblem')
  })

  it('max 缺省为 16', async () => {
    const wf = await loadWorkflow(await writeJson('m.json', withRefs({ encoder: 'E', vae: ['V', 0] })), builtinDir)
    expect(wf.refs).toEqual({ encoder: 'E', vae: ['V', 0], max: 16 })
  })

  it.each([
    ['refs 不是对象', 'abc'],
    ['refs 是数组', []],
    ['encoder 指向不存在的节点', { encoder: 'X', vae: ['V', 0] }],
    ['encoder 不是字符串', { encoder: 5, vae: ['V', 0] }],
    ['vae 不是二元组', { encoder: 'E', vae: ['V'] }],
    ['vae 是字符串', { encoder: 'E', vae: 'V' }],
    ['vae 序号不是整数', { encoder: 'E', vae: ['V', 'a'] }],
    ['vae 节点不存在', { encoder: 'E', vae: ['X', 0] }],
    ['max 为 0', { encoder: 'E', vae: ['V', 0], max: 0 }],
    ['max 为 17', { encoder: 'E', vae: ['V', 0], max: 17 }],
    ['max 为小数', { encoder: 'E', vae: ['V', 0], max: 2.5 }],
    ['max 为字符串', { encoder: 'E', vae: ['V', 0], max: '3' }],
  ])('写错：%s → 按不支持处理并给出原因，工作流仍可加载', async (_n, refs) => {
    const wf = await loadWorkflow(await writeJson('m.json', withRefs(refs)), builtinDir)
    expect(wf.refs).toBeUndefined()
    expect(wf.refsProblem).toMatch(/\S/)
    expect(wf.refsProblem).not.toContain('abc')
    expect(fillWorkflow(wf, { prompt: 'p', refs: ['a.png'] })).toEqual(fillWorkflow(wf, { prompt: 'p' }))
  })
})

describe('参考图：填值', () => {
  const load = async (refs?: unknown) => loadWorkflow(await writeJson('m.json', withRefs(refs)), builtinDir)

  it.each(['qwen-image-2.1', 'qwen-image-2.1-gguf'])('内置 %s：无参考图时与不传逐字段相同', async (name) => {
    const wf = await loadWorkflow(name, builtinDir)
    const base = fillWorkflow(wf, { prompt: 'p', seed: 1 })
    expect(fillWorkflow(wf, { prompt: 'p', seed: 1, refs: [] })).toEqual(base)
    expect(base['5']!.inputs.images).toEqual({})
    expect(base['5']!.inputs).not.toHaveProperty('vae')
    expect(Object.keys(base).some((k) => k.startsWith('aha_ref_'))).toBe(false)
  })

  it('一张：加 LoadImage 节点，扁平键，连 vae，删掉空 images', async () => {
    const wf = await load()
    const g = fillWorkflow(wf, { prompt: 'p', refs: ['a.png'] })
    expect(g.aha_ref_1).toEqual({ class_type: 'LoadImage', inputs: { image: 'a.png' } })
    expect(g.E!.inputs['images.image_1']).toEqual(['aha_ref_1', 0])
    expect(g.E!.inputs.vae).toEqual(['V', 0])
    expect(g.E!.inputs).not.toHaveProperty('images')
    expect(g.E!.inputs.prompt).toBe('p')
  })

  it('多张：按顺序编号，不改原工作流', async () => {
    const wf = await load()
    const before = structuredClone(wf.graph)
    const g = fillWorkflow(wf, { prompt: 'p', refs: ['a.png', 'b.png'] })
    expect(g.aha_ref_2).toEqual({ class_type: 'LoadImage', inputs: { image: 'b.png' } })
    expect(g.E!.inputs['images.image_2']).toEqual(['aha_ref_2', 0])
    expect(wf.graph).toEqual(before)
  })

  it('节点编号冲突时换名', async () => {
    const doc = withRefs() as Record<string, any>
    doc.aha_ref_1 = { class_type: 'Other', inputs: {} }
    doc.aha_ref_1_2 = { class_type: 'Other', inputs: {} }
    const wf = await loadWorkflow(await writeJson('m.json', doc), builtinDir)
    const g = fillWorkflow(wf, { prompt: 'p', refs: ['a.png', 'b.png'] })
    expect(g.aha_ref_1).toEqual({ class_type: 'Other', inputs: {} })
    const ids = Object.keys(g).filter((k) => g[k]!.class_type === 'LoadImage')
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(g.E!.inputs['images.image_1']).toEqual([ids[0], 0])
    expect(g.E!.inputs['images.image_2']).toEqual([ids[1], 0])
    expect(g[ids[0]!]!.inputs.image).toBe('a.png')
    expect(g[ids[1]!]!.inputs.image).toBe('b.png')
  })

  it('超过 max 只用前 max 张，refsUsed 给出实际张数', async () => {
    const wf = await load()
    const g = fillWorkflow(wf, { prompt: 'p', refs: ['1', '2', '3', '4', '5'] })
    expect(Object.keys(g).filter((k) => g[k]!.class_type === 'LoadImage')).toHaveLength(3)
    expect(g.E!.inputs).not.toHaveProperty('images.image_4')
    expect(refsUsed(wf, ['1', '2', '3', '4', '5'])).toBe(3)
    expect(refsUsed(wf, ['1'])).toBe(1)
    expect(refsUsed(wf, [])).toBe(0)
    expect(refsUsed(wf, undefined)).toBe(0)
  })

  it('不支持参考图的工作流：refsUsed 为 0', async () => {
    const wf = await loadWorkflow(await writeJson('m.json', minimal()), builtinDir)
    expect(refsUsed(wf, ['a.png'])).toBe(0)
  })
})

describe('参考图：额外依赖', () => {
  it('支持时给出 LoadImage 与编码节点类型；不支持为 undefined', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    expect(refsRequirementsOf(wf)).toEqual({ nodeTypes: ['LoadImage'], encoderType: 'TextEncodeQwenImage21' })
    const plain = await loadWorkflow(await writeJson('m.json', minimal()), builtinDir)
    expect(refsRequirementsOf(plain)).toBeUndefined()
  })

  it('requirementsOf 的返回值不含 LoadImage', async () => {
    const wf = await loadWorkflow('qwen-image-2.1', builtinDir)
    expect(requirementsOf(wf, {}).nodeTypes).not.toContain('LoadImage')
  })
})
