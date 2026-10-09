// 导入命令：全程不经模型，用选择卡片依次问来源、内容与冲突。
// 问题的构造、回答到决定的映射、汇总文字都是纯函数；处理函数只负责按顺序调用。
import path from 'node:path'
import type {
  CharacterDecision, ImportConflict, ProfileDecision, SkippedFile, SourceListing,
} from '../core/importer'
import { importCharacter, importProfile, listImportable } from '../core/importer'
import { readRegistry } from '../core/registry'
import { isAhaError } from '../core/errors'
import type { Theme } from '../core/theme'
import { answerItem, isAbort, shownName, SessionGate, type AskFn, type AskItem } from './confirm'
import type { CommandHandler } from './context'
import {
  failureReceipt, importCancelledReceipt, importNoSourceReceipt, importNothingReceipt, readonlyReceipt, type Reply,
} from './receipts'
import { isReadonly } from './writable'
import type { SetupSections } from './setup'

/** 一张卡片最多放多少个选项。宿主类型定义与校验没有给出上限，取一个保守值，超出时分批。 */
export const MAX_OPTIONS = 12
const TAGLINE_MAX = 60
const PATH_MAX = 80

/** 折叠空白并按字符数截断；放进卡片的用户文字都过它。 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

/** 一张卡片和它的"选项文字 -> 取值"对照。选项文字必须唯一，重名的加序号。 */
export interface Labeled<T> {
  item: AskItem
  byLabel: Map<string, T>
}

export function uniqueLabel(base: string, used: Set<string>): string {
  let label = base || '(未命名)'
  for (let n = 2; used.has(label); n++) label = `${base || '(未命名)'} (${n})`
  used.add(label)
  return label
}

export interface SourceTavern {
  name: string
  path: string
}

export function buildSourceQuestion(theme: Theme, sources: readonly SourceTavern[]): Labeled<SourceTavern> {
  const used = new Set<string>()
  const byLabel = new Map<string, SourceTavern>()
  const options = sources.map((s) => {
    const label = uniqueLabel(shownName(s.name) || theme.concept('tavern'), used)
    byLabel.set(label, s)
    return { label, description: clip(s.path, PATH_MAX) }
  })
  const only = sources.length === 1 ? sources[0]! : null
  return {
    item: {
      id: 'source',
      header: theme.action('import'),
      question: only
        ? `从「${shownName(only.name)}」${theme.action('import')}？（${clip(only.path, PATH_MAX)}）`
        : `从哪间${theme.concept('tavern')}${theme.action('import')}？`,
      options,
    },
    byLabel,
  }
}

export type ImportPick = { kind: 'character'; id: string; name: string } | { kind: 'profile' }

/** 要导入哪些：各角色一项，来源有主角档案再加一项；超过上限分批。 */
export function buildPickBatches(theme: Theme, listing: SourceListing, size = MAX_OPTIONS): Array<Labeled<ImportPick>> {
  const used = new Set<string>()
  const entries: Array<{ label: string; description: string; pick: ImportPick }> = []
  for (const c of listing.characters) {
    entries.push({
      label: uniqueLabel(shownName(c.name), used),
      description: c.tagline ? clip(c.tagline, TAGLINE_MAX) : '',
      pick: { kind: 'character', id: c.id, name: c.name },
    })
  }
  if (listing.hasProfile) {
    entries.push({
      label: uniqueLabel(theme.concept('profile'), used),
      description: `把来源的${theme.concept('profile')}复制过来`,
      pick: { kind: 'profile' },
    })
  }
  const total = Math.max(1, Math.ceil(entries.length / size))
  const batches: Array<Labeled<ImportPick>> = []
  for (let i = 0; i < total; i++) {
    const part = entries.slice(i * size, (i + 1) * size)
    const byLabel = new Map<string, ImportPick>()
    for (const e of part) byLabel.set(e.label, e.pick)
    const progress = total > 1 ? `（第 ${i + 1}/${total} 批）` : ''
    batches.push({
      item: {
        id: `pick-${i + 1}`,
        header: theme.action('import'),
        question: `从「${shownName(listing.tavernName)}」${theme.action('import')}哪些？可多选${progress}`,
        ...(listing.broken.length > 0
          ? { detail: `另有 ${listing.broken.length} 张${theme.concept('card')}读不出来，没有列在这里。` }
          : {}),
        multiSelect: true,
        options: part.map((e) => ({ label: e.label, description: e.description })),
      },
      byLabel,
    })
  }
  return batches
}

