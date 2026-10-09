// 统一错误类：所有 core 模块抛出带稳定错误码的异常，由外壳决定如何对用户说。

export type AhaErrorCode =
  | 'already-tavern'
  | 'not-tavern'
  | 'marker-invalid'
  | 'version-too-new'
  | 'invalid-name'
  | 'lock-timeout'
  | 'registry-invalid'
  | 'theme-invalid'
  | 'character-exists'
  | 'character-not-found'
  | 'card-invalid'
  | 'memory-invalid'
  | 'chat-not-found'
  | 'chat-invalid'
  | 'session-locked'
  | 'session-invalid'

export class AhaError extends Error {
  readonly code: AhaErrorCode

  constructor(code: AhaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AhaError'
    this.code = code
  }
}

export function isAhaError(e: unknown, code?: AhaErrorCode): e is AhaError {
  return e instanceof AhaError && (code === undefined || e.code === code)
}
