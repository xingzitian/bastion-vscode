#!/usr/bin/env node
/**
 * hub-lite e2e：一个 serve 进程持有多条会话，共用一个 MCP 端点。
 *
 * 验收：
 *   1. listSessions 能看到两条（xzt / xb）
 *   2. 不指定 session 且有多条 → 明确要求指定（不猜）
 *   3. 指定 session=档案名 → 落到那条会话（xzt 与 xb 是两台机器，hostname 不同）
 *   4. bastion_use 绑定后，不带 session 也能落到绑定的那条
 *   5. tail 能读到指定会话的屏幕
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const cli = path.join(repo, 'out', 'cli', 'main.js')
const mcpFile = path.join(os.homedir(), '.bastionshell', 'mcp-cli.json')
const results = []
const ok = (n, x = '') => results.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => results.push(`FAIL  ${n}  ${w}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(process.execPath, [cli, 'serve', 'xzt', 'xb'], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

async function waitEndpoint(timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(mcpFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))
        if (j.pid === child.pid && j.url) return j
      } catch {
        /* ignore */
      }
    }
    if (child.exitCode !== null) throw new Error(`serve 退出：${log.slice(-500)}`)
    await sleep(250)
  }
  throw new Error(`等端点超时：${log.slice(-500)}`)
}

async function call(ep, name, args) {
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${ep.token}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.random().toString(36).slice(2),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  const r = JSON.parse(text)
  return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 200), isError: r.result?.isError === true }
}

try {
  const ep = await waitEndpoint()

  const list = await call(ep, 'bastion_listSessions', {})
  if (list.text.includes('xzt') && list.text.includes('xb') && /共 2 条/.test(list.text)) ok('listSessions 两条')
  else bad('listSessions', list.text.slice(0, 300))

  const noSess = await call(ep, 'bastion_exec', { command: 'hostname', clientId: 'c-unbound' })
  if (/请用 session 指定/.test(noSess.text) && noSess.isError) ok('多条不指定 → 明确报错（不猜）')
  else bad('多条不指定', noSess.text.slice(0, 240))

  const onXzt = await call(ep, 'bastion_exec', { command: 'hostname', session: 'xzt' })
  const onXb = await call(ep, 'bastion_exec', { command: 'hostname', session: 'xb' })
  const xztHost = /VM-24-4-debian/.test(onXzt.text)
  const xbHost = xztHost ? !/VM-24-4-debian/.test(onXb.text) : true
  if (xztHost && xbHost) ok('session 路由到不同机器', `${onXzt.text.match(/VM-[\w.-]+/)?.[0] ?? '?'} / ${onXb.text.split('\n').pop()}`)
  else bad('session 路由', `${onXzt.text.slice(0, 120)} || ${onXb.text.slice(0, 120)}`)

  const used = await call(ep, 'bastion_use', { session: 'xzt', as: 'hub-client', clientId: 'c-hub' })
  const bound = await call(ep, 'bastion_exec', { command: 'hostname', clientId: 'c-hub' })
  if (/已把客户端/.test(used.text) && /VM-24-4-debian/.test(bound.text)) ok('use 绑定后不带 session 也可用')
  else bad('use 绑定', `${used.text.slice(0, 120)} || ${bound.text.slice(0, 120)}`)

  const tail = await call(ep, 'bastion_tail', { session: 'xzt', lines: 10 })
  if (/屏幕最后/.test(tail.text) && tail.text.includes('xzt')) ok('tail 指向指定会话')
  else bad('tail', tail.text.slice(0, 200))
} catch (e) {
  bad('e2e 整体', e instanceof Error ? e.message : String(e))
} finally {
  child.kill('SIGTERM')
  await sleep(700)
  fs.rmSync(mcpFile, { force: true })
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
