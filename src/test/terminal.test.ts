// 终端输出整理 + 哨兵标记安全性
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tailText, isMarkerSafe, stripAnsi, safeReadStart } from '../terminal'

// ---------------------------------------------------------------------------
// ANSI 分块：这是真实咬过的 bug —— 菜单明明在屏幕上、dump 出来也干净，就是认不出来。
// 原因：emitOutput 曾经「每来一个数据块就单独剥离 ANSI」，而 \x1b[32m 这类转义序列
// 经常被 TCP 拆到两个块里，逐块剥离会把文字切碎（输\x1b[32m入）。
//
// 现在的做法（见 terminal.ts 的 markOutput/readSince）：
//   **缓冲存原始数据 → 匹配时对整段剥离**，而且读「标记之后」的那一段时，
//   若标记正好落在转义序列中间，就退回到 \x1b 再读（safeReadStart）。
// 下面这组测试就是钉住这两点。
// ---------------------------------------------------------------------------

/** 把字符串按每个字符切开（模拟最恶劣的分块：每个转义序列都被切开） */
function splitPerChar(s: string): string[] {
  return [...s]
}

/** 按给定切点切成块 */
function splitAt(s: string, cuts: number[]): string[] {
  const out: string[] = []
  let prev = 0
  for (const c of cuts) {
    out.push(s.slice(prev, c))
    prev = c
  }
  out.push(s.slice(prev))
  return out.filter((x) => x.length > 0)
}

/** 收块：模拟 emitOutput 把每个块原样追加进滚动缓冲 */
function collect(chunks: string[]): string {
  let buf = ''
  for (const c of chunks) buf += c
  return buf
}

/**
 * 模拟 readSince：从标记位置开始读，返回干净文本。
 * （和 BastionTerminal.readSince 同一套算法，用它来验证分块场景）
 */
function readSince(buf: string, markLen: number, maxLines = 40): string {
  return tailText(buf.slice(safeReadStart(buf, markLen)), maxLines)
}

/** 用一组候选正则去匹配读出来的屏幕文本，返回第一个命中的下标（-1 = 没命中） */
function firstHit(res: RegExp[], screen: string): number {
  return res.findIndex((r) => r.test(screen))
}

