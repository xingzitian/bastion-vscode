#!/usr/bin/env node
// require 路径检查：out/ 里每个相对 require 都必须解析到真实文件。
//
// 为什么 tsc 不够：tsc 只校验**静态 import**。`require(variable)`、`require(path.join(...))`、
// 以及手写在字符串里的路径，它一律不看。搬家/改名之后，这类路径最容易断在运行时。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const outDir = path.join(root, 'out')

if (!fs.existsSync(outDir)) {
  console.error('✗ 找不到 out/ —— 先 npm run compile')
  process.exit(1)
}

function collect(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...collect(p))
    else if (e.isFile() && p.endsWith('.js')) out.push(p)
  }
  return out
}

/** 相对 require 的解析：先试原样 .js，再试目录 index.js */
function resolves(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')]
  return candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())
}

const re = /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g
const problems = []
let total = 0

for (const file of collect(outDir)) {
  const src = fs.readFileSync(file, 'utf8')
  let m
  while ((m = re.exec(src)) !== null) {
    const spec = m[1]
    total++
    if (!resolves(file, spec)) {
      problems.push(`${path.relative(root, file).replace(/\\/g, '/')} → require('${spec}') 找不到`)
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ require 路径检查失败（${problems.length}/${total}）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`✓ require 路径检查通过：${total} 处相对 require 全部可解析`)
