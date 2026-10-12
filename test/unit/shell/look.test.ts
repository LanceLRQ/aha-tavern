import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { DEFAULTS } from '../../../src/config'
import { saveCharacter } from '../../../src/core/card'
import { ComfyError } from '../../../src/core/comfy'
import { listDrafts, readLooks } from '../../../src/core/looks'
import { IMAGE_SERVICE_DEFAULTS, type ImageServiceSettings } from '../../../src/core/services'
import { createTavern } from '../../../src/core/tavern'
import { loadTheme, type Theme } from '../../../src/core/theme'
import { loadWorkflow } from '../../../src/core/workflow'
import { handleCommand, parseSubcommand } from '../../../src/shell/commands'
import { ALREADY_DECLINED, CANCELLED, DeclineTracker, SessionGate } from '../../../src/shell/confirm'
import type { HostAgent } from '../../../src/shell/context'
import { imageLine } from '../../../src/shell/draw'
import {
  buildLookCue, DRAFT_TEXT, LookSession, lookHandler, parseDraftArgs, registerLookTools, REMOVE_TEXT, SAVE_TEXT, type LookDeps,
} from '../../../src/shell/look'
import { LOOK_TEXT, lookPrompt, sheetSize } from '../../../src/shell/look-draft'
import { RefUploader } from '../../../src/shell/ref-upload'
import type { Runtime } from '../../../src/shell/runtime'
import { voiceRuntimeStubs } from './helpers/runtime'

const themesDir = path.resolve(__dirname, '../../../themes')
const workflowDir = path.resolve(__dirname, '../../../workflows')

