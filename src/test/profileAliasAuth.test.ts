// 别名解析 + 「密码被改过之后的出路」的测试。
//
// 这两件事都是维护者实际踩到的：
//   ① 一台机器两个叫法 → 部署任务里写另一个叫法就找不到档案；
//   ② 密码在服务器上改过 → 旧密码自动重试几次后报连接失败，用户没有任何入口去改。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
import { queueWarningResponse, setInputBoxResult, warningMessages } from '../testkit/vscode-stub'
import { isAuthFailure } from '../authError'
import {
  hasSavedPassword,
  getPassphrase,   savePassphrase,   hasSavedPassphrase,   offerPassphraseReset,
  initProfiles,
  offerPasswordReset,
  resolveProfile,
  type ConnectionProfile
} from '../profiles'

function fake(over: Partial<ConnectionProfile>): ConnectionProfile {
  return { name: 'n', host: 'h', port: 22, username: 'u', authMethod: 'password', ...over }
}

const secrets = new Map<string, string>()
const ctx = {
  globalState: { get: () => undefined, update: async () => undefined },
  secrets: {
    get: async (k: string) => secrets.get(k),
    store: async (k: string, v: string) => void secrets.set(k, v),
    delete: async (k: string) => void secrets.delete(k)
  }
} as unknown as vscode.ExtensionContext

// ───────────── ① 别名解析 ─────────────

test('别名：档案名和别名都能指到同一个档案', () => {
  const list = [
    fake({ name: '生产堡垒机', aliases: ['生产', 'prod-bastion'] }),
    fake({ name: '测试机' })
  ]
  assert.equal(resolveProfile(list, '生产堡垒机')?.name, '生产堡垒机', '按名字')
  assert.equal(resolveProfile(list, '生产')?.name, '生产堡垒机', '按别名')
  assert.equal(resolveProfile(list, 'PROD-BASTION')?.name, '生产堡垒机', '别名忽略大小写')
  assert.equal(resolveProfile(list, '  生产  ')?.name, '生产堡垒机', '别名去空格')
  assert.equal(resolveProfile(list, '不存在的机器'), undefined, '找不到就是找不到')
  assert.equal(resolveProfile(list, ''), undefined, '空串不该匹配到任何东西')
  assert.equal(resolveProfile(list, undefined), undefined, 'undefined 也不该炸')
})

test('别名：名字优先于别人的别名（别让别名把真名顶掉）', () => {
  const list = [fake({ name: 'A', aliases: ['B'] }), fake({ name: 'B' })]
  assert.equal(resolveProfile(list, 'B')?.name, 'B', '精确的名字要赢过另一条档案的别名')
})

// ───────────── ② 密码被改过之后的出路 ─────────────

test('认证失败能被认出来（ssh2 那句原文）', () => {
  assert.equal(isAuthFailure(new Error('All configured authentication methods failed')), true)
  assert.equal(isAuthFailure(Object.assign(new Error('x'), { level: 'client-authentication' })), true)
  assert.equal(isAuthFailure(new Error('read ECONNRESET')), false, '断线不是认证失败，别混为一谈')
})

test('钥匙串里有密码才给出路（没有就别乱弹）', async () => {
  initProfiles(ctx)
  secrets.clear()
  assert.equal(await hasSavedPassword(fake({ name: 'p1' })), false)
  secrets.set('bastion.pass.p1', 'old-pw')
  assert.equal(await hasSavedPassword(fake({ name: 'p1' })), true)
})

test('选「重新输入密码」：返回新密码，并写回钥匙串', async () => {
  initProfiles(ctx)
  secrets.set('bastion.pass.p2', 'old-pw')
  queueWarningResponse('重新输入密码')
  setInputBoxResult('new-pw-123')
  const r = await offerPasswordReset(fake({ name: 'p2', username: 'deploy', host: '10.0.0.1' }))
  assert.deepEqual(r, { action: 'retry', password: 'new-pw-123' })
  assert.equal(secrets.get('bastion.pass.p2'), 'new-pw-123', '新密码要存下来，否则下次还是连不上')
  assert.ok(
    warningMessages.some((m) => m.includes('已保存的密码无效')),
    '提示要说清楚是"存下来的密码无效"：' + JSON.stringify(warningMessages)
  )
})

test('选「清除已保存的密码」：钥匙串里那份要被删掉', async () => {
  initProfiles(ctx)
  secrets.set('bastion.pass.p3', 'old-pw')
  queueWarningResponse('清除已保存的密码')
  const r = await offerPasswordReset(fake({ name: 'p3' }))
  assert.deepEqual(r, { action: 'cleared' })
  assert.equal(secrets.has('bastion.pass.p3'), false)
})

test('取消 / 空输入：都不能改动钥匙串（否则会把用户存好的密码弄丢）', async () => {
  initProfiles(ctx)
  secrets.set('bastion.pass.p4', 'old-pw')
  queueWarningResponse(undefined)
  assert.deepEqual(await offerPasswordReset(fake({ name: 'p4' })), { action: 'cancel' })
  assert.equal(secrets.get('bastion.pass.p4'), 'old-pw', '取消不能动它')

  queueWarningResponse('重新输入密码')
  setInputBoxResult('')
  assert.deepEqual(await offerPasswordReset(fake({ name: 'p4' })), { action: 'cancel' }, '空输入等于取消')
  assert.equal(secrets.get('bastion.pass.p4'), 'old-pw', '空输入也不能覆盖掉原密码')
})
// ───────────── ③ 私钥口令也要记住（以前每次都问，AI 连接被卡住）─────────────

test('私钥口令：没存过是 undefined，「存过但不需要口令」是空串 —— 两者必须能区分', async () => {
  initProfiles(ctx)
  secrets.clear()
  assert.equal(await getPassphrase(ctx, 'k1'), undefined, '没存过 → undefined（要问一次）')
  assert.equal(await hasSavedPassphrase(fake({ name: 'k1' })), false)
  await savePassphrase(ctx, 'k1', '')
  assert.equal(await getPassphrase(ctx, 'k1'), '', '存过但是空口令')
  assert.equal(await hasSavedPassphrase(fake({ name: 'k1' })), true, '空口令也算"存过" → 以后不能再问')
  await savePassphrase(ctx, 'k1', 'pp-123')
  assert.equal(await getPassphrase(ctx, 'k1'), 'pp-123')
})

test('口令不对时的出路：重输写回 / 清除 / 取消不动它', async () => {
  initProfiles(ctx)
  secrets.set('bastion.passphrase.k2', 'old-pp')
  queueWarningResponse('重新输入口令')
  setInputBoxResult('new-pp')
  const r = await offerPassphraseReset(fake({ name: 'k2', authMethod: 'key', privateKeyPath: 'C:/k/id_rsa' }))
  assert.deepEqual(r, { action: 'retry', password: 'new-pp' })
  assert.equal(await getPassphrase(ctx, 'k2'), 'new-pp', '新口令要写回钥匙串')

  queueWarningResponse('清除已保存的口令')
  assert.deepEqual(await offerPassphraseReset(fake({ name: 'k2', authMethod: 'key' })), { action: 'cleared' })
  assert.equal(await getPassphrase(ctx, 'k2'), undefined, '清除之后应该回到"没存过"')

  await savePassphrase(ctx, 'k2', 'keep-me')
  queueWarningResponse(undefined)
  assert.deepEqual(await offerPassphraseReset(fake({ name: 'k2', authMethod: 'key' })), { action: 'cancel' })
  assert.equal(await getPassphrase(ctx, 'k2'), 'keep-me', '取消不能动它')
})
