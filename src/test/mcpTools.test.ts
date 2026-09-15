// MCP 工具层：定义与分发。
//
// 这里有一条**契约测试**是刻意加的：MCP 工具名必须和 package.json 里
// `languageModelTools` 的名字**完全一致**。两条路各起一个名字的话，文档、
// 提示词、用户心智都会分叉，所以用测试钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_INSTRUCTIONS, MCP_TOOL_DEFS, UnknownToolError, createToolDispatch, type McpSessionApi } from '../mcpTools'
import { toMcpTool } from '../mcpServer'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as {
  contributes: { languageModelTools: { name: string }[] }
}

function fakeApi(over: Partial<McpSessionApi> = {}): McpSessionApi {
  return {
    listSessions: async () => '当前堡垒机会话（2 个）：\n- deploy@10.0.0.1\n- deploy@10.0.0.2',
    listProfiles: async () => '可用的连接档案（1 个）：\n- 生产（deploy@10.0.0.10:22，堡垒机，提权习惯=sudo）',
    exec: async () => 'hello from remote',
    connect: async (i) => `已连接到目标 ${i.host}`,
    habits: async () => '当前个人习惯（全局）：\n- 提权方式：ask',
    health: async () => '端点自检：正常',
    tail: async () => '屏幕：\n[deploy@h ~]$ ',
    push: async () => '已上传 a.txt',
    pull: async () => '已下载 b.txt',
    ...over
  }
}

test('MCP 工具包含全部语言模型工具，名字不许分叉（MCP 可以多出只在 MCP 侧有意义的东西）', () => {
  const lmNames = pkg.contributes.languageModelTools.map((t) => t.name).sort()
  const mcpNames = MCP_TOOL_DEFS.map((t) => t.name).sort()
  for (const n of lmNames) {
    assert.ok(mcpNames.includes(n), `语言模型工具有 ${n}，MCP 侧也必须一模一样地有（不许改名）`)
  }
  // MCP 侧多出来的只有端点自检这类「只在 MCP 侧才有意义」的工具
  const extra = mcpNames.filter((n) => !lmNames.includes(n))
  assert.deepEqual(extra, ['bastion_health'], '多出来的工具必须是刻意加的，不能是随手写的')
})

test('工具定义齐全：名字唯一、有说明、有 inputSchema、只读标记正确', () => {
  assert.equal(MCP_TOOL_DEFS.length, 9)

  const names = MCP_TOOL_DEFS.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, '工具名不能重复')

  for (const t of MCP_TOOL_DEFS) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, `工具名要符合 MCP 规范：${t.name}`)
    assert.ok(t.title.length > 0, `${t.name} 缺 title`)
    // 说明是给模型看的：太短的说明等于没说清楚什么时候用
    assert.ok(t.description.length > 40, `${t.name} 的说明太短（模型会不知道怎么用）`)
    assert.equal((t.inputSchema as { type?: string }).type, 'object', `${t.name} 的 inputSchema 必须是 object`)
  }

  const readOnly = MCP_TOOL_DEFS.filter((t) => t.readOnly).map((t) => t.name)
  assert.deepEqual(readOnly, ['bastion_listSessions', 'bastion_health', 'bastion_tail', 'bastion_listProfiles'])
})

test('有副作用的工具没被标成只读（标错＝客户端不再弹确认）', () => {
  for (const name of ['bastion_exec', 'bastion_connect', 'bastion_habits', 'bastion_push', 'bastion_pull']) {
    const def = MCP_TOOL_DEFS.find((t) => t.name === name)!
    assert.equal(def.readOnly, false, `${name} 有副作用，不能标只读`)
  }
})

test('tools/list 的形状：annotations.readOnlyHint 跟着 readOnly 走', () => {
  const listed = MCP_TOOL_DEFS.map((d) => toMcpTool(d) as { name: string; annotations: { readOnlyHint: boolean } })
  for (const t of listed) {
    const def = MCP_TOOL_DEFS.find((d) => d.name === t.name)!
    assert.equal(t.annotations.readOnlyHint, def.readOnly)
  }
  assert.equal(listed.find((t) => t.name === 'bastion_listSessions')!.annotations.readOnlyHint, true)
  assert.equal(listed.find((t) => t.name === 'bastion_exec')!.annotations.readOnlyHint, false)
})

