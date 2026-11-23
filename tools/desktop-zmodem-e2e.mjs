// 桌面终端的 zmodem 下载验收（远端 sz → core 收下来 → 事件回给界面）
//
// 用法：node tools/desktop-zmodem-e2e.mjs [档案名，默认 xzt]
// 前置：那台机器装了 lrzsz（/usr/bin/sz）；下载目录得可写（沙箱里用 BASTIONSHELL_DOWNLOAD_DIR 指到工作区）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const EXE = process.env.BASTIONSHELL_EXE?.trim() || path.resolve(import.meta.dirname, '..', '..', 'bastion-wails', 'build', 'bin', 'BastionShell.exe')
const DL = process.env.BASTIONSHELL_DOWNLOAD_DIR?.trim() || path.join(os.homedir(), 'Downloads', 'BastionShell')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const app = spawn(EXE, [], { env: { ...process.env, BASTIONSHELL_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))
const out = []
const ok = (n, x = '') => out.push(`PASS  ${n}${x ? '  ' + x : ''}`)
const bad = (n, w) => out.push(`FAIL  ${n}  ${w}`)

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch('http://127.0.0.1:18090/api/profiles')).ok) break
    } catch {
      /* wait */
    }
    await sleep(250)
  }
  const profiles = await (await fetch('http://127.0.0.1:18090/api/profiles')).json()
  const want = process.argv[2] ?? 'xzt'
  const xzt = profiles.find((p) => p.name === want)

  const ws = new WebSocket('ws://127.0.0.1:18090/ws')
  let data = ''
  const events = []
  let ready = false
  const send = (o) => ws.send(JSON.stringify(o))
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.type === 'data') data += m.data
    if (m.type === 'zmodem') events.push(m.payload)
    if (m.type === 'connected') send({ type: 'connect', connId: 'z1', cols: 120, rows: 30 })
    if (m.type === 'ready') ready = true
  })
  await new Promise((r) => ws.on('open', r))
  send({ type: 'control', connId: 'z1', host: xzt.host, port: xzt.port, user: xzt.username, password: '', key: xzt.privateKeyPath ?? '', passphrase: '' })
  for (let i = 0; i < 200 && !ready; i++) await sleep(200)
  if (!ready) throw new Error('会话没 ready：' + data.slice(-200))
  await sleep(1200)

  // 远端有没有 lrzsz
  send({ type: 'input', data: "command -v sz >/dev/null && printf 'HAS%s\n' SZ || printf 'NO%s\n' SZ" + '\r' })
  let hasSz = false
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    if (/NOSZ/.test(data)) break
    if (/HASSZ/.test(data)) {
      hasSz = true
      break
    }
  }
  if (!hasSz) {
    bad('远端有 lrzsz', 'xzt 上没有 sz，这轮只能验事件通路（跳过下载）')
  } else {
    ok('远端有 lrzsz（sz）')
    fs.mkdirSync(DL, { recursive: true })
    const target = path.join(DL, 'probe-sz.txt')
    fs.rmSync(target, { force: true })
    data = ''
    send({ type: 'input', data: 'printf zmodem-probe > /tmp/probe-sz.txt && sz /tmp/probe-sz.txt\r' })
    let got = null
    for (let i = 0; i < 200; i++) {
      await sleep(250)
      const done = events.find((e) => e.type === 'end' && /probe-sz/.test(String(e.name ?? '')))
      if (done) {
        got = done
        break
      }
    }
    if (got) ok('收到 zmodem end 事件', `${got.name} ${got.bytesTotal} B`)
    else bad('zmodem 事件', '没等到 end：' + JSON.stringify(events))
    await sleep(800)
    const landed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    if (landed.includes('zmodem-probe')) ok('文件落到下载目录', target)
    else bad('文件落盘', `${target} 不存在或内容不对：${landed.slice(0, 40)}`)
  }
  ws.close()
} catch (e) {
  bad('验证整体', e instanceof Error ? e.message : String(e))
} finally {
  app.kill()
  await sleep(6500)
  console.log(out.join('\n'))
  console.log('\n--- log 关键行 ---')
  console.log(log.split('\n').filter((l) => /zmodem|ZMODEM|传输|下载/.test(l)).slice(-8).join('\n'))
  console.log(`\nTOTAL pass=${out.filter((r) => r.startsWith('PASS')).length} fail=${out.filter((r) => r.startsWith('FAIL')).length}`)
  process.exit(out.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}
