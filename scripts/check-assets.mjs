#!/usr/bin/env node
// 资源路径检查：源码里引用的**仓库内资源**必须存在。
//
// 为什么单独一条：这类路径 tsc 完全不看，而它断掉只会在运行时炸
// （icon 变空白、walkthrough 打不开、语法文件加载失败）。
// 本次内核搬家就踩了同一类坑：有三个测试用 `path.join(__dirname, '..','..','src', …)`
// 读源码，文件一搬全挂 —— 如果早有一条资源路径检查，会立刻发现。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const srcDir = path.join(root, 'src')

if (!fs.existsSync(srcDir)) {
  console.error('✗ 找不到 src/')
  process.exit(1)
}

/** 仓库里可以被引用的资源目录/文件前缀（排除源码与产物） */
// ⚠️ 只认"资源目录"：里面装的是随包发布的文件（图标/文档/语法/行走引导）。
// 开发用的目录（tools/、scripts/、src/、out/）不算 —— 否则 `'tools/list'`（MCP 方法名）
// 会被当成资源路径，直接误报。另外要求字面量带扩展名（`.png` / `.md` / `.json` …）。
const assetPrefixes = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^(media|walkthroughs|docs|syntaxes|resources|images)$/.test(e.name))
  .map((e) => e.name + '/')
// 外加几个根目录文件
const assetFiles = ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].filter((f) => fs.existsSync(path.join(root, f)))

function collect(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...collect(p))
    else if (e.isFile() && p.endsWith('.ts')) out.push(p)
  }
  return out
}

const problems = []
let checked = 0

// 匹配单/双引号里的字符串字面量
const literalRe = /['"]([^'"\n]+)['"]/g

for (const file of collect(srcDir)) {
  const src = fs.readFileSync(file, 'utf8')
  let m
  while ((m = literalRe.exec(src)) !== null) {
    const lit = m[1]
    const isAsset =
      assetPrefixes.some((p) => lit.startsWith(p)) || assetFiles.some((f) => lit === f)
    if (!isAsset) continue
    // 带模板变量/通配的跳过（无法静态判定）
    if (/[$*{}<>|]/.test(lit)) continue
    // 必须像"文件"：最后一段带扩展名
    if (!/\.[a-z0-9]{1,6}$/i.test(lit)) continue
    checked++
    if (!fs.existsSync(path.join(root, lit))) {
      problems.push(`${path.relative(root, file).replace(/\\/g, '/')} → '${lit}' 不存在`)
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ 资源路径检查失败（${problems.length}/${checked}）：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log(`✓ 资源路径检查通过：${checked} 处引用全部存在`)
