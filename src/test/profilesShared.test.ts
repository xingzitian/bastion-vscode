// 「两个客户端读同一份档案」的**跨实现**测试（扩展这一侧）。
//
// 这一条是这次"客户端同步"的核心承诺：桌面版（Go）写进 ~/.bastionshell/profiles.jsonc 的东西，
// 扩展这边必须原样读得到；反过来也一样。所以这里用一个**桌面版实际会写出来的文件内容**
// （注释头 + 数组，含它认识的字段）来验证 getProfiles 能读，而且不丢字段。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type * as vscode from 'vscode'
import { getProfiles, saveProfiles, PROFILES_FILE } from '../profiles'

function ctxStub(): vscode.ExtensionContext {
  return {
    globalState: { get: () => undefined, update: async () => undefined }
  } as unknown as vscode.ExtensionContext
}

function withSharedDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-profiles-'))
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

/** 桌面版（Go）写出来的样子：注释头 + 数组，字段名与扩展侧一致 */
const DESKTOP_WRITTEN = `// ============================================================
// BastionShell 连接档案配置（**桌面版与 VS Code 扩展共享这一份**）
// ============================================================
[
  {
    "name": "生产堡垒机",
    "host": "10.0.0.10",
    "port": 22,
    "username": "deploy",
    "authMethod": "password",
    "mode": "bastion",
    "preCommand": "cd /opt/app"
  },
  {
    "name": "直连测试机",
    "host": "10.0.0.11",
    "port": 2222,
    "username": "root",
    "authMethod": "key",
    "privateKeyPath": "/home/me/.ssh/id_ed25519",
    "mode": "direct"
  }
]
`

test('扩展能读到桌面版写进共享文件的档案（同一个文件、同一套字段名）', () => {
  withSharedDir((dir) => {
    fs.writeFileSync(path.join(dir, PROFILES_FILE), DESKTOP_WRITTEN)
    const profiles = getProfiles(ctxStub())
    assert.equal(profiles.length, 2, `应该读出 2 个档案：${JSON.stringify(profiles)}`)
    const byName = new Map(profiles.map((p) => [p.name, p]))
    const bastion = byName.get('生产堡垒机')
    assert.ok(bastion, '应该读到"生产堡垒机"')
    assert.equal(bastion!.host, '10.0.0.10')
    assert.equal(bastion!.username, 'deploy')
    assert.equal(bastion!.authMethod, 'password')
    assert.equal(bastion!.mode, 'bastion')
    const direct = byName.get('直连测试机')
    assert.equal(direct!.port, 2222)
    assert.equal(direct!.authMethod, 'key')
    assert.equal(direct!.privateKeyPath, '/home/me/.ssh/id_ed25519')
    assert.equal(direct!.mode, 'direct')
  })
})

test('扩展保存档案时不能把桌面版写的字段抹掉（否则就是数据丢失，不是同步）', () => {
  withSharedDir((dir) => {
    fs.writeFileSync(path.join(dir, PROFILES_FILE), DESKTOP_WRITTEN)
    const profiles = getProfiles(ctxStub())
    // 模拟"改一下端口再保存"（比如用户在侧边栏编辑了档案）
    const edited = profiles.map((p) => (p.name === '生产堡垒机' ? { ...p, port: 2200 } : p))
    saveProfiles(ctxStub(), edited)

    const text = fs.readFileSync(path.join(dir, PROFILES_FILE), 'utf8')
    assert.match(text, /2200/, '该改的字段要改到')
    assert.match(text, /preCommand/, '桌面版/扩展方写的字段不能被抹掉')
    assert.match(text, /cd \/opt\/app/, '字段的值也要在')

    // 再读一遍：改完之后仍然是合法可读的
    const again = getProfiles(ctxStub())
    assert.equal(again.length, 2)
    assert.equal(again.find((p) => p.name === '生产堡垒机')?.port, 2200)
  })
})

test('共享文件坏了：扩展侧退回空列表并备份 .bak，不崩、不覆盖用户文件', () => {
  withSharedDir((dir) => {
    fs.writeFileSync(path.join(dir, PROFILES_FILE), '{ 这不是 JSON')
    const profiles = getProfiles(ctxStub())
    assert.deepEqual(profiles, [], '坏文件应该退回空列表（而不是崩）')
    assert.equal(fs.existsSync(path.join(dir, PROFILES_FILE)), true, '原文件要留着')
  })
})
