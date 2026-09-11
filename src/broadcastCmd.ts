/**
 * 命令：多会话广播输入。
 *
 * Electron 版就有这个能力，VS Code 版一直缺。它和「批量部署」是两件事：
 * 部署管的是「跑完一批命令、拿一份报告」，广播管的是「边看边敲、几个窗口同步」——
 * 典型的用法是同一个改动要在测试机和两台生产机上各敲一遍，或者几个会话一起进交互式菜单。
 *
 * 设计上的取舍：
 *   - **只同步人工键盘输入**。MFA 动态码、AI 执行、部署注入都不走广播
 *     （前者的码每台可能不同，后者是脚本化操作、不该被顺手复制到别的机器）。
 *   - **只读会话不进列表**。只读连人工输入都拦，广播更不该往里写。
 *   - **取消勾选全部 = 关闭广播**，不需要再记一个「关闭广播」的命令。
 *   - 开着的时候底栏用警告色常驻（见 slots.updateBroadcastSlot）——
 *     忘了广播开着，在测试机上敲的东西会同时在生产机上跑，这是最危险的情况。
 */

import * as vscode from 'vscode'
import {
  terminals,
  getBroadcastTargets,
  setBroadcastTargets,
  clearBroadcast,
  getBroadcastMode,
  BROADCAST_MODE_LABEL,
  type BroadcastMode
} from './state'
import type { BastionTerminal } from './terminal'
import { updateStatusBar } from './slots'
import { log } from './log'

/** 一行候选会话。抽成普通对象是为了能脱离真终端做单测 */
export interface BroadcastRow {
  /** VS Code 终端名（通常已经是 `#3 10.0.0.1` 这种） */
  name: string
  /** 会话号；0 表示还没分配（连接中） */
  sessionNo: number
  readOnly: boolean
  term: BastionTerminal
}

export interface BroadcastPickItem extends vscode.QuickPickItem {
  term: BastionTerminal
  picked: boolean
}

/** 列表里显示的名字：会话号统一用 `#n`，并去掉终端名里重复的那一段 */
export function broadcastItemLabel(row: Pick<BroadcastRow, 'name' | 'sessionNo'>): string {
  const tag = row.sessionNo > 0 ? `#${row.sessionNo}` : '#?'
  return `${tag} ${row.name.replace(/^#\d+\s*/, '')}`
}

/** 可参与广播的会话：只读的排除掉 */
export function filterBroadcastRows(rows: BroadcastRow[]): BroadcastRow[] {
  return rows.filter((r) => !r.readOnly)
}

/** 构造多选列表，勾选状态 = 当前正在广播的目标 */
export function buildBroadcastItems(rows: BroadcastRow[], targets: BastionTerminal[]): BroadcastPickItem[] {
  return rows.map((r) => ({
    term: r.term,
    picked: targets.includes(r.term),
    label: broadcastItemLabel(r)
  }))
}

/** 多选结果 → 新的广播目标（去重；空数组表示关闭广播） */
export function nextBroadcastTargets(picked: BastionTerminal[]): BastionTerminal[] {
  return [...new Set(picked)]
}

/**
 * 命令：切换广播模式（原样同步 ⇄ 整行发送）。
 *
 * 为什么要有快捷键式的切换：这两种模式是**按场景**换的 ——
 * 批量敲命令时想要整行（不打扰对面），进 vim 改配置时必须原样（不然方向键、模式切换全废）。
 * 藏在设置里等于每次都要开设置面板，所以做成一个命令 + 底栏一格可点的开关。
 */
export async function toggleBroadcastMode(): Promise<void> {
  const cur = getBroadcastMode()
  const next: BroadcastMode = cur === 'raw' ? 'line' : 'raw'
  await vscode.workspace.getConfiguration('bastion').update('broadcastMode', next, vscode.ConfigurationTarget.Global)
  log(`广播模式：${BROADCAST_MODE_LABEL[next]}（${next}）`)
  updateStatusBar()
  void vscode.window.showInformationMessage(
    next === 'raw'
      ? '广播模式：原样同步 —— 你敲的每个键都会同步过去（进 vim 改文件、走交互式菜单用这个）'
      : '广播模式：整行发送 —— 只在按回车时把这一整行同步过去（批量敲命令用这个）'
  )
}

/**
 * 命令入口。没参数、没状态：打开一次多选，确认即生效。
 * 少于两个可写会话时不给开 —— 广播给自己没有意义，只会让人以为广播坏了。
 */
export async function toggleBroadcast(): Promise<void> {
  const all = [...terminals.entries()]
  if (all.length === 0) {
    void vscode.window.showInformationMessage('还没有堡垒机会话，先连接一个再开广播输入。')
    return
  }
  const rows: BroadcastRow[] = all.map(([vt, term]) => ({
    name: vt.name,
    sessionNo: term.sessionNo,
    readOnly: term.isReadOnly,
    term
  }))
  const candidates = filterBroadcastRows(rows)
  const skipped = rows.length - candidates.length
  if (candidates.length < 2) {
    void vscode.window.showInformationMessage(
      skipped > 0
        ? `可写会话只有 ${candidates.length} 个（另有 ${skipped} 个只读会话不参与广播），至少要两个才能广播输入。`
        : '广播输入至少要两个会话：先在侧边栏多连几个，再来开。'
    )
    return
  }

  const current = getBroadcastTargets()
  const items = buildBroadcastItems(candidates, current)
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: '广播输入：把键盘输入同时发给哪些会话？',
    placeHolder:
      current.length > 0
        ? `当前正在广播 ${current.length} 个会话；全部取消勾选并回车 = 关闭广播`
        : '勾选要同步的会话。**回车诱发**：只有你按回车的那一整行会同步过去' +
          (skipped > 0 ? `（已跳过 ${skipped} 个只读会话）` : '')
  })
  // 取消（Esc）= 什么都不改：这个命令同时也用来「看一眼现在广播到哪几台了」
  if (!picked) return

  const next = nextBroadcastTargets(picked.map((i) => i.term))
  if (next.length === 0) {
    clearBroadcast()
    log('广播输入：已关闭')
    void vscode.window.showInformationMessage('已关闭广播输入：键盘输入只发给当前会话。')
  } else {
    setBroadcastTargets(next)
    log(`广播输入：${next.length} 个会话（${picked.map((i) => i.label).join('、')}）`)
    void vscode.window.showInformationMessage(
      `广播输入已开启：${next.length} 个会话会同时收到你敲的命令（底栏「广播」可随时改/关）。`
    )
  }
  updateStatusBar()
}
