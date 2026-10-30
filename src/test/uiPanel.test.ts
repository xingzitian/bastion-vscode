// 网页版行动面板的 HTTP 面（GET /ui/*）：给 DSH 侧复用前，先钉住契约
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMcpHttpServer } from '../mcpServer'
import type { McpSessionApi } from '../mcpTools'

const TOKEN = 'token-0123456789abcdef'
const api = (): McpSessionApi =>
  ({
    listSessions: async () => '',
    listProfiles: async () => '',
    use: async () => '',
    exec: async () => ({ text: '' }),
    wait: async () => ({ text: '' }),
    job: async () => ({ text: '' }),
    cancel: async () => ({ text: '' }),
    health: async () => '',
    connect: async () => '',
    habits: async () => '',
    tail: async () => '',
    push: async () => '',
    pull: async () => ''
  }) as unknown as McpSessionApi

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  actionId: 'j-1',
  intentId: 'i-1',
  sessionNo: 1,
  sessionId: 's-1',
  why: '部署新版本',
  brief: '2 步：cd · git pull',
  steps: 2,
  command: 'cd /x && git pull',
  redacted: false,
  status: 'completed',
  exitCode: 0,
  startedAt: Date.now() - 5000,
  endedAt: Date.now(),
  elapsedMs: 5000,
  ...over
})

async function start(): Promise<{ url: string; close: () => void }> {
  const h = await startMcpHttpServer({
    api: api(),
    token: TOKEN,
    clients: [],
    port: 0,
    serverName: 'bastionshell',
    serverVersion: '0.3.13',
    ui: { listActions: async () => [rec() as never] }
  })
  return { url: `http://127.0.0.1:${h.port}`, close: () => h.close?.() }
}

test('○ /ui/ 要能返回 HTML（带卡片、带 token 注入），无 token 401', async () => {
  const s = await start()
  try {
    const ok = await fetch(`${s.url}/ui/?token=${TOKEN}`)
    assert.equal(ok.status, 200)
    const html = await ok.text()
    assert.match(html, /行动面板/)
    assert.match(html, /部署新版本/)
    assert.match(html, /EventSource/)

    const bad = await fetch(`${s.url}/ui/`)
    assert.equal(bad.status, 401)

    const cors = await fetch(`${s.url}/ui/`, { method: 'OPTIONS' })
    assert.equal(cors.status, 204)
    assert.equal(cors.headers.get('access-control-allow-origin'), '*')
  } finally {
    s.close()
  }
})

