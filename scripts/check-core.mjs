#!/usr/bin/env node
// 内核边界检查（M0 的护栏）。
//
// 三件事，任何一条不满足就 exit 1：
//   1. src/core 里不允许出现 `vscode`（import / require / 类型引用）
//   2. src/core 不允许用 `../` 反向引用宿主模块（core 只能向下依赖 node 内置模块）
//   3. src/core 里的相对依赖必须落在 core 目录内（防止悄悄引回根目录的文件）
//
// 它比 tsconfig.core.json 更早失败、提示更清楚；两者一起用：
//   check-core.mjs 管"文本层面有没有越界"，tsconfig.core.json 管"类型层面能不能独立编译"。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const coreDir = path.join(root, 'src', 'core')

if (!fs.existsSync(coreDir)) {
  console.error(`✗ 找不到内核目录：${coreDir}`)
  process.exit(1)
}

/** 递归收集 .ts（排除 .d.ts） */
function collect(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(p))
    else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const files = collect(coreDir)
const problems = []

// 只在"代码"里找，不在注释里找：先去掉行注释与块注释
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const raw = fs.readFileSync(file, 'utf8')
  const code = stripComments(raw)

  // 1) vscode
  if (/\bfrom\s+['"]vscode['"]/.test(code) || /\brequire\(\s*['"]vscode['"]\s*\)/.test(code)) {
    problems.push(`${rel}：引用了 vscode —— core 里不允许（用 src/core/ports.ts 的端口）`)
  }
  if (/\bvscode\.[A-Za-z]/.test(code)) {
    problems.push(`${rel}：出现了 vscode.<API> 用法 —— core 里不允许`)
  }

  // 2) 反向引用宿主
  const importRe = /\bfrom\s+['"](\.[^'"]*)['"]/g
  let m
  while ((m = importRe.exec(code)) !== null) {
    const spec = m[1]
    const target = path.resolve(path.dirname(file), spec)
    const inside = target === coreDir || target.startsWith(coreDir + path.sep)
    if (spec.startsWith('../')) {
      // 允许 src/core/<sub>/x.ts → src/core/y.ts（等同于 ../y）
      if (!inside) problems.push(`${rel}：反向引用了 core 之外的模块（${spec}）`)
      continue
    }
    // 3) 同目录/子目录但解析到 core 外（例如 ../../foo）
    if (!inside && !spec.startsWith('.')) continue
    if (!inside) problems.push(`${rel}：引用了 core 之外的相对路径（${spec}）`)
  }
}

const vscodeFree = files.length
if (problems.length > 0) {
  console.error(`✗ 内核边界检查失败（${problems.length} 处）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`✓ 内核边界检查通过：${vscodeFree} 个文件，0 处 vscode / 0 处反向引用`)
