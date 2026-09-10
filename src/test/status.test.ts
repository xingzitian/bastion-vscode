// 状态栏：格式化函数 + 槽位行为
import '../testkit/vscode-stub'
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resetStatusBarItems, lastStatusBarItem } from '../testkit/vscode-stub'
import { fmtBytes, fmtDuration, fmtSpeed, progressBar, setSlot, flashSlot, clearSlot, disposeSlots } from '../status'

// 每个用例前彻底重置：disposeSlots 清掉槽位表，reset 清掉打桩记录，
// 这样 lastStatusBarItem()（按创建顺序取）才是可靠的。
beforeEach(() => {
  disposeSlots()
  resetStatusBarItems()
})

test('fmtBytes：人类可读字节数', () => {
  assert.equal(fmtBytes(0), '0 B')
  assert.equal(fmtBytes(512), '512 B')
  assert.equal(fmtBytes(1024), '1.0 KB')
  assert.equal(fmtBytes(2048), '2.0 KB')
  assert.equal(fmtBytes(1572864), '1.5 MB')
  assert.equal(fmtBytes(20 * 1024 * 1024), '20 MB') // 两位数不保留小数
  assert.equal(fmtBytes(1024 * 1024 * 1024), '1.0 GB')
})

test('fmtBytes：非法输入不抛异常', () => {
  assert.equal(fmtBytes(NaN), '-')
  assert.equal(fmtBytes(-1), '-')
  assert.equal(fmtBytes(Infinity), '-', '非有限数一律返回 -')
})

test('fmtDuration：秒/分/时', () => {
  assert.equal(fmtDuration(0), '0s')
  assert.equal(fmtDuration(3200), '3s')
  assert.equal(fmtDuration(60000), '1m')
  assert.equal(fmtDuration(80000), '1m20s')
  assert.equal(fmtDuration(3600 * 1000), '1h00m')
  assert.equal(fmtDuration(NaN), '-')
})

test('fmtSpeed', () => {
  assert.equal(fmtSpeed(0), '-')
  assert.equal(fmtSpeed(-5), '-')
  assert.equal(fmtSpeed(1258291), '1.2 MB/s')
})

test('progressBar：边界收敛', () => {
  assert.equal(progressBar(0, 10), '░'.repeat(10))
  assert.equal(progressBar(0.5, 10), '█████░░░░░')
  assert.equal(progressBar(1, 10), '█'.repeat(10))
  assert.equal(progressBar(5, 10), '█'.repeat(10), '越界要收敛到 100%')
  assert.equal(progressBar(-3, 10), '░'.repeat(10), '负数要收敛到 0%')
  assert.equal(progressBar(NaN, 10), '░'.repeat(10))
})

test('setSlot：文本/提示/点击命令', () => {
  setSlot('forward', { text: 'x', tooltip: 'y', command: 'some.cmd' })
  const item = lastStatusBarItem()
  assert.equal(item.shown, true)
  assert.equal(item.text, 'x')
  assert.equal(item.tooltip, 'y')
  assert.equal(item.command?.command, 'some.cmd')
  assert.equal(item.command?.arguments, undefined, '没有参数时不应带 arguments 键')
})

test('setSlot：带参数时正确透传', () => {
  setSlot('forward', { text: 'x', command: 'c', commandArgs: ['p1'] })
  assert.deepEqual(lastStatusBarItem().command?.arguments, ['p1'])
})

test('setSlot：背景色（警告态）能设置', () => {
  setSlot('readonly', { text: 'x', backgroundColor: { id: 'statusBarItem.warningBackground' } as never })
  assert.equal(lastStatusBarItem().backgroundColor?.id, 'statusBarItem.warningBackground')
})

test('clearSlot 幂等，且能取消未触发的自动隐藏', () => {
  setSlot('transfer', { text: 'a' })
  flashSlot('transfer', { text: 'b' }, 50)
  clearSlot('transfer')
  assert.equal(lastStatusBarItem().shown, false)
  assert.doesNotThrow(() => clearSlot('transfer'), '重复 clear 不应抛异常')
})

test('flashSlot：超时后自动隐藏', async () => {
  flashSlot('transfer', { text: 'done' }, 20)
  assert.equal(lastStatusBarItem().shown, true)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(lastStatusBarItem().shown, false, '超时后应自动隐藏')
})

test('flashSlot：期间被新状态覆盖时，不要误吞新状态', async () => {
  flashSlot('transfer', { text: 'old' }, 20)
  setSlot('transfer', { text: 'new' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(lastStatusBarItem().text, 'new')
  assert.equal(lastStatusBarItem().shown, true, '新状态不应被旧定时器隐藏')
})

after(() => disposeSlots())
