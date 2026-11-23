// 「AI 访问」页面数据（桌面界面的 /api/ai-access）。
//
// 背景：桌面界面是「一字不改」保下来的，它读的字段名来自已删掉的 Go `ai_access.go`。
// 这一组盯的是：**字段名别改**（否则界面白屏）、**令牌只给打码 + 原文两份**、
// **绑定和解绑要按 clientId/别名对上**、以及**桌面版只有一个令牌这件事要说出来**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDesktopAiAccessView } from '../core/aiAccessView'
import type { BindingsFile } from '../core/sessionBindings'

function bindings(clients: Record<string, { label: string; sessions: Record<string, { sessionId: string; name: string; since: string }> }>): BindingsFile {
  const out: BindingsFile = { version: 1, clients: {} }
  for (const [id, c] of Object.entries(clients)) {
    out.clients[id] = { label: c.label, updatedAt: '', sessions: c.sessions }
  }
  return out
}

const SESSIONS = [
  { id: 's-abc-1', name: 'xzt' },
  { id: 's-abc-2', name: '中转' }
]

test('桌面版只有一个令牌：mainOnly 必须是 true，且令牌只打码不整条露在 masked 里', () => {
  const view = buildDesktopAiAccessView({
    endpoint: 'http://127.0.0.1:39311/mcp',
    token: 'abcdef1234567890',
    bindings: bindings({}),
    sessions: SESSIONS,
    bindingsFile: '/tmp/mcp-bindings.json'
  })
  assert.equal(view.mainOnly, true)
  assert.equal(view.endpoint, 'http://127.0.0.1:39311/mcp')
  assert.equal(view.token, 'abcdef1234567890', '原文要给「复制客户端配置」用')
  assert.ok(!view.tokenMasked.includes('1234'), '打码里不该露出中段')
  assert.equal(view.tokenMasked, 'abcd…7890')
  assert.equal(view.clients.length, 1, '没绑定时只有主令牌一行')
  assert.equal(view.clients[0].isMain, true)
  assert.equal(view.clients[0].external, false)
  assert.equal(view.clients[0].scope, 'full')
  assert.ok(view.note.length > 0, '必须说清「只有一个令牌 = 全权」')
  assert.equal(view.bindingsFile, '/tmp/mcp-bindings.json')
})

test('绑定文件里的会话要摊到 clients[].bindings 和 sessions[].owners 两处（界面两处都读）', () => {
  const view = buildDesktopAiAccessView({
    endpoint: 'http://127.0.0.1:39311/mcp',
    token: 'tok-1234567890',
    bindings: bindings({
      default: { label: '主令牌', sessions: { B: { sessionId: 's-abc-1', name: 'xzt', since: '' } } },
      dsh: { label: 'dsh', sessions: { A: { sessionId: 's-abc-2', name: '中转', since: '' } } }
    }),
    sessions: SESSIONS,
    bindingsFile: '/tmp/mcp-bindings.json'
  })
  const main = view.clients.find((c) => c.isMain)
  assert.deepEqual(main?.bindings.map((b) => b.alias), ['B'])
  const dsh = view.clients.find((c) => c.clientId === 'dsh')
  assert.ok(dsh, '绑定文件里出现的 clientId 要在 clients 里列出来（可解绑）')
  assert.equal(dsh?.external, true)
  const xzt = view.sessions.find((s) => s.id === 's-abc-1')
  const zz = view.sessions.find((s) => s.id === 's-abc-2')
  assert.deepEqual(xzt?.owners.map((o) => o.alias), ['B'])
  assert.deepEqual(zz?.owners.map((o) => o.alias), ['A'])
  assert.equal(view.sessions.length, SESSIONS.length, '没被绑的会话也要列（界面要展示全部会话）')
})

test('主令牌那行用桌面版的说法（不照搬 VS Code 的文案）', () => {
  const view = buildDesktopAiAccessView({
    endpoint: '',
    token: '',
    bindings: bindings({}),
    sessions: [],
    bindingsFile: ''
  })
  assert.ok(view.clients[0].label.includes('桌面版'))
  assert.ok(!view.clients[0].label.includes('VS Code'))
})
