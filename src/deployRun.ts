/**
 * 部署任务的执行：逐台推进、进度、会话回收、结果报告，以及任务文件的增删改查命令。
 */

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { parse as parseJsonc, modify, applyEdits, ParseError } from 'jsonc-parser'
import { BastionTerminal, isMarkerSafe, stripAnsi } from './terminal'
import type { SharedConnection } from './connection'
import type { ConnectionProfile } from './profiles'
import { getProfiles } from './profiles'
import type { DeployTaskItem } from './deployTree'
import {
  DeployTask,
  listDeployTasks,
  createDeployTask,
  deleteDeployTaskFile,
  readDeployTaskByUri,
  resolveTerminalPolicy,
  type TerminalPolicy
} from './deploy'
import { findDangerousIn, describeDanger } from './danger'
import { getDangerRules } from './dangerConfig'
import { getHabits, resolvePrivilege } from './habits'
import { SHELL_STEP, resolveMenuHints, detectPrompt } from './menu'
import { setSlot, flashSlot, clearSlot, fmtDuration } from './status'
import { log } from './log'
import { sleep, ctx, terminals, activeIsBastion, deployProvider } from './state'
import { updateStatusBar, updateKeepTerminalSlot } from './slots'
import { ensureConnection, openSessionToHost, openTerminal } from './sessions'
import { HostResult, DeployRun, renderDeployReport, capForAi, type StepResult } from './deployReport'
import { sendTextToAIChat } from './aiChat'
import { toReportView, showReportPanel, type ReportView } from './deployReportView'
import {
  registerDeploy,
  unregisterDeploy,
  getRunningDeploy,
  abortDeploy,
  isDeployRunning
} from './deployRunning'

// ---------------------------------------------------------------- 运行中的任务

/** 停止一个正在跑的部署任务（粒度：跑完当前这台就停） */
export function abortDeployTask(taskId: string): boolean {
  const info = getRunningDeploy(taskId)
  if (!info) return false
  if (!abortDeploy(taskId)) return false
  // 中途硬中断会把目标机留在半执行状态（文件传了一半、脚本跑了一半），
  // 比多等一台危险得多，所以粒度是「跑完当前这台」。
  log(`收到停止请求：部署任务「${info.taskName}」（跑完当前这台后停止）`)
  return true
}

/**
 * 拆出要执行的命令行：去空行、去首尾空白。
 *
 * 三种换行都要认（\n / \r\n / 裸 \r）：裸 \r 不是洁癖 —— 它会被终端当成回车，
 * 把半条命令提前提交掉；留在「一行」里反而是隐患，必须拆开。
 */
export function splitCommandLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * 逐行执行命令并把**输出**带回来。
 *
 * 为什么拆成一行一行而不是整段 write：
 * 1. 只有一行一个命令，才能把「哪条命令产生了什么输出」对应起来写进报告 ——
 *    整段 write 只能看到一坨混在一起的输出，事后没法复盘。
 * 2. 哨兵标记（命令结束打个唯一标记）是按行判断安全性的：`sudo -i` 不能加标记
 *    （会变成交互式 shell，标记永远打不出来），但它下一行的 `cd /etc` 可以。
 *    所以 `sudo -i\ncd /etc` 这种常见写法，第一行走兜底、第二行能精确捕获输出。
 */
export async function runCommandLines(
  term: BastionTerminal,
  label: string,
  commands: string[],
  allowPlainSudo: boolean
): Promise<StepResult[]> {
  const out: StepResult[] = []
  for (const cmd of commands) {
    if (!cmd.trim()) continue
    const t0 = Date.now()
    if (isMarkerSafe(cmd, allowPlainSudo)) {
      // 捕获到的原始输出带 ANSI/括号粘贴等控制序列（报告里会出现 `[?2004hroot@...` 这种），
      // 报告是给人看的，先清干净再存。
      const output = stripAnsi(await term.exec(cmd))
      // 没等到结束标记 → 命令很可能没执行（典型场景：上一步上传后 rz 还占着终端）。
      // 如实标出来并说明原因，别让人去怀疑自己的脚本。
      out.push({ label, command: cmd, output, captured: true, pending: !term.lastExecMarkerSeen, ms: Date.now() - t0 })
    } else {
      // 交互式命令（sudo -i / su）、后台任务、exec 换 shell：哨兵打不出来，
      // 只能写进去等一会。输出无法可靠归属，报告里会标出来让人自己去看窗口。
      log(`「${label}」这句是交互式/后台命令，输出无法可靠捕获：${cmd}`)
      await term.write(cmd + '\r')
      await sleep(1500)
      out.push({ label, command: cmd, output: '', captured: false, ms: Date.now() - t0 })
    }
  }
  return out
}

