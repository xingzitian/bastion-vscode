/**
 * 纯格式化工具（不 import vscode）。
 *
 * 从 `status.ts` 拆出来：`transferPath` / `uploadVerify` / `deployReport` 只需要这几个函数，
 * 而 `status.ts` 本身是状态栏（宿主专属）。拆开后 core 里不再出现 vscode 依赖。
 * `status.ts` 会 re-export 这里，宿主代码零改动。
 */

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** 毫秒 → 人类可读（3s / 1m20s / 1h02m） */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h${String(rm).padStart(2, '0')}m`
}

/** 速率（字节/秒）。传 undefined 也安全 —— 小文件算不出速率时会没有这个字段 */
export function fmtSpeed(bytesPerSec: number | undefined): string {
  if (bytesPerSec === undefined || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '-'
  return `${fmtBytes(bytesPerSec)}/s`
}

export function progressBar(ratio: number, width = 20): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const filled = Math.round(r * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}
