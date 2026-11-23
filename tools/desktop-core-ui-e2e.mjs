#!/usr/bin/env node
/**
 * 「统一核心」验收：桌面 exe（headless）起 core 后端在 18090，
 * 然后完全按界面（shim.js）的报文顺序驱动 /ws，证明界面路径已经跑在 core 上。
 *
 * 用法：node tools/desktop-core-ui-e2e.mjs
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import WebSocket from 'ws'

const repo = path.resolve(import.meta.dirname, '..')
const exe = path.join(repo, '..', 'bastion-wails', 'build', 'bin', 'BastionShell.exe')
const results = []
const ok = (n, x = '') => results.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => results.push(`FAIL  ${n}  ${w}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = spawn(exe, [], {
  env: { ...process.env, BASTIONSHELL_HEADLESS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))

async function wait(fn, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return
    await sleep(200)
  }
  throw new Error(`等超时：${label}\n${log.slice(-400)}`)
}

try {
  await wait(async () => {
    try {
      return (await fetch('http://127.0.0.1:18090/api/profiles')).ok
    } catch {
      return false
    }
  }, 20000, 'core 后端 18090')

  const profiles = await (await fetch('http://127.0.0.1:18090/api/profiles')).json()
  if (profiles.length >= 5 && profiles.every((p) => p.name)) ok('/api/profiles 来自 core', `${profiles.length} 条`)
  else bad('/api/profiles', JSON.stringify(profiles).slice(0, 160))

  const p = profiles.find((x) => x.name === 'xzt')
  if (!p) throw new Error('没有 xzt 档案')

  const seen = []
  let out = ''
  const ws = new WebSocket('ws://127.0.0.1:18090/ws')
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等 ready 超时；收到 ${seen.join(',')}`)), 30000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'control',
          connId: 'c1',
          host: p.host,
          port: p.port,
          user: p.username,
          password: '',
          key: p.privateKeyPath ?? '',
          passphrase: ''
        })
      )
    )
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      seen.push(m.type)
      if (m.type === 'error') {
        clearTimeout(t)
        reject(new Error(m.message))
      }
      if (m.type === 'connected') ws.send(JSON.stringify({ type: 'connect', connId: 'c1', cols: 100, rows: 30 }))
      if (m.type === 'ready') ws.send(JSON.stringify({ type: 'input', data: 'echo core-ui-ok\r' }))
      if (m.type === 'data') {
        out += m.data
        if (out.includes('core-ui-ok')) {
          clearTimeout(t)
          resolve()
        }
      }
    })
    ws.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
  ws.close()

  if (seen.includes('connected') && seen.includes('ready')) ok('WS control → connected → ready', seen.join('→'))
  else bad('WS 握手', seen.join(','))
  if (out.includes('core-ui-ok')) ok('input → data 回显', String(out.length) + ' 字节')
  else bad('回显', out.slice(-160))

  // 「AI 访问」页面：Go 的 MCP 层删了之后由 core 出这份数据，字段名必须还能喂给旧界面
  const ai = await (await fetch('http://127.0.0.1:18090/api/ai-access')).json()
  const aiOk =
    ai.mainOnly === true &&
    typeof ai.token === 'string' &&
    ai.token.length > 0 &&
    typeof ai.tokenMasked === 'string' &&
    !ai.tokenMasked.includes(ai.token.slice(4, -4)) &&
    ai.endpoint.includes('/mcp') &&
    Array.isArray(ai.clients) &&
    ai.clients[0]?.isMain === true
  if (aiOk) ok('/api/ai-access 由 core 提供', `endpoint=${ai.endpoint} token=${ai.tokenMasked}`)
  else bad('/api/ai-access', JSON.stringify(ai).slice(0, 200))
  if (Array.isArray(ai.sessions) && ai.sessions.some((s) => String(s.id).startsWith('s-')))
    ok('界面会话出现在 AI 访问里', `${ai.sessions.length} 条`)
  else bad('AI 访问会话行', JSON.stringify(ai.sessions).slice(0, 160))

  const un = await (
    await fetch('http://127.0.0.1:18090/api/ai-access/unbind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'no-such-client', alias: 'ZZ' })
    })
  ).json()
  if (un.ok === false) ok('解绑不存在的绑定 → ok:false（不写文件）')
  else bad('解绑', JSON.stringify(un))
} catch (e) {
  bad('e2e 整体', e instanceof Error ? e.message : String(e))
} finally {
  app.kill()
  await sleep(6500) // 等核心后端的父进程守卫退出
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