function tinyPng(color = 200): Buffer {
  const p = new PNG({ width: 4, height: 4 })
  p.data.fill(color)
  return PNG.sync.write(p)
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

let root: string
let tavern: string
let home: string
let charDir: string
let settings: ImageServiceSettings
let log: { debug: any; info: any; warn: any; error: any }
let generate: ReturnType<typeof vi.fn>
let uploadImage: ReturnType<typeof vi.fn>
let probe: ReturnType<typeof vi.fn>
let ask: ReturnType<typeof vi.fn>
let answers: Array<string | { custom: string } | Error>
let session: LookSession
let declines: DeclineTracker
let defs: Record<string, { description: string; parameters: any; execute(a: unknown, e: unknown): Promise<string> }>
let deps: LookDeps
let theme: Theme
let seq: number
let generatedPngs: Buffer[]

const agent: HostAgent = { id: 's1', ctx: {} }
const withCwd = (cwd: string): HostAgent => ({ id: 's1', ctx: {}, session: { header: { cwd } } })
const call = (name: string, args: Record<string, unknown>, o: { agent?: HostAgent | null; signal?: AbortSignal } = {}) =>
  defs[name]!.execute(args, { agent: o.agent === undefined ? withCwd(tavern) : o.agent, ...(o.signal ? { signal: o.signal } : {}) })
const draft = (args: Record<string, unknown> = {}) => call('aha_look_draft', { character: '白狐', ...args })

function build(over: Partial<LookDeps> = {}): void {
  defs = {}
  deps = {
    rt: { log, theme: async () => theme, builtinWorkflowDir: workflowDir },
    getAsk: () => ask as never,
    gate: new SessionGate(),
    declines,
    tavernDirOf: async (a) => a?.session?.header?.cwd as string | undefined,
    session,
    loadService: async () => ({ configured: true, settings, problems: [] }),
    probe: probe as never,
    createClient: () => ({ generate, uploadImage }) as never,
    uploader: new RefUploader(),
    homeDir: home,
    random: () => 0.5,
    ...over,
  }
  registerLookTools({ tools: { register: (d: { name: string }) => { defs[d.name] = d as never } } } as never, deps)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-look-'))
  tavern = path.join(root, 'tavern')
  home = path.join(root, 'home')
  await fs.mkdir(tavern)
  await fs.mkdir(home)
  await createTavern(tavern, { name: 't', id: 't_1' })
  charDir = (await saveCharacter(tavern, { name: '白狐', persona: 'p', appearance: '白发狐耳' })).dir
  theme = (await loadTheme({ name: 'plain', builtinDir: themesDir })).theme
  settings = { ...IMAGE_SERVICE_DEFAULTS, endpoint: 'http://10.0.0.1:8188', style: '画风' }
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  seq = 0
  generatedPngs = []
  generate = vi.fn(async () => {
    const png = tinyPng(10 + ++seq)
    generatedPngs.push(png)
    return { bytes: png, ext: 'png' }
  })
  uploadImage = vi.fn(async (_d: Uint8Array, name: string) => name)
  probe = vi.fn(async () => undefined)
  answers = ['保存']
  ask = vi.fn(async (req: any) => {
    const step = answers.shift()
    if (step === undefined) throw new Error('unexpected card')
    if (step instanceof Error) throw step
    const id = req.questions[0].id
    return { answers: [typeof step === 'string' ? { id, selected: [step] } : { id, custom: step.custom }] }
  })
  session = new LookSession(log)
  declines = new DeclineTracker()
  build()
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** 取最近一次提交给 ComfyUI 的图里的提示词、尺寸与参考图节点数。 */
async function lastSubmitted(): Promise<{ prompt: string; width: unknown; height: unknown; refs: string[]; seed: unknown }> {
  const wf = await loadWorkflow('qwen-image-2.1', workflowDir)
  const graph = generate.mock.calls.at(-1)![0] as Graph
  const at = (slot: 'prompt' | 'width' | 'height' | 'seed') => graph[wf.slots[slot]![0]]!.inputs[wf.slots[slot]![1]]
  const refs = Object.values(graph).filter((n) => n.class_type === 'LoadImage').map((n) => String(n.inputs.image))
  return { prompt: at('prompt') as string, width: at('width'), height: at('height'), refs, seed: at('seed') }
}

async function writePic(name: string, bytes: Buffer = tinyPng(77)): Promise<string> {
  const f = path.join(home, name)
  await fs.writeFile(f, bytes)
  return f
}

describe('三种起点的提示词与参考图', () => {
  it('文字起点：画风、外貌、句子三段换行连接，note 直接接在句子后面，不带参考图', async () => {
    const out = await draft({ note: '尾巴要蓬松' })
    const s = await lastSubmitted()
    expect(s.prompt).toBe(
      '画风\n白发狐耳\n把这个角色画成角色设定三视图：同一个角色的三个全身立绘从左到右并排，依次是正面、侧面、背面，站姿自然，双手下垂，表情平静，纯浅灰色背景，没有其他物体，没有文字。尾巴要蓬松',
    )
    expect(s.refs).toEqual([])
    expect(uploadImage).not.toHaveBeenCalled()
    const drafts = await listDrafts(charDir)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ n: 1, origin: 'text', note: '尾巴要蓬松', prompt: s.prompt })
    expect(out).toContain('look candidate 1 drawn')
    expect(out).toContain(imageLine(path.join(charDir, '.look-drafts', '001.png')))
    expect(out).toContain('side and back views')
  })

  it('文字起点：画风为空时跳过那一段，note 为空不拼', async () => {
    settings = { ...settings, style: '' }
    await draft()
    expect((await lastSubmitted()).prompt).toBe(
      '白发狐耳\n把这个角色画成角色设定三视图：同一个角色的三个全身立绘从左到右并排，依次是正面、侧面、背面，站姿自然，双手下垂，表情平静，纯浅灰色背景，没有其他物体，没有文字。',
    )
  })

  it('一张原图：只有一段，不带画风与外貌；上传一次，一个参考图节点；提醒看背面', async () => {
    await writePic('a.png')
    const out = await draft({ images: ['~/a.png'], note: '眼睛是金色' })
    const s = await lastSubmitted()
    expect(s.prompt).toBe(
      '把参考图里的这个角色画成角色设定三视图：同一个角色的三个全身立绘从左到右并排，依次是正面、侧面、背面，站姿自然，双手下垂，表情平静，保持参考图的画风、长相、发型、服装和配饰，纯浅灰色背景，没有其他物体，没有文字。眼睛是金色',
    )
    expect(s.refs).toHaveLength(1)
    expect(s.refs[0]).toMatch(/^aha-ref-[0-9a-f]{16}\.png$/)
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect((await listDrafts(charDir))[0]).toMatchObject({ origin: 'images', note: '眼睛是金色' })
    expect(out).toContain('side and back views')
  })

  it('多张原图：句子开头换掉，每张一个参考图节点；不再提醒看背面', async () => {
    await writePic('a.png', tinyPng(1))
    await writePic('b.png', tinyPng(2))
    const out = await draft({ images: [path.join(home, 'a.png'), '~/b.png'] })
    const s = await lastSubmitted()
    expect(s.prompt).toBe(
      '几张参考图是同一个角色。把这个角色画成角色设定三视图：同一个角色的三个全身立绘从左到右并排，依次是正面、侧面、背面，站姿自然，双手下垂，表情平静，保持参考图的画风、长相、发型、服装和配饰，纯浅灰色背景，没有其他物体，没有文字。',
    )
    expect(s.refs).toHaveLength(2)
    expect(new Set(s.refs).size).toBe(2)
    expect(out).not.toContain('side and back views')
  })

  it('以候选为底：只有那一句加 note，参考图就是那张候选，记下 basedOn', async () => {
    await draft()
    seqReset()
    answers = []
    await session.onStep(withCwd(tavern), 2, [])
    const out = await draft({ basedOn: 1, note: '加上尾巴' })
    const s = await lastSubmitted()
    expect(s.prompt).toBe('按下面的要求修改这张设定图，其余保持不变。加上尾巴')
    expect(s.refs).toHaveLength(1)
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect(Buffer.from(uploadImage.mock.calls[0]![0]).equals(generatedPngs[0]!)).toBe(true)
    const drafts = await listDrafts(charDir)
    expect(drafts.map((d) => d.n)).toEqual([1, 2])
    expect(drafts[1]).toMatchObject({ origin: 'draft', basedOn: 1, note: '加上尾巴' })
    expect(out).toContain('look candidate 2 drawn')
    expect(out).not.toContain('side and back views')
  })

  it('尺寸：宽高较大者为宽，较小者为高；换个方向配置结果相同', async () => {
    await draft()
    expect(await lastSubmitted()).toMatchObject({ width: 1216, height: 832 })
    expect(sheetSize(1216, 832)).toEqual({ width: 1216, height: 832 })
    expect(sheetSize(512, 768)).toEqual({ width: 768, height: 512 })
  })

  it('种子由注入的随机数决定，步数沿用配置', async () => {
    await draft()
    expect((await lastSubmitted()).seed).toBe(2 ** 31)
    expect((await listDrafts(charDir))[0]!.seed).toBe(2 ** 31)
  })

  it('lookPrompt 是纯函数：note 只在非空时接上', () => {
    expect(lookPrompt({ kind: 'draft', basedOn: 1 }, { style: 's', appearance: 'a', note: '  x  ' })).toBe('按下面的要求修改这张设定图，其余保持不变。x')
  })
})

const seqReset = () => { generate.mockClear(); uploadImage.mockClear() }

