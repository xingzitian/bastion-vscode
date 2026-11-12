import * as vscode from 'vscode'
import * as net from 'net'
import { SharedConnection } from './connection'
import { readJsonFile, writeJsonFile, migrateJsonExtension } from './core/config'
import { log } from './log'

export interface ForwardRule {
  id: string
  /** 所属堡垒机档案名 */
  profileId: string
  label: string
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
}

const KEY = 'bastion.forwardRules'
export const FORWARD_FILE = 'forwardRules.jsonc'

export const FORWARD_HEADER = [
  '// ============================================================',
  '// BastionShell 端口转发规则',
  '// 直接编辑本文件并保存即可生效（刷新侧边栏后读取）。',
  '// ------------------------------------------------------------',
  '// 每个规则字段说明：',
  '//   id         规则唯一 ID（自己起、别重复，如 "fw-mysql"）',
  '//   profileId  所属档案名（对应 profiles.jsonc 里的 name）',
  '//   label      显示标签（如 "MySQL"）',
  '//   localHost  本地监听地址，一般填 127.0.0.1',
  '//   localPort  本地监听端口（如 13306）—— **本机**这个端口必须空着',
  '//   remoteHost 转发目标（由 SSH 那一侧能访问到的地址）。直连时 127.0.0.1 就是这台机器；',
  '//              堡垒机模式下 127.0.0.1 指的是**堡垒机自己**，要访问目标机请填目标机 IP',
  '//   remotePort 目标端口（如 3306）',
  '//',
  '// 语义 = ssh -L localPort:remoteHost:remotePort（**本地转发**）：',
  '//   浏览器/客户端连本机 localPort → 经 SSH 转给 remoteHost:remotePort。',
  '//   所以「本地和远端同端口」是允许的（如 8006 → 8006），只要本机 8006 没被占用。',
  '// ============================================================'
].join('\n');

function isValidRule(r: unknown): r is ForwardRule {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.profileId === 'string' &&
    typeof o.label === 'string' &&
    typeof o.localHost === 'string' &&
    typeof o.remoteHost === 'string' &&
    typeof o.localPort === 'number' &&
    typeof o.remotePort === 'number'
  )
}

function normalizeRule(r: ForwardRule): ForwardRule {
  return {
    ...r,
    localHost: typeof r.localHost === 'string' && r.localHost ? r.localHost : '127.0.0.1'
  }
}

export function getForwardRules(ctx: vscode.ExtensionContext): ForwardRule[] {
  migrateJsonExtension(FORWARD_FILE, 'forwardRules.json', FORWARD_HEADER)
  // 只要求是数组，然后逐条筛：某条规则写错不该让整份文件被当损坏丢进 .bak
  const raw = readJsonFile<ForwardRule[]>(FORWARD_FILE, [], (v): v is ForwardRule[] => Array.isArray(v))
  let rules = raw.filter(isValidRule)
  const bad = raw.length - rules.length
  if (bad > 0) {
    log(`转发规则有 ${bad} 条格式不合法，已跳过；文件本身未改动`)
  }

  const legacy = ctx.globalState.get<ForwardRule[]>(KEY)
  if (rules.length === 0 && Array.isArray(legacy) && legacy.length > 0) {
    rules = legacy.filter(isValidRule).map(normalizeRule)
    try {
      writeJsonFile(FORWARD_FILE, rules, FORWARD_HEADER)
      void ctx.globalState.update(KEY, undefined)
      log(`已迁移 ${rules.length} 条转发规则到配置文件`)
    } catch (e) {
      log(`转发规则迁移写入失败: ${(e as Error).message}`)
    }
  }
  return rules.map(normalizeRule)
}

export function saveForwardRules(ctx: vscode.ExtensionContext, rules: ForwardRule[]): void {
  writeJsonFile(FORWARD_FILE, rules.map(normalizeRule), FORWARD_HEADER)
}

