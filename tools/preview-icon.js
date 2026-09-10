/**
 * 把 media/icon.png 解码成终端里的 ASCII 预览。
 *
 * 为什么需要它：这台机器上没有 ImageMagick / sharp，也不一定有能看图的终端，
 * 而「PNG 结构合法」不等于「画得对」（可能跑偏、可能被裁掉）。
 * 这个脚本把真实文件解码回来渲染成字符画 —— 验的是落盘的产物，不是生成时的意图。
 *
 * 用法：node tools/preview-icon.js [列数] [行数]
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const FILE = path.join(__dirname, '..', 'media', 'icon.png')
const COLS = Number(process.argv[2]) || 64
const ROWS = Number(process.argv[3]) || 32

const png = fs.readFileSync(FILE)

// ---- 解析 PNG（只处理本仓库生成器产出的形态：8bit RGBA、无隔行、filter 全 0）----
if (png.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG')
let off = 8
let width = 0
let height = 0
const idat = []
while (off < png.length) {
  const len = png.readUInt32BE(off)
  const type = png.slice(off + 4, off + 8).toString('ascii')
  const data = png.slice(off + 8, off + 8 + len)
  const crc = png.readUInt32BE(off + 8 + len)
  const expect = zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0
  if (expect !== crc) throw new Error(`块 ${type} 的 CRC 不对`)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
    if (data[8] !== 8 || data[9] !== 6) throw new Error('只支持 8bit RGBA')
  } else if (type === 'IDAT') {
    idat.push(data)
  } else if (type === 'IEND') {
    break
  }
  off += 12 + len
}

const raw = zlib.inflateSync(Buffer.concat(idat))
const stride = width * 4
const px = Buffer.alloc(width * height * 4)
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)]
  if (filter !== 0) throw new Error(`第 ${y} 行用了 filter ${filter}，预览脚本只实现了 0`)
  raw.copy(px, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
}

// ---- 渲染 ----
const RAMP = ' .:-=+*#%@'
const bw = width / COLS
const bh = height / ROWS
console.log(`${path.basename(FILE)}  ${width}x${height}  →  ${COLS}x${ROWS} 预览\n`)
for (let r = 0; r < ROWS; r++) {
  let line = ''
  for (let c = 0; c < COLS; c++) {
    // 块内平均（含 alpha：透明的算作「无内容」）
    let aSum = 0
    let lSum = 0
    let n = 0
    for (let y = Math.floor(r * bh); y < Math.floor((r + 1) * bh); y++) {
      for (let x = Math.floor(c * bw); x < Math.floor((c + 1) * bw); x++) {
        const i = (y * width + x) * 4
        const a = px[i + 3] / 255
        aSum += a
        // 亮度按感知加权
        lSum += a * (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])
        n++
      }
    }
    const a = aSum / n
    if (a < 0.35) {
      line += ' ' // 圆角外的透明区
    } else {
      const lum = lSum / Math.max(1e-6, aSum) / 255
      line += RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.round(lum * (RAMP.length - 1))))]
    }
  }
  console.log('|' + line + '|')
}

// ---- 几个关键点的颜色，确认配色和圆角 ----
const at = (x, y) => {
  const i = (y * width + x) * 4
  return `#${[px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')} a=${px[i + 3]}`
}
console.log('\n关键点采样：')
console.log(`  左上角 (0,0)      ${at(0, 0)}   ← 圆角外，应为透明`)
console.log(`  边中点 (0,64)     ${at(0, 64)}   ← 圆角内，应为底色`)
console.log(`  中心   (64,64)    ${at(64, 64)}   ← 提示符附近`)
console.log(`  描边   (2,64)     ${at(2, 64)}   ← 应为描边色`)
