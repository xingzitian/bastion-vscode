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
