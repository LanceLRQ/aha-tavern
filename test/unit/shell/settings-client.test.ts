// 设置页浏览器端的冒烟测试：真的打一次包，在假的 window 与极简的 React 里加载，核对入口格式、
// 注册到插件页的槽位、页面能渲染并把操作转成对插件端的远程调用。不依赖真实浏览器与宿主。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error 构建脚本是 .mjs，没有类型声明
import { buildAll } from '../../../scripts/build.mjs'
import { SETTINGS_METHODS } from '../../../src/shared/settings-rpc'

// ---------- 极简 React：函数组件 + useState/useEffect/useRef，按位置保存状态 ----------

type Node = { type: unknown; props: Record<string, any>; children: unknown[] }

function createMiniReact() {
  const store = new Map<string, any>()
  let path = ''
  let idx = 0
  let dirty = false
  const effects: (() => void)[] = []
  const key = () => `${path}#${idx++}`
  const React = {
    createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children }),
    useState<T>(initial: T) {
      const k = key()
      if (!store.has(k)) store.set(k, { value: typeof initial === 'function' ? (initial as () => T)() : initial })
      const slot = store.get(k)
      return [slot.value, (next: any) => {
        const v = typeof next === 'function' ? next(slot.value) : next
        if (v !== slot.value) { slot.value = v; dirty = true }
      }]
    },
    useRef<T>(initial: T) {
      const k = key()
      if (!store.has(k)) store.set(k, { current: initial })
      return store.get(k)
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const k = key()
      const prev = store.get(k)
      const same = prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, i) => d === prev.deps[i])
      if (same) return
      store.set(k, { deps })
      effects.push(() => { fn() })
    },
  }
  function expand(node: any, at: string): any {
    if (Array.isArray(node)) return node.map((n, i) => expand(n, `${at}.${i}`))
    if (node === null || node === undefined || typeof node !== 'object') return node
    const n = node as Node
    if (typeof n.type === 'function') {
      path = at
      idx = 0
      const out = (n.type as (p: unknown) => unknown)({ ...n.props, children: n.children })
      return expand(out, `${at}/f`)
    }
    return { type: n.type, props: n.props, children: n.children.map((c, i) => expand(c, `${at}.${i}`)) }
  }
  /** 渲染到稳定：反复渲染、执行副作用、让出微任务。 */
  async function render(root: unknown): Promise<any> {
    let tree: any
    for (let i = 0; i < 30; i += 1) {
      dirty = false
      effects.length = 0
      tree = expand(root, 'r')
      const pending = [...effects]
      pending.forEach((e) => e())
      await new Promise((r) => setTimeout(r, 0))
      if (!dirty && pending.length === 0) break
    }
    return tree
  }
  return { React, render }
}

const textOf = (n: any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : n && typeof n === 'object' ? n.children.map(textOf).join('') : '')
function findAll(n: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(n)) n.forEach((c) => findAll(c, pred, out))
  else if (n && typeof n === 'object') {
    if (pred(n)) out.push(n)
    n.children.forEach((c: any) => findAll(c, pred, out))
  }
  return out
}
const button = (tree: any, label: string) => findAll(tree, (n) => n.type === 'button' && textOf(n) === label)[0]

// ---------- 加载打包产物 ----------

let outdir: string
let clientModule: any
let registered: { meta: any; component: any }[]
let mounted: any[]
let disposed: string[]
let timers: Map<number, () => void>

beforeAll(async () => {
  outdir = await fs.mkdtemp(path.join(os.tmpdir(), 'aha-client-build-'))
  await buildAll({ outdir, logLevel: 'silent' })
})
afterAll(async () => {
  await fs.rm(outdir, { recursive: true, force: true })
})

const ok = (value: unknown) => ({ ok: true, value })
const stateOf = (over: Record<string, any> = {}) => ({
  servicesPath: '/home/x/services.yaml',
  workflows: ['qwen-image-2.1'],
  voice: { form: { endpoint: 'http://127.0.0.1:18123', launch: 'mlx', model: '', modelsDir: '', hfEndpoint: '', read: '', language: '', timeoutSeconds: '' } },
  image: { form: { endpoint: '', workflow: '', auto: '', style: '', width: '', height: '', steps: '', timeoutSeconds: '', unet: '', clip: '', vae: '' } },
  defaults: {
    voice: { launch: 'none', model: '0.6b', modelsDir: '/d/voice', read: 'lines', language: 'chinese', timeoutSeconds: 120 },
    image: { workflow: 'qwen-image-2.1', auto: true, style: '画风', width: 832, height: 1216, steps: 12, timeoutSeconds: 180 },
  },
  problems: { file: [], voice: [], image: [] },
  voiceStatus: { state: 'stopped', text: '语音服务：未启动。', canStart: true, canStop: false, env: { supported: true, uv: true, envInstalled: false, modelDownloaded: false } },
  ...over,
})

