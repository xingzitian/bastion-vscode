// MCP 的 JSON-RPC 层（纯逻辑）：握手、工具列表、工具调用、错误码。
//
// 这一层是「一次就能跑」的关键：VS Code 的 MCP 客户端和别家的客户端
// 都会先 initialize、再 notifications/initialized、然后才 tools/list。
// 顺序或形状不对，客户端表现为「这个服务器没有工具」，而不是报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LATEST_PROTOCOL_VERSION, createMcpServer, toMcpTool } from '../mcpServer'
import { MCP_TOOL_DEFS, type McpSessionApi } from '../mcpTools'

function api(over: Partial<McpSessionApi> = {}): McpSessionApi {
  return {
    listSessions: async () => '会话列表',
    listProfiles: async () => '档案列表',
    exec: async (i) => `执行：${i.command}`,
    connect: async (i) => `连接：${i.host}`,
    habits: async () => '习惯',
    health: async () => '端点自检：正常',
    tail: async () => '屏幕：\n[deploy@h ~]$ ',
    push: async () => '已上传 a.txt',
    pull: async () => '已下载 b.txt',
    ...over
  }
}

function server(over: Partial<McpSessionApi> = {}) {
  return createMcpServer({ api: api(over), serverVersion: '9.9.9' })
}

interface RpcResult {
  jsonrpc: string
  id: unknown
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

test('initialize：客户端给的协议版本我们认识就照原样回', async () => {
  const s = server()
  const r = (await s.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } }
  })) as RpcResult
  assert.equal(r.jsonrpc, '2.0')
  assert.equal(r.id, 1)
  assert.equal(r.result?.protocolVersion, '2025-03-26')
})

test('initialize：不认识的版本回我们支持的最新版（而不是回 null）', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 'abc', method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as RpcResult
  assert.equal(r.result?.protocolVersion, LATEST_PROTOCOL_VERSION)
  assert.equal(r.id, 'abc', 'id 要原样回（字符串 id 也不能丢）')
})

test('initialize：声明 tools 能力 + 带一段给模型看的使用说明', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })) as RpcResult
  const caps = r.result?.capabilities as { tools?: unknown }
  assert.ok(caps.tools, '没有 tools 能力，客户端不会去要工具列表')
  const info = r.result?.serverInfo as { name: string; version: string }
  assert.equal(info.version, '9.9.9')
  assert.ok(String(r.result?.instructions ?? '').includes('MFA'), '说明里要点明 MFA 只能人来输')
})

test('通知不需要应答：notifications/initialized 与 cancelled 都回 null', async () => {
  const s = server()
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null)
})

test('ping 回空结果（客户端用它探活）', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 7, method: 'ping' })) as RpcResult
  assert.deepEqual(r.result, {})
})

test('tools/list 返回 5 个工具，形状符合规范', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as RpcResult
  const tools = r.result?.tools as { name: string; description: string; inputSchema: { type: string } }[]
  assert.equal(tools.length, MCP_TOOL_DEFS.length)
  for (const t of tools) {
    assert.ok(t.name && t.description)
    assert.equal(t.inputSchema.type, 'object')
  }
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'bastion_connect',
      'bastion_exec',
      'bastion_habits',
      'bastion_health',
      'bastion_listProfiles',
      'bastion_listSessions',
      'bastion_pull',
      'bastion_push',
      'bastion_tail'
    ]
  )
})

test('tools/call 成功：content 是 text，且不带 isError', async () => {
  const s = server()
  const r = (await s.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'bastion_exec', arguments: { command: 'uptime' } }
  })) as RpcResult
  const content = r.result?.content as { type: string; text: string }[]
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, '执行：uptime')
  assert.equal('isError' in (r.result ?? {}), false)
})

test('tools/call：工具层的 isError（缺参数等）要原样传出去', async () => {
  const s = server()
  const r = (await s.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'bastion_exec', arguments: {} } // 缺 command：分发层会回 isError
  })) as RpcResult
  assert.equal(r.result?.isError, true)
  assert.match((r.result?.content as { text: string }[])[0].text, /需要 command/)
})

test('tools/call：不存在的工具 → JSON-RPC -32602', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } })) as RpcResult
  assert.equal(r.error?.code, -32602)
})

test('tools/call：能力抛异常也不炸传输层，回一条 isError 结果让模型读到原因', async () => {
  const s = server({
    exec: async () => {
      throw new Error('会话通道断了')
    }
  })
  const r = (await s.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'bastion_exec', arguments: { command: 'ls' } }
  })) as RpcResult
  assert.equal(r.error, undefined, '这不是传输错误')
  assert.equal(r.result?.isError, true)
  assert.match((r.result?.content as { text: string }[])[0].text, /会话通道断了/)
})

test('未知方法 → -32601；未知方法但没 id（通知）→ 静默忽略', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' })) as RpcResult
  assert.equal(r.error?.code, -32601)
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'resources/list' }), null)
})

test('无效请求（没有 method）→ -32600；没有 id 就不回', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 9 })) as RpcResult
  assert.equal(r.error?.code, -32600)
  assert.equal(await s.handle({ jsonrpc: '2.0' }), null)
})

test('toolList() 与 tools/list 一致（命令「查看已注册工具」用的就是它）', async () => {
  const s = server()
  const r = (await s.handle({ jsonrpc: '2.0', id: 10, method: 'tools/list' })) as RpcResult
  assert.deepEqual(s.toolList(), r.result?.tools)
  assert.deepEqual(s.toolList()[0], toMcpTool(MCP_TOOL_DEFS[0]))
})
