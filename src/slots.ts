/**
 * 状态栏各槽位的刷新逻辑。
 *
 * 底栏分「常驻」和「临时」两层（见 status.ts），这里负责决定每一格显示什么：
 * 会话概览（常驻）、只读状态、上传覆盖方式、端口转发。
 * 传输进度 / 部署进度 / MFA 由各自的模块直接写槽位。
 */

import * as vscode from 'vscode'
import { setSlot, clearSlot, fmtDuration } from './status'
import { terminals, activeIsBastion, describeSession, getBroadcastTargets, getBroadcastMode, BROADCAST_MODE_LABEL } from './state'
import type { SharedConnection } from './connection'
import type { BastionTerminal } from './terminal'
import { listActiveForwards } from './forward'
import { log } from './log'

/**
 * 可以关掉的「常驻」格子。底栏是稀缺资源，有人嫌挤 —— 允许自己选显示哪几格。
 * 注意：进度类（传输/部署/MFA）**不在此列**，它们是临时反馈，不该被关掉。
 */
export const STATUS_SLOT_KEYS = [
  'session',
  'readonly',
  'overwrite',
  'keepterm',
  'broadcast',
  'broadcastmode',
  'forward'
] as const
export type StatusSlotKey = (typeof STATUS_SLOT_KEYS)[number]

const isSlotKey = (x: unknown): x is StatusSlotKey =>
  typeof x === 'string' && (STATUS_SLOT_KEYS as readonly string[]).includes(x)

/**
 * 状态栏 tooltip 一律用它包一层。
 *
 * 别传纯字符串 —— VS Code 只对 MarkdownString 走 markdown 渲染
 * （工作台里就是 `isMarkdownString(tooltip) ? { markdown: tooltip } : tooltip`），
 * 纯字符串会被原样显示，于是文案里的 `**` 变成用户眼前的两个星号。
 */
function mdTooltip(text: string): vscode.MarkdownString {
  return new vscode.MarkdownString(text)
}

/**
 * 解析设置 `bastion.statusBarItems`，返回要显示的格子集合。
 *
 * 规则（手写设置容易写错，所以容错做在前面）：
 * - 没配过（不是数组）→ **全部显示**
 * - 是数组 → 只显示列出来的那几个，未知名字忽略
 * - 数组非空但**一个合法名字都没有**（典型是拼错）→ 退回全部显示并记日志。
 *   宁可多显示一格，也不因为一个拼写错误把底栏清空、让人以为扩展坏了。
 */
export function resolveStatusSlots(configured: unknown): Set<StatusSlotKey> {
  if (!Array.isArray(configured)) return new Set(STATUS_SLOT_KEYS)
  const valid = configured.filter(isSlotKey)
  if (valid.length === 0 && configured.length > 0) {
    log(`设置 bastion.statusBarItems 里没有合法名字（${JSON.stringify(configured)}）→ 按全部显示处理`)
    return new Set(STATUS_SLOT_KEYS)
  }
  return new Set(valid)
}

/** 当前设置下这一格要不要显示 */
export function isStatusSlotEnabled(name: StatusSlotKey): boolean {
  return resolveStatusSlots(vscode.workspace.getConfiguration('bastion').get('statusBarItems')).has(name)
}

