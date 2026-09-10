/**
 * 比对两份声明快照，回答一个问题：**这次重构只是搬了位置，还是改了逻辑？**
 *
 * 用法：
 *   node tools/snapshot-decls.js tools/__before.json     # 重构前
 *   ……重构……
 *   node tools/snapshot-decls.js tools/__after.json      # 重构后
 *   node tools/compare-decls.js tools/__before.json tools/__after.json
 *
 * 比对时只比**代码**：剔掉注释、export 前缀、空白。
 * 剔注释是因为快照按「两个声明之间」切片，会把邻居的文档注释算进尾部 ——
 * 声明顺序一变就会假报差异。剔 export 是因为搬运时会给模块私有声明补上导出。
 * 剩下的差异就是真正的代码改动，必须逐条人工核对。
 */
const fs = require('fs')

const [beforeFile, afterFile] = process.argv.slice(2)
if (!beforeFile || !afterFile) {
  console.error('用法：node tools/compare-decls.js <前.json> <后.json>')
  process.exit(2)
}

const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'))
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'))

/** 只留代码 */
const code = (s) =>
  s
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const beforeKeys = Object.keys(before).filter((k) => !k.includes('@'))
const changed = beforeKeys.filter((k) => k in after && code(before[k]) !== code(after[k]))
const missing = beforeKeys.filter((k) => !(k in after))
const added = Object.keys(after).filter((k) => !(k in before) && !k.includes('@'))

console.log(`对比声明数：${beforeKeys.length}`)
console.log('')

console.log('=== 代码有变化的声明（必须逐条确认是预期内的改写）===')
if (changed.length === 0) {
  console.log('  （无）')
}
for (const k of changed) {
  const b = code(before[k])
  const a = code(after[k])
  let i = 0
  while (i < b.length && i < a.length && b[i] === a[i]) i++
  let j = 0
  while (j < b.length - i && j < a.length - i && b[b.length - 1 - j] === a[a.length - 1 - j]) j++
  console.log(`  ✎ ${k}`)
  console.log(`      旧: ...${b.slice(Math.max(0, i - 40), b.length - j + 6)}`)
  console.log(`      新: ...${a.slice(Math.max(0, i - 40), a.length - j + 6)}`)
}
console.log('')

console.log('=== 消失的声明（绝不能有）===')
console.log(missing.length ? '  ❌ ' + missing.join(', ') : '  ✓ 无')
console.log('')

console.log('=== 新增的声明 ===')
console.log(added.length ? added.map((k) => '  + ' + k).join('\n') : '  （无）')
console.log('')

process.exit(missing.length > 0 ? 1 : 0)
