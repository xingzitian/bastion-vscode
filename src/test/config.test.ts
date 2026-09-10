// 配置读写层：JSONC 注释/尾逗号、原子写、损坏备份、扩展名迁移
import '../testkit/vscode-stub'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import { useTempHome, cleanupTempHome, cfgPath } from '../testkit/env'
import { readJsonFile, writeJsonFile, ensureJsonFile, migrateJsonExtension, configFilePath, configDir } from '../config'

const home = useTempHome()
after(() => cleanupTempHome(home))

test('configDir 落在临时 HOME 下（证明没碰真实配置）', () => {
  assert.equal(configDir(), cfgPath(home, '').replace(/[\\/]$/, ''))
  assert.match(configDir(), /bastion-test-/)
})

test('writeJsonFile + readJsonFile 往返', () => {
  writeJsonFile('t-round.jsonc', { a: 1, b: ['x'] }, '// 头部说明')
  assert.deepEqual(readJsonFile<Record<string, unknown>>('t-round.jsonc', {}, (v): v is Record<string, unknown> => !!v), { a: 1, b: ['x'] })
})

test('带中文注释和尾逗号的 JSONC 能读出来（这就是改用 .jsonc 的原因）', () => {
  const fp = configFilePath('t-jsonc.jsonc')
  fs.writeFileSync(fp, '// 中文注释\n{\n  "a": 1, // 行尾注释\n  "b": [1, 2,],\n}\n', 'utf8')
  const got = readJsonFile<Record<string, unknown>>('t-jsonc.jsonc', {}, (v): v is Record<string, unknown> => !!v)
  assert.equal(got.a, 1)
  assert.deepEqual(got.b, [1, 2])
})

test('文件不存在时返回 fallback，不创建文件', () => {
  const got = readJsonFile('t-missing.jsonc', { fallback: true }, (v): v is { fallback: boolean } => !!v)
  assert.deepEqual(got, { fallback: true })
  assert.equal(fs.existsSync(configFilePath('t-missing.jsonc')), false)
})

test('解析失败 → 备份 .bak 并返回 fallback（不静默崩）', () => {
  const fp = configFilePath('t-broken.jsonc')
  fs.writeFileSync(fp, '{ 这不是 JSON', 'utf8')
  const got = readJsonFile('t-broken.jsonc', [], (v): v is unknown[] => Array.isArray(v))
  assert.deepEqual(got, [])
  assert.equal(fs.existsSync(fp + '.bak'), true, '坏文件要留一份 .bak')
  assert.equal(fs.readFileSync(fp + '.bak', 'utf8'), '{ 这不是 JSON', '备份内容要和原文件一致')
})

test('校验不过也算损坏（类型不对）', () => {
  const fp = configFilePath('t-wrongtype.jsonc')
  fs.writeFileSync(fp, '{"not":"an array"}', 'utf8')
  const got = readJsonFile('t-wrongtype.jsonc', [], (v): v is unknown[] => Array.isArray(v))
  assert.deepEqual(got, [])
  assert.equal(fs.existsSync(fp + '.bak'), true)
})

test('写入是原子的：不留 .tmp 残渣', () => {
  writeJsonFile('t-atomic.jsonc', { ok: 1 })
  assert.equal(fs.existsSync(configFilePath('t-atomic.jsonc')), true)
  assert.equal(fs.existsSync(configFilePath('t-atomic.jsonc') + '.tmp'), false, '临时文件必须被 rename 掉')
})

test('头部说明写在 JSON 之前，且能重复读回', () => {
  writeJsonFile('t-header.jsonc', [1, 2], '// 第一行\n// 第二行')
  const raw = fs.readFileSync(configFilePath('t-header.jsonc'), 'utf8')
  assert.match(raw, /^\/\/ 第一行\n\/\/ 第二行\n\[/)
  assert.deepEqual(readJsonFile('t-header.jsonc', [], (v): v is number[] => Array.isArray(v)), [1, 2])
})

test('ensureJsonFile：不存在才建，默认模板是空数组', () => {
  ensureJsonFile('t-ensure.jsonc', '// 说明')
  assert.equal(fs.existsSync(configFilePath('t-ensure.jsonc')), true)
  assert.deepEqual(readJsonFile('t-ensure.jsonc', null, (v): v is unknown[] => Array.isArray(v)), [])
  // 已存在时不能被覆盖
  writeJsonFile('t-ensure.jsonc', [{ keep: true }], '// 说明')
  ensureJsonFile('t-ensure.jsonc', '// 说明')
  assert.deepEqual(readJsonFile('t-ensure.jsonc', [], (v): v is unknown[] => Array.isArray(v)), [{ keep: true }])
})

test('ensureJsonFile：initial 支持对象模板（习惯文件是对象不是数组）', () => {
  ensureJsonFile('t-objtemplate.jsonc', '// 说明', { privilege: 'ask', notes: [] })
  const got = readJsonFile<Record<string, unknown>>('t-objtemplate.jsonc', {}, (v): v is Record<string, unknown> => !!v)
  assert.equal(got.privilege, 'ask')
})

test('migrateJsonExtension：.json → .jsonc 数据保留，旧文件删除', () => {
  writeJsonFile('t-old.json', [{ id: 'legacy' }])
  migrateJsonExtension('t-new.jsonc', 't-old.json', '// 迁移说明')
  assert.equal(fs.existsSync(configFilePath('t-new.jsonc')), true)
  assert.equal(fs.existsSync(configFilePath('t-old.json')), false, '旧文件要删掉')
  assert.deepEqual(readJsonFile('t-new.jsonc', [], (v): v is unknown[] => Array.isArray(v)), [{ id: 'legacy' }])
  assert.match(fs.readFileSync(configFilePath('t-new.jsonc'), 'utf8'), /迁移说明/)
})

test('migrateJsonExtension：目标已存在时不覆盖', () => {
  writeJsonFile('t-new2.jsonc', [{ id: 'current' }], '// 现有的')
  writeJsonFile('t-old2.json', [{ id: 'legacy' }])
  migrateJsonExtension('t-new2.jsonc', 't-old2.json', '// 不该被写入')
  assert.deepEqual(readJsonFile('t-new2.jsonc', [], (v): v is unknown[] => Array.isArray(v)), [{ id: 'current' }])
  assert.equal(fs.existsSync(configFilePath('t-old2.json')), true, '没迁移就不该删旧文件')
})

test('migrateJsonExtension：旧文件解析不了就保留原样，不硬迁移', () => {
  const oldFp = configFilePath('t-old3.json')
  fs.writeFileSync(oldFp, '{ 坏的', 'utf8')
  migrateJsonExtension('t-new3.jsonc', 't-old3.json', '// 说明')
  assert.equal(fs.existsSync(configFilePath('t-new3.jsonc')), false, '不该生成半成品新文件')
  assert.equal(fs.existsSync(oldFp), true, '旧文件必须保留，交给人处理')
})
