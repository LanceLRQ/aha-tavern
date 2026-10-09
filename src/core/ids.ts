// 编号生成：小写字母加数字的随机串。
import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomString(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

export const newCharacterId = (): string => `c_${randomString(8)}`
export const newTavernId = (): string => `t_${randomString(8)}`
export const newChatId = (): string => randomString(4)
/** 聊天编号的格式：与 newChatId 的字符集和长度一致。外来输入先过它再用。 */
export const CHAT_ID_PATTERN = /^[0-9a-z]{4}$/
export const isChatId = (v: unknown): v is string => typeof v === 'string' && CHAT_ID_PATTERN.test(v)