/** 右下角常驻状态：当前几个会话、活动的是谁。点击展开右侧「总览与进度」面板 */
export function updateStatusBar(): void {
  updateOverwriteSlot()
  updateReadOnlySlot()
  updateKeepTerminalSlot()
  updateBroadcastSlot()
  updateBroadcastModeSlot()
  if (!isStatusSlotEnabled('session')) {
    clearSlot('session')
    return
  }
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
  if (rules.length === 0 || !isStatusSlotEnabled('forward')) {
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
  if (terminals.size === 0 || !isStatusSlotEnabled('readonly')) {
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
    tooltip: mdTooltip(
      (on
        ? '当前会话处于**只读模式**：键盘输入被拦截，查看和复制不受影响'
        : '当前会话**可写**（正常输入）') +
        `\n\n**点击打开「总览与进度」面板**（可切换只读）${roList.length > 0 ? `\n\n已开启只读的会话（${roList.length} 个）：\n${roList.map(([vt]) => `- ${vt.name}`).join('\n')}` : ''}\n\n` +
        '只拦人工打字：MFA 输入、AI 执行、部署注入都不受影响'
    ),
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
  if (terminals.size === 0 || !isStatusSlotEnabled('overwrite')) {
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
    tooltip: mdTooltip(
      `上传遇到远端同名文件时：${desc[mode]}\n\n` +
        '**点击打开「总览与进度」面板**（可切换覆盖方式）\n也可在设置里改 bastion.uploadOverwrite'
    ),
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
  if (policy !== 'keep' || !isStatusSlotEnabled('keepterm')) {
    clearSlot('keepterm')
    return
  }
  setSlot('keepterm', {
    text: '$(terminal) 保留终端',
    tooltip: mdTooltip(
      '**部署结束后保留会话窗口**（已开启）\n\n' +
        '跑完不自动关窗口，可以直接翻里面的原始输出 —— 报告虽然记了每条命令的输出，' +
        '但出问题时看现场更直接。\n\n' +
        '**点击关闭**（关掉后：成功的会话自动回收，失败的仍然保留）\n\n' +
        '也可以在设置里改 `bastion.deployTerminalPolicy`。'
    ),
    command: 'bastion.toggleKeepDeployTerminal',
    backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground')
  })
}

/**
 * 「广播输入」的开关槽位。
 *
 * 同「保留终端」：**只在开着时出现** —— 关着是默认行为。开着的时候它必须一直在底栏，
 * 因为广播是「一个窗口敲字、好几个窗口同时执行」，忘了它开着是最危险的情况
 * （在测试机上敲 `rm`，生产机上一样跑）。所以这一格用警告色常驻，点一下就能改/关。
 */
export function updateBroadcastSlot(): void {
  const targets = getBroadcastTargets()
  if (targets.length === 0 || !isStatusSlotEnabled('broadcast')) {
    clearSlot('broadcast')
    return
  }
  const mode = getBroadcastMode()
  const names = [...terminals.entries()]
    .filter(([, t]) => targets.includes(t))
    .map(([vt]) => `- ${vt.name}`)
  setSlot('broadcast', {
    text: `$(broadcast) 广播 ${targets.length} 台`,
    tooltip: mdTooltip(
      `**输入广播中：这 ${targets.length} 个会话会同时收到你的键盘输入**\n\n` +
        (names.length > 0 ? `${names.join('\n')}\n\n` : '') +
        `当前模式：**${BROADCAST_MODE_LABEL[mode]}**（旁边那一格可切换）\n\n` +
        (mode === 'raw'
          ? '原样同步：你敲的每个键都同步过去 —— 进 vim 改文件、走交互式菜单用这个。\n\n'
          : '整行发送：只在按回车时把这一整行同步过去，敲到一半的内容不会发。空回车不同步。\n\n') +
        '只同步人工键盘输入：MFA 动态码、AI 执行、部署注入都**不会**被广播。\n\n' +
        '**点击重新选择 / 全部取消即关闭**（也可以在右侧「总览与进度」面板里逐台勾）'
    ),
    command: 'bastion.toggleBroadcast',
    backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground')
  })
}

/**
 * 广播模式那一格。**只在广播开着时出现** —— 它是广播的从属开关，
 * 广播没开时摆一个「原样同步」在底栏只会让人困惑。
 * 必须常驻可见：原样模式下你在 vim 里敲的每个键都会跑到别的机器上，忘了模式是什么很危险。
 */
export function updateBroadcastModeSlot(): void {
  if (getBroadcastTargets().length === 0 || !isStatusSlotEnabled('broadcastmode')) {
    clearSlot('broadcastmode')
    return
  }
  const mode = getBroadcastMode()
  setSlot('broadcastmode', {
    text: mode === 'raw' ? '$(arrow-swap) 原样同步' : '$(list-ordered) 整行发送',
    tooltip: mdTooltip(
      `**广播模式：${BROADCAST_MODE_LABEL[mode]}**\n\n` +
        (mode === 'raw'
          ? '你敲的每个键都同步给广播组 —— **vim 里改配置文件、进交互式菜单必须用这个**。\n\n' +
            '代价：敲到一半的内容、退格、方向键也会跑过去。'
          : '只在按回车时把整行同步过去，敲到一半的内容不会发；空回车不同步。\n\n' +
            '代价：vim 这类全屏交互程序里没法用（它们不是"一行"）。') +
        '\n\n**点击切换**（也可以在命令面板搜「广播模式」，或点右侧总览面板里的那一项）'
    ),
    command: 'bastion.toggleBroadcastMode'
  })
}

