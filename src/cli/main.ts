#!/usr/bin/env node
/**
 * BastionShell CLI（A1：终端 + 单条执行；MCP 在 A2 接）。
 *
 * 用法：
 *   bastionshell list                       列出档案
 *   bastionshell run <档案> --exec "命令"    连一次、跑一条、打印输出与退出码（给测试/脚本用）
 *   bastionshell connect <档案>             交互式：裸模式直通本地终端
 *
 * 退出：`Ctrl-]`（telnet 习惯）。日志一律写 stderr —— stdout 是终端字节流，不能混。
 */

import { connectProfile } from '../engine/connect'
import { EngineSession } from '../engine/session'
import { findProfile, loadProfiles, profilesFilePath, type EngineProfile } from '../engine/profiles'
import type { CliSessionEntry } from './host'
import type { Client } from 'ssh2'
import { CliHost } from './host'
import { addTermUrlToEndpoint, startCliMcp } from './mcp'
import { groupByIntent } from '../core/actionLedger'
import { renderActionsHtml } from '../core/actionPanelHtml'
import { fetchSecret } from '../core/secretLookup'
import { startTermServer } from './termServer'
import { startUiServer } from './uiServer'

/** CLI 版本：跟扩展同号（同一份 core），先硬编码，发版时一起改 */
const VERSION = '0.3.22-cli'

/** 父进程还活着吗（Windows 上 signal 0 也能用） */
export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 父进程死了就退出。
 *
 * 为什么必须要有：桌面（Wails）spawn 了我们。如果它被强杀（更新、崩溃、任务管理器结束任务），
 * 我们会变成**孤儿 node 进程**，继续占着 SSH 连接和端口 —— 2026-11-23 用户就是看到一堆
 * `node out/cli/main.js serve` 在跑。这里每 5 秒看一眼父进程，没了就收摊。
 */
export function exitWhenParentDies(parentPid: number, logFn: (m: string) => void = () => undefined): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (isAlive(parentPid)) return
    logFn(`父进程 ${parentPid} 已退出，跟着收尾`)
    clearInterval(timer)
    process.exit(0)
  }, 5000)
  timer.unref?.()
  return timer
}

/** 取 --host-key 策略（off / known_hosts / strict） */
export function parseHostKeyPolicy(argv: string[]): 'off' | 'known_hosts' | 'strict' {
  const i = argv.indexOf('--host-key')
  const v = i >= 0 ? (argv[i + 1] ?? '').toLowerCase() : ''
  return v === 'off' || v === 'strict' ? v : 'known_hosts'
}

/** 取 --known-hosts 路径 */
export function parseKnownHostsFile(argv: string[]): string | undefined {
  const i = argv.indexOf('--known-hosts')
  const v = i >= 0 ? (argv[i + 1] ?? '').trim() : ''
  return v || undefined
}

/** 从 argv 里取 --parent-pid */
export function parseParentPid(argv: string[]): number | undefined {
  const i = argv.indexOf('--parent-pid')
  if (i < 0 || i + 1 >= argv.length) return undefined
  const n = Number(argv[i + 1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const log = (msg: string): void => {
  process.stderr.write(`[bastion] ${msg}\n`)
}

function usage(): void {
  process.stderr.write(
    [
      '用法：',
      '  bastionshell list',
      '  bastionshell run <档案> --exec "命令"   （非交互，打印输出与退出码）',
      '  bastionshell connect <档案>            （交互式终端 + MCP；Ctrl-] 退出）',
      '  bastionshell serve <档案…>            （非交互：起会话 + MCP，输出实时打印；给脚本/桌面薄壳用）',
      '                                        --passwords-stdin：从 stdin 读一行 JSON 密码表（桌面用）',
      '                                        --print-endpoint：打印机器可读端点行（宿主写端点文件）',
      '                                        --host-key=known_hosts|strict|off（默认 known_hosts：首次记录、之后必须一致）',
      '                                        --known-hosts <路径>（默认 ~/.ssh/known_hosts）',
      ''
    ].join('\n')
  )
}

/** 交互式读一次密码（不回显）：只在内存里用，不落盘 */
function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    const wasRaw = stdin.isTTY ? stdin.isRaw : false
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const onData = (d: Buffer): void => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stderr.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003') {
          cleanup()
          process.stderr.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        buf += ch
      }
    }
    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}