test('ANSI 被逐字符切开（最恶劣分块）仍然能匹配', () => {
  const res = [/提示：输入[^\n]{0,80}(账号|账户|用户)\s*ID/i, /^#\s*$/m]
  const colored = '提示：\x1b[32m输入资产[test-node-1.2.3.4(1.2.3.4)]的\x1b[0m账号ID'
  assert.equal(firstHit(res, readSince(collect(splitPerChar(colored)), 0)), 0)
})

test('标记落在转义序列中间：退回到 \\x1b 再读，行首锚定的规则依然能匹配', () => {
  const text = '\x1b[1;33mID>\x1b[0m'
  const chunks = splitAt(text, [3]) // 切点落在 \x1b[1;33m 中间
  const buf = collect(chunks)
  // 标记正好打在切点上 → 从第二块开头读会得到 `33mID>`，`^ID>` 就死了
  const naive = tailText(buf.slice(3), 10)
  assert.equal(/^ID>/im.test(naive), false, '直接从切点读会粘上 `33m` 残渣（这就是当初认不出来的原因）')
  // 正确做法：退回到 \x1b
  assert.equal(/^ID>/im.test(readSince(buf, 3)), true, 'safeReadStart 退回到 \\x1b 后就能匹配')
})

test('safeReadStart：标记本身是安全切点时不后退', () => {
  const buf = 'hello\nWorld\n'
  assert.equal(safeReadStart(buf, buf.length), buf.length)
  assert.equal(safeReadStart(buf, 0), 0, '标记在开头')
  assert.equal(safeReadStart(buf, 999), 0, '标记越界（缓冲被裁剪过）→ 从头读')
})

test('safeReadStart：完整的转义序列不后退，残缺的才后退', () => {
  const complete = 'a\x1b[32mb'
  assert.equal(safeReadStart(complete, complete.length), complete.length, '\\x1b[32m 是完整的 → 不用退')
  const partial = 'a\x1b[3'
  assert.equal(safeReadStart(partial, partial.length), 1, '\\x1b[3 被切断了 → 退回到 \\x1b')
  const osc = 'a\x1b]0;title\x07b'
  assert.equal(safeReadStart(osc, osc.length), osc.length, 'OSC 标题序列完整 → 不用退')
})

test('readSince：只看标记之后的内容，旧画面不会被误当成新画面', () => {
  const buf = 'Opt> 请输入目标机IP\n' + 'Opt> Opt> 10.0.0.10\n'
  const cut = buf.indexOf('Opt> Opt>')
  const screen = readSince(buf, cut, 40)
  assert.equal(screen.includes('请输入目标机IP'), false, '旧主菜单不该出现在这次读到的画面里')
  assert.equal(screen.includes('10.0.0.10'), true)
})

test('对照：逐块剥离会把文字切碎（记录这个坑，避免有人改回去）', () => {
  const colored = '输\x1b[32m入'
  const chunks = splitPerChar(colored)
  // 老做法：每块各自剥离再拼
  const oldWay = chunks.map(stripAnsi).join('')
  assert.equal(oldWay.includes('输入'), false, '逐块剥离后文字被切碎 —— 这就是当初认不出来的原因')
  // 新做法：整段累积后剥离
  assert.equal(stripAnsi(chunks.join('')).includes('输入'), true, '整段剥离才对')
})

test('多组候选：同一次读到的画面里出现多个，按组顺序取靠前的', () => {
  const res = [/AAA/, /BBB/, /CCC/]
  assert.equal(firstHit(res, 'AAA 和 CCC 同时出现'), 0, '都命中时靠前的组优先')
  assert.equal(firstHit(res, '只有 BBB'), 1)
  assert.equal(firstHit(res, 'zzz'), -1, '都不命中')
})

test('实测的选用户菜单：带 ANSI 且被切开也能命中', () => {
  const res = ['输入[^\\n]{0,80}(账号|账户|用户)\\s*ID', '^\\s*id>', '名称[^\\n]{0,20}用户名'].map(
    (s) => new RegExp(s, 'im')
  )
  const menu = [
    '\x1b[36m  ID    | 名称                    | 用户名\x1b[0m',
    '\x1b[36m--------+-------------------------+---------\x1b[0m',
    '  1     | deploy                | deploy',
    '提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID',
    '返回：B/b',
    'ID>'
  ].join('\r\n')
  assert.equal(firstHit(res, readSince(collect(splitPerChar(menu)), 0)), 0, '应命中选用户菜单')
})

test('tailText：去掉 ANSI 颜色码', () => {
  assert.equal(tailText('\x1b[32mok\x1b[0m', 10), 'ok')
  assert.equal(tailText('\x1b[1;31merror\x1b[m', 10), 'error')
})

test('tailText：\\r 覆盖只保留最后一段（进度条场景）', () => {
  assert.equal(tailText('10%\r55%\r100% done', 10), '100% done')
  assert.equal(tailText('downloading\r\ncomplete', 10), 'downloading\ncomplete')
})

test('tailText：OSC 标题序列也要清掉', () => {
  assert.equal(tailText('\x1b]0;my title\x07hello', 10), 'hello')
})

test('tailText：去掉尾部空行、只取末 N 行', () => {
  assert.equal(tailText('a\n\n\n', 10), 'a')
  assert.equal(tailText('l1\nl2\nl3\nl4', 2), 'l3\nl4')
  assert.equal(tailText('', 10), '')
  assert.equal(tailText('a\nb', 0), 'b', 'maxLines 至少取 1 行')
})

test('isMarkerSafe：普通命令可以加哨兵', () => {
  assert.equal(isMarkerSafe('ls -l'), true)
  assert.equal(isMarkerSafe('docker compose up -d'), true)
  assert.equal(isMarkerSafe('cat a | grep b'), true)
})

test('isMarkerSafe：交互式提权命令不能加哨兵', () => {
  // 没确认免密时，任何 sudo 都不能加
  assert.equal(isMarkerSafe('sudo ls /root'), false)
  // sudo -i / -s 会换成交互式 shell，哨兵永远打不出来
  assert.equal(isMarkerSafe('sudo -i', true), false)
  assert.equal(isMarkerSafe('sudo -s', true), false)
  assert.equal(isMarkerSafe('sudo --login', true), false)
  assert.equal(isMarkerSafe('sudo --shell', true), false)
  // su 一律不加
  assert.equal(isMarkerSafe('su - root', true), false)
})

test('isMarkerSafe：确认免密后，普通 sudo <命令> 可以用哨兵', () => {
  assert.equal(isMarkerSafe('sudo ls /root', true), true)
  assert.equal(isMarkerSafe('sudo systemctl restart nginx', true), true)
  assert.equal(isMarkerSafe('sudo -u root systemctl restart nginx', true), true)
})

test('isMarkerSafe：保守误判可接受（宁可退回静止判定）', () => {
  // `sudo grep -i` 里的 -i 会被当成交互式 shell 处理。
  // 这是有意的保守：误判只是退回「输出静止」兜底，不会出错。
  assert.equal(isMarkerSafe('sudo grep -i foo a.txt', true), false)
})

test('isMarkerSafe：后台任务 / exec 换 shell 不加哨兵', () => {
  assert.equal(isMarkerSafe('sleep 30 &'), false)
  assert.equal(isMarkerSafe('exec bash'), false)
  assert.equal(isMarkerSafe('cat a | exec b'), false)
  assert.equal(isMarkerSafe('   '), false)
})
