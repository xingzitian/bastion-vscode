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
import {
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  headerMismatchError,
  httpStatusForError,
  LIST_TTL_MS,
  MODERN_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS as ALL_SUPPORTED_VERSIONS,
  TASKS_EXTENSION,
  clientSupportsTasks,
  createTaskResult,
  discoverResult,
  eraOf,
  isSupportedVersion,
  readMeta,
  taskSnapshot,
  unsupportedVersionError,
  withCache,
  withResultType
} from './mcpEra'
import * as crypto from 'crypto'
import * as net from 'net'
import type { Socket } from 'net'
import {
  MCP_INSTRUCTIONS,
  MCP_TOOL_DEFS,
  UnknownToolError,
  createToolDispatch,
  type McpSessionApi,
  type McpToolDef,
  type ToolCallContext
} from './mcpTools'
import { getJob, jobText, onJobEvent, viewOf, type ExecJob } from './execJobs'
import { decodeRequestState, encodeRequestState, inputRequestsFor } from './mrt'

/** 我们实现的 MCP 协议版本；握手时按客户端请求回（不认识就回这个最新的 legacy 版本） */
export const LATEST_PROTOCOL_VERSION = '2025-06-18'
export const SUPPORTED_PROTOCOL_VERSIONS = ALL_SUPPORTED_VERSIONS

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
  /** 作业的宿主能力（游标 / 取消）—— 保持本文件不 import vscode */
  jobs?: {
    cursorOf?: (sessionId: string) => number | undefined
    cancel?: (jobId: string) => Promise<void>
  }
}

export interface McpServer {
  /** 处理一条 JSON-RPC 消息；通知返回 null（不需要应答）。ctx 里带调用者标识 */
  handle(msg: JsonRpcRequest, ctx?: ToolCallContext, headerVersion?: string): Promise<object | null>
  /** tools/list 返回的形状，测试与「查看工具」命令共用 */
  toolList(): object[]
}