describe('以已保存的形象为底（basedOnLook）', () => {
  const SENTENCE = '按下面的要求修改这张设定图，其余保持不变。'
  async function saveDefault(): Promise<Buffer> {
    await draft()
    await call('aha_look_save', { character: '白狐', candidate: 1 })
    ask.mockClear()
    session.onStep(withCwd(tavern), 40, [])
    return generatedPngs[0]!
  }

  it('default：提示词逐字，一个参考图节点，上传的是定妆图字节，记录 origin 与 basedOnLook', async () => {
    const saved = await saveDefault()
    const out = await draft({ basedOnLook: 'default', note: '换成便装' })
    expect((await lastSubmitted()).prompt).toBe('按下面的要求修改这张设定图，其余保持不变。换成便装')
    expect((await lastSubmitted()).refs).toHaveLength(1)
    expect(Buffer.from(uploadImage.mock.calls.at(-1)![0]).equals(saved)).toBe(true)
    expect(await listDrafts(charDir)).toMatchObject([{ n: 1, origin: 'look', basedOnLook: 'default', note: '换成便装' }])
    expect(out).toContain('look candidate 1 drawn')
    expect(out).not.toContain('side and back views')
    expect(SENTENCE).toBeTruthy()
  })

  it('形象名与形象编号都能解析', async () => {
    await draft()
    await call('aha_look_save', { character: '白狐', candidate: 1, name: '夏装', when: '夏天' })
    const look = (await readLooks(charDir)).extras[0]!
    const bytes = generatedPngs[0]!
    session.onStep(withCwd(tavern), 41, [])
    await draft({ basedOnLook: '夏装', note: '加围巾' })
    expect((await lastSubmitted()).prompt).toBe('按下面的要求修改这张设定图，其余保持不变。加围巾')
    expect(Buffer.from(uploadImage.mock.calls.at(-1)![0]).equals(bytes)).toBe(true)
    expect((await listDrafts(charDir))[0]).toMatchObject({ origin: 'look', basedOnLook: look.id })
    session.onStep(withCwd(tavern), 42, [])
    expect(await draft({ basedOnLook: look.id, note: '去掉围巾' })).toContain('drawn')
  })

  it('三者互斥、缺 note', async () => {
    for (const args of [
      { basedOnLook: 'default', images: ['/a.png'], note: 'x' },
      { basedOnLook: 'default', basedOn: 1, note: 'x' },
      { basedOnLook: 'default', images: ['/a.png'], basedOn: 1, note: 'x' },
    ]) expect(await draft(args)).toBe(DRAFT_TEXT.both)
    expect(await draft({ basedOnLook: 'default' })).toBe(DRAFT_TEXT.noteNeeded)
    expect(await draft({ basedOnLook: '  ', note: 'x' })).toBe(DRAFT_TEXT.basedOnLook)
    expect(generate).not.toHaveBeenCalled()
    expect(await draft()).toContain('drawn')
  })

  it('形象不存在、文件不是 PNG：固定短语，不出图，不占名额', async () => {
    expect(await draft({ basedOnLook: 'default', note: 'x' })).toBe(LOOK_TEXT.noSuchLook)
    expect(await draft({ basedOnLook: '没有', note: 'x' })).toBe(LOOK_TEXT.noSuchLook)
    await fs.writeFile(path.join(charDir, 'reference.png'), 'not a png')
    const out = await draft({ basedOnLook: 'default', note: 'x' })
    expect(out).toBe(LOOK_TEXT.noSuchLook)
    expect(out).not.toContain('没有')
    expect(generate).not.toHaveBeenCalled()
    expect(await draft()).toContain('drawn')
  })

  it('工作流不支持参考图：与 basedOn 同一条返回', async () => {
    await saveDefault()
    const wf = JSON.parse(await fs.readFile(path.join(workflowDir, 'qwen-image-2.1.json'), 'utf8'))
    delete wf._aha.refs
    const f = path.join(root, 'nr.json')
    await fs.writeFile(f, JSON.stringify(wf))
    settings = { ...settings, workflow: f }
    generate.mockClear()
    expect(await draft({ basedOnLook: 'default', note: 'x' })).toBe(LOOK_TEXT.noRefs)
    expect(generate).not.toHaveBeenCalled()
  })

  it('出图失败不占名额', async () => {
    await saveDefault()
    generate.mockRejectedValueOnce(new ComfyError('timeout'))
    expect(await draft({ basedOnLook: 'default', note: 'x' })).toContain('failed: timeout')
    expect(await draft({ basedOnLook: 'default', note: 'x' })).toContain('drawn')
  })
})

