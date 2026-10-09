import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComfyError, type ComfyClient, type ObjectInfo } from '../../../src/core/comfy'
import { loadImageService } from '../../../src/core/services'
import { loadWorkflow, requirementsOf } from '../../../src/core/workflow'
import { loadTheme } from '../../../src/core/theme'
import type { HostAgent, Invocation } from '../../../src/shell/context'
import { doctorHandler } from '../../../src/shell/doctor'
import { checkDrawing, wantsTrial, type DrawDoctorDeps } from '../../../src/shell/draw-doctor'
import {
  drawBriefText, drawDoctorBrief, drawDoctorCardReceipt, drawDoctorMarkdown, drawDoctorOneLine, unavailableWhy,
} from '../../../src/shell/receipts'
import { OPT_CLOSE, OPT_RECHECK, OPT_TRIAL, RECHECK_MAX } from '../../../src/shell/doctor'
import { SessionGate } from '../../../src/shell/confirm'

const fake = {
  probe: vi.fn(), objectInfo: vi.fn(), generate: vi.fn(), interrupt: vi.fn(),
}
vi.mock('../../../src/core/comfy', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/comfy')>()
  return { ...actual, createComfyClient: () => fake }
})

const builtinWorkflowDir = path.resolve(__dirname, '../../../workflows')
const themeDir = path.resolve(__dirname, '../../../themes')
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const agent: HostAgent = { id: 's1', ctx: {} }

let dir: string
let yaml: string
let log: { debug: any; info: any; warn: any; error: any }
let clock: number

const fullInfo = async (workflow = 'qwen-image-2.1', drop: string[] = []): Promise<ObjectInfo> => {
  const req = requirementsOf(await loadWorkflow(workflow, builtinWorkflowDir), {})
  const info: ObjectInfo = {}
  for (const t of req.nodeTypes) if (!drop.includes(t)) info[t] = {}
  for (const m of req.models) if (info[m.nodeType]) info[m.nodeType]![m.input] = [m.file]
  return info
}

const deps = (over: Partial<DrawDoctorDeps> = {}): DrawDoctorDeps => ({
  loadService: () => loadImageService(yaml),
  createClient: () => fake as unknown as ComfyClient,
  builtinWorkflowDir,
  tmpDir: dir,
  now: () => (clock += 2000),
  random: () => 0.5,
  log,
  ...over,
})

const write = (image: string) => fs.writeFile(yaml, image)
const CONFIG = 'image:\n  endpoint: http://10.0.0.1:8188/some/path?token=abc\n'

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-doctor-'))
  yaml = path.join(dir, 'services.yaml')
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  clock = 1_000_000
  for (const f of Object.values(fake)) f.mockReset()
  fake.probe.mockResolvedValue('0.3.50')
  fake.objectInfo.mockResolvedValue(await fullInfo())
  fake.generate.mockResolvedValue({ bytes: png, ext: 'png' })
  await write(CONFIG)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const text = async (args = '', over: Partial<DrawDoctorDeps> = {}) =>
  drawDoctorOneLine(await checkDrawing(deps(over), { trial: wantsTrial(args) }))

describe('wantsTrial', () => {
  it('生图 / image（不分大小写）才试出图', () => {
    expect(wantsTrial(' 生图 ')).toBe(true)
    expect(wantsTrial('image')).toBe(true)
    expect(wantsTrial('IMAGE')).toBe(true)
    expect(wantsTrial('生图 吧')).toBe(false)
    expect(wantsTrial('')).toBe(false)
  })
})

