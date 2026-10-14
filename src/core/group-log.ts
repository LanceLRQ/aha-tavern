// 群聊回复的拆分（二期规格 §6、§15）：整段回复按行首标记拆成旁白与角色台词。
// 纯函数；接线与落盘在 shell/group-transcript.ts。

/** 拆出的一段：旁白或某角色的台词。 */
export interface GroupLine {
  kind: 'narrator' | 'character'
  /** kind 为 character 时的角色编号 */
  speaker?: string
  text: string
  /** 代表用户的行（越界，规格 §15）：记为旁白并打上标记 */
  userImpersonated?: boolean
}

/** 名字匹配用的最小信息。 */
export interface KnownCharacter {
  id: string
  name: string
}

/** 行首的名字部分（冒号前）：太长的不当名字，防误吞正文。 */
const NAME_MAX = 40
/** 越界判定：这些开头的行视为替用户说话。 */
const USER_LABELS = new Set(['我', 'user', '用户', '你'])
// 量词里的长度上限要拼进字符串，正则字面量不会插值变量
const NAME_LINE_RE = new RegExp(`^([^：:]{1,${NAME_MAX}})[：:]\\s*`)

const stripMarker = (line: string, label: string): string => line.slice(label.length).trim()

function nameLabel(line: string): string | null {
  const m = NAME_LINE_RE.exec(line)
  return m ? (m[1] ?? '').trim() : null
}

/** 名字匹配（不分大小写）：全名相等优先，其次唯一的前缀命中；都没有为 null。 */
function matchName(label: string, known: readonly KnownCharacter[]): KnownCharacter | null {
  const q = label.toLowerCase()
  const exact = known.filter((c) => c.name.trim().toLowerCase() === q)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null
  const prefix = known.filter((c) => c.name.trim().toLowerCase().startsWith(q))
  return prefix.length === 1 ? prefix[0]! : null
}

/**
 * 拆整段回复：以「【旁白】」（或主题对 narrator 的称呼）开头的行起新的旁白段，
 * 以「名字：」开头的行起新的台词段（名字按酒馆里的角色匹配，不在场的也照记，规格 §15）；
 * 代表用户的行记为旁白并打越界标记；拆不出合法行首的段落整段记为旁白（规格 §6）。
 * 后续不以行首标记开头的行并入当前段；开头之前的内容也是旁白。
 */
export function parseGroupReply(
  reply: string,
  known: readonly KnownCharacter[],
  narratorLabels: readonly string[] = ['旁白'],
): GroupLine[] {
  const lines = reply.replace(/\r\n?/g, '\n').split('\n')
  const out: GroupLine[] = []
  const pushNarrator = (text: string, userImpersonated = false): void => {
    const t = text.trim()
    if (t === '') return
    out.push({ kind: 'narrator', text: t, ...(userImpersonated ? { userImpersonated: true } : {}) })
  }
  let current: GroupLine | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    // 新段的判定只看行首：【旁白】（含主题称呼）或「名字：」
    const marker = narratorLabels.find((l) => l !== '' && trimmed.startsWith(`【${l}】`))
    if (marker !== undefined) {
      current = null
      pushNarrator(stripMarker(trimmed, `【${marker}】`))
      continue
    }
    const label = nameLabel(trimmed)
    if (label !== null) {
      if (USER_LABELS.has(label.toLowerCase())) {
        current = null
        pushNarrator(stripMarker(trimmed, `${label}：`), true)
        continue
      }
      const hit = matchName(label, known)
      if (hit) {
        current = { kind: 'character', speaker: hit.id, text: stripMarker(trimmed, `${label}：`) }
        out.push(current)
        continue
      }
    }
    // 不是新段：并入当前段；当前没有段（开头就没有标记）则归旁白
    if (current) current.text += `\n${trimmed}`
    else pushNarrator(trimmed)
  }
  return out.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text !== '')
}
