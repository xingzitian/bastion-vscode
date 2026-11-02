/**
 * 最近关闭的会话（带 TTL）。
 *
 * 为什么需要它：`findSession` 报错时必须能分清两件事 ——
 *   - 「会话 s-22be 刚被关掉了」（绑定还在、屏幕没了）
 *   - 「你说的这个名字根本没有匹配到任何会话」（参数写错）
 * 两种情况下"下一步"完全不同：前者要重连/重新绑定，后者要改参数。
 */
const TTL_MS = 10 * 60 * 1000
const closed = new Map<string, number>()

/** 记一条"刚关闭"的会话（终端关闭/销毁时调） */
export function rememberClosedSession(sessionId: string): void {
  const id = (sessionId ?? '').trim()
  if (!id) return
  closed.set(id, Date.now())
}

/** 这个会话 id 是不是最近刚关掉的（顺便清理过期项） */
export function isRecentlyClosedSession(sessionId: string): boolean {
  const id = (sessionId ?? '').trim()
  if (!id) return false
  prune()
  return closed.has(id)
}

/** 供测试/诊断：当前记住的关闭记录 */
export function recentClosedSessions(): string[] {
  prune()
  return [...closed.keys()]
}

function prune(): void {
  const now = Date.now()
  for (const [id, at] of closed) if (now - at > TTL_MS) closed.delete(id)
}

/** 测试用 */
export function resetClosedSessions(): void {
  closed.clear()
}
