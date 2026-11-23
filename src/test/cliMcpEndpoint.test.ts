// CLI 端点文件的两套 schema + token 复用 + 端口退让（0.3.22 / B 阶段硬前置）。
//
// 为什么值得专门测：B 阶段要让 CLI **接管旧桌面版的 mcp.json 身份**（端口 39311 + 旧 token），
// 这样现有用户的客户端配置一个字都不用改。写错一个字段，别人的客户端就全连不上。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { startCliMcp } from '../cli/mcp'
import type { CliHost } from '../cli/host'

const fakeHost = { api: () => ({}) } as unknown as CliHost
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'bs-cli-mcp-'))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('★ 默认 schema：写 mcp-cli.json（url/port/token/pid/profile）', async () => {
  const dir = tmp()
  const file = path.join(dir, 'mcp-cli.json')
  const h = await startCliMcp({ host: fakeHost, version: 't', profileName: 'xzt', sessionId: 's-1', endpointFile: file })
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(j.url, h.url)
    assert.equal(j.port, h.port)
    assert.equal(j.token, h.token)
    assert.equal(j.pid, process.pid)
    assert.equal(j.profile, 'xzt')
    assert.ok(String(j.url).startsWith('http://127.0.0.1:'))
  } finally {
    await h.close()
  }
  assert.equal(fs.existsSync(file), false, 'close 后应删掉自己写的端点文件')
})

test('★ 旧 schema（mcp.json）：字段按桌面版格式写，老客户端才认', async () => {
  const dir = tmp()
  const file = path.join(dir, 'mcp.json')
  const h = await startCliMcp({
    host: fakeHost,
    version: 't',
    profileName: 'xzt',
    sessionId: 's-2',
    endpointFile: file,
    port: 0
  })
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.ok('actualPort' in j, '旧 schema 有 actualPort')
    assert.ok('updatedAt' in j, '旧 schema 有 updatedAt')
    assert.equal(j.port, h.port, 'port 应等于实际端口（请求 0 时）')
    assert.equal(j.token, h.token)
    assert.equal(h.legacy, true)
  } finally {
    await h.close()
  }
})

test('★ token 复用：接管旧身份时不能换 token，否则客户端配置全失效', async () => {
  const dir = tmp()
  const file = path.join(dir, 'mcp.json')
  fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 'OLD_TOKEN', port: 39311 }), 'utf8')
  const h = await startCliMcp({ host: fakeHost, version: 't', profileName: 'x', sessionId: 's', endpointFile: file })
  try {
    assert.equal(h.token, 'OLD_TOKEN')
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { token: string }
    assert.equal(j.token, 'OLD_TOKEN')
  } finally {
    await h.close()
  }
})

test('★ 端口被占用：退到随机端口，并写 note 说明原因', async () => {
  const dir = tmp()
  const file = path.join(dir, 'mcp.json')
  const blocker = net.createServer()
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
  const addr = blocker.address()
  const busyPort = typeof addr === 'object' && addr ? addr.port : 0
  try {
    const h = await startCliMcp({
      host: fakeHost,
      version: 't',
      profileName: 'x',
      sessionId: 's',
      endpointFile: file,
      port: busyPort
    })
    try {
      assert.equal(h.portFallback, true)
      assert.notEqual(h.port, busyPort)
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { note?: string; actualPort?: number }
      assert.equal(j.actualPort, h.port)
      assert.match(String(j.note), /端口被占用/)
    } finally {
      await h.close()
    }
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()))
  }
  await sleep(10)
})
