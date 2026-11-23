#!/usr/bin/env node
/**
 * 「界面后端」契约测试：完全按桌面 React 界面（shim.js）的报文顺序驱动 CLI 后端。
 *
 * 验收：
 *   1. GET /api/profiles 返回共享档案（name/host/port 都在）
 *   2. WS 发 {type:'control'} → 收到 {type:'connected'}
 *   3. WS 发 {type:'connect'} → 收到 {type:'ready'}
 *   4. 发 {type:'input', data:'echo ui-backend-ok\r'} → 收到含该字符串的 {type:'data'}
 *   5. 未实现的接口明确 501（不假装成功）
 *
 * 用法：node tools/ui-backend-e2e.mjs
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import WebSocket from 'ws'

const repo = path.resolve(import.meta.dirname, '..')
const cli = path.join(repo, 'out', 'cli', 'main.js')
const PORT = 18190 // 避开桌面版占用的 18090
const results = []
const ok = (n, x = '') => results.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => results.push(`FAIL  ${n}  ${w}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(process.execPath, [cli, 'ui', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

async function waitServer(timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/profiles`)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error(`界面后端没起来：${log.slice(-400)}`)
}

try {
  await waitServer()

  // ① 档案
  const profiles = await (await fetch(`http://127.0.0.1:${PORT}/api/profiles`)).json()
  const xzt = profiles.find((p) => p.name === 'xzt')
  if (xzt && xzt.host && xzt.username) ok('/api/profiles', `${profiles.length} 条，xzt=${xzt.host}`)
  else bad('/api/profiles', JSON.stringify(profiles).slice(0, 200))

  // ②③④ 按界面的顺序驱动 WS
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const seen = []
  const data = []
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 ready 超时；收到 ${seen.join(',')}`)), 25000)
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'control',
          connId: 'conn-e2e',
          host: xzt.host,
          port: xzt.port,
          user: xzt.username,
          password: '',
          key: xzt.privateKeyPath ?? '',
          passphrase: ''
        })
      )
    })
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      seen.push(m.type)
      if (m.type === 'error') {
        clearTimeout(timer)
        reject(new Error(m.message))
        return
      }
      if (m.type === 'connected') {
        ws.send(JSON.stringify({ type: 'connect', connId: 'conn-e2e', cols: 100, rows: 30 }))
        return
      }
      if (m.type === 'ready') {
        ws.send(JSON.stringify({ type: 'input', data: 'echo ui-backend-ok\r' }))
        return
      }
      if (m.type === 'data') {
        data.push(m.data)
        if (data.join('').includes('ui-backend-ok')) {
          clearTimeout(timer)
          resolve()
        }
      }
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })

  if (seen.includes('connected')) ok('WS control → connected')
  else bad('WS control', seen.join(','))
  if (seen.includes('ready')) ok('WS connect → ready')
  else bad('WS connect', seen.join(','))
  const text = data.join('')
  if (text.includes('ui-backend-ok')) ok('input → data 回路', `${text.length} 字节`)
  else bad('input → data', text.slice(-160) || '(无输出)')

  ws.close()

  // ⑤ 未实现接口
  const up = await fetch(`http://127.0.0.1:${PORT}/api/upload`, { method: 'POST' })
  if (up.status === 501) ok('未实现接口明确 501')
  else bad('/api/upload', `status=${up.status}`)
} catch (e) {
  bad('e2e 整体', e instanceof Error ? e.message : String(e))
} finally {
  child.kill('SIGTERM')
  await sleep(500)
  console.log(results.join('\n'))
  console.log(`\nTOTAL pass=${results.filter((r) => r.startsWith('PASS')).length} fail=${results.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