describe('检查', () => {
  it('没配置：只报未配置', async () => {
    await fs.rm(yaml)
    const t = await text()
    expect(t).toBe('生图：未配置。配置方法见 docs/image-setup.md。')
    expect(fake.probe).not.toHaveBeenCalled()
  })

  it('地址格式不对：未配置并列出问题清单', async () => {
    await write('image:\n  endpoint: 10.0.0.1:8188\n')
    const t = await text()
    expect(t).toContain('生图：未配置')
    expect(t).toContain('! image.endpoint 必须是 http:// 或 https:// 开头的地址')
    expect(fake.probe).not.toHaveBeenCalled()
  })

  it('连不上：报告后结束，地址只有主机与端口', async () => {
    fake.probe.mockRejectedValue(new ComfyError('unreachable', 'ECONNREFUSED secret-detail'))
    const t = await text()
    expect(t).toBe('✗ 生图服务 10.0.0.1:8188 连不上')
    expect(t).not.toContain('some/path')
    expect(t).not.toContain('token')
    expect(t).not.toContain('secret-detail')
    expect(fake.objectInfo).not.toHaveBeenCalled()
    expect(log.debug).toHaveBeenCalled()
  })

  it('工作流有问题：仍显示服务已连上，之后不查', async () => {
    await write(CONFIG + '  workflow: no-such-flow\n')
    const t = await text()
    expect(t).toContain('✓ 生图服务 10.0.0.1:8188 已连上（ComfyUI 0.3.50）')
    expect(t).toContain('✗ 工作流 no-such-flow：工作流不存在：no-such-flow')
    expect(fake.objectInfo).not.toHaveBeenCalled()
  })

  it('缺节点：列出，GGUF 节点带专门提示，且不查模型', async () => {
    await write(CONFIG + '  workflow: qwen-image-2.1-gguf\n')
    fake.objectInfo.mockResolvedValue(await fullInfo('qwen-image-2.1-gguf', ['UnetLoaderGGUF']))
    const t = await text()
    expect(t).toContain('✗ 缺少节点：UnetLoaderGGUF')
    expect(t).toContain('ComfyUI-GGUF')
    expect(t).toContain('qwen-image-2.1（只用自带节点）')
    expect(t).not.toContain('模型')
  })

  it('缺节点但不是 GGUF：没有 GGUF 提示', async () => {
    fake.objectInfo.mockResolvedValue(await fullInfo('qwen-image-2.1', ['VAELoader']))
    const t = await text()
    expect(t).toContain('✗ 缺少节点：VAELoader')
    expect(t).not.toContain('ComfyUI-GGUF')
  })

  it('缺模型：文件名、目录、下载地址都在回执里', async () => {
    const info = await fullInfo()
    info.VAELoader!.vae_name = ['other.safetensors']
    fake.objectInfo.mockResolvedValue(info)
    const t = await text()
    expect(t).toContain('✓ 节点齐全（')
    expect(t).toContain('✗ 缺少模型 qwen_image_2.1_vae_bf16.safetensors，放到 ComfyUI/models/vae/')
    expect(t).toContain('https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors')
  })

  it('读不到可选列表：无法确认，不算缺', async () => {
    const info = await fullInfo()
    delete info.VAELoader!.vae_name
    fake.objectInfo.mockResolvedValue(info)
    const t = await text('生图')
    expect(t).toContain('? 无法确认模型 qwen_image_2.1_vae_bf16.safetensors')
    expect(t).not.toContain('✗')
    expect(t).toContain('✓ 试出图成功')
  })

  it('全部通过', async () => {
    const t = await text()
    expect(t.split('；')).toEqual([
      '✓ 生图服务 10.0.0.1:8188 已连上（ComfyUI 0.3.50）',
      '✓ 工作流 qwen-image-2.1',
      expect.stringMatching(/^✓ 节点齐全（\d+ 种）$/),
      '✓ 模型文件齐全',
    ])
    expect(fake.generate).not.toHaveBeenCalled()
  })

  it('配置回落默认值的问题放在最后', async () => {
    await write(CONFIG + '  steps: abc\n')
    const t = await text()
    const lines = t.split('；')
    expect(lines[lines.length - 1]).toMatch(/^! /)
    expect(lines[lines.length - 1]).toContain('steps')
  })

  it('读节点信息失败：报告，ComfyUI 原文不进回执', async () => {
    fake.objectInfo.mockRejectedValue(new ComfyError('unreachable', 'raw server text'))
    const t = await text()
    expect(t).toContain('✗ 读不到节点信息')
    expect(t).not.toContain('（超')
    expect(t).not.toContain('raw server text')
  })

  it('取消信号传给节点信息请求', async () => {
    const ac = new AbortController()
    await checkDrawing(deps(), { trial: false, signal: ac.signal })
    expect(fake.objectInfo.mock.calls[0]![0].signal).toBe(ac.signal)
  })
})

