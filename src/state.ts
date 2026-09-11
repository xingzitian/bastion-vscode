/**
 * 扩展的共享状态。
 *
 * 单列一个模块是为了打破「谁都能改全局变量」的乱局：其它模块只 import 具体的名字，
 * 写操作必须走 setter —— 这样谁在什么时候改了状态，grep setter 就能查清楚。
 *
 * 注意：这里导出的 `let` 在别的文件里是**只读**的（ESM 语义），
 * 想改必须调对应的 setXxx()。
 */

import * as vscode from 'vscode'
import { ConnectionManager, SharedConnection } from './connection'
import { BastionTerminal } from './terminal'
import type { ConnectionProfile } from './profiles'
import { BastionProfilesProvider } from './profilesTree'
import { DeployTasksProvider } from './deployTree'
import { QuickCommandsProvider } from './quickCommands'
import { ForwardRulesProvider } from './forward'
import { TransferHistoryProvider } from './transfer'
import { fmtDuration } from './status'
import type { FedLine } from './localPath'

export let ctx: vscode.ExtensionContext

export let profilesProvider: BastionProfilesProvider

export let deployProvider: DeployTasksProvider

export let quickCommandsProvider: QuickCommandsProvider

export let forwardProvider: ForwardRulesProvider

export let transferProvider: TransferHistoryProvider

export const manager = new ConnectionManager()

/** 记录每个 VS Code 终端对应的 BastionTerminal（多开会话管理） */
export const terminals = new Map<vscode.Terminal, BastionTerminal>()

/** 最近一个堡垒机会话（AI 执行命令时若活动终端不是堡垒机，用它兜底） */
export let lastBastionTerminal: BastionTerminal | null = null

/** 最近一次连接的档案（断连后一键重连用） */
export let lastBastionProfile: ConnectionProfile | null = null

/** 已挂过断连提示的连接，避免多会话时重复弹窗 */
export const reconnectNotified = new Set<SharedConnection>()

/** 「当前焦点是否在堡垒机终端」：用于网关文件右键上传，避免在编辑器/预览页时误传 */
export let activeIsBastion = false

export function setActiveIsBastion(value: boolean): void {
  activeIsBastion = value
  void vscode.commands.executeCommand('setContext', 'bastion.activeIsBastion', value)
}

/** 会话号自增器：只在本次窗口生命周期内递增，不复用，避免「#1 一会儿是这个一会儿是那个」 */
export let sessionSeq = 0

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 当前活动（或最近）的堡垒机会话 */
export function activeSession(): { vt: vscode.Terminal; term: BastionTerminal } | undefined {
  const vt = vscode.window.activeTerminal
  if (vt) {
    const term = terminals.get(vt)
    if (term) return { vt, term }
  }
  if (lastBastionTerminal) {
    for (const [v, t] of terminals) {
      if (t === lastBastionTerminal) return { vt: v, term: t }
    }
  }
  return undefined
}

/** 槽位文本：会话号统一显示成 #1 这种 */
export function sessionTag(term: BastionTerminal): string {
  return term.sessionNo > 0 ? `#${term.sessionNo}` : '#?'
}

/** 会话行的统一描述（状态栏 tooltip / 切换列表共用，免得两处写两遍还不一致） */
export function describeSession(vt: vscode.Terminal, term: BastionTerminal): string {
  const age = term.conn.connectedAt > 0 ? fmtDuration(Date.now() - term.conn.connectedAt) : '连接中'
  const flags = [term.isReadOnly ? '只读' : '可写', `已连 ${age}`].join(' · ')
  return `${sessionTag(term)} ${vt.name.replace(/^#\d+\s*/, '')}  ${flags}`
}

// ---- 写状态的入口（其它模块要改状态只能走这里）----

export function setCtx(c: vscode.ExtensionContext): void {
  ctx = c
}
export function setProfilesProvider(p: BastionProfilesProvider): void {
  profilesProvider = p
}
export function setDeployProvider(p: DeployTasksProvider): void {
  deployProvider = p
}
export function setQuickCommandsProvider(p: QuickCommandsProvider): void {
  quickCommandsProvider = p
}
export function setForwardProvider(p: ForwardRulesProvider): void {
  forwardProvider = p
}
export function setTransferProvider(p: TransferHistoryProvider): void {
  transferProvider = p
}
export function setLastBastionTerminal(t: BastionTerminal | null): void {
  lastBastionTerminal = t
}
export function setLastBastionProfile(p: ConnectionProfile | null): void {
  lastBastionProfile = p
}
/** 分配下一个会话号（只在窗口生命周期内递增，不复用） */
export function nextSessionNo(): number {
  return ++sessionSeq
}

