/**
 * 生成扩展的 128×128 商店图标（media/icon.png）。
 *
 * 为什么要手写：这台机器上没有 ImageMagick / sharp 之类的图像工具，
 * 而商店要求 `icon` 是 ≥128×128 的 PNG（且不能是 SVG）。
 * 所以直接算像素 + 自己编码 PNG —— 只用到 Node 自带的 zlib，零依赖。
 *
 * 画法用的是「有符号距离场 + 覆盖率抗锯齿」：
 * 每个像素算出到图形的距离，用距离决定 alpha，边缘自然就平滑了，
 * 不需要超采样。图形也全都是参数化的，想改配色/尺寸直接改下面的常量。
 *
 * 用法：node tools/make-icon.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 128
const OUT = path.join(__dirname, '..', 'media', 'icon.png')

// ---- 配色（改这里就能换皮肤）----
const BG = [0x0f, 0x14, 0x1b, 255] // 深蓝黑底：白底和黑底的商店页上都够跳
const BORDER = [0x33, 0x41, 0x55, 255] // 一圈浅色描边，避免在白底上糊成一团
const ACCENT = [0x3f, 0xd0, 0xa8, 255] // 青绿：终端提示符

// ---- 几何 ----
// 注意：描边宽度会让图形实际外接范围比控制点更宽（左右各半个线宽），
// 所以下面这组坐标是「按实际外接范围算好居中」的结果，不是随手填的：
//   > 的外接 x = 29..65，_ 的外接 x = 67..99 → 合计 29..99，中心 64 ✓
//   纵向：> 的外接 y = 34..94，_ 的 y = 84..94 → 合计 34..94，中心 64 ✓
const RADIUS = 26
const BORDER_W = 3
const CHEVRON = [
  [35, 40],
  [59, 64],
  [35, 88]
]
const CHEVRON_W = 12
const UNDERSCORE = { x0: 67, y0: 84, x1: 99, y1: 94, r: 3 }

// ---- 抗锯齿工具：距离 → 覆盖率 ----
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 圆角矩形的有符号距离（负数=在内部） */
function roundRectSdf(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hw = (x1 - x0) / 2 - r
  const hh = (y1 - y0) / 2 - r
  const qx = Math.abs(px - cx) - hw
  const qy = Math.abs(py - cy) - hh
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** 点到线段的距离 */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const l2 = vx * vx + vy * vy
  const t = l2 > 0 ? clamp01((wx * vx + wy * vy) / l2) : 0
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

/** 取折线上距离该点最近的一段的距离 */
function polylineDist(px, py, pts) {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
    if (d < best) best = d
  }
  return best
}

/** 把颜色按覆盖率叠加到画布上（source-over） */
function blend(buf, i, color, cov) {
  if (cov <= 0) return
  const a = cov * (color[3] / 255)
  for (let c = 0; c < 3; c++) {
    buf[i + c] = Math.round(buf[i + c] * (1 - a) + color[c] * a)
  }
  buf[i + 3] = Math.round(buf[i + 3] * (1 - a) + 255 * a)
}

// ---- 画 ----
const buf = Buffer.alloc(SIZE * SIZE * 4, 0) // 全透明起步

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    const px = x + 0.5
    const py = y + 0.5

    // 背景圆角方
    const d = roundRectSdf(px, py, 0, 0, SIZE, SIZE, RADIUS)
    blend(buf, i, BG, clamp01(0.5 - d))

    // 描边：外侧再收一圈，形成一条内描边
    const dIn = roundRectSdf(px, py, BORDER_W, BORDER_W, SIZE - BORDER_W, SIZE - BORDER_W, RADIUS - BORDER_W)
    blend(buf, i, BORDER, clamp01(0.5 - d) * clamp01(0.5 + dIn))

    // 提示符 >
    blend(buf, i, ACCENT, clamp01(0.5 - (polylineDist(px, py, CHEVRON) - CHEVRON_W / 2)))

    // 光标 _
    const du = roundRectSdf(px, py, UNDERSCORE.x0, UNDERSCORE.y0, UNDERSCORE.x1, UNDERSCORE.y1, UNDERSCORE.r)
    blend(buf, i, ACCENT, clamp01(0.5 - du))
  }
}

// ---- 编码 PNG ----
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0)
  return Buffer.concat([len, t, data, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type: RGBA
ihdr[10] = 0 // deflate
ihdr[11] = 0 // adaptive filtering
ihdr[12] = 0 // no interlace

// 每行前面加一个 filter 字节（0 = None）
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, png)
console.log(`已生成 ${path.relative(process.cwd(), OUT)}  ${SIZE}x${SIZE}  ${png.length} 字节`)
