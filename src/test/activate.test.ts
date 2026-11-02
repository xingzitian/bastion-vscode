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
import type * as vscode from 'vscode'

function fakeContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>()
  return {
    subscriptions: [],
    extensionUri: { fsPath: '/fake/ext', path: '/fake/ext', scheme: 'file', toString: () => 'file:///fake/ext' },
    extensionPath: '/fake/ext',
    globalStorageUri: { fsPath: '/fake/storage', path: '/fake/storage', scheme: 'file' },
    storageUri: { fsPath: '/fake/ws', path: '/fake/ws', scheme: 'file' },
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
    logUri: { fsPath: '/fake/log', path: '/fake/log', scheme: 'file' },
    asAbsolutePath: (p: string) => `/fake/ext/${p}`
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
  const ctx = fakeContext()
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
})
