// 桌面会话链路验收：① 上传落到 shell 当前目录  ② 桌面 bastion_connect 可用
//
// 用法：node tools/desktop-session-e2e.mjs [档案名，默认 xzt]
// 跑的是仓库里构建出来的 build/bin exe（它会从仓库加载 out/cli/main.js）。
// 跑的是仓库里刚构建的 exe（build/bin），它会从仓库加载 out/cli/main.js。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import WebSocket from 'ws'

const EXE = process.env.BASTIONSHELL_EXE?.trim() || path.resolve(import.meta.dirname, '..', '..', 'bastion-wails', 'build', 'bin', 'BastionShell.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const app = spawn(EXE, [], { env: { ...process.env, BASTIONSHELL_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))
const out = []
const ok = (n, x = '') => out.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => out.push(`FAIL  ${n}  ${w}`)

async function up() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch('http://127.0.0.1:18090/api/profiles')).ok) return
    } catch {
      /* wait */
    }
    await sleep(250)
  }
  throw new Error('18090 没起来：' + log.slice(-300))
}

async function mcpToolsCall(name, args) {
  const ai = await (await fetch('http://127.0.0.1:18090/api/ai-access')).json()
  const hdr = { 'content-type': 'application/json', authorization: 'Bearer ' + ai.token, accept: 'application/json, text/event-stream' }
  const r0 = await fetch(ai.endpoint, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } })
  })
  const sid = r0.headers.get('mcp-session-id')
  const h2 = sid ? { ...hdr, 'mcp-session-id': sid } : hdr
  await fetch(ai.endpoint, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => undefined)
  const r = await fetch(ai.endpoint, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) })
  const text = await r.text()
  const line = text.split('\n').find((l) => l.includes('"jsonrpc"')) ?? text
  return JSON.parse(line)
}

try {
  await up()
  const profiles = await (await fetch('http://127.0.0.1:18090/api/profiles')).json()
  const want = process.argv[2] ?? 'xzt'
  const xzt = profiles.find((p) => p.name === want)
  if (!xzt) throw new Error('没有 xzt 档案')

  // ---- ② 桌面 MCP：bastion_connect（密钥档案，不需要密码） ----
  const cn = await mcpToolsCall('bastion_connect', { profile: 'xzt' })
  const cnText = JSON.stringify(cn.result ?? cn.error ?? cn)
  if (/已连接/.test(cnText)) ok('桌面 bastion_connect 可用', cnText.slice(0, 120))
  else bad('bastion_connect', cnText.slice(0, 260))

  // ---- ① 上传落点 ----
  const ws = new WebSocket('ws://127.0.0.1:18090/ws')
  let data = ''
  let ready = false
  let uploadDone = false
  let uploadErr = ''
  const send = (o) => ws.send(JSON.stringify(o))
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.type === 'data') data += m.data
    if (m.type === 'connected') send({ type: 'connect', connId: 'c1', cols: 120, rows: 30 })
    if (m.type === 'ready') {
      ready = true
      send({ type: 'input', data: 'mkdir -p /tmp/bscwdtest && cd /tmp/bscwdtest\r' })
    }
    if (m.type === 'upload:done') uploadDone = true
    if (m.type === 'upload:error') uploadErr = m.message
  })
  await new Promise((r) => ws.on('open', r))
  send({ type: 'control', connId: 'c1', host: xzt.host, port: xzt.port, user: xzt.username, password: '', key: xzt.privateKeyPath ?? '', passphrase: '' })

  for (let i = 0; i < 150 && !ready; i++) await sleep(200)
  if (!ready) throw new Error('会话没 ready：' + data.slice(-300))
  await sleep(1500) // 等 cd 生效

  const tmp = path.join(os.tmpdir(), 'cwd-probe.txt')
  fs.writeFileSync(tmp, 'cwd-probe-ok')
  send({ type: 'upload', paths: [tmp] })
  for (let i = 0; i < 250 && !uploadDone && !uploadErr; i++) await sleep(200)
  if (uploadDone) ok('上传动作完成（upload:done）')
  else bad('上传动作', uploadErr || '没有 upload:done')

  data = ''
  send({ type: 'input', data: 'ls -l /tmp/bscwdtest; pwd\r' })
  let listed = false
  for (let i = 0; i < 100 && !listed; i++) {
    await sleep(200)
    listed = /cwd-probe\.txt/.test(data)
  }
  if (listed) ok('上传落到 shell 当前目录', '/tmp/bscwdtest 里有 cwd-probe.txt')
  else bad('上传落点', '在 /tmp/bscwdtest 里没看到：' + data.slice(-200))
  ws.close()
} catch (e) {
  bad('验证整体', e instanceof Error ? e.message : String(e))
} finally {
  app.kill()
  await sleep(6500)
  console.log(out.join('\n'))
  console.log('\n--- log 关键行 ---')
  console.log(log.split('\n').filter((l) => /上传|密码|新建连接|连接已建立|pwd/.test(l)).slice(-10).join('\n'))
  console.log(`\nTOTAL pass=${out.filter((r) => r.startsWith('PASS')).length} fail=${out.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(out.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
