/**
 * 把 MCP 服务接进 VS Code。
 *
 * 三件事：
 *   1. 启动一个只监听 127.0.0.1 的 MCP 端点（token 鉴权，见 `mcpServer.ts`）；
 *   2. 通过 `contributes.mcpServerDefinitionProviders` + `lm.registerMcpServerDefinitionProvider`
 *      把它**注册给 VS Code** —— 用户装完扩展就能在 Copilot（agent 模式）里直接用，
 *      不用手写任何 JSON。这是本扩展相对「纯 MCP 服务器」的结构性优势：
 *      我们已经有市场安装和自动更新，MCP 的配置门槛就被抹平了。
 *   3. 给一条 `BastionShell: 查看 MCP 端点` 命令：把 URL/token 和各种客户端要的
 *      配置片段**直接复制出来**，这样即使不用 VS Code 的注册（CodeBuddy / Trae /
 *      Cline 那种外部客户端），用户也能自己接上。
 *
 * 端点信息（token + 端口）持久化在 `~/.bastionshell/mcp.json`：
 * 端口固定、token 固定，用户粘一次配置就一直有效（VS Code 关掉端点就没了，
 * 下次启动还是同一对 —— 不然每次重启都要重配，等于不可用）。
 */

import * as fs from 'fs'
import * as vscode from 'vscode'
import { configFilePath, readJsonFile, writeJsonFile } from './config'
import { log } from './log'
import { sessionApi } from './aiSessionApi'
import { MCP_TOOL_DEFS } from './mcpTools'
import { newMcpToken, startMcpHttpServer, toMcpTool, type McpHttpHandle } from './mcpServer'
import { setMcpEndpointInfo } from './state'

/** 必须和 package.json 里 `contributes.mcpServerDefinitionProviders[0].id` 一致 */
export const MCP_PROVIDER_ID = 'bastion'

export const MCP_STATE_FILE = 'mcp.json'
export const MCP_DEFAULT_PORT = 39311

interface McpState {
  /** 访问令牌（持久，重启不变） */
  token: string
  /** **配置里要求的**端口（设置 bastion.mcpPort；也是下次启动要绑的端口） */
  port: number
  /** 这次实际绑上的端口（端口被占回退时会和上面不同）；纯诊断 + 给人看 */
  actualPort?: number
  /** 这次实际可用的端点地址 */
  url?: string
  updatedAt?: string
}

const MCP_STATE_HEADER = [
  '// BastionShell 的 MCP 端点信息（自动生成，一般不用手改）',
  '//',
  '// 这个文件给两件事用：',
  '//   1. 让 token 在 VS Code 重启后保持不变 —— 这样你在别的 AI 客户端',
  '//      （CodeBuddy / Trae / Cline 等）里粘一次的 MCP 配置一直有效；',
  '//   2. 出问题时能直接看到 token 和实际端口（401 / 连不上时排查用）。',
  '//',
  '// port       = 设置 bastion.mcpPort 里要求的端口（下次启动就绑它）',
  '// actualPort = 这次实际绑上的端口。**端口被占用时会和 port 不同**，',
  '//              那就以 actualPort / url 为准（日志里也会说明）。',
  '//',
  '// ⚠️ token 等于「能在你的堡垒机会话里执行命令」的钥匙，别贴给别人。',
  '//    想换一把：删掉本文件，下次启动会重新生成。'
].join('\n')

let handle: McpHttpHandle | undefined
let starting: Promise<McpHttpHandle | undefined> | undefined
let changeEmitter: vscode.EventEmitter<void> | undefined
let lastError = ''
/** serverInfo.version：用扩展自己的版本（工具变了版本必然也变，客户端会提示刷新工具） */
let serverVersion = '0.0.0'

function cfg<T>(key: string, fallback: T): T {
  const v = vscode.workspace.getConfiguration('bastion').get<T>(key)
  return v === undefined || v === null ? fallback : v
}

export function mcpEnabled(): boolean {
  return cfg<boolean>('mcpEnabled', true)
}

function readState(): McpState | undefined {
  return readJsonFile<McpState | undefined>(MCP_STATE_FILE, undefined, (v): v is McpState => {
    if (!v || typeof v !== 'object') return false
    const o = v as Record<string, unknown>
    return typeof o.token === 'string' && o.token.length >= 16 && typeof o.port === 'number'
  })
}

function writeState(state: McpState): void {
  try {
    writeJsonFile(MCP_STATE_FILE, state, MCP_STATE_HEADER)
    // 这文件里有 token：类 Unix 上是 0600，Windows 上 chmod 基本无意义但无害
    try {
      fs.chmodSync(configFilePath(MCP_STATE_FILE), 0o600)
    } catch {
      /* ignore */
    }
  } catch (e) {
    log(`写入 MCP 状态文件失败（不影响使用，只是重启后 token 会变）: ${(e as Error).message}`)
  }
}

