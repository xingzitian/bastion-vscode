/**
 * MCP 服务端：JSON-RPC 消息处理（纯逻辑）+ Streamable HTTP 传输（Node 内置 http）。
 *
 * **不 import vscode** —— 这样它既能跑在扩展宿主里，也能被普通 Node 脚本加载
 * （测试、以及将来给 CodeBuddy / Trae 那种外部客户端用的 stdio 转发器）。
 *
 * 传输上只实现了 VS Code 真正会用到的那部分：
 *   - `POST /mcp`：JSON-RPC 请求 → 200 + `application/json`
 *   - 通知（没有 id）→ 202 + 空 body
 *   - `GET /mcp` → 405（规范允许；我们不做服务端推送，所以不开 SSE 长连接）
 *   - 鉴权：`Authorization: Bearer <token>`，只监听 127.0.0.1
 *
 * 为什么不返回 `text/event-stream`：MCP 的 Streamable HTTP 允许服务端对 POST
 * 直接回 JSON。回 JSON 少一层 SSE 解析，出错面小得多 —— 而我们的调用都是
 * 「一问一答」，用不上流式。
 */

import * as http from 'http'
import * as crypto from 'crypto'
import * as net from 'net'
import type { Socket } from 'net'
import {
  MCP_INSTRUCTIONS,
  MCP_TOOL_DEFS,
  UnknownToolError,
  createToolDispatch,
  type McpSessionApi,
  type McpToolDef
} from './mcpTools'

/** 我们实现的 MCP 协议版本；握手时按客户端请求回（不认识就回这个最新的） */
export const LATEST_PROTOCOL_VERSION = '2025-06-18'
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

type JsonRpcId = string | number | null

export interface McpServerOptions {
  api: McpSessionApi
  defs?: McpToolDef[]
  serverName?: string
  serverVersion?: string
  instructions?: string
}

export interface McpServer {
  /** 处理一条 JSON-RPC 消息；通知返回 null（不需要应答） */
  handle(msg: JsonRpcRequest): Promise<object | null>
  /** tools/list 返回的形状，测试与「查看工具」命令共用 */
  toolList(): object[]
}

function ok(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** 内部工具定义 → MCP `tools/list` 里的一条 */
export function toMcpTool(def: McpToolDef): object {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: { title: def.title, readOnlyHint: def.readOnly }
  }
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const defs = opts.defs ?? MCP_TOOL_DEFS
  const dispatch = createToolDispatch(opts.api)
  // 名字里**不要放连字符**：VS Code 把工具暴露成 `mcp_<server>_<tool>`，
  // 名字越短越不容易被模型记错（`mcp_bastionshell_bastion_exec` 比
  // `mcp_bastion-shell_bastion_exec` 好记，也少一个可能被客户端清洗的字符）。
  const serverName = opts.serverName ?? 'bastionshell'
  const serverVersion = opts.serverVersion ?? '0.0.0'
  const instructions = opts.instructions ?? MCP_INSTRUCTIONS

  async function handle(msg: JsonRpcRequest): Promise<object | null> {
    const id: JsonRpcId = msg?.id === undefined ? null : msg.id
    const isNotification = msg?.id === undefined || msg?.id === null

    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return isNotification ? null : fail(id, -32600, '无效的 JSON-RPC 请求：method 必须是字符串')
    }

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion
        const version =
          typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION
        return ok(id, {
          protocolVersion: version,
          // listChanged: false —— 工具是固定 5 个，不会变，别让客户端等通知
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: serverVersion },
          instructions
        })
      }

      // 客户端在 initialize 之后发一次，确认握手完成。通知，不需要应答。
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return null

      case 'ping':
        return isNotification ? null : ok(id, {})

      case 'tools/list':
        return isNotification ? null : ok(id, { tools: defs.map(toMcpTool) })

      case 'tools/call': {
        const name = typeof msg.params?.name === 'string' ? (msg.params.name as string) : ''
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
        if (!name) return fail(id, -32602, '无效参数：tools/call 需要 name')
        try {
          const r = await dispatch(name, args)
          const payload: Record<string, unknown> = { content: [{ type: 'text', text: r.text }] }
          if (r.isError === true) payload.isError = true
          return ok(id, payload)
        } catch (e) {
          if (e instanceof UnknownToolError) return fail(id, -32602, e.message)
          // 工具内部抛错不当成传输错误：回一条 isError 的结果，模型能读到原因
          const text = `工具执行失败：${e instanceof Error ? e.message : String(e)}`
          return ok(id, { content: [{ type: 'text', text }], isError: true })
        }
      }

      default:
        // 未实现的方法（resources/*、prompts/*…）：我们没有声明这些能力，直接说不支持
        return isNotification ? null : fail(id, -32601, `不支持的方法：${msg.method}`)
    }
  }

  return { handle, toolList: () => defs.map(toMcpTool) }
}

// ─────────────────────────── HTTP 传输 ───────────────────────────

export interface McpHttpOptions extends McpServerOptions {
  token: string
  /** 监听端口，0 = 让系统随便给一个 */
  port?: number
  host?: string
  log?: (msg: string) => void
}