test('exec 的 schema 要求 command 必填', () => {
  const exec = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_exec')!
  const schema = exec.inputSchema as { required?: string[]; properties: Record<string, unknown> }
  assert.deepEqual(schema.required, ['command'])
  assert.ok(schema.properties.terminal, '多会话时要用 terminal 指定目标')
})

test('分发：只读工具直接回 api 结果', async () => {
  const dispatch = createToolDispatch(fakeApi())
  const r = await dispatch('bastion_listSessions', {})
  assert.equal(r.text.includes('deploy@10.0.0.1'), true)
  assert.equal(r.isError, undefined)
})

test('分发：未知工具抛 UnknownToolError（HTTP 层翻成 -32602）', async () => {
  const dispatch = createToolDispatch(fakeApi())
  await assert.rejects(() => dispatch('bastion_rm_rf', {}), (e: unknown) => e instanceof UnknownToolError)
})

test('分发：高危命令的拒绝是**正常文本**，不是 isError（和语言模型工具那条路一致）', async () => {
  // 真实实现（aiSessionApi.execChecked）拦下高危命令时返回一段说明文字，
  // 而不是抛错 —— 语言模型工具那条路也是这么返回的。两条路必须一致：
  // 标成 isError 会让客户端把它显示成「工具坏了」，模型可能转而去试别的写法。
  const dispatch = createToolDispatch(
    fakeApi({ exec: async () => '⚠️ 该命令包含高危操作，已被 BastionShell 拦截，不会执行。' })
  )
  const r = await dispatch('bastion_exec', { command: 'rm -rf /' })
  assert.equal(r.isError, undefined)
  assert.match(r.text, /拦截/)
})

test('分发：exec 缺 command 给的是「看得懂的错误」而不是抛异常', async () => {
  const dispatch = createToolDispatch(fakeApi())
  const r = await dispatch('bastion_exec', {})
  assert.equal(r.isError, true)
  assert.match(r.text, /需要 command/)
})

test('分发：exec 把 command 和 terminal 原样传给 api', async () => {
  let seen: { command?: string; terminal?: string } | undefined
  const dispatch = createToolDispatch(
    fakeApi({
      exec: async (i) => {
        seen = i
        return 'ok'
      }
    })
  )
  await dispatch('bastion_exec', { command: 'df -h', terminal: 'deploy@10.0.0.1' })
  assert.deepEqual(seen, { command: 'df -h', terminal: 'deploy@10.0.0.1' })
})

test('分发：connect 缺 profile 也是可读错误', async () => {
  const dispatch = createToolDispatch(fakeApi())
  const r = await dispatch('bastion_connect', { host: '10.0.0.1' })
  assert.equal(r.isError, true)
  assert.match(r.text, /需要 profile/)
})

test('分发：habits 缺 action 时按 read 处理（模型常忘传）', async () => {
  let action: string | undefined
  const dispatch = createToolDispatch(
    fakeApi({
      habits: async (i) => {
        action = i.action
        return '习惯'
      }
    })
  )
  const r = await dispatch('bastion_habits', {})
  assert.equal(action, 'read')
  assert.equal(r.text, '习惯')
})

test('分发：connect 把 assetId 原样传给能力层（一个 IP 多条资产靠它选）', async () => {
  let seen: { profile?: string; host?: string; userChoice?: string; assetId?: string } | undefined
  const dispatch = createToolDispatch(
    fakeApi({
      connect: async (i) => {
        seen = i
        return '已连接'
      }
    })
  )
  await dispatch('bastion_connect', { profile: '生产', host: '10.0.0.1', userChoice: '2', assetId: '2' })
  assert.deepEqual(seen, { profile: '生产', host: '10.0.0.1', userChoice: '2', assetId: '2' })

  // 不传就是 undefined（决策层据此去问人，而不是瞎猜一条）
  await dispatch('bastion_connect', { profile: '生产', host: '10.0.0.1' })
  assert.equal(seen!.assetId, undefined)
})

