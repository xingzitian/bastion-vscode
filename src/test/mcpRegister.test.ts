// MCP 与 VS Code 的接缝：provider 注册、开关、老版本兜底、token 落盘。
//
// 这一层是「一次就能跑」最危险的地方 —— 它只在真实的扩展宿主里执行，
// 单测 HTTP 端点覆盖不到。所以这里用测试桩把 VS Code 那半边假出来：
//   · 老版本 VS Code（没有 lm.registerMcpServerDefinitionProvider）→ 不抛异常、只在日志里说明
//   · 新版本 → provider 注册成功，provideMcpServerDefinitions 交回带 URL/token 的 HTTP 定义
//   · token/端口落盘且重启后不变（外部客户端里粘一次的配置要一直有效）
//   · 关掉开关 → 不启动端点、返回空列表，并通知 VS Code 重新取
import '../testkit/vscode-stub'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import { parse as parseJsonc } from 'jsonc-parser'
import { cfgPath, cleanupTempHome, useTempHome } from '../testkit/env'
import { configValues, fireConfigChange } from '../testkit/vscode-stub'

// 必须在加载被测模块之前把 HOME 指到临时目录：端点信息会写 ~/.bastionshell/mcp.json
const home = useTempHome()
// 用一个固定的高位随机端口：既贴近真实（默认 39311 也是固定端口），又不和开发机上
// 真在跑的 VS Code 抢端口。49152 以上是动态端口区，撞上的概率可以忽略。
const TEST_PORT = 49152 + Math.floor(Math.random() * 15000)
configValues.set('bastion.mcpPort', TEST_PORT)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode') as Record<string, unknown>

const { registerMcp, ensureMcpServer, stopMcp, mcpEndpoint, mcpEnabled, MCP_PROVIDER_ID } =
  require('../mcpRegister') as typeof import('../mcpRegister')

interface Captured {
  id: string
  provider: {
    provideMcpServerDefinitions: () => Promise<unknown[]>
    onDidChangeMcpServerDefinitions?: (cb: () => void) => { dispose(): void }
  }
}

const captured: Captured[] = []

function fakeContext(): { subscriptions: { dispose(): void }[]; extension: { packageJSON: { version: string } } } {
  return { subscriptions: [], extensions: undefined, extension: { packageJSON: { version: '1.2.3' } } } as never
}

// 端点是个真在监听的服务：不收掉测试进程不会退出
after(async () => {
  await stopMcp()
  cleanupTempHome(home)
})

