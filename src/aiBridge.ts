/**
 * AI 桥接：让运行在 VS Code 里的 AI 能在堡垒机服务器上执行命令。
 *
 * 除了语言模型工具（在 extension.ts 里注册），还包括不支持 LM 工具的 AI 用的
 * 文件桥（<工作区>/.vscode/bastion-command.txt → bastion-last-output.txt）。
 */

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BastionTerminal, stripAnsi } from './terminal'
import { getProfiles } from './profiles'
import { getHabits, resolvePrivilege, habitsForAI } from './habits'
import { isWaitingForPassword, resolvePasswordPrompts } from './recognize'
import { log } from './log'
import { ctx, terminals, lastBastionTerminal } from './state'
import { ensureConnection, openTerminal, openSessionToHost } from './sessions'

export function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined
}

export function bridgeFilePath(fileName: string): string {
  const root = workspaceRoot()
  if (root) {
    const dir = path.join(root, '.vscode')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      log(`创建 .vscode 目录失败: ${(e as Error).message}`)
    }
    return path.join(dir, fileName)
  }
  return path.join(os.tmpdir(), fileName)
}

export function readCommandFile(): string {
  try {
    return fs.readFileSync(bridgeFilePath('bastion-command.txt'), 'utf8').trim()
  } catch {
    return ''
  }
}

export function writeOutputFile(output: string): void {
  try {
    fs.writeFileSync(bridgeFilePath('bastion-last-output.txt'), output, 'utf8')
  } catch (e) {
    log(`写入桥接输出文件失败: ${(e as Error).message}`)
  }
}

/**
 * bastion.exec：在活动堡垒机会话上执行远程命令并回传输出。
 * - 命令来源：命令参数（AI 的 run_vscode_command 传 args）或 .vscode/bastion-command.txt
 * - 输出回传：返回值 + 写入 .vscode/bastion-last-output.txt（AI 读文件兜底）
 * - 人在终端里实时看到命令与输出
 */
export async function execRemote(arg?: string | { command?: string; terminal?: string }): Promise<string> {
  const input = typeof arg === 'string' ? { command: arg } : (arg ?? {})
  let command = input.command ?? ''
  if (!command) command = readCommandFile()
  if (!command.trim()) {
    const msg = '没有命令：请传 command 参数，或把命令写入 .vscode/bastion-command.txt'
    vscode.window.showWarningMessage(msg)
    return msg
  }

  // 按终端名找目标会话；没指定则用活动/最近会话
  const terminalName = input.terminal ?? ''
  let term: BastionTerminal | undefined
  if (terminalName) {
    for (const [vt, t] of terminals) {
      if (vt.name === terminalName || vt.name.includes(terminalName)) {
        term = t
        break
      }
    }
  }
  if (!term) {
    const vt = vscode.window.activeTerminal
    term = vt ? terminals.get(vt) : undefined
  }
  if (!term) term = lastBastionTerminal ?? undefined
  if (!term) {
    const msg = '没有活动堡垒机会话，请先用 BastionShell 连接'
    vscode.window.showErrorMessage(msg)
    writeOutputFile(msg)
    return msg
  }

  // 提权习惯决定两件事：要不要给 sudo 命令加哨兵标记（免密才敢加），以及弹密码提示时怎么提示 AI
  const profileName = term.profile?.name
  const privilege = resolvePrivilege(getHabits(), profileName)
  const output = await term.exec(command, { allowPlainSudo: privilege === 'sudo' })

  let finalOutput = output
  if (isSudoPasswordPrompt(command, output)) {
    finalOutput += '\n\n[⚠️ sudo 密码交互] 命令正在等待密码输入。请让用户到堡垒机终端里手动输入密码完成认证（终端已聚焦）；用户确认认证完成后再继续执行后续特权命令。'
    if (privilege === 'sudo') {
      finalOutput += `\n[习惯与实际不符] 习惯文件里「${profileName ?? '全局'}」记的是 sudo（免密），但实际弹了密码提示。等用户输完密码完成认证后，请用 bastion_habits 把该档案的 privilege 改成 sudo-i，并用 remember 记下这台机器真实的提权做法。`
    } else if (privilege === 'ask') {
      finalOutput += `\n[还没记录习惯]「${profileName ?? '全局'}」没有提权习惯记录。等用户这次认证完，请用 bastion_habits 的 setPrivilege / remember 把结论记下来，以后就不用再问了。`
    }
  }
  writeOutputFile(finalOutput)
  return finalOutput
}