// ---- 「最近一次没认出来的屏幕原文」----
// 菜单识别失败时由 sessions.ts 存下来，供命令「从屏幕原文生成菜单规则」使用：
// 用户不用去日志里翻，直接选一句提示就能生成规则。
let lastUnrecognizedScreen = ''

export function setLastUnrecognizedScreen(text: string): void {
  lastUnrecognizedScreen = text
}
export function getLastUnrecognizedScreen(): string {
  return lastUnrecognizedScreen
}

// ---- 广播输入（一次给多个会话发同一条命令）----
// Electron 版有这个能力，VS Code 版一直没有。它跟「批量部署」不同：
// 部署管的是「跑完一批命令拿报告」，广播管的是「边看边敲，所有会话同步」。
let broadcastTargets = new Set<BastionTerminal>()

export function getBroadcastTargets(): BastionTerminal[] {
  return [...broadcastTargets]
}
export function setBroadcastTargets(list: BastionTerminal[]): void {
  broadcastTargets = new Set(list)
}
export function clearBroadcast(): void {
  broadcastTargets = new Set()
}
/** 会话关闭时把自己从广播目标里摘掉（否则底栏台数会一直虚高，还会留着已死对象） */
export function removeBroadcastTarget(t: BastionTerminal): void {
  broadcastTargets.delete(t)
}

/**
 * 这份输入要转发给谁：开着广播时，**除自己以外**的所有目标。
 *
 * 单独抽成纯函数是为了能测：这里最容易犯的错是"把自己也放进接收者"，
 * 那会形成自我转发（虽然 write 不回调 handleInput，但语义上就是错的）。
 * 已关闭和只读的会话也排除 —— 前者写了没意义，后者本来就不接受人工输入。
 */
export function broadcastReceivers(current: BastionTerminal, targets: BastionTerminal[]): BastionTerminal[] {
  if (targets.length === 0) return []
  return targets.filter((t) => t !== current && !t.isReadOnly && !t.isClosed)
}

/**
 * 广播的两种模式。
 *
 * - `raw`  **原样同步**（默认，和 Electron 桌面版一致）：你敲的每一个键都原样发过去。
 *   在 vim 里改配置文件、进交互式菜单、用方向键翻历史，靠的都是它 ——
 *   整行模式在这些场景下根本没法用（vim 的插入/命令模式切换不是"一行"）。
 * - `line` **整行发送**：只在按回车那一刻把这一整行发过去。
 *   敲到一半的内容、退格、方向键都不会跑过去，适合"给几台机器各敲一条命令"。
 *
 * 两种都只同步人工键盘输入；MFA 动态码、AI 执行、部署注入都不广播。
 */
export type BroadcastMode = 'raw' | 'line'

/** 设置里读出来的值可能是任何东西 —— 只有明确写了 line 才是整行，其余一律按原样 */
export function resolveBroadcastMode(configured: unknown): BroadcastMode {
  return configured === 'line' ? 'line' : 'raw'
}

export function getBroadcastMode(): BroadcastMode {
  return resolveBroadcastMode(vscode.workspace.getConfiguration('bastion').get('broadcastMode'))
}

export const BROADCAST_MODE_LABEL: Record<BroadcastMode, string> = {
  raw: '原样同步',
  line: '整行发送'
}

/**
 * 广播要发什么内容；返回 undefined = 这一块不同步。
 *
 * 整行模式的判断依据是攒行器的结果（见 localPath.InputLineTracker）；
 * 原样模式**连回车都要转发** —— 否则在 vim 里敲 `:wq` 之后那个回车过不去，
 * 对面就永远存不了盘（这正是用户要原样同步的原因）。
 */
export function broadcastPayload(
  data: string,
  fed: Pick<FedLine, 'line' | 'multiLine'>,
  mode: BroadcastMode
): string | undefined {
  if (mode === 'raw') return data || undefined
  // 多行粘贴：整块原样同步（本地也是整块发出去的，不能只发第一行）
  if (fed.multiLine) return data
  if (fed.line !== undefined && fed.line.trim()) return `${fed.line}\r`
  return undefined
}
