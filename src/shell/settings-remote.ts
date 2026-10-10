// 设置页在插件端的出口：把 SettingsApi 挂成 typert 远程服务，浏览器端经 ctx.remote.ahaSettings.* 调用。
// 只有 mode 为 settings 的实例（根层的一行）会走到这里，两个酒馆模式里的实例不涉及。
// @deepseek-ai/dsh-typert-protocol 由宿主提供，这里动态导入：它不存在（比如 --patch 调试）时只是设置页装不上，
// 不影响插件其余部分。
import type { Context } from '@deepseek-ai/cordis'
import { SERVICE_KEY, SETTINGS_METHODS } from '../shared/settings-rpc'
import { createSettingsApi, type SettingsApi } from './settings'
import type { Runtime } from './runtime'

type ProtocolModule = typeof import('@deepseek-ai/dsh-typert-protocol')

export interface InstallSettingsOptions {
  api?: SettingsApi
  loadProtocol?: () => Promise<ProtocolModule>
}

/** 调用出错时返回给页面的固定内容；页面对每个结果都按"可能没有预期字段"处理。 */
const CALL_FAILED = { ok: false, text: '操作出错，详情见日志。' }

export function installSettings(rt: Runtime, ctx: Context, opts: InstallSettingsOptions = {}): void {
  const api = opts.api ?? createSettingsApi(rt)
  const loadProtocol = opts.loadProtocol ?? (() => import('@deepseek-ai/dsh-typert-protocol'))
  const inject = (ctx as unknown as { inject(deps: string[], cb: (c: Context) => unknown): unknown }).inject
  // 宿主没有 typert（不是 web 载体）时回调不会执行，设置页自然不存在
  inject.call(ctx, ['typert'], async (c: Context) => {
    let protocol: ProtocolModule
    try {
      protocol = await loadProtocol()
    } catch (e) {
      rt.log.warn(`设置页服务未能装载（宿主缺少 typert 协议包）：${(e as Error).message}`)
      return
    }
    const { Remote, TypertRemoteService } = protocol

    class AhaSettingsRemote extends TypertRemoteService {
      constructor(owner: Context) {
        super(owner, SERVICE_KEY, { namespace: SERVICE_KEY })
        // 等价于给每个方法写 @Remote 装饰器（Node 里不能直接用装饰器语法）
        for (const m of SETTINGS_METHODS) {
          Remote(undefined, { kind: 'method', name: m.name, private: false, static: false, addInitializer: (fn: () => void) => fn.call(this) })
        }
      }
    }
    for (const m of SETTINGS_METHODS) {
      Object.defineProperty(AhaSettingsRemote.prototype, m.name, {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]): Promise<unknown> => {
          try {
            return await (api[m.name] as (...a: unknown[]) => Promise<unknown>)(...args)
          } catch (e) {
            rt.log.error(`设置页调用 ${m.name} 出错：${(e as Error).stack ?? String(e)}`)
            return CALL_FAILED
          }
        },
      })
    }
    new AhaSettingsRemote(c)
    rt.log.info('设置页服务已就绪')
  })
}