export const OPT_OVERWRITE = '覆盖'
export const OPT_SKIP = '跳过'
/** 另存的选项文字带"角色"的称呼，随主题变。 */
export const optCopy = (theme: Theme): string => `另存为新${theme.concept('character')}`

const optionOf = (label: string, description: string) => ({ label, description })

export function buildConflictQuestion(
  theme: Theme, conflict: ImportConflict, incomingName: string,
): Labeled<CharacterDecision> {
  const byLabel = new Map<string, CharacterDecision>()
  const options: AskItem['options'] = []
  const add = (label: string, decision: CharacterDecision, description: string): void => {
    byLabel.set(label, decision)
    options!.push(optionOf(label, description))
  }
  let question: string
  if (conflict.kind === 'id') {
    question = `这间${theme.concept('tavern')}里已有同一个${theme.concept('character')}「${shownName(conflict.existing.name)}」`
      + `（要${theme.action('import')}的是「${shownName(incomingName)}」）。怎么办？`
    if (conflict.overwriteBlocked) {
      question += `（${theme.concept('card')}改名后的名字已被另一个${theme.concept('character')}占用，不能覆盖。）`
    } else {
      add(OPT_OVERWRITE, 'overwrite', `只换${theme.concept('card')}与参考图、音色，已有的${theme.concept('core_memory')}保留`)
    }
    add(optCopy(theme), 'copy', `作为一个新${theme.concept('character')}加进来，名字后加序号`)
    add(OPT_SKIP, 'skip', `不${theme.action('import')}这一个`)
  } else {
    question = `这间${theme.concept('tavern')}里已有叫「${shownName(conflict.dirName)}」的${theme.concept('character')}，`
      + `和要${theme.action('import')}的「${shownName(incomingName)}」重名。怎么办？`
    add(optCopy(theme), 'copy', `作为一个新${theme.concept('character')}加进来，名字后加序号`)
    add(OPT_SKIP, 'skip', `不${theme.action('import')}这一个`)
  }
  return { item: { id: 'conflict', header: theme.action('import'), question, options }, byLabel }
}

export function buildProfileConflictQuestion(theme: Theme): Labeled<ProfileDecision> {
  const byLabel = new Map<string, ProfileDecision>([[OPT_OVERWRITE, 'overwrite'], [OPT_SKIP, 'skip']])
  return {
    item: {
      id: 'profile-conflict',
      header: theme.action('import'),
      question: `这间${theme.concept('tavern')}已有${theme.concept('profile')}。用来源的覆盖它吗？`,
      options: [
        optionOf(OPT_OVERWRITE, `用来源的${theme.concept('profile')}替换现有的`),
        optionOf(OPT_SKIP, '保留现有的'),
      ],
    },
    byLabel,
  }
}

/** 单选回答 -> 取值；跳过、自由输入、没选、选了不认识的，一律是 null（取消当前这一步）。 */
export function interpretSingle<T>(answer: unknown, q: Labeled<T>): T | null {
  const item = answerItem(answer, q.item.id)
  if (!item) return null
  if (typeof item.custom === 'string' && item.custom.trim() !== '') return null
  const selected = Array.isArray(item.selected) ? item.selected : []
  if (selected.length !== 1) return null
  return q.byLabel.get(selected[0]!) ?? null
}

/** 多选回答 -> 取值列表；规则同上，没选出任何认识的项也是 null。 */
export function interpretMulti<T>(answer: unknown, q: Labeled<T>): T[] | null {
  const item = answerItem(answer, q.item.id)
  if (!item) return null
  if (typeof item.custom === 'string' && item.custom.trim() !== '') return null
  const selected = Array.isArray(item.selected) ? item.selected : []
  const out: T[] = []
  for (const label of new Set(selected)) {
    const v = q.byLabel.get(label)
    if (v !== undefined) out.push(v)
  }
  return out.length > 0 ? out : null
}

