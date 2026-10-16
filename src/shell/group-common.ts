// 群聊外壳共用的函数：名字匹配、场景标题（group.ts、group-scene.ts、group-memory.ts 都要用，放这里避免循环依赖）。
import { matchCharacterName, type CharacterEntry } from '../core/card'
import { readRecords } from '../core/chat'
import type { ShowSummary } from '../core/summary'
import type { BadEntry, GoodEntry } from './chat'

export type NameResolve =
  | { kind: 'ok'; entries: GoodEntry[] }
  | { kind: 'none'; name: string }
  | { kind: 'ambiguous'; name: string; candidates: CharacterEntry[] }
  /** 名字对上的是坏卡：交给回执说明是哪个目录、什么问题 */
  | { kind: 'bad-card'; entry: BadEntry }

/** 逐个名字匹配（与单聊同规则，含包含档），保序去重；对上坏卡时单独说明。 */
export function matchGroupNames(entries: readonly CharacterEntry[], names: readonly string[]): NameResolve {
  const out: GoodEntry[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const m = matchCharacterName([...entries], name, { contains: true })
    switch (m.kind) {
      case 'exact':
      case 'prefix':
      case 'contains': {
        const e = m.entry
        if (!e.ok) return { kind: 'bad-card', entry: e }
        if (!seen.has(e.card.id)) {
          seen.add(e.card.id)
          out.push(e)
        }
        break
      }
      case 'ambiguous':
        return { kind: 'ambiguous', name, candidates: m.candidates }
      case 'none':
        return { kind: 'none', name }
    }
  }
  return { kind: 'ok', entries: out }
}

/** 写某个场景的梗概时用的标题：这次给的 > 梗概里已有的 > 换场时写进场景分界的（场景一没有分界）。 */
export async function sceneTitleOf(
  tavernDir: string, chatId: string, show: ShowSummary, scene: number, given?: string,
): Promise<string | null> {
  if (given) return given
  const existing = show.scenes.find((s) => s.index === scene)?.title
  if (existing) return existing
  const { records } = await readRecords(tavernDir, chatId)
  const boundary = records.filter((r) => r.type === 'scene' && r.scene === scene).pop()
  return boundary?.text.trim() || null
}
