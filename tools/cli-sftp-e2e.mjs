#!/usr/bin/env node
/**
 * CLI 宿主的传文件 e2e（A2 之后）：起 serve，走 MCP 调 bastion_push / bastion_pull。
 *
 * 验收：
 *   1. push 一个本地文件到 /tmp（SFTP 优先，直连档案）
 *   2. 远端 md5 与本机一致（复用 exec 算 md5）
 *   3. pull 回本机 downloads/，内容一致
 *   4. 覆盖策略：再 push 一次同样大小 → skipped（不重复传）
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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

const child = spawn(process.execPath, [cli, 'serve', 'xzt'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

async function waitEndpoint(timeoutMs = 30000) {
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
    if (child.exitCode !== null) throw new Error(`serve 退出：${log.slice(-600)}`)
    await sleep(200)
  }
  throw new Error(`等端点超时：${log.slice(-600)}`)
}

async function rpc(ep, method, params) {
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${ep.token}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': params?.name } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.random().toString(36).slice(2), method, params })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function call(ep, name, args) {
  const r = await rpc(ep, 'tools/call', { name, arguments: args })
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 300)
  return { text, isError: r.result?.isError === true }
}

function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
}

try {
  const ep = await waitEndpoint()
  const local = path.join(os.tmpdir(), `bs-sftp-e2e-${Date.now()}.txt`)
  const body = `cli sftp e2e ${new Date().toISOString()}\n` + 'x'.repeat(200) + '\n'
  fs.writeFileSync(local, body, 'utf8')
  const localMd5 = md5(local)
  const remoteName = path.basename(local)

  const pushed = await call(ep, 'bastion_push', { localPath: local, remoteDir: '/tmp' })
  if (/已上传/.test(pushed.text) && pushed.text.includes('/tmp/')) ok('bastion_push', pushed.text.replace(/\n/g, ' '))
  else bad('bastion_push', pushed.text.slice(0, 300))

  const sum = await call(ep, 'bastion_exec', { command: `md5sum /tmp/${remoteName}`, why: 'e2e 校验上传' })
  if (sum.text.includes(localMd5)) ok('远端 md5 一致', localMd5.slice(0, 12))
  else bad('远端 md5', sum.text.slice(0, 200))

  const pushAgain = await call(ep, 'bastion_push', { localPath: local, remoteDir: '/tmp' })
  if (/已存在|跳过|跳过同大小|skipped/i.test(pushAgain.text)) ok('同大小不重复传', pushAgain.text.replace(/\n/g, ' ').slice(0, 80))
  else bad('覆盖策略', pushAgain.text.slice(0, 160))

  const dlDir = path.join(repo, 'downloads')
  const pulled = await call(ep, 'bastion_pull', { remotePath: `/tmp/${remoteName}`, localDir: dlDir })
  const gotPath = path.join(dlDir, remoteName)
  if (/已下载/.test(pulled.text) && fs.existsSync(gotPath) && md5(gotPath) === localMd5) {
    ok('bastion_pull 内容一致', gotPath)
  } else bad('bastion_pull', `${pulled.text.slice(0, 200)} exists=${fs.existsSync(gotPath)}`)

  const bad1 = await call(ep, 'bastion_push', {})
  if (/需要 localPath/.test(bad1.text)) ok('缺参数有明确报错')
  else bad('缺参数', bad1.text.slice(0, 120))
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