/** 部署结束后怎么处理那些会话终端（类型定义在 deploy.ts，那里也有任务级覆盖的纯函数） */
export type DeployTerminalPolicy = TerminalPolicy

export function getDeployTerminalPolicy(): DeployTerminalPolicy {
  const v = vscode.workspace.getConfiguration('bastion').get<string>('deployTerminalPolicy', 'closeSuccess')
  return v === 'keep' || v === 'closeAll' || v === 'ask' ? v : 'closeSuccess'
}

/**
 * 这次任务到底用哪个策略：**任务里写了 keepTerminal 就以任务为准**，没写才看全局设置。
 * 打一行日志说清来源，否则「为什么这次没保留终端」很难查。
 */
export function policyForTask(task: DeployTask): DeployTerminalPolicy {
  const { policy, from } = resolveTerminalPolicy(task.keepTerminal, getDeployTerminalPolicy())
  if (from === 'task') {
    log(`终端处理策略：${policy}（来自任务设置 keepTerminal=${task.keepTerminal}）`)
  }
  return policy
}

/**
 * 命令：一键开关「部署结束后保留终端窗口」。
 *
 * 为什么要有这个开关（而不是只留一个设置项）：跑完自动关窗口时，你手上就只剩一份报告；
 * 而排查问题最需要的恰恰是那个窗口里的原始输出。藏在设置里等于没有 ——
 * 底栏会常驻一格「保留终端」告诉你它是开着的，点一下就能关。
 */
export async function toggleKeepDeployTerminal(): Promise<void> {
  const cur = getDeployTerminalPolicy()
  const next: DeployTerminalPolicy = cur === 'keep' ? 'closeSuccess' : 'keep'
  await vscode.workspace.getConfiguration('bastion').update('deployTerminalPolicy', next, vscode.ConfigurationTarget.Global)
  updateKeepTerminalSlot()
  log(`部署完保留终端：${next === 'keep' ? '已开启' : '已关闭'}`)
  if (next === 'keep') {
    vscode.window.showInformationMessage(
      '已开启：部署结束后保留会话窗口（底栏会出现「保留终端」，点它可关闭）'
    )
  } else {
    vscode.window.showInformationMessage('已关闭：部署成功后会回收会话窗口（失败的仍然保留）')
  }
}

/**
 * 部署任务开跑前检查 preCommand / script 里的高危操作。
 * 返回 true = 可以继续（没命中，或用户确认要跑）。
 *
 * 这里用「确认」而不是像 AI 那样直接拦：命令是你自己写的，你有权执行，
 * 但如果里面藏着 `rm -rf /`，至少让你先看一眼。
 */
export async function confirmDangerousDeploy(task: DeployTask): Promise<boolean> {
  const found = findDangerousIn([
    { label: '前置命令', text: task.preCommand.join('\n') },
    { label: '执行脚本', text: task.script.join('\n') }
  ], getDangerRules())
  if (found.length === 0) return true

  const detail = found.map((f) => `【${f.label}】\n${describeDanger(f.hits)}`).join('\n\n')
  log(`部署任务「${task.name}」命中高危命令：\n${detail}`)
  const pick = await vscode.window.showWarningMessage(
    `部署任务「${task.name}」里有高危操作，确认要继续吗？\n\n${detail}`,
    { modal: true },
    '仍然执行'
  )
  return pick === '仍然执行'
}

