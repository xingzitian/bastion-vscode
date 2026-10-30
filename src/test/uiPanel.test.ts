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