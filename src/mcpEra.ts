/**
 * MCP 协议「两个时代」的纯逻辑（不 import vscode，好测）。
 *
 * - **modern**：`2026-07-28` 起 —— 无状态核心，版本/身份/能力放在每个请求的 `_meta`；
 *   每个结果必须带 `resultType`；列表结果还要求 `ttlMs` + `cacheScope`；有 `server/discover`。
 * - **legacy**：`2025-11-25` 及更早 —— `initialize` 握手，结果不带 `resultType`。
 *
 * 我们做 **dual-era**：老客户端（initialize + 无 `_meta`）照旧能用；新客户端走 modern，
 * 并提供 `server/discover` + Tasks 扩展（`io.modelcontextprotocol/tasks`）。
 *
 * 依据（2026-07-28）：
 *   - changelog：无会话、无 initialize；`_meta` 每请求；`resultType` 必填；
 *     `-32022` = UnsupportedProtocolVersion；`ttlMs`/`cacheScope` 必填于列表结果。
 *   - server/discover：`{ resultType, supportedVersions, capabilities, _meta.serverInfo, instructions?, ttlMs, cacheScope }`
 *   - Tasks 扩展：客户端用 `_meta.clientCapabilities.extensions['io.modelcontextprotocol/tasks']` 声明；
 *     服务端在 discover 的 `capabilities.extensions` 里声明；任务结果 `resultType:'task'` + `taskId/status/ttlMs/pollIntervalMs`。
 */

export const MODERN_VERSION = '2026-07-28'
/** 我们仍然会回声支持的 legacy 版本（按 initialize 握手） */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS]

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel'

/** JSON-RPC 错误码（2026-07-28 重新编号后的） */
export const ERR_UNSUPPORTED_VERSION = -32022
export const ERR_INVALID_PARAMS = -32602
export const ERR_HEADER_MISMATCH = -32020
export const ERR_METHOD_NOT_FOUND = -32601

export interface RequestMeta {
  version?: string
  clientInfo?: { name?: string; version?: string }
  clientCapabilities?: Record<string, unknown>
  logLevel?: string
}

/** 从请求 params 里取 `_meta`（容忍缺失/类型不对） */
export function readMeta(params: unknown): RequestMeta {
  const p = params as { _meta?: Record<string, unknown> } | undefined
  const m = p?._meta
  if (!m || typeof m !== 'object') return {}
  const version = typeof m[META_VERSION] === 'string' ? (m[META_VERSION] as string) : undefined
  const ci = m[META_CLIENT_INFO] as { name?: unknown; version?: unknown } | undefined
  const caps = m[META_CLIENT_CAPS] as Record<string, unknown> | undefined
  const logLevel = typeof m[META_LOG_LEVEL] === 'string' ? (m[META_LOG_LEVEL] as string) : undefined
  return {
    version,
    clientInfo:
      ci && typeof ci === 'object'
        ? { name: typeof ci.name === 'string' ? ci.name : undefined, version: typeof ci.version === 'string' ? ci.version : undefined }
        : undefined,
    clientCapabilities: caps && typeof caps === 'object' ? caps : undefined,
    logLevel
  }
}

/** 这个请求算哪个时代：带 `_meta` 版本 → modern；不带 → legacy（老客户端照旧能用） */
export function eraOf(meta: RequestMeta): 'modern' | 'legacy' {
  return meta.version ? 'modern' : 'legacy'
}

export function isSupportedVersion(v: string | undefined): boolean {
  return !!v && SUPPORTED_PROTOCOL_VERSIONS.includes(v)
}

/** 不支持版本时的错误对象（-32022，带 supported/requested） */
export function unsupportedVersionError(requested: string | undefined): {
  code: number
  message: string
  data: { supported: string[]; requested?: string }
} {
  return {
    code: ERR_UNSUPPORTED_VERSION,
    message: 'Unsupported protocol version',
    data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested }
  }
}

/** modern 结果必须带 resultType；列表类还要 ttlMs + cacheScope */
export function withResultType<T extends Record<string, unknown>>(result: T, modern: boolean): T & { resultType?: 'complete' } {
  return modern ? { ...result, resultType: 'complete' } : result
}

