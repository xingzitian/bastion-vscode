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
  waitForExecJob,
  readExecJob,
  cancelExecJob,
  resumeExecJob,

  listProfilesForAI,
  listSessions,
  pullFile,
  pushFile,
  sessionEntries,
  sessionHealthLines,
  sessionStateLabel,
  tailScreen
} from './aiBridge'
import {
  bindSession,
  bindingsOf,
  describeBindings,
  loadBindings,
  normalizeClientId,
  resolveSessionRef,
  saveBindings,
  unbind
} from './sessionBindings'
import { describeDanger, findDangerous } from './danger'
import { getDangerRules } from './dangerConfig'
import { appendHabit, habitsForAI, isPrivilegeMode, setPrivilege } from './habits'
import { log } from './log'
import { lastSweepCountOf } from './sessionBindings'
import { cachedNote, createExecMemo } from './execIdempotency'
import type { ExecResponse } from './aiBridge'
import { getMcpEndpointInfo } from './state'
import { MCP_TOOL_DEFS } from './mcpTools'
import type { McpSessionApi } from './mcpTools'

/**
 * 执行远端命令前先过一遍高危规则。
 *
 * 注意这里对 AI 是**直接拒绝**（不因客户端的「总是允许」放行）：换成人自己敲
 * 才有确认流程 —— AI 幻觉出来的 `rm -rf /` 不值得给它一次机会。
 */
/** P2-b 的幂等表：进程内、10 分钟 TTL（重试窗口远小于这个） */
const execMemo = createExecMemo()

