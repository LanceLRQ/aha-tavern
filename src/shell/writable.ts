// 数据版本检查：命令入口与写盘工具共用。
// 数据版本过新的酒馆拒绝写入（只读）；过旧的就地迁移并先备份，迁移失败也按只读处理。
import { migrateTavern, openTavern, type TavernInfo } from '../core/tavern'
import type { Log } from './runtime'

/** 写盘工具在只读酒馆里的返回。 */
export const READONLY_TOOL_MESSAGE = 'not saved: tavern data is newer than this plugin (read-only)'

export const isReadonly = (info: Pick<TavernInfo, 'access'> | null | undefined): boolean => info?.access === 'readonly'

/** 打开酒馆并得到最终的读写状态：migrate 时尝试迁移，失败按只读处理并记日志。 */
export async function openResolved(dir: string, log?: Pick<Log, 'warn'>): Promise<TavernInfo> {
  const info = await openTavern(dir)
  if (info.access !== 'migrate') return info
  try {
    return await migrateTavern(dir)
  } catch (e) {
    log?.warn(`酒馆 ${dir} 需要迁移但失败，按只读处理：${(e as Error).message}`)
    return { ...info, access: 'readonly' }
  }
}

/** 写盘工具动手前的检查：只读返回应交给模型的说明，可写返回 null。 */
export async function readonlyToolMessage(dir: string, log?: Pick<Log, 'warn'>): Promise<string | null> {
  try {
    return isReadonly(await openResolved(dir, log)) ? READONLY_TOOL_MESSAGE : null
  } catch {
    return null
  }
}