export function withCache<T extends Record<string, unknown>>(result: T, modern: boolean, ttlMs: number): T & { ttlMs?: number; cacheScope?: 'public' | 'private' } {
  return modern ? { ...result, ttlMs, cacheScope: 'private' } : result
}

/** 客户端有没有声明 Tasks 扩展（modern 才看得到） */
export function clientSupportsTasks(meta: RequestMeta): boolean {
  const caps = meta.clientCapabilities as { extensions?: Record<string, unknown> } | undefined
  return !!caps?.extensions && Object.prototype.hasOwnProperty.call(caps.extensions, TASKS_EXTENSION)
}

/** server/discover 的结果 */
export function discoverResult(input: {
  serverInfo: { name: string; version: string }
  instructions?: string
  ttlMs: number
}): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: {
      tools: { listChanged: false },
      extensions: { [TASKS_EXTENSION]: {} }
    },
    instructions: input.instructions,
    _meta: { [META_SERVER_INFO]: input.serverInfo },
    ttlMs: input.ttlMs,
    cacheScope: 'private'
  }
}

/** 我们的作业状态 → Tasks 的任务状态（词是一样的，这里保留一层是在做显式约定） */
export function toTaskStatus(status: string): 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled' {
  switch (status) {
    case 'input_required':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return status
    default:
      return 'working'
  }
}

export const TASK_TTL_MS = 10 * 60 * 1000
export const TASK_POLL_INTERVAL_MS = 1000

/** `resultType:'task'` 的创建结果 */
export function createTaskResult(taskId: string, status: string): Record<string, unknown> {
  return {
    resultType: 'task',
    taskId,
    status: toTaskStatus(status),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS
  }
}

/** `tasks/get` 的结果 */
export function taskSnapshot(input: {
  taskId: string
  status: string
  /** completed 时的原始工具结果（content/structuredContent） */
  result?: Record<string, unknown>
  /** failed 时的 JSON-RPC 错误 */
  error?: { code: number; message: string }
  prompt?: string
  hint?: string
}): Record<string, unknown> {
  const status = toTaskStatus(input.status)
  const out: Record<string, unknown> = {
    resultType: 'complete',
    taskId: input.taskId,
    status,
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS
  }
  if (status === 'completed' && input.result) out.result = input.result
  if (status === 'failed') {
    out.error = input.error ?? { code: -32603, message: '任务失败' }
  }
  if (status === 'input_required') {
    // 需要人输入：用 elicitation 形状表达（客户端可以把它展示给人）
    out.inputRequests = {
      prompt: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: [input.prompt ?? '需要人工输入', input.hint ?? ''].filter(Boolean).join('\n'),
          requestedSchema: { type: 'object', properties: {} }
        }
      }
    }
  }
  return out
}

/** 列表/发现类结果的缓存 TTL（工具列表变化不频繁） */
export const LIST_TTL_MS = 5 * 60 * 1000

/**
 * JSON-RPC 错误码 → HTTP 状态（2026-07-28 的 Streamable HTTP 要求）：
 *   -32022 UnsupportedProtocolVersion → 400
 *   -32020 HeaderMismatch            → 400
 *   -32601 Method not found          → 404（现代端点的规则）
 * 其余错误仍是 200（错误在 JSON-RPC 层）。
 *
 * ⚠️ 只对**现代请求**套用这些状态码：老客户端把 400 当"端点不存在"，
 * 会退到 HTTP+SSE 探测，反而更乱（见规范的 Backward Compatibility 一节）。
 */
export function httpStatusForError(errorCode: number | undefined, modern: boolean): number {
  if (!modern || errorCode === undefined) return 200
  if (errorCode === ERR_UNSUPPORTED_VERSION || errorCode === ERR_HEADER_MISMATCH) return 400
  if (errorCode === ERR_METHOD_NOT_FOUND) return 404
  return 200
}

/** 头与 body 里的版本不一致时的错误（-32020） */
export function headerMismatchError(headerVersion: string, metaVersion: string): {
  code: number
  message: string
} {
  return {
    code: ERR_HEADER_MISMATCH,
    message: `Header mismatch: MCP-Protocol-Version '${headerVersion}' 与请求体 _meta 里的 '${metaVersion}' 不一致`
  }
}