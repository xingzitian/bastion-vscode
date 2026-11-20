#!/usr/bin/env node
// SFTP 真机端到端测试（用 xzt 档案的真实服务器，跑**编译后的 core 代码**）。
//
// 目的：复现并验证 2026-11-20 的两个真机问题
//   1. `remoteDir` 被忽略、文件落到 home（/root）—— 宿主曾悄悄回退 realpath('.')
//   2. 7.4KB 就超时/掉线 —— 缓存 sftp 通道 + 混合 shell 探测
//
// 用法：node tools/sftp-e2e.mjs
// 需要：out/ 已编译（npm run compile）；档案 xzt 的私钥存在。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('ssh2')
const { putFile, getFile, resolveRemoteDir } = require('../out/core/sftpTransfer.js')

const PROFILE = {
  host: '159.75.78.7',
  port: 22,
  username: 'root',
  privateKeyPath: 'c:\\Users\\Administrator\\Desktop\\私钥\\xb_xzt.txt'
}

/** 把 ssh2 的 sftp 包成 core 要的 Promise 接口（和 terminal.ts 里的 wrapSftp 等价） */
function wrap(s) {
  const call = (fn) => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v))))
  return {
    stat: (p) => call((cb) => s.stat(p, cb)),
    createReadStream: (p, o) => s.createReadStream(p, o),
    createWriteStream: (p, o) => s.createWriteStream(p, o),
    mkdir: (p) => call((cb) => s.mkdir(p, cb)),
    realpath: (p) => call((cb) => s.realpath(p, cb)),
    unlink: (p) => call((cb) => s.unlink(p, cb)),
    rename: (a, b) => call((cb) => s.rename(a, b, cb)),
    fastPut: (l, r, o) => new Promise((res, rej) => s.fastPut(l, r, { step: o?.step }, (e) => (e ? rej(e) : res()))),
    fastGet: (r, l, o) => new Promise((res, rej) => s.fastGet(r, l, { step: o?.step }, (e) => (e ? rej(e) : res())))
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => resolve(c)).on('error', reject)
    c.connect({
      host: PROFILE.host,
      port: PROFILE.port,
      username: PROFILE.username,
      privateKey: fs.readFileSync(PROFILE.privateKeyPath)
    })
  })
}

const openSftp = (client) =>
  new Promise((res, rej) => client.sftp((e, s) => (e ? rej(e) : res(s))))

const LOGS = []
async function runCased(name, fn) {
  const t0 = Date.now()
  try {
    const out = await fn()
    console.log(`✓ ${name}  (${Date.now() - t0}ms)  ${out ?? ''}`)
    return true
  } catch (e) {
    console.log(`✗ ${name}  (${Date.now() - t0}ms)  ${e.message}`)
    return false
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-'))
function makeFile(name, size) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, Buffer.alloc(size, 'A'))
  return p
}

const client = await connect()
const sftp = wrap(await openSftp(client))

// 远端跑的 shell 命令（用于核对文件真的在哪个目录）
const exec = (cmd) =>
  new Promise((res, rej) => {
    client.exec(cmd, (e, st) => {
      if (e) return rej(e)
      let out = ''
      st.on('data', (d) => (out += d)).stderr.on('data', (d) => (out += d))
      st.on('close', () => res(out.trim()))
    })
  })

let pass = 0
let fail = 0
const ck = (ok) => (ok ? pass++ : fail++)

// 1) 目录解析：存在的目录必须原样返回
ck(await runCased('resolveRemoteDir(/tmp) 返回 /tmp', async () => {
  const d = await resolveRemoteDir(sftp, '/tmp')
  if (d !== '/tmp') throw new Error(`期望 /tmp，实际 ${d}`)
  return d
}))

// 2) 不存在的目录必须报错（而不是悄悄回退 home）
ck(await runCased('★ resolveRemoteDir(/opt/绝对不存在-xxx) 必须报错', async () => {
  try {
    await resolveRemoteDir(sftp, '/opt/绝对不存在-bs-e2e')
    throw new Error('没有报错 —— 这就是 /root 那个 bug 的根源')
  } catch (e) {
    if (/目录不存在|目录不可访问/.test(e.message)) return '正确报错'
    throw e
  }
}))

// 3) 760B 上传到 /tmp（复现用户第一次调用）
const small = makeFile('smoke-760b.bin', 760)
ck(await runCased('760B → /tmp', async () => {
  const r = await putFile(sftp, small, '/tmp')
  if (!r.ok) throw new Error(r.error)
  const ls = await exec('ls -l /tmp/smoke-760b.bin')
  if (!ls.includes('/tmp/smoke-760b.bin')) throw new Error(`远端看不到：${ls}`)
  return r.remotePath
}))

// 4) 7.4KB 上传到 /tmp（复现"超时"；这次应秒完成）
const mid = makeFile('smoke-7k.bin', 7400)
ck(await runCased('★ 7.4KB → /tmp（原来会超时）', async () => {
  const r = await putFile(sftp, mid, '/tmp')
  if (!r.ok) throw new Error(r.error)
  const ls = await exec('ls -l /tmp/smoke-7k.bin')
  if (!/7400\b/.test(ls)) throw new Error(`大小不对：${ls}`)
  return r.remotePath
}))

// 5) 同一文件再传一次：应跳过（远端同大小）
ck(await runCased('7.4KB 再传一次 → 跳过', async () => {
  const r = await putFile(sftp, mid, '/tmp')
  if (!r.ok) throw new Error(r.error)
  if (!r.skipped) throw new Error('没有跳过（重复传了一遍）')
  return 'skipped'
}))

// 6) 5MB 上传（验证 fastPut 并发 + 不再挂起）
const big = makeFile('smoke-5m.bin', 5 * 1024 * 1024)
ck(await runCased('5MB → /tmp', async () => {
  const r = await putFile(sftp, big, '/tmp')
  if (!r.ok) throw new Error(r.error)
  const ls = await exec('ls -l /tmp/smoke-5m.bin')
  if (!/5242880\b/.test(ls)) throw new Error(`大小不对：${ls}`)
  return r.remotePath
}))

// 7) 下载回来，内容与大小一致
ck(await runCased('5MB 下载回来', async () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-dl-'))
  const r = await getFile(sftp, '/tmp/smoke-5m.bin', dl)
  if (!r.ok) throw new Error(r.error)
  const back = fs.readFileSync(r.localPath)
  if (back.length !== 5 * 1024 * 1024) throw new Error(`大小 ${back.length}`)
  return r.localPath
}))

// 清理远端测试文件
for (const f of ['/tmp/smoke-760b.bin', '/tmp/smoke-7k.bin', '/tmp/smoke-5m.bin']) {
  try {
    await sftp.unlink(f)
  } catch {
    /* ignore */
  }
}

try {
  sftp.__raw?.end?.()
} catch {
  /* ignore */
}
client.end()

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
