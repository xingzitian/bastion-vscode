// 激活冒烟测试：不开 VS Code，也要能证明 `activate()` 跑得通、命令都注册上。
//
// 它抓的是"接线错误"这一类（搬家后最容易出现、单测又看不到）：
//   - activate 里引用了已经搬走/改名的模块（装载期就炸）
//   - 注册了不存在的命令 / 少了订阅
//   - 初始化顺序错，某个 API 在 vscode 上不存在（真机才会崩的那种）
//
// 边界：它**不验证**任何 vscode 行为（终端、树、webview 都只是 no-op 假实现）。
// 真正的交互仍然只能上真机点。

import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configValues, registeredCommands } from '../testkit/vscode-stub'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as vscode from 'vscode'

/**
 * 假 context。
 *
 * ⚠️ 路径必须是**真实存在且可写**的：activate 会往 globalStorageUri 里 mkdir（任务/日志目录）。
 * 之前这里写死 `/fake/storage`，Windows 下等价于 `C:\fake\storage`（管理员能建），
 * 而 Linux CI 上就是根目录 `/fake/storage` → `EACCES: mkdir`，CI 直接红。
 * 教训：测试里的"假路径"要跨平台 —— 一律用 os.tmpdir()。
 */
function fakeContext(storageDir: string): vscode.ExtensionContext {
  const state = new Map<string, unknown>()
  // extensionUri 指仓库根：activate 可能会读仓库里的真实资源（文档/图标）
  const extRoot = path.resolve(__dirname, '..', '..')
  const uri = (fsPath: string): { fsPath: string; path: string; scheme: string; toString(): string } => ({
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath.replace(/\\/g, '/')}`
  })
  return {
    subscriptions: [],
    extensionUri: uri(extRoot),
    extensionPath: extRoot,
    globalStorageUri: uri(storageDir),
    storageUri: uri(storageDir),
    globalState: {
      get: (k: string, d?: unknown) => (state.has(k) ? state.get(k) : d),
      update: async (k: string, v: unknown) => {
        state.set(k, v)
      },
      keys: () => [...state.keys()]
    },
    workspaceState: {
      get: (_k: string, d?: unknown) => d,
      update: async () => undefined,
      keys: () => []
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: () => ({ dispose(): void {} })
    },
    environmentVariableCollection: {},
    extensionMode: 3,
    logUri: uri(path.join(storageDir, 'log')),
    asAbsolutePath: (p: string) => path.join(extRoot, p)
  } as unknown as vscode.ExtensionContext
}

test('★ activate() 不抛错，并注册了全部命令（搬家后的接线冒烟）', async () => {
  const ext = (await import('../extension')) as unknown as {
    activate: (ctx: vscode.ExtensionContext) => Promise<unknown>
  }
  assert.equal(typeof ext.activate, 'function')

  // 关键：别真的起 MCP 端点 —— 它会监听端口、挂定时器，测试进程永远不退出。
  // 冒烟测试验的是"接线"，不是网络。
  configValues.set('bastion.mcpEnabled', false)
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-activate-'))
  const ctx = fakeContext(storageDir)
  // activate 不抛错就是通过（它本来就不要求返回对外 API）
  await ext.activate(ctx)

  // 命令注册：包里有 66 条 contributes.commands，activate 至少要注册绝大多数
  assert.ok(
    registeredCommands.length >= 50,
    `注册的命令太少（${registeredCommands.length}），可能有命令在搬家后丢了`
  )
  // 抽查几个关键命令存在
  for (const id of ['bastion.connect', 'bastion.exec', 'bastion.showActions', 'bastion.selfTest', 'bastion.showMcpInfo']) {
    assert.ok(registeredCommands.includes(id), `缺少命令 ${id}`)
  }
  // 订阅都挂到了 context 上（否则重载时资源不释放）
  assert.ok(ctx.subscriptions.length > 0, 'context.subscriptions 是空的 —— dispose 会漏')

  // 收尾：让 activate 里挂的定时器/监听退掉，否则 node --test 会挂住
  const anyExt = ext as unknown as { deactivate?: () => unknown }
  if (typeof anyExt.deactivate === 'function') await anyExt.deactivate()
  fs.rmSync(storageDir, { recursive: true, force: true })
})
