// 凭据清单（只有元数据）—— 让「我到底存了哪些密码」变成能看见的事。
//
// 背景（2026-11-27 维护者）：密码在两个地方各自加密保存（扩展 SecretStorage 不能枚举 /
// 桌面 DPAPI 能枚举），两边互不知道；改名之后旧键就成了谁都清不掉的孤儿。
// 这个清单只记"谁在哪个键上存了什么、什么时候"，用来合并显示 + 认孤儿。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let dir = ''
const realShared = process.env.BASTIONSHELL_SHARED_DIR

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-cred-'))
  process.env.BASTIONSHELL_SHARED_DIR = dir
})
after(() => {
  if (realShared === undefined) delete process.env.BASTIONSHELL_SHARED_DIR
  else process.env.BASTIONSHELL_SHARED_DIR = realShared
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function idx() {
  // 每次重新 import 走 configDir() 的实时读法不需要重载：模块内部每次调用都会读 env
  return import('../core/credentialIndex')
}

/** 每个用例从空清单开始，互不影响 */
async function fresh() {
  const m = await idx()
  fs.rmSync(m.credentialIndexPath(), { force: true })
  return m
}

test('记一条 → 读得到；同一键重复记只留最新时间', async () => {
  const m = await fresh()
  m.recordEntry({ key: 'xzt', kind: 'password', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  m.recordEntry({ key: 'xzt', kind: 'password', owner: 'vscode' }, () => '2026-11-27T02:00:00.000Z')
  const list = m.readIndex()
  assert.equal(list.length, 1, '同 (key,kind,owner) 不能重复')
  assert.equal(list[0].updatedAt, '2026-11-27T02:00:00.000Z')
})

test('两个产品的条目能并在一张表里（属主不同就是两条）', async () => {
  const m = await fresh()
  m.recordEntry({ key: '中转长期机器', kind: 'password', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  m.recordEntry({ key: '中转长期机器', kind: 'password', owner: 'desktop' }, () => '2026-11-27T01:00:00.000Z')
  const rows = m.readIndex().filter((e) => e.key === '中转长期机器')
  assert.deepEqual(rows.map((r) => r.owner).sort(), ['desktop', 'vscode'])
})

test('删一条只删那一条（不影响同键的另一种类 / 另一个属主）', async () => {
  const m = await fresh()
  m.recordEntry({ key: 'p1', kind: 'passphrase', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  m.recordEntry({ key: 'p1', kind: 'password', owner: 'desktop' }, () => '2026-11-27T01:00:00.000Z')
  m.dropEntry('p1', 'password', 'desktop')
  const left = m.readIndex().filter((e) => e.key === 'p1')
  assert.deepEqual(left.map((e) => `${e.kind}/${e.owner}`), ['passphrase/vscode'])
})

test('孤儿 = 清单里有、档案表里没有的键（改名/删除留下的）', async () => {
  const m = await fresh()
  m.recordEntry({ key: '中转2', kind: 'password', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  const orphan = m.orphansOf(m.readIndex(), ['xzt', '中转长期机器'])
  assert.deepEqual(orphan.map((e) => e.key), ['中转2'])
})

test('dropKey 一次清掉这个键的所有条目（清孤儿用）', async () => {
  const m = await fresh()
  m.recordEntry({ key: 'oldname', kind: 'password', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  m.recordEntry({ key: 'oldname', kind: 'passphrase', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  m.dropKey('oldname')
  assert.deepEqual(m.readIndex().filter((e) => e.key === 'oldname'), [])
})

test('清单文件坏掉 → 读成空表，不抛（只影响显示）', async () => {
  const m = await fresh()
  fs.writeFileSync(m.credentialIndexPath(), '{ 这不是 JSON', 'utf8')
  assert.deepEqual(m.readIndex(), [])
  // 坏文件不该阻止继续记录
  m.recordEntry({ key: 'ok', kind: 'password', owner: 'vscode' }, () => '2026-11-27T01:00:00.000Z')
  assert.deepEqual(m.readIndex().map((e) => e.key), ['ok'])
})

test('清单里绝不能出现明文密码字段（只有元数据）', async () => {
  const m = await fresh()
  m.recordEntry({ key: 'secret-profile', kind: 'password', owner: 'desktop' }, () => '2026-11-27T01:00:00.000Z')
  const raw = fs.readFileSync(m.credentialIndexPath(), 'utf8')
  const parsed = JSON.parse(raw) as { entries: Array<Record<string, unknown>> }
  const allowed = new Set(['key', 'kind', 'owner', 'updatedAt'])
  for (const e of parsed.entries) {
    for (const k of Object.keys(e)) assert.ok(allowed.has(k), `清单里出现了不该有的字段：${k}`)
  }
  assert.ok(!/"value"|"secret"|"cipher"|"plain"/.test(raw), '不能有明文/密文字段：' + raw.slice(0, 200))
})
