#!/usr/bin/env node
/**
 * 把 CLI 宿主的真机 e2e 一次跑完（需要真档案：默认 xzt / xb）。
 *
 * 用法：npm run e2e:cli
 *
 * 每个脚本自己起 serve、跑完退出；这里只负责顺序执行、汇总、用非零码报警。
 * 想单独跑某一个：node tools/cli-panel-e2e.mjs（见各文件头部注释）。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const suites = [
  ['MCP 基础', 'cli-mcp-e2e.mjs'],
  ['网页终端', 'cli-term-e2e.mjs'],
  ['行动面板', 'cli-panel-e2e.mjs'],
  ['传文件', 'cli-sftp-e2e.mjs'],
  ['多会话', 'cli-hub-e2e.mjs']
]

const results = []
const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, 'tools', file)], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })

for (const [name, file] of suites) {
  process.stdout.write(`\n=== ${name}（${file}）===\n`)
  const { code, out } = await run(file)
  const pass = (out.match(/^PASS /gm) ?? []).length
  const fail = (out.match(/^FAIL /gm) ?? []).length
  process.stdout.write(`${out.trim()}\n`)
  results.push({ name, code, pass, fail })
}

const bad = results.filter((r) => r.code !== 0 || r.fail > 0)
const totalPass = results.reduce((n, r) => n + r.pass, 0)
const totalFail = results.reduce((n, r) => n + r.fail, 0)
process.stdout.write('\n================ 汇总 ================\n')
for (const r of results) {
  process.stdout.write(`${r.code === 0 && r.fail === 0 ? '✓' : '✗'} ${r.name}  pass=${r.pass} fail=${r.fail}\n`)
}
process.stdout.write(`TOTAL pass=${totalPass} fail=${totalFail}（${results.length} 组）\n`)
process.exit(bad.length === 0 ? 0 : 1)