function ok(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): object {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
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

  /** 作业所在会话的屏幕游标（cursorMoved 需要它）；由宿主注入，找不到就是 undefined */
  function cursorOfJob(job: ExecJob): number | undefined {
    return opts.jobs?.cursorOf?.(job.sessionId)
  }

  /** 任务完成后要回给客户端的"原始工具结果" */
  async function resultOfJob(job: ExecJob): Promise<Record<string, unknown>> {
    const view = viewOf(job, Date.now(), cursorOfJob(job))
    const text =
      `作业 ${job.id} 已结束（${view.status}，退出码 ${view.exitCode ?? '未知'}）。` +
      `\n\n—— 输出（尾部）——\n${jobText(job, 16000)}`
    return { content: [{ type: 'text', text }], structuredContent: { ...view } }
  }

  async function handle(msg: JsonRpcRequest, ctx?: ToolCallContext, headerVersion?: string): Promise<object | null> {
    const id: JsonRpcId = msg?.id === undefined ? null : msg.id
    const isNotification = msg?.id === undefined || msg?.id === null

    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return isNotification ? null : fail(id, -32600, '无效的 JSON-RPC 请求：method 必须是字符串')
    }

    // ── 两个时代 ─────────────────────────────────────────────────────────
    // modern（2026-07-28+）：版本/身份/能力都在每个请求的 `_meta` 里，没有 initialize 握手；
    // legacy（2025-11-25 及更早）：initialize + 不带 `_meta` 的请求。
    // 我们做 dual-era：不带 `_meta` 的请求按 legacy 处理（老客户端照旧能用）。
    const meta0 = readMeta(msg.params)
    // 有些客户端只把版本放 HTTP 头（MCP-Protocol-Version / Mcp-Protocol-Version），_meta 里不放 —— 兜底一下
    const meta = meta0.version || !headerVersion ? meta0 : { ...meta0, version: headerVersion }
    const modern = eraOf(meta) === 'modern'
    // Tasks 扩展的协商只看「客户端有没有声明」，不绑协议代际（压测 P1-4：legacy 客户端声明了也该拿到任务）
    const tasksCapable = clientSupportsTasks(meta)
    if (modern && !isSupportedVersion(meta.version)) {
      const e = unsupportedVersionError(meta.version)
      return isNotification ? null : fail(id, e.code, e.message, e.data)
    }
    // 头里的版本必须和 body 的 _meta 一致（规范：不一致 → 400 + -32020）
    if (headerVersion && meta.version && headerVersion !== meta.version) {
      const e = headerMismatchError(headerVersion, meta.version)
      return isNotification ? null : fail(id, e.code, e.message)
    }

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion
        // 老客户端报了一个我们不支持的版本：别静默降级（压测 P1-3：同一条路由两种行为，
        // 头路径已经严格拒绝，legacy 路径也必须一致）
        if (typeof asked === 'string' && !isSupportedVersion(asked)) {
          const e = unsupportedVersionError(asked)
          return isNotification ? null : fail(id, e.code, e.message, e.data)
        }
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

      case 'server/discover': {
        // 2026-07-28 起服务端**必须**实现它：一次拿到支持的版本 / 能力 / 身份。
        return isNotification
          ? null
          : ok(id, discoverResult({ serverInfo: { name: serverName, version: serverVersion }, instructions, ttlMs: LIST_TTL_MS }))
      }

      case 'tasks/get': {
        const taskId = typeof msg.params?.taskId === 'string' ? (msg.params.taskId as string) : ''
        const job = taskId ? getJob(taskId) : undefined
        if (!job) return fail(id, ERR_INVALID_PARAMS, `找不到任务「${taskId}」`)
        const view = viewOf(job, Date.now(), cursorOfJob(job))
        const snapshot = taskSnapshot({
          taskId: job.id,
          status: view.status,
          prompt: view.prompt,
          hint: view.hint
        })
        if (view.status === 'completed') snapshot.result = await resultOfJob(job)
        if (view.status === 'failed') {
          snapshot.error = { code: -32603, message: view.reason === 'session_lost' ? '会话已关闭' : '任务执行失败' }
        }
        return ok(id, snapshot)
      }

      case 'tasks/update':
        // 客户端的输入（例如人对 elicitation 的应答）。我们的人是在终端里直接输的，
        // 所以这里只做确认；任务状态会由终端输出自己推进。
        return isNotification ? null : ok(id, { resultType: 'complete' })

      case 'tasks/cancel': {
        const taskId = typeof msg.params?.taskId === 'string' ? (msg.params.taskId as string) : ''
        const job = taskId ? getJob(taskId) : undefined
        if (!job) return fail(id, ERR_INVALID_PARAMS, `找不到任务「${taskId}」`)
        await opts.jobs?.cancel?.(job.id)
        return ok(id, { resultType: 'complete' })
      }

      case 'tools/list':
        return isNotification
          ? null
          : ok(id, withCache(withResultType({ tools: defs.map(toMcpTool) }, modern), modern, LIST_TTL_MS))

      case 'tools/call': {
        const name = typeof msg.params?.name === 'string' ? (msg.params.name as string) : ''
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
        if (!name) return fail(id, ERR_INVALID_PARAMS, '无效参数：tools/call 需要 name')

        // ── 权限分档（P0b）──
        // observer：只能调只读工具（list/tail/health），外加 bastion_use（绑定本身不执行任何东西）。
        // operator：可以写（exec/push/pull/habits），但不能 connect。
        // 没传 scope = full（内部调用 / 测试 / VS Code 内的 Copilot 直连）。
        const def = defs.find((d) => d.name === name)
        const scope = ctx?.scope ?? 'full'
        const toolResult = (payload: Record<string, unknown>, isError?: boolean): Record<string, unknown> => {
          const out: Record<string, unknown> = modern ? { resultType: 'complete', ...payload } : { ...payload }
          if (isError === true) out.isError = true
          return out
        }
        const refuse = (text: string): object => ok(id, toolResult({ content: [{ type: 'text', text }] }, true))
        if (def && !def.readOnly && name !== 'bastion_use' && scope === 'observer') {
          return refuse(
            `当前令牌是 **observer（只读）**：不能调用 ${name}。` +
              '需要写入就让用户用「BastionShell: 管理外部 AI 令牌」给这个客户端换一个 operator 或 full 的令牌。'
          )
        }
        if (name === 'bastion_connect' && scope !== 'full') {
          return refuse(
            `连接新目标机需要 **full** 权限（当前 ${scope}）—— connect 会在堡垒机上开新会话，所以单独提一档。` +
              '让用户用「BastionShell: 管理外部 AI 令牌」升级，或让他自己在终端里连。'
          )
        }

        // ── MRTR 第二步：客户端带着 inputResponses + requestState 重试 ──
        const inputResponses = (msg.params as { inputResponses?: unknown })?.inputResponses
        const rawState = (msg.params as { requestState?: unknown })?.requestState
        if (inputResponses && rawState !== undefined) {
          const st = decodeRequestState(rawState)
          const resumed = await opts.api.resumeTask({ jobId: st.jobId, responses: inputResponses })
          const payload: Record<string, unknown> = { content: [{ type: 'text', text: resumed.text }] }
          if (resumed.structured) payload.structuredContent = resumed.structured
          return ok(id, toolResult(payload, resumed.isError === true))
        }

        try {
          const r = await dispatch(name, args, ctx)
          const payload: Record<string, unknown> = { content: [{ type: 'text', text: r.text }] }
          // structuredContent：AI 不用再从文本里猜状态
          if (r.structured) payload.structuredContent = r.structured

          // ── MRTR：等人工输入 → InputRequiredResult（带 requestState，客户端可带 inputResponses 重试）──
          if (modern && r.structured?.status === 'input_required' && typeof r.structured?.jobId === 'string') {
            return ok(id, {
              resultType: 'input_required',
              inputRequests: inputRequestsFor(
                typeof r.structured.prompt === 'string' ? r.structured.prompt : undefined,
                typeof r.structured.hint === 'string' ? r.structured.hint : undefined
              ),
              requestState: encodeRequestState({ jobId: r.structured.jobId })
            })
          }

          // ── Tasks 扩展：长任务改成"先给句柄，客户端轮询" ──
          // 只有**声明了** io.modelcontextprotocol/tasks 的客户端才允许收到任务（规范明确要求）。
          const jobId = typeof r.structured?.jobId === 'string' ? r.structured.jobId : undefined
          const jobStatus = typeof r.structured?.status === 'string' ? r.structured.status : undefined
          if (tasksCapable && jobId && jobStatus && jobStatus !== 'completed' && jobStatus !== 'failed') {
            return ok(id, createTaskResult(jobId, jobStatus))
          }
          return ok(id, toolResult(payload, r.isError === true))
        } catch (e) {
          if (e instanceof UnknownToolError) return fail(id, ERR_INVALID_PARAMS, e.message)
          // 工具内部抛错不当成传输错误：回一条 isError 的结果，模型能读到原因
          const text = `工具执行失败：${e instanceof Error ? e.message : String(e)}`
          return ok(id, toolResult({ content: [{ type: 'text', text }] }, true))
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

export type McpScope = 'observer' | 'operator' | 'full'

/** 客户端标签归一化：只留安全字符，空/超长退回 default（值与 sessionBindings 保持一致） */
function sanitizeClientId(raw?: string): string {
  const v = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 32)
  return v || 'default'
}

export interface McpClientToken {
  token: string
  label: string
  scope: McpScope
}

export interface McpHttpOptions extends McpServerOptions {
  /** 主令牌（= default 客户端，full 权限） */
  token: string
  /** 额外为不同 AI 客户端签发的令牌（P0b：真隔离 + 权限分档） */
  clients?: McpClientToken[]
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
  const clients = opts.clients ?? []
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
    // 令牌 → 调用者身份 + 权限档。主令牌是 default/full；其余是给不同 AI 客户端签发的。
    let caller: { clientId: string; scope: McpScope } | undefined
    if (given && tokenEquals(given, token)) caller = { clientId: 'default', scope: 'full' }
    else if (given) {
      const hit = clients.find((c) => tokenEquals(given, c.token))
      if (hit) caller = { clientId: sanitizeClientId(hit.label), scope: hit.scope }
    }
    if (!caller) {
      send(
        401,
        {
          error: 'unauthorized',
          hint: '需要 Authorization: Bearer <token>（令牌见 ~/.bastionshell/mcp.json；为每个 AI 单独签发令牌请用命令 BastionShell: 管理外部 AI 令牌）'
        },
        { 'WWW-Authenticate': 'Bearer' }
      )
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
          // ── subscriptions/listen：单请求上的长连接 SSE（2026-07-28 用它取代 GET 流）──
          // 先 ack，再把作业状态变化以 notifications/tasks 推出去；客户端断开即结束。
          const m = (parsed as JsonRpcRequest).method
          if (m === 'subscriptions/listen') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-store',
              'X-Accel-Buffering': 'no',
              Connection: 'keep-alive'
            })
            const writeEvent = (event: string, data: unknown): void => {
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            }
            writeEvent('message', {
              jsonrpc: '2.0',
              method: 'notifications/subscriptions/acknowledged',
              params: { subscriptionId: `sub-${Date.now().toString(36)}`, filters: { tasks: true } }
            })
            const unsubscribe = onJobEvent((e) => {
              writeEvent('message', {
                jsonrpc: '2.0',
                method: 'notifications/tasks',
                params: { taskId: e.jobId, status: e.status, exitCode: e.exitCode, reason: e.reason }
              })
            })
            const keepAlive = setInterval(() => {
              // SSE 注释行：保持连接，客户端会忽略
              res.write(': keep-alive\n\n')
            }, 25_000)
            ;(keepAlive as unknown as { unref?: () => void }).unref?.()
            const close = (): void => {
              clearInterval(keepAlive)
              unsubscribe()
            }
            // ⚠️ 只监听 res 的 close：req 的 'close' 在请求体读完就会触发，会把订阅立刻取消
            res.on('close', close)
            log('MCP：已开 subscriptions/listen 长连接（推 notifications/tasks）')
            return
          }

          // 调用者标识：客户端可以在配置里加请求头 `X-BastionShell-Client`。
          // 它**不是鉴权**（能被伪造），只是让"某个 AI 绑定在哪条会话上"能隔离开；
          // 真隔离请给每个客户端发独立 token（P0b）。
          // 令牌已经决定了身份（P0b）；请求头只在「匿名/主令牌」时用来区分用途（P0a 的兼容路径）
          const rawClient = req.headers['x-bastionshell-client']
          const headerClient = typeof rawClient === 'string' ? rawClient : undefined
          const clientId = caller.clientId === 'default' ? headerClient ?? caller.clientId : caller.clientId
          const headerVersion = String(req.headers['mcp-protocol-version'] ?? '').trim() || undefined
          const requestHeaders = {
            version: headerVersion,
            method: typeof req.headers['mcp-method'] === 'string' ? String(req.headers['mcp-method']) : undefined,
            name: typeof req.headers['mcp-name'] === 'string' ? String(req.headers['mcp-name']) : undefined
          }
          const reply = await server.handle(
            parsed as JsonRpcRequest,
            { clientId, scope: caller.scope, headers: requestHeaders },
            headerVersion
          )
          if (reply === null) {
            // 通知：按规范用 202 且不带 body
            res.writeHead(202, { 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          // 现代请求的错误要落到对应的 HTTP 状态码（版本不支持/头不一致 → 400，未知方法 → 404）。
          // 老请求保持 200：它们会把 400 当成"端点不存在"而去探测旧传输。
          const errCode = (reply as { error?: { code?: number } }).error?.code
          const isModernRequest =
            !!headerVersion || !!readMeta((parsed as JsonRpcRequest).params).version
          send(httpStatusForError(errCode, isModernRequest), reply)
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
