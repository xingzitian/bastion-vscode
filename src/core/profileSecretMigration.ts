/**
 * 档案改名 / 删除之后，钥匙串里那份密码怎么办（纯逻辑，不依赖 vscode）。
 *
 * 为什么需要：密码在 SecretStorage 里是**按档案名**存的（`bastion.pass.<名字>`）。
 * 用户把「中转2」改名成「中转长期机器」之后：
 *   - 新名字查不到密码 → 每次都要重输（能忍，但烦）；
 *   - 旧名字那份**永远留在钥匙串里**，而列表里已经没有这个名字了 —— 界面上没有任何入口
 *     能再清掉它（SecretStorage 不能枚举）。维护者 2026-11-27 的「清理密码还是有问题」
 *     一部分就来自这里：名字改了，旧密码清不掉、也看不见。
 *
 * 所以保存档案时做一次对账：
 *   - **改名**（一个旧名字消失、一个新名字出现，且身份字段完全一样）→ 把密码/口令搬到新名字下；
 *   - **删除**（找不到对应的新名字）→ 把它那份密码/口令清掉，别留孤儿；
 *   - **拿不准**（同一台机器有两个同身份档案）→ 什么都不做，只在日志里说一声。
 *
 * 「身份字段」= host + port + username + 私钥路径。刻意**不含**档案名，也**不含** authMethod
 * （把 password 改成 key 通常就是同一台机器换了认证方式，密码该跟着走）。
 */

export interface ProfileIdentityLike {
  name: string
  host: string
  port?: number
  username: string
  privateKeyPath?: string
}

export interface SecretPlan {
  /** 需要把密码/口令从 from 搬到 to */
  renames: Array<{ from: string; to: string }>
  /** 档案被删掉了，它的密码/口令应该清掉 */
  removed: string[]
  /** 拿不准 / 有歧义，两边都不动（只用于日志） */
  skipped: string[]
}

function identityKey(p: ProfileIdentityLike): string {
  return [
    (p.host ?? '').trim().toLowerCase(),
    String(p.port ?? 22),
    (p.username ?? '').trim().toLowerCase(),
    (p.privateKeyPath ?? '').trim()
  ].join('|')
}

/**
 * 算出这次保存档案之后要做的密码迁移。
 *
 * 只认「一对一」的改名：同一个身份在旧列表出现 1 次、在新列表也出现 1 次。
 * 出现 2 次以上就分不清谁是谁 —— 那时候宁可什么都不做（密码留在旧名字下，至少没丢）。
 */
export function planSecretMigration(
  before: readonly ProfileIdentityLike[],
  after: readonly ProfileIdentityLike[]
): SecretPlan {
  const oldNames = new Set(before.map((p) => p.name))
  const newNames = new Set(after.map((p) => p.name))

  const gone = before.filter((p) => !newNames.has(p.name))
  const appeared = after.filter((p) => !oldNames.has(p.name))

  // 按身份分组：>1 的一律视为「分不清」
  const byIdentityGone = new Map<string, ProfileIdentityLike[]>()
  for (const p of gone) {
    const k = identityKey(p)
    byIdentityGone.set(k, [...(byIdentityGone.get(k) ?? []), p])
  }
  const byIdentityNew = new Map<string, ProfileIdentityLike[]>()
  for (const p of appeared) {
    const k = identityKey(p)
    byIdentityNew.set(k, [...(byIdentityNew.get(k) ?? []), p])
  }

  const plan: SecretPlan = { renames: [], removed: [], skipped: [] }
  const claimed = new Set<string>()

  for (const [key, olds] of byIdentityGone) {
    const news = byIdentityNew.get(key) ?? []
    if (olds.length === 1 && news.length === 1 && !claimed.has(news[0].name)) {
      plan.renames.push({ from: olds[0].name, to: news[0].name })
      claimed.add(news[0].name)
      continue
    }
    if (news.length > 0 || olds.length > 1) {
      // 同一身份有多条：别猜（既不搬也不删）
      plan.skipped.push(...olds.map((p) => p.name))
      continue
    }
    plan.removed.push(...olds.map((p) => p.name))
  }

  // 新出现但没被认领的（纯新增档案）：什么都不用做
  return plan
}