/**
 * 一次性密码表：桌面 spawn 时通过 **stdin** 传进来。
 *
 * 为什么不能走命令行参数：argv 会出现在进程列表里（`ps`/任务管理器），密码就泄漏了。
 * 格式是一行 JSON：`{"xzt":"密码","生产堡垒机":"密码"}`；只在内存，进程退出即丢。
 */
let passwordTable: Record<string, string> | undefined

async function loadPasswordTableFromStdin(enabled: boolean): Promise<void> {
  if (!enabled) return
  const chunks: Buffer[] = []
  await new Promise<void>((resolve) => {
    const stdin = process.stdin
    const done = (): void => resolve()
    stdin.on('data', (d: Buffer | string) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))))
    stdin.on('end', done)
    stdin.on('error', done)
    // 桌面写完就会关 stdin；万一没关，10s 后也继续（不能永远等）
    setTimeout(done, 10_000).unref?.()
  })
  const text = Buffer.concat(chunks).toString('utf8').trim()
  log(`stdin 收到 ${text.length} 字节（--passwords-stdin）`)
  if (!text) return
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const table: Record<string, string> = {}
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string') table[k] = v
    passwordTable = table
    log(`已收到 ${Object.keys(table).length} 个档案的密码（只在内存）`)
  } catch {
    log('stdin 里的密码表不是合法 JSON，忽略')
  }
}

async function ensurePassword(profileName: string, needPassword: boolean): Promise<string | undefined> {
  if (!needPassword) return undefined
  const fromTable = passwordTable?.[profileName]
  if (fromTable) return fromTable
  return readPassword(`档案「${profileName}」的密码（只留在内存）：`)
}

async function cmdList(): Promise<number> {
  const list = loadProfiles()
  if (list.length === 0) {
    process.stderr.write(`没有档案：${profilesFilePath()}\n`)
    return 1
  }
  for (const p of list) {
    process.stdout.write(
      `${p.name}\t${p.username}@${p.host}:${p.port}\t${p.mode}\t${p.authMethod === 'key' ? '密钥' : '密码'}\n`
    )
  }
  return 0
}

async function cmdRun(name: string, command: string): Promise<number> {
  const profile = findProfile(name)
  if (!profile) {
    process.stderr.write(`找不到档案「${name}」（文件：${profilesFilePath()}）\n`)
    return 2
  }
  const password = await ensurePassword(profile.name, profile.authMethod !== 'key')
    const conn = await connectProfile(profile, {
      password,
      log,
      hostKey: parseHostKeyPolicy(process.argv),
      knownHostsFile: parseKnownHostsFile(process.argv)
    })
  const session = new EngineSession(profile.name, conn.channel, { log })
  try {
    // 先等 shell 就绪：否则登录 banner 会被算进这次命令的输出
    await session.waitShellReady()
    const r = await session.exec(command, { maxMs: 5 * 60_000 })
    process.stdout.write(r.text + (r.text.endsWith('\n') ? '' : '\n'))
    if (!r.markerSeen) log('没等到结束哨兵（命令可能仍在跑）')
    log(`退出码=${r.exitCode ?? '未知'}｜耗时 ${Math.round(r.elapsedMs / 1000)}s`)
    return r.exitCode ?? (r.markerSeen ? 0 : 1)
  } finally {
    session.close()
    conn.client.end()
  }
}

