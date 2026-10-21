/**
 * 左侧「AI 访问」树 —— 和「连接档案」同一类东西：**在这里看、在这里管**，
 * 而不是让人去命令面板里翻（维护者原话："为什么令牌配置一定要在命令里面做"）。
 *
 * 树的结构：
 *   AI 客户端（主令牌 + 每个签发的令牌）
 *     └ 绑定：A → s-7f3a（#3 deploy@10.0.0.1）
 *   会话与绑定
 *     └ #3 deploy@10.0.0.1  s-7f3a   A（主令牌）
 *
 * 权限档一律用**人话**（来自 aiAccess.SCOPE_INFO），不只写 observer/operator/full。
 */
import * as vscode from 'vscode'
import { terminals } from './state'
import { bindingsOf, loadBindings, onBindingsChanged } from './sessionBindings'
import { mcpClientTokens, mcpMainToken } from './mcpRegister'
import { buildAiModel, ownersSummary, scopeDetail, scopeInfoOf, type AiClientRow, type AiSessionRow } from './aiAccess'

const CLIENT_CTX = 'aiClient'
const BINDING_CTX = 'aiBinding'
const SESSION_CTX = 'aiSession'

class AiItem extends vscode.TreeItem {
  client?: AiClientRow
  bindingAlias?: string
  sessionId?: string
  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, ctx?: string) {
    super(label, collapsibleState)
    if (ctx) this.contextValue = ctx
  }
}

function sessionRows(): Array<{ id: string; name: string }> {
  return [...terminals.entries()].map(([vt, term]) => ({
    id: term.sessionId,
    name: vt.name
  }))
}

function currentModel() {
  const tokens = mcpClientTokens().map((c) => ({ label: c.label, scope: c.scope, token: c.token }))
  const bindings = loadBindings()
  return buildAiModel({
    tokens,
    clients: bindings.clients ?? {},
    sessions: sessionRows(),
    mainToken: mcpMainToken()
  })
}

export class AiAccessProvider implements vscode.TreeDataProvider<AiItem> {
  private _onDidChange = new vscode.EventEmitter<AiItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(el: AiItem): vscode.TreeItem {
    return el
  }

  getChildren(el?: AiItem): AiItem[] {
    const m = currentModel()
    if (!el) {
      const clientsGroup = new AiItem('AI 客户端', vscode.TreeItemCollapsibleState.Expanded, 'aiClientsGroup')
      clientsGroup.iconPath = new vscode.ThemeIcon('hubot')
      clientsGroup.description = m.hasCustom ? `${m.clients.length} 个（含主令牌）` : '只有主令牌'
      const sessionsGroup = new AiItem('会话与绑定', vscode.TreeItemCollapsibleState.Expanded, 'aiSessionsGroup')
      sessionsGroup.iconPath = new vscode.ThemeIcon('link')
      sessionsGroup.description = m.hasBindings ? '' : '还没有 AI 绑定'
      return [clientsGroup, sessionsGroup]
    }
    if (el.contextValue === 'aiClientsGroup') {
      return m.clients.map((c) => {
        const item = new AiItem(c.label, c.bindings.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None, CLIENT_CTX)
        item.client = c
        item.description = `${c.scopeLabel} · ${c.plain}${c.bindings.length ? ` · ${c.bindings.length} 条绑定` : ''}`
        item.tooltip = new vscode.MarkdownString(
          [
            `**${c.label}**`,
            '',
            scopeDetail(c.scope).replace(/\n/g, '  \n'),
            '',
            c.tokenMasked ? `令牌：\`${c.tokenMasked}\`` : '',
            c.isMain ? '（主令牌不给单独签发：它就是 VS Code 自己用的那把）' : '',
            c.headerOnly ? '\n**右键 → 签发同名令牌**，就能把它从"全权"降到你选的档（它已有的绑定会跟过来）' : ''
          ].join('\n')
        )
        item.iconPath = new vscode.ThemeIcon(c.isMain ? 'shield' : 'key')
        // 主令牌不能吊销；没签发令牌的客户端给"升级"入口；签发的给管理菜单
        item.contextValue = c.isMain ? 'aiClientMain' : c.headerOnly ? 'aiClientHeader' : CLIENT_CTX
        return item
      })
    }
    if (el.contextValue === 'aiClient' || el.contextValue === 'aiClientMain') {
      const c = el.client
      if (!c || c.bindings.length === 0) {
        const hint = new AiItem('（还没有绑定会话）', vscode.TreeItemCollapsibleState.None)
        hint.description = 'AI 用 bastion_use 或 bastion_connect 绑定后这里会出现'
        return [hint]
      }
      return c.bindings.map((b) => {
        const item = new AiItem(`${b.alias} → ${b.sessionId}`, vscode.TreeItemCollapsibleState.None, BINDING_CTX)
        item.description = b.name
        item.bindingAlias = b.alias
        item.sessionId = b.sessionId
        item.client = c
        item.iconPath = new vscode.ThemeIcon('link')
        item.tooltip = new vscode.MarkdownString(`**${c.label}** 的绑定 \`${b.alias}\`\n\n会话：${b.name}（${b.sessionId}）`)
        item.command = {
          command: 'bastion.focusAiSession',
          title: '聚焦这条会话',
          arguments: [b.sessionId]
        }
        return item
      })
    }
    if (el.contextValue === 'aiSessionsGroup') {
      if (m.sessions.length === 0) {
        return [new AiItem('（还没有会话）', vscode.TreeItemCollapsibleState.None)]
      }
      return m.sessions.map((s: AiSessionRow) => {
        const item = new AiItem(s.name, vscode.TreeItemCollapsibleState.None, SESSION_CTX)
        item.description = `${s.id}${s.owners.length ? ` · ${ownersSummary(s)}` : ' · 没有 AI 绑定'}`
        item.sessionId = s.id
        item.iconPath = new vscode.ThemeIcon(s.owners.length ? 'plug' : 'terminal')
        item.tooltip = new vscode.MarkdownString(
          `**${s.name}**\n\n会话 id：\`${s.id}\`\n\n${
            s.owners.length ? s.owners.map((o) => `- ${o.alias}：${o.label}（${scopeInfoOf(o.scope).label}）`).join('\n') : '没有 AI 绑着它'
          }`
        )
        item.command = { command: 'bastion.focusAiSession', title: '聚焦这条会话', arguments: [s.id] }
        return item
      })
    }
    return []
  }
}

/** 激活时调用：注册树 + 订阅绑定变化（AI 那边一绑定，树里立刻就出来） */
export function registerAiAccess(context: vscode.ExtensionContext): AiAccessProvider {
  const provider = new AiAccessProvider()
  const view = vscode.window.createTreeView('bastion.aiAccess', { treeDataProvider: provider, showCollapseAll: false })
  context.subscriptions.push(view)
  context.subscriptions.push(onBindingsChanged(() => provider.refresh()))
  return provider
}

/** 聚焦某条会话（树的点击/命令都走它） */
export function focusAiSession(sessionId: string): void {
  for (const [vt, term] of terminals) {
    if (term.sessionId === sessionId) {
      vt.show()
      return
    }
  }
  void vscode.window.showInformationMessage(`会话 ${sessionId} 已经不在了（可能被关闭）。`)
}