describe('试出图', () => {
  it.each(['生图', 'image', 'IMAGE'])('参数 %s：成功，文件写到临时目录', async (arg) => {
    const report = await checkDrawing(deps(), { trial: wantsTrial(arg) })
    expect(report.trial).toMatchObject({ status: 'ok', seconds: 2 })
    const p = (report.trial as { path: string }).path
    expect(path.dirname(p)).toBe(dir)
    expect(path.basename(p)).toMatch(/^aha-tavern-doctor-\d+-[0-9a-f]{8}\.png$/)
    expect([...(await fs.readFile(p))]).toEqual([...png])
    expect(drawDoctorOneLine(report)).toContain(`✓ 试出图成功，用时 2 秒：${p}`)
    const [graph, opts] = fake.generate.mock.calls[0]!
    expect(JSON.stringify(graph)).toContain('一只橘猫趴在木质吧台上，暖色灯光')
    expect(opts.timeoutMs).toBe(180_000)
  })

  it('失败：给出失败种类，不含原文', async () => {
    fake.generate.mockRejectedValue(new ComfyError('failed', 'traceback blah'))
    const t = await text('生图')
    expect(t).toContain('✗ 试出图失败（出错）')
    expect(t).not.toContain('traceback')
    fake.generate.mockRejectedValue(new ComfyError('timeout'))
    expect(await text('生图')).toContain('✗ 试出图失败（超时）')
  })

  it('取消信号传给出图请求', async () => {
    const ac = new AbortController()
    await checkDrawing(deps(), { trial: true, signal: ac.signal })
    expect(fake.generate.mock.calls[0]![1].signal).toBe(ac.signal)
  })

  it('前面有未通过的项时不试出图', async () => {
    fake.objectInfo.mockResolvedValue(await fullInfo('qwen-image-2.1', ['VAELoader']))
    const t = await text('生图')
    expect(t).toContain('前面有未通过的项，没有试出图。')
    expect(fake.generate).not.toHaveBeenCalled()
  })

  it('其他参数被忽略', async () => {
    const t = await text('随便')
    expect(t).not.toContain('试出图')
    expect(fake.generate).not.toHaveBeenCalled()
  })
})

