// 测试用的假 Runtime：带齐全部必填成员，可传覆盖项。
import { vi } from 'vitest'
import { DEFAULTS } from '../../../../src/config'
import type { Runtime } from '../../../../src/shell/runtime'

/** 语音相关的三个必填成员（测试里不会真的用到，用到的测试自行覆盖）。 */
export const voiceRuntimeStubs = {
  builtinAssetsDir: '',
  voiceSettings: async () => ({ configured: false as const, problems: [] }),
  voiceServerDeps: () => {
    throw new Error('测试里没有提供 voiceServerDeps')
  },
}

export function fakeRuntime(over: Partial<Runtime> = {}): Runtime {
  return {
    config: { ...DEFAULTS },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    builtinThemeDir: '', builtinWorkflowDir: '', servicesPath: () => '', tools: () => undefined,
    theme: async () => { throw new Error('测试里没有提供 theme') },
    handlers: {},
    ...voiceRuntimeStubs,
    ...over,
  }
}
