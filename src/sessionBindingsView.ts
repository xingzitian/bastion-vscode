/**
 * 「AI 会话绑定」的可见化（用户要的管理面板入口）。
 *
 * 背景：绑定现在存在服务端，AI 那边能看清自己在哪条会话上；**人也得能看清** ——
 * 否则出现"AI 把命令打到另一台机器"时，人根本不知道有几个 AI、各自占着哪条会话。
 *
 * 这里给两样东西：
 *   1. 状态栏一格（复用已有的 `ai` 槽位）：有几个绑定、分别是谁；
 *   2. 一条命令 `bastion.showAiBindings`：列出每条会话被哪些客户端绑着，能聚焦/解绑。
 *
 * 刻意**不 import aiBridge**（它依赖 sessions → slots，会绕成循环依赖）；
 * 这里只需要 terminals 和绑定文件。
 */
import * as vscode from 'vscode'
import { terminals } from './state'
import { setSlot, clearSlot } from './status'
import { aliasOfSession, bindingsOf, loadBindings, normalizeClientId, onBindingsChanged, ownerClients, saveBindings, unbind } from './sessionBindings'

function entries(): { id: string; name: string; term: import('./terminal').BastionTerminal }[] {
  return [...terminals.entries()].map(([vt, term]) => ({ id: term.sessionId, name: vt.name, term }))
}

/** 状态栏：没有绑定就清掉这一格（不占底栏） */
export function updateAiBindingSlot(): void {
  const f = loadBindings()
  const live = new Set(entries().map((e) => e.id))
  const lines: string[] = []
  let total = 0
  for (const [clientId, cb] of Object.entries(f.clients)) {
    for (const [alias, b] of Object.entries(cb.sessions)) {
      if (!live.has(b.sessionId)) continue
      total += 1
      lines.push(`- \`${clientId}\` → ${alias} = ${b.sessionId}${b.name ? `（${b.name}）` : ''}`)
    }
  }
  if (total === 0) {
    clearSlot('ai')
    return
  }
  setSlot('ai', {
    text: `$(hubot) AI ${total}`,
    tooltip: new vscode.MarkdownString(
      ['**AI 会话绑定**', ...lines, '', '点击查看 / 解绑（`BastionShell: 查看 AI 会话绑定`）'].join('\n')
    ),
    command: 'bastion.showAiBindings'
  })
}

/** 命令：列出每条会话 + 它的绑定，可聚焦终端或解绑 */
export async function showAiBindings(): Promise<void> {
  const list = entries()
  const f = loadBindings()
  if (list.length === 0) {
    void vscode.window.showInformationMessage('现在还没有任何 BastionShell 会话。')
    return
  }
  const items: (vscode.QuickPickItem & { id?: string })[] = list.map((e) => {
    const mine = normalizeClientId(undefined)
    const myAlias = aliasOfSession(bindingsOf(f, mine), e.id)
    const owners = ownerClients(f, e.id)
    const tags = [
      myAlias ? `你的(${myAlias})` : '',
      owners.filter((o) => o !== mine).length ? `其他客户端: ${owners.filter((o) => o !== mine).join(',')}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      label: `${e.id}  ${e.name}`,
      description: tags || '未绑定',
      detail: e.term.isReadOnly ? '只读会话' : undefined,
      id: e.id
    }
  })
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '会话 id / 终端名 · 谁绑着它（Esc 退出）'
  })
  if (!picked || !picked.id) return

  const target = picked.id
  const owners = ownerClients(f, target)
  const actions: vscode.QuickPickItem[] = [
    { label: '$(terminal) 聚焦这条会话的终端', description: '只是切过去看，不影响任何绑定' },
    { label: '$(copy) 复制会话 id', description: target }
  ]
  if (owners.length > 0) {
    actions.push({ label: `$(close) 解绑（${owners.join(', ')}）`, description: '清掉这些客户端对这个会话的绑定' })
  }
  const act = await vscode.window.showQuickPick(actions, { placeHolder: `${picked.label}（${picked.description ?? ''}）` })
  if (!act) return

  if (act.label.startsWith('$(terminal)')) {
    const hit = [...terminals.entries()].find(([, t]) => t.sessionId === target)
    hit?.[0].show()
    return
  }
  if (act.label.startsWith('$(copy)')) {
    await vscode.env.clipboard.writeText(target)
    void vscode.window.showInformationMessage(`已复制会话 id：${target}`)
    return
  }
  // 解绑：把所有绑着这条会话的客户端都摘掉
  const fresh = loadBindings()
  let removed = 0
  for (const clientId of ownerClients(fresh, target)) {
    if (unbind(fresh, clientId, { sessionId: target })) removed += 1
  }
  if (removed > 0) {
    saveBindings(fresh)
    void vscode.window.showInformationMessage(`已解绑 ${removed} 个客户端对该会话的绑定。`)
  }
  updateAiBindingSlot()
}

/** 激活时调用：订阅绑定变化 + 画一次 */
export function registerSessionBindingsView(context: vscode.ExtensionContext): void {
  context.subscriptions.push(onBindingsChanged(() => updateAiBindingSlot()))
  updateAiBindingSlot()
}
