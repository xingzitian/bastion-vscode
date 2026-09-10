// 「部署结束保留终端」这个开关：状态必须看得见、且不能骗人。
//
// 背景：这个能力以前只藏在设置 bastion.deployTerminalPolicy 里（枚举 + 说明），
// 用户找不到，于是每次都看着终端被自动关掉、报告又是空的，还以为「成功 = 没输出」。
// 现在做成底栏常驻一格 + 一个命令，所以这里钉住两件事：
//   1. 开启时底栏真的出现那一格、关闭时消失（显示的状态 = 实际设置）
//   2. 点一下就真的改了设置（不是只改个显示）
import '../testkit/vscode-stub'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { configValues, resetStatusBarItems, slotItem } from '../testkit/vscode-stub'
import { disposeSlots } from '../status'
import { updateKeepTerminalSlot } from '../slots'
import { getDeployTerminalPolicy, toggleKeepDeployTerminal } from '../deployRun'

beforeEach(() => {
  disposeSlots()
  resetStatusBarItems()
  configValues.clear()
})

test('默认（closeSuccess）：底栏不占格子 —— 关着是常态，不需要一直提示', () => {
  updateKeepTerminalSlot()
  const item = slotItem('keepterm')
  assert.ok(!item || !item.shown, '默认状态下不该出现「保留终端」格子')
})

test('开启 keep 时底栏出现「保留终端」，点击就是那个开关命令', () => {
  configValues.set('bastion.deployTerminalPolicy', 'keep')
  updateKeepTerminalSlot()
  const item = slotItem('keepterm')
  assert.ok(item, '应当创建了这个槽位')
  assert.equal(item!.shown, true, '开启时必须是显示的（看不到的开关等于没有）')
  assert.match(item!.text, /保留终端/)
  assert.equal(item!.command?.command, 'bastion.toggleKeepDeployTerminal', '点它就该能关掉')
  assert.ok(item!.backgroundColor, '要有醒目的背景色，不然会看漏')
})

test('从 keep 切回 closeSuccess：格子要收起来（显示不能落后于设置）', () => {
  configValues.set('bastion.deployTerminalPolicy', 'keep')
  updateKeepTerminalSlot()
  configValues.set('bastion.deployTerminalPolicy', 'closeSuccess')
  updateKeepTerminalSlot()
  assert.equal(slotItem('keepterm')!.shown, false)
})

test('toggle：一开一关，实际设置跟着变（状态不会和设置脱节）', async () => {
  assert.equal(getDeployTerminalPolicy(), 'closeSuccess')
  await toggleKeepDeployTerminal()
  assert.equal(getDeployTerminalPolicy(), 'keep', '第一次点应当开启')
  assert.equal(configValues.get('bastion.deployTerminalPolicy'), 'keep', '要真的写进设置，不能只改显示')
  assert.equal(slotItem('keepterm')!.shown, true, '开启后底栏立刻出现')
  await toggleKeepDeployTerminal()
  assert.equal(getDeployTerminalPolicy(), 'closeSuccess', '再点一次应当关闭')
})

test('设置里是 ask 时点开关 → 明确切成 keep（不会来回抖动）', async () => {
  configValues.set('bastion.deployTerminalPolicy', 'ask')
  assert.equal(getDeployTerminalPolicy(), 'ask')
  await toggleKeepDeployTerminal()
  assert.equal(getDeployTerminalPolicy(), 'keep', 'ask 状态下点开关应当切成 keep')
})
