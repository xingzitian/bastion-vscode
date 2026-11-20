// 断线原因分类的测试。
//
// 起因（2026-11-20 用户日志）：只有一句 `SSH 错误: read ECONNRESET`，
// 看起来都像"莫名断了"。实际是三种不同的事，日志要能区分，否则排障全靠猜。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDisconnect, describeDisconnect } from '../core/disconnect'

test('★ RST：对端重置（NAT/防火墙删映射、服务端踢人）', () => {
  const v = classifyDisconnect(new Error('read ECONNRESET'))
  assert.equal(v.kind, 'rst')
  assert.match(v.label, /对端重置/)
  assert.match(v.hint, /重连/)
})

test('★ keepalive 超时：和 RST 要分开（更早发现链路已断）', () => {
  const v = classifyDisconnect(new Error('Keepalive timeout'))
  assert.equal(v.kind, 'keepalive')
  assert.match(v.label, /keepalive/)
})

test('网络超时 / 连接被拒 / 认证失败 各自归类', () => {
  assert.equal(classifyDisconnect(new Error('connect ETIMEDOUT 1.2.3.4:22')).kind, 'timeout')
  assert.equal(classifyDisconnect(new Error('connect ECONNREFUSED')).kind, 'refused')
  assert.equal(classifyDisconnect(new Error('All configured authentication methods failed')).kind, 'auth')
})

test('★ 通道打不开：Channel open failure（MaxSessions / 连接已坏）单独一类', () => {
  const v = classifyDisconnect(new Error('(SSH) Channel open failure: open failed'))
  assert.equal(v.kind, 'channel')
  assert.match(v.hint, /MaxSessions/)
})

test('★ shell 通道关闭 与 整条连接断开 要能区分', () => {
  const shell = classifyDisconnect(undefined, 'shell')
  assert.equal(shell.kind, 'shell-closed')
  assert.match(shell.label, /shell/)
  // 同样"没有错误对象"，但发生在连接层 → 不能说成 shell
  const conn = classifyDisconnect(undefined, 'connection')
  assert.equal(conn.kind, 'unknown')
})

test('describeDisconnect 给出一句话（标签 + 该怎么办）', () => {
  const s = describeDisconnect(new Error('read ECONNRESET'))
  assert.match(s, /对端重置（RST）/)
  assert.match(s, /——/)
})