function loadClient() {
  registered = []
  mounted = []
  disposed = []
  timers = new Map()
  let timerId = 0
  const mini = createMiniReact()
  const sandbox: any = {
    setInterval: (fn: () => void) => { timerId += 1; timers.set(timerId, fn); return timerId },
    clearInterval: (id: number) => { timers.delete(id) },
    window: {
      __ModuleLoader__: {
        load: (def: { id: string; factory: (req: (id: string) => unknown) => unknown }) => {
          sandbox.loaded = def
          clientModule = def.factory((id) => {
            if (id === 'react') return mini.React
            throw new Error(`未预期的 require：${id}`)
          })
        },
      },
    },
  }
  vm.createContext(sandbox)
  return fs.readFile(path.join(outdir, 'client.js'), 'utf8').then((code) => {
    vm.runInContext(code, sandbox)
    return { sandbox, mini }
  })
}

function fakeClientCtx(remote: Record<string, unknown>) {
  const c: any = {
    effect: (fn: () => unknown) => fn(),
    locale: { register: vi.fn(() => () => disposed.push('locale')) },
    slots: {
      inject: (_name: string, cb: () => unknown) => cb(),
      register: (meta: unknown, component: unknown) => { registered.push({ meta, component }); return () => disposed.push('slot') },
    },
    remote: { ahaSettings: remote },
  }
  const ctx: any = {
    remote: {
      $mount: async (r: unknown) => { mounted.push(r); return async () => { disposed.push('remote') } },
    },
    inject: (deps: string[], cb: (c: unknown) => void) => {
      cb(c)
      return Object.assign(Promise.resolve(), { deps, dispose: async () => { disposed.push('inject') } })
    },
  }
  return ctx
}

describe('打包产物与入口格式', () => {
  it('三个产物都在，client.js 是 __ModuleLoader__.load({id, factory}) 的格式，id 是包名', async () => {
    const files = (await fs.readdir(outdir)).sort()
    expect(files).toEqual(['client.js', 'index.js', 'typert.host.js'])
    const code = await fs.readFile(path.join(outdir, 'client.js'), 'utf8')
    expect(code.startsWith('window.__ModuleLoader__.load({\n  id: "aha-tavern",\n  factory: (require) => {')).toBe(true)
    expect(code).toContain('return module.exports;')
    // 只依赖宿主页面提供的 react，没有别的运行时依赖被打进去或留着 require
    const requires = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
    expect(new Set(requires)).toEqual(new Set(['react']))
  })

  it('./typert 产物导出 TYPERT，方法与清单一致', async () => {
    const mod = await import(path.join(outdir, 'typert.host.js'))
    expect(mod.TYPERT.invocations.map((i: any) => i.method)).toEqual(SETTINGS_METHODS.map((m) => m.name))
  })

  it('插件本体对设置页服务的协议包只做动态导入', async () => {
    const code = await fs.readFile(path.join(outdir, 'index.js'), 'utf8')
    expect(code).not.toMatch(/^import[^\n]*dsh-typert-protocol/m)
    expect(code).toContain('import("@deepseek-ai/dsh-typert-protocol")')
  })
})