/**
 * 读已有的 token（没有就生成一份并落盘）。
 *
 * ⚠️ 端口**只认设置里的值**，不认文件里上次实际绑的那个：否则「端口被占 → 回退到
 * 随机端口」会被写回文件，下次启动又拿这个随机端口当目标端口 —— 端口就再也不固定了
 * （这条是测试抓出来的）。文件里的 `actualPort` 只是给人看/排查用的。
 */
export function loadOrCreateState(): McpState {
  const wantPort = cfg<number>('mcpPort', MCP_DEFAULT_PORT)
  const existing = readState()
  const token = existing?.token && existing.token.length >= 16 ? existing.token : newMcpToken()
  if (!existing || existing.token !== token || existing.port !== wantPort) {
    writeState({ token, port: wantPort, updatedAt: new Date().toISOString() })
  }
  return { token, port: wantPort }
}

/**
 * 保证端点在跑（幂等）。失败不抛给调用方 —— 返回 undefined，并把原因记在日志里。
 * MCP 服务起不来不该影响堡垒机本身的任何功能。
 */
export async function ensureMcpServer(): Promise<McpHttpHandle | undefined> {
  if (handle) return handle
  if (starting) return starting
  if (!mcpEnabled()) return undefined

  starting = (async () => {
    try {
      const state = loadOrCreateState()
      const h = await startMcpHttpServer({
        api: sessionApi,
        token: state.token,
        port: state.port,
        serverName: 'bastionshell',
        serverVersion,
        log: (m) => log(m)
      })
      handle = h
      lastError = ''
      setMcpEndpointInfo({ url: h.url, port: h.port, portFallback: h.portFallback, version: serverVersion })
      log(
        `MCP 端点已启动：${h.url}（工具 ${MCP_TOOL_DEFS.length} 个` +
          (h.portFallback ? `；端口 ${state.port} 被占，已退到随机端口` : '') +
          '）'
      )
      // 把「这次实际绑上的端口/地址」也记进文件，方便排查；端口本身下次仍按设置来
      writeState({
        token: h.token,
        port: state.port,
        actualPort: h.port,
        url: h.url,
        updatedAt: new Date().toISOString()
      })
      // ⚠️ 端口回退过就必须让 VS Code **重新问一次**：它手里缓存的是上一次的 URL，
      // 不刷新的话工具调用会打到错的端口（表现为「工具出错 / 连不上」）。
      if (h.portFallback) changeEmitter?.fire()
      return h
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      log(`MCP 端点启动失败：${lastError}`)
      return undefined
    } finally {
      starting = undefined
    }
  })()
  return starting
}

export async function stopMcp(): Promise<void> {
  const h = handle
  handle = undefined
  setMcpEndpointInfo(undefined)
  if (!h) return
  try {
    await h.close()
    log('MCP 端点已停止')
  } catch (e) {
    log(`MCP 端点停止出错：${(e as Error).message}`)
  }
}

/** 当前端点（没起来时返回 undefined） */
export function mcpEndpoint(): { url: string; token: string; port: number } | undefined {
  return handle ? { url: handle.url, token: handle.token, port: handle.port } : undefined
}

export function mcpLastError(): string {
  return lastError
}