export type OutcomeResult = 'imported' | 'overwritten' | 'copied' | 'skipped' | 'failed'

export interface Outcome {
  kind: 'character' | 'profile'
  /** 角色名；主角档案为空串。 */
  name: string
  result: OutcomeResult
  /** 提问被中断（用户中止）而取消。 */
  cancelled?: boolean
  /** 另存后的新名字。 */
  savedAs?: string
  /** 失败原因。 */
  error?: string
  skippedFiles?: SkippedFile[]
}

export interface SummaryInfo {
  sourceName: string
  /** 来源里读不出来的卡的数量。 */
  brokenCount: number
  /** 其中因符号链接而不读取的数量。 */
  brokenSymlinks?: number
  /** 来源的主角档案是符号链接，没有读取。 */
  profileUnsafe?: boolean
  /** 中途出错停下时的原因。 */
  aborted?: string
}

const SYSTEM_CODES: Record<string, string> = {
  ENAMETOOLONG: '文件名太长', EACCES: '没有权限', EPERM: '没有权限', ENOSPC: '磁盘已满',
}

/** 失败原因：按错误码映射成一句人话，不把带完整路径的原始系统错误交给用户。 */
export function describeFailure(theme: Theme, e: unknown): string {
  if (isAhaError(e)) {
    switch (e.code) {
      case 'character-not-found': return `来源里找不到这个${theme.concept('character')}`
      case 'character-exists': return `这里已有同名的${theme.concept('character')}目录`
      case 'import-source-symlink': return '来源里的文件是符号链接，不读取'
      case 'version-too-new': return `${theme.concept('tavern')}的数据比插件新，请先升级插件`
      case 'import-invalid-decision': return '这种情况不能这样处理'
      case 'import-same-tavern': return `来源与目标是同一间${theme.concept('tavern')}`
      case 'card-invalid': return `${theme.concept('card')}内容不合要求`
      default: return `其他原因（${e.code}）`
    }
  }
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string') return SYSTEM_CODES[code] ?? `其他原因（${code}）`
  return '其他原因'
}

/** 汇总：导入了哪些、覆盖了哪些、跳过了哪些、因何失败。 */
export function summarize(theme: Theme, outcomes: readonly Outcome[], info: SummaryInfo): Reply {
  const label = (o: Outcome): string =>
    o.kind === 'profile' ? theme.concept('profile') : `「${shownName(o.name)}」`
  const group = (r: OutcomeResult): Outcome[] => outcomes.filter((o) => o.result === r)
  const lines: string[] = [
    `从「${shownName(info.sourceName)}」${theme.action('import')}：${outcomes.length === 0 ? `没有${theme.action('import')}任何内容。` : '办完了。'}`,
  ]
  const list = (title: string, items: Outcome[], fmt: (o: Outcome) => string = label): void => {
    if (items.length) lines.push(`${title}：${items.map(fmt).join('、')}`)
  }
  list(`${theme.action('import')}了`, group('imported'))
  list('覆盖了', group('overwritten'))
  list(`另存为新${theme.concept('character')}`, group('copied'), (o) => `${label(o)}→「${shownName(o.savedAs ?? o.name)}」`)
  list('跳过了', group('skipped').filter((o) => !o.cancelled))
  list('因提问被中断而取消了', group('skipped').filter((o) => o.cancelled))
  list('没成功', group('failed'), (o) => `${label(o)}（${clip(o.error ?? '其他原因', 80)}）`)
  const lost = outcomes.flatMap((o) =>
    (o.skippedFiles ?? []).map((f) => `${label(o)}的 ${shownName(f.name)}（${f.reason === 'too-large' ? '文件太大' : '复制失败'}）`))
  if (lost.length) lines.push(`没带上的附带文件：${lost.join('、')}`)
  if (info.brokenCount > 0) {
    const sym = info.brokenSymlinks ? `（其中 ${info.brokenSymlinks} 个是符号链接，不读取）` : ''
    lines.push(`来源里另有 ${info.brokenCount} 张${theme.concept('card')}读不出来，没有列入${sym}。`)
  }
  if (info.profileUnsafe) lines.push(`来源的${theme.concept('profile')}是符号链接，没有读取。`)
  if (info.aborted) lines.push(`中途出错，后面的没有处理：${clip(info.aborted, 120)}`)
  const succeeded = outcomes.some((o) => o.result === 'imported' || o.result === 'overwritten' || o.result === 'copied')
  const failed = info.aborted !== undefined || (outcomes.some((o) => o.result === 'failed') && !succeeded)
  return { kind: failed ? 'error' : 'success', text: lines.join('\n') }
}

