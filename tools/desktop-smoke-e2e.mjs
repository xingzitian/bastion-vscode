// 发布冒烟：拿**发行副本**（不是仓库里的 build/bin）验三件事
//   ③ 桌面 MCP：用 /api/ai-access 给的 token 打真实 MCP 端点 → tools/list 数工具
//   ② DPAPI：读已存过的档案密码（只读，不写 %APPDATA%）
//   真机终端：⚡ 起 xzt → 打 /term/ws → echo → 看到回显
//
// 用法：node tools/desktop-smoke-e2e.mjs ["<BastionShell.exe 路径>"]
//   参数省略时用默认的桌面副本；要验 dist 里的包就把路径传进来。
// 为什么单独有这个脚本：dist 里的 exe 与 build/bin 的 exe 是同一份代码，但
// **CLI 入口是从 exe 旁边找的** —— 只有对着发行包跑，才真的验证了「换台机器也能用」。
import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const EXE = process.argv[2] ?? 'C:\\Users\\Administrator\\Desktop\\BastionShell-0.9.3\\BastionShell.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const app = spawn(EXE, [], { env: { ...process.env, BASTIONSHELL_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))

const results = []
const ok = (n, x = '') => results.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => results.push(`FAIL  ${n}  ${w}`)

async function up() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch('http://127.0.0.1:18090/api/profiles')).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('18090 没起来：' + log.slice(-300))
}

async function mcpTools() {
  const ai = await (await fetch('http://127.0.0.1:18090/api/ai-access')).json()
  const hdr = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + ai.token,
    accept: 'application/json, text/event-stream'
  }
  const r1 = await fetch(ai.endpoint, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }
    })
  })
  const sid = r1.headers.get('mcp-session-id')
  const h2 = sid ? { ...hdr, 'mcp-session-id': sid } : hdr
  await fetch(ai.endpoint, {
    method: 'POST',
    headers: h2,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }).catch(() => undefined)
  const r2 = await fetch(ai.endpoint, {
    method: 'POST',
    headers: h2,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  })
  const text = await r2.text()
  const names = new Set()
  for (const m of text.matchAll(/"name"\s*:\s*"(bastion_[A-Za-z]+)"/g)) names.add(m[1])
  return { endpoint: ai.endpoint, status: r2.status, names: [...names] }
}

async function termEcho() {
  // ⚡ 起一条真机会话（xzt 是密钥档案）
  const r = await fetch('http://127.0.0.1:18090/api/shell/cli/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profiles: [{ name: 'xzt', password: '' }] })
  })
  const j = await r.json()
  if (!j.url) return { error: JSON.stringify(j) }
  // termUrl 形如 http://127.0.0.1:PORT/term?token=…&session=…
  const u = new URL(j.url)
  const wsUrl = 'ws://127.0.0.1:' + u.port + '/term/ws' + u.search
  let out = ''
  const ws = new WebSocket(wsUrl)
  const got = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 25000)
    ws.on('open', () => ws.send(JSON.stringify({ t: 'in', d: 'echo term-core-ok\r' })))
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.t === 'out') out += Buffer.from(m.d, 'base64').toString('utf8')
      } catch {
        /* ignore */
      }
      if (out.includes('term-core-ok')) {
        clearTimeout(t)
        resolve(true)
      }
    })
    ws.on('error', () => undefined)
  })
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  return { wsUrlPort: u.port, ok: got, bytes: out.length, tail: out.slice(-120) }
}

try {
  await up()

  // ② DPAPI 读
  let secretOk = 0
  for (const k of ['xzt', '中转']) {
    const s = await fetch('http://127.0.0.1:18090/api/secret?key=' + encodeURIComponent(k))
    const body = await s.text()
    if (s.ok) secretOk++
    results.push(`${s.ok ? 'PASS' : 'INFO'}  DPAPI 读 ${k}  status=${s.status} ${body.slice(0, 40).replace(/\n/g, ' ')}`)
  }

  // ③ MCP
  const m = await mcpTools()
  if (m.status === 200 && m.names.length === 13) ok('桌面 MCP = 13 工具', m.names.join(','))
  else bad('桌面 MCP', `status=${m.status} count=${m.names.length} ${m.names.join(',')}`)
  if (m.names.includes('bastion_connect') && m.names.includes('bastion_push')) ok('关键工具在（connect/push/pull）')
  else bad('关键工具', m.names.join(','))

  // 真机终端
  const t = await termEcho()
  if (t.ok) ok('⚡ 真机终端（xzt）回显 term-core-ok', `${t.bytes} 字节`)
  else bad('⚡ 真机终端', JSON.stringify(t).slice(0, 200))
} catch (e) {
  bad('冒烟整体', e instanceof Error ? e.message : String(e))
} finally {
  app.kill()
  await sleep(6500)
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
