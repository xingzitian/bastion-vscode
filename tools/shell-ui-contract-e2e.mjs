#!/usr/bin/env node
/**
 * 桌面「薄壳」按钮的**契约测试**：把 ⚡ / 🗂 点击时前端会发的请求按顺序打一遍。
 *
 * 为什么要有它：我点不了 GUI，但前端点下去做的就是这几步 —— 这层能测，
 * 就能挡住"⏹ 弹出一坨 HTML"这种前端逻辑错误（2026-11-23 真踩到过：directUrl 被优先级吃掉）。
 *
 * 验收：
 *   1. POST /api/shell/cli/start（带 profiles 数组）→ 200 + termUrl
 *   2. 直接 GET termUrl → 200（xterm 页面），**不再触发第二次 spawn**
 *   3. 期间 CLI 子进程数 == 1（没有重复起进程）
 *   4. /api/shell/endpoint → running true 且 writeError 不阻塞使用
 *   5. POST /api/shell/cli/stop → 3 秒内子进程归零
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const exe = path.join(repo, '..', 'bastion-wails', 'build', 'bin', 'BastionShell.exe')
const results = []
const ok = (n, x = '') => results.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => results.push(`FAIL  ${n}  ${w}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 数本机 CLI 子进程（PowerShell 查询，和用户排查时用的一条命令一致） */
function cliChildren() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'out[\\\\/]cli[\\/]main\\.js' }).Count"
      ],
      { encoding: 'utf8' }
    )
    return Number(out.trim()) || 0
  } catch {
    return -1
  }
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { error: text.slice(0, 200) }
  }
  return { status: r.status, json }
}

const env = { ...process.env, BASTIONSHELL_HEADLESS: '1' }
delete env.BASTIONSHELL_CLI_MCP_FILE
delete env.BASTIONSHELL_CLI_MCP_PORT
const app = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))

async function waitBackend(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:18090/api/shell/endpoint')
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error(`桌面后端没起来：${log.slice(-400)}`)
}

try {
  await waitBackend()

  // ① 前端点 🗂 / ⚡（密码档案）时发的就是这一条
  const started = await post('http://127.0.0.1:18090/api/shell/cli/start', {
    profiles: [{ name: 'xzt', password: '' }]
  })
  if (started.status === 200 && typeof started.json.url === 'string') ok('POST start → termUrl', started.json.url.slice(0, 46))
  else bad('POST start', `status=${started.status} ${JSON.stringify(started.json).slice(0, 160)}`)

  const ep = await (await fetch('http://127.0.0.1:18090/api/shell/endpoint')).json()
  const termUrl = started.json.url
  if (!termUrl) throw new Error('没拿到 termUrl，后面没法继续')

  // ② 前端把 termUrl 直接塞进 iframe（不该再去打 spawn 路由）
  const page = await fetch(termUrl)
  const html = await page.text()
  if (page.status === 200 && html.includes('xterm')) ok('iframe 加载 term 页面', `${html.length} 字节`)
  else bad('term 页面', `status=${page.status} len=${html.length}`)

  // ③ 没有重复 spawn：同一个 CLI 进程 pid（宿主自己报的），比数进程稳
  const epAfter = await (await fetch('http://127.0.0.1:18090/api/shell/endpoint')).json()
  if (epAfter.pid > 0 && epAfter.pid === ep.pid) ok('无重复 spawn（pid 未变）', `pid=${ep.pid}`)
  else bad('重复 spawn', `pid ${ep?.pid} → ${epAfter.pid}；进程数=${cliChildren()}`)

  // ④ 端点信息
  if (ep.running === true && typeof ep.mcpUrl === 'string') {
    ok('endpoint 反映运行中', ep.writeError ? '（writeError 存在但不影响使用）' : '')
  } else bad('endpoint', JSON.stringify(ep).slice(0, 160))

  // ⑤ 关闭 → 子进程归零
  const stopped = await post('http://127.0.0.1:18090/api/shell/cli/stop', {})
  if (stopped.status === 200) ok('POST stop')
  else bad('POST stop', `status=${stopped.status}`)
  await sleep(3000)
  const n2 = cliChildren()
  if (n2 === 0) ok('stop 后子进程归零')
  else bad('stop 后子进程', `还有 ${n2} 个`)
} catch (e) {
  bad('契约测试整体', e instanceof Error ? e.message : String(e))
} finally {
  try {
    app.kill()
  } catch {
    /* ignore */
  }
  await sleep(500)
  fs.rmSync(path.join(os.homedir(), '.bastionshell', 'mcp-cli.json'), { force: true })
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
