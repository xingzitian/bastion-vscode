/** 配置文件入口与其它零散命令：打开习惯/快捷命令/高危规则文件、打开日志、切换上传覆盖方式。 */


import * as vscode from 'vscode'
import * as path from 'path'
import { configDir, ensureJsonFile } from './config'
import { HABITS_FILE, HABITS_HEADER, HABITS_TEMPLATE } from './habits'
import { ensureQuickCommandsFile, QUICK_COMMANDS_FILE } from './quickCommands'
import { openDangerRulesFile } from './dangerConfig'
import { log, outChannel } from './log'
import { updateOverwriteSlot, getOverwriteMode, OVERWRITE_LABEL } from './slots'

/** 打开一个配置文件（不存在则用带中文说明的模板创建） */
export function openConfigFile(file: string, header: string, initial: unknown = []): void {
  ensureJsonFile(file, header, initial)
  void vscode.window.showTextDocument(vscode.Uri.file(path.join(configDir(), file)))
}

/** 打开个人习惯配置文件（提权方式 / 常用目录 / 口头习惯） */
export function openHabitsFile(): void {
  openConfigFile(HABITS_FILE, HABITS_HEADER, HABITS_TEMPLATE)
}

/** 打开高危命令规则文件（内置规则能关、也能加自己那套） */
export function openDangerRules(): void {
  void openDangerRulesFile()
}

/** 命令：打开 BastionShell 日志通道（诊断菜单导航、部署、传输时最常用） */
export function showLog(): void {
  outChannel().show()
  log('—— 打开了日志通道 ——')
}

/** 命令：点状态栏切换上传覆盖方式 */
export async function pickOverwriteMode(): Promise<void> {
  log('状态栏点击：切换上传覆盖方式')
  const cur = getOverwriteMode()
  const options = [
    { mode: 'skip', name: '跳过', desc: '远端有同名文件就不传（最安全，默认）' },
    { mode: 'overwrite', name: '覆盖', desc: '直接覆盖远端同名文件（rz -y）' },
    { mode: 'rename', name: '改名', desc: '远端自动改名保留旧文件（rz -E）' }
  ]
  const pick = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: `${o.mode === cur ? '$(check) ' : ''}${o.name}`,
      description: o.desc,
      mode: o.mode
    })),
    { placeHolder: `上传遇到远端同名文件时怎么办（当前：${OVERWRITE_LABEL[cur]}）` }
  )
  if (!pick) return
  await vscode.workspace
    .getConfiguration('bastion')
    .update('uploadOverwrite', pick.mode, vscode.ConfigurationTarget.Global)
  updateOverwriteSlot()
  log(`上传覆盖方式已改为 ${pick.mode}`)
  vscode.window.setStatusBarMessage(`$(cloud-upload) 上传同名文件：${OVERWRITE_LABEL[pick.mode]}`, 4000)
}

