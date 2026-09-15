// MCP 的 HTTP 传输：**真的起一个监听、真的发 HTTP**。
//
// 这一组是「一次就能跑」的保险。单测 JSON-RPC 只证明消息处理对，
// 证明不了 VS Code 那条路能通 —— 鉴权头、202/405、Content-Type、
// 路径、body 上限，任何一处不对，客户端都表现为「服务器没工具」。
//
// 这里刻意按 VS Code 客户端（MCP TypeScript SDK）的**真实请求形状**发：
//   Accept: application/json, text/event-stream
//   Content-Type: application/json
//   Authorization: Bearer <token>
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMcpHttpServer, newMcpToken, type McpHttpHandle } from '../mcpServer'
import { MCP_TOOL_DEFS, type McpSessionApi } from '../mcpTools'

const TOKEN = newMcpToken()

function api(over: Partial<McpSessionApi> = {}): McpSessionApi {
  return {
    listSessions: async () => '当前堡垒机会话（1 个）：\n- deploy@10.0.0.1',
    listProfiles: async () => '可用的连接档案（1 个）',
    exec: async (i) => `输出：${i.command}`,
    connect: async (i) => `已连接 ${i.host}`,
    habits: async () => '习惯',
    health: async () => '端点自检：正常',
    tail: async () => '屏幕：\n[deploy@h ~]$ ',
    push: async () => '已上传 a.txt',
    pull: async () => '已下载 b.txt',
    ...over
  }
}

async function withServer<T>(fn: (h: McpHttpHandle) => Promise<T>, over: Partial<McpSessionApi> = {}): Promise<T> {
  const h = await startMcpHttpServer({ api: api(over), token: TOKEN, port: 0, serverVersion: '1.2.3' })
  try {
    return await fn(h)
  } finally {
    await h.close()
  }
}

/** 模拟 MCP 客户端的一次 POST */
async function rpc(
  h: McpHttpHandle,
  body: unknown,
  opts: { token?: string | null; method?: string; accept?: string } = {}
): Promise<{ status: number; text: string; type: string | null; headers: Headers }> {
  const token = opts.token === undefined ? h.token : opts.token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: opts.accept ?? 'application/json, text/event-stream'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(h.url, { method: opts.method ?? 'POST', headers, body: opts.method === 'GET' ? undefined : JSON.stringify(body) })
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type'), headers: res.headers }
}

test('端点只监听 127.0.0.1，地址是 .../mcp', async () => {
  await withServer(async (h) => {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.ok(h.port > 0)
  })
})

test('没有 token / token 不对 → 401（并且不泄露任何会话信息）', async () => {
  await withServer(async (h) => {
    const a = await rpc(h, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null })
    assert.equal(a.status, 401)
    assert.ok(!a.text.includes('deploy@'))

    const b = await rpc(h, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'deadbeef'.repeat(4) })
    assert.equal(b.status, 401)
  })
})

test('客户端完整流程：initialize → initialized → tools/list → tools/call', async () => {
  await withServer(async (h) => {
    const init = await rpc(h, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vscode', version: '1' } }
    })
    assert.equal(init.status, 200)
    assert.match(init.type ?? '', /application\/json/)
    const initBody = JSON.parse(init.text) as { result: { protocolVersion: string; capabilities: unknown } }
    assert.equal(initBody.result.protocolVersion, '2025-06-18')

    // 通知：202 且没有 body（有的客户端会因为这个较真）
    const notif = await rpc(h, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notif.status, 202)
    assert.equal(notif.text, '')

    const list = await rpc(h, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listBody = JSON.parse(list.text) as { result: { tools: { name: string }[] } }
    assert.equal(listBody.result.tools.length, MCP_TOOL_DEFS.length)

    const call = await rpc(h, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'bastion_exec', arguments: { command: 'df -h' } }
    })
    const callBody = JSON.parse(call.text) as { result: { content: { text: string }[] } }
    assert.equal(callBody.result.content[0].text, '输出：df -h')
  })
})

test('GET（SSE 流）与 DELETE 回 405 + Allow: POST', async () => {
  await withServer(async (h) => {
    const get = await rpc(h, null, { method: 'GET' })
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const del = await rpc(h, null, { method: 'DELETE' })
    assert.equal(del.status, 405)
  })
})

test('别的路径 → 404（别把 / 也当端点）', async () => {
  await withServer(async (h) => {
    const res = await fetch(h.url.replace('/mcp', '/'), { method: 'POST', headers: { Authorization: `Bearer ${h.token}` } })
    assert.equal(res.status, 404)
  })
})

test('body 不是 JSON → -32700；批量数组 → -32600（规范已移除 batch）', async () => {
  await withServer(async (h) => {
    const bad = await fetch(h.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: '{ 这不是 JSON'
    })
    const badBody = JSON.parse(await bad.text()) as { error: { code: number } }
    assert.equal(badBody.error.code, -32700)

    const batch = await rpc(h, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    const batchBody = JSON.parse(batch.text) as { error: { code: number } }
    assert.equal(batchBody.error.code, -32600)
  })
})

test('未知方法 → -32601（客户端据此知道我们没实现 resources/prompts）', async () => {
  await withServer(async (h) => {
    const r = await rpc(h, { jsonrpc: '2.0', id: 9, method: 'prompts/list' })
    const body = JSON.parse(r.text) as { error: { code: number; message: string } }
    assert.equal(body.error.code, -32601)
    assert.match(body.error.message, /prompts\/list/)
  })
})

test('工具执行失败也走 200 + isError（HTTP 状态码别乱用）', async () => {
  await withServer(
    async (h) => {
      const r = await rpc(h, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bastion_exec', arguments: { command: 'x' } } })
      assert.equal(r.status, 200)
      const body = JSON.parse(r.text) as { result: { isError?: boolean } }
      assert.equal(body.result.isError, true)
    },
    {
      exec: async () => {
        throw new Error('通道断了')
      }
    }
  )
})

test('close() 之后端口真的释放（可以立刻再起一个）', async () => {
  const a = await startMcpHttpServer({ api: api(), token: TOKEN, port: 0 })
  const port = a.port
  await a.close()
  const b = await startMcpHttpServer({ api: api(), token: TOKEN, port })
  assert.equal(b.port, port)
  await b.close()
})

test('端口被占时自动退到随机端口（不抛异常、功能不消失）', async () => {
  const first = await startMcpHttpServer({ api: api(), token: TOKEN, port: 0 })
  const second = await startMcpHttpServer({ api: api(), token: TOKEN, port: first.port })
  try {
    assert.equal(second.portFallback, true)
    assert.notEqual(second.port, first.port)
    assert.ok(second.port > 0)
  } finally {
    await second.close()
    await first.close()
  }
})
