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
