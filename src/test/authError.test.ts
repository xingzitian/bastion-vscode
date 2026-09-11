// 连接错误翻译：把 ssh2 的英文原文翻成「人话 + 能不能重试」
//
// 这一组测试来自一次真实事故：连堡垒机连续失败 6 次，每次都只看到
//   All configured authentication methods failed
// 既不知道是动态码错了还是密码错了，也不知道该不该再试。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeConnectError, shouldOfferRetry, MAX_AUTH_ATTEMPTS } from '../authError'

/** 造一个 ssh2 风格的认证失败错误 */
const authErr = (msg = 'All configured authentication methods failed'): Error & { level: string } =>
  Object.assign(new Error(msg), { level: 'client-authentication' })

test('动态码失败：认得出、可重试、说清「只重问动态码」', () => {
  const info = describeConnectError(authErr(), { usedMfa: true, target: '10.0.0.10' })
  assert.equal(info.kind, 'mfa')
  assert.equal(info.retryable, true)
  assert.match(info.message, /动态码/)
  assert.match(info.message, /只重新问动态码/)
})

test('没问过动态码就认证失败 → 是密码/用户名问题，重试没意义', () => {
  const info = describeConnectError(authErr(), { usedMfa: false })
  assert.equal(info.kind, 'password')
  assert.equal(info.retryable, false, '密码错了，原样重试不会有不同结果')
  assert.match(info.message, /用户名或密码/)
})

test('主机密钥校验失败：不能自动重试（这是唯一的中间人提示）', () => {
  const info = describeConnectError(new Error('Host key verification failed'))
  assert.equal(info.kind, 'hostkey')
  assert.equal(info.retryable, false)
  assert.match(info.message, /主机密钥/)
})

test('超时 / 网络类：可重试，且提示里带上目标地址', () => {
  const t = describeConnectError(new Error('Timed out while waiting for handshake'), { usedMfa: false, target: 'jumper:22' })
  assert.equal(t.kind, 'timeout')
  assert.equal(t.retryable, true)
  assert.match(t.message, /jumper:22/)

  const n = describeConnectError(new Error('connect ECONNREFUSED 1.2.3.4:22'))
  assert.equal(n.kind, 'network')
  assert.equal(n.retryable, true)
})

test('用户主动取消不算错误、也不该再弹重试', () => {
  const info = describeConnectError(new Error('用户取消 MFA'))
  assert.equal(info.kind, 'cancelled')
  assert.equal(info.retryable, false)
})

test('无法归类的错误：保留原文，别假装知道原因', () => {
  const info = describeConnectError(new Error('something weird happened'))
  assert.equal(info.kind, 'unknown')
  assert.equal(info.retryable, false)
  assert.match(info.message, /something weird happened/, '原文要留着，方便用户搜索')
})

test('非 Error 类型也不会崩（字符串 / null / undefined）', () => {
  for (const v of ['boom', null, undefined, 42]) {
    const info = describeConnectError(v)
    assert.ok(info.message.length > 0)
    assert.equal(info.kind, 'unknown')
  }
})

// ---- 这些文案出现在**纯文本**界面上，不许带 markdown ----
test('提示里不能有 markdown 记号：终端黄字/警告弹窗/错误弹窗/日志都是纯文本', () => {
  const cases: unknown[] = [
    authErr(), // mfa
    Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }),
    new Error('Host key verification failed'),
    new Error('Timed out while waiting for handshake'),
    new Error('connect ECONNREFUSED 1.2.3.4:22'),
    new Error('用户取消 MFA'),
    new Error('something weird happened')
  ]
  for (const c of cases) {
    for (const usedMfa of [true, false]) {
      const info = describeConnectError(c, { usedMfa, target: '10.0.0.10' })
      // 用户看到字面的 ** 只会以为是乱码 —— 这里钉住它
      assert.doesNotMatch(info.message, /\*\*/, `文案不该带 markdown 加粗：${info.message}`)
      assert.doesNotMatch(info.message, /`/, `文案不该带 markdown 代码记号：${info.message}`)
    }
  }
})

test('动态码失败的文案仍要说清「只重问动态码、密码不用再输」', () => {
  const info = describeConnectError(authErr(), { usedMfa: true })
  assert.match(info.message, /只重新问动态码/)
  assert.match(info.message, /密码不用再输/)
})

// ---- 重试策略：这条最容易被后续改动弄丢 ----
test('可重试的错误：第 1、2 次失败会问，第 3 次失败不再问（最多试 3 次）', () => {
  const mfa = describeConnectError(authErr(), { usedMfa: true })
  assert.equal(mfa.retryable, true)
  assert.equal(shouldOfferRetry(mfa, 1), true, '第 1 次失败 → 再试一次（第 2 次尝试）')
  assert.equal(shouldOfferRetry(mfa, 2), true, '第 2 次失败 → 再试一次（第 3 次尝试）')
  assert.equal(shouldOfferRetry(mfa, 3), false, '第 3 次失败 → 到此为止，不再弹窗')
  assert.equal(MAX_AUTH_ATTEMPTS, 3, '上限就是 3 次尝试（= 最多再问 2 次）')
})

test('不可重试的错误：一次都不问（密码错 / 指纹变 / 未知）', () => {
  for (const err of [
    Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }),
    new Error('Host key verification failed'),
    new Error('something weird happened')
  ]) {
    const info = describeConnectError(err, { usedMfa: false })
    assert.equal(info.retryable, false)
    assert.equal(shouldOfferRetry(info, 1), false, `${info.kind} 不该弹重试`)
  }
})

test('用户取消：即使被标成可重试也绝不问（他刚刚说了不想连）', () => {
  assert.equal(shouldOfferRetry({ kind: 'cancelled', retryable: true }, 1), false)
  const info = describeConnectError(new Error('用户取消 MFA'))
  assert.equal(shouldOfferRetry(info, 1), false)
})
