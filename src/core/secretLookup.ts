/**
 * 从 Go 的 DPAPI 接口**现取**一个档案密码（`GET /api/secret?key=<档案名>`）。
 *
 * 为什么不只在启动时取一次快照：CLI（core）启动时把密码表读进内存之后，
 * 用户在界面里「清除已保存的密码」只会删掉 DPAPI 里那份 —— 内存里那份还在，
 * 于是 AI 的 `bastion_connect` 仍然拿旧密码去连（2026-11-27 报的"清理不掉"是同一类问题的桌面版）。
 *
 * 现取就没有这个问题：DPAPI 里没有 → 立刻连不上并给出可读理由；
 * 新存的密码也不用重启应用才生效。
 *
 * 取不到（404 / 连不上 / 超时）一律返回 `undefined`，由调用方决定怎么报错 —— 不抛。
 */

export interface FetchSecretOptions {
  /** 超时（毫秒）。DPAPI 是本机调用，正常几毫秒；短一点避免拖住 connect */
  timeoutMs?: number
}

/** 见文件头注释：失败返回 undefined，绝不抛 */
export async function fetchSecret(
  base: string,
  name: string,
  opts: FetchSecretOptions = {}
): Promise<string | undefined> {
  const root = (base ?? '').trim().replace(/\/+$/, '')
  const key = (name ?? '').trim()
  if (!root || !key) return undefined
  const timeoutMs = opts.timeoutMs ?? 3000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`${root}/api/secret?key=${encodeURIComponent(key)}`, { signal: ac.signal })
    if (!r.ok) return undefined
    const j = (await r.json()) as { value?: unknown }
    return typeof j.value === 'string' && j.value !== '' ? j.value : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
