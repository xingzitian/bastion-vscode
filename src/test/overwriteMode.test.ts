// 覆盖模式的读取：状态栏显示的和上传实际用到的，必须是同一个值
//
// 用户的疑问「我右下角设的是覆盖，报告却说跳过」，本质就是担心这两个地方读的不是一个东西。
// 这条测试把「设置 → getOverwriteMode()」这条读取链固定下来：
// 三个合法值原样返回，非法值退回 skip（和 terminal.upload 里的解析保持一致）。
import '../testkit/vscode-stub'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { configValues } from '../testkit/vscode-stub'
import { getOverwriteMode } from '../slots'

beforeEach(() => configValues.clear())

test('三个合法值都原样读出来', () => {
  for (const v of ['skip', 'overwrite', 'rename']) {
    configValues.set('bastion.uploadOverwrite', v)
    assert.equal(getOverwriteMode(), v, `设置 ${v} 应读出 ${v}`)
  }
})

test('设置项没设过时读默认值 skip', () => {
  configValues.clear()
  assert.equal(getOverwriteMode(), 'skip')
})

test('非法值 / 写错大小写都退回 skip（不能让上传拿一个未知模式去拼 rz 参数）', () => {
  for (const bad of ['OVERWRITE', 'OverWrite', 'yes', '', '  ', 123, null, undefined, {}]) {
    configValues.set('bastion.uploadOverwrite', bad as unknown)
    assert.equal(getOverwriteMode(), 'skip', `非法值 ${JSON.stringify(bad)} 应退回 skip`)
  }
})

test('状态栏显示与上传用的是同一个键（bastion.uploadOverwrite）', () => {
  // 这条是防回归：一旦有人把某一边改成读别的键，用户就会看到「显示覆盖、实际跳过」
  configValues.set('bastion.uploadOverwrite', 'overwrite')
  assert.equal(getOverwriteMode(), 'overwrite')
  // 换个无关的键不该影响它
  configValues.set('bastion.uploadOverwriteX', 'rename')
  assert.equal(getOverwriteMode(), 'overwrite', '只认 bastion.uploadOverwrite')
})
