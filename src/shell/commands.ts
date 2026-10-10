// 命令注册与分流：一条 `aha <子命令>` 加每个子命令一条 `aha-<英文名>`，共用一个入口。
import type { Context } from '@deepseek-ai/cordis'
import { dispatch, type CommandId } from '../core/dispatch'
import { buildRelayNotice, makeNotice, shouldRelay } from './steer'
import { buildContext, type CommandReply, type HostAgent, type HostServices } from './context'
import {
  dispatchReceipt, emptyReceipt, failureReceipt, notTavernModeReceipt, pendingReceipt, readonlyReceipt, unknownReceipt,
} from './receipts'
import { isReadonly } from './writable'
import type { Runtime } from './runtime'

export interface Subcommand {
  id: CommandId
  /** 中文主名：命令菜单、回执与文档里用它。 */
  zh: string
  /** 中文同义写法：解析时与主名等价，不出现在菜单里。 */
  aliases: readonly string[]
  /** 英文名即 id；同时是独立命令 `aha-<en>` 的后缀。 */
  en: CommandId
  /** 命令菜单里的说明：通用用词，不随主题变。 */
  description: string
  hint?: string
}

/** names 的第一个是中文主名，其余是同义写法。 */
const sub = (id: CommandId, names: readonly [string, ...string[]], description: string, hint?: string): Subcommand => ({
  id, zh: names[0], aliases: names.slice(1), en: id, description, ...(hint ? { hint } : {}),
})

export const SUBCOMMANDS: readonly Subcommand[] = [
  sub('init', ['启动', '开店', '开张'], '把当前工作区变成一间酒馆'),
  sub('card', ['角色', '角色卡', '建卡'], '新建或修改角色卡', '[角色名]'),
  sub('me', ['我'], '写或改主角档案'),
  sub('world', ['世界观'], '写或改世界观'),
  sub('import', ['导入'], '从另一间酒馆复制角色卡或主角档案'),
  sub('start', ['开场'], '选定角色，开始聊天', '[角色名]'),
  sub('remember', ['记忆', '记住'], '记一句话，或让角色回顾并整理记忆', '[内容]'),
  sub('reroll', ['重新生图', '重掷'], '上一张图重新生成', '[修改词]'),
  sub('speak', ['说话', '朗读'], '念出来，或开关自动朗读', '[文本|开|关|停]'),
  sub('doctor', ['自检'], '检查当前状态与外部服务'),
  sub('voice', ['语音'], '启动、停止或查看语音服务', '[启动|停止|状态]'),
]

export type ParsedSubcommand =
  | { kind: 'command'; id: CommandId; args: string }
  | { kind: 'unknown'; word: string }
  | { kind: 'empty' }

/** 解析 `/aha` 后面的文字：第一个词是子命令（中文主名或同义写法须精确，英文不分大小写），其余是参数。 */
export function parseSubcommand(input: string): ParsedSubcommand {
  const text = input.trim()
  if (text === '') return { kind: 'empty' }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text)!
  const word = m[1]!
  const lower = word.toLowerCase()
  const hit = SUBCOMMANDS.find((s) => s.zh === word || s.aliases.includes(word) || s.en === lower)
  return hit ? { kind: 'command', id: hit.id, args: m[2]!.trim() } : { kind: 'unknown', word }
}

/** 会话是否全新；取不到或抛错按"已落地"处理。 */
export function isFreshSession(agent: HostAgent): boolean {
  try {
    const msgs = agent.session?.deriveMessages?.()
    return Array.isArray(msgs) && msgs.length === 0
  } catch {
    return false
  }
}

/** 统一入口：`parsed` 为已解析的子命令，`label` 为用户敲的写法。 */
export async function handleCommand(
  rt: Runtime,
  services: HostServices,
  agent: HostAgent,
  parsed: ParsedSubcommand,
  label: string,
  signal?: AbortSignal,
): Promise<CommandReply> {
  const fresh = isFreshSession(agent)
  let steered = false
  const steer = (text: string, summary: string): void => {
    if (typeof agent.steer !== 'function') throw new Error('宿主 agent 没有 steer')
    agent.steer(makeNotice(text, summary))
    steered = true
  }
  const reply = await processCommand(rt, services, agent, parsed, label, steer, signal)
  // 全新会话里回执不显示：没有别的 steer 时，另请掌柜转告一遍（07 F18）
  if (shouldRelay({ fresh, steered, replyText: reply.text })) {
    try {
      const theme = await rt.theme().catch(() => undefined)
      steer(buildRelayNotice(label, reply.text!, theme), `回执：${label}`)
      rt.log.debug(`命令 ${label}：全新会话，已请掌柜转告回执`)
    } catch (e) {
      rt.log.warn(`转告回执失败：${(e as Error).message}`)
    }
  }
  return reply
}

