// 浏览器端入口：在"插件"页的阿哈酒馆包页面里注册设置页。构建脚本把它包成 window.__ModuleLoader__.load 的格式。
// 与插件端经 typert 远程调用通信（ctx.remote.ahaSettings.*）。
import { PACKAGE_NAME, SERVICE_KEY, clientRemote } from '../shared/settings-rpc'
import { createPage } from './page'

// 宿主的客户端 Cordis 上下文没有现成类型，这里按用到的几处写最小接口
interface ClientCtx {
  remote: { $mount(remote: unknown): Promise<() => Promise<void> | void> } & Record<string, any>
  inject(deps: string[], cb: (c: any) => void): Promise<{ dispose(): Promise<void> | void }> & { dispose(): Promise<void> | void }
}

export const inject = ['remote', 'slots', 'locale']

const LOCALE = 'ahaSettings'
const TEXT = { title: '阿哈酒馆设置', summary: '语音与生图服务的地址、模型和启停' }

export async function apply(ctx: ClientCtx): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(clientRemote())
  const ui = ctx.inject([`remote.${SERVICE_KEY}`, 'slots', 'locale'], (c) => {
    c.effect(() => c.locale.register(LOCALE, { zh: TEXT, en: TEXT }))
    c.slots.inject('plugins.bundle.config', () =>
      c.slots.register(
        { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: LOCALE },
        createPage(() => c.remote[SERVICE_KEY]),
      ))
  })
  await ui
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
