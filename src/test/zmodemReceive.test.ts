// ZMODEM **接收**（用户自己敲 `sz` 下载）这条路的回归测试。
//
// 真机故障（2026-09-15，维护者报）：用户在终端里敲 `sz xxx` 下载时得到
//   ZMODEM 处理失败: Unhandled header: ZRQINIT
// 而且没有任何文件落盘。
//
// 根因：**接收会话在握手期间去弹「选择保存目录」对话框**。
//   ZRQINIT（对端的 sz 发起）→ on_detect → runReceiveSession
//     → await pickDownloadDir()   ← 弹窗，等用户点（几秒起）
//     → zsession.start()          ← 这一步才发 ZRINIT
// 对端等不到 ZRINIT 会**重发 ZRQINIT**；那帧重发已经排在管道里，等对话框点完、
// 会话 start() 之后才被解析 —— 而那时处理器表是 {ZFILE, ZSINIT, ZFIN}，
// 没有 ZRQINIT，zmodem.js 直接抛 "Unhandled header: ZRQINIT"。
//
// 所以这一组盯三件事：
//   1. **ZRINIT 必须立刻发出去**（不能等任何用户交互）；
//   2. 对端重发的（迟到的）ZRQINIT **不能把一次好端端的下载报成失败**；
//   3. 没有可用下载目录时要说清怎么修，而不是静默什么都不做。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Zmodem from 'zmodem.js'
import { ZmodemSessionController, type ZmodemIo } from '../zmodem'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 造一个 ZRQINIT 帧（对端 sz 发起时发的第一个 header） */
function zrqinitFrame(): Buffer {
  return Buffer.from(Zmodem.Header.build('ZRQINIT').to_hex())
}

/** 从我们发出去的字节里认出 header 名（用来确认 ZRINIT 到底发出去了没有） */
function headerNameOf(buf: Buffer): string | undefined {
  try {
    return Zmodem.Header.parse(Array.from(buf))?.[0]?.NAME
  } catch {
    return undefined
  }
}

interface Harness {
  ctrl: ZmodemSessionController
  sent: Buffer[]
  errors: string[]
  infos: string[]
}

/** @param dir 解析出来的下载目录；null = 没有可用目录 */
function harness(dir: string | null = '/tmp/dl'): Harness {
  const sent: Buffer[] = []
  const errors: string[] = []
  const infos: string[] = []
  const io: ZmodemIo = {
    statFiles: async () => [],
    resolveDownloadDir: () => (dir === null ? '' : dir),
    openWrite: (_dir: string, name: string) => ({ fd: 1, path: `/tmp/dl/${name}` }),
    write: () => {},
    close: () => {},
    openRead: () => 0,
    read: () => Buffer.alloc(0),
    closeRead: () => {},
    hashFile: async () => ''
  }
  const ctrl = new ZmodemSessionController('test-session', (d: Buffer) => sent.push(d), () => {}, io)
  // ⚠️ 控制器只在 **'event'** 这一个通道上发事件（terminal.ts 也是这么收的）。
  // 第一版这里监听的是 'error' / 'info' —— 永远收不到东西，于是"不该报 ZRQINIT 错"
  // 这类断言**形同虚设**，真 bug 就这么漏到用户机器上了（2026-09-15）。
  ctrl.on('event', (p: { type?: string; message?: string }) => {
    if (p.type === 'error') errors.push(p.message ?? '')
    if (p.type === 'info') infos.push(p.message ?? '')
  })
  return { ctrl, sent, errors, infos }
}

test('收到 ZRQINIT 后立刻回 ZRINIT（握手期间不能等任何人）', async () => {
  const h = harness()
  h.ctrl.consume(zrqinitFrame())
  // 同步就该发出去了 —— 连一个微任务都不用等（原来要等目录对话框点完）
  const names = h.sent.map(headerNameOf)
  assert.ok(
    names.includes('ZRINIT'),
    `收到 ZRQINIT 后必须立刻回 ZRINIT（实际发出：${JSON.stringify(names)}）`
  )
  await sleep(10)
  assert.equal(h.errors.length, 0, `握手不该报错：${JSON.stringify(h.errors)}`)
})

test('对端重发/迟到的 ZRQINIT：不报错，而且**补发 ZRINIT**（第一帧丢了也能救回来）', async () => {
  const h = harness()
  const frame = zrqinitFrame()
  h.ctrl.consume(frame) // #1 检测到，start() 已回 ZRINIT
  await sleep(20)
  // #2 对端的重发。⚠️ 前面缀上 `\r\n` 垃圾字节是**关键**：裸帧会被 zmodem.js
  //    当垃圾吃掉、根本走不到报错那条路 —— 第一版测试就是这么漏掉真 bug 的
  //    （真机上那帧是排在管道里的，会被正常解析）。
  h.ctrl.consume(Buffer.concat([Buffer.from('\r\n'), frame]))

  assert.deepEqual(
    h.errors.filter((e) => e.includes('ZRQINIT')),
    [],
    `迟到的 ZRQINIT 不该报 Unhandled header（实际：${JSON.stringify(h.errors)}）`
  )
  // 还没开始收文件 → 必须补发 ZRINIT（协议规定 ZRQINIT 就该回 ZRINIT）
  const zrinits = h.sent.map(headerNameOf).filter((n) => n === 'ZRINIT')
  assert.ok(
    zrinits.length >= 2,
    `收到重发的 ZRQINIT 之后应该补发 ZRINIT（已发 ${zrinits.length} 次）`
  )
  assert.equal(h.ctrl.isActive(), true, '会话必须还活着，否则对端的 ZFILE 没人接')
})

test('解析不出下载目录时也不崩：握手照常应答，会话保持可用', async () => {
  // 这条是**防御性**的：真实实现里 resolveDownloadDir() 永远有个兜底目录，
  // 只有宿主实现出错时才会返回空。断言的是"别把这种情况变成崩溃/静默半死"。
  const h = harness(null)
  h.ctrl.consume(zrqinitFrame())
  await sleep(20)
  assert.equal(h.sent.map(headerNameOf).includes('ZRINIT'), true, '握手该照常应答')
  assert.equal(h.ctrl.isActive(), true, '会话要保持可用（不能因为目录问题把自己弄死）')
})

test('对端放弃时用 info 说一句，不报红色错误', async () => {
  const h = harness()
  h.ctrl.consume(zrqinitFrame())
  await sleep(10)
  // lrzsz 放弃时会发 5 个 CAN(0x18? 不，是 0x18=ZDLE 以外的 24=0x18) —— zmodem.js 认的是
  // ABORT_SEQUENCE=[24,24,24,24,24]；写 5 个 0x18 即可触发 "Peer aborted session"
  h.ctrl.consume(Buffer.from([24, 24, 24, 24, 24]))
  assert.equal(
    h.errors.filter((e) => e.includes('Peer aborted')).length,
    0,
    `对端放弃不该报成错误（实际：${JSON.stringify(h.errors)}）`
  )
  assert.ok(
    h.infos.some((m) => m.includes('放弃')),
    `应该用一句 info 说明（实际 info：${JSON.stringify(h.infos)}）`
  )
})