/** 在一个已经就绪的会话上跑完一个任务，返回这一步的结果 */
async function runTaskOnTerminal(
  term: BastionTerminal,
  profile: ConnectionProfile,
  task: DeployTask,
  host: string,
  policy: DeployTerminalPolicy,
  vt: vscode.Terminal,
  direct: boolean
): Promise<HostResult> {
  const t0 = Date.now()
  const steps: StepResult[] = []
  // 习惯里记了「这台机器 sudo 免密」时，`sudo <命令>` 也能用哨兵精确捕获输出
  const allowPlainSudo = resolvePrivilege(getHabits(), profile.name) === 'sudo'
  try {
    if (task.preCommand.length > 0) {
      steps.push(...(await runCommandLines(term, '前置命令', task.preCommand, allowPlainSudo)))
    }
    if (task.uploads.length > 0) {
      const up0 = Date.now()
      const { skipped, mode } = await term.upload(task.uploads)
      // 上报要诚实：以前只写「上传文件 README.md · 0.3s」，跳过时看起来像传成功了；
      // 而且不写实际模式，用户分不清「设置没生效」和「对端拒绝了覆盖」。
      const names = task.uploads.map((p) => path.basename(p))
      const uploaded = names.filter((n) => !skipped.includes(n))
      const modeLabel = { skip: '跳过', overwrite: '覆盖', rename: '改名' }[mode]
      const lines: string[] = [`覆盖模式：${mode}（${modeLabel}${mode === 'skip' ? '' : `，rz${mode === 'overwrite' ? ' -y' : ' -E'}`}）`]
      if (uploaded.length > 0) lines.push(`已上传：${uploaded.join('、')}`)
      if (skipped.length > 0) {
        lines.push(`未上传（远端拒绝了本次传输）：${skipped.join('、')}`)
        if (mode === 'skip') {
          lines.push('→ 远端已存在同名文件，按当前设置跳过。想覆盖就把 bastion.uploadOverwrite 设为 overwrite。')
        } else {
          lines.push(
            `→ **不是设置没生效**：已按 ${mode} 发出请求，但对端拒绝了（对端 rz 可能不支持 ${mode === 'overwrite' ? '-y' : '-E'}，或堡垒机在中间拦了文件传输）。`
          )
        }
      }
      steps.push({
        label: skipped.length > 0 && uploaded.length === 0 ? '上传文件（全部未上传）' : '上传文件',
        command: names.join('、'),
        output: lines.join('\n'),
        captured: true,
        ms: Date.now() - up0
      })
    }
    if (task.script.length > 0) {
      steps.push(...(await runCommandLines(term, '脚本', task.script, allowPlainSudo)))
    }
    // 成功的会话按策略回收（留着只会越堆越多）
    if (policy === 'closeSuccess' || policy === 'closeAll') {
      vt.dispose()
      log(`部署 ${host} 成功，已回收该会话终端`)
    }
    return { host, ok: true, ms: Date.now() - t0, steps, direct }
  } catch (e) {
    const msg = (e as Error).message
    log(`部署 ${host} 失败: ${msg}`)
    // 失败的会话**默认保留** —— 里面就是出错现场（菜单卡在哪、报什么错）。
    // 关掉它等于把唯一的证据销毁，所以只有显式选了 closeAll 才回收。
    if (policy === 'closeAll') {
      vt.dispose()
      log(`部署 ${host} 失败，按 closeAll 策略回收了会话终端（现场已丢失）`)
    } else {
      log(`部署 ${host} 失败，保留会话终端以便查看出错现场：${vt.name}`)
    }
    return { host, ok: false, ms: Date.now() - t0, error: msg, steps, direct }
  }
}

/** 走堡垒机菜单落到目标机再跑任务 */
export async function deployToHost(
  conn: SharedConnection,
  profile: ConnectionProfile,
  task: DeployTask,
  host: string,
  policy: DeployTerminalPolicy
): Promise<HostResult> {
  const t0 = Date.now()
  let vt: vscode.Terminal | undefined
  try {
    const opened = await openSessionToHost(conn, profile, host, task.userChoice)
    vt = opened.vt
    return await runTaskOnTerminal(opened.term, profile, task, host, policy, vt, false)
  } catch (e) {
    const msg = (e as Error).message
    log(`部署 ${host} 失败: ${msg}`)
    if (policy === 'closeAll' && vt) vt.dispose()
    else if (vt) log(`部署 ${host} 失败，保留会话终端以便查看出错现场：${vt.name}`)
    return { host, ok: false, ms: Date.now() - t0, error: msg, steps: [] }
  }
}

/**
 * 直连档案：**目标机就是档案自己那台**，所以没有「选目标机」和「选用户」两步。
 *
 * 这是修一个真 bug：以前直连也走 openSessionToHost，于是
 *   1) 干等一个永远不出现的选机菜单（6 秒超时 + 1.2 秒兜底）—— 慢
 *   2) 把档案里的「host」当成目标机 IP 打进已经进去的 shell —— 错
 *   3) 如果 hosts 是空的，total = 0，整个任务**什么都不做**，报告显示 0/0
 */
export async function deployToDirect(
  conn: SharedConnection,
  profile: ConnectionProfile,
  task: DeployTask,
  policy: DeployTerminalPolicy
): Promise<HostResult> {
  const host = profile.host
  const t0 = Date.now()
  let vt: vscode.Terminal | undefined
  try {
    const opened = openTerminal(conn, profile, `${profile.username}@${profile.host}`)
    vt = opened.vt
    opened.vt.show()
    // 直连没有菜单，但 shell 提示符要等一下才出来。
    // 用和菜单导航同一套「等屏幕静止 → 读整屏 → 匹配」的办法：
    // 以前是在数据流里等正则，会被 TCP 分块的转义序列坑到（见 terminal.ts 的说明）。
    const hints = resolveMenuHints((k) => vscode.workspace.getConfiguration('bastion').get(`menuHints.${k}`))
    const mark = opened.term.markOutput()
    await opened.term.settleScreen(mark, { firstMs: SHELL_STEP.timeoutMs, quietMs: 700, maxMs: SHELL_STEP.timeoutMs + 4000 })
    if (!detectPrompt(opened.term.readSince(mark, 20), 'shellPrompt', hints)) await sleep(800)
    return await runTaskOnTerminal(opened.term, profile, task, host, policy, vt, true)
  } catch (e) {
    const msg = (e as Error).message
    log(`直连部署 ${host} 失败: ${msg}`)
    if (policy === 'closeAll' && vt) vt.dispose()
    else if (vt) log(`直连部署 ${host} 失败，保留会话终端：${vt.name}`)
    return { host, ok: false, ms: Date.now() - t0, error: msg, steps: [], direct: true }
  }
}

