// 多客户端隔离的「传输层」验证：请求头 `X-BastionShell-Client` → clientId → 工具调用。
//
// 为什么单独测这一层：绑定隔离再正确，如果请求头没被读出来，两个 AI 都算 `default`，
// 那"你的 A / 我的 A"就退化成同一个集合 —— 正是这次要修的问题。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMcpHttpServer, newMcpToken, type McpHttpHandle } from '../mcpServer'
import { type McpSessionApi, type ToolCallContext } from '../mcpTools'

const TOKEN = newMcpToken()

/** 把每次调用的参数记下来，断言传输层有没有把 clientId / session 传对 */
function recordingApi() {
  const calls: { tool: string; input: Record<string, unknown>; clientId?: string }[] = []
  const api: McpSessionApi = {
    listSessions: async (ctx?: ToolCallContext) => {
      calls.push({ tool: 'listSessions', input: {}, clientId: ctx?.clientId })
      return '会话列表'
    },
    listProfiles: async () => '档案',
    exec: async (i) => {
      calls.push({ tool: 'exec', input: i as Record<string, unknown>, clientId: i.clientId })
      return { text: `执行：${i.command}`, structured: { status: 'completed', exitCode: 0 } }
    },
    wait: async (i) => {
      calls.push({ tool: 'wait', input: i as Record<string, unknown> })
      return { text: `等作业 ${i.jobId}` }
    },
    job: async (i) => {
      calls.push({ tool: 'job', input: i as Record<string, unknown> })
      return { text: `作业 ${i.jobId} 日志` }
    },
    cancel: async (i) => {
      calls.push({ tool: 'cancel', input: i as Record<string, unknown> })
      return { text: `取消 ${i.jobId}` }
    },
    resumeTask: async (i) => ({ text: '续跑 ' + (i.jobId ?? '') }),
    connect: async (i) => {
      calls.push({ tool: 'connect', input: i as Record<string, unknown>, clientId: i.clientId })
      return `已连接 ${i.host}`
    },
    use: async (i) => {
      calls.push({ tool: 'use', input: i as Record<string, unknown>, clientId: i.clientId })
      return `已绑定 ${i.session}`
    },
    habits: async () => '习惯',
    tail: async (i) => {
      calls.push({ tool: 'tail', input: i as Record<string, unknown>, clientId: i.clientId })
      return '屏幕'
    },
    push: async (i) => {
      calls.push({ tool: 'push', input: i as Record<string, unknown>, clientId: i.clientId })
      return '已上传'
    },
    pull: async (i) => {
      calls.push({ tool: 'pull', input: i as Record<string, unknown>, clientId: i.clientId })
      return '已下载'
    },
    health: async (ctx?: ToolCallContext) => {
      calls.push({ tool: 'health', input: {}, clientId: ctx?.clientId })
      return '自检'
    }
  }
  return { api, calls }
}

async function withServer<T>(fn: (h: McpHttpHandle, calls: ReturnType<typeof recordingApi>['calls']) => Promise<T>): Promise<T> {
  const { api, calls } = recordingApi()
  const h = await startMcpHttpServer({ api, token: TOKEN, port: 0 })
  try {
    return await fn(h, calls)
  } finally {
    await h.close()
  }
}

/** 一次 MCP 工具调用（可带调用者标识头） */
async function call(h: McpHttpHandle, name: string, args: Record<string, unknown>, client?: string): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${h.token}`
  }
  if (client) headers['X-BastionShell-Client'] = client
  const res = await fetch(h.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { result?: { content?: { text?: string }[] } }
  return body.result?.content?.[0]?.text ?? ''
}

test('请求头 X-BastionShell-Client 会作为 clientId 传进工具（两个 AI 各自的身份）', async () => {
  await withServer(async (h, calls) => {
    await call(h, 'bastion_use', { session: 's-7f3a' }, 'claude')
    await call(h, 'bastion_use', { session: 's-9c21' }, 'trae')
    const uses = calls.filter((c) => c.tool === 'use')
    assert.equal(uses.length, 2)
    assert.equal(uses[0].clientId, 'claude')
    assert.equal(uses[1].clientId, 'trae')
    assert.equal(uses[0].input.session, 's-7f3a')
    assert.equal(uses[1].input.session, 's-9c21')
  })
})

test('主令牌 + 没带那个头 → clientId 就是 default（P0b 之后身份由令牌决定）', async () => {
  await withServer(async (h, calls) => {
    await call(h, 'bastion_listSessions', {})
    const c = calls.find((x) => x.tool === 'listSessions')
    assert.ok(c)
    assert.equal(c?.clientId, 'default')
  })
})

test('session 参数一路透传到 exec / tail / push / pull（含旧参数 terminal）', async () => {
  await withServer(async (h, calls) => {
    await call(h, 'bastion_exec', { command: 'uname -r', session: 'A' }, 'claude')
    await call(h, 'bastion_tail', { session: 's-9c21', lines: 5 })
    await call(h, 'bastion_push', { localPath: '/tmp/a', session: 'B' })
    await call(h, 'bastion_pull', { remotePath: '/tmp/b', terminal: '#3 deploy@10.0.0.1' })
    assert.equal(calls.find((x) => x.tool === 'exec')?.input.session, 'A')
    assert.equal(calls.find((x) => x.tool === 'exec')?.clientId, 'claude')
    assert.equal(calls.find((x) => x.tool === 'tail')?.input.session, 's-9c21')
    assert.equal(calls.find((x) => x.tool === 'push')?.input.session, 'B')
    // 旧参数仍然能用（向后兼容）
    assert.equal(calls.find((x) => x.tool === 'pull')?.input.terminal, '#3 deploy@10.0.0.1')
  })
})

test('bastion_use 缺 session → 直接报错，不落到后端', async () => {
  await withServer(async (h, calls) => {
    const text = await call(h, 'bastion_use', {})
    assert.match(text, /需要 session 参数/)
    assert.equal(calls.filter((c) => c.tool === 'use').length, 0)
  })
})

test('bastion_connect 也带 clientId（新会话才能自动绑到正确的人身上）', async () => {
  await withServer(async (h, calls) => {
    await call(h, 'bastion_connect', { profile: '生产', host: '10.0.0.1' }, 'trae')
    const c = calls.find((x) => x.tool === 'connect')
    assert.equal(c?.clientId, 'trae')
  })
})