export interface ImportHooks {
  now?(): string
  /** 与工具保存共用的会话锁：导入进行中，同一会话里模型的保存调用排在后面。 */
  gate?: SessionGate
}

/** `导入` / `import`：全程不经模型。 */
export function importHandler(
  sections: Pick<SetupSections, 'refresh'>, getAsk: () => AskFn | undefined, hooks: ImportHooks = {},
): CommandHandler {
  const now = hooks.now ?? (() => new Date().toISOString())
  return (inv) => (hooks.gate ? hooks.gate.run(inv.agent.id, () => runImport(inv), 'command') : runImport(inv))

  async function runImport({ agent, services, rt, theme, context, signal }: Parameters<CommandHandler>[0]): Promise<Reply> {
    const tavern = context.tavern
    if (!tavern) return failureReceipt(`这里还不是${theme.concept('tavern')}`)
    if (isReadonly(tavern)) return readonlyReceipt(theme)
    const ask = getAsk()
    if (!ask) {
      rt.log.warn('导入：选择卡片不可用（没有 userQuestions 服务）')
      return failureReceipt('选择卡片不可用')
    }
    const askOne = async (item: AskItem): Promise<unknown> => {
      if (signal?.aborted) throw new AskCancelled()
      try {
        return await ask({ agent, ...(signal ? { signal } : {}), questions: [item] })
      } catch (e) {
        if (isAbort(e, signal)) throw new AskCancelled()
        throw new AskFailure((e as Error).message, { cause: e })
      }
    }

    const registry = await readRegistry(rt.config.registryPath)
    const here = path.resolve(tavern.dir)
    const sources = registry
      .filter((e) => path.resolve(e.path) !== here && e.id !== tavern.marker.id)
      .map((e) => ({ name: e.name, path: e.path }))
    if (sources.length === 0) return importNoSourceReceipt(theme)

    // 选来源与选内容两步被中断，等同于取消整个导入
    const stepAnswer = async (item: AskItem): Promise<unknown> => {
      try {
        return await askOne(item)
      } catch (e) {
        if (e instanceof AskCancelled) return undefined
        throw e
      }
    }
    const sq = buildSourceQuestion(theme, sources)
    const source = interpretSingle(await stepAnswer(sq.item), sq)
    if (!source) return importCancelledReceipt(theme)

    let listing: SourceListing
    try {
      listing = await listImportable(source.path)
    } catch (e) {
      rt.log.warn(`导入：读不了来源 ${source.path}：${(e as Error).message}`)
      if (isAhaError(e, 'version-too-new')) {
        return failureReceipt(`来源${theme.concept('tavern')}「${shownName(source.name)}」的数据比插件新，请先升级插件`)
      }
      return failureReceipt(`读不了「${shownName(source.name)}」：${describeFailure(theme, e)}`)
    }
    if (listing.characters.length === 0 && !listing.hasProfile) {
      return importNothingReceipt(theme, listing.tavernName, listing.broken.length)
    }

    const picks: ImportPick[] = []
    for (const batch of buildPickBatches(theme, listing)) {
      const got = interpretMulti(await stepAnswer(batch.item), batch)
      if (!got) return importCancelledReceipt(theme)
      picks.push(...got)
    }

    const outcomes: Outcome[] = []
    let aborted: string | undefined
    try {
      for (const pick of picks) {
        outcomes.push(pick.kind === 'profile'
          ? await runProfile(source.path, tavern.dir, theme, askOne)
          : await runCharacter(source.path, tavern.dir, pick, theme, askOne, now()))
      }
    } catch (e) {
      rt.log.warn(`导入中途出错：${(e as Error).message}`)
      aborted = isAskFailure(e) ? `提问没能完成（${(e as Error).message}）` : describeFailure(theme, e)
    }

    if (outcomes.some((o) => o.result === 'imported' || o.result === 'overwritten' || o.result === 'copied')) {
      try {
        await sections.refresh(agent, services, theme)
      } catch (e) {
        rt.log.warn(`导入后刷新掌柜提示词段失败：${(e as Error).message}`)
      }
    }
    rt.log.info(`导入：${source.path} -> ${tavern.dir}，${outcomes.map((o) => `${o.kind}:${o.result}`).join(',')}`)
    return summarize(theme, outcomes, {
      sourceName: listing.tavernName,
      brokenCount: listing.broken.length,
      brokenSymlinks: listing.broken.filter((b) => b.problem === 'symlink').length,
      ...(listing.profileUnsafe ? { profileUnsafe: true } : {}),
      ...(aborted ? { aborted } : {}),
    })
  }
}

