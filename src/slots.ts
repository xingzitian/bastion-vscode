/**
 * 状态栏各槽位的刷新逻辑。
 *
 * 底栏分「常驻」和「临时」两层（见 status.ts），这里负责决定每一格显示什么：
 * 会话概览（常驻）、只读状态、上传覆盖方式、端口转发。
 * 传输进度 / 部署进度 / MFA 由各自的模块直接写槽位。
 */

import * as vscode from 'vscode'
import { setSlot, clearSlot, fmtDuration } from './status'
import { terminals, activeIsBastion, describeSession } from './state'
import type { SharedConnection } from './connection'
import type { BastionTerminal } from './terminal'
import { listActiveForwards } from './forward'

/** 右下角常驻状态：当前几个会话、活动的是谁。点击展开右侧「总览与进度」面板 */
export function updateStatusBar(): void {
  updateOverwriteSlot()
  updateReadOnlySlot()
  updateKeepTerminalSlot()
  const n = terminals.size
  if (n === 0) {
    setSlot('session', {
      text: '$(plug) Bastion 未连接',
      tooltip: '点击连接堡垒机',
      command: 'bastion.connect'
    })
    return
  }
  const activeVt = vscode.window.activeTerminal
  const active = activeVt ? terminals.get(activeVt) : undefined

  // 按底层连接分组：一条连接复用几个会话，一眼看得出
  const byConn = new Map<SharedConnection, Array<[vscode.Terminal, BastionTerminal]>>()
  for (const [vt, t] of terminals) {
    const list = byConn.get(t.conn) ?? []
    list.push([vt, t])
    byConn.set(t.conn, list)
  }
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**BastionShell 会话（${n} 个）**\n\n`)
  if (!active) md.appendMarkdown(`_当前焦点不在堡垒机终端：右键上传不可用_\n\n`)
  for (const [conn, list] of byConn) {
    const age = conn.connectedAt > 0 ? fmtDuration(Date.now() - conn.connectedAt) : '连接中'
    const state = conn.isAlive ? '🟢 已认证' : '⛔ 已断开'
    md.appendMarkdown(`**${conn.profile.name}** · ${conn.profile.username}@${conn.profile.host} · ${state} · 已连 ${age} · 复用 ${conn.channelCount} 会话\n\n`)
    for (const [vt, t] of list) {
      const here = vt === activeVt ? ' ← 当前' : ''
      md.appendMarkdown(`- ${describeSession(vt, t)}${here}\n`)
    }
    md.appendMarkdown('\n')
  }
  md.appendMarkdown('**点击打开「总览与进度」面板**（在里面切换会话、连接、看进度）')

  setSlot('session', {
    text: `$(terminal-bash) Bastion ${n} 会话`,
    tooltip: md,
    command: 'bastion.showOverview',
    backgroundColor: active ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground')
  })
}

/**
 * 转发槽位：有隧道在跑才出现。
 * 点击只「打开端口转发视图」——以前这里点一下就全部停止，
 * 结果用户不知道这是什么、点完隧道全没了。破坏性操作不该放在最容易误点的地方。
 */
export function updateForwardSlot(): void {
  const rules = listActiveForwards()
  if (rules.length === 0) {
    clearSlot('forward')
    return
  }
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**运行中的端口转发（${rules.length} 条）**\n\n`)
  for (const r of rules) {
    md.appendMarkdown(`- **${r.label}**：\`${r.localHost}:${r.localPort}\` → \`${r.remoteHost}:${r.remotePort}\`\n`)
    md.appendMarkdown(`  - 档案：${r.profileId}\n`)
  }
  md.appendMarkdown('\n**点击打开「总览与进度」面板**（每条隧道都有停止按钮）')
  setSlot('forward', {
    text: `$(radio-tower) 转发 ${rules.length} 条`,
    tooltip: md,
    command: 'bastion.showOverview'
  })
}

