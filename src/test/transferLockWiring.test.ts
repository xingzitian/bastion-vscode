// 传输锁的"接线"守卫（读源码断言）。
//
// 为什么这类测试值得写：锁本身已经在 transferLock.test.ts 里测透了，
// 但历史教训是**接线**最容易悄悄坏 —— 我们踩过 4 次同类事故（headers / meta / 权限 / why+intentId
// 都在"转发器逐字段列举"时被吞掉）。所以这里锁死几条结构性事实：
//   1. handleInput 里传输锁的判断必须在只读判断**之前**（否则"菜单放行"分支永远走不到，
//      因为锁本身会先被只读分支拦下并提示"只读模式"，看起来像用户设置问题）
//   2. upload / download 都必须在 finally 里解锁（异常路径也要恢复）
//   3. 广播必须过滤 isTransferLocked（广播走 writeToSession，绕过只读判断）
//   4. 所有 push/pull 入口都要包 withTransferLock（否则探测/校验阶段没锁）
//   5. zmodem 拒绝时要把 screenTail 传进去并附在原因里

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const root = path.resolve(__dirname, '..', '..')

function src(rel: string): string {
  return fs.readFileSync(path.join(root, 'src', rel), 'utf8')
}

test('★ handleInput：传输锁判断必须在只读判断之前', () => {
  const s = src('terminal.ts')
  const lockAt = s.indexOf('if (this.tlock.active)')
  // 只读分支的判定（setReadOnly 是方法定义，这里找 handleInput 里的那句）
  const roAt = s.indexOf('if (this.readOnly) {')
  assert.ok(lockAt > 0, 'handleInput 里找不到传输锁判断')
  assert.ok(roAt > 0, 'handleInput 里找不到只读判断')
  assert.ok(lockAt < roAt, '传输锁必须在只读之前 —— 否则锁住时会被当成"只读模式"提示，菜单也放行不了')
})

test('★ upload / download：异常路径也要解锁（finally）', () => {
  const s = src('terminal.ts')
  for (const reason of ["enterTransferLock('上传')", "enterTransferLock('下载')"]) {
    const at = s.indexOf(reason)
    assert.ok(at > 0, `找不到 ${reason}`)
    // 该锁之后必须出现 finally + exitTransferLock（距离不要太远）
    const tail = s.slice(at, at + 3000)
    assert.match(tail, /finally \{/, `${reason} 之后没有 finally —— 抛错时键盘会一直锁着`)
    assert.match(tail, /this\.exitTransferLock\(\)/, `${reason} 之后没有 exitTransferLock()`)
  }
})

test('★ 广播：必须跳过正在传输的会话（广播绕过只读判断）', () => {
  const s = src('state.ts')
  assert.match(s, /!t\.isTransferLocked/, 'broadcastReceivers 没有过滤 isTransferLocked')
})

test('★ 所有 push/pull 入口都包了 withTransferLock（探测/校验阶段也要锁）', () => {
  const sites: Array<[string, RegExp]> = [
    ['terminal.ts', /withTransferLock\('上传'/],
    ['transferCmd.ts', /withTransferLock\('上传'/],
    ['aiBridge.ts', /withTransferLock\('上传'/],
    ['aiBridge.ts', /withTransferLock\('下载'/]
  ]
  for (const [file, re] of sites) {
    assert.match(src(file), re, `${file} 缺少传输锁包裹`)
  }
  // pushPath / pullPath 的调用次数应等于被包住的次数（多一处就会漏锁）
  const ai = src('aiBridge.ts')
  assert.equal((ai.match(/pushPath\(\{/g) ?? []).length, 1, 'aiBridge 里 pushPath 调用点数量变了，检查是否漏包')
  assert.equal((ai.match(/pullPath\(\{/g) ?? []).length, 1, 'aiBridge 里 pullPath 调用点数量变了，检查是否漏包')
})

test('★ 会话关闭时清理锁与状态栏', () => {
  assert.match(src('terminal.ts'), /forceUnlockTransfer\('会话关闭'\)/)
})

test('zmodem：拒绝时把远端屏幕尾巴附进原因（不再猜"不支持 -y"）', () => {
  const s = src('core/zmodem.ts')
  assert.match(s, /screenTail\?: \(\) => string/, 'ZmodemSendOptions 缺 screenTail')
  assert.match(s, /this\.rejectTail = options\.screenTail/, 'sendFiles 没把 screenTail 存进去')
  assert.match(s, /远端最后输出/, '拒绝原因里没有附远端输出')
  assert.ok(!/可能不支持该参数/.test(s), '旧的"对端可能不支持 -y"猜测文案又回来了')
})
