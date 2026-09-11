import * as vscode from 'vscode'

/**
 * 状态栏槽位管理。
 *
 * 底栏是稀缺资源，不能谁想显示就各自 createStatusBarItem —— 那样会互相挤、顺序也乱。
 * 所以统一走这里，分两层：
 *   - 常驻项（session）：永远在，显示会话概览
 *   - 临时项（transfer / deploy / forward / readonly / ai / mfa）：有事才出现，结束即消失
 *
 * 每个槽位是独立的 StatusBarItem，用优先级控制左右顺序（数字越大越靠左）。
 * clearSlot 是幂等的，随便重复调；setSlot 会清掉上一次的自动隐藏定时器。
 */

export type SlotName = 'mfa' | 'transfer' | 'deploy' | 'ai' | 'forward' | 'overwrite' | 'readonly' | 'keepterm' | 'broadcast' | 'broadcastmode' | 'session'

/** 优先级：数字越大越靠左。MFA 最紧急放最左，会话概览常驻放最右 */
const PRIORITY: Record<SlotName, number> = {
  mfa: 1000,
  transfer: 900,
  deploy: 850,
  ai: 800,
  forward: 700,
  overwrite: 650,
  readonly: 600,
  keepterm: 580,
  broadcast: 570,
  broadcastmode: 560,
  session: 500
}

interface SlotState {
  item: vscode.StatusBarItem
  /** 临时项的自动隐藏定时器 */
  timer: NodeJS.Timeout | null
}

const slots = new Map<SlotName, SlotState>()

function slot(name: SlotName): SlotState {
  let s = slots.get(name)
  if (!s) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY[name])
    item.name = `BastionShell ${name}`
    s = { item, timer: null }
    slots.set(name, s)
  }
  return s
}

export interface SlotContent {
  text: string
  tooltip?: string | vscode.MarkdownString
  /** 点击执行的命令 */
  command?: string
  commandArgs?: unknown[]
  /** 前景色 */
  color?: vscode.ThemeColor
  /** 背景色，用来做「警告」态 */
  backgroundColor?: vscode.ThemeColor
}

/** 显示 / 更新一个槽位（会取消该槽位待执行的自动隐藏） */
export function setSlot(name: SlotName, c: SlotContent): void {
  const s = slot(name)
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
  s.item.text = c.text
  s.item.tooltip = c.tooltip
  // arguments 为空时不要带这个键，避免个别 VS Code 版本把空数组当成「无命令」
  s.item.command = c.command
    ? c.commandArgs && c.commandArgs.length > 0
      ? { title: s.item.name ?? name, command: c.command, arguments: c.commandArgs }
      : { title: s.item.name ?? name, command: c.command }
    : undefined
  s.item.color = c.color
  s.item.backgroundColor = c.backgroundColor
  s.item.show()
}

/** 显示一个临时状态，ms 毫秒后自动消失（用于「上传完成 ✓」这类回执） */
export function flashSlot(name: SlotName, c: SlotContent, ms = 4000): void {
  setSlot(name, c)
  const s = slot(name)
  s.timer = setTimeout(() => {
    s.timer = null
    // 只有期间没人再写过这个槽位才隐藏，避免把新状态误吞掉
    if (s.item.text === c.text) s.item.hide()
  }, ms)
}

export function clearSlot(name: SlotName): void {
  const s = slots.get(name)
  if (!s) return
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
  s.item.hide()
}

export function disposeSlots(): void {
  for (const s of slots.values()) {
    if (s.timer) clearTimeout(s.timer)
    s.item.dispose()
  }
  slots.clear()
}

// ---- 通用格式化：状态栏和提示都要用，放一处免得各写一份 ----

/** 字节数 → 人类可读（1.2 MB） */
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

/** 进度条：用实心/空心方块拼一个，给 tooltip 用 */
export function progressBar(ratio: number, width = 20): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const filled = Math.round(r * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