/** 只读槽位：有会话时一直显示，写清「可写 / 只读」，点击切换（之前只在已只读时才出现，根本找不到） */
export function updateReadOnlySlot(): void {
  if (terminals.size === 0) {
    clearSlot('readonly')
    return
  }
  const activeVt = vscode.window.activeTerminal
  const active = activeVt ? terminals.get(activeVt) : undefined
  const target = active ?? [...terminals.values()].pop()
  const roList = [...terminals.entries()].filter(([, t]) => t.isReadOnly)
  const on = target?.isReadOnly ?? false

  setSlot('readonly', {
    text: on ? `$(lock) 只读` : `$(unlock) 可写`,
    tooltip:
      (on
        ? '当前会话处于**只读模式**：键盘输入被拦截，查看和复制不受影响'
        : '当前会话**可写**（正常输入）') +
      `\n\n**点击打开「总览与进度」面板**（可切换只读）${roList.length > 0 ? `\n\n已开启只读的会话（${roList.length} 个）：\n${roList.map(([vt]) => `- ${vt.name}`).join('\n')}` : ''}\n\n` +
      '只拦人工打字：MFA 输入、AI 执行、部署注入都不受影响',
    command: 'bastion.showOverview',
    backgroundColor: on ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  })
}

/** 上传覆盖方式的可读名 */
export const OVERWRITE_LABEL: Record<string, string> = {
  skip: '跳过',
  overwrite: '覆盖',
  rename: '改名'
}

/** 覆盖方式槽位：有会话时一直显示，点击切换（跳过 / 覆盖 / 改名） */
export function updateOverwriteSlot(): void {
  if (terminals.size === 0) {
    clearSlot('overwrite')
    return
  }
  const mode = getOverwriteMode()
  const desc: Record<string, string> = {
    skip: '远端已有同名文件就跳过，不覆盖',
    overwrite: '直接覆盖远端同名文件（rz -y）',
    rename: '远端自动改名保留旧文件（rz -E）'
  }
  setSlot('overwrite', {
    text: `$(cloud-upload) 同名:${OVERWRITE_LABEL[mode]}`,
    tooltip:
      `上传遇到远端同名文件时：${desc[mode]}\n\n` +
      '**点击打开「总览与进度」面板**（可切换覆盖方式）\n也可在设置里改 bastion.uploadOverwrite',
    command: 'bastion.showOverview'
  })
}

export function getOverwriteMode(): string {
  const raw = vscode.workspace.getConfiguration('bastion').get<string>('uploadOverwrite', 'skip')
  return raw === 'overwrite' || raw === 'rename' ? raw : 'skip'
}

/**
 * 「部署完保留终端」的开关槽位。
 *
 * **只在打开时出现** —— 关着是默认行为，不需要占一格；打开时它一直在底栏，
 * 一眼就知道「现在跑任务不会自动关窗口」，而且点一下就能关掉。
 * 以前这个能力只藏在设置里（bastion.deployTerminalPolicy），用户找不到，
 * 于是每次都看着终端被关掉、报告又是空的，还以为任务成功就等于没输出。
 */
export function updateKeepTerminalSlot(): void {
  const policy = vscode.workspace.getConfiguration('bastion').get<string>('deployTerminalPolicy', 'closeSuccess')
  if (policy !== 'keep') {
    clearSlot('keepterm')
    return
  }
  setSlot('keepterm', {
    text: '$(terminal) 保留终端',
    tooltip:
      '**部署结束后保留会话窗口**（已开启）\n\n' +
      '跑完不自动关窗口，可以直接翻里面的原始输出 —— 报告虽然记了每条命令的输出，' +
      '但出问题时看现场更直接。\n\n' +
      '**点击关闭**（关掉后：成功的会话自动回收，失败的仍然保留）\n\n' +
      '也可以在设置里改 `bastion.deployTerminalPolicy`。',
    command: 'bastion.toggleKeepDeployTerminal',
    backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground')
  })
}