async function cmdConnect(name: string): Promise<number> {
  await loadPasswordTableFromStdin(process.argv.includes('--passwords-stdin'))
  const profile = findProfile(name)
  if (!profile) {
    process.stderr.write(`找不到档案「${name}」（文件：${profilesFilePath()}）\n`)
    return 2
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('connect 需要交互式终端（stdin 不是 TTY）。脚本里请用 run。\n')
    return 2
  }
  const password = await ensurePassword(profile.name, profile.authMethod !== 'key')
  log(`连接 ${profile.username}@${profile.host}:${profile.port} …`)
  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 30
    const conn = await connectProfile(profile, {
      password,
      log,
      cols,
      rows,
      hostKey: parseHostKeyPolicy(process.argv),
      knownHostsFile: parseKnownHostsFile(process.argv)
    })
  const session = new EngineSession(profile.name, conn.channel, { log })
  // 先把登录 banner 收完再进交互（否则它会刷在用户第一屏的最上面，还会被当成输出）
  await session.waitShellReady()

  // MCP：一进程一条会话；端口随机（不抢扩展的 39311），端点写 ~/.bastionshell/mcp-cli.json
  const sessionId = `s-${process.pid.toString(16)}`
  const host = new CliHost({
    sessions: [{ id: sessionId, profile, session, client: conn.client }],
    version: VERSION,
    log: (m) => log(m)
  })
  let mcp: Awaited<ReturnType<typeof startCliMcp>> | undefined
  try {
    mcp = await startCliMcp({ host, version: VERSION, profileName: profile.name, sessionId, log })
    log(`MCP 已启动：${mcp.url}（token 在 ${mcp.file}）`)
    log('AI 客户端配置：{"url":"' + mcp.url + '","headers":{"Authorization":"Bearer <token>"}}')
  } catch (e) {
    log(`MCP 启动失败（终端仍可用）：${(e as Error).message}`)
  }
  log(`已连上（${conn.readyMs}ms）。Ctrl-] 退出。`)

  const stdout = process.stdout
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()

  // 远端 → 本地（原始字节，不加工）
  session.onData((d) => stdout.write(d))

  // 本地 → 远端；Ctrl-] 退出
  const onStdin = (d: Buffer): void => {
    if (d.length === 1 && d[0] === 0x1d) {
      void mcp?.close()
      session.close()
      conn.client.end()
      restore()
      log('已退出')
      process.exit(0)
    }
    session.write(d)
  }
  stdin.on('data', onStdin)

  const onResize = (): void => session.resize(stdout.columns || 120, stdout.rows || 30)
  process.on('SIGWINCH', onResize)
  onResize()

  const restore = (): void => {
    process.removeListener('SIGWINCH', onResize)
    stdin.removeListener('data', onStdin)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }

  session.onClose(() => {
    void mcp?.close()
    restore()
    log('远端会话已关闭')
    conn.client.end()
    process.exit(0)
  })

  return await new Promise<number>(() => {
    /* 直到 Ctrl-] / 远端关闭 */
  })
}

/**
 * `serve`：非交互的"守护进程"模式 —— 起会话 + MCP，把远端输出实时打到当前终端。
 *
 * 和 `connect` 的区别只有一个：不接管键盘（不做 raw 模式）。
 * 这样它能被脚本/测试驱动，也就是将来桌面薄壳指向的那个"后台"。
 */