describe('小结与报告', () => {
  it('各种情形的一行小结', async () => {
    expect(drawDoctorBrief({ configured: false, problems: [] })).toMatchObject({ status: '未配置', flagged: true })
    expect(drawDoctorBrief(await checkDrawing(deps(), { trial: false }))).toEqual({ status: '可用', notes: [], flagged: false })
    fake.probe.mockRejectedValue(new ComfyError('unreachable'))
    expect(drawDoctorBrief(await checkDrawing(deps(), { trial: false })).status).toBe('不可用：连不上 10.0.0.1:8188')
    fake.probe.mockResolvedValue('1')
    await write(CONFIG + '  workflow: nope\n')
    expect(drawDoctorBrief(await checkDrawing(deps(), { trial: false })).status).toBe('不可用：工作流读不了')
    await write(CONFIG)
    fake.objectInfo.mockRejectedValue(new ComfyError('unreachable'))
    expect(drawDoctorBrief(await checkDrawing(deps(), { trial: false })).status).toBe('不可用：读不到节点信息')
    fake.objectInfo.mockResolvedValue(await fullInfo('qwen-image-2.1', ['VAELoader', 'CLIPLoader']))
    expect(drawDoctorBrief(await checkDrawing(deps(), { trial: false })).status).toMatch(/^不可用：缺少节点 \w+ 等 2 项$/)
    const info = await fullInfo()
    info.VAELoader!.vae_name = []
    fake.objectInfo.mockResolvedValue(info)
    expect(drawDoctorBrief(await checkDrawing(deps(), { trial: false })).status)
      .toBe('不可用：缺少模型 qwen_image_2.1_vae_bf16.safetensors')
  })

  it('配置有问题但其余通过：可用，括注配置问题并提示详情', async () => {
    await write(CONFIG + '  steps: abc\n')
    const b = drawDoctorBrief(await checkDrawing(deps(), { trial: false }))
    expect(drawBriefText(b)).toBe('生图 可用（配置有 1 处写法不对）')
    expect(b.flagged).toBe(true)
  })

  it('括注合并会话说明', () => {
    expect(drawBriefText({ status: '可用', notes: [], flagged: false }, '这个会话只读，不能画图')).toBe('生图 可用（这个会话只读，不能画图）')
  })

  it('Markdown：一项一行的列表，下载地址是链接', async () => {
    const info = await fullInfo()
    info.VAELoader!.vae_name = []
    fake.objectInfo.mockResolvedValue(info)
    const md = drawDoctorMarkdown(await checkDrawing(deps(), { trial: false }))
    expect(md.split('\n').every((l) => l.startsWith('- ') || l.startsWith('  - '))).toBe(true)
    expect(md).toContain('[下载地址](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors)')
  })

  it('not-configured 有说法', () => {
    expect(unavailableWhy('not-configured')).toBe('还没有配置生图服务')
    expect(unavailableWhy('zzz')).toBe('原因不明')
  })

  it('版本号截断并去掉控制字符', async () => {
    fake.probe.mockResolvedValue('1.0\n\x07' + 'x'.repeat(100))
    const r = await checkDrawing(deps(), { trial: false })
    expect(r.service!.version!.length).toBe(40)
    expect(r.service!.version).not.toMatch(/[\n\x07]/)
  })

  it('版本号不像版本号（比如网址）：当作未知', async () => {
    for (const v of ['http://evil.example/x', 'www.evil.example', '点这里 0.1']) {
      fake.probe.mockResolvedValue(v)
      const r = await checkDrawing(deps(), { trial: false })
      expect(r.service).toMatchObject({ connected: true, version: '' })
    }
  })

  it('读节点信息时被取消：算已取消，不算读不到', async () => {
    const ac = new AbortController()
    fake.objectInfo.mockImplementation(async () => {
      ac.abort()
      throw new ComfyError('cancelled')
    })
    const r = await checkDrawing(deps(), { trial: false, signal: ac.signal })
    expect(r.cancelled).toBe(true)
    expect(r.nodes).toBeUndefined()
  })

  it('绝对路径的工作流：失败原因里不带完整路径', async () => {
    const wfPath = path.join(dir, 'nope.json')
    await write(CONFIG + `  workflow: ${wfPath}\n`)
    const r = await checkDrawing(deps(), { trial: false })
    expect(r.workflow).toEqual({ name: 'nope.json', ok: false, reason: '工作流不存在：nope.json' })
    expect(drawDoctorOneLine(r)).not.toContain(dir)
  })

  it('数量与长度上限', async () => {
    const r = await checkDrawing(deps(), { trial: false })
    r.nodes!.missing = Array.from({ length: 15 }, (_, i) => `N${i}` + 'x'.repeat(200))
    const line = drawDoctorOneLine(r)
    expect(line).toContain('等 15 项')
    expect(line).not.toContain('N10')
    expect(line).not.toContain('x'.repeat(130))
    r.problems = Array.from({ length: 12 }, (_, i) => `p${i}`)
    expect(drawDoctorOneLine(r)).toContain('! 等 12 项')
  })

  it('带用户名密码的地址：不发请求，日志里没有凭据', async () => {
    await write('image:\n  endpoint: http://bob:hunter2@10.0.0.1:8188\n')
    const r = await checkDrawing(deps(), { trial: true })
    expect(fake.probe).not.toHaveBeenCalled()
    const line = drawDoctorOneLine(r)
    expect(line).toContain('地址里不要带用户名和密码')
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('bob')
    expect(drawDoctorBrief(r).status).toBe('不可用：地址里带了用户名和密码')
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('hunter2')
  })

  it('错误原文里的凭据在写日志前去掉', async () => {
    fake.probe.mockRejectedValue(new ComfyError('unreachable', 'fetch http://u:pw@10.0.0.1:8188/x failed'))
    await checkDrawing(deps(), { trial: false })
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('pw@')
  })

  it('试出图写盘失败归为图片保存失败', async () => {
    const r = await checkDrawing(deps({ tmpDir: path.join(dir, 'missing-dir') }), { trial: true })
    expect(r.trial).toEqual({ status: 'failed', kind: 'save' })
    expect(drawDoctorOneLine(r)).toContain('图片保存失败')
  })

  it('已取消：提前结束', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await checkDrawing(deps(), { trial: true, signal: ac.signal })
    expect(r.cancelled).toBe(true)
    expect(fake.probe).not.toHaveBeenCalled()
    const ac2 = new AbortController()
    fake.probe.mockImplementation(async () => { ac2.abort(); return '1' })
    const r2 = await checkDrawing(deps(), { trial: false, signal: ac2.signal })
    expect(r2.cancelled).toBe(true)
    expect(fake.objectInfo).not.toHaveBeenCalled()
  })

  it('卡片回执', async () => {
    const ok = await checkDrawing(deps(), { trial: false })
    expect(drawDoctorCardReceipt(ok).text).toBe('生图自检：全部通过。')
    expect(drawDoctorCardReceipt({ ...ok, trial: { status: 'ok', seconds: 14, path: '/x' } }).text)
      .toBe('生图自检：全部通过，试出图成功（14 秒）。')
    expect(drawDoctorCardReceipt({ ...ok, trial: { status: 'failed', kind: 'timeout' } }).text)
      .toBe('生图自检：全部通过，试出图失败（超时）。')
    fake.objectInfo.mockResolvedValue(await fullInfo('qwen-image-2.1', ['VAELoader', 'CLIPLoader']))
    expect(drawDoctorCardReceipt(await checkDrawing(deps(), { trial: false })).text).toBe('生图自检：2 项未通过。')
  })
})