export function newForwardRuleId(): string {
  return `fw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 运行中的转发：id -> { 连接, 规则, 本地 listener } */
interface ActiveForward {
  conn: SharedConnection
  rule: ForwardRule
  /** 本地监听（`net.Server`）。**这是本地转发**：本机 bind，收到连接再 forwardOut 到远端 */
  server: net.Server
}

const active = new Map<string, ActiveForward>()

/**
 * 把 bind 失败翻译成人能看懂的原因。
 *
 * 这里有历史教训：早期版本用了 `forwardIn`（远端 bind，等于 `ssh -R`），
 * 于是"本地和远端同端口"时必然失败（远端那个端口正是你要访问的服务），
 * 而且成功也没有本地监听 —— 浏览器当然打不开。错误信息还只说 "Unable to bind"，
 * 让人以为是远端问题。现在把它说清楚：**是本机端口被占用**。
 */
export function bindErrorText(err: NodeJS.ErrnoException, host: string, port: number): string {
  if (err.code === 'EADDRINUSE') {
    return (
      `本地 ${host}:${port} 已被占用（不是远端问题）。端口转发是「本机监听 → 连远端」，` +
      `本机这个端口必须是空的；把 localPort 换成别的（例如 18006）再启动即可。`
    )
  }
  if (err.code === 'EACCES') {
    return `本地 ${host}:${port} 没有权限监听（1024 以下的端口需要管理员权限）`
  }
  return `本地 ${host}:${port} 监听失败：${err.message}`
}

/**
 * 启动一条**本地**端口转发（等价 `ssh -L localPort:remoteHost:remotePort`）。
 *
 * 本地监听 → 每来一个连接，就在这条 SSH 连接上 forwardOut 到 `remoteHost:remotePort`。
 *
 * ⚠️ 堡垒机模式下的语义：`forwardOut` 的目标是**堡垒机视角**能访问到的地址。
 * 所以 `remoteHost = 127.0.0.1` 指的是「堡垒机自己」，不是目标机；
 * 要访问目标机上的服务，请填目标机的 IP（或任何堡垒机能路由到的地址）。
 */
export function startForward(conn: SharedConnection, rule: ForwardRule): Promise<void> {
  return new Promise((resolve, reject) => {
    // 幂等：同一条规则重复启动不算错（树视图单击可能连点两下）
    if (active.has(rule.id)) {
      resolve()
      return
    }
    const host = (rule.localHost || '127.0.0.1').trim()
    const server = net.createServer((sock) => {
      sock.on('error', (e) => log(`转发连接出错（${rule.label}）：${(e as Error).message}`))
      conn.rawClient.forwardOut(
        sock.remoteAddress ?? '127.0.0.1',
        sock.remotePort ?? 0,
        rule.remoteHost,
        rule.remotePort,
        (err, chan) => {
          if (err) {
            log(`转发连接失败（${rule.label} → ${rule.remoteHost}:${rule.remotePort}）: ${err.message}`)
            sock.destroy()
            return
          }
          chan.on('error', (e: Error) => {
            log(`转发通道出错（${rule.label}）：${(e as Error).message}`)
            sock.destroy()
          })
          sock.on('close', () => chan.destroy())
          sock.pipe(chan).pipe(sock)
        }
      )
    })
    const onBindError = (err: NodeJS.ErrnoException) => {
      server.close()
      reject(new Error(bindErrorText(err, host, rule.localPort)))
    }
    server.once('error', onBindError)
    server.listen(rule.localPort, host, () => {
      server.removeListener('error', onBindError)
      server.on('error', (e) => log(`转发监听出错（${rule.label}）：${e.message}`))
      active.set(rule.id, { conn, rule, server })
      log(`转发已启动（本地）：${host}:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}（${rule.label}）`)
      resolve()
    })
  })
}

export function stopForward(id: string): void {
  const e = active.get(id)
  if (!e) return
  try {
    e.server.close()
  } catch {
    /* 已经关了就算了 */
  }
  active.delete(id)
  log(`转发已停止：${e.rule.localHost}:${e.rule.localPort} → ${e.rule.remoteHost}:${e.rule.remotePort}（${e.rule.label}）`)
}

export function stopForwardsOfConn(conn: SharedConnection): void {
  for (const [id, e] of active) {
    if (e.conn === conn) stopForward(id)
  }
}

/** 当前运行中的转发规则（状态栏要用） */
export function listActiveForwards(): ForwardRule[] {
  return [...active.values()].map((e) => e.rule)
}

/** 停掉全部转发，返回停掉的条数 */
export function stopAllForwards(): number {
  const ids = [...active.keys()]
  for (const id of ids) stopForward(id)
  return ids.length
}

export function isForwardActive(id: string): boolean {
  return active.has(id)
}

// ---- 树视图 ----

export class ForwardRuleItem extends vscode.TreeItem {
  constructor(public readonly rule: ForwardRule) {
    super(rule.label || `${rule.localPort}→${rule.remoteHost}:${rule.remotePort}`, vscode.TreeItemCollapsibleState.None)
    const act = isForwardActive(rule.id)
    this.description = act
      ? `🟢 ${rule.localHost}:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`
      : `${rule.localHost}:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`
    this.tooltip = new vscode.MarkdownString(
      [
        `**单击：启动 / 停止这条转发**（当前${act ? '运行中，单击停止' : '未启动，单击启动'}）`,
        '',
        `**${rule.label}**`,
        '',
        `- 本地监听：\`${rule.localHost}:${rule.localPort}\``,
        `- 转发到：\`${rule.remoteHost}:${rule.remotePort}\``,
        `- 所属档案：${rule.profileId}`,
        `- 状态：${act ? '🟢 运行中' : '⚪ 未启动'}`,
        '',
        act ? '行内 ■ 也可单独停止' : '行内 ▶ 也可单独启动',
        '右键可：启动 / 停止 / 编辑规则（打开配置文件）/ 删除规则'
      ].join('\n')
    )
    this.contextValue = act ? 'forwardActive' : 'forwardIdle'
    this.iconPath = new vscode.ThemeIcon(act ? 'vm-active' : 'vm-connect')
    // 单击 = 启停切换：这是本视图的主操作，和行内 ▶/■、右键首项一致
    this.command = { command: act ? 'bastion.stopForward' : 'bastion.startForward', title: act ? '停止' : '启动', arguments: [this] }
  }
}

export class ForwardRulesProvider implements vscode.TreeDataProvider<ForwardRuleItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ForwardRuleItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly loadRules: () => ForwardRule[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(e: ForwardRuleItem): vscode.TreeItem {
    return e
  }

  getChildren(): ForwardRuleItem[] {
    return this.loadRules().map((r) => new ForwardRuleItem(r))
  }
}
