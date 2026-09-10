// 个人习惯：提权方式继承、追加（保注释）、坏字段容错
import '../testkit/vscode-stub'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import { useTempHome, cleanupTempHome, cfgPath } from '../testkit/env'

const home = useTempHome()
after(() => cleanupTempHome(home))

import { getHabits, resolvePrivilege, resolveWorkdir, appendHabit, setPrivilege, setWorkdir, habitsForAI, isPrivilegeMode, HABITS_FILE } from '../habits'

test('首次读取会自动按模板建文件（带中文说明）', () => {
  const h = getHabits()
  assert.deepEqual(h.notes, [])
  const fp = cfgPath(home, HABITS_FILE)
  assert.equal(fs.existsSync(fp), true)
  assert.match(fs.readFileSync(fp, 'utf8'), /BastionShell 个人习惯/)
})

test('没有任何记录时默认 ask（= 先问用户一次）', () => {
  assert.equal(resolvePrivilege(getHabits(), '生产'), 'ask')
})

test('档案级设置覆盖全局', () => {
  assert.equal(setPrivilege('生产', 'sudo'), true)
  assert.equal(resolvePrivilege(getHabits(), '生产'), 'sudo')
  assert.equal(resolvePrivilege(getHabits(), '别的档案'), 'ask', '别的档案继承全局')
  assert.equal(resolvePrivilege(getHabits(), ''), 'ask', '空档案名视为全局')
  assert.equal(resolvePrivilege(getHabits(), undefined), 'ask')
})

test('installPrivilege 校验只认四个合法值', () => {
  for (const ok of ['none', 'sudo', 'sudo-i', 'ask']) assert.equal(isPrivilegeMode(ok), true, ok)
  for (const bad of ['SUDO', 'sudo -i', '', 123, null, undefined, {}]) assert.equal(isPrivilegeMode(bad), false, String(bad))
})

test('appendHabit 追加成功、自动去重', () => {
  assert.equal(appendHabit('生产', 'deploy 的 sudo 免密'), true)
  assert.equal(appendHabit('生产', 'deploy 的 sudo 免密'), false, '重复条目应跳过')
  assert.deepEqual(getHabits().profiles?.['生产']?.notes, ['deploy 的 sudo 免密'])
})

test('appendHabit 写全局（不传档案名）', () => {
  assert.equal(appendHabit(undefined, '改配置前先备份到 /tmp/bak'), true)
  assert.deepEqual(getHabits().notes, ['改配置前先备份到 /tmp/bak'])
})

test('appendHabit 空字符串不写入', () => {
  assert.equal(appendHabit('生产', '   '), false)
})

test('手写中文注释不会被写入操作冲掉', () => {
  const fp = cfgPath(home, HABITS_FILE)
  const before = fs.readFileSync(fp, 'utf8')
  fs.writeFileSync(fp, before.replace('"notes"', '// 我手写的注释\n  "notes"'))
  assert.equal(appendHabit('生产', '日志都在 /data/logs'), true)
  const after = fs.readFileSync(fp, 'utf8')
  assert.match(after, /我手写的注释/, '手写注释必须保留')
  assert.match(after, /BastionShell 个人习惯/, '文件头说明也必须保留')
  assert.deepEqual(getHabits().profiles?.['生产']?.notes, ['deploy 的 sudo 免密', '日志都在 /data/logs'])
})

test('setWorkdir 生效并支持档案级覆盖', () => {
  assert.equal(setWorkdir('生产', '/data/app'), true)
  assert.equal(resolveWorkdir(getHabits(), '生产'), '/data/app')
  assert.equal(resolveWorkdir(getHabits(), '别的档案'), '', '全局没设就是空')
})

test('坏字段只忽略自己，不把整份文件当损坏', () => {
  const fp = cfgPath(home, HABITS_FILE)
  fs.writeFileSync(fp, '{\n  "privilege": "胡说八道",\n  "profiles": { "生产": { "privilege": "sudo", "notes": ["ok"] } }\n}')
  const h = getHabits()
  assert.equal(h.privilege, undefined, '非法 privilege 被忽略')
  assert.equal(resolvePrivilege(h, '生产'), 'sudo', '合法档案照常生效')
  assert.equal(fs.existsSync(fp + '.bak'), false, '不应生成 .bak')
})

test('habitsForAI 输出包含关键信息', () => {
  // 注意：前面的用例会重写配置文件，所以这里先把状态摆好，不依赖执行顺序
  setPrivilege('生产', 'sudo')
  appendHabit('生产', 'deploy 的 sudo 免密')
  // 先把「写进去了没有」和「拼出来的文本对不对」分开断言 ——
  // 否则写文件偶发失败时，报错会指向格式（误导排错方向）
  const h = getHabits()
  assert.equal(resolvePrivilege(h, '生产'), 'sudo', '前置：提权习惯应当已写入')
  assert.ok(
    (h.profiles?.['生产']?.notes ?? []).includes('deploy 的 sudo 免密'),
    '前置：这条习惯应当已写入'
  )
  const text = habitsForAI('生产')
  assert.match(text, /提权习惯/)
  assert.match(text, /sudo <命令>/)
  assert.match(text, /个人习惯/)
  assert.match(text, /deploy 的 sudo 免密/)
})

test('habitsForAI 对没记录的档案给出「先问一次再记」的指引', () => {
  const text = habitsForAI('从没配过的档案')
  assert.match(text, /ask/)
  assert.match(text, /bastion_habits/)
})