/** 批量连接：选档案 + 主机列表，一次性开多个会话（过堡垒机菜单选机/选用户） */
export async function batchConnect(): Promise<void> {
  const profiles = getProfiles(ctx)
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('请先创建连接档案')
    return
  }
  const profilePick = await vscode.window.showQuickPick(
    profiles.map((p) => ({
      label: p.name,
      description: `${p.username}@${p.host} · ${p.mode === 'direct' ? '直连' : '堡垒机'}`,
      profile: p
    })),
    { placeHolder: '选择连接档案' }
  )
  if (!profilePick) return

  // 直连档案只对应一台机器，没有选机/选用户这两步：直接开一个会话就完事
  if (profilePick.profile.mode === 'direct') {
    const conn = await ensureConnection(profilePick.profile)
    if (!conn) return
    const { vt } = openTerminal(conn, profilePick.profile, `${profilePick.profile.username}@${profilePick.profile.host}`)
    vt.show()
    log(`直连档案「${profilePick.profile.name}」无需选机/选用户，已直接开会话`)
    return
  }

  const hostsText = await vscode.window.showInputBox({ prompt: '目标机器（空格或逗号分隔）', placeHolder: '10.0.0.1 10.0.0.2' })
  if (!hostsText) return
  const hosts = hostsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  if (hosts.length === 0) return
  const userChoice =
    (await vscode.window.showInputBox({
      prompt: '选择用户序号（有些管理员账号输完 IP 直接进 shell，没有这一步——那就清空直接回车）',
      value: '1'
    })) ?? '1'
  const conn = await ensureConnection(profilePick.profile)
  if (!conn) return
  for (let i = 0; i < hosts.length; i++) {
    // 复用「长任务进度」槽位显示批量连接进度
    setSlot('deploy', {
      text: `$(sync~spin) 连接 ${i + 1}/${hosts.length}`,
      tooltip: `批量连接：${profilePick.profile.name}\n正在：${hosts[i]}`
    })
    await openSessionToHost(conn, profilePick.profile, hosts[i], userChoice)
    await sleep(400)
  }
  clearSlot('deploy')
  flashSlot('deploy', { text: `$(check) 已连接 ${hosts.length} 台`, tooltip: hosts.join('\n') }, 5000)
}

/**
 * 跑一个部署任务，逐台推进并实时显示进度，最后汇总成报告。
 * 单台失败不再中断整个任务（旧行为是一台失败就弹错继续跑，但没有汇总，事后不知道哪台挂了）。
 *
 * 目标机列表按档案模式决定：
 * - 直连档案：**目标机就是档案自己那台**，忽略 hosts（它是给堡垒机模式用的），只跑一台，
 *   而且跳过选机/选用户两步。
 * - 堡垒机档案：逐台过菜单落到目标机。
 */
