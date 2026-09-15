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
import * as crypto from 'crypto'
import { BastionTerminal, stripAnsi } from './terminal'
import { getProfiles } from './profiles'
import { getHabits, resolvePrivilege, habitsForAI } from './habits'
import { isWaitingForPassword, resolvePasswordPrompts } from './recognize'
import { log } from './log'
import { ctx, terminals, lastBastionTerminal, getMcpEndpointInfo } from './state'
import { defaultDownloadDir as defaultDownloadDirShared } from './downloadDir'
import { ensureConnection, openTerminal, openSessionToHost, type AssetPicked } from './sessions'
import { describeAsset, describeAssets, classifySessionScreen, menuStuckMessage, resolveMenuHints, type SessionScreenState } from './menu'
import { pullPath, pushPath, type TransferSession } from './transferPath'
import { fmtBytes } from './status'

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
/** 找到目标会话（按终端名匹配，没指定就用活动/最近的）。工具层共用 */
export function findSession(terminalName?: string): { term: BastionTerminal; name: string } | { error: string } {
  const want = (terminalName ?? '').trim()
  if (want) {
    for (const [vt, t] of terminals) {
      if (vt.name === want || vt.name.includes(want)) return { term: t, name: vt.name }
    }
    return { error: `找不到会话「${want}」。先用 bastion_listSessions 看有哪些会话（名字形如 用户@主机）` }
  }
  const vt = vscode.window.activeTerminal
  const active = vt ? terminals.get(vt) : undefined
  if (active && vt) return { term: active, name: vt.name }
  const last = lastBastionTerminal ?? undefined
  if (last) {
    for (const [v, t] of terminals) if (t === last) return { term: t, name: v.name }
  }
  return { error: '没有活动堡垒机会话，请先用 BastionShell 连接' }
}

