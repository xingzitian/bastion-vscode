// 部署任务：模板带中文说明、读写兼容 .json/.jsonc、迁移不丢数据
import '../testkit/vscode-stub'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import type * as vscode from 'vscode'
import { useTempHome, cleanupTempHome } from '../testkit/env'

const home = useTempHome()
after(() => cleanupTempHome(home))

import {
  listDeployTasks,
  createDeployTask,
  migrateTaskFiles,
  readDeployTaskByUri,
  normalizeCommands,
  DEPLOY_TASK_HEADER,
  DEPLOY_TASK_TEMPLATE,
  TASK_EXT
} from '../deploy'

test('命令字段：数组写法（推荐，像 docker compose 一行一个）', () => {
  assert.deepEqual(normalizeCommands(['cd /etc', 'ls -l']), ['cd /etc', 'ls -l'])
})

test('命令字段：字符串写法也支持（按行拆）', () => {
  assert.deepEqual(normalizeCommands('cd /etc\nls -l'), ['cd /etc', 'ls -l'])
  assert.deepEqual(normalizeCommands('sudo -i\r\ncd /etc'), ['sudo -i', 'cd /etc'])
})

test('命令字段：两种写法可以混用（数组元素自带换行也会拆开）', () => {
  assert.deepEqual(normalizeCommands(['cd /etc\nls -l', 'echo done']), ['cd /etc', 'ls -l', 'echo done'])
})

test('命令字段：空值 / 非法值都归一成空数组', () => {
  assert.deepEqual(normalizeCommands(''), [])
  assert.deepEqual(normalizeCommands([]), [])
  assert.deepEqual(normalizeCommands(undefined), [])
  assert.deepEqual(normalizeCommands(123), [])
  assert.deepEqual(normalizeCommands(['  ', '\t']), [])
  assert.deepEqual(normalizeCommands(['ok', 5, null]), ['ok'], '非字符串元素被跳过')
})

test('命令字段：去首尾空白、去空行（缩进写的脚本也能跑）', () => {
  assert.deepEqual(normalizeCommands(['  cd /etc  ', '', '  ls -l']), ['cd /etc', 'ls -l'])
})