export async function runDeployTaskCore(
  task: DeployTask,
  opts: { label?: string; openReport?: boolean; onlyHosts?: string[] } = {}
): Promise<DeployRun> {
  const profile = getProfiles(ctx).find((p) => p.name === task.profileId)
  if (!profile) {
    vscode.window.showErrorMessage(`找不到连接档案「${task.profileId}」`)
    return { task, results: [], ms: 0 }
  }

  const direct = profile.mode === 'direct'
  const allHosts = direct ? [profile.host] : task.hosts
  // 只要其中几台（报告面板的「重跑这台」）—— 顺序仍按任务里的顺序
  const hosts = opts.onlyHosts ? allHosts.filter((h) => opts.onlyHosts!.includes(h)) : allHosts
  if (hosts.length === 0) {
    // 以前这里会静默空跑（total = 0，报告 0/0），看起来像「跑了但什么都没发生」
    const msg = `部署任务「${task.name}」没有目标机：档案「${profile.name}」是${direct ? '直连' : '堡垒机'}模式，请在任务 JSON 的 hosts 里填目标机 IP`
    log(msg)
    vscode.window.showErrorMessage(msg)
    return { task, results: [], ms: 0 }
  }

  // 同一个任务不许并发跑两次（后一次会覆盖前一次的运行时状态）
  if (isDeployRunning(task.id)) {
    vscode.window.showWarningMessage(`部署任务「${task.name}」正在执行中`)
    return { task, results: [], ms: 0 }
  }

  // 高危操作先确认（preCommand / script 里可能藏着 rm -rf / 之类）
  if (!(await confirmDangerousDeploy(task))) {
    log(`部署任务「${task.name}」被用户取消（高危操作未确认）`)
    return { task, results: [], ms: 0 }
  }

  const conn = await ensureConnection(profile)
  if (!conn) return { task, results: [], ms: 0 }

  const prefix = opts.label ? `${opts.label} ` : ''
  const t0 = Date.now()
  const results: HostResult[] = []
  // 任务里写了 keepTerminal 就以任务为准，没写才跟随全局设置
  const policy = policyForTask(task)
  const state = registerDeploy(task.id, task.name, hosts.length)
  deployProvider?.refresh()

  try {
    for (let i = 0; i < hosts.length; i++) {
      // 停止检查放在**每台开始之前**：中途硬中断会把目标机留在半执行状态，比多等一台危险
      if (state.abort) {
        log(`部署任务「${task.name}」已停止：剩余 ${hosts.length - i} 台未执行`)
        for (let k = i; k < hosts.length; k++) {
          results.push({ host: hosts[k], ok: false, ms: 0, error: '用户手动停止，未执行', skipped: true, direct })
        }
        break
      }
      const host = hosts[i]
      state.done = i
      setSlot('deploy', {
        text: `$(sync~spin) ${prefix}${direct ? '直连' : '部署'} ${i + 1}/${hosts.length}`,
        tooltip: `${task.name}\n正在：${host}\n已完成 ${results.filter((r) => r.ok).length} 台成功、${results.filter((r) => !r.ok).length} 台失败\n（命令面板搜「停止部署任务」可中断）`
      })
      results.push(direct ? await deployToDirect(conn, profile, task, policy) : await deployToHost(conn, profile, task, host, policy))
    }
  } finally {
    unregisterDeploy(task.id)
    deployProvider?.refresh()
  }

  const ms = Date.now() - t0
  const okCount = results.filter((r) => r.ok).length
  const skipped = results.filter((r) => r.skipped).length
  const failed = results.length - okCount - skipped
  if (failed === 0 && skipped === 0) {
    flashSlot(
      'deploy',
      {
        text: `$(check) ${prefix}部署完成 ${okCount}/${results.length}`,
        tooltip: `${task.name}\n总耗时 ${fmtDuration(ms)}${direct ? '\n（直连模式，已跳过选机/选用户）' : ''}`
      },
      6000
    )
  } else {
    flashSlot(
      'deploy',
      {
        text: `$(warning) ${prefix}部署 ${okCount}/${results.length}${skipped ? '（已停止）' : ''}`,
        tooltip:
          `${task.name}\n失败 ${failed} 台` +
          (skipped ? `、未执行 ${skipped} 台` : '') +
          `：\n${results.filter((r) => !r.ok).map((r) => `  ${r.host}：${r.error}`).join('\n')}`,
        backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground')
      },
      12000
    )
  }

  // 策略为 ask：跑完让用户决定窗口留不留（报告里已经有命令输出了，但有人就是想自己去翻）
  if (policy === 'ask') await askKeepTerminals(results)

  const run: DeployRun = { task, results, ms }
  if (opts.openReport !== false) await finishDeployReport([run])
  return run
}

/** 问一次要不要保留窗口，不保留就关掉成功的那些（失败的永远保留） */
async function askKeepTerminals(results: HostResult[]): Promise<void> {
  const okHosts = results.filter((r) => r.ok).map((r) => r.host)
  if (okHosts.length === 0) return
  const pick = await vscode.window.showInformationMessage(
    `部署结束。要保留这 ${okHosts.length} 台机器的会话窗口吗？（报告里已记录每条命令的输出）`,
    { modal: true },
    '保留窗口',
    '关掉窗口'
  )
  if (pick !== '关掉窗口') {
    log(`按用户选择保留 ${okHosts.length} 个会话窗口`)
    return
  }
  let closed = 0
  for (const [vt, term] of terminals) {
    if (term.profile?.name && okHosts.includes(term.profile.host)) {
      vt.dispose()
      closed++
    }
  }
  log(`按用户选择关掉 ${closed} 个会话窗口`)
}

/** 把报告写到扩展目录（不混进用户项目），返回文件路径 */
export async function writeDeployReport(markdown: string, name: string): Promise<vscode.Uri> {
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'reports')
  await vscode.workspace.fs.createDirectory(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = vscode.Uri.joinPath(dir, `deploy-${name}-${stamp}.md`)
  await vscode.workspace.fs.writeFile(file, Buffer.from(markdown, 'utf8'))
  return file
}

/**
 * 最近一次部署报告。
 *
 * 为什么要记它：报告写进扩展目录后，如果只靠一条几秒就消失的提示给「打开报告」按钮，
 * 用户没点到就**再也找不回来了**（报告埋在 globalStorage 里，没有任何入口）。
 * 所以记下最近一份，并提供命令/按钮随时打开。
 */