async function cmdServe(names: string[], mcpFile?: string, mcpPort?: number): Promise<number> {
  await loadPasswordTableFromStdin(process.argv.includes('--passwords-stdin'))
  const parentPid = parseParentPid(process.argv)
  if (parentPid) exitWhenParentDies(parentPid, log)
  if (names.length === 0) {
    process.stderr.write('serve 需要至少一个档案名（可多个：serve a b c）\n')
    return 2
  }
  // 逐条连接：口令认证的档案会各问一次（不落盘）；密钥认证直接连
  const entries: Array<{ id: string; profile: EngineProfile; session: EngineSession; client: Client }> = []
  for (const name of names) {
    const profile = findProfile(name)
    if (!profile) {
      process.stderr.write(`找不到档案「${name}」（文件：${profilesFilePath()}）\n`)
      return 2
    }
    const password = await ensurePassword(profile.name, profile.authMethod !== 'key')
    log(`连接 ${profile.name}（${profile.username}@${profile.host}:${profile.port}）…`)
    const conn = await connectProfile(profile, {
      password,
      log,
      hostKey: parseHostKeyPolicy(process.argv),
      knownHostsFile: parseKnownHostsFile(process.argv)
    })
    const session = new EngineSession(profile.name, conn.channel, { log })
    await session.waitShellReady()
    session.onData((d) => process.stdout.write(d))
    entries.push({ id: `s-${process.pid.toString(16)}-${entries.length + 1}`, profile, session, client: conn.client })
    log(`  ✅ ${profile.name} 已连上（${conn.readyMs}ms）`)
  }

  const sessionId = entries[0].id
  // AI 新建连接（bastion_connect）：连上后追加到会话表里
  let extraSeq = 0
  const connectSession = async (profileName: string): Promise<CliSessionEntry> => {
    const p2 = findProfile(profileName)
    if (!p2) throw new Error(`找不到档案「${profileName}」（${profilesFilePath()}）`)
    if (p2.authMethod !== 'key' && !passwordTable?.[p2.name]) {
      throw new Error(
        `档案「${p2.name}」是密码认证：AI 这条路没有密码可用。` +
          `请人在终端里先连一次，或让桌面版的密码框启动它（密码只经 stdin 传，不落盘）`
      )
    }
    const pw = await ensurePassword(p2.name, p2.authMethod !== 'key')
    const conn = await connectProfile(p2, {
      password: pw,
      log,
      hostKey: parseHostKeyPolicy(process.argv),
      knownHostsFile: parseKnownHostsFile(process.argv)
    })
    const s2 = new EngineSession(p2.name, conn.channel, { log })
    await s2.waitShellReady()
    s2.onData((d) => process.stdout.write(d))
    extraSeq += 1
    return { id: `s-${process.pid.toString(16)}-${entries.length + extraSeq}`, profile: p2, session: s2, client: conn.client }
  }
  const host = new CliHost({
    sessions: entries,
    version: VERSION,
    log: (m) => log(m),
    connectSession
  })
  const mcp = await startCliMcp({
    host,
    version: VERSION,
    profileName: entries.map((e) => e.profile.name).join('+'),
    sessionId,
    log,
    port: mcpPort,
    endpointFile: mcpFile,
    // 桌面 spawn 时用 --print-endpoint：CLI 不写文件，宿主自己写（子进程写文件会 EPERM）
    writeEndpoint: !process.argv.includes('--print-endpoint')
  })
  log(`MCP 已启动：${mcp.url}`)
  log(`端点文件：${mcp.file}`)
  // 网页终端 + 只读面板：同一个 token，单开一个端口（不污染 MCP 的 HTTP 层）
  const term = await startTermServer({
    sessions: entries.map((e) => ({ id: e.id, name: e.profile.name, session: e.session })),
    token: mcp.token,
    title: entries.map((e) => e.profile.name).join('+'),
    log: (m) => log(m),
    // 行动面板的实时数据：账本 + 在跑数量 + 取消 + 变更推送
    panel: {
      async actions(sessionId, limit) {
        const records = await host.ledgerRecords(sessionId, limit)
        const groups = groupByIntent(records)
        return { html: renderActionsHtml(groups), groupsTotal: groups.length }
      },
      working: () => host.workingCount(),
      cancel: (jobId) => host.cancelJob(jobId),
      subscribe: (cb) => host.subscribe(cb)
    }
  })
  if (process.argv.includes('--print-endpoint')) {
    // 机器可读：桌面据此自己写 mcp.json
    log('端点：' + JSON.stringify({ url: mcp.url, token: mcp.token, termUrl: term.url, port: mcp.port, actualPort: mcp.port, legacy: mcp.legacy }))
  } else {
    addTermUrlToEndpoint(term.url, mcp.file)
  }

  log(`浏览器打开：${term.url}`)
  log('serve 模式：远端输出会实时打在这里；Ctrl-C 退出。')

  const shutdown = async (): Promise<void> => {
    try {
      await term.close()
      await mcp.close()
    } catch {
      /* ignore */
    }
    for (const e of entries) {
      e.session.close()
      e.client.end()
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  for (const e of entries) e.session.onClose(() => void shutdown())
  return await new Promise<number>(() => {
    /* 长驻 */
  })
}

/**
 * `ui`：只跑「界面后端」—— 把桌面 React 界面要的 HTTP + WS 协议实现在这个进程里。
 *
 * 用法：bastionshell ui [--port 18090]
 * 然后把桌面界面的 API 地址指到它（默认就是 18090，所以界面不用改）。
 */
async function cmdUi(port: number | undefined, proxyBase?: string, mcpPort?: number, mcpFile?: string): Promise<number> {
  // 会话表 + MCP 都在这个进程里：界面开的会话对 AI 可见（统一核心：一份会话、一份语义）
  // 父进程（桌面 exe）被强杀时跟着收摊 —— 否则会变成占着 18090 的孤儿：
  // 下一个 exe 起不来（端口被占），界面连上去却是个不响应的后端（2026-11-23 踩到）。
  const uiParentPid = parseParentPid(process.argv)
  if (uiParentPid) exitWhenParentDies(uiParentPid, log)
  // 档案密码：桌面经 stdin 交过来（DPAPI 解密后的明文，只在内存里）。
  // 有它，AI 的 bastion_connect 才能连密码认证的档案 —— 与 serve 模式同一套机制。
  await loadPasswordTableFromStdin(process.argv.includes('--passwords-stdin'))
  let seq = 0
  // AI 新建连接（bastion_connect）：和 serve 模式同一份实现，区别只是新会话也注册进宿主，
  // 而且它的远端输出会经 WS 推给界面（不写 stdout，免得和日志混在一起）。
  //
  // 密码优先**现取**（proxyBase → Go 的 DPAPI 接口），stdin 那份表只当兜底：
  // 启动快照会过时 —— 用户在界面里"清除已保存的密码"之后，快照里那份旧密码
  // 还能被 AI 拿去连（2026-11-27 报的"清理不掉"桌面版就是这个）。
  const liveSecret = proxyBase ? (name: string) => fetchSecret(proxyBase, name) : undefined
  const connectSession = async (profileName: string): Promise<CliSessionEntry> => {
    const p = findProfile(profileName)
    if (!p) throw new Error(`找不到档案「${profileName}」（${profilesFilePath()}）`)
    const needPw = p.authMethod !== 'key'
    let pw = ''
    if (needPw) {
      const live = liveSecret ? await liveSecret(p.name) : undefined
      pw = live ?? passwordTable?.[p.name] ?? ''
      if (!pw) {
        throw new Error(
          `档案「${p.name}」是密码认证，但本机没有它的密码（DPAPI 里没存过，网络也不好到这里去现问）。` +
            `请先在桌面里用 ⚡ 连一次并勾选保存密码，或在界面上新建连接。`
        )
      }
      if (live) log(`已从 DPAPI 现取「${p.name}」的密码（${live.length} 字符，只在内存里）`)
    }
    const conn = await connectProfile(p, {
      password: pw,
      log,
      hostKey: parseHostKeyPolicy(process.argv),
      knownHostsFile: parseKnownHostsFile(process.argv)
    })
    const s = new EngineSession(p.name, conn.channel, { log })
    const shellReady = await s.waitShellReady()
    if (!shellReady) {
      // 堡垒机档案登录后停在菜单上（选资产/选用户/输动态码），AI 走不下去。
      // 宁可如实报错，也不要返回"已连接"让 AI 对着菜单发命令。
      s.close()
      conn.client.end()
      throw new Error(
        `档案「${p.name}」登录后没有到达 shell 提示符（${p.mode === 'bastion' ? '堡垒机菜单需要人选择资产/用户' : '可能还需要交互认证'}）。` +
          `请在界面里手动连它，再用 listSessions 拿会话 id。`
      )
    }
    seq += 1
    const id = `s-${process.pid.toString(16)}-${seq}`
    // 注意：**不要**在这里 host.addSession —— CliHost.connect() 拿到 entry 后自己会 add，
    // 两边都加会撞 id（"会话 id 冲突：s-xxxx-1"，2026-11-23 实测）。
    log(`AI 新建连接：${p.name}（${p.username}@${p.host}:${p.port}）→ ${id}`)
    return { id, profile: p, session: s, client: conn.client }
  }
  const host = new CliHost({ sessions: [], version: VERSION, log: (m) => log(m), connectSession })
  let mcp: Awaited<ReturnType<typeof startCliMcp>> | undefined
  try {
    mcp = await startCliMcp({
      host,
      version: VERSION,
      profileName: '(界面)',
      sessionId: '(none)',
      port: mcpPort ?? 0,
      endpointFile: mcpFile,
      // --print-endpoint：由宿主（Go）自己写端点文件 —— 子进程写 %APPDATA% 可能被拒
      writeEndpoint: !process.argv.includes('--print-endpoint'),
      log
    })
    log(`MCP 已启动：${mcp.url}（会话由界面 / bastion_connect 提供）`)
    if (process.argv.includes('--print-endpoint')) {
      log('端点：' + JSON.stringify({ url: mcp.url, token: mcp.token, termUrl: '', port: mcp.port, actualPort: mcp.port, legacy: mcp.legacy }))
    }
  } catch (e) {
    log(`MCP 启动失败（界面仍可用）：${(e as Error).message}`)
  }
  const srv = await startUiServer({
    port,
    proxyBase,
    hostKey: parseHostKeyPolicy(process.argv),
    knownHostsFile: parseKnownHostsFile(process.argv),
    log,
    mcp: mcp ? { url: mcp.url, token: mcp.token, port: mcp.port, portFallback: mcp.portFallback, file: mcp.file } : undefined,
    hostSessions: () => host.sessionList(),
    onSession: ({ profile, session, client }) => {
      seq += 1
      const id = `s-${process.pid.toString(16)}-${seq}`
      host.addSession({ id, profile: { ...profile, name: `${profile.name}（界面）` }, session, client })
      return id
    }
  })
  log(`界面后端：http://127.0.0.1:${srv.port}/  （/api/profiles、/api/mcp-info、WS /ws）`)
  log('壳能力（secret/upload/pick-files/shell、快捷命令与转发规则）由 Go 18091 提供，其余全在这一个进程里。Ctrl-C 退出。')
  const shutdown = async (): Promise<void> => {
    try {
      await mcp?.close()
      await srv.close()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  return await new Promise<number>(() => {
    /* 长驻 */
  })
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage()
    return cmd ? 0 : 1
  }
  if (cmd === 'list') return cmdList()
  if (cmd === 'run') {
    const name = rest[0]
    const i = rest.indexOf('--exec')
    const command = i >= 0 ? rest[i + 1] : ''
    if (!name || !command) {
      usage()
      return 2
    }
    return cmdRun(name, command)
  }
  if (cmd === 'connect') {
    const name = rest[0]
    if (!name) {
      usage()
      return 2
    }
    return cmdConnect(name)
  }
  if (cmd === 'ui') {
    let port: number | undefined
    let proxyBase: string | undefined
    let mcpPort: number | undefined
    let mcpFile: string | undefined
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--port') {
        const n = Number(rest[++i])
        port = Number.isFinite(n) ? n : undefined
      } else if (rest[i] === '--proxy') {
        proxyBase = rest[++i]
      } else if (rest[i] === '--mcp-port') {
        const n = Number(rest[++i])
        mcpPort = Number.isFinite(n) ? n : undefined
      } else if (rest[i] === '--mcp-file') {
        mcpFile = rest[++i]
      } else if (rest[i] === '--mcp-port') {
        const n = Number(rest[++i])
        mcpPort = Number.isFinite(n) ? n : undefined
      } else if (rest[i] === '--mcp-file') {
        mcpFile = rest[++i]
      }
    }
    return cmdUi(port, proxyBase, mcpPort, mcpFile)
  }
  if (cmd === 'serve') {
    // 位置参数 = 档案名（可多个）；--mcp-file / --port 各带一个值
    const names: string[] = []
    let mf: string | undefined
    let mp: number | undefined
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      if (a === '--mcp-file') {
        mf = rest[++i]
        continue
      }
      if (a === '--port') {
        const n = Number(rest[++i])
        mp = Number.isFinite(n) ? n : undefined
        continue
      }
      if (a === '--parent-pid') {
        i++ // 值不能当档案名
        continue
      }
      if (a.startsWith('--')) continue
      names.push(a)
    }
    if (names.length === 0) {
      usage()
      return 2
    }
    return cmdServe(names, mf, mp)
  }
  usage()
  return 2
}

// 入口守卫：只有**直接运行**这个文件时才执行 main()。
// 否则任何 require 它的检查（scripts/check-load.mjs 会把 out/ 里每个模块都加载一遍）
// 都会把 CLI 真跑起来 → 打印用法 → process.exit(1)，把检查本身弄挂。
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`[bastion] 失败：${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
