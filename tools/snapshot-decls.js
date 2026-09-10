/**
 * 抽取 src 下所有顶层声明的「规范化正文」，输出成 JSON。
 *
 * 用途：重构前后各跑一次，逐条比对。
 * 只要两边完全一致，就能证明这次重构**只搬了位置、没有改逻辑** ——
 * 这是把一个 1700 行的 god file 拆开时唯一靠谱的安全网
 * （tsc 只能证明能编译，证明不了行为没变）。
 *
 * 规范化：把连续空白压成一个空格并 trim。
 * 这样容忍纯粹的缩进/换行差异，但任何语义改动都会暴露。
 *
 * 用法：node tools/snapshot-decls.js <输出文件>
 */
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const OUT = process.argv[2] || path.join(__dirname, '__decls.json')

// 顶层声明（顶格，没有缩进）：函数 / const / let / interface / type
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/

/** 往前吃掉紧邻的文档注释（/** ... *\/），但不要把 `// ---- 分节标题 ----` 也算进去 */
function docStart(lines, i) {
  let start = i
  let j = i - 1
  // 连续的 // 注释行
  if (j >= 0 && /^\s*\/\//.test(lines[j]) && !/^\s*\/\/\s*-{3,}/.test(lines[j])) {
    while (j >= 0 && /^\s*\/\//.test(lines[j]) && !/^\s*\/\/\s*-{3,}/.test(lines[j])) j--
    return j + 1
  }
  // /** ... */ 块注释
  if (j >= 0 && /\*\/\s*$/.test(lines[j])) {
    let k = j
    while (k >= 0 && !/^\s*\/\*\*/.test(lines[k])) k--
    if (k >= 0) start = k
  }
  return start
}

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const normalize = (s) => s.replace(/\s+/g, ' ').trim()

const result = {}
const duplicates = []

for (const file of walk(SRC)) {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/')
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

  // 找出所有顶层声明的起始行
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i])
    if (m) starts.push({ i, name: m[1] })
  }

  for (let k = 0; k < starts.length; k++) {
    const { i, name } = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length
    const from = docStart(lines, i)
    const text = normalize(lines.slice(from, end).join('\n'))
    if (!text) continue
    const key = name
    if (result[key] !== undefined && result[key] !== text) {
      duplicates.push(key)
      // 同名不同体：带上文件区分，避免误判为一致
      result[`${key}@${rel}`] = text
    } else if (result[key] === undefined) {
      result[key] = text
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8')
console.log(`已快照 ${Object.keys(result).length} 个顶层声明 → ${path.basename(OUT)}`)
if (duplicates.length > 0) {
  console.log(`注意：有 ${duplicates.length} 个重名声明（已按文件区分）：${[...new Set(duplicates)].join(', ')}`)
}
