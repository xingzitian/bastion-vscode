// 档案改名/删除后，钥匙串里的密码怎么跟着走（2026-11-27 维护者：改了名之后
// 「清理密码还是有问题」——旧名字那份密码既清不掉也看不见，因为 SecretStorage 不能枚举）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSecretMigration } from '../core/profileSecretMigration'

const A = { name: '中转2', host: '66.85.92.49', port: 22, username: 'root' }

test('改名（身份完全一致）→ 密码应该搬到新名字下', () => {
  const plan = planSecretMigration([A], [{ ...A, name: '中转长期机器' }])
  assert.deepEqual(plan.renames, [{ from: '中转2', to: '中转长期机器' }])
  assert.deepEqual(plan.removed, [], '不能当成删除 —— 否则密码丢了')
})

test('删掉档案 → 它那份密码要清掉（别在钥匙串里留孤儿）', () => {
  const plan = planSecretMigration([A], [])
  assert.deepEqual(plan.removed, ['中转2'])
  assert.deepEqual(plan.renames, [])
})

test('密码认证改成密钥认证、名字不变 → 什么都不用做', () => {
  const plan = planSecretMigration([A], [{ ...A }])
  assert.deepEqual(plan, { renames: [], removed: [], skipped: [] })
})

test('同一个身份有两条旧档案、只留一条新名字 → 分不清，不动（既不搬也不删）', () => {
  const plan = planSecretMigration([A, { ...A, name: '备用' }], [{ ...A, name: '新名字' }])
  assert.deepEqual(plan.renames, [], '分不清就不猜')
  assert.deepEqual(plan.removed, [], '更不能删（删了密码就找不回来了）')
  assert.ok(plan.skipped.includes('中转2') && plan.skipped.includes('备用'))
})

test('只换了端口/用户/私钥 → 身份不同，不算改名（按删除处理）', () => {
  const plan = planSecretMigration([A], [{ ...A, name: '新机器', port: 2222 }])
  assert.deepEqual(plan.renames, [], '端口不同就是另一台，别把密码搬过去')
  assert.deepEqual(plan.removed, ['中转2'])
})

test('多条互不相关的改名一次算清', () => {
  const B = { name: 'xb', host: '91.108.80.167', port: 22, username: 'computebox' }
  const plan = planSecretMigration([A, B], [{ ...A, name: '中转长期机器' }, { ...B, name: 'xb-新' }])
  assert.deepEqual(
    plan.renames.sort((x, y) => x.from.localeCompare(y.from)),
    [
      { from: 'xb', to: 'xb-新' },
      { from: '中转2', to: '中转长期机器' }
    ].sort((x, y) => x.from.localeCompare(y.from))
  )
  assert.deepEqual(plan.removed, [])
})

test('新增档案不影响已有密码', () => {
  const plan = planSecretMigration([A], [A, { name: '新的', host: '1.2.3.4', username: 'root' }])
  assert.deepEqual(plan, { renames: [], removed: [], skipped: [] })
})
