// 底栏格子可配（bastion.statusBarItems）
//
// 背景：底栏最多会长出 5 格（会话/只读/覆盖/保留终端/转发），有人嫌挤。
// 这一组测试守住三件事：
//   1. 没配过 → 全部显示（不能因为新设置让人以为扩展坏了）
//   2. 配了就按配的来；未知名字忽略
//   3. **拼错导致一个合法名字都没有时，退回全部显示** —— 不能让一个拼写错误把底栏清空
// 另外还确认：进度类格子（传输/部署/MFA）不在可关列表里。
import '../testkit/vscode-stub'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { configValues, resetStatusBarItems, slotItem } from '../testkit/vscode-stub'
import { disposeSlots } from '../status'
import {
  STATUS_SLOT_KEYS,
  resolveStatusSlots,
  updateStatusBar,
  updateKeepTerminalSlot,
  updateReadOnlySlot,
  updateOverwriteSlot,
  updateBroadcastSlot
} from '../slots'
import { setBroadcastTargets, terminals, clearBroadcast } from '../state'
import type { BastionTerminal } from '../terminal'

beforeEach(() => {
  disposeSlots()
  resetStatusBarItems()
  configValues.clear()
})

test('没配过 → 全部显示', () => {
  const on = resolveStatusSlots(undefined)
  for (const k of STATUS_SLOT_KEYS) assert.equal(on.has(k), true, `${k} 应默认显示`)
  assert.equal(on.size, STATUS_SLOT_KEYS.length)
})

test('配了就按配的来；未知名字忽略', () => {
  const on = resolveStatusSlots(['session', 'forward', '不存在的名字', 42, null])
  assert.deepEqual([...on].sort(), ['forward', 'session'])
})

test('空数组 = 一个都不显示（这是明确的用户意图）', () => {
  assert.equal(resolveStatusSlots([]).size, 0)
})

test('非空但一个合法名字都没有 → 退回全部显示（拼错不该让底栏空掉）', () => {
  const on = resolveStatusSlots(['ssesion']) // 拼错了
  assert.equal(on.size, STATUS_SLOT_KEYS.length, '拼错时应退回全部显示，而不是什么都不显示')
  assert.equal(on.has('session'), true)
})

test('进度类格子不在可关列表里（关掉会让人不知道后台在干什么）', () => {
  for (const k of ['transfer', 'deploy', 'mfa'] as const) {
    assert.equal((STATUS_SLOT_KEYS as readonly string[]).includes(k), false, `${k} 不该出现在可配列表里`)
  }
})

test('关掉「保留终端」格子：即使策略是 keep，那一格也不显示', () => {
  configValues.set('bastion.deployTerminalPolicy', 'keep')
  updateKeepTerminalSlot()
  assert.equal(slotItem('keepterm')!.shown, true, '前提：开着策略时是显示的')

  disposeSlots()
  resetStatusBarItems()
  configValues.set('bastion.deployTerminalPolicy', 'keep')
  configValues.set('bastion.statusBarItems', ['session'])
  updateKeepTerminalSlot()
  const item = slotItem('keepterm')
  assert.ok(!item || !item.shown, '设置里没列 keepterm → 不该显示')
})

test('关掉「会话概览」格子：底栏不再出现那一格', () => {
  configValues.set('bastion.statusBarItems', ['forward'])
  updateStatusBar()
  const item = slotItem('session')
  assert.ok(!item || !item.shown, '没列 session → 不该显示会话格')
})

test('会话格子默认是显示的（不能因为新设置把默认行为改坏）', () => {
  updateStatusBar()
  const item = slotItem('session')
  assert.ok(item, '默认应创建会话格')
  assert.equal(item!.shown, true)
})

// ---------------------------------------------------------------------------
// 所有常驻格子的 tooltip 都带 markdown 记号（**、`）——
// 而 VS Code 只对 MarkdownString 走 markdown 渲染：工作台里就是
//   isMarkdownString(tooltip) ? { markdown: tooltip } : tooltip
// 传纯字符串的话，用户悬停看到的是**字面的两个星号**。这条守住这个坑。
// ---------------------------------------------------------------------------
test('常驻格子的 tooltip 必须是 MarkdownString（纯字符串会让用户看到字面的 **）', () => {
  const vt = { name: '#1 a' } as unknown as vscode.Terminal
  terminals.set(vt, { sessionNo: 1, isReadOnly: false, isClosed: false } as unknown as BastionTerminal)
  setBroadcastTargets([...terminals.values()])

  configValues.set('bastion.deployTerminalPolicy', 'keep')
  updateKeepTerminalSlot()
  updateReadOnlySlot()
  updateOverwriteSlot()
  updateBroadcastSlot()

  for (const k of ['readonly', 'overwrite', 'keepterm', 'broadcast'] as const) {
    const item = slotItem(k)
    assert.ok(item, `${k} 格子应当存在`)
    assert.ok(
      item!.tooltip instanceof vscode.MarkdownString,
      `${k} 的 tooltip 是纯字符串 → VS Code 会原样显示，用户看到字面的 **`
    )
    const value = (item!.tooltip as unknown as { value: string }).value
    assert.ok(value.includes('**'), `${k} 的 tooltip 本来就写了 markdown，就该按 markdown 渲染`)
  }
  terminals.clear()
  clearBroadcast()
})