async function processCommand(
  rt: Runtime,
  services: HostServices,
  agent: HostAgent,
  parsed: ParsedSubcommand,
  label: string,
  steer: (text: string, summary: string) => void,
  signal?: AbortSignal,
): Promise<CommandReply> {
  let theme
  try {
    theme = await rt.theme()
  } catch (e) {
    return failureReceipt(`主题加载失败（${(e as Error).message}）`)
  }
  if (parsed.kind === 'empty') return emptyReceipt(SUBCOMMANDS)
  if (parsed.kind === 'unknown') return unknownReceipt(parsed.word, SUBCOMMANDS)

  try {
    const context = await buildContext(agent, services, rt.log)
    rt.log.debug(`命令 ${label}：实例 ${rt.config.mode}，会话模式 ${context.mode}，状态 ${context.state}，工作区 ${context.cwd ?? '（无）'}`)
    if (context.mode === null || context.state === null) return notTavernModeReceipt()
    // 命令按作用域登记，会话只会看到自己所在模式那份实例的命令，这里理论上不会发生；
    // 万一发生，静默不处理（另一份实例会处理），只留一行调试日志
    if (context.mode !== rt.config.mode) {
      rt.log.debug(`命令 ${label} 到达了不匹配的实例：实例模式 ${rt.config.mode}，会话模式 ${context.mode}`)
      return { kind: 'success' }
    }
    const d = dispatch(context.mode, context.state, parsed.id)
    if (!d.run) return dispatchReceipt(theme, d.reason, { label, outsideReason: context.outsideReason })
    if (isReadonly(context.tavern) && parsed.id !== 'doctor' && parsed.id !== 'voice' && parsed.id !== 'speak') return readonlyReceipt(theme)
    const handler = rt.handlers[parsed.id]
    if (!handler) return pendingReceipt(label)
    return await handler({ agent, services, rt, theme, context, args: parsed.args, label, steer, ...(signal ? { signal } : {}) })
  } catch (e) {
    rt.log.error(`命令 ${label} 失败：${(e as Error).stack ?? e}`)
    return failureReceipt((e as Error).message)
  }
}

/** 注册时 inject 的宿主服务。要用别的服务，在这里加一项。 */
export const HOST_SERVICES = ['commands', 'agentPresets'] as const

interface CommandInvocation {
  agent: HostAgent
  rawInput?: string
  signal?: AbortSignal
}
interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string }
  handler(inv: CommandInvocation): CommandReply | Promise<CommandReply>
}
interface InjectedContext extends HostServices {
  commands: { register(def: CommandDefinition): () => void }
}

/** 向当前模式的清单注册全部命令名。同名重复注册只记警告，不抛出。 */
export function registerCommands(ctx: Context, rt: Runtime): void {
  const inject = (ctx as unknown as { inject(keys: readonly string[], cb: (c: InjectedContext) => void): void }).inject
  rt.log.info(`等待宿主服务：${HOST_SERVICES.join('、')}`)
  inject.call(ctx, HOST_SERVICES, (c) => {
    let count = 0
    const reg = (def: CommandDefinition): void => {
      try {
        c.commands.register(def)
        count++
      } catch (e) {
        rt.log.warn(`注册命令 ${def.name} 失败：${(e as Error).message}`)
      }
    }
    const usage = SUBCOMMANDS.map((s) => `${s.zh}/${s.en}`).join('、')
    reg({
      name: 'aha',
      description: `阿哈酒馆：${usage}`,
      input: { hint: '<子命令> [参数]' },
      handler: ({ agent, rawInput, signal }) => {
        const input = rawInput ?? ''
        const parsed = parseSubcommand(input)
        const word = input.trim().split(/\s+/)[0] ?? ''
        return handleCommand(rt, c, agent, parsed, word ? `/aha ${word}` : '/aha', signal)
      },
    })
    for (const s of SUBCOMMANDS) {
      reg({
        name: `aha-${s.en}`,
        description: `阿哈酒馆 · ${s.zh}：${s.description}`,
        ...(s.hint ? { input: { hint: s.hint } } : {}),
        handler: ({ agent, rawInput, signal }) =>
          handleCommand(rt, c, agent, { kind: 'command', id: s.id, args: (rawInput ?? '').trim() }, `/aha-${s.en}`, signal),
      })
    }
    rt.log.info(`命令已注册（模式 ${rt.config.mode}，${count} 条）`)
  })
}