describe('doctorHandler', () => {
  let drawing: { refresh: ReturnType<typeof vi.fn> }
  let askFn: ReturnType<typeof vi.fn> | undefined
  let gate: SessionGate

  const inv = async (mode: 'setup' | 'chat', args = '', signal?: AbortSignal): Promise<Invocation> => {
    const { theme } = await loadTheme({ name: 'plain', builtinDir: themeDir })
    return {
      agent, args, label: '/aha 自检', theme, ...(signal ? { signal } : {}),
      services: {} as any,
      rt: {
        log, servicesPath: () => yaml, builtinWorkflowDir, tools: () => undefined, drawing,
        cards: { gate, getAsk: () => askFn as any },
        handlers: {}, config: {} as any, builtinThemeDir: themeDir, theme: async () => theme,
      } as any,
      context: { mode, tavern: { dir: '/long/tavern/path' }, outsideReason: null, cwd: null, sessionId: 's1' } as any,
      steer: vi.fn(),
    }
  }
  const pick = (...labels: string[]) => {
    const q = [...labels]
    askFn!.mockImplementation(async (req: any) => ({ answers: [{ id: req.questions[0].id, selected: [q.shift() ?? OPT_CLOSE] }] }))
  }

  beforeEach(() => {
    drawing = { refresh: vi.fn() }
    askFn = vi.fn()
    gate = new SessionGate()
  })

  it('不带参数：一行，生图小结在酒馆路径之前，不弹卡片、不试出图', async () => {
    drawing.refresh.mockResolvedValue({ available: true, settings: null, reason: 'ok' })
    const r = await doctorHandler(await inv('chat'))
    const t = r.text as string
    expect(r.kind).toBe('success')
    expect(t).not.toContain('\n')
    expect(t).toMatch(/^当前状态：模式 .+；生图 可用；/)
    expect(t.indexOf('生图 可用')).toBeLessThan(t.indexOf('/long/tavern/path'))
    expect(t).not.toContain('看详情')
    expect(askFn).not.toHaveBeenCalled()
    expect(fake.generate).not.toHaveBeenCalled()
    expect(drawing.refresh).toHaveBeenCalledWith(agent)
  })

  it('有问题：行末提示看详情', async () => {
    fake.probe.mockRejectedValue(new ComfyError('unreachable'))
    drawing.refresh.mockResolvedValue({ available: false, settings: null, reason: 'unreachable' })
    const t = (await doctorHandler(await inv('chat'))).text as string
    expect(t).toContain('生图 不可用：连不上 10.0.0.1:8188')
    expect(t).not.toContain('这个会话')
    expect(t.endsWith('（/aha 自检 生图 看详情）')).toBe(true)
  })

  it('未配置', async () => {
    await fs.rm(yaml)
    const t = (await doctorHandler(await inv('setup'))).text as string
    expect(t).toContain('生图 未配置')
    expect(t.endsWith('（/aha 自检 生图 看详情）')).toBe(true)
  })

  it('小结与会话结论不一致：加括注', async () => {
    drawing.refresh.mockResolvedValue({ available: false, settings: null, reason: 'readonly' })
    const t = (await doctorHandler(await inv('chat'))).text as string
    expect(t).toContain('生图 可用（这个会话只读，不能画图）')
    expect(t.endsWith('（/aha 自检 生图 看详情）')).toBe(true)
  })

  it('刷新结论是还没开始聊天：不加括注；筹备模式不刷新', async () => {
    drawing.refresh.mockResolvedValue({ available: false, settings: null, reason: 'not-chatting' })
    expect((await doctorHandler(await inv('chat'))).text).toContain('生图 可用；')
    drawing.refresh.mockClear()
    await doctorHandler(await inv('setup'))
    expect(drawing.refresh).not.toHaveBeenCalled()
  })

  it('已取消', async () => {
    const ac = new AbortController()
    ac.abort()
    expect((await doctorHandler(await inv('setup', '', ac.signal))).text).toBe('自检已取消。')
  })

  it('生图参数：卡片是 Markdown，全部通过时选项为试出一张图 / 关闭，关闭后回执', async () => {
    pick(OPT_CLOSE)
    const r = await doctorHandler(await inv('setup', '生图'))
    const req = askFn!.mock.calls[0]![0]
    expect(req.questions).toHaveLength(1)
    expect(req.questions[0].header).toBe('生图自检')
    expect(req.questions[0].question).toBe('生图服务检查结果：全部通过')
    expect(req.questions[0].detail).toMatch(/^- ✓ 生图服务 /m)
    expect(req.questions[0].options.map((o: any) => o.label)).toEqual([OPT_TRIAL, OPT_CLOSE])
    expect(r).toEqual({ kind: 'success', text: '生图自检：全部通过。' })
    expect(fake.generate).not.toHaveBeenCalled()
  })

  it('选试出一张图：写临时目录，第二张卡片写文件路径、不带图片行，选项只有关闭', async () => {
    pick(OPT_TRIAL, OPT_CLOSE)
    const r = await doctorHandler(await inv('setup', 'IMAGE'))
    expect(askFn).toHaveBeenCalledTimes(2)
    const q2 = askFn!.mock.calls[1]![0].questions[0]
    const m = /图片存在：`(.+?)`/.exec(q2.detail)
    expect(q2.detail).not.toContain('![')
    expect(m).not.toBeNull()
    expect(path.dirname(m![1] as string)).toBe(os.tmpdir())
    expect(q2.options.map((o: any) => o.label)).toEqual([OPT_CLOSE])
    expect(r.text).toMatch(/^生图自检：全部通过，试出图成功（\d+ 秒）。$/)
    await fs.rm(m![1] as string, { force: true })
  })

  it('试出图失败：第二张卡片写原因', async () => {
    fake.generate.mockRejectedValue(new ComfyError('timeout', 'raw'))
    pick(OPT_TRIAL, OPT_CLOSE)
    const r = await doctorHandler(await inv('setup', '生图'))
    const q = askFn!.mock.calls[1]![0].questions[0].detail
    expect(q).toContain('试出图失败（超时）')
    expect(q).not.toContain('raw')
    expect(r.text).toBe('生图自检：全部通过，试出图失败（超时）。')
  })

  it('有未通过项：选项为重新检查 / 关闭；重新检查会再弹卡片', async () => {
    fake.objectInfo.mockResolvedValueOnce(await fullInfo('qwen-image-2.1', ['VAELoader']))
    pick(OPT_RECHECK, OPT_CLOSE)
    const r = await doctorHandler(await inv('setup', '生图'))
    expect(askFn!.mock.calls[0]![0].questions[0].options.map((o: any) => o.label)).toEqual([OPT_RECHECK, OPT_CLOSE])
    expect(askFn).toHaveBeenCalledTimes(2)
    expect(r.text).toBe('生图自检：全部通过。')
  })

  it('重新检查最多连续 5 次', async () => {
    fake.objectInfo.mockResolvedValue(await fullInfo('qwen-image-2.1', ['VAELoader']))
    askFn!.mockImplementation(async (req: any) => ({ answers: [{ id: req.questions[0].id, selected: [OPT_RECHECK] }] }))
    const r = await doctorHandler(await inv('setup', '生图'))
    expect(askFn).toHaveBeenCalledTimes(RECHECK_MAX + 1)
    expect(r.text).toBe('生图自检：1 项未通过。')
  })

  it('卡片被跳过或取消：结束', async () => {
    askFn!.mockResolvedValue({})
    expect((await doctorHandler(await inv('setup', '生图'))).text).toBe('生图自检：全部通过。')
    askFn!.mockRejectedValue(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))
    expect((await doctorHandler(await inv('setup', '生图'))).text).toBe('自检已取消。')
  })

  it('卡片流程后刷新单聊的画图能力', async () => {
    drawing.refresh.mockResolvedValue({ available: true, settings: null, reason: 'ok' })
    pick(OPT_CLOSE)
    await doctorHandler(await inv('chat', '生图'))
    expect(drawing.refresh).toHaveBeenCalledTimes(1)
  })

  it('已有卡片未答：不弹新卡片', async () => {
    let release!: () => void
    const held = gate.run('s1', () => new Promise<void>((r) => { release = r }), 'command')
    const r = await doctorHandler(await inv('setup', '生图'))
    expect(r.text).toBe('有一张卡片还没回答，先处理它再自检。')
    expect(askFn).not.toHaveBeenCalled()
    release()
    await held
  })

  it('没有提问服务：降级成一行长文，且试出图', async () => {
    askFn = undefined
    const r = await doctorHandler(await inv('setup', '生图'))
    const t = r.text as string
    expect(t).not.toContain('\n')
    expect(t).toContain('✓ 试出图成功')
    const m = /：(\/[^；]+)$/.exec(t)
    await fs.rm(m![1] as string, { force: true })
  })
})
