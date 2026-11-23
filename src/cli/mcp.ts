/**
 * CLI 宿主的 MCP 端点。
 *
 * 复用 `core/mcpServer`（HTTP + 双代际协议）与 `core/mcpTools`（工具语义），
 * 这里只做三件事：起服务、写端点文件、退出时收尾。
 *
 * 两种端点文件：
 *   - 默认 `mcp-cli.json`（CLI 自己的一份，和扩展的 `mcp.json` 互不覆盖）；
 *   - `--mcp-file …\mcp.json --port 39311`：**接管旧身份**（桌面版以前写的那份，
 *     schema 也按旧格式写），这样现有客户端配置一个字都不用改 —— B 阶段落地前必须走这条。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { newMcpToken, startMcpHttpServer, type McpHttpHandle } from '../core/mcpServer'
import { MCP_TOOL_DEFS } from '../core/mcpTools'
import { loadActionRecords } from '../core/actionLedgerIo'
import type { CliHost } from './host'

export interface CliMcp {
  url: string
  port: number
  token: string
  portFallback: boolean
  file: string
  /** true = 这个文件是旧桌面版的 mcp.json（schema 也按旧的写） */
  legacy: boolean
  close(): Promise<void>
}

export function cliMcpFile(): string {
  const override = (process.env.BASTIONSHELL_SHARED_DIR ?? '').trim()
  const dir = override || path.join(os.homedir(), '.bastionshell')
  return path.join(dir, 'mcp-cli.json')
}

/** 读旧端点文件里的 token（接管身份时复用，客户端配置才不用改） */
function reusedToken(file: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown }
    return typeof j.token === 'string' && j.token.length > 0 ? j.token : undefined
  } catch {
    return undefined
  }
}

export interface StartCliMcpOptions {
  host: CliHost
  version: string
  profileName: string
  sessionId: string
  log?: (msg: string) => void
  /** 0/省略 = 系统分配 */
  port?: number
  /** 端点文件（默认 mcp-cli.json） */
  endpointFile?: string
  /** 强制新 token（默认会复用已有文件里的 token） */
  freshToken?: boolean
}

export async function startCliMcp(opts: StartCliMcpOptions): Promise<CliMcp> {
  const log = opts.log ?? (() => undefined)
  const file = opts.endpointFile?.trim() || cliMcpFile()
  const legacy = path.basename(file).toLowerCase() === 'mcp.json'
  const token = (!opts.freshToken && reusedToken(file)) || newMcpToken()

  const handle: McpHttpHandle = await startMcpHttpServer({
    api: opts.host.api(),
    defs: MCP_TOOL_DEFS,
    token,
    port: opts.port ?? 0,
    host: '127.0.0.1',
    serverName: 'bastionshell-cli',
    serverVersion: opts.version,
    log,
    // 账本已经是同一份 JSONL，直接喂给 /ui 的只读接口
    ui: { listActions: () => loadActionRecords(300) }
  })

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const note = handle.portFallback
    ? '默认端口被占用，已退到随机端口（本机可能还开着另一个 BastionShell 或 VS Code 扩展）'
    : undefined
  const payload = legacy
    ? {
        // 旧桌面版的 schema：老客户端可能只看这几个字段
        url: handle.url,
        // 旧字段 port = 请求的端口；请求 0（让系统分配）时写实际端口更有用
        port: opts.port && opts.port > 0 ? opts.port : handle.port,
        actualPort: handle.port,
        token,
        updatedAt: new Date().toLocaleString('zh-CN'),
        ...(note ? { note } : {}),
        // 额外字段（新客户端可读，旧客户端忽略）
        host: 'cli',
        profile: opts.profileName,
        sessionId: opts.sessionId,
        version: opts.version
      }
    : {
        url: handle.url,
        port: handle.port,
        token,
        pid: process.pid,
        profile: opts.profileName,
        sessionId: opts.sessionId,
        version: opts.version,
        startedAt: new Date().toISOString(),
        ...(note ? { note } : {}),
        note2: '此文件由 CLI 宿主写入；VS Code 扩展用 ~/.bastionshell/mcp.json（互不覆盖）'
      }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')

  return {
    url: handle.url,
    port: handle.port,
    token,
    portFallback: handle.portFallback,
    file,
    legacy,
    async close() {
      try {
        await handle.close()
      } catch {
        /* 忽略 */
      }
      // 只删自己写的（token 对得上才删，避免删掉后来者的文件）
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string; pid?: number }
        if (cur.token === token && (legacy || cur.pid === process.pid)) fs.unlinkSync(file)
      } catch {
        /* 文件可能已被覆盖/删除 */
      }
    }
  }
}

/** 网页终端起好之后，把它的地址补进端点文件（壳子/launcher 靠这个字段） */
export function addTermUrlToEndpoint(termUrl: string, endpointFile?: string): void {
  const file = endpointFile?.trim() || cliMcpFile()
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    cur.termUrl = termUrl
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8')
  } catch {
    /* 文件不在（比如换了进程）就算了 */
  }
}