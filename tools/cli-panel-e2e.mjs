#!/usr/bin/env node
/**
 * 行动面板 e2e：CLI 宿主的 /ui 及三个实时接口。
 *
 * 验收：
 *   1. /ui 返回 HTML（含面板标题）
 *   2. /ui/actions 返回 {html, groupsTotal}，且 html 里含刚才那次 exec 的摘要
 *   3. /ui/status 返回 {working}
 *   4. /ui/cancel 只接受 POST；POST 一个不存在的 job 也返回 ok（尽力而为）
 *   5. /ui/stream 是 SSE（能收到注释/事件帧）
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

const child = spawn(process.execPath, [cli, 'serve', 'xzt'], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
let termUrl = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => {
  log += d
  const m = /浏览器打开：(http:\/\/127\.0\.0\.1:\d+\/term\?token=[A-Za-z0-9_-]+)/.exec(log)
  if (m && !termUrl) termUrl = m[1]
})

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return
    await sleep(200)
  }
  throw new Error(`等待超时：${label}\n${log.slice(-500)}`)
}

async function rpc(ep, name, args) {
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
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name, arguments: args } })
  })
  return JSON.parse(await res.text()).result?.content?.[0]?.text ?? ''
}

try {
  await waitFor(() => termUrl !== '', 40000, '网页终端 URL')
  const u = new URL(termUrl)
  const base = `http://127.0.0.1:${u.port}`
  const token = u.searchParams.get('token')
  const ep = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))

  const ran = await rpc(ep, 'bastion_exec', { command: 'echo panel-e2e', why: '面板 e2e' })
  if (!ran.includes('panel-e2e')) throw new Error(`exec 没跑通：${ran.slice(0, 120)}`)

  const page = await fetch(`${base}/ui?token=${token}`)
  const html = await page.text()
  if (page.status === 200 && html.includes('行动面板')) ok('/ui 页面')
  else bad('/ui', `status=${page.status} len=${html.length}`)

  if (html.includes('id="sess"') && /<option value="s-/.test(html)) ok('/ui 有会话下拉')
  else bad('/ui 会话下拉', '没找到 select/option')

  const panel = await fetch(`${base}/ui/panel?session=${encodeURIComponent(ep.sessionId ?? '')}&token=${token}`)
  const panelHtml = await panel.text()
  if (panel.status === 200 && panelHtml.includes('行动面板')) ok('/ui/panel 可渲染')
  else bad('/ui/panel', `status=${panel.status}`)

  const acts = await fetch(`${base}/ui/actions?limit=50&token=${token}`)
  const aj = await acts.json()
  if (acts.status === 200 && typeof aj.html === 'string' && /panel-e2e|echo/.test(aj.html)) {
    ok('/ui/actions 有新动作', `groupsTotal=${aj.groupsTotal}`)
  } else bad('/ui/actions', JSON.stringify(aj).slice(0, 200))

  const st = await fetch(`${base}/ui/status?token=${token}`)
  const sj = await st.json()
  if (st.status === 200 && typeof sj.working === 'number') ok('/ui/status', `working=${sj.working}`)
  else bad('/ui/status', JSON.stringify(sj))

  const getCancel = await fetch(`${base}/ui/cancel?token=${token}`)
  if (getCancel.status === 405) ok('/ui/cancel 只收 POST')
  else bad('/ui/cancel GET', `status=${getCancel.status}`)

  const postCancel = await fetch(`${base}/ui/cancel?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'j-nonexistent' })
  })
  if (postCancel.status === 200) ok('/ui/cancel POST 尽力而为')
  else bad('/ui/cancel POST', `status=${postCancel.status}`)

  // SSE：读到第一帧注释就算通
  const ctrl = new AbortController()
  const sse = fetch(`${base}/ui/stream?token=${token}`, { signal: ctrl.signal })
  const r = await sse
  const reader = r.body.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value ?? new Uint8Array())
  ctrl.abort()
  if (r.status === 200 && /^: connected/m.test(text)) ok('/ui/stream SSE', text.split('\n')[0])
  else bad('/ui/stream', `status=${r.status} first=${JSON.stringify(text.slice(0, 40))}`)

  // 无 token 一律 401
  const noTok = await fetch(`${base}/ui/actions`)
  if (noTok.status === 401) ok('面板接口需要 token')
  else bad('无 token', `status=${noTok.status}`)
} catch (e) {
  bad('e2e 整体', e instanceof Error ? e.message : String(e))
} finally {
  child.kill('SIGTERM')
  await sleep(600)
  fs.rmSync(mcpFile, { force: true })
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
