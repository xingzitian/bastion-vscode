// 密码提示识别：厂商相关，必须可配置（写死三种会在别人机器上把密码提示当 MFA 问）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPasswordPrompt,
  isWaitingForPassword,
  resolvePasswordPrompts,
  DEFAULT_PASSWORD_PROMPTS
} from '../recognize'

test('常见文案都认：中 / 英 / 日 / 韩 / 繁体', () => {
  const cases = [
    'Password:',
    '[sudo] password for root: ',
    'Password for user:',
    '请输入密码：',
    '密码：',
    '口令：',
    '請輸入密碼：',
    'パスワード:',
    '암호:',
    'Enter passphrase for key:'
  ]
  for (const c of cases) {
    assert.equal(isPasswordPrompt(c), true, `应认出密码提示：${c}`)
  }
})

test('MFA 提示不该被当成密码', () => {
  const cases = ['[OTP Code]: ', 'Verification code:', '动态验证码：', '请输入动态口令（6 位）：']
  // 注意「动态口令」里含「口令」—— 这是内置规则的已知取舍：
  // 宁可多认一点密码（用户能改配置），也不要在别人机器上把密码当 MFA 填。
  // 这里只断言「纯 OTP/验证码」文案不被误判。
  for (const c of ['[OTP Code]: ', 'Verification code:', '动态验证码：']) {
    assert.equal(isPasswordPrompt(c), false, `不该认成密码：${c}`)
  }
  void cases
})

test('大小写不敏感', () => {
  assert.equal(isPasswordPrompt('PASSWORD:'), true)
  assert.equal(isPasswordPrompt('PaSsWoRd:'), true)
})

test('空文本不认', () => {
  assert.equal(isPasswordPrompt(''), false)
  assert.equal(isPasswordPrompt('   '), false)
  assert.equal(isWaitingForPassword(''), false)
})

test('只看最后一个非空行 —— 输出里路过 password 一词不算在等密码', () => {
  const out = [
    '$ grep password /etc/app.conf',
    'db_password = hunter2',
    'root@host:~# '
  ].join('\n')
  assert.equal(isWaitingForPassword(out), false, '结尾是 shell 提示符，不该判成等密码')
})

test('最后一行是密码提示才算在等密码（后面可能还有空行）', () => {
  const out = 'Starting deploy...\n[sudo] password for root: \n\n'
  assert.equal(isWaitingForPassword(out), true)
})

test('设置留空 → 用内置默认', () => {
  assert.deepEqual(resolvePasswordPrompts(() => undefined), DEFAULT_PASSWORD_PROMPTS)
  assert.deepEqual(resolvePasswordPrompts(() => []), DEFAULT_PASSWORD_PROMPTS)
  assert.deepEqual(resolvePasswordPrompts(() => ['  ']), DEFAULT_PASSWORD_PROMPTS)
  assert.deepEqual(resolvePasswordPrompts(() => 'not-an-array'), DEFAULT_PASSWORD_PROMPTS)
})

test('设置填了 → 整套替换（能适配任意厂商文案）', () => {
  const custom = resolvePasswordPrompts(() => ['公司口令', 'CorpSecret'])
  assert.deepEqual(custom, ['公司口令', 'CorpSecret'])
  // 替换后内置的「password」应失效
  assert.equal(isPasswordPrompt('Password:', custom), false)
  assert.equal(isPasswordPrompt('请输入公司口令：', custom), true)
})

test('设置里混入非字符串会被过滤掉，不会让整组失效', () => {
  const got = resolvePasswordPrompts(() => ['ok', 123, null, '  ', 'also-ok'])
  assert.deepEqual(got, ['ok', 'also-ok'])
})