/** 拼给 AI 的习惯附注：连接/列档案时一并返回，省得 AI 每次都问同样的问题 */
export function habitNote(profileName?: string): string {
  return `\n\n—— 这台机器的个人习惯（BastionShell 记录，勿重复询问）——\n${habitsForAI(profileName)}`
}

/** bastion_connect 工具：连接档案（直接 SSH 直接进 shell；堡垒机模式过菜单选目标机） */
export async function connectToTarget(input?: { profile?: string; host?: string; userChoice?: string }): Promise<string> {
  const profileName = input?.profile ?? ''
  const host = input?.host ?? ''
  if (!profileName) {
    return '错误：需要 profile（档案名）参数'
  }
  const profile = getProfiles(ctx).find((p) => p.name === profileName)
  if (!profile) {
    return `找不到档案「${profileName}」，请先在侧边栏「连接档案」里创建`
  }
  const conn = await ensureConnection(profile)
  if (!conn) {
    return `连接「${profileName}」失败`
  }
  if (profile.mode === 'direct') {
    const { vt } = openTerminal(conn, profile, `${profile.username}@${profile.host}`)
    vt.show()
    return `已直接连接 ${profile.username}@${profile.host}，终端名 ${profile.username}@${profile.host}。之后用 bastion_exec 在这台机器上执行命令。${habitNote(profileName)}`
  }
  if (!host) {
    return '堡垒机模式需要 host（目标机器 IP）参数'
  }
  await openSessionToHost(conn, profile, host, input?.userChoice ?? '1')
  return `已连接到目标 ${host}，终端名 ${profile.username}@${host}。之后用 bastion_exec 在这台机器上执行命令。${habitNote(profileName)}`
}

/** bastion_listSessions 工具：列出当前堡垒机会话终端名 */
export function listSessions(): string {
  const names = [...terminals.keys()].map((vt) => vt.name)
  if (names.length === 0) {
    return '没有活动堡垒机会话'
  }
  return `当前堡垒机会话（${names.length} 个）：\n` + names.map((n) => `- ${n}`).join('\n')
}

/** bastion_listProfiles 工具：列出堡垒机连接档案 */
export function listProfilesForAI(): string {
  const profiles = getProfiles(ctx)
  if (profiles.length === 0) {
    return '没有连接档案，请先在侧边栏「连接档案」创建'
  }
  const h = getHabits()
  return `可用的连接档案（${profiles.length} 个）：\n` +
    profiles
      .map((p) => `- ${p.name}（${p.username}@${p.host}:${p.port || 22}，${p.mode === 'direct' ? '直接 SSH' : '堡垒机'}，提权习惯=${resolvePrivilege(h, p.name)}）`)
      .join('\n') +
    '\n\n提权习惯取值：none=不用提权；sudo=账号 sudo 免密，直接 `sudo <命令>`；sudo-i=必须先 `sudo -i`（要人工输密码）；ask=没记录，先问用户一次再用 bastion_habits 记下来。' +
    '\n全局习惯与细节可用 bastion_habits（action=read）查看。'
}

/**
 * 判断一条 sudo/su 命令是否停在密码交互（等待用户输密码）。
 * 用于把「sudo -i 后需要输密码」的闭环提示回传给 AI。
 *
 * 只扫**最后一个非空行**（提示符就在那），并且关键词可配置 ——
 * 有些机器的 sudo 提示是本地化文案或者 `Passphrase:`，写死英文会漏。
 */
export function isSudoPasswordPrompt(command: string, output: string): boolean {
  const cmd = command.trim()
  if (!/^(sudo|su)\b/.test(cmd)) return false
  const patterns = resolvePasswordPrompts((k) => vscode.workspace.getConfiguration('bastion').get(k))
  const tail = stripAnsi(output).slice(-400)
  return isWaitingForPassword(tail, patterns) || /\[sudo\]/i.test(tail)
}