test('老版本 VS Code（没有 MCP API）下注册不抛异常，端点照样能用', async () => {
  registerMcp(fakeContext() as never)
  const h = await ensureMcpServer()
  assert.ok(h, '即使不能自动注册，端点也要能用（外部客户端还要靠它）')
  assert.match(h!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.equal(captured.length, 0, '没有 API 就不该有注册记录')
})

test('新版本 VS Code：provider 注册成功，定义里带着 URL 和 Bearer token', async () => {
  // 把 VS Code 那半边补齐（模拟 1.101+）
  class FakeMcpHttpServerDefinition {
    constructor(
      public label: string,
      public uri: { toString(): string },
      public headers: Record<string, string>,
      public version?: string
    ) {}
  }
  vscode.McpHttpServerDefinition = FakeMcpHttpServerDefinition
  vscode.lm = {
    registerMcpServerDefinitionProvider: (id: string, provider: Captured['provider']) => {
      captured.push({ id, provider })
      return { dispose(): void {} }
    }
  }

  registerMcp(fakeContext() as never)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].id, MCP_PROVIDER_ID)

  const defs = (await captured[0].provider.provideMcpServerDefinitions()) as FakeMcpHttpServerDefinition[]
  assert.equal(defs.length, 1, '开着的状态下应当交回一个 MCP 服务定义')
  assert.equal(defs[0].label, 'BastionShell')
  assert.match(defs[0].uri.toString(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.match(defs[0].headers.Authorization, /^Bearer [0-9a-f]{64}$/)
  assert.equal(defs[0].version, '1.2.3', '版本变了客户端才会提示刷新工具')

  // 定义里的 token 必须就是端点真在用的那个，否则客户端会被 401 挡掉
  const live = mcpEndpoint()!
  assert.equal(defs[0].headers.Authorization, `Bearer ${live.token}`)
  assert.equal(defs[0].uri.toString(), live.url)
})

test('端点信息落盘并能读回：重启后 token 和端口不变（粘一次的配置一直有效）', async () => {
  await stopMcp()
  const h = (await ensureMcpServer())!
  assert.equal(h.port, TEST_PORT, '配置了固定端口就该绑上它')

  const fp = cfgPath(home, 'mcp.json')
  assert.ok(fs.existsSync(fp), '应当写出 ~/.bastionshell/mcp.json')
  const raw = fs.readFileSync(fp, 'utf8')
  const parsed = parseJsonc(raw) as { token?: string; port?: number; actualPort?: number; url?: string }
  assert.equal(parsed.token, h.token, 'token 必须落盘，否则重启后外部客户端里粘的配置就失效了')
  assert.equal(parsed.port, TEST_PORT, '文件里的 port 是「下次要绑的端口」，必须跟设置一致')
  assert.equal(parsed.actualPort, h.port, '实际端口也记下来，排查时用')
  assert.equal(parsed.url, h.url)
  assert.match(raw, /别贴给别人/, '文件里要有「这是一把钥匙」的中文提醒')

  // 模拟 VS Code 重启：重新读文件起端点
  await stopMcp()
  const h2 = (await ensureMcpServer())!
  assert.equal(h2.token, h.token, '重启后 token 变了的话，用户每次都得重配')
  assert.equal(h2.port, h.port, '重启后端口也要一样')
})

test('端口被占时不把随机端口写回文件（否则端口再也不固定了）', async () => {
  await stopMcp() // 先把上一步的端点停掉，再占端口
  // 占住目标端口，模拟「另一个 VS Code 窗口已经起了端点」
  const net = await import('net')
  const squatter = net.createServer()
  await new Promise<void>((r) => squatter.listen(TEST_PORT, '127.0.0.1', () => r()))
  try {
    const h = (await ensureMcpServer())!
    assert.equal(h.portFallback, true, '端口被占应当回退')
    assert.notEqual(h.port, TEST_PORT)

    const raw = fs.readFileSync(cfgPath(home, 'mcp.json'), 'utf8')
    const parsed = parseJsonc(raw) as { port?: number; actualPort?: number }
    assert.equal(parsed.port, TEST_PORT, '文件里的 port 仍要是设置要求的那个')
    assert.equal(parsed.actualPort, h.port, '实际用的是随机端口 → 记进 actualPort')
  } finally {
    await stopMcp()
    await new Promise<void>((r) => squatter.close(() => r()))
  }
})

test('关掉 bastion.mcpEnabled → 不启动端点、provider 交回空列表；改设置会通知 VS Code 重新问', async () => {
  let refires = 0
  captured[0].provider.onDidChangeMcpServerDefinitions?.(() => {
    refires++
  })

  configValues.set('bastion.mcpEnabled', false)
  assert.equal(mcpEnabled(), false)
  await stopMcp()
  assert.equal(await ensureMcpServer(), undefined, '关掉就不该起监听')

  const defs = await captured[0].provider.provideMcpServerDefinitions()
  assert.deepEqual(defs, [], '关掉时不能还告诉 VS Code 有这个服务')

  // 用户在设置里动开关 → 必须通知 VS Code 重新取一遍定义（否则工具列表一直是旧的）
  fireConfigChange('bastion.mcpEnabled')
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(refires >= 1, '改开关没通知 VS Code 的话，工具列表不会变')

  // 打开后又能起来
  configValues.set('bastion.mcpEnabled', true)
  const h = await ensureMcpServer()
  assert.ok(h, '开关切回来应当能重新启动')
})