function vsCodeConfigSnippet(url: string, token: string): string {
  return JSON.stringify(
    { servers: { bastion: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2
  )
}

function otherClientSnippet(url: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { bastion: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2
  )
}

async function copy(text: string, what: string): Promise<void> {
  await vscode.env.clipboard.writeText(text)
  vscode.window.setStatusBarMessage(`$(clippy) 已复制${what}`, 3000)
}

/** 命令：查看 / 复制 MCP 端点信息 */
export async function showMcpInfo(): Promise<void> {
  if (!mcpEnabled()) {
    const pick = await vscode.window.showWarningMessage(
      'BastionShell 的 MCP 端点当前是关闭的（设置 bastion.mcpEnabled）。',
      '打开设置并启用'
    )
    if (pick) {
      await vscode.workspace.getConfiguration('bastion').update('mcpEnabled', true, vscode.ConfigurationTarget.Global)
      changeEmitter?.fire()
    }
    return
  }

  const h = await ensureMcpServer()
  if (!h) {
    const pick = await vscode.window.showErrorMessage(
      `MCP 端点没起来：${lastError || '未知原因'}（详见「输出 → BastionShell」）`,
      '打开日志'
    )
    if (pick) void vscode.commands.executeCommand('bastion.showLog')
    return
  }

  const tools = MCP_TOOL_DEFS.map((d) => d.name).join('、')
  const items: (vscode.QuickPickItem & { act: () => Promise<void> | void })[] = [
    {
      label: '$(clippy) 复制端点 URL 和 token',
      description: h.url,
      act: () => copy(`${h.url}\n${h.token}`, '端点 URL 和 token')
    },
    {
      label: '$(clippy) 复制 VS Code 手动配置',
      description: '.vscode/mcp.json 或用户 mcp.json 里的 servers 段',
      detail: 'VS Code 已经自动注册了，这一条是备用：想在别的窗口/别的机器上手配时用',
      act: () => copy(vsCodeConfigSnippet(h.url, h.token), 'VS Code 配置片段')
    },
    {
      label: '$(clippy) 复制其它 AI 客户端的配置',
      description: 'CodeBuddy / Trae / Cline / Claude Code 等（mcpServers 段，HTTP 传输）',
      detail: '粘一次就一直有效（端口和 token 固定）；前提是本机 VS Code 开着、扩展已激活',
      act: () => copy(otherClientSnippet(h.url, h.token), '其它客户端配置片段')
    },
    {
      label: '$(list-unordered) 查看已注册的工具',
      description: `${MCP_TOOL_DEFS.length} 个：${tools}`,
      act: () => {
        void vscode.window.showInformationMessage(
          `BastionShell MCP 工具（${MCP_TOOL_DEFS.length} 个）：\n` + MCP_TOOL_DEFS.map((d) => `• ${d.name}${d.readOnly ? '（只读）' : ''}`).join('\n'),
          { modal: true }
        )
      }
    },
    {
      label: '$(output) 打开日志',
      description: '端点地址、请求错误都记在这里',
      act: () => void vscode.commands.executeCommand('bastion.showLog')
    }
  ]

  const picked = await vscode.window.showQuickPick(items, {
    title: `BastionShell MCP 端点（${h.url}）`,
    placeHolder: `状态：运行中 · 端口 ${h.port} · ${MCP_TOOL_DEFS.length} 个工具`
  })
  if (picked) await picked.act()
}

/**
 * 在 activate() 里调用：启动端点 + 注册 provider + 注册命令。
 *
 * 注册 provider 必须是激活时同步完成的（VS Code 的约定），所以这里只做注册，
 * 真正启动 HTTP 监听放在 `provideMcpServerDefinitions` / 命令行里做。
 */
export function registerMcp(context: vscode.ExtensionContext): void {
  changeEmitter = new vscode.EventEmitter<void>()
  serverVersion = (context.extension?.packageJSON?.version as string) ?? '0.0.0'

  // 注意：命令本身统一在 extension.ts 里注册（那边是唯一的「装配」处，
  // manifest 测试也据此对账「清单里的命令都真的注册了」）。这里只负责
  // provider、监听和启动。

  // 设置里改了开关/端口 → 让 VS Code 重新问一遍，并（必要时）停掉端点
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('bastion.mcpEnabled') && !e.affectsConfiguration('bastion.mcpPort')) return
      changeEmitter?.fire()
      if (!mcpEnabled()) void stopMcp()
      else void ensureMcpServer()
    })
  )

  // 端点随扩展激活就起来：这样外部客户端（CodeBuddy / Trae）不必等你在 VS Code 里发一次提问
  if (mcpEnabled()) {
    void ensureMcpServer().then(() => {
      // 起来之后主动让 VS Code 重新取一次定义：扩展重载（比如刚装完新版本）后，
      // 客户端手里那张定义可能是上一轮的 URL —— 不刷新就会表现成「工具调用出错」。
      changeEmitter?.fire()
    })
  }

  // 老版本 VS Code：这两个 MCP API 是 1.101 才有的，缺了也不能让激活失败
  const lm = (vscode as unknown as {
    lm?: {
      registerMcpServerDefinitionProvider?: (
        id: string,
        provider: vscode.McpServerDefinitionProvider
      ) => vscode.Disposable
    }
  }).lm
  const Ctor = (vscode as unknown as { McpHttpServerDefinition?: new (...args: unknown[]) => vscode.McpServerDefinition })
    .McpHttpServerDefinition

  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function' || typeof Ctor !== 'function') {
    log(
      '当前 VS Code 版本不支持扩展注册 MCP 服务器（需要 1.101+）——已跳过自动注册；' +
        '仍然可以用「BastionShell: 查看 MCP 端点」拿到 URL/token 手动配置'
    )
    return
  }

  context.subscriptions.push(
    lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changeEmitter.event,
      provideMcpServerDefinitions: async () => {
        if (!mcpEnabled()) return []
        const h = await ensureMcpServer()
        if (!h) return []
        return [
          new Ctor('BastionShell', vscode.Uri.parse(h.url), { Authorization: `Bearer ${h.token}` }, serverVersion)
        ]
      }
    })
  )

  log(`MCP：已向 VS Code 注册 provider「${MCP_PROVIDER_ID}」（工具 ${MCP_TOOL_DEFS.length} 个）`)
}

/** 给「查看已注册工具」用的展示（测试与文档引用） */
export function mcpToolSummary(): string[] {
  return MCP_TOOL_DEFS.map((d) => {
    const t = toMcpTool(d) as { name: string; annotations?: { readOnlyHint?: boolean } }
    return `${t.name}${t.annotations?.readOnlyHint ? '（只读）' : ''}`
  })
}
