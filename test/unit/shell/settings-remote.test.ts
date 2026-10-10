import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../../../src/config'
import { SETTINGS_METHODS, SERVICE_KEY, clientRemote, hostTypert } from '../../../src/shared/settings-rpc'
import { installHandlers } from '../../../src/shell/handlers'
import { installSettings } from '../../../src/shell/settings-remote'
import type { SettingsApi } from '../../../src/shell/settings'
import { TYPERT } from '../../../src/typert-host'
import { fakeRuntime } from './helpers/runtime'

function fakeProtocol() {
  const registered: string[] = []
  const created: { key: string; options: unknown; self: object }[] = []
  class TypertRemoteService {
    constructor(_ctx: unknown, key: string, options?: unknown) {
      created.push({ key, options, self: this })
    }
  }
  const Remote = vi.fn((_o: unknown, context: any) => {
    registered.push(context.name)
    context.addInitializer(function (this: unknown) { /* 宿主在这里登记方法 */ })
  })
  return { protocol: { TypertRemoteService, Remote } as any, registered, created }
}

function fakeApi(): SettingsApi {
  const mk = () => vi.fn().mockResolvedValue({ ok: true })
  return {
    getState: mk(), saveVoice: mk(), saveImage: mk(), voiceStatus: mk(), voiceStart: mk(), voiceStop: mk(), testVoice: mk(), testImage: mk(),
  } as unknown as SettingsApi
}

const fakeCtx = () => {
  const ctx: any = { inject: vi.fn((_deps: string[], cb: (c: unknown) => unknown) => cb(ctx)) }
  return ctx
}

describe('设置页的远程调用清单', () => {
  it('插件端 ./typert 描述、浏览器端描述和方法表三处一致', () => {
    const names = SETTINGS_METHODS.map((m) => m.name)
    expect(TYPERT.invocations.map((i) => i.method)).toEqual(names)
    expect(clientRemote().descriptors.map((d) => d.method)).toEqual(names)
    expect(hostTypert().model.services[0]!.members.map((m) => m.name)).toEqual(names)
    for (const d of clientRemote().descriptors) {
      expect(d.id).toBe(`aha-tavern#${SERVICE_KEY}/${d.method}`)
      expect(d.namespace).toBe(SERVICE_KEY)
    }
  })

  it('描述里的入参校验是直通的（校验在 API 里），字段齐全', () => {
    const inv = TYPERT.invocations.find((i) => i.method === 'saveVoice')!
    expect(inv.parameters[0]!.codec.create().parse({ a: 1 })).toEqual({ a: 1 })
    expect(inv.invocation).toEqual({ kind: 'direct' })
  })
})

describe('installSettings', () => {
  it('在 typert 就绪后建服务，键与命名空间正确，每个方法都登记了', async () => {
    const f = fakeProtocol()
    const api = fakeApi()
    const ctx = fakeCtx()
    installSettings(fakeRuntime(), ctx, { api, loadProtocol: async () => f.protocol })
    expect(ctx.inject).toHaveBeenCalledWith(['typert'], expect.any(Function))
    await vi.waitFor(() => expect(f.created).toHaveLength(1))
    expect(f.created[0]).toMatchObject({ key: SERVICE_KEY, options: { namespace: SERVICE_KEY } })
    expect(f.registered).toEqual(SETTINGS_METHODS.map((m) => m.name))
  })

  it('远程方法转给 API，入参原样传递', async () => {
    const f = fakeProtocol()
    const api = fakeApi()
    installSettings(fakeRuntime(), fakeCtx(), { api, loadProtocol: async () => f.protocol })
    await vi.waitFor(() => expect(f.created).toHaveLength(1))
    const svc = f.created[0]!.self as any
    await svc.saveVoice({ endpoint: 'x' })
    expect(api.saveVoice).toHaveBeenCalledWith({ endpoint: 'x' })
    await svc.voiceStart({ confirmed: true })
    expect(api.voiceStart).toHaveBeenCalledWith({ confirmed: true })
  })

  it('API 抛错：记日志，页面只拿到固定说明', async () => {
    const f = fakeProtocol()
    const api = fakeApi()
    ;(api.voiceStop as any).mockRejectedValue(new Error('secret http://u:p@h'))
    const rt = fakeRuntime()
    installSettings(rt, fakeCtx(), { api, loadProtocol: async () => f.protocol })
    await vi.waitFor(() => expect(f.created).toHaveLength(1))
    const r = await (f.created[0]!.self as any).voiceStop()
    expect(r).toEqual({ ok: false, text: '操作出错，详情见日志。' })
    expect(rt.log.error).toHaveBeenCalled()
  })

  it('协议包加载不上：只记警告，不抛出', async () => {
    const rt = fakeRuntime()
    installSettings(rt, fakeCtx(), { api: fakeApi(), loadProtocol: async () => { throw new Error('Cannot find package') } })
    await vi.waitFor(() => expect(rt.log.warn).toHaveBeenCalled())
  })
})

describe('settings 模式的实例', () => {
  it('配置里认 settings', () => {
    expect(resolveConfig({ mode: 'settings' }).mode).toBe('settings')
    expect(resolveConfig({ mode: 'other' }).mode).toBe('chat')
  })

  it('只装语音操作与设置页服务，不登记聊天或筹备的处理', () => {
    const rt = fakeRuntime({ config: { ...resolveConfig({ mode: 'settings' }) } })
    const ctx: any = { inject: vi.fn(), effect: vi.fn(), registerTool: vi.fn(), command: vi.fn() }
    installHandlers(rt, ctx)
    expect(rt.handlers.voice).toBeTypeOf('function')
    expect(rt.voice).toBeDefined()
    expect(rt.handlers.doctor).toBeUndefined()
    expect(ctx.inject).toHaveBeenCalledWith(['typert'], expect.any(Function))
    expect(ctx.command).not.toHaveBeenCalled()
  })
})
