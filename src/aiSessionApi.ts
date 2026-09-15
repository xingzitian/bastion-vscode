/**
 * 会话能力的**唯一实现**：语言模型工具（Copilot 直连）和 MCP 工具都调这里。
 *
 * 为什么要有这一层：拦高危命令、提权习惯、个人习惯这些逻辑，如果 LM 工具
 * 一套、MCP 工具另一套，迟早会分叉成「Copilot 那条拦、MCP 那条不拦」。
 * 所以两边共用同一个函数 —— 行为差异只可能来自「谁调用」，不来自「哪条路」。
 */

import {
  connectToTarget,
  execRemote,
  listProfilesForAI,
  listSessions,
  pullFile,
  pushFile,
  sessionHealthLines,
  sessionStateLabel,
  tailScreen
} from './aiBridge'
import { describeDanger, findDangerous } from './danger'
import { getDangerRules } from './dangerConfig'
import { appendHabit, habitsForAI, isPrivilegeMode, setPrivilege } from './habits'
import { log } from './log'
import { getMcpEndpointInfo } from './state'
import { MCP_TOOL_DEFS } from './mcpTools'
import type { McpSessionApi } from './mcpTools'

/**
 * 执行远端命令前先过一遍高危规则。
 *
 * 注意这里对 AI 是**直接拒绝**（不因客户端的「总是允许」放行）：换成人自己敲
 * 才有确认流程 —— AI 幻觉出来的 `rm -rf /` 不值得给它一次机会。
 */
export async function execChecked(input: { command?: string; terminal?: string }): Promise<string> {
  const command = input.command ?? ''
  const hits = findDangerous(command, getDangerRules())
  if (hits.length > 0) {
    log(`拦截高危命令（AI 执行路径）：${describeDanger(hits)}`)
    return (
      '⚠️ 该命令包含高危操作，已被 BastionShell 拦截，不会执行。\n命中原因：\n' +
      describeDanger(hits) +
      '\n\n请让用户自己判断。如果确实要执行，请让用户在堡垒机终端里手动敲，或在部署任务/快捷命令里走人工确认流程。'
    )
  }
  return execRemote({ command, terminal: input.terminal })
}

/** 个人习惯：读 / 记一条 / 改提权方式（LM 工具与 MCP 工具共用） */
export async function habitsTool(input: {
  action?: string
  profile?: string
  habit?: string
  privilege?: string
}): Promise<string> {
  const action = input.action ?? 'read'
  const profile = input.profile?.trim() || undefined
  try {
    if (action === 'read') {
      return `当前个人习惯（${profile ?? '全局'}）：\n${habitsForAI(profile)}`
    }
    if (action === 'remember') {
      const habit = input.habit ?? ''
      if (!habit.trim()) return '错误：action=remember 需要 habit 参数（要记下来的那句话）'
      const added = appendHabit(profile, habit)
      return (
        (added ? `已记录习惯（${profile ?? '全局'}）：${habit}` : `这条习惯之前已经记过，跳过：${habit}`) +
        `\n\n当前习惯：\n${habitsForAI(profile)}`
      )
    }
    if (action === 'setPrivilege') {
      if (!isPrivilegeMode(input.privilege)) {
        return '错误：privilege 必须是 none / sudo / sudo-i / ask 之一'
      }
      setPrivilege(profile, input.privilege)
      return `已把提权习惯设为 ${input.privilege}（${profile ?? '全局'}）。\n\n当前习惯：\n${habitsForAI(profile)}`
    }
    return '错误：action 必须是 read / remember / setPrivilege'
  } catch (e) {
    const msg = `操作个人习惯文件失败: ${(e as Error).message}`
    log(msg)
    return msg
  }
}

/**
 * 端点自检（`bastion_health`）。
 *
 * 存在的理由很具体：AI 遇到「工具调用出错」时，分不清是
 * 「端点根本没连上」还是「连上了、工具里报错」—— 于是它容易放弃
 * （真实案例：listSessions 报错后它就转而让用户手工敲命令）。
 * 有了这个工具，AI 的自救路径是：**先重试一次 → 再调 bastion_health → 还不行就明确告诉用户「重启 MCP 服务器」**。
 */
export function healthReport(): string {
  const ep = getMcpEndpointInfo()
  const lines: string[] = ['BastionShell MCP 端点自检']
  if (!ep) {
    lines.push(
      '⚠️ 端点信息为空：MCP 服务当前没在跑（这可能正是刚才那次调用失败的原因）。',
      '请让用户在 VS Code 里重启 MCP 服务器：命令面板 → `MCP: List Servers` → 选 BastionShell → Restart；',
      '或者直接重载窗口（`Developer: Reload Window`）。重启后本工具会返回正常内容。'
    )
    return lines.join('\n')
  }
  lines.push(
    `- 端点：${ep.url}${ep.portFallback ? '（⚠️ 默认端口被占用，已退到随机端口；VS Code 里缓存的可能是旧端口）' : ''}`,
    `- 扩展版本：${ep.version ?? '未知'}`,
    `- 工具：${MCP_TOOL_DEFS.length} 个`
  )
  const sessions = sessionHealthLines()
  if (sessions.length === 0) {
    lines.push('- 会话：0 个（工具本身是通的 —— 现在是「没连服务器」，不是「调用出错」）')
  } else {
    const usable = sessions.filter((s) => s.state === 'shell').length
    lines.push(`- 会话：${sessions.length} 个（**${usable} 个能直接执行命令**）`)
    for (const s of sessions) lines.push(`  - ${s.name}：${sessionStateLabel(s.state)}`)
    if (usable === 0) {
      // 这句是给 AI 看的：以前它看到「0 个能直接执行命令」还是会硬着头皮 exec，
      // 结果命令被敲进菜单里。所以这里把「为什么 0 个」和「该谁来做」写明白。
      lines.push(
        '⚠️ 现在**没有能直接执行命令的会话**：会话还停在堡垒机菜单上（要选资产 / 选账号 / 输密码）。',
        '请让用户在终端里手动走完这一步；他做完之后你可以直接在同一条会话上 bastion_exec（不需要重新认证）。',
        '不要往菜单里发命令 —— 它会被菜单当成菜单输入吃掉。'
      )
    }
  }
  lines.push(
    '',
    '端点文件：`~/.bastionshell/mcp.json`（token 固定，端口以设置 `bastion.mcpPort` 为准）。',
    '如果本工具能返回这段内容，就说明端点、鉴权、协议都是好的 —— 之前那次失败属于偶发（例如扩展刚重载完），**直接重试原来的调用即可**。'
  )
  return lines.join('\n')
}

/** 给 MCP 服务用的会话能力实现 */
export const sessionApi: McpSessionApi = {
  listSessions: async () => listSessions(),
  listProfiles: async () => listProfilesForAI(),
  exec: execChecked,
  connect: (input) => connectToTarget(input),
  habits: habitsTool,
  tail: async (input) => tailScreen(input),
  push: async (input) => pushFile(input),
  pull: async (input) => pullFile(input),
  health: async () => healthReport()
}