test('○ /ui/actions 返回分组后的 HTML 片段和计数', async () => {
  const s = await start()
  try {
    const r = await fetch(`${s.url}/ui/actions?limit=10&token=${TOKEN}`)
    const j = (await r.json()) as { total: number; groups: number; html: string }
    assert.equal(j.total, 1)
    assert.equal(j.groups, 1)
    assert.match(j.html, /部署新版本/)
    assert.match(j.html, /退出码 0/)
  } finally {
    s.close()
  }
})
test('○ /ui/cancel 必须真的调到注入的 cancel（页面上的"取消"靠它）', async () => {
  const cancelled: string[] = []
  const h = await startMcpHttpServer({
    api: api(),
    token: TOKEN,
    clients: [],
    port: 0,
    serverName: 'bastionshell',
    serverVersion: '0.3.13',
    ui: { listActions: async () => [rec() as never] },
    jobs: {
      cursorOf: () => 0,
      cancel: async (jobId: string) => {
        cancelled.push(jobId)
      }
    }
  })
  try {
    const url = `http://127.0.0.1:${h.port}`
    const r = await fetch(`${url}/ui/cancel?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'j-1' })
    })
    assert.equal(r.status, 200)
    assert.deepEqual(cancelled, ['j-1'])

    const noTok = await fetch(`${url}/ui/cancel`, { method: 'POST', body: '{}' })
    assert.equal(noTok.status, 401)
  } finally {
    h.close?.()
  }
})
test('★ /ui/status 必须读实时作业表，不能读账本（账本会有永远 working 的脏行）', async () => {
  const { resetJobs, createJob, completeJob, markInputRequired } = await import('../execJobs')
  resetJobs()
  const a = createJob({ sessionId: 's-1', sessionNo: 1, command: 'sleep 100', cursorAtStart: 0 })
  const b = createJob({ sessionId: 's-2', sessionNo: 2, command: 'read x', cursorAtStart: 0 })
  markInputRequired(b, 'Password:', '让人输')
  const c = createJob({ sessionId: 's-3', sessionNo: 3, command: 'true', cursorAtStart: 0 })
  completeJob(c, { exitCode: 0, markerSeen: true })

  // 账本里塞一条"还在跑"的脏行：如果实现读了账本，working 会变成 2
  const h = await startMcpHttpServer({
    api: api(),
    token: TOKEN,
    clients: [],
    port: 0,
    serverName: 'bastionshell',
    serverVersion: '0.3.13',
    ui: {
      listActions: async () =>
        [
          rec({ actionId: 'stale', status: 'working', endedAt: undefined, command: 'ghost' }) as never
        ] as never
    }
  })
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/ui/status?token=${TOKEN}`)
    const j = (await r.json()) as {
      ok: boolean
      working: number
      inputRequired: number
      checkedAt: number
      version: string
      capabilities: string[]
    }
    assert.equal(j.ok, true)
    assert.equal(j.working, 1, '只算实时在跑的（c 已完成、b 是等输入）')
    assert.equal(j.inputRequired, 1)
    assert.ok(j.checkedAt > 0)
    // 版本握手：插件靠它判断"扩展够不够新"，而不是给用户一个空白面板
    assert.equal(j.version, '0.3.13')
    assert.deepEqual(j.capabilities, ['status', 'actions', 'stream', 'cancel', 'embed', 'theme'])
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/ui/status`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/ui/status?token=${TOKEN}`)).headers.get('cache-control'), 'no-store')
    void a
  } finally {
    h.close?.()
    resetJobs()
  }
})

test('★ embed=1 不渲染标题/页脚；theme=light 用浅色；默认与之前一致', async () => {
  const s = await start()
  try {
    const plain = await (await fetch(`${s.url}/ui/?token=${TOKEN}`)).text()
    assert.match(plain, /<h1>/)
    assert.match(plain, /<footer>/)
    assert.match(plain, /--bg: #0d1117/)

    const emb = await (await fetch(`${s.url}/ui/?embed=1&theme=light&token=${TOKEN}`)).text()
    assert.doesNotMatch(emb, /<h1>/, 'embed 不能有标题')
    assert.doesNotMatch(emb, /<footer>/, 'embed 不能有页脚')
    assert.match(emb, /padding: 8px/)
    assert.match(emb, /--bg: #ffffff/)
    assert.match(emb, /color-scheme: light/)
    // 其余照旧：SSE、取消、卡片都还在
    assert.match(emb, /EventSource/)
    assert.match(emb, /\/ui\/cancel/)
    assert.match(emb, /部署新版本/)
  } finally {
    s.close()
  }
})

test('○ /ui/actions 增加 groupsTotal（不改 groups 语义）；/ui/stream 首行 retry: 3000', async () => {
  const s = await start()
  try {
    const j = (await (await fetch(`${s.url}/ui/actions?limit=1&token=${TOKEN}`)).json()) as {
      total: number
      groups: number
      groupsTotal: number
    }
    assert.equal(j.groups, 1, 'limit=1 时切片后只有 1 组（旧字段语义不变）')
    assert.equal(j.groupsTotal, 1, '全量分组数')

    const res = await fetch(`${s.url}/ui/stream?token=${TOKEN}`)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const head = new TextDecoder().decode(value)
    assert.match(head, /retry: 3000/)
    await reader.cancel()
  } finally {
    s.close()
  }
})