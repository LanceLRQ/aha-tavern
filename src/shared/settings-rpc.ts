// 设置页的远程调用清单：插件端（typert 服务）、插件端的 ./typert 描述与浏览器端的描述都从这里生成，
// 不各写一份。入参一律是 JSON；方法名与参数名写进了页面与插件之间的约定，只增不改。

export const PACKAGE_NAME = 'aha-tavern'
/** 插件端服务的键，同时是浏览器端 ctx.remote 下的命名空间。 */
export const SERVICE_KEY = 'ahaSettings'

export const SETTINGS_METHODS = [
  { name: 'getState', params: [] },
  { name: 'saveVoice', params: ['form'] },
  { name: 'saveImage', params: ['form'] },
  { name: 'voiceStatus', params: [] },
  { name: 'voiceStart', params: ['options'] },
  { name: 'voiceStop', params: [] },
  { name: 'testVoice', params: [] },
  { name: 'testImage', params: [] },
] as const satisfies readonly { name: string; params: readonly string[] }[]

export type SettingsMethodName = (typeof SETTINGS_METHODS)[number]['name']

/** 入参不做结构校验（校验在插件端的 API 里，把入参当不可信输入处理）。 */
const anySchema = () => ({ parse: (v: unknown) => v })
const strictCodec = (typeSymbol: string) => ({ mode: 'strict', typeSymbol, create: anySchema })

function invocation(m: (typeof SETTINGS_METHODS)[number], file: string) {
  const id = `${PACKAGE_NAME}#${SERVICE_KEY}/${m.name}`
  return {
    id, service: SERVICE_KEY, namespace: SERVICE_KEY, method: m.name, invocation: { kind: 'direct' },
    parameters: m.params.map((p) => ({ name: p, wire: p, source: 'json', codec: strictCodec(`${id}:${p}`) })),
    result: strictCodec(`${id}:result`),
    sourceLocation: { file, line: 1, column: 1 },
  }
}

/** 插件端 `./typert` 导出的描述。 */
export function hostTypert() {
  return {
    package: PACKAGE_NAME, face: 'host', schemas: [],
    invocations: SETTINGS_METHODS.map((m) => invocation(m, 'dist/index.js')),
    model: {
      services: [{
        key: SERVICE_KEY, exportName: 'default', description: '', summary: '', tags: [], jsDoc: '',
        members: SETTINGS_METHODS.map((m) => ({
          kind: 'method', name: m.name, signature: `@Remote ${m.name}(${m.params.map((p) => `${p}?: unknown`).join(', ')}): object`, summary: '', jsDoc: '',
        })),
        types: [],
      }],
      events: [], objects: [],
    },
  }
}

/** 浏览器端 `ctx.remote.$mount` 用的描述。 */
export function clientRemote() {
  return { package: PACKAGE_NAME, descriptors: SETTINGS_METHODS.map((m) => invocation(m, 'dist/client.js')) }
}
