// 快捷命令：三种写法解析、坏条目隔离、模板生成
import '../testkit/vscode-stub'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { useTempHome, cleanupTempHome, cfgPath } from '../testkit/env'
import { setWorkspaceFolder } from '../testkit/vscode-stub'

const home = useTempHome()
after(() => cleanupTempHome(home))

import {
  getQuickCommands,
  resolveQuickCommand,
  quickCommandPreview,
  ensureQuickCommandsFile,
  QuickCommandItem,
  QUICK_COMMANDS_FILE,
  type QuickCommand
} from '../quickCommands'

/** getQuickCommands 需要 ExtensionContext，实际只用到 globalState。
 *  这里用 `import type`（编译期擦除），所以不会真的去 require('vscode')。 */
import type * as vscode from 'vscode'

function ctxStub(): vscode.ExtensionContext {
  return {
    globalState: { get: () => undefined, update: async () => undefined }
  } as unknown as vscode.ExtensionContext
}

test('首次打开会生成带中文说明和示例的模板', () => {
  const fp = cfgPath(home, QUICK_COMMANDS_FILE)
  assert.equal(fs.existsSync(fp), false)
  ensureQuickCommandsFile()
  assert.equal(fs.existsSync(fp), true)
  const text = fs.readFileSync(fp, 'utf8')
  assert.match(text, /BastionShell 快捷命令/)
  assert.match(text, /一行一个/, '要说明数组写法')
  assert.match(text, /\.sh 文件/, '要说明外部文件写法')
  const seeded = JSON.parse(text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  assert.equal(seeded.length, 3, '模板含三个示例')
})

test('写法一：字符串命令原样返回', () => {
  assert.equal(resolveQuickCommand({ id: 'a', label: 'a', command: 'df -h' }), 'df -h')
})

test('写法二：数组按行拼接（不用写 \\n）', () => {
  assert.equal(
    resolveQuickCommand({ id: 'b', label: 'b', command: ['cd /etc', 'ls -l', 'echo done'] }),
    'cd /etc\nls -l\necho done'
  )
})

test('写法三：外部 .sh 文件（绝对路径）读文件内容', () => {
  const sh = path.join(home, 'restart.sh')
  fs.writeFileSync(sh, '#!/bin/sh\necho restarting\n')
  assert.equal(resolveQuickCommand({ id: 'c', label: 'c', file: sh }), '#!/bin/sh\necho restarting\n')
})

test('file 优先于 command（同时存在时用文件）', () => {
  const sh = path.join(home, 'prio.sh')
  fs.writeFileSync(sh, 'from-file\n')
  const text = resolveQuickCommand({ id: 'c', label: 'c', file: sh, command: 'from-inline' })
  assert.equal(text, 'from-file\n')
  assert.doesNotMatch(text, /from-inline/)
})

test('外部文件相对路径按工作区根解析', () => {
  fs.writeFileSync(path.join(home, 'rel.sh'), 'echo rel\n')
  setWorkspaceFolder(home)
  assert.equal(resolveQuickCommand({ id: 'd', label: 'd', file: 'rel.sh' }), 'echo rel\n')
  setWorkspaceFolder(undefined)
})

test('没有工作区时用相对路径要报错说明白', () => {
  setWorkspaceFolder(undefined)
  assert.throws(() => resolveQuickCommand({ id: 'd', label: '缺工作区', file: 'rel.sh' }), /没有打开工作区/)
})

test('引用的文件不存在时报错要带标签和路径（不能静默不发）', () => {
  const missing = path.join(home, 'nope.sh')
  assert.throws(() => resolveQuickCommand({ id: 'e', label: '缺文件', file: missing }), (err: Error) => {
    assert.match(err.message, /缺文件/, '要带命令标签')
    assert.match(err.message, /nope\.sh/, '要带具体路径')
    return true
  })
})

test('坏条目只跳过自己，不连累整份文件', () => {
  const fp = cfgPath(home, QUICK_COMMANDS_FILE)
  fs.writeFileSync(fp, '[\n  {"id":"ok","label":"好的","command":"ls"},\n  {"id":123,"label":"坏的"}\n]')
  const cmds = getQuickCommands(ctxStub())
  assert.equal(cmds.length, 1, '好的留下、坏的跳过')
  assert.equal(cmds[0].label, '好的')
  assert.equal(fs.existsSync(fp + '.bak'), false, '不该把整份当损坏备份掉')
  assert.match(fs.readFileSync(fp, 'utf8'), /"id":123/, '原文件不应被改写')
})

test('缺 command 和 file 的条目也算合法（先占位后填写）', () => {
  const fp = cfgPath(home, QUICK_COMMANDS_FILE)
  fs.writeFileSync(fp, '[{"id":"a","label":"占位"}]')
  assert.equal(getQuickCommands(ctxStub()).length, 1)
  assert.equal(resolveQuickCommand({ id: 'a', label: '占位' }), '', '解析结果为空串，由调用方提示')
})

test('预览文本：数组用分号连、文件显示 basename', () => {
  assert.equal(quickCommandPreview({ id: 'a', label: 'a', command: 'df -h' }), 'df -h')
  assert.equal(quickCommandPreview({ id: 'a', label: 'a', command: ['a', 'b'] }), 'a ; b')
  assert.equal(quickCommandPreview({ id: 'a', label: 'a', file: 'D:/x/y/restart.sh' }), 'file:restart.sh')
})

test('树节点：文件类用 file-code 图标并标出来源', () => {
  const it = new QuickCommandItem({ id: 'a', label: '脚本', file: 'D:/x/restart.sh' })
  assert.equal((it.iconPath as { id: string }).id, 'file-code')
  assert.match((it.tooltip as { value: string }).value, /D:\/x\/restart\.sh/)
})

test('树节点：sendEnter:false 要在 tooltip 里说明不自动回车', () => {
  const it = new QuickCommandItem({ id: 'b', label: '不回车', command: 'ls', sendEnter: false })
  assert.match((it.tooltip as { value: string }).value, /不自动回车/)
  const it2 = new QuickCommandItem({ id: 'c', label: '默认', command: 'ls' } as QuickCommand)
  assert.doesNotMatch((it2.tooltip as { value: string }).value, /不自动回车/)
})
