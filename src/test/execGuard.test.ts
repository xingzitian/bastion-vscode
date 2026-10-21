// P2-a / P2-b 的纯逻辑测试：
//   - 乐观并发：cursor 对不上就拒绝（防止 AI 盲执行到别人动过的会话上）
//   - 幂等键：同一件事重试不重复执行；在途去重；失败不缓存；TTL 过期可重跑
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expectCursorProblem } from '../sessionBindings'
import { cachedNote, createExecMemo } from '../execIdempotency'

// ───────────────── P2-a：cursor ─────────────────

test('cursor 一致 / 没传 → 放行', () => {
  assert.equal(expectCursorProblem(undefined, 42), null, '没传就别校验')
  assert.equal(expectCursorProblem(42, 42), null, '一致就放行')
})

test('★ cursor 对不上 → 拒绝，并说清"先 tail 确认"', () => {
  const msg = expectCursorProblem(12, 15)
  assert.ok(msg, '必须拒绝')
  assert.match(String(msg), /cursor 12 → 15/)
  assert.match(String(msg), /bastion_tail/)
  assert.match(String(msg), /另一个 AI|用户/)
  assert.match(String(msg), /别传 expectCursor/, '要给出"我知道我在干什么"的出口')
})

test('cursor 传了非法值（NaN/Infinity）→ 不因为参数脏就拦住', () => {
  assert.equal(expectCursorProblem(Number.NaN, 3), null)
  assert.equal(expectCursorProblem(Number.POSITIVE_INFINITY, 3), null)
})

// ───────────────── P2-b：幂等键 ─────────────────

test('★ 同一个 key 第二次不再执行，直接返回上次结果', async () => {
  const memo = createExecMemo()
  let runs = 0
  const fn = async (): Promise<string> => {
    runs++
    return `输出#${runs}`
  }
  const a = await memo.run('restart-nginx', fn)
  const b = await memo.run('restart-nginx', fn)
  assert.equal(runs, 1, '第二次绝不能真的执行')
  assert.equal(a.cached, false)
  assert.equal(b.cached, true)
  assert.equal(b.text, '输出#1')
  assert.equal(b.joined, false)
})

test('不同 key 各自执行；不带 key 永远执行（服务端无法保证不重复）', async () => {
  const memo = createExecMemo()
  let runs = 0
  const fn = async (): Promise<string> => `x${++runs}`
  await memo.run('a', fn)
  await memo.run('b', fn)
  await memo.run(undefined, fn)
  await memo.run('   ', fn)
  assert.equal(runs, 4, '不同 key / 没 key 都算新的一次')
})

test('★ 上一次还在执行中（客户端超时重试）→ 等同一个结果，不并发再跑一遍', async () => {
  const memo = createExecMemo()
  let runs = 0
  let release: (v: string) => void = () => {}
  const slow = (): Promise<string> =>
    new Promise<string>((resolve) => {
      runs++
      release = resolve
    })
  const p1 = memo.run('long-op', slow)
  const p2 = memo.run('long-op', slow) // 重试在第一次还没结束时到达
  release('done-once')
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(runs, 1, '★ 只能真执行一次')
  assert.equal(a.text, 'done-once')
  assert.equal(b.text, 'done-once')
  assert.equal(b.joined, true)
  assert.match(cachedNote('long-op', true), /没有重复执行/)
})

test('失败不缓存：第一次真的失败，重试必须能再跑一次', async () => {
  const memo = createExecMemo()
  let runs = 0
  const flaky = async (): Promise<string> => {
    runs++
    if (runs === 1) throw new Error('网络抖了一下')
    return 'ok'
  }
  await assert.rejects(() => memo.run('k', flaky), /网络抖了一下/)
  const second = await memo.run('k', flaky)
  assert.equal(runs, 2, '失败之后重试必须真的执行')
  assert.equal(second.cached, false)
  assert.equal(second.text, 'ok')
})

test('超过 TTL 的记录会被清掉，之后同一个 key 可以重新执行', async () => {
  let t = 1000
  const memo = createExecMemo({ ttlMs: 1000, now: () => t })
  let runs = 0
  const fn = async (): Promise<string> => `r${++runs}`
  await memo.run('k', fn)
  assert.equal((await memo.run('k', fn)).cached, true)
  t += 5000
  const again = await memo.run('k', fn)
  assert.equal(again.cached, false, '过期之后要重新执行')
  assert.equal(runs, 2)
})

test('cachedNote 会告诉模型"这是旧结果、没有重复执行"', () => {
  assert.match(cachedNote('k', false), /上一次调用的结果/)
  assert.match(cachedNote('k', false), /没有重复执行/)
  assert.match(cachedNote('k', true), /还没结束/)
})
