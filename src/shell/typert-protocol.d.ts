// 宿主包 @deepseek-ai/dsh-typert-protocol 的最小类型声明：只声明设置页用到的部分。
// 该包由宿主提供（peerDependency），本仓库不安装它；只在设置页实例里动态导入。
declare module '@deepseek-ai/dsh-typert-protocol' {
  export abstract class TypertRemoteService {
    protected constructor(ctx: unknown, serviceKey: string, options?: { namespace?: string })
  }
  export function Remote(option: unknown, context: unknown): void
}
