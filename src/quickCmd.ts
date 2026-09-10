/**
 * 快捷命令的界面命令：新建 / 发送 / 删除 / 打开配置文件。
 * 发送前会过高危命令确认（一点就发、默认还自动回车，最容易被误触）。
 */

import * as vscode from 'vscode'
import * as path from 'path'
import {
  QuickCommandItem, getQuickCommands, saveQuickCommands, newQuickCommandId,
  resolveQuickCommand, ensureQuickCommandsFile, QUICK_COMMANDS_FILE
} from './quickCommands'
import { findDangerous, describeDanger } from './danger'
import { getDangerRules } from './dangerConfig'
import { configDir } from './config'
import { log } from './log'
import { ctx, terminals, quickCommandsProvider } from './state'

export async function addQuickCommand(): Promise<void> {
  const label = await vscode.window.showInputBox({ prompt: '快捷命令名称（显示标签）', placeHolder: '重启服务' })
  if (!label) return
  const command = await vscode.window.showInputBox({ prompt: '要发送的命令（多行命令建议改配置文件用数组写法）', placeHolder: 'systemctl restart xxx' })
  if (!command) return
  const cmds = getQuickCommands(ctx)
  cmds.push({ id: newQuickCommandId(), label, command })
  saveQuickCommands(cmds)
  quickCommandsProvider.refresh()
  // 长命令/多行命令用向导填很别扭，顺手提示有更好的维护方式
  const more = await vscode.window.showInformationMessage('已添加。命令较长或想自己维护？直接编辑配置文件更省事（支持多行和外部 .sh 文件）', '打开配置文件')
  if (more === '打开配置文件') await openQuickCommandsFile()
}

export async function sendQuickCommand(item?: QuickCommandItem): Promise<void> {
  if (!item?.cmd) return
  const vt = vscode.window.activeTerminal
  const term = vt ? terminals.get(vt) : undefined
  if (!term) {
    vscode.window.showWarningMessage('当前激活的终端不是堡垒机会话')
    return
  }
  let text: string
  try {
    text = resolveQuickCommand(item.cmd)
  } catch (e) {
    const msg = (e as Error).message
    log(`快捷命令解析失败: ${msg}`)
    vscode.window.showErrorMessage(msg)
    return
  }
  if (!text.trim()) {
    vscode.window.showWarningMessage(`快捷命令「${item.cmd.label}」内容是空的`)
    return
  }
  // 高危操作先确认再发。快捷命令是「一点就发」，最容易被误点，
  // 而且 sentEnter 默认自动回车 —— 发出去就执行了，没有反悔余地。
  const hits = findDangerous(text, getDangerRules())
  if (hits.length > 0) {
    log(`快捷命令「${item.cmd.label}」命中高危命令：${describeDanger(hits)}`)
    const pick = await vscode.window.showWarningMessage(
      `快捷命令「${item.cmd.label}」包含高危操作，确认要发送吗？\n\n${describeDanger(hits)}`,
      { modal: true },
      '仍然发送'
    )
    if (pick !== '仍然发送') {
      log(`快捷命令「${item.cmd.label}」被取消（高危未确认）`)
      return
    }
  }
  // sendEnter === false 时只把命令打进终端，让人确认后再自己回车
  const enter = item.cmd.sendEnter === false ? '' : '\r'
  await term.write(text.replace(/\r\n/g, '\n') + enter)
  log(`已发送快捷命令「${item.cmd.label}」（${text.length} 字符${enter ? '' : '，未回车'}）`)
}

export async function deleteQuickCommand(item?: QuickCommandItem): Promise<void> {
  if (!item?.cmd) return
  const cmds = getQuickCommands(ctx).filter((c) => c.id !== item.cmd.id)
  saveQuickCommands(cmds)
  quickCommandsProvider.refresh()
}

// ---- 端口转发 ----

/**
 * 打开快捷命令配置文件。
 * 首次打开会建一份带中文说明 + 三个示例（短命令 / 多行数组 / 外部 .sh）的模板，
 * 这样「长命令自己维护」这件事不用先看文档就知道怎么写。
 */
export async function openQuickCommandsFile(): Promise<void> {
  ensureQuickCommandsFile()
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(configDir(), QUICK_COMMANDS_FILE)))
}

