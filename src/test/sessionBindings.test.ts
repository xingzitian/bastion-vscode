// 会话解析与绑定（docs/session-identity.md）的单元测试。
//
// 这一组盯的是"**命令绝不能落到错的机器上**"：解析必须精确、歧义必须拒绝、
// 写操作没有绑定必须拒绝（以前会静默回退到"当前活动窗口"）。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  bindSession,
  bindingsOf,
  cleanupBindings,
  describeBindings,
  loadBindings,
  normalizeClientId,
  ownerClients,
  resolveSessionRef,
  saveBindings,
  unbind,
  type ClientBindings,
  type SessionRef
} from '../sessionBindings'

const S1: SessionRef = { id: 's-7f3a', name: '#3 deploy@10.0.0.1', no: 3, state: 'shell', cursor: 0 }
const S2: SessionRef = { id: 's-9c21', name: '#1 deploy@10.0.0.2', no: 1, state: 'shell', cursor: 0 }
const S3: SessionRef = { id: 's-1111', name: '#7 deploy@10.0.0.10', no: 7, state: 'menu', cursor: 0 }
const LIST = [S1, S2, S3]

const noBinding: ClientBindings = { label: 'default', updatedAt: '', sessions: {} }
function withBindings(entries: Record<string, SessionRef>): ClientBindings {
  const sessions: Record<string, { sessionId: string; name: string; since: string }> = {}
  for (const [alias, ref] of Object.entries(entries)) sessions[alias] = { sessionId: ref.id, name: ref.name, since: '' }
  return { label: 'default', updatedAt: '', sessions }
}

// ───────────────── ① 解析：精确优先、歧义拒绝 ─────────────────

test('按会话 id 精确命中（首选）', () => {
  const r = resolveSessionRef(LIST, 's-7f3a', { mode: 'write', client: noBinding })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.ref.id, 's-7f3a')
})

test('按完整终端名精确命中（含 #N 前缀）', () => {
  const r = resolveSessionRef(LIST, '#1 deploy@10.0.0.2', { mode: 'write', client: noBinding })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.ref.id, 's-9c21')
})

test('按别名命中（别名只属于持有它的客户端）', () => {
  const client = withBindings({ B: S2 })
  const r = resolveSessionRef(LIST, 'b', { mode: 'write', client })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.ref.id, 's-9c21', '别名应大小写不敏感')
})

test('★ 片段命中多条 → 拒绝并列候选（绝不取第一个）', () => {
  // 注意 S3 的主机是 10.0.0.10：以前 includes 会命中它，把命令发到另一台机器上
  const r = resolveSessionRef(LIST, 'deploy@10.0.0.1', { mode: 'write', client: noBinding })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.message, /匹配到 2 条会话/)
    assert.match(r.message, /s-7f3a/)
    assert.match(r.message, /s-1111/)
    assert.match(r.message, /请用 session id 指定/)
  }
})

test('片段唯一命中 → 允许（方便人/模型用简短名字）', () => {
  const r = resolveSessionRef(LIST, '10.0.0.2', { mode: 'write', client: noBinding })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.ref.id, 's-9c21')
})

test('完全找不到 → 拒绝并列出当前会话', () => {
  const r = resolveSessionRef(LIST, '不存在的机器', { mode: 'write', client: noBinding })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.message, /找不到会话/)
    assert.match(r.message, /当前有/)
  }
})

// ───────────────── ② 没传会话：绑定决定，写操作 fail-closed ─────────────────

test('只有一条绑定 → 没传会话时用它（方便）', () => {
  const r = resolveSessionRef(LIST, undefined, { mode: 'write', client: withBindings({ A: S1 }) })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.ref.id, 's-7f3a')
    assert.equal(r.via, 'binding')
  }
})

test('★ 写操作没有任何绑定 → 拒绝（不许回退到活动终端）', () => {
  const r = resolveSessionRef(LIST, undefined, { mode: 'write', client: noBinding })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.message, /还没有绑定任何会话/)
    assert.match(r.message, /bastion_use/)
  }
})

test('★ 绑定多于一条 → 拒绝，并要求指定（两台机器场景的关键）', () => {
  const client = withBindings({ A: S1, B: S2 })
  const r = resolveSessionRef(LIST, undefined, { mode: 'write', client })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.message, /绑定了 2 条会话/)
    assert.match(r.message, /A=s-7f3a/)
    assert.match(r.message, /B=s-9c21/)
    assert.match(r.message, /不会替你猜/)
  }
})

test('读操作没有绑定 → 允许回退，但标明 via=fallback', () => {
  const r = resolveSessionRef(LIST, undefined, { mode: 'read', client: noBinding, fallback: S2 })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.ref.id, 's-9c21')
    assert.equal(r.via, 'fallback')
  }
})

test('绑定指向的会话已经没了 → 明确报"绑定已失效"', () => {
  const r = resolveSessionRef(LIST, undefined, { mode: 'write', client: withBindings({ A: { ...S1, id: 's-dead' } }) })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /已经不在了/)
})

// ───────────────── ③ 绑定本身 ─────────────────

