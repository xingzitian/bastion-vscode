// 「清除已保存的密码」必须**真的**生效（2026-11-27 维护者报：清完再连还是拿旧密码去认证）。
//
// 根因：`SharedConnection` 自己捏着这次握手用的密码（`retryAuth` 会沿用它，为了"只重问动态码"），
// 而认证失败时 `authFailed` 会让 close 回调提前 return —— 连接**不会**被池子自动摘掉。
// 于是「钥匙串已清空」+「池子里那条连接还带着旧密码」同时成立：
// `ensureConnection` → `manager.get()` 直接命中它，既不读钥匙串也不弹输入框。
//
// 这一组盯的就是那条界线：**清凭据 = 池子里的那份也要摘掉**，但不能顺手打死别人的活会话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetConnection } from '../core/connectionPool'

function fakeConn(channels = 0): { conn: { isAlive: boolean; channelCount: number; end(): void }; ended: () => number } {
  let ends = 0
  return {
    conn: {
      isAlive: true,
      channelCount: channels,
      end: () => {
        ends += 1
      }
    },
    ended: () => ends
  }
}

test('清凭据后池子里那条连接必须被摘掉 —— 否则下次连接还会用内存里的旧密码', () => {
  const pool = new Map<string, ReturnType<typeof fakeConn>['conn']>()
  const { conn, ended } = fakeConn()
  pool.set('中转2', conn)

  const r = forgetConnection(pool, '中转2')

  assert.deepEqual(r, { dropped: true, ended: true }, '没有活会话 → 摘掉并关掉')
  assert.equal(pool.get('中转2'), undefined, '摘掉之后池子里查不到（下次连接才会重新读钥匙串/问人）')
  assert.equal(ended(), 1, '没人用这条连接，应该真的 end() 掉')
})

test('还有活着的会话时：只摘池子，不 end()（不能因为清密码把别人的终端打死）', () => {
  const pool = new Map<string, ReturnType<typeof fakeConn>['conn']>()
  const { conn, ended } = fakeConn(2)
  pool.set('中转2', conn)

  const r = forgetConnection(pool, '中转2')

  assert.deepEqual(r, { dropped: true, ended: false })
  assert.equal(pool.get('中转2'), undefined, '池子里不再有它')
  assert.equal(ended(), 0, '还有 2 个通道在用，不能 end()')
})

test('池子里没有这条连接时是幂等的（清除命令多点几次不会出错）', () => {
  const pool = new Map<string, ReturnType<typeof fakeConn>['conn']>()
  assert.deepEqual(forgetConnection(pool, '不存在'), { dropped: false, ended: false })
})

test('只影响指定的那个档案，别人的连接原封不动', () => {
  const pool = new Map<string, ReturnType<typeof fakeConn>['conn']>()
  const { conn: a } = fakeConn()
  const { conn: b, ended: bEnded } = fakeConn()
  pool.set('A', a)
  pool.set('B', b)

  forgetConnection(pool, 'A')

  assert.equal(pool.get('A'), undefined)
  assert.equal(pool.get('B'), b, 'B 不该被动到')
  assert.equal(bEnded(), 0)
})
