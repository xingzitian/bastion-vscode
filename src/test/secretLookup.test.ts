// 「现取 DPAPI 密码」的取数逻辑（桌面 `bastion_connect` 用）。
//
// 为什么要有它：启动时把密码表读进内存之后，用户在界面里「清除已保存的密码」
// 只会删掉 DPAPI 里那份，内存里那份还在 —— AI 仍然能拿旧密码去连（2026-11-27 报的
// "清理不掉"是同一类问题）。现取就没有这个窗口：删了立刻连不上，新存立刻生效。
//
// 这一组盯的是**失败必须安静**：取不到（404 / 连不上 / 超时 / 空值）一律 undefined，
// 由调用方给可读的拒绝理由 —— 不能抛异常把 `bastion_connect` 变成一堆栈。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { fetchSecret } from '../core/secretLookup'

interface Started {
  base: string
  close(): Promise<void>
}

async function serve(handler: http.RequestListener): Promise<Started> {
  const srv = http.createServer(handler)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  }
}

test('200 + value → 返回密码原文（路径与 key 参数都对）', async () => {
  let seen = ''
  const s = await serve((req, res) => {
    seen = String(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ value: 'pw-123' }))
  })
  try {
    assert.equal(await fetchSecret(s.base, '中转2'), 'pw-123')
    assert.equal(seen, '/api/secret?key=' + encodeURIComponent('中转2'))
  } finally {
    await s.close()
  }
})

test('404（没存过 / 已经清掉）→ undefined，不抛', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  try {
    assert.equal(await fetchSecret(s.base, '中转2'), undefined)
  } finally {
    await s.close()
  }
})

test('value 是空串 → undefined（等于"没有密码"，不能当空密码去连）', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ value: '' }))
  })
  try {
    assert.equal(await fetchSecret(s.base, 'p'), undefined)
  } finally {
    await s.close()
  }
})

test('端口没人听（Go 后端没起来）→ undefined，不抛', async () => {
  assert.equal(await fetchSecret('http://127.0.0.1:1', 'p', { timeoutMs: 800 }), undefined)
})

test('对端不响应 → 超时返回 undefined（不能把 connect 卡死）', async () => {
  const s = await serve(() => {
    /* 故意不回应 */
  })
  try {
    const t0 = Date.now()
    assert.equal(await fetchSecret(s.base, 'p', { timeoutMs: 300 }), undefined)
    assert.ok(Date.now() - t0 < 3000, '必须在超时附近返回')
  } finally {
    await s.close()
  }
})

test('base 为空（没有 proxyBase）→ 直接 undefined，不发请求', async () => {
  assert.equal(await fetchSecret('', 'p'), undefined)
})
