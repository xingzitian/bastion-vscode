/**
 * 「把终端内容发给 AI」：选中一段文字、或最近若干行输出，一键送进 AI 聊天。
 *
 * 难点在拿选中内容 —— VS Code 没有读终端选区的公开 API（microsoft/vscode#188173），
 * 只能借剪贴板：清空 → 调内置「复制终端选中」→ 读回 → 把原剪贴板还回去。
 */

import * as vscode from 'vscode'
import { log } from './log'
import { terminals, lastBastionTerminal, sleep, activeSession } from './state'

/**
 * 读取堡垒机终端里当前选中的文字。
 *
 * VS Code 至今没有公开 API 能拿终端选区（microsoft/vscode#188173），
 * 唯一可靠的办法是借剪贴板：先清空 → 调内置「复制终端选中」→ 读回 → 把原剪贴板还回去。
 * 读回为空 = 终端里没有选中内容。
 */
export async function readTerminalSelection(): Promise<string> {
  const backup = await vscode.env.clipboard.readText()
  await vscode.env.clipboard.writeText('')
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection')
  } catch (e) {
    log(`复制终端选中内容失败: ${(e as Error).message}`)
  }
  // 复制是异步落到剪贴板的，给它一点时间；没有选区时剪贴板会一直是空的
  let sel = ''
  for (let i = 0; i < 3; i++) {
    sel = await vscode.env.clipboard.readText()
    if (sel) break
    await sleep(60)
  }
  // 选中的字已经拿到手，把用户原来的剪贴板还回去，不留副作用
  await vscode.env.clipboard.writeText(backup)
  return sel
}

/** 把一段文本发到 VS Code 内置的 AI 聊天 */
export async function sendTextToAIChat(text: string, title: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('bastion')
  const insertOnly = cfg.get<string>('sendToAiMode', 'insert') !== 'send'
  const query = `${title}\n\`\`\`\n${text}\n\`\`\``
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: insertOnly })
    log(`已发送到 AI 聊天（${insertOnly ? '填入输入框' : '直接发送'}，${text.length} 字符）`)
  } catch (e) {
    // 没装 / 没启用 AI 聊天（例如没登录 Copilot）时兜底：复制到剪贴板，让人自己贴
    log(`打开 AI 聊天失败: ${(e as Error).message}`)
    await vscode.env.clipboard.writeText(text)
    vscode.window.showInformationMessage('当前 VS Code 没有可用的 AI 聊天，已把内容复制到剪贴板')
  }
}

/** 命令：把终端里选中的文字一键发给 AI（对应编辑器里的「选中内容发给 AI」） */
export async function sendSelectionToAI(): Promise<void> {
  const sel = await readTerminalSelection()
  if (!sel.trim()) {
    vscode.window.showWarningMessage('终端里没有选中文字：先在堡垒机终端里选中要发的内容，再按快捷键')
    return
  }
  const name = vscode.window.activeTerminal?.name ?? '终端'
  await sendTextToAIChat(sel, `以下是堡垒机终端「${name}」里我选中的内容，请帮我分析：`)
}

/** 命令：把终端最近的输出一键发给 AI（没选中东西时用这个） */
export async function sendTailToAI(): Promise<void> {
  const s = activeSession()
  if (!s) {
    vscode.window.showWarningMessage('没有活动的堡垒机会话')
    return
  }
  const raw = vscode.workspace.getConfiguration('bastion').get<number>('tailLines', 80)
  const lines = Math.max(1, Math.min(1000, Number(raw) || 80))
  const text = s.term.getTail(lines)
  if (!text.trim()) {
    vscode.window.showInformationMessage('这个会话还没有输出')
    return
  }
  await sendTextToAIChat(text, `以下是堡垒机终端「${s.vt.name}」最近 ${lines} 行的输出，请帮我分析：`)
}