test('读任务文件时两种写法都能解析出来', () => {
  resetTasksDir()
  fs.writeFileSync(
    path.join(tasksDir, 'arr.jsonc'),
    JSON.stringify({ name: 'A', profile: 'p', hosts: ['h'], preCommand: ['sudo -i', 'cd /etc'], script: ['echo hi'] }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(tasksDir, 'str.jsonc'),
    JSON.stringify({ name: 'B', profile: 'p', hosts: ['h'], preCommand: 'sudo -i\ncd /etc', script: 'echo hi' }),
    'utf8'
  )
  const tasks = listDeployTasks(ctxStub())
  const a = tasks.find((t) => t.name === 'A')!
  const b = tasks.find((t) => t.name === 'B')!
  assert.deepEqual(a.preCommand, ['sudo -i', 'cd /etc'])
  assert.deepEqual(a.script, ['echo hi'])
  assert.deepEqual(b.preCommand, ['sudo -i', 'cd /etc'], '字符串写法应得到完全一样的结果')
  assert.deepEqual(b.script, ['echo hi'])
})

test('新建任务模板用数组写法（照着加行就行，不用写 \\n）', () => {
  resetTasksDir()
  const uri = createDeployTask(ctxStub())
  assert.equal(DEPLOY_TASK_TEMPLATE.preCommand.includes('cd /tmp'), true)
  const task = readDeployTaskByUri(uri)!
  assert.deepEqual(task.preCommand, ['cd /tmp'], '模板解析出来的应是数组')
  assert.deepEqual(task.script, [], '脚本默认留空数组，加行就行')
})

test('说明头里写清了数组写法和逐行执行（用户不至于不知道多条语句怎么加）', () => {
  assert.match(DEPLOY_TASK_HEADER, /推荐数组写法/)
  assert.match(DEPLOY_TASK_HEADER, /\["sudo -i", "cd \/etc"\]/)
  assert.match(DEPLOY_TASK_HEADER, /逐行执行/)
})

/** 任务目录在 globalStorageUri 下，用临时目录模拟 */
const storage = path.join(home, 'globalStorage')
const tasksDir = path.join(storage, 'tasks')
function ctxStub(): vscode.ExtensionContext {
  return { globalStorageUri: { fsPath: storage } } as unknown as vscode.ExtensionContext
}
function resetTasksDir(): void {
  fs.rmSync(tasksDir, { recursive: true, force: true })
  fs.mkdirSync(tasksDir, { recursive: true })
}

test('新建任务：写 .jsonc、带中文说明头、且能解析回任务', () => {
  resetTasksDir()
  const uri = createDeployTask(ctxStub(), '生产')
  assert.ok(uri.fsPath.endsWith(TASK_EXT), `应是 ${TASK_EXT} 结尾`)
  const text = fs.readFileSync(uri.fsPath, 'utf8')
  assert.match(text, /BastionShell 部署任务/, '要有中文说明头')
  assert.match(text, /userChoice/, '要说明 userChoice')
  assert.match(text, /不需要选用户/, '要说明留空=不选用户')
  const parsed = readDeployTaskByUri(uri)
  assert.ok(parsed, '说明头 + JSON 体应能被解析')
  assert.equal(parsed!.profileId, '生产')
  assert.equal(parsed!.userChoice, '1')
})

test('新建任务：说明头是注释，不会污染 JSON 解析', () => {
  resetTasksDir()
  const uri = createDeployTask(ctxStub())
  const files = listDeployTasks(ctxStub())
  assert.equal(files.length, 1)
  assert.equal(files[0].uri.fsPath, uri.fsPath)
})

test('任务目录里同时有 .json 和 .jsonc 时都能列出来', () => {
  resetTasksDir()
  createDeployTask(ctxStub()) // .jsonc
  fs.writeFileSync(
    path.join(tasksDir, 'legacy.json'),
    JSON.stringify({ name: '老任务', profile: '国内', hosts: ['10.0.0.9'] }),
    'utf8'
  )
  const tasks = listDeployTasks(ctxStub())
  assert.equal(tasks.length, 2)
  const names = tasks.map((t) => t.name).sort()
  assert.deepEqual(names, ['新任务', '老任务'].sort(), '两种扩展名的任务都要能列出来')
  // 顺便确认 id 推导：.json 的 id 不该带后缀
  assert.deepEqual(tasks.map((t) => t.id).sort(), ['legacy', tasks.find((t) => t.name === '新任务')!.id].sort())
})

test('path id 推导：两种扩展名都要能去掉', () => {
  resetTasksDir()
  fs.writeFileSync(path.join(tasksDir, 'a.json'), JSON.stringify({ name: 'A', profile: 'p', hosts: [] }), 'utf8')
  fs.writeFileSync(path.join(tasksDir, 'b.jsonc'), JSON.stringify({ name: 'B', profile: 'p', hosts: [] }), 'utf8')
  const ids = listDeployTasks(ctxStub()).map((t) => t.id).sort()
  assert.deepEqual(ids, ['a', 'b'], 'id 不能带着 .json/.jsonc 后缀')
})

test('迁移：.json → 带说明的 .jsonc，内容完整保留，旧文件删除', () => {
  resetTasksDir()
  const original = {
    name: '部署 myapp',
    profile: '生产',
    hosts: ['10.0.0.10'],
    uploads: ['D:/work/myapp.yaml'],
    preCommand: 'sudo -i',
    script: 'systemctl restart myapp',
    userChoice: '2'
  }
  fs.writeFileSync(path.join(tasksDir, 'task-old.json'), JSON.stringify(original, null, 2), 'utf8')

  migrateTaskFiles(ctxStub())

  assert.equal(fs.existsSync(path.join(tasksDir, 'task-old.json')), false, '旧文件应被删除')
  const newPath = path.join(tasksDir, `task-old${TASK_EXT}`)
  assert.equal(fs.existsSync(newPath), true, '新文件应存在')
  assert.match(fs.readFileSync(newPath, 'utf8'), /BastionShell 部署任务/, '新文件要带说明头')

  const t = listDeployTasks(ctxStub())
  assert.equal(t.length, 1)
  // 命令字段现在归一成「一行一条」的数组 —— 迁移后每行的内容必须一字不差
  assert.deepEqual(
    [t[0].name, t[0].profileId, t[0].hosts, t[0].uploads, t[0].preCommand, t[0].script, t[0].userChoice],
    [original.name, original.profile, original.hosts, original.uploads, ['sudo -i'], ['systemctl restart myapp'], original.userChoice],
    '字段内容都要保留（命令按行拆成数组）'
  )
})

test('迁移：解析不过的旧文件原地保留，不生成半成品', () => {
  resetTasksDir()
  fs.writeFileSync(path.join(tasksDir, 'broken.json'), '{ 这不是 JSON', 'utf8')
  migrateTaskFiles(ctxStub())
  assert.equal(fs.existsSync(path.join(tasksDir, 'broken.json')), true, '坏的旧文件必须留着给人处理')
  assert.equal(fs.existsSync(path.join(tasksDir, `broken${TASK_EXT}`)), false, '不该生成坏的新文件')
})

test('迁移：已有同名 .jsonc 时不覆盖、也不删旧文件', () => {
  resetTasksDir()
  fs.writeFileSync(path.join(tasksDir, 'dup.json'), JSON.stringify({ name: '旧的', profile: 'p', hosts: [] }), 'utf8')
  fs.writeFileSync(path.join(tasksDir, `dup${TASK_EXT}`), JSON.stringify({ name: '新的', profile: 'p', hosts: [] }), 'utf8')
  migrateTaskFiles(ctxStub())
  assert.equal(fs.existsSync(path.join(tasksDir, 'dup.json')), true, '不该删旧文件（新文件已存在，什么都没做）')
  const names = listDeployTasks(ctxStub()).map((t) => t.name).sort()
  assert.deepEqual(names, ['新的', '旧的'])
})

test('迁移是幂等的：跑两次结果一样', () => {
  resetTasksDir()
  fs.writeFileSync(path.join(tasksDir, 'twice.json'), JSON.stringify({ name: 'T', profile: 'p', hosts: ['h'] }), 'utf8')
  migrateTaskFiles(ctxStub())
  migrateTaskFiles(ctxStub())
  const t = listDeployTasks(ctxStub())
  assert.equal(t.length, 1, '不该重复生成')
  assert.equal(t[0].name, 'T')
})

test('迁移：旧任务里的字段写错类型时，按老规则回退默认值', () => {
  resetTasksDir()
  fs.writeFileSync(
    path.join(tasksDir, 'weird.json'),
    JSON.stringify({ name: 'W', profile: 'p', hosts: ['h'], userChoice: 123, uploads: 'not-array' }),
    'utf8'
  )
  migrateTaskFiles(ctxStub())
  const t = listDeployTasks(ctxStub())[0]
  assert.equal(t.userChoice, '1', '非字符串 userChoice 回退默认 1')
  assert.deepEqual(t.uploads, [], '非数组 uploads 回退空数组')
})

test('迁移保留 userChoice 的空字符串（= 不选用户）', () => {
  resetTasksDir()
  fs.writeFileSync(
    path.join(tasksDir, 'nouser.json'),
    JSON.stringify({ name: 'N', profile: 'p', hosts: ['h'], userChoice: '' }),
    'utf8'
  )
  migrateTaskFiles(ctxStub())
  assert.equal(listDeployTasks(ctxStub())[0].userChoice, '', '空串是有意义的配置，不能被默认值顶掉')
})

test('模板常量本身健康', () => {
  assert.ok(DEPLOY_TASK_HEADER.includes('//'), '说明头必须是注释')
  assert.ok(DEPLOY_TASK_TEMPLATE.name, '模板要有 name')
  assert.equal(DEPLOY_TASK_TEMPLATE.userChoice, '1')
  assert.ok(Array.isArray(DEPLOY_TASK_TEMPLATE.hosts))
})
