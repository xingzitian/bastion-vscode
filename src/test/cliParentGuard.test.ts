// 父进程守卫：桌面被强杀后，CLI 子进程不能变成孤儿（2026-11-23 用户看到一堆 node 进程）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAlive, parseParentPid } from '../cli/main'

test('isAlive：自己活着，瞎编的 pid 不活', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(2 ** 30), false)
  assert.equal(isAlive(0), false)
  assert.equal(isAlive(Number.NaN), false)
})

test('parseParentPid：只认正数，缺值/垃圾都当没传', () => {
  assert.equal(parseParentPid(['node', 'serve', 'xzt', '--parent-pid', '1234']), 1234)
  assert.equal(parseParentPid(['--parent-pid', '0']), undefined)
  assert.equal(parseParentPid(['--parent-pid', 'abc']), undefined)
  assert.equal(parseParentPid(['--parent-pid']), undefined)
  assert.equal(parseParentPid([]), undefined)
})