type AskOne = (item: AskItem) => Promise<unknown>

async function runCharacter(
  sourceDir: string, targetDir: string, pick: Extract<ImportPick, { kind: 'character' }>,
  theme: Theme, askOne: AskOne, now: string,
): Promise<Outcome> {
  const base = { kind: 'character' as const, name: pick.name }
  try {
    let r = await importCharacter(sourceDir, targetDir, { characterId: pick.id, now })
    if (r.status === 'needs-decision') {
      const cq = buildConflictQuestion(theme, r.conflict, pick.name)
      // 取消这一步：这个角色不导入
      const decision = interpretSingle(await askOne(cq.item), cq)
      if (!decision) return { ...base, result: 'skipped' }
      r = await importCharacter(sourceDir, targetDir, { characterId: pick.id, now, decision })
    }
    if (r.status === 'skipped' || r.status === 'needs-decision') return { ...base, result: 'skipped' }
    const result: OutcomeResult = r.mode === 'overwrite' ? 'overwritten' : r.mode === 'copy' ? 'copied' : 'imported'
    return {
      ...base, result,
      ...(r.mode === 'copy' ? { savedAs: r.card.name } : {}),
      ...(r.skippedFiles.length ? { skippedFiles: r.skippedFiles } : {}),
    }
  } catch (e) {
    // 卡片本身出错（问不了用户）要停下；文件层面的错误只算这一个失败
    if (e instanceof AskCancelled) return { ...base, result: 'skipped', cancelled: true }
    if (isAskFailure(e)) throw e
    return { ...base, result: 'failed', error: describeFailure(theme, e) }
  }
}

async function runProfile(sourceDir: string, targetDir: string, theme: Theme, askOne: AskOne): Promise<Outcome> {
  const base = { kind: 'profile' as const, name: '' }
  try {
    let r = await importProfile(sourceDir, targetDir)
    if (r.status === 'needs-decision') {
      const pq = buildProfileConflictQuestion(theme)
      const decision = interpretSingle(await askOne(pq.item), pq)
      if (!decision) return { ...base, result: 'skipped' }
      r = await importProfile(sourceDir, targetDir, decision)
    }
    if (r.status === 'imported') return { ...base, result: r.mode === 'overwrite' ? 'overwritten' : 'imported' }
    if (r.status === 'no-source') return { ...base, result: 'failed', error: '来源已经没有了' }
    return { ...base, result: 'skipped' }
  } catch (e) {
    if (e instanceof AskCancelled) return { ...base, result: 'skipped', cancelled: true }
    if (isAskFailure(e)) throw e
    return { ...base, result: 'failed', error: describeFailure(theme, e) }
  }
}

/** 弹卡片本身失败（宿主出错、被中断）：不能算作某个角色的失败，要停下整个导入。 */
class AskFailure extends Error {}
/** 提问被用户中断：按"取消当前这一步"处理。 */
class AskCancelled extends Error {}
const isAskFailure = (e: unknown): boolean => e instanceof AskFailure
