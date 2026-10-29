// 断线/关闭相关的回归：终端关不掉、会话卡在面板上（0.3.11 之后的真机问题）
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BastionTerminal } from '../terminal'
import { closeSessionsOfConn } from '../sessions'
import { terminals } from '../state'

function fakeConn(): any {
  return {
    isAlive: true,
    connectedAt: Date.now(),
    channelCount: 1,
    onClose: () => undefined
  }
}

function fakeProfile(): any {
  return { name: 'p', host: '127.0.0.1', port: 22, username: 'u', mode: 'direct' }
}

function newTerm(sessionNo: number): BastionTerminal {
  const t = new BastionTerminal(fakeConn(), fakeProfile())
  t.sessionNo = sessionNo
  t.sessionId = `s-${sessionNo}`
  return t
}

test('★ close() 第二次调用必须仍然发 close 事件（否则终端永远关不掉）', () => {
  const t = newTerm(1)
  let closes = 0
  t.onDidClose(() => {
    closes++
  })
  t.close()
  assert.equal(closes, 1, '第一次关闭应发一次')
  // 真机上出现过的状态：第一次 close 被 VS Code 漏掉，终端还在 → 用户再点「关闭」
  t.close()
  assert.equal(closes, 2, '★ 第二次必须再发：否则 dispose() 是空操作，终端和卡片都清不掉')
})

test('finish 内部重复调用不会额外发事件（正常路径不重复）', () => {
  const t = newTerm(2)
  let closes = 0
  t.onDidClose(() => {
    closes++
  })
  // 走 pty 的内部收尾（模拟 shell 通道断开）
  ;(t as unknown as { finish: (c: number, m?: string) => void }).finish(0, '[会话已断开]')
  ;(t as unknown as { finish: (c: number, m?: string) => void }).finish(0, '[会话已断开]')
  assert.equal(closes, 1, '正常路径只发一次')
})

test('★ 断线收尾：该连接上的会话全部 close()，并从表里清掉', async () => {
  terminals.clear()
  const conn = fakeConn()
  const a = newTerm(101)
  const b = newTerm(102)
  const other = newTerm(103)
  const closed: number[] = []
  for (const t of [a, b, other]) {
    t.close = () => {
      closed.push(t.sessionNo)
    }
  }
  const vtA = { name: '#101 a' } as never
  const vtB = { name: '#102 b' } as never
  const vtOther = { name: '#103 c' } as never
  // a/b 属于这条断掉的连接；other 属于另一条，不该被收尾
  ;(a as unknown as { conn: unknown }).conn = conn
  ;(b as unknown as { conn: unknown }).conn = conn
  ;(other as unknown as { conn: unknown }).conn = fakeConn()
  terminals.set(vtA, a)
  terminals.set(vtB, b)
  terminals.set(vtOther, other)

  closeSessionsOfConn(conn as never)
  assert.deepEqual(closed.sort(), [101, 102], '只关本连接上的两条')

  // 300ms 兜底清表（VS Code 没兑现 close 的情况）
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(terminals.has(vtA), false, 'A 应从表里移除')
  assert.equal(terminals.has(vtB), false, 'B 应从表里移除')
  assert.equal(terminals.has(vtOther), true, '别的连接的会话不能动')
  terminals.clear()
})