interface LastReport {
  uri: vscode.Uri
  name: string
  okCount: number
  total: number
  at: number
}
let lastReport: LastReport | null = null

export function getLastDeployReport(): LastReport | null {
  return lastReport
}

/** 内存里最近一次的结构化结果（面板用；进程重启后从 .json 副本恢复） */
let lastView: ReportView | null = null
let lastReportPaths: { md: string; json: string } | null = null

/** 报告旁的派生文件路径：<同一目录>/<同名>.json（结构化副本，供面板跨重启恢复） */
function sidecarPaths(mdPath: string): { md: string; json: string } {
  return { md: mdPath, json: mdPath.replace(/\.md$/i, '.json') }
}

/** 打开报告面板；拿不到结构化数据就退回打开 Markdown（老行为，不会更差） */
export async function openLastDeployReport(): Promise<void> {
  if (!lastView) await restoreLastReport(ctx)
  if (lastView) {
    showReportPanel(lastView, {
      rerunHost: rerunHostFromReport,
      openMarkdown: openReportMarkdown,
      markdown: readReportMarkdown
    })
    return
  }
  await openReportMarkdown()
}

/** 打开 Markdown 原文（面板里的「打开 Markdown」按钮也走这里） */
async function openReportMarkdown(): Promise<void> {
  const uri = lastReport?.uri ?? (lastReportPaths ? vscode.Uri.file(lastReportPaths.md) : undefined)
  if (!uri) {
    void vscode.window.showInformationMessage('还没有生成过部署报告（跑一次部署任务后就有了）')
    return
  }
  try {
    await vscode.window.showTextDocument(uri, { preview: false })
  } catch (e) {
    // 报告文件可能被用户删了
    log(`打开最近部署报告失败: ${(e as Error).message}`)
    void vscode.window.showWarningMessage(`打不开报告（可能已被删除）：${uri.fsPath}`)
  }
}

/** 读报告 Markdown 文本（发给 AI 用） */
async function readReportMarkdown(): Promise<string> {
  const uri = lastReport?.uri ?? (lastReportPaths ? vscode.Uri.file(lastReportPaths.md) : undefined)
  if (!uri) return ''
  try {
    return fs.readFileSync(uri.fsPath, 'utf8')
  } catch (e) {
    log(`读取报告失败: ${(e as Error).message}`)
    return ''
  }
}

/**
 * 从报告面板重跑某一台：重读任务文件（拿最新配置），只跑这一台。
 * 直连/批量连接产生的报告没有任务文件，这时明确告诉用户跑不了。
 */
export async function rerunHostFromReport(host: string): Promise<void> {
  const uriStr = lastView?.taskUri
  if (!uriStr) {
    void vscode.window.showWarningMessage('这份报告不是部署任务产生的（没有任务文件），无法单独重跑。')
    return
  }
  const task = readDeployTaskByUri(vscode.Uri.parse(uriStr))
  if (!task) {
    void vscode.window.showErrorMessage('任务文件解析失败，无法重跑。请打开任务文件检查格式。')
    return
  }
  log(`从报告重跑单台：${host}（任务 ${task.name}）`)
  await runDeployTaskCore(task, { label: `[单台 ${host}]`, onlyHosts: [host] })
}

/**
 * 启动时恢复「最近一次报告」。
 * 以前 lastReport 只在内存里 —— 重启 VS Code 之后报告就**再也找不回来了**
 * （命令只会说「还没有生成过部署报告」），而报告正是批量部署唯一的产物。
 * 所以落一个指针文件（reports/last.json）指向 .md 和 .json 副本。
 */
export async function restoreLastReport(context: vscode.ExtensionContext): Promise<void> {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'reports')
  const ptr = vscode.Uri.joinPath(dir, 'last.json')
  try {
    if (!fs.existsSync(ptr.fsPath)) return
    const info = JSON.parse(fs.readFileSync(ptr.fsPath, 'utf8')) as {
      md: string
      json: string
      name?: string
      okCount?: number
      total?: number
      at?: number
    }
    lastReportPaths = { md: info.md, json: info.json }
    lastReport = {
      uri: vscode.Uri.file(info.md),
      name: info.name ?? '部署',
      okCount: info.okCount ?? 0,
      total: info.total ?? 0,
      at: info.at ?? 0
    }
    if (info.json && fs.existsSync(info.json)) {
      lastView = JSON.parse(fs.readFileSync(info.json, 'utf8')) as ReportView
    }
    log(`已恢复最近一次部署报告：${info.md}`)
  } catch (e) {
    log(`恢复最近部署报告失败: ${(e as Error).message}`)
  }
}

