/**
 * 连接池里「把一个档案的连接摘掉」这一件事（纯逻辑，不依赖 vscode，好测）。
 *
 * 为什么值得单独拎出来：`SharedConnection` 自己捏着这次握手用的密码
 * （`retryAuth` 沿用它，为的是"只重问动态码、不用重输密码"）。
 * 用户在钥匙串里清掉密码之后，池子里这个对象**还带着旧密码** ——
 * 下次连接 `manager.get()` 直接命中它，既不读钥匙串也不弹输入框，
 * 于是一个"清掉了"的密码还在被用（2026-11-27 维护者报的"清理不掉"就是这个）。
 *
 * 认证失败时更隐蔽：`authFailed` 会让 close 回调提前 return，池子**不会**自动摘掉它。
 *
 * 规则：
 *   - 池子里有这条连接 → 从池子摘掉（下次连接才会重新读钥匙串 / 问人）；
 *   - 它还有活着的通道 → 只摘池子，**不** end()，免得把别人正在用的终端打死；
 *   - 没有通道 / 不在池子里 → 该 end() 就 end()；不在池子里就什么都不做（幂等）。
 */

/** 池子里这个对象最少要满足的形状（便于测试用假对象） */
export interface PooledConnectionLike {
  readonly isAlive: boolean
  /** 这条连接上还开着几个 shell 通道 */
  readonly channelCount: number
  end(): void
}

export interface ForgetResult {
  /** 池子里原本有没有它 */
  dropped: boolean
  /** 有没有真的把它关掉 */
  ended: boolean
}

/** 从池子里摘掉某条连接（幂等） */
export function forgetConnection<T extends PooledConnectionLike>(
  pool: Map<string, T>,
  name: string
): ForgetResult {
  const conn = pool.get(name)
  if (!conn) return { dropped: false, ended: false }
  pool.delete(name)
  const ended = conn.channelCount === 0
  if (ended) conn.end()
  return { dropped: true, ended }
}
