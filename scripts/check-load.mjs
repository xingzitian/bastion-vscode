#!/usr/bin/env node
// 装载期检查：用假 vscode 把 out/ 里**每一个**模块 require 一遍。
//
// 它抓的是"搬家之后才会炸"的那一类问题：
//   - Cannot find module（路径改了、emit 没跟上）
//   - 顶层就调用 vscode API 崩（模块被移动后初始化顺序变了）
//   - export 名字对不上（`undefined is not a function` 在装载期就暴露）
//
// 不启动 VS Code、不需要真窗口：复用 testkit 里那个 Module._load 打桩。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const root = process.cwd()
const outDir = path.join(root, 'out')
const requireCjs = createRequire(import.meta.url)

if (!fs.existsSync(outDir)) {
  console.error('✗ 找不到 out/ —— 先 npm run compile')
  process.exit(1)
}

// 先装桩（副作用式：拦截 require('vscode')）
requireCjs(path.join(outDir, 'testkit', 'vscode-stub.js'))

function collect(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...collect(p))
    else if (e.isFile() && p.endsWith('.js') && !p.endsWith('.map')) out.push(p)
  }
  return out
}

// 测试与桩自己不需要"被装载检查"（它们本来就是被测对象）
const skip = [path.join(outDir, 'test'), path.join(outDir, 'testkit')]
const files = collect(outDir).filter((f) => !skip.some((s) => f.startsWith(s)))

const failures = []
for (const f of files) {
  try {
    requireCjs(f)
  } catch (e) {
    failures.push(`${path.relative(root, f).replace(/\\/g, '/')}: ${e && e.message ? e.message : String(e)}`)
  }
}

if (failures.length > 0) {
  console.error(`✗ 装载检查失败（${failures.length}/${files.length}）：`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(`✓ 装载检查通过：${files.length} 个模块在假 vscode 下全部可加载`)