/**
 * 写报告文件，并决定怎么呈现：
 * 有失败 → 直接打开报告（要看失败原因）；全成功 → 只弹一条带「打开报告」按钮的提示，不打断。
 * 无论哪种，都把路径写进日志，并记成「最近一次报告」供随时回看。
 */
export async function finishDeployReport(runs: DeployRun[]): Promise<void> {
  if (runs.length === 0 || runs.every((r) => r.results.length === 0)) return
  const { markdown, okCount, total } = renderDeployReport(runs)
  let file: vscode.Uri
  try {
    file = await writeDeployReport(markdown, runs.length === 1 ? runs[0].task.name || 'task' : 'batch')
  } catch (e) {
    log(`写部署报告失败: ${(e as Error).message}`)
    vscode.window.showWarningMessage(`部署结束（${okCount}/${total} 成功），但报告写入失败：${(e as Error).message}`)
    return
  }
  lastReport = { uri: file, name: runs.map((r) => r.task.name).join('、'), okCount, total, at: Date.now() }
  // 结构化副本（.json）：面板重启后还能打开；再落一个指针文件指向这两份
  try {
    const paths = sidecarPaths(file.fsPath)
    lastReportPaths = paths
    lastView = toReportView(runs, runs.length === 1 ? runs[0].task.uri?.toString() : undefined)
    fs.writeFileSync(paths.json, JSON.stringify(lastView, null, 2), 'utf8')
    const ptr = vscode.Uri.joinPath(ctx.globalStorageUri, 'reports', 'last.json')
    fs.writeFileSync(
      ptr.fsPath,
      JSON.stringify({ md: paths.md, json: paths.json, name: lastReport.name, okCount, total, at: lastReport.at }, null, 2),
      'utf8'
    )
  } catch (e) {
    // 写副本失败不影响主流程（Markdown 报告已经写好了）
    log(`写报告副本失败（面板可能无法跨重启恢复）: ${(e as Error).message}`)
  }
  // 路径也写进日志：万一提示错过了，日志里还能找到文件
  // （总览面板也会显示「最近一次部署」，它自己会读到 lastReport，所以这里不需要反向通知 ——
  //   反向 import overview 会形成 deployRun ↔ overview 循环依赖）
  log(`部署报告已保存：${file.fsPath}（可在命令面板搜「打开最近一次部署报告」再打开）`)

  if (okCount === total) {
    const pick = await vscode.window.showInformationMessage(
      `部署完成：${okCount}/${total} 台成功`,
      '打开报告',
      '保留窗口'
    )
    if (pick === '打开报告') await openLastDeployReport()
  } else {
    // 有失败时给「发给 AI」：报告里每条命令的输出都在，正好让 AI 直接分析失败原因
    const pick = await vscode.window.showWarningMessage(
      `部署结束：${okCount}/${total} 台成功，${total - okCount} 台失败（已打开报告）`,
      '发给 AI 分析'
    )
    await openLastDeployReport()
    if (pick === '发给 AI 分析') await sendLastReportToAI()
  }
}

/** 命令：把最近一次部署报告发给 AI 分析（失败原因、下一步怎么办） */
export async function sendLastReportToAI(): Promise<void> {
  if (!lastReport) {
    vscode.window.showInformationMessage('还没有生成过部署报告（跑一次部署任务后就有了）')
    return
  }
  let text: string
  try {
    const raw = fs.readFileSync(lastReport.uri.fsPath, 'utf8')
    const capped = capForAi(raw)
    text = capped.text
    if (capped.omitted > 0) {
      // 只让 AI 知道被截断是不够的：用户以为整份都发出去了，而切掉的可能是失败那台
      log(`报告过长，发给 AI 前截断：省略 ${capped.omitted} 字符（原文 ${raw.length}）`)
      void vscode.window.showInformationMessage(
        `报告较长（${raw.length} 字符），已截断到 ${capForAi(raw).text.length} 字符再发给 AI —— 后面的内容没发出去。`
      )
    }
  } catch (e) {
    log(`读取最近部署报告失败: ${(e as Error).message}`)
    vscode.window.showWarningMessage(`读不到报告文件（可能已被删除）：${lastReport.uri.fsPath}`)
    return
  }
  await sendTextToAIChat(
    text,
    `以下是我刚才那次部署的报告（${lastReport.name}，${lastReport.okCount}/${lastReport.total} 台成功）。` +
      `请帮我分析失败原因，并给出下一步该怎么排查：`
  )
}

export function runDeployTask(item?: DeployTaskItem): void {
  if (!item?.task?.uri) return
  // 运行前重读文件，避免编辑后用到过期数据
  const fresh = readDeployTaskByUri(item.task.uri)
  if (!fresh) {
    vscode.window.showErrorMessage(`任务「${item.task.name}」JSON 解析失败，请检查文件格式`)
    return
  }
  void runDeployTaskCore(fresh)
}

