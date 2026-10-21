// MCP「两个时代」（legacy initialize ↔ modern 2026-07-28）的纯逻辑。
//
// 这一组盯的是：老客户端不许被打断；新客户端拿到的形状必须符合 2026-07-28；
// Tasks 只能发给声明了扩展的客户端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIST_TTL_MS,
  MODERN_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TASKS_EXTENSION,
  clientSupportsTasks,
  createTaskResult,
  discoverResult,
  eraOf,
  isSupportedVersion,
  readMeta,
  taskSnapshot,
  toTaskStatus,
  unsupportedVersionError,
  headerMismatchError,
  httpStatusForError,
  withCache,
  withResultType
} from '../mcpEra'

const metaOf = (version: string, caps: Record<string, unknown> = {}) => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': caps
  }
})

test('支持版本清单包含 2026-07-28 和两个 legacy 版本', () => {
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(MODERN_VERSION))
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2025-06-18'))
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2024-11-05'))
})

test('★ 不带 _meta 的请求按 legacy 处理（老客户端不许被打断）', () => {
  assert.equal(eraOf(readMeta({})), 'legacy')
  assert.equal(eraOf(readMeta({ name: 'x' })), 'legacy')
  assert.equal(eraOf(readMeta(metaOf(MODERN_VERSION))), 'modern')
})

test('readMeta 容忍畸形输入（不抛异常，返回空对象）', () => {
  assert.deepEqual(readMeta(undefined), {})
  assert.deepEqual(readMeta({ _meta: 'not-an-object' }), {})
  assert.deepEqual(readMeta({ _meta: { 'io.modelcontextprotocol/protocolVersion': 42 } }), {
    version: undefined,
    clientInfo: undefined,
    clientCapabilities: undefined,
    logLevel: undefined
  })
})

test('不支持的版本 → -32022，并带 supported / requested', () => {
  assert.equal(isSupportedVersion('1900-01-01'), false)
  const err = unsupportedVersionError('1900-01-01')
  assert.equal(err.code, -32022)
  assert.deepEqual(err.data.supported, SUPPORTED_PROTOCOL_VERSIONS)
  assert.equal(err.data.requested, '1900-01-01')
})

test('modern 结果必须带 resultType；legacy 结果不带', () => {
  assert.deepEqual(withResultType({ tools: [] }, true), { tools: [], resultType: 'complete' })
  assert.deepEqual(withResultType({ tools: [] }, false), { tools: [] })
})

test('modern 的列表结果带 ttlMs + cacheScope=private（工具列表按令牌可能不同，不能 public）', () => {
  assert.deepEqual(withCache({ tools: [] }, true, LIST_TTL_MS), {
    tools: [],
    ttlMs: LIST_TTL_MS,
    cacheScope: 'private'
  })
  assert.deepEqual(withCache({ tools: [] }, false, LIST_TTL_MS), { tools: [] })
})

test('server/discover 的形状符合 2026-07-28', () => {
  const r = discoverResult({ serverInfo: { name: 'bastionshell', version: '0.3.9' }, instructions: 'hi', ttlMs: 1000 })
  assert.equal(r.resultType, 'complete')
  assert.deepEqual(r.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS)
  assert.deepEqual((r.capabilities as any).tools, { listChanged: false })
  assert.ok((r.capabilities as any).extensions[TASKS_EXTENSION], '必须声明 Tasks 扩展')
  assert.deepEqual((r._meta as any)['io.modelcontextprotocol/serverInfo'], { name: 'bastionshell', version: '0.3.9' })
  assert.equal(r.ttlMs, 1000)
  assert.equal(r.cacheScope, 'private')
})

test('★ 只有声明了 Tasks 扩展的客户端才看得见任务支持', () => {
  assert.equal(clientSupportsTasks(readMeta(metaOf(MODERN_VERSION))), false)
  assert.equal(
    clientSupportsTasks(readMeta(metaOf(MODERN_VERSION, { extensions: { [TASKS_EXTENSION]: {} } }))),
    true
  )
  // legacy 客户端即便带了奇怪的 caps，也不算
  assert.equal(clientSupportsTasks(readMeta({})), false)
})

test('CreateTaskResult：resultType=task + taskId + ttlMs + pollIntervalMs', () => {
  const r = createTaskResult('j-0001', 'working')
  assert.equal(r.resultType, 'task')
  assert.equal(r.taskId, 'j-0001')
  assert.equal(r.status, 'working')
  assert.equal(typeof r.ttlMs, 'number')
  assert.equal(r.pollIntervalMs, 1000)
})

test('作业状态 → 任务状态（词必须完全对齐）', () => {
  for (const s of ['working', 'input_required', 'completed', 'failed', 'cancelled']) {
    assert.equal(toTaskStatus(s), s)
  }
  assert.equal(toTaskStatus('completed'), 'completed')
  assert.equal(toTaskStatus('nonsense'), 'working')
})

test('tasks/get：completed 带 result、failed 带 error、input_required 带 inputRequests', () => {
  const done = taskSnapshot({ taskId: 'j-1', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } })
  assert.equal(done.status, 'completed')
  assert.ok(done.result)
  assert.equal((done.result as any).content[0].text, 'ok')

  const failed = taskSnapshot({ taskId: 'j-2', status: 'failed', error: { code: -32603, message: '会话丢了' } })
  assert.deepEqual(failed.error, { code: -32603, message: '会话丢了' })

  const need = taskSnapshot({ taskId: 'j-3', status: 'input_required', prompt: 'Password:', hint: '让用户输密码' })
  const req = (need.inputRequests as any).prompt
  assert.equal(req.method, 'elicitation/create')
  assert.match(req.params.message, /Password:/)
  assert.match(req.params.message, /让用户输密码/)

  // working 不该带 result/error
  const working = taskSnapshot({ taskId: 'j-4', status: 'working' })
  assert.equal(working.result, undefined)
  assert.equal(working.error, undefined)
})

test('★ 现代请求的错误 → 对应 HTTP 状态码；legacy 一律 200（别让老客户端以为端点不存在）', () => {
  assert.equal(httpStatusForError(-32022, true), 400) // 版本不支持
  assert.equal(httpStatusForError(-32020, true), 400) // 头不一致
  assert.equal(httpStatusForError(-32601, true), 404) // 未知方法
  assert.equal(httpStatusForError(-32602, true), 200) // 参数错误仍在 JSON-RPC 层
  assert.equal(httpStatusForError(undefined, true), 200)
  // legacy：全部 200
  for (const c of [-32022, -32020, -32601, -32602]) assert.equal(httpStatusForError(c, false), 200)
})

test('头与 _meta 版本不一致 → -32020，消息里带两个版本（便于定位）', () => {
  const e = headerMismatchError('2026-07-28', '2025-06-18')
  assert.equal(e.code, -32020)
  assert.match(e.message, /2026-07-28/)
  assert.match(e.message, /2025-06-18/)
})