// 高危规则的用户覆盖：能关内置、能加自己的、坏配置不连累整体
import '../testkit/vscode-stub'
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import { useTempHome, cleanupTempHome, cfgPath } from '../testkit/env'

const home = useTempHome()
after(() => cleanupTempHome(home))

import { buildDangerRules, findDangerous, isDangerous, BUILTIN_DANGER_RULES } from '../danger'
import { getDangerRules, getDangerOverride, DANGER_RULES_FILE, DANGER_RULES_TEMPLATE } from '../dangerConfig'

const file = cfgPath(home, DANGER_RULES_FILE)
beforeEach(() => {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
})

test('不传覆盖 = 纯内置', () => {
  assert.equal(buildDangerRules().length, BUILTIN_DANGER_RULES.length)
  assert.equal(isDangerous('rm -rf /', buildDangerRules()), true)
})

test('useBuiltin:false = 完全用自己写的（内置一条都不生效）', () => {
  const rules = buildDangerRules({ useBuiltin: false, extra: [{ why: '禁止删库', pattern: '\\bdrop\\s+database\\b' }] })
  assert.equal(rules.length, 1)
  assert.equal(isDangerous('rm -rf /', rules), false, '内置应已关闭')
  assert.equal(isDangerous('DROP DATABASE prod', rules), true, '自定义规则应生效')
})

test('disabled = 关掉指定内置规则（误报时用）', () => {
  const rules = buildDangerRules({ disabled: ['rm-root', 'kill-all'] })
  assert.equal(isDangerous('rm -rf /', rules), false)
  assert.equal(isDangerous('killall5', rules), false)
  assert.equal(isDangerous('reboot', rules), true, '没关的仍然生效')
})

test('extra 追加在末尾，且不区分大小写', () => {
  const rules = buildDangerRules({ extra: [{ id: 'prod-db', why: '禁止直接改生产库', pattern: '\\b(update|delete|drop)\\b' }] })
  assert.equal(rules.length, BUILTIN_DANGER_RULES.length + 1)
  for (const c of ['drop table x', 'DROP DATABASE y', 'Delete from z']) {
    assert.equal(isDangerous(c, rules), true, `应命中：${c}`)
  }
  const hit = findDangerous('drop table x', rules)[0]
  assert.equal(hit.id, 'prod-db')
  assert.equal(hit.why, '禁止直接改生产库', '原因要能显示给人看')
})

test('自定义规则可以不写 id 和 why（自动编号 + 默认原因）', () => {
  const rules = buildDangerRules({ useBuiltin: false, extra: [{ pattern: 'foo' }] })
  assert.equal(rules[0].id, 'custom-1')
  assert.equal(rules[0].why, '自定义高危规则')
})

test('坏正则只跳过它自己，不影响其它规则', () => {
  const rules = buildDangerRules({ extra: [{ pattern: '[' }, { pattern: 'goodword' }] })
  assert.ok(rules.some((r) => r.re.source === 'goodword'))
  assert.equal(isDangerous('goodword', rules), true)
})

test('空 / 缺 pattern 的条目被忽略', () => {
  const rules = buildDangerRules({ useBuiltin: false, extra: [{ pattern: '' }, { pattern: '   ' }, undefined as never] })
  assert.equal(rules.length, 0)
})

test('配置文件不存在时会自动按模板建一份（带中文说明）', () => {
  getDangerOverride()
  assert.equal(fs.existsSync(file), true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /BastionShell 高危命令规则/)
  assert.match(text, /useBuiltin/)
  assert.match(text, /内置规则 id 一览/, '要列出内置 id，用户才知道 disabled 里能写什么')
  for (const id of BUILTIN_DANGER_RULES.map((r) => r.id)) {
    assert.match(text, new RegExp(`\\b${id}\\b`), `说明里应列出内置 id：${id}`)
  }
})

test('模板本身是可用的合法配置', () => {
  const rules = getDangerRules()
  assert.ok(rules.length >= BUILTIN_DANGER_RULES.length, '模板不应关掉任何内置规则')
  // 模板里那个示例规则只匹配 drop database/table，不该影响日常命令
  for (const c of ['ls -l', 'systemctl restart nginx', 'cd /etc']) {
    assert.equal(isDangerous(c, rules), false, `模板不该误报：${c}`)
  }
})

test('端到端：改文件即生效（用户自己就能加规则/关规则）', () => {
  fs.writeFileSync(
    file,
    JSON.stringify(
      { useBuiltin: true, disabled: ['reboot'], extra: [{ id: 'no-rm-tmp', why: '禁止删临时目录', pattern: 'rm\\s+-rf\\s+/tmp' }] },
      null,
      2
    ),
    'utf8'
  )
  const rules = getDangerRules()
  assert.equal(isDangerous('reboot', rules), false, 'disabled 生效')
  assert.equal(isDangerous('rm -rf /tmp', rules), true, 'extra 生效')
  assert.equal(isDangerous('rm -rf /', rules), true, '内置其余仍然生效')
  // 报告里能看到自定义原因
  assert.match(findDangerous('rm -rf /tmp', rules)[0].why, /禁止删临时目录/)
})

test('文件写坏时退回内置（检查高危命令这件事不能因为配置读失败就失效）', () => {
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const rules = getDangerRules()
  assert.equal(isDangerous('rm -rf /', rules), true, '应退回内置而不是「一条规则都没有」')
})

test('模板常量与导出保持一致', () => {
  assert.equal(DANGER_RULES_TEMPLATE.useBuiltin, true)
  assert.ok(Array.isArray(DANGER_RULES_TEMPLATE.extra))
})