/** 命令：停止一个正在跑的部署任务（树上的 ■ 按钮 / 命令面板） */
export function stopDeployTask(item?: DeployTaskItem): void {
  const task = item?.task
  if (!task) return
  if (!abortDeployTask(task.id)) {
    vscode.window.showInformationMessage(`任务「${task.name}」当前没有在运行`)
    return
  }
  vscode.window.setStatusBarMessage(`$(debug-stop) 正在停止「${task.name}」（跑完当前这台后停下）`, 5000)
}

/** 批量执行：勾选多个任务逐个跑，最后出一份合并报告 */
export async function batchRunDeployTasks(): Promise<void> {
  const tasks = listDeployTasks(ctx)
  if (tasks.length === 0) {
    vscode.window.showWarningMessage('还没有部署任务，请先新建')
    return
  }
  const picks = await vscode.window.showQuickPick(
    tasks.map((t) => {
      const p = getProfiles(ctx).find((x) => x.name === t.profileId)
      const where = p?.mode === 'direct' ? '直连 · 1 台' : `${t.hosts.length} 台`
      return { label: t.name || '（未命名）', description: `${t.profileId || '（未填档案）'} · ${where}`, task: t }
    }),
    { canPickMany: true, placeHolder: '勾选要批量执行的任务' }
  )
  if (!picks || picks.length === 0) return
  const runs: DeployRun[] = []
  for (let i = 0; i < picks.length; i++) {
    runs.push(await runDeployTaskCore(picks[i].task, { label: `[${i + 1}/${picks.length}]`, openReport: false }))
  }
  await finishDeployReport(runs)
}

/** 新建任务：生成 JSON 模板文件并打开编辑器，自由编辑 */
export async function addDeployTask(): Promise<void> {
  const profiles = getProfiles(ctx)
  let profileName = ''
  if (profiles.length === 1) {
    profileName = profiles[0].name
  } else if (profiles.length > 1) {
    const pick = await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.name, description: `${p.username}@${p.host}`, profile: p })),
      { placeHolder: '选择堡垒机档案（之后可在 JSON 里改 profile 字段）' }
    )
    profileName = pick?.profile?.name ?? ''
  }
  const uri = createDeployTask(ctx, profileName)
  deployProvider.refresh()
  await vscode.window.showTextDocument(uri)
}

/** 单击树节点：打开 JSON 文件编辑 */
export async function openDeployTask(item?: DeployTaskItem): Promise<void> {
  if (!item?.task?.uri) return
  await vscode.window.showTextDocument(item.task.uri)
}

export async function deleteDeployTask(item?: DeployTaskItem): Promise<void> {
  if (!item?.task) return
  const confirm = await vscode.window.showWarningMessage(`删除部署任务「${item.task.name}」？`, { modal: true }, '删除')
  if (confirm !== '删除') return
  deleteDeployTaskFile(ctx, item.task)
  deployProvider.refresh()
}

/** 右键文件 → 加入部署任务（往 JSON 文件的 uploads 数组追加绝对路径） */
export async function addFileToDeployTask(uri?: vscode.Uri): Promise<void> {
  if (!uri) return
  const tasks = listDeployTasks(ctx)
  if (tasks.length === 0) {
    vscode.window.showWarningMessage('还没有部署任务，请先在「部署任务」视图新建')
    return
  }
  const pick = await vscode.window.showQuickPick(
    tasks.map((t) => ({ label: t.name || '（未命名）', description: `${t.profileId} · ${t.hosts.length} 台`, task: t })),
    { placeHolder: '添加到哪个部署任务' }
  )
  if (!pick) return
  try {
    const text = fs.readFileSync(pick.task.uri.fsPath, 'utf8')
    const errors: ParseError[] = []
    const raw = parseJsonc(text, errors, { allowTrailingComma: true }) as Record<string, unknown>
    if (errors.length > 0) {
      vscode.window.showErrorMessage('任务文件 JSON 有语法错误，请先修正后再试')
      return
    }
    const uploads = Array.isArray(raw.uploads) ? raw.uploads : []
    const newUploads = uploads.includes(uri.fsPath) ? uploads : [...uploads, uri.fsPath]
    // 用 jsonc-parser 的 modify/applyEdits 只改 uploads，保留文件里的中文注释和格式
    const edits = modify(text, ['uploads'], newUploads, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
    fs.writeFileSync(pick.task.uri.fsPath, applyEdits(text, edits), 'utf8')
  } catch (e) {
    vscode.window.showErrorMessage(`修改任务文件失败: ${(e as Error).message}`)
    return
  }
  deployProvider.refresh()
  const base = uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath
  vscode.window.showInformationMessage(`已把 ${base} 加入任务「${pick.task.name}」`)
}

// ---- 快捷命令 ----

