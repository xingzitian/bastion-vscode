#!/usr/bin/env node
// 循环依赖检查：src/ 里模块之间的 import 图不允许有环。
//
// 为什么这次专门要它：搬家之后最容易出现的就是 A↔B 互相 import。
// tsc **不报**这个错（它能处理循环），但运行时可能拿到 `undefined`
// （CJS 里环上某一侧还没执行完就被 require）—— 典型症状是"某个函数突然不是函数"，
// 而且只在特定加载顺序下出现，极难复现。
//
// 只解析相对 import（`./x`、`../y`），第三方包不参与。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()

// 已知遗留的环（搬家前就存在）。这份清单是**棘轮**：
// 只允许它变小，不允许变大 —— 新引入的环会立即失败。
// 拆它们属于 M3/M4 的收口工作（state↔terminal、sessions→overview→deployRun、
// aiBridge↔…↔mcpRegister 这几条都是历史结构，改起来要动执行路径，不在本次范围）。
const KNOWN = [
  ['src/core/menu.ts', 'src/core/menuHintsFile.ts'],
  ['src/state.ts', 'src/terminal.ts'],
  ['src/sessions.ts', 'src/overview.ts', 'src/deployRun.ts'],
  ['src/aiBridge.ts', 'src/sessions.ts', 'src/overview.ts', 'src/mcpRegister.ts', 'src/aiSessionApi.ts'],
  ['src/aiBridge.ts', 'src/sessions.ts', 'src/overview.ts', 'src/mcpRegister.ts']
]

/** 把环归一成可比较的 key（去重首尾、排序） */
function cycleKey(files) {
  return files
    .slice(0, -1)
    .map((f) => path.relative(root, f).replace(/\\/g, '/'))
    .sort()
    .join('|')
}
const knownKeys = new Set(KNOWN.map((c) => [...c].sort().join('|')))
const srcDir = path.join(root, 'src')

if (!fs.existsSync(srcDir)) {
  console.error('✗ 找不到 src/')
  process.exit(1)
}

function collect(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collect(p, acc)
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

const files = collect(srcDir)
const known = new Set(files)
const graph = new Map()

const importRe = /\bfrom\s+['"](\.[^'"]+)['"]/g
const requireRe = /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g

function resolveSpec(from, spec) {
  const base = path.resolve(path.dirname(from), spec)
  const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')]
  return candidates.find((c) => known.has(c))
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const deps = new Set()
  for (const re of [importRe, requireRe]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) {
      const target = resolveSpec(file, m[1])
      if (target) deps.add(target)
    }
  }
  graph.set(file, [...deps])
}

// DFS 找环（三色标记）
const WHITE = 0
const GRAY = 1
const BLACK = 2
const color = new Map(files.map((f) => [f, WHITE]))
const stack = []
const cycles = []

function visit(node) {
  color.set(node, GRAY)
  stack.push(node)
  for (const dep of graph.get(node) ?? []) {
    const c = color.get(dep)
    if (c === GRAY) {
      const start = stack.indexOf(dep)
      cycles.push(stack.slice(start).concat(dep))
    } else if (c === WHITE) {
      visit(dep)
    }
  }
  stack.pop()
  color.set(node, BLACK)
}

for (const f of files) if (color.get(f) === WHITE) visit(f)

const fresh = []
const seen = new Set()
for (const c of cycles) {
  const key = cycleKey(c)
  if (seen.has(key)) continue
  seen.add(key)
  if (!knownKeys.has(key)) fresh.push(c)
}

if (fresh.length > 0) {
  console.error(`✗ 发现 ${fresh.length} 个**新增**循环依赖（已知遗留 ${knownKeys.size} 个不算）：`)
  for (const c of fresh) {
    console.error('  - ' + c.map((f) => path.relative(root, f).replace(/\\/g, '/')).join(' → '))
  }
  process.exit(1)
}

// 顺带报一下"没人 import 的模块"（只提示，不失败 —— 入口/命令文件可能确实没人 import）
const imported = new Set()
for (const deps of graph.values()) for (const d of deps) imported.add(d)
const orphans = files
  .filter((f) => !imported.has(f) && !/\\extension\.ts$/.test(f))
  .map((f) => path.relative(root, f).replace(/\\/g, '/'))

console.log(`✓ 循环依赖检查通过：${files.length} 个模块，0 个新增环（已知遗留 ${knownKeys.size} 个）`)
if (orphans.length > 0) console.log(`  （提示）无人 import 的模块 ${orphans.length} 个：${orphans.join(', ')}`)
