// 端口转发：**本地监听**语义的回归测试（0.3.14 修的那个 bug）。
//
// 历史 bug：实现用了 `rawClient.forwardIn()`（远端 bind，等于 `ssh -R`），
// 于是「本地和远端同端口」时必然失败（远端那个端口正是要访问的服务），
// 而且就算换了端口"启动成功"，本机也没有监听 —— 浏览器当然打不开。
//
// 这组测试锁三件事：
//   1. 错误信息必须说清"是**本地**端口占用"（历史 bug 的提示会让人以为是远端）
//   2. 绑定失败不留在 active 里；同一条规则重复启动是幂等的
//   3. 停掉之后监听真的关闭
//
// 说明：这里**不测完整数据通路**（本机 socket ↔ forwardOut 通道）。那需要一个
// 假的 SSH 通道 + 真 socket，跑起来会留下未关闭的 handle 把 `node --test` 挂住。
// 数据通路由 `bastion_health` 之外的真人验证：启动转发 → 浏览器打开页面。

import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as net from 'node:net'
import { bindErrorText, startForward, stopForward, isForwardActive, type ForwardRule } from '../forward'
import type { SharedConnection } from '../connection'

function fakeConn(): SharedConnection {
  const raw = {
    forwardOut: (_srcIP: string, _srcPort: number, _host: string, _port: number, cb: (err: Error | null, chan: unknown) => void) => {
      // 数据通路不在这组测试里；给一个立即关闭的假通道就够了
      cb(null, { on: () => undefined, destroy: () => undefined, pipe: () => undefined })
    }
  }
  return { rawClient: raw } as unknown as SharedConnection
}

/** 找一个空闲端口（bind 到 0 再关掉，取端口号） */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

function rule(id: string, localPort: number): ForwardRule {
  return { id, profileId: '测试', label: id, localHost: '127.0.0.1', localPort, remoteHost: '10.0.0.9', remotePort: 8006 }
}

test('★ 绑定失败的原因必须说清是「本地占用」（历史 bug：让人以为远端错）', () => {
  const eaddrinuse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
  const msg = bindErrorText(eaddrinuse, '127.0.0.1', 8006)
  assert.match(msg, /本地 127\.0\.0\.1:8006 已被占用/)
  assert.match(msg, /不是远端问题/)
  assert.match(msg, /18006/, '要给一个可操作的建议')

  const eacces = Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
  assert.match(bindErrorText(eacces, '127.0.0.1', 80), /权限/)

  assert.match(bindErrorText(new Error('boom'), '127.0.0.1', 9000), /监听失败.*boom/)
})

test('本机端口被占用时：reject 且不留在 active 里', async () => {
  const blocker = net.createServer()
  const port = await freePort()
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))
  try {
    await assert.rejects(
      () => startForward(fakeConn(), rule('fw-busy', port)),
      (e: Error) => {
        assert.match(e.message, /本地 127\.0\.0\.1:\d+ 已被占用/)
        return true
      }
    )
    assert.equal(isForwardActive('fw-busy'), false, '绑定失败不应留在 active 里')
  } finally {
    blocker.close()
  }
})

test('同一条规则重复启动是幂等的（树视图连点两下不该报错）', async () => {
  const port = await freePort()
  const r = rule('fw-twice', port)
  const conn = fakeConn()
  await startForward(conn, r)
  await startForward(conn, r) // 第二次必须 resolve，而不是 EADDRINUSE
  stopForward(r.id)
  assert.equal(isForwardActive(r.id), false)
})

test('停掉之后监听真的关闭了（再连就失败）', async () => {
  const port = await freePort()
  const r = rule('fw-stop', port)
  await startForward(fakeConn(), r)
  stopForward(r.id)
  const ok = await new Promise<boolean>((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
    setTimeout(() => resolve(false), 1500)
  })
  assert.equal(ok, false, '停止后不该还能连上')
})
