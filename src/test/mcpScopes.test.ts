// P0b：每个 AI 一把令牌 + 权限分档（observer 只读 / operator 可写 / full 全权）。
//
// 为什么必须做：P0a 的 `X-BastionShell-Client` 只是"区分用途"，两个 AI 共用主令牌时
// 谁都能冒充谁；而且**没有任何办法让第二个 AI"只能看不能动"**。令牌 + 分档才是真隔离。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMcpHttpServer, newMcpToken, type McpHttpHandle } from '../mcpServer'
import { type McpSessionApi, type ToolCallContext } from '../mcpTools'

const MAIN = newMcpToken()
const OBS = newMcpToken()
const OP = newMcpToken()
const CLIENTS = [
  { token: OBS, label: 'claude-observer', scope: 'observer' as const },
  { token: OP, label: 'trae-operator', scope: 'operator' as const }
]

function recordingApi(calls: { tool: string; clientId?: string; scope?: string }[]): McpSessionApi {
  const push = (tool: string, ctx?: ToolCallContext): void => {
    calls.push({ tool, clientId: ctx?.clientId, scope: ctx?.scope })
  }
  return {
    listSessions: async (ctx) => {
      push('listSessions', ctx)
      return '会话列表'
    },
    listProfiles: async () => '档案',
    exec: async (i) => {
      calls.push({ tool: 'exec', clientId: i.clientId })
      return { text: `执行：${i.command}`, structured: { status: 'completed' } }
    },
    wait: async () => ({ text: '等作业' }),
    job: async () => ({ text: '作业日志' }),
    cancel: async () => ({ text: '已取消' }),
    connect: async (i) => {
      calls.push({ tool: 'connect', clientId: i.clientId })
      return `已连接 ${i.host}`
    },
    use: async (i) => {
      calls.push({ tool: 'use', clientId: i.clientId })
      return `已绑定 ${i.session}`
    },
    habits: async () => '习惯',
    tail: async () => '屏幕',
    push: async (i) => {
      calls.push({ tool: 'push', clientId: i.clientId })
      return '已上传'
    },
    pull: async (i) => {
      calls.push({ tool: 'pull', clientId: i.clientId })
      return '已下载'
    },
    health: async (ctx) => {
      push('health', ctx)
      return '自检'
    }
  }
}

async function withServer<T>(fn: (h: McpHttpHandle, calls: { tool: string; clientId?: string }[]) => Promise<T>): Promise<T> {
  const calls: { tool: string; clientId?: string }[] = []
  const h = await startMcpHttpServer({ api: recordingApi(calls), token: MAIN, clients: CLIENTS, port: 0 })
  try {
    return await fn(h, calls)
  } finally {
    await h.close()
  }
}

async function rpc(h: McpHttpHandle, token: string, name?: string, args: Record<string, unknown> = {}): Promise<{ status: number; text: string; isError?: boolean }> {
  const body = name
    ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
    : { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  const res = await fetch(h.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  const json = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } }
  return { status: res.status, text: json.result?.content?.[0]?.text ?? '', isError: json.result?.isError }
}

// ───────────────── 鉴权 ─────────────────

test('主令牌 / 客户端令牌 / 未知令牌：分别放行、放行、401', async () => {
  await withServer(async (h, calls) => {
    assert.equal((await rpc(h, MAIN)).status, 200)
    assert.equal((await rpc(h, OBS)).status, 200)
    assert.equal((await rpc(h, OP)).status, 200)
    const bad = await rpc(h, 'deadbeefdeadbeefdeadbeef')
    assert.equal(bad.status, 401)
    // 401 的响应不泄露任何会话信息
    assert.ok(!bad.text.includes('会话'))
    assert.equal(calls.length, 0, '鉴权失败的请求不该进到工具层')
  })
})

test('每把令牌对应自己的 clientId（这才是真隔离，不靠可伪造的请求头）', async () => {
  await withServer(async (h, calls) => {
    await rpc(h, OBS, 'bastion_listSessions')
    await rpc(h, OP, 'bastion_listSessions')
    await rpc(h, MAIN, 'bastion_listSessions')
    assert.deepEqual(
      calls.map((c) => c.clientId),
      ['claude-observer', 'trae-operator', 'default']
    )
  })
})

// ───────────────── 权限分档 ─────────────────

test('observer：能读不能写，拒绝文案说清怎么升级', async () => {
  await withServer(async (h, calls) => {
    assert.equal((await rpc(h, OBS, 'bastion_tail', {})).isError, undefined, '只读工具应该允许')
    const exec = await rpc(h, OBS, 'bastion_exec', { command: 'uname -r' })
    assert.equal(exec.isError, true)
    assert.match(exec.text, /observer（只读）/)
    assert.match(exec.text, /管理外部 AI 令牌/, '要告诉用户去哪儿换权限')
    assert.equal(calls.filter((c) => c.tool === 'exec').length, 0, '被拒的写操作绝不能落到执行层')

    // 绑定本身不执行任何东西 → observer 允许（方便它用别名 tail）
    assert.equal((await rpc(h, OBS, 'bastion_use', { session: 'A' })).isError, undefined)
  })
})

test('observer / operator 都不能 connect；只有 full 能', async () => {
  await withServer(async (h, calls) => {
    const a = await rpc(h, OBS, 'bastion_connect', { profile: '生产', host: '10.0.0.1' })
    assert.equal(a.isError, true)
    assert.match(a.text, /full/)
    const b = await rpc(h, OP, 'bastion_connect', { profile: '生产', host: '10.0.0.1' })
    assert.equal(b.isError, true, 'operator 也不能连新机器')
    const c = await rpc(h, MAIN, 'bastion_connect', { profile: '生产', host: '10.0.0.1' })
    assert.equal(c.isError, undefined)
    assert.equal(calls.filter((x) => x.tool === 'connect').length, 1, '只有 full 那次真的连了')
  })
})

test('operator：能写（exec / push / pull）也能 bind', async () => {
  await withServer(async (h, calls) => {
    assert.equal((await rpc(h, OP, 'bastion_exec', { command: 'df -h' })).isError, undefined)
    assert.equal((await rpc(h, OP, 'bastion_push', { localPath: '/tmp/a' })).isError, undefined)
    assert.equal((await rpc(h, OP, 'bastion_pull', { remotePath: '/tmp/b' })).isError, undefined)
    assert.equal(calls.filter((c) => ['exec', 'push', 'pull'].includes(c.tool)).length, 3)
  })
})
