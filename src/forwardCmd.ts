/**
 * 端口转发的界面命令。
 *
 * 注意「全部停止」的入口刻意放在视图标题栏（并且要确认），
 * 不放状态栏 —— 状态栏那一条点一下就全停，太容易误触。
 */

import * as vscode from 'vscode'
import type { ForwardRuleItem } from './forward'
import { getForwardRules, saveForwardRules, newForwardRuleId, startForward, stopForward, listActiveForwards, stopAllForwards, type ForwardRule } from './forward'
import { getProfiles } from './profiles'
import { log } from './log'
import { ctx, forwardProvider } from './state'
import { updateForwardSlot } from './slots'
import { ensureConnection } from './sessions'

/** 显式「聚焦端口转发视图」：状态栏转发槽位点击走这里（不再直接全停） */
export async function showForwards(): Promise<void> {
  try {
    await vscode.commands.executeCommand('bastion.forwards.focus')
  } catch (e) {
    log(`聚焦端口转发视图失败: ${(e as Error).message}`)
  }
}

/** 命令：停止所有端口转发（入口在「端口转发」视图标题栏，不在状态栏） */
export async function stopAllForwardsCommand(): Promise<void> {
  const rules = listActiveForwards()
  if (rules.length === 0) {
    vscode.window.showInformationMessage('当前没有运行中的端口转发')
    return
  }
  // 这是「一次干掉所有隧道」，误点代价大 → 必须确认，并把要停的列清楚
  const confirm = await vscode.window.showWarningMessage(
    `停止全部 ${rules.length} 条端口转发？\n\n` +
      rules.map((r) => `· ${r.label}：${r.localHost}:${r.localPort} → ${r.remoteHost}:${r.remotePort}`).join('\n'),
    { modal: true },
    '全部停止'
  )
  if (confirm !== '全部停止') return
  const n = stopAllForwards()
  forwardProvider.refresh()
  updateForwardSlot()
  log(`已停止全部端口转发（${n} 条）`)
  vscode.window.showInformationMessage(`已停止 ${n} 条端口转发`)
}

export async function addForwardRule(): Promise<void> {
  const profiles = getProfiles(ctx)
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('请先创建连接档案')
    return
  }
  const profilePick = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.name, description: `${p.username}@${p.host}`, profile: p })),
    { placeHolder: '选择堡垒机档案' }
  )
  if (!profilePick) return
  const label = await vscode.window.showInputBox({ prompt: '规则名称（标签）', placeHolder: '转发 MySQL' })
  if (!label) return
  const localPortStr = await vscode.window.showInputBox({ prompt: '本地端口', placeHolder: '13306' })
  if (!localPortStr) return
  const localPort = parseInt(localPortStr, 10) || 0
  const remoteHost = await vscode.window.showInputBox({ prompt: '远端主机（服务器可达的地址）', value: '127.0.0.1' })
  if (!remoteHost) return
  const remotePortStr = await vscode.window.showInputBox({ prompt: '远端端口', placeHolder: '3306' })
  if (!remotePortStr) return
  const remotePort = parseInt(remotePortStr, 10) || 0

  const rule: ForwardRule = {
    id: newForwardRuleId(),
    profileId: profilePick.profile.name,
    label,
    localHost: '127.0.0.1',
    localPort,
    remoteHost,
    remotePort
  }
  const rules = getForwardRules(ctx)
  rules.push(rule)
  saveForwardRules(ctx, rules)
  forwardProvider.refresh()
}

export async function startForwardRule(item?: ForwardRuleItem): Promise<void> {
  const rule = item?.rule
  if (!rule) return
  const profile = getProfiles(ctx).find((p) => p.name === rule.profileId)
  if (!profile) {
    vscode.window.showErrorMessage(`找不到堡垒机档案「${rule.profileId}」`)
    return
  }
  const conn = await ensureConnection(profile)
  if (!conn) return
  try {
    await startForward(conn, rule)
    forwardProvider.refresh()
    updateForwardSlot()
    vscode.window.showInformationMessage(`转发已启动：${rule.localHost}:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`)
  } catch (e) {
    vscode.window.showErrorMessage(`启动转发失败: ${(e as Error).message}`)
  }
}

export function stopForwardRule(item?: ForwardRuleItem): void {
  const rule = item?.rule
  if (!rule) return
  stopForward(rule.id)
  forwardProvider.refresh()
  updateForwardSlot()
}

export async function deleteForwardRule(item?: ForwardRuleItem): Promise<void> {
  const rule = item?.rule
  if (!rule) return
  const confirm = await vscode.window.showWarningMessage(`删除转发规则「${rule.label}」？`, { modal: true }, '删除')
  if (confirm !== '删除') return
  stopForward(rule.id)
  const rules = getForwardRules(ctx).filter((r) => r.id !== rule.id)
  saveForwardRules(ctx, rules)
  forwardProvider.refresh()
}

// ---- 档案 ----