export interface McpHttpHandle {
  url: string
  port: number
  token: string
  /** 实际用的端口是不是请求的那个（不是的话说明端口被占，退到了随机端口） */
  portFallback: boolean
  close(): Promise<void>
}

/** 请求体上限：正常一次工具调用只有几十 KB，超过就是有人在乱发 */
const MAX_BODY_BYTES = 1024 * 1024

function tokenEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * 端口上是不是已经有人在听。
 *
 * 为什么要**先探一次连接**而不是只等 `EADDRINUSE`：Windows 上两个进程绑同一个
 * 127.0.0.1:port 不一定会报错（没有 SO_REUSEADDR 语义那么干净），于是「第二个
 * VS Code 窗口」会悄悄和第一个共用端口，客户端连到哪个窗口是不确定的 —— 而
 * 「AI 操作的是哪个窗口的会话」必须确定。所以固定端口用之前先探一下。
 */
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port })
    const done = (v: boolean): void => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(400, () => done(false)) // 超时按「没占」处理：宁可去用固定端口
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle> {
  const server = createMcpServer(opts)
  const token = opts.token
  const path = '/mcp'
  const sockets = new Set<Socket>()
  const log = opts.log ?? ((): void => {})

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const bare = url.split('?')[0].replace(/\/+$/, '') || '/'

    const send = (status: number, body?: unknown, extraHeaders?: Record<string, string>): void => {
      const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...(extraHeaders ?? {}) }
      let text = ''
      if (body !== undefined) {
        text = JSON.stringify(body)
        headers['Content-Type'] = 'application/json'
      }
      res.writeHead(status, headers)
      res.end(text)
    }

    if (bare !== path) {
      send(404, { error: 'not found', hint: `MCP 端点是 POST ${path}` })
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 只允许 POST：GET（SSE 流）和 DELETE（结束会话）我们都不支持，按规范回 405
    if (req.method !== 'POST') {
      send(405, { error: 'method not allowed', allow: 'POST' }, { Allow: 'POST' })
      return
    }

    const auth = req.headers['authorization']
    const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!given || !tokenEquals(given, token)) {
      send(401, { error: 'unauthorized', hint: '需要 Authorization: Bearer <token>（token 见 ~/.bastionshell/mcp.json）' }, {
        'WWW-Authenticate': 'Bearer'
      })
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      if (aborted) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        send(413, { error: 'payload too large' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('error', () => {
      aborted = true
    })
    req.on('end', () => {
      if (aborted) return
      void (async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
        } catch {
          send(200, fail(null, -32700, 'JSON 解析失败'))
          return
        }
        if (Array.isArray(parsed)) {
          send(200, fail(null, -32600, '不支持批量请求（JSON-RPC batch 已从 MCP 规范移除）'))
          return
        }
        if (!parsed || typeof parsed !== 'object') {
          send(200, fail(null, -32600, '无效请求'))
          return
        }
        try {
          const reply = await server.handle(parsed as JsonRpcRequest)
          if (reply === null) {
            // 通知：按规范用 202 且不带 body
            res.writeHead(202, { 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          send(200, reply)
        } catch (e) {
          log(`MCP 处理请求失败：${e instanceof Error ? e.message : String(e)}`)
          send(500, fail(null, -32603, '服务端内部错误'))
        }
      })()
    })
  })

  httpServer.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  const host = opts.host ?? '127.0.0.1'
  let wantPort = opts.port ?? 0
  let portFallback = false

  // 固定端口先探一下：被占了就退到随机端口（多窗口时端口是共享资源）
  if (wantPort !== 0 && (await portInUse(host, wantPort))) {
    log(`MCP 端口 ${wantPort} 已被占用，改用随机端口`)
    wantPort = 0
    portFallback = true
  }

  return new Promise<McpHttpHandle>((resolve, reject) => {
    const onListenError = (e: NodeJS.ErrnoException): void => {
      if (e.code === 'EADDRINUSE' && wantPort !== 0) {
        // 兜底：探测之后到绑定之间被抢（或探测超时判断错了）
        log(`MCP 端口 ${wantPort} 绑定失败（EADDRINUSE），改用随机端口`)
        wantPort = 0
        portFallback = true
        httpServer.removeListener('error', onListenError)
        httpServer.listen(0, host, () => finish())
        return
      }
      reject(e)
    }
    httpServer.on('error', onListenError)

    const finish = (): void => {
      const addr = httpServer.address()
      const port = addr && typeof addr === 'object' ? addr.port : wantPort
      resolve({
        url: `http://${host}:${port}${path}`,
        port,
        token,
        portFallback,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            sockets.clear()
            httpServer.close(() => done())
            // close() 只等已有连接结束；上面的 destroy 保证不会挂住
            setTimeout(done, 500).unref?.()
          })
      })
    }

    httpServer.listen(wantPort, host, () => finish())
  })
}

/** 生成一个新的访问令牌（32 字节十六进制） */
export function newMcpToken(): string {
  return crypto.randomBytes(32).toString('hex')
}