test('自动别名 A → B；同一条会话重复绑定是幂等的', () => {
  const f = loadBindings()
  const a = bindSession(f, 'c1', S1)
  assert.ok(!('error' in a) && a.alias === 'A')
  const b = bindSession(f, 'c1', S2)
  assert.ok(!('error' in b) && b.alias === 'B')
  const again = bindSession(f, 'c1', S1)
  assert.ok(!('error' in again) && again.alias === 'A' && again.existing === true)
})

test('别名冲突 / 非法别名 → 拒绝并说明', () => {
  const f = loadBindings()
  bindSession(f, 'c2', S1)
  const conflict = bindSession(f, 'c2', S2, 'A')
  assert.ok('error' in conflict)
  if ('error' in conflict) assert.match(conflict.error, /已经指向/)
  const bad = bindSession(f, 'c2', S2, '别名 带空格')
  assert.ok('error' in bad)
})

test('不同客户端的绑定互不干扰（你的 A 不是我的 A）', () => {
  const f = loadBindings()
  bindSession(f, 'claude', S1)
  bindSession(f, 'trae', S2)
  assert.equal(bindingsOf(f, 'claude').sessions.A.sessionId, 's-7f3a')
  assert.equal(bindingsOf(f, 'trae').sessions.A.sessionId, 's-9c21')
  assert.deepEqual(ownerClients(f, 's-7f3a'), ['claude'])
  assert.deepEqual(ownerClients(f, 's-9c21'), ['trae'])
})

test('解绑：按别名或 sessionId 都能摘掉', () => {
  const f = loadBindings()
  bindSession(f, 'c3', S1)
  assert.equal(unbind(f, 'c3', { alias: 'a' }), true, '别名大小写不敏感')
  assert.equal(unbind(f, 'c3', { sessionId: 's-9c21' }), false, '没绑过就返回 false')
})

test('清理：会话没了 / 超过 12 小时的绑定会被丢弃', () => {
  const f = loadBindings()
  bindSession(f, 'c4', S1)
  bindSession(f, 'c4', S2)
  f.clients.c4.sessions.B.since = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString()
  const changed = cleanupBindings(f, [S1.id]) // S2 已经不在了；B 也超时
  assert.equal(changed, true)
  assert.deepEqual(Object.keys(f.clients.c4.sessions), ['A'])
})

test('clientId 归一化：空 → default；非法字符替换；超长截断', () => {
  assert.equal(normalizeClientId(undefined), 'default')
  assert.equal(normalizeClientId('  '), 'default')
  assert.equal(normalizeClientId('claude desktop'), 'claude_desktop')
  assert.equal(normalizeClientId('x'.repeat(100)).length, 32)
})

test('绑定文件：真的落盘、能读回来（用临时共享目录，不碰真实配置）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-bindings-'))
  const old = process.env.BASTIONSHELL_SHARED_DIR
  process.env.BASTIONSHELL_SHARED_DIR = dir
  try {
    const f = loadBindings()
    bindSession(f, 'claude', S1)
    saveBindings(f)
    assert.equal(fs.existsSync(path.join(dir, 'mcp-bindings.json')), true, '应该写到共享目录里')
    const reloaded = loadBindings()
    assert.equal(reloaded.clients.claude.sessions.A.sessionId, 's-7f3a')
    assert.match(describeBindings(reloaded, 'claude'), /A=s-7f3a/)
    assert.match(describeBindings(reloaded, 'nobody'), /还没有绑定/)
  } finally {
    if (old === undefined) delete process.env.BASTIONSHELL_SHARED_DIR
    else process.env.BASTIONSHELL_SHARED_DIR = old
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('别名命名：26 个字母用完之后接着 AA/AB（上限抬到 32 也不撞名）', async () => {
  const { aliasName } = await import('../sessionBindings')
  assert.equal(aliasName(0), 'A')
  assert.equal(aliasName(7), 'H')
  assert.equal(aliasName(25), 'Z')
  assert.equal(aliasName(26), 'AA')
  assert.equal(aliasName(27), 'AB')
  assert.equal(aliasName(31), 'AF')
})

test('★ 绑定上限 32：第 9 条不再撞墙（以前只有 A..H 8 个）', async () => {
  const { bindSession } = await import('../sessionBindings')
  const f = { version: 1, clients: {} } as unknown as Parameters<typeof bindSession>[0]
  const seen: string[] = []
  for (let i = 0; i < 32; i++) {
    const r = bindSession(f, 'default', { id: 'sid-' + i, name: '#i h' + i, no: i, state: 'shell', cursor: 0 }, undefined)
    assert.ok('alias' in r, `第 ${i + 1} 条应该绑定成功：${JSON.stringify(r)}`)
    seen.push((r as { alias: string }).alias)
  }
  assert.equal(seen[0], 'A')
  assert.equal(seen[7], 'H')
  assert.equal(seen[8], 'I', '第 9 条应该是 I —— 这正是原来会失败的地方')
  assert.equal(seen[25], 'Z')
  assert.equal(seen[26], 'AA')
  assert.equal(seen[31], 'AF')
  const over = bindSession(f, 'default', { id: 'sid-32', name: '#32 h32', no: 32, state: 'shell', cursor: 0 }, undefined)
  assert.ok('error' in over)
  assert.match((over as { error: string }).error, /32/)
})