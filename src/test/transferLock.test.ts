// 传输期间键盘锁的纯逻辑测试。
//
// 背景（2026-11-18 真机）：上传时用户以为传完了，按了 ↑ —— 发出去的是 `ESC [ A`，
// 而 ESC 是 ZMODEM 的转义字符，rz 把它当协议数据吃掉：传输被打断/块错乱，
// 数据其实已落盘，却被判定"上传失败"。所以传输期间的人工输入必须丢弃。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TransferLock } from '../core/transferLock'

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test('★ 锁住期间丢键并计数；解锁后恢复原只读状态', () => {
  const c = fakeClock()
  const lock = new TransferLock({ now: c.now })
  assert.equal(lock.active, false)

  assert.equal(lock.enter(false), true, '第一次进入应返回 true（宿主据此提示）')
  assert.equal(lock.active, true)
  assert.equal(lock.shouldDrop('unknown'), true)
  assert.equal(lock.shouldDrop('unknown'), true)
  assert.equal(lock.dropped, 2)

  const out = lock.exit()
  assert.equal(out.released, true)
  assert.equal(out.dropped, 2)
  assert.equal(out.restoreReadOnly, false, '进入前不是只读 → 退出后要恢复成可写')
  assert.equal(lock.active, false)
})

test('★ 用户在只读模式下上传：结束后必须仍然是只读（不能被解锁改成可写）', () => {
  const lock = new TransferLock()
  lock.enter(true)
  const out = lock.exit()
  assert.equal(out.restoreReadOnly, true)
})

test('嵌套（编排层锁 + 内部 upload 再锁一次）：只有最外层提示与恢复', () => {
  const lock = new TransferLock()
  assert.equal(lock.enter(false), true)
  assert.equal(lock.enter(false), false, '内层不应重复提示')
  assert.equal(lock.totalDepth, 2)
  assert.equal(lock.exit().released, false, '内层退出不解锁')
  assert.equal(lock.active, true)
  assert.equal(lock.exit().released, true)
  assert.equal(lock.active, false)
})

test('★ 屏幕是登录菜单时放行（否则堡垒机登录时键盘被锁死）', () => {
  const lock = new TransferLock()
  lock.enter(false)
  assert.equal(lock.shouldDrop('menu'), false, '菜单要放行')
  assert.equal(lock.dropped, 0, '放行不算丢弃')
})

test('★ 屏幕回到 shell 但已锁超过宽限期 → 放行（宿主自己卡住时的逃生门）', () => {
  const c = fakeClock()
  const lock = new TransferLock({ now: c.now, stuckGraceMs: 60_000 })
  lock.enter(false)
  assert.equal(lock.shouldDrop('shell'), true, '刚锁上时 shell 也可能是传输前残留，仍要拦')
  c.advance(61_000)
  assert.equal(lock.shouldDrop('shell'), false, '超过宽限期还停在 shell → 放行让人接手')
})

test('硬超时：到点必须能强制解锁，且标记 timedOut', () => {
  const c = fakeClock()
  const lock = new TransferLock({ now: c.now, hardTimeoutMs: 10 * 60_000 })
  lock.enter(false)
  c.advance(9 * 60_000)
  assert.equal(lock.isHardTimedOut(), false)
  c.advance(2 * 60_000)
  assert.equal(lock.isHardTimedOut(), true)
  const out = lock.exitAll()
  assert.equal(out.released, true)
  assert.equal(out.timedOut, true)
  assert.equal(lock.active, false)
})

test('没锁的时候 shouldDrop / exit 都是安全的 no-op', () => {
  const lock = new TransferLock()
  assert.equal(lock.shouldDrop('unknown'), false)
  assert.equal(lock.exit().released, false)
  assert.equal(lock.exitAll().released, false)
  assert.equal(lock.heldForMs, 0)
})

test('reset 清掉残留（会话关闭）', () => {
  const lock = new TransferLock()
  lock.enter(true)
  lock.shouldDrop('unknown')
  lock.reset()
  assert.equal(lock.active, false)
  assert.equal(lock.dropped, 0)
})
