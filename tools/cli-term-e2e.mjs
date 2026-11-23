#!/usr/bin/env node
/**
 * 网页终端 e2e：起 `serve xzt`，从日志里拿终端 URL，用 WS 真的敲一条命令。
 *
 * 验收（A3）：
 *   1. /term 返回 HTML（含 xterm.js 引用）
 *   2. 没有 token → 401
 *   3. WS 连上后发 {t:'in'} → 收到 {t:'out'} 且含命令输出（真终端回显）
 *   4. /ui 面板能渲染（含账本卡片）
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

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
  const m = /浏览器打开：(http:\/\/127\.0\.0\.1:\d+\/term\?token=[A-Za-z0-9]+)/.exec(log)
  if (m && !termUrl) termUrl = m[1]
})

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await sleep(200)
  }
  throw new Error(`等待超时：${label}\n${log.slice(-800)}`)
}

try {
  await waitFor(() => termUrl !== '', 30000, '网页终端 URL')
  const u = new URL(termUrl)
  const token = u.searchParams.get('token')

  const page = await fetch(termUrl)
  const html = await page.text()
  if (page.status === 200 && html.includes('/xterm/xterm.js') && html.includes('Terminal')) ok('/term 返回页面')
  else bad('/term', `status=${page.status} len=${html.length}`)

  const noTok = await fetch(`http://127.0.0.1:${u.port}/term`)
  if (noTok.status === 401) ok('无 token → 401')
  else bad('无 token', `status=${noTok.status}`)

  const asset = await fetch(`http://127.0.0.1:${u.port}/xterm/xterm.js?token=${token}`)
  if (asset.status === 200 && (await asset.text()).length > 10000) ok('xterm.js 本地资源可读')
  else bad('xterm.js', `status=${asset.status}`)

  // WS：真敲一条命令
  const got = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${u.port}/term/ws?token=${token}`)
    let acc = ''
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(acc)
    }, 12000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 30 }))
      ws.send(JSON.stringify({ t: 'in', d: 'echo web-term-ok\r' }))
    })
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.t === 'out') acc += Buffer.from(m.d, 'base64').toString('utf8')
        if (acc.includes('web-term-ok') && acc.split('web-term-ok').length > 1) {
          clearTimeout(timer)
          ws.close()
          resolve(acc)
        }
      } catch {
        /* ignore */
      }
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(acc)
    })
  })
  if (got.includes('web-term-ok')) ok('WS 输入→远端→输出回路', `收到 ${got.length} 字节`)
  else bad('WS 回路', got.slice(-200) || '(无输出)')

  const ui = await fetch(`http://127.0.0.1:${u.port}/ui?token=${token}`)
  const uiHtml = await ui.text()
  if (ui.status === 200 && uiHtml.includes('BastionShell')) ok('/ui 面板可渲染')
  else bad('/ui', `status=${ui.status} len=${uiHtml.length}`)
} catch (e) {
  bad('e2e 整体', e instanceof Error ? e.message : String(e))
} finally {
  child.kill('SIGTERM')
  await sleep(600)
  try {
    fs.rmSync(mcpFile, { force: true })
  } catch {
    /* ignore */
  }
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
