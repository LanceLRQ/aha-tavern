// 参考图上传的记账：同一个服务地址上，同一张图（按内容的 SHA-256 取名）只传一次，并发的请求共享同一次上传。
// 本模块不自己建客户端，上传动作由调用方传入（ComfyClient.uploadImage 的形状），便于测试。单聊（chat.ts 装配处）与筹备（look.ts）各有一个实例，同一张图在两边各传一次。
import { createHash } from 'node:crypto'

/** 上传一张图，返回服务端实际使用的文件名。 */
export type UploadFn = (data: Uint8Array, filename: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<string>

/** 内容对应的服务端文件名：aha-ref-<SHA-256 前 16 位十六进制>.png。 */
export function refFileName(bytes: Uint8Array): string {
  return `aha-ref-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`
}

export class RefUploader {
  /** 键是"服务地址 + 文件名"；值是进行中或已完成的上传（存的是服务端返回的名字）。失败的不留。 */
  private readonly uploads = new Map<string, Promise<string>>()

  private key(endpoint: string, filename: string): string {
    return `${endpoint}\n${filename}`
  }

  /** 确保这张图已在该服务上；返回服务端文件名。已传过的直接返回，进行中的共享同一个 Promise。 */
  ensure(
    endpoint: string, bytes: Uint8Array, upload: UploadFn, opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const filename = refFileName(bytes)
    const k = this.key(endpoint, filename)
    const hit = this.uploads.get(k)
    if (hit) return hit
    const p = upload(bytes, filename, opts)
    this.uploads.set(k, p)
    p.catch(() => {
      if (this.uploads.get(k) === p) this.uploads.delete(k)
    })
    return p
  }

  /** 忘掉这张图在该服务上的记账（服务端说图不存在时用，下次会重传）。 */
  forget(endpoint: string, bytes: Uint8Array): void {
    this.uploads.delete(this.key(endpoint, refFileName(bytes)))
  }
}
