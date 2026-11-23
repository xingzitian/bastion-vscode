/**
 * CLI 宿主的 MCP 端点。
 *
 * 复用 `core/mcpServer`（HTTP + 双代际协议）与 `core/mcpTools`（工具语义），
 * 这里只做三件事：起服务、写端点文件、退出时收尾。
 *
 * 端点文件刻意**不复用扩展的 `mcp.json`**（那份是 VS Code 扩展的），
 * 用 `mcp-cli.json`，避免两个宿主互相覆盖。
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
  close(): Promise<void>
}

export function cliMcpFile(): string {
  const override = (process.env.BASTIONSHELL_SHARED_DIR ?? '').trim()
  const dir = override || path.join(os.homedir(), '.bastionshell')
  return path.join(dir, 'mcp-cli.json')
}

/** 起 MCP 服务并写端点文件（端口 0 = 让系统分配，天然避开扩展的 39311） */
export async function startCliMcp(opts: {
  host: CliHost
  version: string
  profileName: string
  sessionId: string
  log?: (msg: string) => void
  port?: number
}): Promise<CliMcp> {
  const token = newMcpToken()
  const log = opts.log ?? (() => undefined)
  const file = cliMcpFile()

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
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        url: handle.url,
        port: handle.port,
        token,
        pid: process.pid,
        profile: opts.profileName,
        sessionId: opts.sessionId,
        version: opts.version,
        startedAt: new Date().toISOString(),
        note: '此文件由 CLI 宿主写入；VS Code 扩展用 ~/.bastionshell/mcp.json（互不覆盖）'
      },
      null,
      2
    ),
    'utf8'
  )

  return {
    url: handle.url,
    port: handle.port,
    token,
    portFallback: handle.portFallback,
    file,
    async close() {
      try {
        await handle.close()
      } catch {
        /* 忽略 */
      }
      // 只删自己写的（pid 对得上才删，避免删掉后来者的文件）
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }
        if (cur.pid === process.pid) fs.unlinkSync(file)
      } catch {
        /* 文件可能已被覆盖/删除 */
      }
    }
  }
}

/** 网页终端起好之后，把它的地址补进端点文件（壳子/launcher 靠这个字段） */
export function addTermUrlToEndpoint(termUrl: string): void {
  const file = cliMcpFile()
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    cur.termUrl = termUrl
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8')
  } catch {
    /* 文件不在（比如换了进程）就算了 */
  }
}