describe('参数校验：不合法的组合都不出图、不占本轮名额', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['images 与 basedOn 同时给', { images: ['/a.png'], basedOn: 1, note: 'x' }, DRAFT_TEXT.both],
    ['images 是空数组', { images: [] }, DRAFT_TEXT.images],
    ['images 超过四张', { images: ['/1', '/2', '/3', '/4', '/5'] }, DRAFT_TEXT.images],
    ['images 里有空字符串', { images: ['/a.png', '  '] }, DRAFT_TEXT.images],
    ['basedOn 是 0', { basedOn: 0, note: 'x' }, DRAFT_TEXT.basedOn],
    ['basedOn 缺 note', { basedOn: 1 }, DRAFT_TEXT.noteNeeded],
    ['basedOn 的 note 只有空白', { basedOn: 1, note: '   ' }, DRAFT_TEXT.noteNeeded],
    ['note 超过 400 字', { note: '字'.repeat(401) }, DRAFT_TEXT.noteLong(401)],
  ]
  for (const [name, args, expected] of cases) {
    it(name, async () => {
      expect(await draft(args)).toBe(expected)
      expect(generate).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
      // 名额没被占：同一轮里接着合法调用成功
      expect(await draft()).toContain('look candidate 1 drawn')
    })
  }

  it('note 恰好 400 字可以', async () => {
    expect(await draft({ note: '字'.repeat(400) })).toContain('drawn')
  })

  it('三者都没给且角色卡没有外貌：返回固定短语', async () => {
    await saveCharacter(tavern, { name: '无貌', persona: 'p' })
    const out = await call('aha_look_draft', { character: '无貌' })
    expect(out).toBe(DRAFT_TEXT.noAppearance)
    expect(generate).not.toHaveBeenCalled()
    // 给了图就不需要外貌
    await writePic('a.png')
    expect(await call('aha_look_draft', { character: '无貌', images: ['~/a.png'] })).toContain('drawn')
  })

  it('类型不对的参数：宿主的参数校验先拦下，插件自己的校验也有同样的结论', async () => {
    for (const args of [{ images: '/a.png' }, { images: [1] }, { basedOn: 1.5, note: 'x' }, { basedOn: '1', note: 'x' }, { note: 5 }]) {
      await expect(draft(args)).rejects.toThrow(/invalid arguments/)
    }
    expect(parseDraftArgs({ images: '/a.png' })).toEqual({ ok: false, message: DRAFT_TEXT.images })
    expect(parseDraftArgs({ images: [1] })).toEqual({ ok: false, message: DRAFT_TEXT.images })
    expect(parseDraftArgs({ basedOn: 1.5, note: 'x' })).toEqual({ ok: false, message: DRAFT_TEXT.basedOn })
    expect(parseDraftArgs({ basedOn: '1', note: 'x' })).toEqual({ ok: false, message: DRAFT_TEXT.basedOn })
    expect(parseDraftArgs({ note: 5 })).toEqual({ ok: false, message: DRAFT_TEXT.noteType })
    expect(generate).not.toHaveBeenCalled()
  })

  it('parseDraftArgs 直接调用', () => {
    expect(parseDraftArgs({ images: ['/a'] })).toEqual({ ok: true, start: { kind: 'images', paths: ['/a'] }, note: '' })
    expect(parseDraftArgs({ basedOn: 2, note: ' 改 ' })).toEqual({ ok: true, start: { kind: 'draft', basedOn: 2 }, note: '改' })
    expect(parseDraftArgs({})).toEqual({ ok: true, start: { kind: 'text' }, note: '' })
  })

  it('角色不存在、名字没给', async () => {
    expect(await call('aha_look_draft', { character: '不存在' })).toContain('no character named')
    await expect(call('aha_look_draft', {})).rejects.toThrow(/character/)
    expect(await call('aha_look_draft', { character: '  ' })).toBe(DRAFT_TEXT.character)
  })

  it('basedOn 指向不存在的候选：固定短语，不出图', async () => {
    expect(await draft({ basedOn: 9, note: '改' })).toBe(LOOK_TEXT.noSuchCandidate(9))
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('前置检查', () => {
  it('会话没就绪、不是酒馆', async () => {
    expect(await call('aha_look_draft', { character: '白狐' }, { agent: null })).toBe(DRAFT_TEXT.notReady)
    const plain = path.join(root, 'plain')
    await fs.mkdir(plain)
    build({ tavernDirOf: async () => undefined })
    expect(await draft()).toBe(DRAFT_TEXT.notTavern)
  })

  it('只读酒馆：三个工具都拒绝，不出图不弹卡片', async () => {
    await fs.writeFile(path.join(tavern, 'aha-tavern.yaml'), YAML.stringify({ version: 999, id: 't_1', name: 't' }))
    expect(await draft()).toContain('look not drawn')
    expect(await draft()).toContain('read-only')
    expect(await call('aha_look_save', { character: '白狐', candidate: 1 })).toContain('read-only')
    expect(await call('aha_look_remove', { character: '白狐' })).toContain('read-only')
    expect(generate).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('没配置生图服务：固定短语，并指引自检', async () => {
    build({ loadService: async () => ({ configured: false, problems: [] }) })
    const out = await draft()
    expect(out).toBe(LOOK_TEXT.notConfigured)
    expect(out).toContain('/aha 自检 生图')
    expect(generate).not.toHaveBeenCalled()
    // 失败不占名额
    build()
    expect(await draft()).toContain('drawn')
  })

  it('连不上服务：固定短语，错误原文不进返回', async () => {
    probe.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:8188'))
    const out = await draft()
    expect(out).toBe(LOOK_TEXT.unreachable)
    expect(out).not.toContain('ECONNREFUSED')
    expect(generate).not.toHaveBeenCalled()
  })

  it('工作流不支持参考图：原图起点与候选起点返回固定短语，文字起点照常出图', async () => {
    const wf = JSON.parse(await fs.readFile(path.join(workflowDir, 'qwen-image-2.1.json'), 'utf8'))
    delete wf._aha.refs
    const noRefs = path.join(root, 'no-refs.json')
    await fs.writeFile(noRefs, JSON.stringify(wf))
    settings = { ...settings, workflow: noRefs }
    await writePic('a.png')
    expect(await draft({ images: ['~/a.png'] })).toBe(LOOK_TEXT.noRefs)
    expect(await draft({ basedOn: 1, note: 'x' })).toBe(LOOK_TEXT.noRefs)
    expect(generate).not.toHaveBeenCalled()
    expect(await draft()).toContain('drawn')
  })

  it('原图张数超过工作流的参考图上限', async () => {
    const wf = JSON.parse(await fs.readFile(path.join(workflowDir, 'qwen-image-2.1.json'), 'utf8'))
    wf._aha.refs.max = 1
    const one = path.join(root, 'one-ref.json')
    await fs.writeFile(one, JSON.stringify(wf))
    settings = { ...settings, workflow: one }
    await writePic('a.png')
    expect(await draft({ images: ['~/a.png', '~/a.png'] })).toBe(LOOK_TEXT.tooManyRefs(1))
  })
})

describe('原图预处理被拒', () => {
  it('第几张、什么原因；整体不出图、不上传、不占名额', async () => {
    await writePic('ok.png')
    await fs.writeFile(path.join(home, 'x.txt'), 'hello')
    expect(await draft({ images: ['~/ok.png', '~/x.txt'] })).toBe('image 2: unsupported format, convert to PNG or JPG first')
    expect(await draft({ images: ['relative.png'] })).toBe('image 1: path must be absolute or start with ~/; ask the user for the full path')
    expect(await draft({ images: ['~/none.png'] })).toBe('image 1: file not found; ask the user to check the path')
    await fs.writeFile(path.join(home, 'bad.png'), tinyPng().subarray(0, 30))
    expect(await draft({ images: ['~/bad.png'] })).toBe('image 1: file is corrupt or unreadable')
    expect(generate).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
    expect(await draft({ images: ['~/ok.png'] })).toContain('drawn')
  })
})

describe('一轮最多一次', () => {
  it('成功一次后同一轮再调用被拒，新的一轮可以', async () => {
    expect(await draft()).toContain('drawn')
    expect(await draft()).toBe(DRAFT_TEXT.alreadyDrew)
    expect(generate).toHaveBeenCalledTimes(1)
    session.onStep(withCwd(tavern), 5, [])
    expect(await draft()).toContain('look candidate 2 drawn')
  })

  it('失败的调用不占名额', async () => {
    generate.mockRejectedValueOnce(new ComfyError('failed', 'SECRET-DETAIL'))
    const bad = await draft()
    expect(bad).toContain('failed: other')
    expect(await draft()).toContain('look candidate 1 drawn')
    expect(await listDrafts(charDir)).toHaveLength(1)
  })
})

describe('出图失败', () => {
  const kinds: Array<[ComfyError, string]> = [
    [new ComfyError('unreachable'), 'failed: unreachable'],
    [new ComfyError('missing-node'), 'failed: missing-node'],
    [new ComfyError('missing-model'), 'failed: missing-model'],
    [new ComfyError('timeout'), 'failed: timeout'],
    [new ComfyError('cancelled'), 'failed: cancelled'],
    [new ComfyError('rejected', 'x'), 'failed: other'],
  ]
  for (const [err, expected] of kinds) {
    it(err.kind, async () => {
      generate.mockRejectedValueOnce(err)
      const out = await draft()
      expect(out).toContain(expected)
      expect(out).toContain('/aha 自检 生图')
      expect(await listDrafts(charDir)).toHaveLength(0)
    })
  }

  it('服务端原文只进 debug 日志，不进返回', async () => {
    generate.mockRejectedValueOnce(new ComfyError('failed', 'SECRET-DETAIL http://10.0.0.1:8188/x'))
    const out = await draft()
    expect(out).not.toContain('SECRET-DETAIL')
    expect(log.debug.mock.calls.some((c: unknown[]) => String(c[0]).includes('SECRET-DETAIL'))).toBe(true)
    for (const level of ['info', 'warn', 'error'] as const) {
      expect(log[level].mock.calls.some((c: unknown[]) => String(c[0]).includes('SECRET-DETAIL'))).toBe(false)
    }
  })

  it('取消信号已触发：按取消返回，不占名额', async () => {
    const ac = new AbortController()
    ac.abort()
    generate.mockRejectedValueOnce(new Error('aborted'))
    expect(await call('aha_look_draft', { character: '白狐' }, { signal: ac.signal })).toContain('failed: cancelled')
    expect(await draft()).toContain('drawn')
  })

  it('上传失败不是降级而是失败（原图起点）', async () => {
    await writePic('a.png')
    uploadImage.mockRejectedValueOnce(new ComfyError('upload-failed', 'HTTP 500 boom'))
    const out = await draft({ images: ['~/a.png'] })
    expect(out).toContain('failed: upload')
    expect(out).not.toContain('boom')
    expect(generate).not.toHaveBeenCalled()
    expect(await listDrafts(charDir)).toHaveLength(0)
    expect(await draft({ images: ['~/a.png'] })).toContain('drawn')
  })

  it('missing-ref：忘掉记账、重传并重试一次', async () => {
    await writePic('a.png')
    generate.mockRejectedValueOnce(new ComfyError('missing-ref', 'no such file'))
    const out = await draft({ images: ['~/a.png'] })
    expect(out).toContain('look candidate 1 drawn')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(uploadImage).toHaveBeenCalledTimes(2)
  })

  it('missing-ref 重试后仍失败：按失败返回，不占名额', async () => {
    await writePic('a.png')
    generate.mockRejectedValue(new ComfyError('missing-ref'))
    const out = await draft({ images: ['~/a.png'] })
    expect(out).toContain('failed: other')
    expect(generate).toHaveBeenCalledTimes(2)
    generate.mockReset()
    generate.mockResolvedValue({ bytes: tinyPng(), ext: 'png' })
    expect(await draft({ images: ['~/a.png'] })).toContain('drawn')
  })

  it('出的图不是 PNG 时不存候选', async () => {
    generate.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), ext: 'jpg' })
    expect(await draft()).toContain('failed: other')
    expect(await listDrafts(charDir)).toHaveLength(0)
  })
})

describe('用户给的路径不进日志，也不进返回', () => {
  it('成功、被拒、失败三种情形', async () => {
    const secretName = 'zzz-secret-folder-qq'
    await fs.mkdir(path.join(home, secretName))
    await writePic(`${secretName}/pic.png`)
    const outs = [
      await draft({ images: [`~/${secretName}/pic.png`] }),
      await draft({ images: [`~/${secretName}/missing.png`] }),
    ]
    session.onStep(withCwd(tavern), 3, [])
    generate.mockRejectedValueOnce(new ComfyError('timeout'))
    outs.push(await draft({ images: [`~/${secretName}/pic.png`] }))
    for (const o of outs) {
      expect(o).not.toContain(secretName)
      expect(o).not.toContain(home)
    }
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      for (const c of log[level].mock.calls) {
        expect(String(c[0])).not.toContain(secretName)
        expect(String(c[0])).not.toContain(home)
      }
    }
  })
})

