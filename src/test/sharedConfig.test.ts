// 「两个客户端读同一份配置」的跨实现测试 —— 转发规则 与 快捷命令 这两份。
//
// 和 profilesShared.test.ts 同一个路子：**用桌面版（Go）实际会写出来的文件内容**，
// 验证扩展侧读得到、而且保存时不抹掉对方字段。桌面版的结构体里没有
// `label`/`profileId`（转发）和 `description`/`sendEnter`/`file`、数组型 `command`（快捷命令），
// 这些都是"容易被整体重写抹掉"的地方。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type * as vscode from 'vscode'
import { getForwardRules, saveForwardRules, FORWARD_FILE } from '../forward'
import { getQuickCommands, saveQuickCommands, QUICK_COMMANDS_FILE } from '../quickCommands'

function ctxStub(): vscode.ExtensionContext {
  return {
    globalState: { get: () => undefined, update: async () => undefined }
  } as unknown as vscode.ExtensionContext
}

function withSharedDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-shared-cfg-'))
  const old = process.env.BASTIONSHELL_SHARED_DIR
  process.env.BASTIONSHELL_SHARED_DIR = dir
  try {
    fn(dir)
  } finally {
    if (old === undefined) delete process.env.BASTIONSHELL_SHARED_DIR
    else process.env.BASTIONSHELL_SHARED_DIR = old
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('扩展能读到桌面版写的转发规则，保存时不抹掉 label/profileId', () => {
  withSharedDir((dir) => {
    // 桌面版写出来的形状（注释头 + 数组，字段名与扩展一致）
    const desktopWritten = `// BastionShell 端口转发规则（**桌面版与 VS Code 扩展共享这一份**）
[
  {
    "id": "r1",
    "profileId": "生产堡垒机",
    "label": "本地 15432 → 库",
    "localHost": "127.0.0.1",
    "localPort": 15432,
    "remoteHost": "10.0.0.5",
    "remotePort": 5432
  }
]
`
    fs.writeFileSync(path.join(dir, FORWARD_FILE), desktopWritten)
    const rules = getForwardRules(ctxStub())
    assert.equal(rules.length, 1, `应该读出 1 条：${JSON.stringify(rules)}`)
    assert.equal(rules[0].profileId, '生产堡垒机', 'profileId 要读到（界面按它分组）')
    assert.equal(rules[0].label, '本地 15432 → 库', 'label 要读到（界面按它显示）')
    assert.equal(rules[0].localPort, 15432)

    // 改一个端口再保存：其它字段不能没
    saveForwardRules(ctxStub(), rules.map((r) => ({ ...r, localPort: 15433 })))
    const text = fs.readFileSync(path.join(dir, FORWARD_FILE), 'utf8')
    assert.match(text, /15433/, '该改的要改到')
    assert.match(text, /生产堡垒机/, 'profileId 不能被抹掉')
    assert.match(text, /本地 15432 → 库/, 'label 不能被抹掉')
  })
})

test('扩展能读到桌面版写的快捷命令，保存时不抹掉 description/sendEnter/数组型 command', () => {
  withSharedDir((dir) => {
    const desktopWritten = `// BastionShell 快捷命令（**桌面版与 VS Code 扩展共享这一份**）
[
  { "id": "q1", "label": "看磁盘", "command": "df -h" },
  { "id": "q2", "label": "多行", "command": ["cd /opt", "./deploy.sh"], "description": "两行", "sendEnter": true }
]
`
    fs.writeFileSync(path.join(dir, QUICK_COMMANDS_FILE), desktopWritten)
    const cmds = getQuickCommands(ctxStub())
    assert.equal(cmds.length, 2, `应该读出 2 条：${JSON.stringify(cmds)}`)
    const q2 = cmds.find((c) => c.id === 'q2')
    assert.ok(q2, '应该读到 q2')
    assert.ok(Array.isArray(q2!.command), '数组型 command 要原样读出来（多行命令）')
    assert.equal(q2!.description, '两行')

    // 保存一遍：桌面版不认识的字段（description/sendEnter）不能被抹掉
    saveQuickCommands(cmds)
    const text = fs.readFileSync(path.join(dir, QUICK_COMMANDS_FILE), 'utf8')
    assert.match(text, /description/, 'description 不能被抹掉')
    assert.match(text, /sendEnter/, 'sendEnter 不能被抹掉')
    assert.match(text, /deploy\.sh/, '数组里的第二行命令不能被抹掉')
  })
})
