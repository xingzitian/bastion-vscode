// 运行中部署登记表 + 停止语义（跑完当前这台才停）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerDeploy,
  unregisterDeploy,
  getRunningDeploy,
  isDeployRunning,
  listRunningDeploys,
  abortDeploy,
  __clearRunningForTest
} from '../deployRunning'

beforeEach(() => __clearRunningForTest())

test('注册后可查到，进度从 0 开始', () => {
  registerDeploy('t1', '任务A', 5)
  assert.equal(isDeployRunning('t1'), true)
  const info = getRunningDeploy('t1')!
  assert.equal(info.taskName, '任务A')
  assert.equal(info.total, 5)
  assert.equal(info.done, 0)
  assert.equal(info.abort, false)
})

test('注销后查不到（任务结束时必须注销，否则树上一辈子转圈）', () => {
  registerDeploy('t1', '任务A', 5)
  unregisterDeploy('t1')
  assert.equal(isDeployRunning('t1'), false)
  assert.equal(getRunningDeploy('t1'), undefined)
})

test('注销不存在的任务不抛异常', () => {
  assert.doesNotThrow(() => unregisterDeploy('不存在'))
})

test('abort：登记过才返回 true，之后 abort 标记为真', () => {
  registerDeploy('t1', '任务A', 3)
  assert.equal(abortDeploy('t1'), true)
  assert.equal(getRunningDeploy('t1')!.abort, true)
  // 再点一次也算成功（幂等）
  assert.equal(abortDeploy('t1'), true)
})

test('abort 没在跑的任务返回 false（树上的 ■ 不会误伤别的任务）', () => {
  assert.equal(abortDeploy('不存在'), false)
})

test('多任务互不干扰：停一个不影响另一个', () => {
  registerDeploy('t1', 'A', 2)
  registerDeploy('t2', 'B', 2)
  assert.equal(listRunningDeploys().length, 2)
  abortDeploy('t1')
  assert.equal(getRunningDeploy('t1')!.abort, true)
  assert.equal(getRunningDeploy('t2')!.abort, false, '不该连带停掉别的任务')
  unregisterDeploy('t1')
  assert.equal(listRunningDeploys().length, 1)
})

test('重复注册同一个 id 会覆盖（调用方在跑之前会先查 isDeployRunning 拦住）', () => {
  registerDeploy('t1', '第一次', 1)
  registerDeploy('t1', '第二次', 2)
  assert.equal(listRunningDeploys().length, 1)
  assert.equal(getRunningDeploy('t1')!.taskName, '第二次')
})

test('进度可以持续推进（树视图显示 3/8 用的就是它）', () => {
  const info = registerDeploy('t1', 'A', 8)
  info.done = 3
  assert.equal(getRunningDeploy('t1')!.done, 3)
})
