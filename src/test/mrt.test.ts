// MRTR（多轮往返）纯逻辑 + subscriptions/listen 的集成测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { decodeRequestState, encodeRequestState, firstInputValue, inputRequestsFor, isSecretPrompt } from '../mrt'
import { startMcpHttpServer } from '../mcpServer'
import type { McpSessionApi } from '../mcpTools'
import { appendJobOutput, createJob, resetJobs } from '../execJobs'

test('requestState 编解码：能带着 jobId 往返，坏数据不抛异常', () => {
  const s = encodeRequestState({ jobId: 'j-0007' })
  assert.deepEqual(decodeRequestState(s), { jobId: 'j-0007' })
  assert.deepEqual(decodeRequestState('not-base64!!'), {})
  assert.deepEqual(decodeRequestState(undefined), {})
  assert.deepEqual(decodeRequestState(Buffer.from('{"x":1}').toString('base64')), {})
})

test('★ 凭据类提示一律不代填（密码/动态码/口令）', () => {
  for (const s of ['Password: ', '[sudo] password for deploy:', 'Verification code:', '动态码：', 'Enter passphrase for key']) {
    assert.equal(isSecretPrompt(s), true, `${s} 应判为凭据类`)
  }
  for (const s of ['Are you sure? (yes/no)', '请选择目标机', 'overwrite? [y/n]']) {
    assert.equal(isSecretPrompt(s), false, `${s} 不是凭据类，可以代填`)
  }
})

test('inputResponses 取值：字符串 / elicitation content / 嵌套对象都能取到', () => {
  assert.equal(firstInputValue({ prompt: 'y' }), 'y')
  assert.equal(firstInputValue({ prompt: { action: 'accept', content: 'yes' } }), 'yes')
  assert.equal(firstInputValue({ prompt: { content: { text: 'ok' } } }), 'ok')
  assert.equal(firstInputValue({}), undefined)
  assert.equal(firstInputValue(undefined), undefined)
})

test('inputRequests 的形状：elicitation + 原文与提示', () => {
  const r = inputRequestsFor('Password:', '让用户在终端里输入') as any
  assert.equal(r.prompt.method, 'elicitation/create')
  assert.match(r.prompt.params.message, /Password:/)
  assert.match(r.prompt.params.message, /让用户在终端里输入/)
})

const api = (): McpSessionApi => ({
  listSessions: async () => '会话',
  listProfiles: async () => '档案',
  use: async () => 'ok',
  exec: async () => ({ text: 'ok', structured: { status: 'completed' } }),
  wait: async () => ({ text: 'ok' }),
  job: async () => ({ text: 'ok' }),
  cancel: async () => ({ text: 'ok' }),
  resumeTask: async (i) => ({ text: `续跑 ${i.jobId ?? ''}`, structured: { jobId: i.jobId, status: 'completed' } }),
  connect: async () => 'ok',
  habits: async () => 'ok',
  health: async () => 'ok',
  tail: async () => 'ok',
  push: async () => 'ok',
  pull: async () => 'ok'
})

/** 起真端点 + 读 SSE 流（只读到第一条 ack 就够） */
function readFirstSseEvent(port: number, body: unknown, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          if (buf.includes('\n\n')) {
            res.destroy()
            resolve(buf)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
    setTimeout(() => reject(new Error('SSE 超时')), 3000).unref?.()
  })
}

test('★ subscriptions/listen：先 ack，再把作业状态变化推成 notifications/tasks', async () => {
  resetJobs()
  const h = await startMcpHttpServer({
    api: api(),
    token: 'token-0123456789abcdef',
    clients: [],
    port: 0,
    serverName: 'bastionshell',
    serverVersion: '0.3.10'
  })
  const port = h.port
  try {
    const ack = await readFirstSseEvent(
      port,
      { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: { filters: { tasks: true } } },
      'token-0123456789abcdef'
    )
    assert.match(ack, /notifications\/subscriptions\/acknowledged/)

    // 再开一条流，然后在同一进程里制造一次作业状态变化
    const received: string[] = []
    const req2 = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-0123456789abcdef' } },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (c: string) => received.push(c))
      }
    )
    req2.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: {} }))
    req2.end()
    await new Promise((r) => setTimeout(r, 100))

    const job = createJob({ sessionId: 's-sse', sessionNo: 1, command: 'x', cursorAtStart: 0, marker: '__SSE_DONE__' })
    appendJobOutput(job, 'done __SSE_DONE__:0\n')
    await new Promise((r) => setTimeout(r, 200))
    req2.destroy()

    const all = received.join('')
    assert.match(all, /notifications\/tasks/)
    assert.match(all, /"taskId":"j-/)
    assert.match(all, /"status":"completed"/)
  } finally {
    h.close?.()
  }
})

test('★ MRTR：带 inputResponses + requestState 的重试会走到 resumeTask', async () => {
  const h = await startMcpHttpServer({
    api: api(),
    token: 'token-0123456789abcdef',
    clients: [],
    port: 0,
    serverName: 'bastionshell',
    serverVersion: '0.3.10'
  })
  const port = h.port
  const post = async (body: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-0123456789abcdef' },
      body: JSON.stringify(body)
    })
    return res.json()
  }
  try {
    const state = encodeRequestState({ jobId: 'j-0001' })
    const r = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'bastion_exec',
        arguments: { command: 'cat' },
        inputResponses: { prompt: { action: 'accept', content: 'y' } },
        requestState: state
      }
    })
    assert.match(r.result.content[0].text, /续跑 j-0001/)
    assert.equal(r.result.structuredContent.status, 'completed')
  } finally {
    h.close?.()
  }
})
