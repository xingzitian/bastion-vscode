// 传输锁的**行为**测试：直接构造真实的 BastionTerminal，看 handleInput 到底怎么写/不写。
//
// 与 transferLock.test.ts 的分工：
//   - transferLock.test.ts 测纯判定（该不该丢、计数、超时）
//   - 这个文件测**接线**：真实的 handleInput 在锁定期间确实没往 stream 写字节，
//     解锁后恢复；只读状态不被锁改动；屏幕是登录菜单时放行。
//
// 这是"静态检查抓不到"的那类风险（我们被"参数/字段被吞掉"坑过 4 次）。

import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BastionTerminal } from '../terminal'
import type { SharedConnection } from '../connection'
import type { ConnectionProfile } from '../profiles'

const profile: ConnectionProfile = {
  name: '测试机',
  host: '10.0.0.1',
  port: 22,
  username: 'tester',
  authMethod: 'password'
}

/** 造一个只有 stream 的终端：够跑 handleInput，不建真连接 */
interface TestableTerminal {
  stream: { write(d: string): unknown }
  tailBuf: string
  handleInput(d: string): void
  enterTransferLock(reason: string): void
  exitTransferLock(): void
  forceUnlockTransfer(why: string): void
  readonly isTransferLocked: boolean
  readonly isReadOnly: boolean
  setReadOnly(v: boolean): boolean
}

/** 造一个只有 stream 的终端：够跑 handleInput，不建真连接（私字段靠结构断言绕过） */
function makeTerm(): { t: TestableTerminal; writes: string[] } {
  const t = new BastionTerminal({} as SharedConnection, profile) as unknown as TestableTerminal
  const writes: string[] = []
  t.stream = { write: (d: string) => writes.push(d) }
  return { t, writes }
}

test('★ 正常输入写进 stream；进入传输锁后按键被丢弃；解锁后恢复', () => {
  const { t, writes } = makeTerm()

  t.handleInput('a')
  assert.deepEqual(writes, ['a'], '正常输入必须写进 stream')

  t.enterTransferLock('上传')
  assert.equal(t.isTransferLocked, true)

  t.handleInput('\u001b[A') // ↑
  t.handleInput('\r')
  assert.deepEqual(writes, ['a'], '锁定期间一个字节都不许写进 pty（否则 ESC 会打断 rz）')

  t.exitTransferLock()
  assert.equal(t.isTransferLocked, false)
  t.handleInput('b')
  assert.deepEqual(writes, ['a', 'b'], '解锁后必须恢复写入')
})

test('★ 只读状态不被锁改动：只读会话上传完仍然是只读', () => {
  const { t } = makeTerm()
  t.setReadOnly(true)
  assert.equal(t.isReadOnly, true)

  t.enterTransferLock('上传')
  t.exitTransferLock()
  assert.equal(t.isReadOnly, true, '锁不能把用户的只读设置改掉')
})

test('★ 屏幕停在登录菜单时放行（否则堡垒机登录会被锁死）', () => {
  const { t, writes } = makeTerm()
  t.enterTransferLock('上传')
  // 真实菜单原文（来自 menu.test.ts 的真机样本）
  t.tailBuf = '1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).\nOpt> '
  t.handleInput('1')
  assert.deepEqual(writes, ['1'], '菜单阶段必须能选机器，否则会死锁')
})

test('嵌套：编排层与内部各锁一次，只有全部退出才恢复', () => {
  const { t, writes } = makeTerm()
  t.enterTransferLock('上传') // 编排层
  t.enterTransferLock('上传') // 内部 upload()
  t.exitTransferLock()
  assert.equal(t.isTransferLocked, true, '内层退出不能提前解锁')
  t.handleInput('x')
  assert.deepEqual(writes, [], '仍然锁着')
  t.exitTransferLock()
  assert.equal(t.isTransferLocked, false)
  t.handleInput('y')
  assert.deepEqual(writes, ['y'])
})

test('强制解锁后键盘立刻可用（硬超时/会话关闭的兜底）', () => {
  const { t, writes } = makeTerm()
  t.enterTransferLock('下载')
  t.forceUnlockTransfer('测试')
  assert.equal(t.isTransferLocked, false)
  t.handleInput('z')
  assert.deepEqual(writes, ['z'])
})
