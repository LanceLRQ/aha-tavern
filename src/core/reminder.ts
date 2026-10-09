// 审视提醒的计数器（规格 7.3）：按会话在内存里计数，进程重启后从零开始。
// 每条用户消息加一；任何记忆写入都清零；达到间隔时返回 true 并清零。

export class ReviewReminder {
  private readonly counts = new Map<string, number>()

  /** interval 小于 1 或不是有限数时不提醒。 */
  constructor(private readonly interval: number) {}

  /** 来了一条用户消息；返回此刻是否该提醒（返回 true 时计数已清零）。 */
  onUserMessage(session: string): boolean {
    if (!Number.isFinite(this.interval) || this.interval < 1) return false
    const n = (this.counts.get(session) ?? 0) + 1
    if (n >= this.interval) {
      this.counts.set(session, 0)
      return true
    }
    this.counts.set(session, n)
    return false
  }

  /** 发生了记忆写入（随手记、整理、手动记住）。 */
  onWrite(session: string): void {
    this.counts.set(session, 0)
  }

  /** 提醒没能送出：回退到下一条用户消息就再次触发。 */
  retry(session: string): void {
    if (Number.isFinite(this.interval) && this.interval >= 1) this.counts.set(session, this.interval - 1)
  }

  forget(session: string): void {
    this.counts.delete(session)
  }
}
