// 「AI 访问」的数据与人话（左侧树 / 右侧总览 / 签发对话框共用）。
//
// 维护者的原话："我都不知道现在令牌还能限制 ai 做什么" —— 所以这一组盯的是
// **每一档权限必须被翻译成人话**，而且主令牌永远要显示出来（不然会误以为"没有令牌=没权限"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAiModel, ownersSummary, scopeDetail, scopeOneLiner, normalizeAiScope, SCOPE_INFO } from '../aiAccess'

test('三档权限都必须能讲清「能做什么 / 不能做什么」', () => {
  for (const s of ['observer', 'operator', 'full'] as const) {
    assert.ok(SCOPE_INFO[s].label.length > 0)
    assert.ok(SCOPE_INFO[s].can.length > 0, `${s} 要写出能做什么`)
  }
  assert.deepEqual(SCOPE_INFO.full.cannot, [], '全权不该有"不能"')
  assert.ok(SCOPE_INFO.observer.cannot.includes('执行命令'), '只读必须明确说不能执行命令')
  assert.ok(SCOPE_INFO.observer.cannot.includes('连新机器'))
  assert.ok(SCOPE_INFO.operator.cannot.some((x) => x.includes('connect') || x.includes('连新机器')), '可写要说清不能连新机器')
})

test('一行总结里同时出现「能」和「不能」（UI 直接显示它）', () => {
  const obs = scopeOneLiner('observer')
  assert.match(obs, /只读/)
  assert.match(obs, /不能/)
  assert.match(obs, /执行命令/)
  const full = scopeOneLiner('full')
  assert.match(full, /全权/)
  assert.doesNotMatch(full, /不能：/)
})

test('未知取值归一化成 observer（宁可少给权限）', () => {
  assert.equal(normalizeAiScope('full'), 'full')
  assert.equal(normalizeAiScope('whatever'), 'observer')
  assert.equal(normalizeAiScope(undefined), 'observer')
})

test('两行详情带换行（树 tooltip 用）', () => {
  const d = scopeDetail('operator')
  assert.match(d, /权限：/)
  assert.match(d, /\n能：/)
  assert.match(d, /\n不能：/)
})

// ───────────── 展示模型 ─────────────

test('★ 没签发过令牌时，主令牌也必须显示（否则用户以为「没令牌=没权限」）', () => {
  const m = buildAiModel({ tokens: [], clients: {}, sessions: [] })
  assert.equal(m.clients.length, 1)
  assert.equal(m.clients[0].isMain, true)
  assert.equal(m.clients[0].scope, 'full', '主令牌是全权 —— 必须让用户看到')
  assert.equal(m.hasCustom, false)
})

test('签发的令牌显示权限档 + 人话 + 掩码（不显示完整 token）', () => {
  const m = buildAiModel({
    tokens: [{ label: 'claude', scope: 'observer', token: 'abcdef0123456789abcdef' }],
    clients: {},
    sessions: []
  })
  const c = m.clients.find((x) => x.clientId === 'claude')!
  assert.equal(c.scopeLabel, '只读')
  assert.match(c.plain, /只能看/)
  assert.match(c.tokenMasked, /^abcd…/)
  assert.ok(!c.tokenMasked.includes('0123456789abcdef'), '不能把完整令牌显示在 UI 上')
  assert.equal(m.hasCustom, true)
})

test('绑定按别名排序，并挂到对应会话上（owners）', () => {
  const m = buildAiModel({
    tokens: [
      { label: 'claude', scope: 'observer', token: 't1' },
      { label: 'trae', scope: 'operator', token: 't2' }
    ],
    clients: {
      default: { label: '默认', sessions: { C: { sessionId: 's-1', name: '#3 deploy@h1' } } },
      claude: { label: 'claude', sessions: { B: { sessionId: 's-1', name: '#3 deploy@h1' }, A: { sessionId: 's-2', name: '#1 deploy@h2' } } }
    },
    sessions: [
      { id: 's-1', name: '#3 deploy@h1' },
      { id: 's-2', name: '#1 deploy@h2' }
    ]
  })
  const claude = m.clients.find((c) => c.clientId === 'claude')!
  assert.deepEqual(claude.bindings.map((b) => b.alias), ['A', 'B'], '别名要排序')
  const s1 = m.sessions.find((s) => s.id === 's-1')!
  assert.equal(s1.owners.length, 2, '同一条会话可以被两个客户端绑着')
  assert.match(ownersSummary(s1), /主令牌/)
  assert.match(ownersSummary(s1), /claude/)
  const s2 = m.sessions.find((s) => s.id === 's-2')!
  assert.equal(ownersSummary(s2), 'A（claude）')
  assert.equal(m.hasBindings, true)
})

test('绑定指向的会话已经没了 → 不崩，owner 不出现', () => {
  const m = buildAiModel({
    tokens: [{ label: 'x', scope: 'observer', token: 't' }],
    clients: { x: { label: 'x', sessions: { A: { sessionId: 's-dead', name: 'old' } } } },
    sessions: []
  })
  assert.equal(m.sessions.length, 0)
  assert.equal(m.clients.find((c) => c.clientId === 'x')!.bindings.length, 1, '绑定还在（会话列表里看不到而已）')
})

test('没有绑定时 hasBindings = false', () => {
  const m = buildAiModel({ tokens: [], clients: { default: { label: '默认', sessions: {} } }, sessions: [{ id: 's-1', name: 'x' }] })
  assert.equal(m.hasBindings, false)
  assert.equal(m.sessions[0].owners.length, 0)
})
