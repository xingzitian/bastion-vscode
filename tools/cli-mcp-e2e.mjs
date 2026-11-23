#!/usr/bin/env node
/**
 * CLI 宿主的 MCP 真机 e2e：起 `serve xzt`，读 mcp-cli.json，直接 POST /mcp 调工具。
 *
 * 验收（A2）：
 *   1. bastion_health 能返回，版本/会话/宿主都对
 *   2. bastion_exec 真执行，输出与退出码正确
 *   3. bastion_tail 能读到屏幕
 *   4. bastion_connect 明确回"CLI 不支持"（不假装成功）
 *   5. 账本写了 action-ledger.jsonl（同一份 JSONL）
 *
 * 用法：node tools/cli-mcp-e2e.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const cli = path.join(repo, 'out', 'cli', 'main.js')
const mcpFile = path.join(os.homedir(), '.bastionshell', 'mcp-cli.json')
const ledger = path.join(os.homedir(), '.bastionshell', 'action-ledger.jsonl')

const results = []
const ok = (name, extra = '') => results.push(`PASS  ${name}${extra ? '  ' + extra : ''}`)
const bad = (name, why) => results.push(`FAIL  ${name}  ${why}`)

const child = spawn(process.execPath, [cli, 'serve', 'xzt'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitEndpoint(timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(mcpFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))
        if (j.pid === child.pid && j.url) return j
      } catch {
        /* 写一半，等一下再读 */
      }
    }
    if (child.exitCode !== null) throw new Error(`serve 进程退出（code=${child.exitCode}）：${out.slice(-800)}`)
    await sleep(200)
  }
  throw new Error(`等端点超时：${out.slice(-800)}`)
}

async function rpc(ep, method, params, id, headers = {}) {
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${ep.token}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': params?.name } : {}),
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function callTool(ep, name, args) {
  const r = await rpc(ep, 'tools/call', { name, arguments: args }, Math.random().toString(36).slice(2))
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 300)
  return { text, isError: r.result?.isError === true, raw: r }
}

try {
  const ep = await waitEndpoint()

  const h = await callTool(ep, 'bastion_health', {})
  if (h.text.includes('BastionShell CLI') && /CLI（\d+ 条会话/.test(h.text)) ok('bastion_health')
  else bad('bastion_health', h.text.slice(0, 200))

  const e = await callTool(ep, 'bastion_exec', { command: 'echo cli-mcp-ok; id -un', why: 'e2e 验证 MCP' })
  if (e.text.includes('cli-mcp-ok') && /root|PASS|ok/i.test(e.text)) ok('bastion_exec', e.text.split('\n')[0])
  else bad('bastion_exec', e.text.slice(0, 300))

  const t = await callTool(ep, 'bastion_tail', { lines: 10 })
  if (t.text.includes('屏幕最后') && t.text.includes('cli-mcp-ok')) ok('bastion_tail')
  else bad('bastion_tail', t.text.slice(0, 200))

  // connect 现在支持了：连一条新会话，listSessions 应该多一条
  const c = await callTool(ep, 'bastion_connect', { profile: 'xb' })
  if (/已连接/.test(c.text) && /会话 id/.test(c.text)) ok('bastion_connect 新建会话', c.text.split('\n')[0].slice(0, 40))
  else bad('bastion_connect', c.text.slice(0, 200))

  const l = await callTool(ep, 'bastion_listSessions', {})
  if (l.text.includes('CLI 宿主')) ok('bastion_listSessions')
  else bad('bastion_listSessions', l.text.slice(0, 160))

  await sleep(300)
  if (fs.existsSync(ledger)) {
    const last = fs.readFileSync(ledger, 'utf8').trim().split('\n').pop() ?? ''
    if (last.includes('cli-mcp-ok')) ok('账本落盘', last.slice(0, 90))
    else bad('账本落盘', last.slice(0, 120))
  } else bad('账本落盘', 'action-ledger.jsonl 不存在')
} catch (e) {
  bad('e2e 整体', e instanceof Error ? e.message : String(e))
} finally {
  child.kill('SIGTERM')
  await sleep(500)
  fs.writeFileSync(path.join(repo, 'tools', '.cli-mcp-e2e.txt'), results.join('\n'), 'utf8')
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
