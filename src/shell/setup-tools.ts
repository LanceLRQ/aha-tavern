// 筹备模式的工具：保存主角档案、保存世界观。
// 返回值是给模型看的文字，只用固定标识说事实，不带主题称呼；写盘失败时返回说明而不抛异常。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countChars, writeMe, writeWorld } from '../core/docs'
import { isTavern } from '../core/tavern'
import type { HostAgent } from './context'
import type { Runtime } from './runtime'

export interface SaveResult {
  ok: boolean
  /** 给模型看的文字 */
  message: string
}

/** 写入字数上限：世界观预算的 3 倍；主角档案与之共用。 */
export const maxCharsOf = (worldBudget: number): number => worldBudget * 3

const fail = (message: string): SaveResult => ({ ok: false, message: `error: ${message}` })

/** 校验正文：必须是非空字符串且不超上限；通过返回 null。 */
function checkText(what: string, text: unknown, limit: number): SaveResult | null {
  if (typeof text !== 'string') return fail(`text must be a string, ${what} not saved`)
  if (text.trim() === '') return fail(`empty text, ${what} not saved`)
  const n = countChars(text)
  if (n > limit) return fail(`${what} not saved, text is ${n} chars, limit ${limit}`)
  return null
}

export async function saveProfileText(tavernDir: string, text: unknown, limit: number): Promise<SaveResult> {
  const bad = checkText('profile', text, limit)
  if (bad) return bad
  try {
    return { ok: true, message: `profile saved (${await writeMe(tavernDir, text as string)} chars)` }
  } catch (e) {
    return fail(`profile not saved (${(e as Error).message})`)
  }
}

export async function saveWorldText(tavernDir: string, text: unknown, budget: number): Promise<SaveResult> {
  const bad = checkText('world', text, maxCharsOf(budget))
  if (bad) return bad
  try {
    const n = await writeWorld(tavernDir, text as string)
    return {
      ok: true,
      message: n > budget
        ? `world saved (${n} chars), over budget ${budget} — suggest trimming`
        : `world saved (${n} chars), budget ${budget}`,
    }
  } catch (e) {
    return fail(`world not saved (${(e as Error).message})`)
  }
}

/** 工具执行时的会话工作区：必须已是酒馆。 */
async function tavernDirOf(agent: HostAgent | undefined): Promise<string | undefined> {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' && (await isTavern(cwd)) ? cwd : undefined
}

export const NOT_TAVERN = 'error: this workspace is not a tavern yet, nothing saved'

interface ToolHost {
  tools: { register(def: ReturnType<typeof defineTool>): unknown }
}

/** onSaved：保存成功后调用（用来刷新该会话的提示词段）；它的失败不影响工具返回。 */
export function registerSetupTools(ctx: Context, rt: Runtime, onSaved: (agent: HostAgent) => Promise<void>): void {
  const host = ctx as unknown as ToolHost
  const text = (_a: unknown, v: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: String(v) }]

  const run = async (
    name: string,
    agent: HostAgent | undefined,
    save: (dir: string) => Promise<SaveResult>,
  ): Promise<string> => {
    const dir = await tavernDirOf(agent)
    if (!dir) {
      rt.log.debug(`工具 ${name}：工作区不是酒馆`)
      return NOT_TAVERN
    }
    const r = await save(dir)
    rt.log.debug(`工具 ${name}：${r.message}`)
    if (r.ok && agent) {
      try {
        await onSaved(agent)
      } catch (e) {
        rt.log.warn(`工具 ${name}：刷新提示词段失败：${(e as Error).message}`)
      }
    }
    return r.message
  }

  host.tools.register(defineTool({
    name: 'aha_save_profile',
    description: '保存 profile 全文，整体覆盖原有内容。只在用户确认过全文之后调用。',
    parameters: { text: { type: 'string', required: true, description: 'profile 的完整正文' } },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) =>
      run('aha_save_profile', exec.agent as unknown as HostAgent | undefined, (dir) =>
        saveProfileText(dir, (args as { text?: unknown }).text, maxCharsOf(rt.config.worldBudget))),
  }))

  host.tools.register(defineTool({
    name: 'aha_save_world',
    description: '保存 world 全文，整体覆盖原有内容。只在用户确认过全文之后调用。返回值会说明是否超出字数预算。',
    parameters: { text: { type: 'string', required: true, description: 'world 的完整正文' } },
    output: { schema: { type: 'string' }, render: text },
    execute: (args, exec) =>
      run('aha_save_world', exec.agent as unknown as HostAgent | undefined, (dir) =>
        saveWorldText(dir, (args as { text?: unknown }).text, rt.config.worldBudget)),
  }))
}