export async function execRemote(arg?: string | { command?: string; terminal?: string }): Promise<string> {
  const input = typeof arg === 'string' ? { command: arg } : (arg ?? {})
  let command = input.command ?? ''
  if (!command) command = readCommandFile()
  if (!command.trim()) {
    const msg = '没有命令：请传 command 参数，或把命令写入 .vscode/bastion-command.txt'
    vscode.window.showWarningMessage(msg)
    return msg
  }

  const found = findSession(input.terminal)
  if ('error' in found) {
    log(`bastion_exec 未执行：${found.error}`)
    writeOutputFile(found.error)
    return found.error
  }
  const term = found.term

  // 会话停在菜单上时**先别发命令**：菜单会把命令当成自己的输入吃掉（甚至误触某个选项）。
  // 正确做法是让人在终端里走完那一步，AI 再接着用 —— 会话是共用的，不需要重新认证。
  const guard = menuGuard(found.name, term)
  if (guard) {
    writeOutputFile(guard)
    return guard
  }

  // 提权习惯决定两件事：要不要给 sudo 命令加哨兵标记（免密才敢加），以及弹密码提示时怎么提示 AI
  const profileName = term.profile?.name
  const privilege = resolvePrivilege(getHabits(), profileName)
  const output = await term.exec(command, { allowPlainSudo: privilege === 'sudo' })

  let finalOutput = output + exitCodeNote(term)
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

/**
 * bastion_connect 工具：连接档案（直接 SSH 直接进 shell；堡垒机模式过菜单选目标机）
 *
 * `assetId`：一个 IP 在堡垒机里匹配到**多条资产**时用它指明要哪一条。
 * 不传的话：只有一条候选就自动用，多条会弹窗让用户选（绝不盲选一条 ——
 * 那等于把命令执行到可能是另一台机器上）。
 */
export async function connectToTarget(input?: {
  profile?: string
  host?: string
  userChoice?: string
  assetId?: string
}): Promise<string> {
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

  let opened: Awaited<ReturnType<typeof openSessionToHost>>
  try {
    opened = await openSessionToHost(conn, profile, host, input?.userChoice ?? '1', input?.assetId)
  } catch (e) {
    // 失败也要**作为文本返回**（而不是抛出去）：里面对「多条资产」这种情况会带上候选列表，
    // AI 读到之后可以带 assetId 再调一次，用户也能看懂发生了什么。
    const msg = (e as Error).message
    log(`连接目标 ${host} 失败：${msg}`)
    return `连接 ${host} 失败：${msg}`
  }

  const assetNote = assetNoteOf(host, opened.asset)
  return `已连接到目标 ${host}，终端名 ${profile.username}@${host}。之后用 bastion_exec 在这台机器上执行命令。${assetNote}${habitNote(profileName)}`
}

/** 把「这次选了哪条资产」写清楚 —— 人多条同名资产时，这一步是唯一能看出差别的地方 */
function assetNoteOf(host: string, asset?: AssetPicked): string {
  if (!asset) return ''
  const mine = asset.candidate ? describeAsset(asset.candidate) : `ID ${asset.id}`
  const others = asset.candidates.filter((c) => c.id !== asset.id)
  let note = `\n\n本次登录的资产：${mine}`
  if (others.length > 0) {
    note +=
      `\n（${host} 一共匹配到 ${asset.candidates.length} 条资产，如果你要的其实是另一条，` +
      `请带上 assetId 重新调用 bastion_connect：\n${describeAssets(others, host)}）`
  }
  return note
}

/**
 * 这条会话现在能不能直接执行命令。
 *
 * 「人已经手动接手过」的会话和「AI 刚连上」的会话在这里没有区别 —— 都是同一条通道，
 * 这正是不需要把密码/动态码交给 AI 那一侧的原因。
 */
export function sessionScreenState(term: BastionTerminal): SessionScreenState {
  try {
    const cfg = vscode.workspace.getConfiguration('bastion')
    const hints = resolveMenuHints((k) => cfg.get(`menuHints.${k}`))
    return classifySessionScreen(term.getTail(12), hints)
  } catch {
    return 'unknown' // 读不到屏幕就当未知：照旧执行，不要因为环境问题误拦
  }
}

/** 每条会话的名字 + 现在的状态（listSessions 和自检工具都用它） */
export function sessionHealthLines(): { name: string; state: SessionScreenState }[] {
  return [...terminals.entries()].map(([vt, t]) => ({ name: vt.name, state: sessionScreenState(t) }))
}

/** 会话状态 → 给人/AI 看的一句话 */
export function sessionStateLabel(state: SessionScreenState): string {
  if (state === 'shell') return '✅ 在 shell 里（可以直接执行命令）'
  if (state === 'menu') return '⚠️ 还停在堡垒机菜单上（需要人在终端里走完这一步）'
  return '状态未知（可以直接试）'
}

/**
 * 会话停在菜单上时的拦截（exec / push / pull 共用）。
 *
 * 返回 null = 可以继续；返回字符串 = 这就是要回给 AI 的话（命令别发）。
 */
function menuGuard(name: string, term: BastionTerminal): string | null {
  if (sessionScreenState(term) !== 'menu') return null
  const msg = menuStuckMessage(term.getTail(12))
  log(`${name}：会话停在堡垒机菜单上，操作已拦下（等人手动走完这一步）`)
  return msg
}

/**
 * 命令的退出码备注 —— **没有它，AI 只能靠读输出猜命令成没成**。
 *
 * 三种情况分开说，因为这三种的下一步完全不同：
 * - 拿到退出码 → 直接给数字（0 = 成功；非 0 通常表示失败）；
 * - 有哨兵但没退出码 → 极少见（老版本远端残留），说"未知"；
 * - 没等到哨兵 → **命令很可能压根没执行完**（终端被别的程序占着，或命令是交互式的），
 *   这时候把输出当正常结果看会得出错误结论。
 */
export function exitCodeNote(term: BastionTerminal): string {
  const rc = term.lastExitCode
  if (!term.lastExecMarkerSeen) {
    return (
      '\n\n[⚠️ 没等到命令结束标记：这条命令很可能**没有真正执行完**' +
      '（终端被别的程序占着、或命令需要交互式输入）。上面的输出不完整，不要当成正常结果；' +
      '必要时用 bastion_tail 看看屏幕上现在是什么。]'
    )
  }
  if (rc === undefined) {
    return '\n\n[退出码未知：这条命令是交互式/需要人工输入的，拿不到可靠的结束标记]'
  }
  return `\n\n[退出码 ${rc}${rc === 0 ? '：命令成功' : '：命令以非 0 退出，通常表示失败 —— 请结合输出判断原因'}]`
}

/**
 * `bastion_tail`：某条会话屏幕上最后几行。
 *
 * 用途有两个，都很实在：
 *   1. **排障** —— AI 看到「命令好像没反应」时能直接看一眼屏幕，而不是反复 exec；
 *   2. **人工接手的收尾** —— 人说"我在终端里弄完了"，AI 看一眼就知道走到哪一步了。
 */
export function tailScreen(input: { terminal?: string; lines?: number } = {}): string {
  const found = findSession(input.terminal)
  if ('error' in found) return found.error
  const n = Math.max(1, Math.min(200, Math.floor(input.lines ?? 40)))
  const state = sessionScreenState(found.term)
  const tail = found.term.getTail(n).trim()
  const head = `会话 ${found.name}（${sessionStateLabel(state)}）屏幕最后 ${n} 行：`
  return `${head}\n${tail || '（屏幕是空的）'}`
}

/**
 * `bastion_push`：把本机文件（或目录）传到远端 —— 走**标准传输工具** `transferPath`。
 *
 * 那个模块负责：能力探测（有没有 rz）→ 选通道（rz / base64 降级 / tar 打包）→ 传完回读校验。
 * 这里只做三件事：找会话、套上"菜单上别发命令"的拦截、把结果翻成人话。
 */
export async function pushFile(input: { localPath?: string; remoteDir?: string; terminal?: string }): Promise<string> {
  const localPath = (input.localPath ?? '').trim()
  if (!localPath) return '错误：需要 localPath（本机文件或目录路径，建议绝对路径）'
  // 本地路径先查：这类错误和会话无关，先报出来更好定位（目录是允许的，会打包再传）
  if (!fs.existsSync(localPath)) return `错误：本机找不到这个路径：${localPath}`
  const found = findSession(input.terminal)
  if ('error' in found) return found.error
  const guard = menuGuard(found.name, found.term)
  if (guard) return guard
  const out = await pushPath({
    localPath,
    remoteDir: input.remoteDir,
    session: transferSessionOf(found.term, found.name)
  })
  return out.message
}

/**
 * `bastion_pull`：把远端文件拉回本机（`sz`）。
 *
 * 默认落在**工作区的 `.bastion-downloads/`** 下 —— 因为拉回来通常就是给 AI 读的，
 * 放在工作区里它自己的文件工具就能直接读；没有工作区时落到 `~/.bastionshell/downloads/`。
 */
export async function pullFile(input: { remotePath?: string; localDir?: string; terminal?: string }): Promise<string> {
  const remotePath = (input.remotePath ?? '').trim()
  if (!remotePath) return '错误：需要 remotePath（远端文件路径）'
  const found = findSession(input.terminal)
  if ('error' in found) return found.error
  const guard = menuGuard(found.name, found.term)
  if (guard) return guard
  const dir = (input.localDir ?? '').trim() || defaultDownloadDir()
  const out = await pullPath({ remotePath, localDir: dir, session: transferSessionOf(found.term, found.name) })
  return out.message
}

/**
 * 把 BastionTerminal 适配成「标准传输工具」要的会话接口。
 *
 * 注意这里**没有**把 zmodem 细节泄漏出去：rz/sz 只是它众多通道里的两条，
 * 没有就自动降级（见 transferPath）。
 */
export function transferSessionOf(term: BastionTerminal, name: string): TransferSession {
  return {
    name,
    exec: (cmd) => term.exec(cmd, {}),
    exitCode: () => term.lastExitCode,
    rzUpload: async (paths) => {
      const r = await term.upload(paths)
      return { skipped: r.skipped, mode: r.mode, error: term.uploadError }
    },
    szDownload: (remotePath, localDir) => term.download(remotePath, localDir),
    overwriteMode: () => {
      const raw = vscode.workspace.getConfiguration('bastion').get<string>('uploadOverwrite', 'skip')
      return raw === 'overwrite' || raw === 'rename' ? raw : 'skip'
    },
    log: (m) => log(m)
  }
}

function defaultDownloadDir(): string {
  // 落点规则收在 downloadDir.ts 一处 —— 人工下载（用户敲 sz）和 AI 的 bastion_pull
  // 必须落在同一个地方，否则"文件到底下到哪了"就会有两个说法。
  return defaultDownloadDirShared()
}


export function listSessions(): string {
  const rows = sessionHealthLines().map(({ name, state }) => `- ${name}：${sessionStateLabel(state)}`)
  // 把 MCP 端点写进返回里：AI 报「工具出错」时，这一行能立刻分清是
  // 「端点没连上（根本没返回）」还是「连上了但工具里出错（返回里会有这行）」。
  const ep = getMcpEndpointInfo()
  const endpointNote = ep ? `\n（本次调用来自 MCP 端点 http://127.0.0.1:${ep.port}/mcp${ep.portFallback ? '（注意：默认端口被占用，已退到随机端口）' : ''}）` : ''
  if (rows.length === 0) {
    return '没有活动堡垒机会话' + endpointNote
  }
  return (
    `当前堡垒机会话（${rows.length} 个）：\n` +
    rows.join('\n') +
    '\n\n提示：这些都是**人和 AI 共用**的会话 —— 需要人工操作（MFA、选资产、输密码、过菜单）时，' +
    '请让用户在终端里做完，然后你直接在这些会话上继续执行命令，不需要重新连接或认证。' +
    endpointNote
  )
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