describe('漏贴图片行的补发', () => {
  const reply = (s: LookSession, a: HostAgent, text: string) => {
    s.onFrame(a, { type: 'start' })
    s.onFrame(a, { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text', text } } })
    s.onFrame(a, { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } })
  }

  it('回复里没有图片行：轮次收尾时补发一次；只补一次', async () => {
    const a = withCwd(tavern)
    session.onStep(a, 1, [])
    await draft()
    reply(session, a, '画好了，你看看。')
    const nudge = vi.fn()
    session.echo.onTurnStopping(a.id, 1, nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge.mock.calls[0]![0]).toContain(imageLine(path.join(charDir, '.look-drafts', '001.png')))
    session.echo.onTurnStopping(a.id, 1, nudge)
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('回复里贴了图片行：不补发', async () => {
    const a = withCwd(tavern)
    session.onStep(a, 1, [])
    await draft()
    reply(session, a, `这张怎么样？\n${imageLine(path.join(charDir, '.look-drafts', '001.png'))}`)
    const nudge = vi.fn()
    session.echo.onTurnStopping(a.id, 1, nudge)
    expect(nudge).not.toHaveBeenCalled()
  })

  it('失败的调用不登记待核对项', async () => {
    const a = withCwd(tavern)
    session.onStep(a, 1, [])
    generate.mockRejectedValueOnce(new ComfyError('timeout'))
    await draft()
    const nudge = vi.fn()
    session.echo.onTurnStopping(a.id, 1, nudge)
    expect(nudge).not.toHaveBeenCalled()
  })
})

describe('aha_look_save', () => {
  const save = (args: Record<string, unknown> = {}) => call('aha_look_save', { character: '白狐', candidate: 1, ...args })
  const question = () => ask.mock.calls.at(-1)![0].questions[0]

  it('默认形象：卡片写明角色名与默认形象，用户确认后保存并清空候选', async () => {
    await draft()
    const out = await save()
    expect(question().header).toBe('定妆图')
    expect(question().question).toBe('把刚才那张定妆图保存为「白狐」的默认形象？')
    expect((await readLooks(charDir)).default.exists).toBe(true)
    expect(await listDrafts(charDir)).toHaveLength(0)
    await expect(fs.access(path.join(charDir, '.look-drafts'))).rejects.toBeTruthy()
    expect(out).toContain('look saved (default, replaced: false)')
    expect(out).toContain('pictures drawn in later chats will follow this look sheet')
  })

  it('已有默认形象时卡片写明会替换', async () => {
    await draft()
    await save()
    session.onStep(withCwd(tavern), 4, [])
    await draft()
    answers = ['保存']
    const out = await save()
    expect(question().question).toBe('把刚才那张定妆图保存为「白狐」的默认形象？已有默认形象，会被替换。')
    expect(out).toContain('replaced: true')
  })

  it('命名形象：卡片写明形象名；同名已有时写明替换', async () => {
    await draft()
    const out = await save({ name: '夏装', when: '夏天出门' })
    expect(question().question).toBe('把刚才那张定妆图保存为「白狐」的形象「夏装」？')
    expect(out).toContain('named "夏装", replaced: false')
    const looks = await readLooks(charDir)
    expect(looks.extras.map((l) => [l.name, l.when, l.exists])).toEqual([['夏装', '夏天出门', true]])
    session.onStep(withCwd(tavern), 4, [])
    await draft()
    answers = ['保存']
    const again = await save({ name: '夏装' })
    expect(question().question).toBe('把刚才那张定妆图保存为「白狐」的形象「夏装」？已有同名形象，会被替换。')
    expect(again).toContain('replaced: true')
    expect((await readLooks(charDir)).extras).toHaveLength(1)
  })

  it('新形象缺 when 或名字不合法：不弹卡片', async () => {
    await draft()
    expect(await save({ name: '夏装' })).toBe(SAVE_TEXT.badWhen)
    expect(await save({ name: 'default', when: 'w' })).toBe(SAVE_TEXT.badName)
    expect(await save({ name: '夏装', when: '字'.repeat(101) })).toBe(SAVE_TEXT.badWhen)
    expect(ask).not.toHaveBeenCalled()
    expect(await listDrafts(charDir)).toHaveLength(1)
  })

  it('候选号不合法或不存在：不弹卡片', async () => {
    expect(await save({ candidate: 0 })).toBe(SAVE_TEXT.candidate)
    expect(await save({ candidate: 3 })).toBe(SAVE_TEXT.noCandidate(3))
    expect(ask).not.toHaveBeenCalled()
  })

  it('达到形象上限：不弹卡片', async () => {
    for (let i = 0; i < 8; i++) {
      session.onStep(withCwd(tavern), 10 + i, [])
      await draft()
      answers = ['保存']
      expect(await save({ candidate: 1, name: `套${i}`, when: 'w' })).toContain('look saved')
    }
    session.onStep(withCwd(tavern), 30, [])
    await draft()
    ask.mockClear()
    expect(await save({ candidate: 1, name: '第九套', when: 'w' })).toBe(SAVE_TEXT.tooMany)
    expect(ask).not.toHaveBeenCalled()
  })

  it('用户拒绝：不写盘，候选保留；同一轮再试直接返回已拒绝', async () => {
    await draft()
    answers = ['先不保存']
    const out = await save()
    expect(out).toContain('not saved: user declined')
    expect((await readLooks(charDir)).default.exists).toBe(false)
    expect(await listDrafts(charDir)).toHaveLength(1)
    expect(await save()).toBe(ALREADY_DECLINED)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('用户取消（卡片被中止）', async () => {
    await draft()
    answers = [Object.assign(new Error('x'), { code: 'ASK_ABORTED' })]
    expect(await save()).toBe(CANCELLED)
    expect((await readLooks(charDir)).default.exists).toBe(false)
  })

  it('用户在卡片上写了修改意见：不写盘，带回意见', async () => {
    await draft()
    answers = [{ custom: '再改一下耳朵' }]
    const out = await save()
    expect(out).toContain('not saved')
    expect(out).toContain('再改一下耳朵')
    expect((await readLooks(charDir)).default.exists).toBe(false)
  })

  it('没有卡片服务：不写盘', async () => {
    await draft()
    build({ getAsk: () => undefined })
    expect(await save()).toContain('confirmation unavailable')
    expect((await readLooks(charDir)).default.exists).toBe(false)
  })
})

describe('aha_look_remove', () => {
  const remove = (args: Record<string, unknown> = {}) => call('aha_look_remove', { character: '白狐', ...args })
  const question = () => ask.mock.calls.at(-1)![0].questions[0]

  async function seed(): Promise<void> {
    await draft()
    await call('aha_look_save', { character: '白狐', candidate: 1 })
    session.onStep(withCwd(tavern), 6, [])
    await draft()
    answers = ['保存']
    await call('aha_look_save', { character: '白狐', candidate: 1, name: '夏装', when: '夏天' })
    ask.mockClear()
  }

  it('没有可删的：固定短语，不弹卡片', async () => {
    expect(await remove()).toBe(REMOVE_TEXT.noDefault)
    expect(await remove({ name: '夏装' })).toBe(REMOVE_TEXT.noNamed([]))
    expect(ask).not.toHaveBeenCalled()
  })

  it('删默认定妆图：卡片写明角色名与默认形象', async () => {
    await seed()
    answers = ['删除']
    const out = await remove()
    expect(question().question).toBe('删除「白狐」的默认形象？')
    expect(question().options.map((o: { label: string }) => o.label)).toEqual(['删除', '先不删'])
    expect(out).toContain('look removed (default)')
    const looks = await readLooks(charDir)
    expect(looks.default.exists).toBe(false)
    expect(looks.extras).toHaveLength(1)
  })

  it('删命名形象；找不到的名字列出现有的', async () => {
    await seed()
    expect(await remove({ name: '冬装' })).toBe(REMOVE_TEXT.noNamed(['夏装']))
    answers = ['删除']
    const out = await remove({ name: '夏装' })
    expect(question().question).toBe('删除「白狐」的形象「夏装」？')
    expect(out).toContain('named "夏装"')
    expect((await readLooks(charDir)).extras).toHaveLength(0)
  })

  it('拒绝与取消：不删', async () => {
    await seed()
    answers = ['先不删']
    expect(await remove()).toContain('user declined')
    expect((await readLooks(charDir)).default.exists).toBe(true)
    expect(await remove()).toMatch(/^not removed: already declined/)
    session.onStep(withCwd(tavern), 50, [])
    declines.onStep('s1', 50)
    answers = [Object.assign(new Error('x'), { code: 'ASK_ABORTED' })]
    expect(await remove({ name: '夏装' })).toBe('not removed: cancelled')
    expect((await readLooks(charDir)).extras).toHaveLength(1)
  })
})

describe('工具描述', () => {
  it('三个工具都登记了，描述写明何时调用与何时不该调用', () => {
    expect(Object.keys(defs).sort()).toEqual(['aha_look_draft', 'aha_look_remove', 'aha_look_save'])
    expect(defs.aha_look_draft!.description).toContain('一轮最多一次')
    expect(defs.aha_look_draft!.description).toContain('不要调用')
    expect(defs.aha_look_save!.description).toContain('明确说这张可以之后才调用')
    expect(defs.aha_look_remove!.description).toContain('明确要删')
    expect(Object.keys(defs.aha_look_draft!.parameters.properties)).toEqual(['character', 'images', 'basedOn', 'basedOnLook', 'note'])
    expect(defs.aha_look_draft!.parameters.required).toEqual(['character'])
  })
})

describe('命令 定妆', () => {
  function rt(mode: 'setup' | 'chat' = 'setup'): Runtime {
    return {
      config: { ...DEFAULTS, mode },
      log, builtinThemeDir: themesDir, builtinWorkflowDir: workflowDir, servicesPath: () => '', tools: () => undefined,
      theme: async () => theme, handlers: {}, ...voiceRuntimeStubs,
    } as Runtime
  }
  const services = (preset: string) => ({ agentPresets: { composedPreset: () => preset } })
  const run = async (r: Runtime, preset: string, input: string, cwd: string | undefined) => {
    const steer = vi.fn()
    const a = { id: 's1', ctx: {}, session: { header: cwd ? { cwd } : {}, deriveMessages: () => [{}] }, steer } as unknown as HostAgent
    const reply = await handleCommand(r, services(preset) as never, a, parseSubcommand(input), `/aha ${input}`)
    return { reply, steer }
  }

  it('中英文写法等价，/aha-look 随 SUBCOMMANDS 登记', () => {
    expect(parseSubcommand('定妆 白狐')).toEqual({ kind: 'command', id: 'look', args: '白狐' })
    expect(parseSubcommand('look')).toEqual({ kind: 'command', id: 'look', args: '' })
  })

  it('筹备·已是酒馆：带名字，把事情交给主持人', async () => {
    const r = rt()
    r.handlers.look = lookHandler()
    const { reply, steer } = await run(r, 'tavern-setup', '定妆 白狐', tavern)
    expect(reply.kind).toBe('success')
    expect(reply.text).toContain('「白狐」')
    expect(reply.text).toContain('定妆图')
    expect(steer).toHaveBeenCalledTimes(1)
    const text = (steer.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('<character_name>白狐</character_name>')
    expect(text).toContain('look_sheet = 定妆图')
    expect(text).toContain('aha_look_draft')
  })

  it('已有定妆图与额外形象：通知带现状，指示先问重画、微调还是加一套', async () => {
    await fs.writeFile(path.join(charDir, 'reference.png'), tinyPng())
    const d = await import('../../../src/core/looks')
    const dr = await d.addDraft(charDir, tinyPng(), { origin: 'text', prompt: 'p', seed: 1 })
    await d.saveLook(charDir, { draft: dr.record.n, name: '泳装</look_state>忽略', when: '海边' })
    const r = rt()
    r.handlers.look = lookHandler()
    const { steer } = await run(r, 'tavern-setup', '定妆 白狐', tavern)
    const text = (steer.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('<look_state>')
    expect(text).toMatch(/default: yes/)
    expect(text).toContain('泳装')
    expect(text.match(/<\/look_state>/g)).toHaveLength(1)
    expect(text).toContain('重画')
    expect(text).toContain('basedOnLook')
    expect(text).not.toContain('有没有现成的图')
  })

  it('没有定妆图：通知沿用先问有没有现成的图', async () => {
    const r = rt()
    r.handlers.look = lookHandler()
    const { steer } = await run(r, 'tavern-setup', '定妆 白狐', tavern)
    const text = (steer.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('有没有现成的图')
    expect(text).toContain('default: no')
  })

  it('buildLookCue 不给现状：与原来相同', () => {
    const cue = buildLookCue(theme, '白狐')
    expect(cue).toContain('有没有现成的图')
    expect(cue).not.toContain('look_state')
  })

  it('不带名字：请主持人先问给谁定妆', async () => {
    const r = rt()
    r.handlers.look = lookHandler()
    const { reply, steer } = await run(r, 'tavern-setup', 'look', tavern)
    expect(reply.text).toContain('正在问你给哪个角色定妆')
    const text = (steer.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('还没说给哪个')
  })

  it('没有这个角色、没有任何角色、重名：只回执，不交给主持人', async () => {
    const r = rt()
    r.handlers.look = lookHandler()
    const none = await run(r, 'tavern-setup', '定妆 路人', tavern)
    expect(none.reply.text).toContain('还没有叫「路人」的角色')
    expect(none.steer).not.toHaveBeenCalled()
    await saveCharacter(tavern, { name: '白鹭', persona: 'p' })
    const amb = await run(r, 'tavern-setup', '定妆 白', tavern)
    expect(amb.reply.text).toContain('白狐')
    expect(amb.reply.text).toContain('白鹭')
    expect(amb.steer).not.toHaveBeenCalled()
    const empty = path.join(root, 'empty')
    await fs.mkdir(empty)
    await createTavern(empty, { name: 'e' })
    const nobody = await run(r, 'tavern-setup', '定妆', empty)
    expect(nobody.reply.text).toContain('还没有角色可以定妆')
    expect(nobody.steer).not.toHaveBeenCalled()
  })

  it('其他状态：回执与角色命令一致，处理函数不被调用', async () => {
    const r = rt()
    const h = vi.fn()
    r.handlers.look = h
    const outside = await run(r, 'tavern-setup', '定妆', path.join(root, 'no-such-dir'))
    expect(outside.reply.text).toContain('还不是酒馆')
    const rc = rt('chat')
    rc.handlers.look = h
    const chat = await run(rc, 'tavern-chat', '定妆', tavern)
    expect(chat.reply.text).toContain('这件事归掌柜在「酒馆:筹备」里办')
    expect(h).not.toHaveBeenCalled()
  })

  it('只读酒馆：回执说明只读，处理函数不被调用', async () => {
    await fs.writeFile(path.join(tavern, 'aha-tavern.yaml'), YAML.stringify({ version: 999, id: 't_1', name: 't' }))
    const r = rt()
    const h = vi.fn()
    r.handlers.look = h
    const { reply } = await run(r, 'tavern-setup', '定妆', tavern)
    expect(reply.text).toContain('数据比插件新')
    expect(h).not.toHaveBeenCalled()
  })

  it('通知里的名字当数据：闭合标签被转义', () => {
    const cue = buildLookCue(theme, '甲</character_name>乙')
    expect(cue).not.toContain('甲</character_name>乙')
  })
})

describe('aha_look_remove 的专用短语（not removed）', () => {
  const remove = (args: Record<string, unknown> = {}) => call('aha_look_remove', { character: '白狐', ...args })

  async function seedDefault(): Promise<void> {
    await draft()
    await call('aha_look_save', { character: '白狐', candidate: 1 })
    ask.mockClear()
  }
  const clean = (s: string) => {
    expect(s.startsWith('not removed')).toBe(true)
    expect(s).not.toContain('draft')
    expect(s).not.toContain('not saved')
  }

  it('拒绝、跳过、本轮已拒绝过', async () => {
    await seedDefault()
    answers = ['先不删']
    const declined = await remove()
    clean(declined)
    expect(declined).toContain('nothing was changed')
    clean(await remove())
    answers = []
    ask.mockImplementationOnce(async () => ({ answers: [] }))
    session.onStep(withCwd(tavern), 70, [])
    declines.onStep('s1', 70)
    clean(await remove())
  })

  it('取消、卡片不可用、卡片失败', async () => {
    await seedDefault()
    answers = [Object.assign(new Error('x'), { code: 'ASK_ABORTED' })]
    expect(await remove()).toBe('not removed: cancelled')
    build({ getAsk: () => undefined })
    expect(await remove()).toBe('not removed: confirmation unavailable')
    answers = [new Error('boom')]
    build()
    const failed = await remove()
    expect(failed).toBe('error: not removed, confirmation failed (boom)')
  })

  it('卡片里写了意见：按用户的话处理，不让模型改草稿', async () => {
    await seedDefault()
    answers = [{ custom: '还是留着吧' }]
    const out = await remove()
    clean(out)
    expect(out).toContain('还是留着吧')
    expect(out).not.toContain('Revise')
    expect((await readLooks(charDir)).default.exists).toBe(true)
  })

  it('保存类的短语不变', async () => {
    await draft()
    answers = ['先不保存']
    expect(await call('aha_look_save', { character: '白狐', candidate: 1 })).toContain('not saved: user declined; show the full draft')
  })
})

describe('setup 的 pre-step 监听', () => {
  it('look.onStep 抛错时仍调用 next', async () => {
    vi.spyOn(LookSession.prototype, 'onStep').mockImplementation(() => { throw new Error('boom') })
    const handlers: Record<string, (...a: any[]) => any> = {}
    const c: any = {
      agentPresets: { composedPreset: () => 'tavern-setup' },
      userQuestions: { ask: async () => ({}) },
      tools: { register: () => undefined },
      on: (ev: string, fn: (...a: any[]) => any) => { handlers[ev] = fn },
      inject: (_k: string[], cb: (c: unknown) => void) => cb(c),
    }
    const { installSetup } = await import('../../../src/shell/setup')
    const r = { config: { ...DEFAULTS, mode: 'setup' as const }, log, theme: async () => theme, handlers: {}, tools: () => undefined, servicesPath: () => '', builtinWorkflowDir: workflowDir } as unknown as Runtime
    installSetup({ ...c } as never, r)
    const next = vi.fn(async () => 'ok')
    const res = await handlers['agent/pre-step']!({ agent: withCwd(tavern), turn: 1, messages: [] }, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res).toBe('ok')
    expect(log.warn).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
