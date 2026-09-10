/** 传输历史与上传的界面命令。 */


import * as vscode from 'vscode'
import * as fs from 'fs'
import { TransferItem, getTransferHistory, clearTransferHistory } from './transfer'
import { log } from './log'
import { terminals, activeIsBastion, lastBastionTerminal, activeSession, transferProvider } from './state'

/** 命令：把「传输历史」视图切到前台 */
export async function showTransferHistory(): Promise<void> {
  try {
    await vscode.commands.executeCommand('bastion.transfers.focus')
  } catch (e) {
    log(`聚焦传输历史视图失败: ${(e as Error).message}`)
  }
}

/** 命令：重试一条失败的上传（把原文件再传一遍到当前活动会话） */
export async function retryTransfer(item?: TransferItem): Promise<void> {
  const rec = item?.rec
  const paths = rec?.retryPaths
  if (!rec || !paths || paths.length === 0) {
    vscode.window.showWarningMessage('这条记录没有可重试的本地文件（下载重试需要远端原始命令，暂不支持）')
    return
  }
  const missing = paths.filter((p) => !fs.existsSync(p))
  if (missing.length > 0) {
    vscode.window.showErrorMessage(`本地文件已不存在，无法重试：${missing.join('、')}`)
    return
  }
  const s = activeSession()
  if (!s) {
    vscode.window.showWarningMessage('没有活动的堡垒机会话：请先连上目标机再重试')
    return
  }
  s.vt.show()
  transferProvider.refresh()
  await s.term.upload(paths)
}

/** 命令：在系统文件管理器里定位这个传输的本地文件 */
export async function revealTransferItem(item?: TransferItem): Promise<void> {
  const p = item?.rec.localPath
  if (!p) {
    vscode.window.showWarningMessage('这条记录没有本地文件路径')
    return
  }
  if (!fs.existsSync(p)) {
    vscode.window.showWarningMessage(`文件已不在了：${p}`)
    return
  }
  // 用 VS Code 内置命令，跨平台都能在资源管理器/Finder 里定位
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p))
}

/** 命令：复制这条传输的本地路径 */
export async function copyTransferPath(item?: TransferItem): Promise<void> {
  const p = item?.rec.localPath
  if (!p) {
    vscode.window.showWarningMessage('这条记录没有本地文件路径')
    return
  }
  await vscode.env.clipboard.writeText(p)
  vscode.window.setStatusBarMessage(`$(clippy) 已复制路径：${p}`, 4000)
}

export async function clearTransferHistoryCommand(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage('清空传输历史？', { modal: true }, '清空')
  if (confirm !== '清空') return
  clearTransferHistory()
}

export async function uploadToSession(uri?: vscode.Uri): Promise<void> {
  const vt = vscode.window.activeTerminal
  const term = vt ? terminals.get(vt) : undefined
  if (!term || !activeIsBastion) {
    vscode.window.showWarningMessage('请先聚焦堡垒机终端，再上传（当前焦点不在终端内）')
    return
  }
  let paths: string[] = []
  if (uri) {
    paths = [uri.fsPath]
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: true,
      openLabel: '选择要上传的文件'
    })
    paths = (uris ?? []).map((u) => u.fsPath)
  }
  if (paths.length === 0) return
  await term.upload(paths)
}

// ---- AI 桥接：bastion.exec 远程执行 ----