export async function execChecked(input: {
  command?: string
  session?: string
  terminal?: string
  clientId?: string
  /** 仅 LM 直连（Copilot）用：没有绑定时允许回退到活动终端 */
  allowActiveFallback?: boolean
  /** P2-a：乐观并发校验（上次读到的 cursor） */
  expectCursor?: number
  /** P2-b：同一件事重试时带同一个 key，服务端不会重复执行 */
  idempotencyKey?: string
  /** 本次最多阻塞多久（默认 15s，夹到 55s；超过转作业） */
  waitMs?: number
  /** 输出静止多久算没输出（默认 15s） */
  quietMs?: number
  /** shell（默认）| interactive（只发不等） */
  mode?: 'shell' | 'interactive'
  /** 立刻返回作业句柄 */
  background?: boolean
  /** 日志 tee 到远端（人仍可见） */
  logToFile?: boolean
  /** 会话上有命令在跑时强行插队（默认拒绝） */
  force?: boolean
}): Promise<ExecResponse> {
  const command = input.command ?? ''
  const hits = findDangerous(command, getDangerRules())
  if (hits.length > 0) {
    log(`拦截高危命令（AI 执行路径）：${describeDanger(hits)}`)
    return {
      text:
        '⚠️ 该命令包含高危操作，已被 BastionShell 拦截，不会执行。\n命中原因：\n' +
        describeDanger(hits) +
        '\n\n请让用户自己判断。如果确实要执行，请让用户在堡垒机终端里手动敲，或在部署任务/快捷命令里走人工确认流程。',
      structured: { status: 'failed', reason: 'dangerous' }
    }
  }
  const run = (): Promise<ExecResponse> =>
    execRemote({
      command,
      session: input.session,
      terminal: input.terminal,
      clientId: input.clientId,
      allowActiveFallback: input.allowActiveFallback,
      expectCursor: input.expectCursor,
      waitMs: input.waitMs,
      quietMs: input.quietMs,
      mode: input.mode,
      background: input.background,
      logToFile: input.logToFile,
      force: input.force
    })

  // P2-b：幂等键。没带 key 就普通执行（服务端无法保证不重复执行，工具说明里写明了）。
  const key = (input.idempotencyKey ?? '').trim()
  if (!key) return run()
  const scope = `${normalizeClientId(input.clientId)}|${(input.session ?? input.terminal ?? '').trim()}|${key}`
  // memo 只缓存文本（结构化结果不缓存：缓存命中本来就是"重复调用"）
  const r = await execMemo.run(scope, async () => (await run()).text)
  return { text: r.cached ? r.text + cachedNote(key, r.joined) : r.text }
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
export function healthReport(clientId?: string, headers?: { version?: string; method?: string; name?: string }): string {
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
  // 头校验：规范要求 MCP-Protocol-Version / Mcp-Method / Mcp-Name，我们**还没强制**（怕把手配好的客户端全打死）。
  // 但必须让 AI 知道「将来会强制」，这样它能提前提醒用户升级客户端。
  if (headers) {
    const h = headers
    const mark = (v?: string): string => (v ? `✓ ${v}` : '✗ 没带')
    lines.push(
      `- 本次请求头：MCP-Protocol-Version ${mark(h.version)}｜Mcp-Method ${mark(h.method)}｜Mcp-Name ${mark(h.name)}`,
      '- 头校验：**尚未强制**（0.3.10 测试期故意放宽）。规范 2026-07-28 要求每个 POST 都带这几个头，' +
        '将来强制之后，缺头的客户端会被 **400 + -32020（HeaderMismatch）** 拒绝。' +
        '如果你的客户端现在没带，建议尽早补上（`Mcp-Method` 必填；`tools/call` 还要 `Mcp-Name`）。'
    )
  }
  const sessions = sessionHealthLines()
  // 绑定清扫掉的条数：让 AI 分清「我没绑定」和「绑定指向的会话真的没了」
  {
    const swept = lastSweepCountOf()
    if (swept > 0) lines.push(`- 绑定清扫：刚清掉 ${swept} 条指向已关闭会话的绑定`)
  }
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
  lines.push('', describeBindings(loadBindings(), clientId ?? 'default'))
  lines.push(
    '',
    '端点文件：`~/.bastionshell/mcp.json`（token 固定，端口以设置 `bastion.mcpPort` 为准）。',
    '如果本工具能返回这段内容，就说明端点、鉴权、协议都是好的 —— 之前那次失败属于偶发（例如扩展刚重载完），**直接重试原来的调用即可**。'
  )
  return lines.join('\n')
}

/**
 * `bastion_use`：把**调用它的客户端**绑定到某条会话（别名 A/B…）。
 *
 * 这就是「让 AI 记住自己在哪条会话上」的落地方式：绑定存在服务端，
 * 模型自己的上下文被压缩/重开也不影响 —— 它问一次 listSessions 就能拿回自己的绑定。
 */
export async function useSession(input: {
  session?: string
  as?: string
  unbind?: boolean
  clientId?: string
}): Promise<string> {
  const clientId = normalizeClientId(input.clientId)
  const sel = (input.session ?? '').trim()
  if (!sel) return '错误：bastion_use 需要 session 参数（会话 id 如 s-7f3a，或终端名的一部分）'
  const entries = sessionEntries()
  const f = loadBindings()
  const cb = bindingsOf(f, clientId)

  if (input.unbind) {
    const alias = Object.keys(cb.sessions).find((a) => a.toLowerCase() === sel.toLowerCase())
    const removed = unbind(f, clientId, alias ? { alias } : { sessionId: sel })
    if (!removed) return `没有找到要解绑的 ${sel}。${describeBindings(f, clientId)}`
    saveBindings(f)
    return `已解绑 ${sel}。${describeBindings(f, clientId)}`
  }

  const resolved = resolveSessionRef(entries.map((x) => x.ref), sel, { mode: 'write', client: cb })
  if (!resolved.ok) return resolved.message
  const res = bindSession(f, clientId, resolved.ref, input.as)
  if ('error' in res) return res.error
  saveBindings(f)
  const head = res.existing
    ? `${resolved.ref.id} 已经绑定为 ${res.alias} 了（没有重复添加）。`
    : `已绑定 ${res.alias} = ${resolved.ref.id}（${resolved.ref.name}，${sessionStateLabel(resolved.ref.state as never)}）。`
  return `${head}\n${describeBindings(f, clientId)}\n\n之后 bastion_exec 可以传 session: "${res.alias}" 或 "${resolved.ref.id}"；只绑了一条时不传也行。`
}

/** 给 MCP 服务用的会话能力实现 */
export const sessionApi: McpSessionApi = {
  listSessions: async (input) => listSessions(input?.clientId),
  use: useSession,
  listProfiles: async () => listProfilesForAI(),
  exec: execChecked,
  connect: (input) => connectToTarget(input),
  habits: habitsTool,
  tail: async (input) => tailScreen(input),
  push: async (input) => pushFile(input),
  pull: async (input) => pullFile(input),
  wait: async (input) => waitForExecJob(input),
  job: async (input) => readExecJob(input),
  cancel: async (input) => cancelExecJob(input),
  resumeTask: async (input) => resumeExecJob(input),
  health: async (input) => healthReport(input?.clientId, input?.headers)
}