test('bastion_connect 的 schema 里有 assetId，并在说明里讲清「不要猜」', () => {
  const def = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_connect')!
  const schema = def.inputSchema as { properties: Record<string, unknown> }
  assert.ok(schema.properties.assetId, '模型要能看到这个参数')
  assert.match(def.description, /assetId/)
  assert.match(def.description, /不要猜|不要猜/)
})

test('自检工具：AI 遇到「调用出错」时有地方可问（而不是放弃去让用户手工敲命令）', async () => {
  let called = 0
  const dispatch = createToolDispatch(
    fakeApi({
      health: async () => {
        called++
        return 'BastionShell MCP 端点自检\n- 端点：http://127.0.0.1:39311/mcp'
      }
    })
  )
  const r = await dispatch('bastion_health', {})
  assert.equal(called, 1)
  assert.match(r.text, /端点自检/)
  assert.equal(r.isError, undefined, '自检本身不该报错')
})

test('自检工具的说明里写了「先重试、再自检、最后让用户重启」这条自救路径', () => {
  const health = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_health')!
  assert.equal(health.readOnly, true, '只读 → 客户端不会弹确认，AI 才敢在出错后调它')
  assert.match(health.description, /先调它|先调/)
  assert.match(health.description, /重试/)
  assert.match(health.description, /MCP: List Servers/)
  assert.match(health.description, /不要因为一次工具调用失败就让用户手工/)

  // 服务器说明里也要有这条路径（AI 在 initialize 就能读到）
  assert.match(MCP_INSTRUCTIONS, /原样重试一次/)
  assert.match(MCP_INSTRUCTIONS, /bastion_health/)
  assert.match(MCP_INSTRUCTIONS, /MCP: List Servers/)
})


test('分发：tail / push / pull 的参数原样传到能力层', async () => {
  const seen: Record<string, unknown> = {}
  const dispatch = createToolDispatch(
    fakeApi({
      tail: async (i) => {
        seen.tail = i
        return '屏幕'
      },
      push: async (i) => {
        seen.push = i
        return '已上传'
      },
      pull: async (i) => {
        seen.pull = i
        return '已下载'
      }
    })
  )
  await dispatch('bastion_tail', { terminal: 'deploy@10.0.0.1', lines: 20 })
  await dispatch('bastion_push', { localPath: 'D:/a.txt', remoteDir: '/opt/app' })
  await dispatch('bastion_pull', { remotePath: '/var/log/x.log' })
  assert.deepEqual(seen.tail, { terminal: 'deploy@10.0.0.1', lines: 20 })
  assert.deepEqual(seen.push, { localPath: 'D:/a.txt', remoteDir: '/opt/app', terminal: undefined })
  assert.deepEqual(seen.pull, { remotePath: '/var/log/x.log', localDir: undefined, terminal: undefined })
})

test('分发：push / pull 缺关键参数时给可读错误，而不是抛异常', async () => {
  const dispatch = createToolDispatch(fakeApi())
  const p = await dispatch('bastion_push', {})
  assert.equal(p.isError, true)
  assert.match(p.text, /需要 localPath/)
  const q = await dispatch('bastion_pull', {})
  assert.equal(q.isError, true)
  assert.match(q.text, /需要 remotePath/)
})

test('写习惯的时机规则必须写在说明里（第一次观察到先别写、2~3 次再记、不符立刻改）', () => {
  const habits = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_habits')!
  assert.match(habits.description, /第一次/)
  assert.match(habits.description, /先别写/)
  assert.match(habits.description, /2~3 次/)
  assert.match(habits.description, /立刻更正/)
  assert.match(habits.description, /错误记忆比没有记忆更糟/)

  const exec = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_exec')!
  assert.match(exec.description, /第一次/)
  assert.match(MCP_INSTRUCTIONS, /2~3 次/)
})
