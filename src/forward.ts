import * as vscode from 'vscode'
import { SharedConnection } from './connection'
import { readJsonFile, writeJsonFile, migrateJsonExtension } from './config'
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
  '//   localPort  本地监听端口（如 13306）',
  '//   remoteHost 远端主机（目标机可达的地址，常填 127.0.0.1）',
  '//   remotePort 远端端口（如 3306）',
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

/** 运行中的转发：id -> {连接, 规则}（规则也留着，状态栏 tooltip 要显示端口映射） */
const active = new Map<string, { conn: SharedConnection; rule: ForwardRule }>()

/** 每个连接一个转发上下文：单 listener 按 destPort 路由到对应规则 */
interface ConnFwdCtx {
  rules: Map<number, ForwardRule>
  listener: (details: { srcIP: string; srcPort: number; destIP: string; destPort: number }, accept: () => import('ssh2').ClientChannel) => void
}

const connContexts = new Map<SharedConnection, ConnFwdCtx>()

function ensureContext(conn: SharedConnection): ConnFwdCtx {
  let c = connContexts.get(conn)
  if (c) return c
  c = {
    rules: new Map(),
    listener: (details, accept) => {
      const rule = c!.rules.get(details.destPort)
      if (!rule) {
        const s = accept()
        s.end()
        return
      }
      const localStream = accept()
      conn.rawClient.forwardOut(details.srcIP, details.srcPort, rule.remoteHost, rule.remotePort, (err, remoteStream) => {
        if (err) {
          log(`转发连接失败（${rule.label} → ${rule.remoteHost}:${rule.remotePort}）: ${err.message}`)
          localStream.end()
          return
        }
        localStream.pipe(remoteStream).pipe(localStream)
      })
    }
  }
  conn.rawClient.on('tcp connection', c.listener)
  connContexts.set(conn, c)
  return c
}

export function startForward(conn: SharedConnection, rule: ForwardRule): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = ensureContext(conn)
    conn.rawClient.forwardIn(rule.localHost, rule.localPort, (err) => {
      if (err) {
        reject(err)
        return
      }
      c.rules.set(rule.localPort, rule)
      active.set(rule.id, { conn, rule })
      resolve()
    })
  })
}

export function stopForward(id: string): void {
  const e = active.get(id)
  if (!e) return
  e.conn.rawClient.unforwardIn(e.rule.localHost, e.rule.localPort, () => {})
  connContexts.get(e.conn)?.rules.delete(e.rule.localPort)
  active.delete(id)
}

export function stopForwardsOfConn(conn: SharedConnection): void {
  for (const [id, e] of active) {
    if (e.conn === conn) {
      e.conn.rawClient.unforwardIn(e.rule.localHost, e.rule.localPort, () => {})
      active.delete(id)
    }
  }
  connContexts.delete(conn)
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