describe('浏览器端加载与页面', () => {
  it('apply：挂载远程描述，向 plugins.bundle.config 以包名注册页面；返回的清理函数按序撤销', async () => {
    await loadClient()
    expect(clientModule.inject).toEqual(['remote', 'slots', 'locale'])
    const dispose = await clientModule.apply(fakeClientCtx({}))
    expect(mounted).toHaveLength(1)
    expect(mounted[0].package).toBe('aha-tavern')
    expect(mounted[0].descriptors).toHaveLength(SETTINGS_METHODS.length)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.meta).toMatchObject({ name: 'plugins.bundle.config', key: 'aha-tavern' })
    await dispose()
    expect(disposed).toEqual(expect.arrayContaining(['inject', 'remote']))
  })

  it('页面：读取状态后渲染语音与生图两节；没有未保存修改时保存按钮不可用', async () => {
    const { mini } = await loadClient()
    const remote = { getState: vi.fn(async () => ok(stateOf())) }
    await clientModule.apply(fakeClientCtx(remote))
    const tree = await mini.render(mini.React.createElement(registered[0]!.component, { view: 'page' }))
    const text = textOf(tree)
    expect(text).toContain('语音')
    expect(text).toContain('生图')
    expect(text).toContain('语音服务：未启动。')
    expect(text).toContain('/home/x/services.yaml')
    expect(button(tree, '保存').props.disabled).toBe(true)
    const inputs = findAll(tree, (n) => n.type === 'input')
    expect(inputs.some((i: any) => i.props.value === 'http://127.0.0.1:18123')).toBe(true)
    expect(inputs.some((i: any) => i.props.placeholder === '/d/voice')).toBe(true)
  })

  it('summary 视图只给一句话；读取失败时给出重试', async () => {
    const { mini } = await loadClient()
    await clientModule.apply(fakeClientCtx({ getState: vi.fn(async () => ({ ok: false, error: 'x' })) }))
    expect(textOf(await mini.render(mini.React.createElement(registered[0]!.component, { view: 'summary' })))).toContain('语音')
    const tree = await mini.render(mini.React.createElement(registered[0]!.component, { view: 'page' }))
    expect(textOf(tree)).toContain('和插件通信失败')
    expect(button(tree, '重试')).toBeTruthy()
  })

  it('插件端出错返回固定值：getState 给重试，测试连接只在本区域显示错误，页面其余部分照常', async () => {
    const { mini } = await loadClient()
    const failed = ok({ ok: false, text: '操作出错，详情见日志。' })
    const remote = { getState: vi.fn(async () => failed) }
    await clientModule.apply(fakeClientCtx(remote))
    const root = mini.React.createElement(registered[0]!.component, { view: 'page' })
    let tree = await mini.render(root)
    expect(textOf(tree)).toContain('插件端返回的内容不对')
    expect(button(tree, '重试')).toBeTruthy()

    const remote2 = { getState: vi.fn(async () => ok(stateOf())), testVoice: vi.fn(async () => failed), voiceStatus: vi.fn(async () => failed) }
    const second = await loadClient()
    await clientModule.apply(fakeClientCtx(remote2))
    const root2 = second.mini.React.createElement(registered[0]!.component, { view: 'page' })
    const render2 = second.mini.render
    tree = await render2(root2)
    button(tree, '测试连接').props.onClick()
    tree = await render2(root2)
    expect(textOf(tree)).toContain('插件端返回的内容不对')
    expect(textOf(tree)).toContain('语音服务：未启动。')
    button(tree, '刷新状态').props.onClick()
    tree = await render2(root2)
    expect(textOf(tree)).toContain('语音服务：未启动。')
    expect(textOf(tree)).toContain('生图')
  })

  it('启动服务：先显示确认说明，点"开始"后才带上同一份说明再调一次', async () => {
    const { mini } = await loadClient()
    const detail = '- 运行环境（约 0.5GB）\n- 存放目录：/d/voice'
    const voiceStart = vi.fn()
      .mockResolvedValueOnce(ok({
        result: 'need-confirm', ok: true, text: 'q',
        confirm: { header: '语音服务', question: '启动语音服务前需要先准备下面这些，现在开始吗？', detail, goLabel: '开始', cancelLabel: '取消' },
      }))
      .mockResolvedValueOnce(ok({ result: 'starting', ok: true, text: '语音服务正在启动（安装运行环境），用 /aha 语音 状态 查看进度。' }))
    const remote = {
      getState: vi.fn(async () => ok(stateOf())), voiceStart,
      voiceStatus: vi.fn(async () => ok({ state: 'starting', text: '语音服务正在启动：安装运行环境，已用 1 秒。', stage: 'install', seconds: 1, canStart: false, canStop: true })),
    }
    await clientModule.apply(fakeClientCtx(remote))
    const root = mini.React.createElement(registered[0]!.component, { view: 'page' })
    let tree = await mini.render(root)
    button(tree, '启动服务').props.onClick()
    tree = await mini.render(root)
    expect(voiceStart).toHaveBeenCalledTimes(1)
    expect(voiceStart).toHaveBeenLastCalledWith({})
    expect(textOf(tree)).toContain(detail)
    button(tree, '开始').props.onClick()
    tree = await mini.render(root)
    expect(voiceStart).toHaveBeenLastCalledWith({ confirmed: true, detail })
    expect(textOf(tree)).toContain('正在启动')
    // 启动中每隔一会儿查一次进度；状态不再是启动中就停止轮询
    expect(timers.size).toBe(1)
    const before = remote.voiceStatus.mock.calls.length
    ;[...timers.values()][0]!()
    await mini.render(root)
    expect(remote.voiceStatus.mock.calls.length).toBeGreaterThan(before)
  })

  it('页面发起的启动完成后：轮询到终态就清掉"正在启动"提示并显示终态说明', async () => {
    const { mini } = await loadClient()
    const voiceStatus = vi.fn()
      .mockResolvedValueOnce(ok({ state: 'starting', text: '语音服务正在启动：安装运行环境，已用 1 秒。', stage: 'install', seconds: 1, canStart: false, canStop: true }))
      .mockResolvedValue(ok({ state: 'running', text: '语音服务：已在运行（由插件启动），模型 0.6b。', ours: true, canStart: false, canStop: true }))
    const remote = {
      getState: vi.fn(async () => ok(stateOf())),
      voiceStart: vi.fn(async () => ok({ result: 'starting', ok: true, text: 'NOTE-STARTING' })),
      voiceStatus,
    }
    await clientModule.apply(fakeClientCtx(remote))
    const root = mini.React.createElement(registered[0]!.component, { view: 'page' })
    let tree = await mini.render(root)
    button(tree, '启动服务').props.onClick()
    tree = await mini.render(root)
    expect(textOf(tree)).toContain('NOTE-STARTING')
    ;[...timers.values()][0]!()
    tree = await mini.render(root)
    expect(textOf(tree)).not.toContain('NOTE-STARTING')
    expect(textOf(tree)).toContain('语音服务：已在运行')
  })

  it('页面发起的启动失败后同样清掉提示，显示失败说明', async () => {
    const { mini } = await loadClient()
    const voiceStatus = vi.fn()
      .mockResolvedValueOnce(ok({ state: 'starting', text: '启动中…', stage: 'start', seconds: 1, canStart: false, canStop: true }))
      .mockResolvedValue(ok({ state: 'failed', text: '上次启动失败：端口被别的服务占用', canStart: true, canStop: false }))
    const remote = {
      getState: vi.fn(async () => ok(stateOf())),
      voiceStart: vi.fn(async () => ok({ result: 'starting', ok: true, text: 'NOTE-STARTING' })),
      voiceStatus,
    }
    await clientModule.apply(fakeClientCtx(remote))
    const root = mini.React.createElement(registered[0]!.component, { view: 'page' })
    let tree = await mini.render(root)
    button(tree, '启动服务').props.onClick()
    tree = await mini.render(root)
    ;[...timers.values()][0]!()
    tree = await mini.render(root)
    expect(textOf(tree)).not.toContain('NOTE-STARTING')
    expect(textOf(tree)).toContain('上次启动失败：端口被别的服务占用')
  })

  it('修改后保存：只把改动的字段交给插件端；校验错误显示在字段下', async () => {
    const { mini } = await loadClient()
    const saveVoice = vi.fn(async () => ok({ ok: false, text: '有填写不对的地方，请改正后再保存。', errors: { modelsDir: '应是绝对路径' } }))
    await clientModule.apply(fakeClientCtx({ getState: vi.fn(async () => ok(stateOf())), saveVoice }))
    const root = mini.React.createElement(registered[0]!.component, { view: 'page' })
    let tree = await mini.render(root)
    const dirInput = findAll(tree, (n) => n.type === 'input' && n.props.placeholder === '/d/voice')[0]
    dirInput.props.onChange({ target: { value: 'rel/path' } })
    tree = await mini.render(root)
    const save = button(tree, '保存')
    expect(save.props.disabled).toBe(false)
    save.props.onClick()
    tree = await mini.render(root)
    expect(saveVoice).toHaveBeenCalledWith({ modelsDir: 'rel/path' })
    expect(textOf(tree)).toContain('应是绝对路径')
  })
})
