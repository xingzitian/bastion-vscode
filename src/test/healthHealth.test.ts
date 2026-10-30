// health 的"接线"测试：代际/能力/作业/提示这几行必须真的出现。
// 同类 bug 已经犯过三次（headers 丢一次、meta 丢一次、实现少传一个参数一次），所以直接断言输出。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setMcpEndpointInfo } from '../state'
import { sessionApi } from '../aiSessionApi'

test('★ health 必须显示代际/能力/在跑作业/提示识别（三次接线 bug 的护栏）', async () => {
  setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false, version: '0.3.10' })
  const text = await sessionApi.health({
    clientId: 'c1',
    headers: { version: '2026-07-28', method: 'tools/call', name: 'bastion_health' },
    meta: { version: '2026-07-28', modern: true, declaresTasks: false, declaresElicitation: false }
  })
  assert.match(text, /协议代际：modern/, '代际那行没出来 → 说明 meta 没被传进 healthReport')
  assert.match(text, /客户端扩展：tasks ✗/, 'tasks 那行没出来')
  assert.match(text, /客户端能力：elicitation ✗/, 'elicitation 那行没出来')
  assert.match(text, /在跑作业：/)
  assert.match(text, /提示识别：内置 \d+ 条规则/)
  assert.match(text, /本次请求头：MCP-Protocol-Version ✓/)
})

test('health：声明了 tasks/elicitation 时应显示 ✓', async () => {
  setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false, version: '0.3.10' })
  const text = await sessionApi.health({
    meta: { version: '2026-07-28', modern: true, declaresTasks: true, declaresElicitation: true }
  })
  assert.match(text, /客户端扩展：tasks ✓/)
  assert.match(text, /客户端能力：elicitation ✓/)
})

test('★ health 要报动作声明率（intentId / why），低于 80% 给出提醒', async () => {
  const { resetJobs, createJob } = await import('../execJobs')
  setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false, version: '0.3.13' })
  resetJobs()
  createJob({ sessionId: 's-a', sessionNo: 1, command: 'ls', cursorAtStart: 0, intentId: 'i-1', why: '看目录' })
  createJob({ sessionId: 's-a', sessionNo: 1, command: 'pwd', cursorAtStart: 0 })
  const text = await sessionApi.health({})
  assert.match(text, /动作声明：本次运行 2 个作业，intentId 50%、why 50%/)
  assert.match(text, /声明率偏低/, '低于 80% 必须提醒')
  resetJobs()
})
test('★ 有作业在跑时，health 不能说"停在菜单上"（屏幕没提示符是正常的）', async () => {
  const { resetJobs, createJob } = await import('../execJobs')
  const { terminals } = await import('../state')
  const { BastionTerminal } = await import('../terminal')
  const st = await import('../state')
  setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false, version: '0.3.13' })
  resetJobs()
  terminals.clear()
  const conn = { isAlive: true, connectedAt: Date.now(), channelCount: 1, onClose: () => undefined } as never
  const term = new BastionTerminal(conn, { name: 'xzt', host: 'h', port: 22, username: 'root', mode: 'direct' } as never)
  term.sessionNo = 1
  term.sessionId = 's-busy'
  terminals.set({ name: '#1 root@h' } as never, term)
  void st
  // 这条作业挂在该会话上（working），屏幕里没有提示符
  createJob({ sessionId: 's-busy', sessionNo: 1, command: 'sleep 40', cursorAtStart: 0, why: '长任务' })
  const text = await sessionApi.health({})
  assert.match(text, /正在跑作业/, '必须识别成"在跑作业"')
  assert.doesNotMatch(text, /停在堡垒机菜单上/, '不能误报成菜单，否则 AI 会去让用户白走一步')
  terminals.clear()
  resetJobs()
})