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
