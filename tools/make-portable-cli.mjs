#!/usr/bin/env node
/**
 * 打「便携 CLI」：把 CLI 装进桌面版的 dist 目录，让 ⚡ / 🗂 在没有仓库的机器上也能用。
 *
 * 做法：在 bastion-vscode 里 `npm pack` → 解到 <dist>/bastion-cli → 在那里 `npm install --omit=dev`。
 * 结果目录约 5–8MB（ssh2 + xterm + ws），**不含 Node 运行时**（用户自备）。
 *
 * 用法（在 bastion-vscode 根目录）：
 *   node tools/make-portable-cli.mjs [目标目录]
 * 默认目标：../dist/desktop-0.9.3/bastion-cli
 *
 * 坑（2026-11-23 踩过）：
 *   - Windows 上 `shell: true` 会把带空格的路径**不加引号**地拼进命令行 → tar 直接失败；
 *     所以 tar 走 execFile 不带 shell，npm 只在目标目录里跑（参数里没有路径）。
 *   - 不用单文件打包：esbuild 会牵进 ssh2 的可选原生依赖（cpu-features），而 ssh2 纯 JS 也能跑。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const target = path.resolve(process.argv[2] ?? path.join(repo, '..', 'dist', 'desktop-0.9.3', 'bastion-cli'))
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function npm(args, cwd) {
  // 参数里不能有路径（Windows 空格问题）；路径一律用 cwd 表达
  return execFileSync(npmCmd, args, { cwd, encoding: 'utf8', shell: true })
}

console.log(`[1/4] npm pack（${repo}）`)
const packOut = npm(['pack'], repo)
const tgz = packOut.trim().split(/\r?\n/).filter(Boolean).pop()
const tgzPath = path.join(repo, tgz)
if (!fs.existsSync(tgzPath)) throw new Error(`没找到 tarball：${tgzPath}`)
console.log(`      ${tgz}  ${(fs.statSync(tgzPath).size / 1024).toFixed(0)} KB`)

console.log(`[2/4] 解压到 ${target}`)
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
// 不带 shell：避免路径空格被拆开
execFileSync('tar', ['-xzf', tgzPath, '-C', target, '--strip-components=1'])
fs.rmSync(tgzPath, { force: true })

console.log('[3/4] 安装运行依赖（--omit=dev，跳过安装脚本）')
npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], target)

console.log('[4/4] 自检：从 dist 里直接跑 list')
const main = path.join(target, 'out', 'cli', 'main.js')
if (!fs.existsSync(main)) throw new Error(`main.js 不在预期位置：${main}`)
const smoke = execFileSync(process.execPath, [main, 'list'], { cwd: os.tmpdir(), encoding: 'utf8' })
const lines = smoke.trim().split(/\r?\n/).filter(Boolean)
console.log(`      ${lines.length} 条档案可读：${lines.slice(0, 2).join(' / ')}…`)

const size = (dir) => {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    n += e.isDirectory() ? size(p) : fs.statSync(p).size
  }
  return n
}
console.log(`\n完成：${target}  （${(size(target) / 1024 / 1024).toFixed(1)} MB）`)
console.log(`桌面 exe 放在 ${path.dirname(target)} 时，会自动探测 bastion-cli/out/cli/main.js`)
