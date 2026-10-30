/**
 * 行动面板（预览）：把「AI 现在在干什么」画成卡片。
 *
 * 为什么做成扩展里的 webview 而不是先做 DSH 插件：
 *  - 面板跑在扩展宿主里，**可以直接订阅作业事件**，不用跨域、不用 SSE、不用 token；
 *  - 不用 DSH 的用户同样需要它（AI 在 VS Code 里写一长串命令，人也看不出来在干嘛）；
 *  - DSH 插件以后可以复用同一个数据源（HTTP 端点的 action 事件），视图各写一份、语义只有一处。
 *
 * 这一层只做渲染 + 收事件，**不碰 SSH、不碰状态机**。
 */

import * as vscode from 'vscode'
import { groupByIntent, type ActionRecord, type IntentGroup } from './actionLedger'
import { renderActionsHtml, sessionNameOf } from './actionPanelHtml'
import { allJobs, getJob, onJobEvent } from './execJobs'
import { recordFromJob } from './actionLedger'
import { terminals } from './state'
import { log } from './log'
import { cancelExecJob } from './aiBridge'

let panel: vscode.WebviewPanel | undefined
let live: ActionRecord[] = []
let history: ActionRecord[] = []
let unsubscribe: (() => void) | undefined

/** 把一条作业转成记录（每次状态变化都更新同一条） */
function absorb(jobId: string): void {
  const job = getJob(jobId)
  if (!job) return
  const rec = recordFromJob(job)
  const idx = live.findIndex((r) => r.actionId === rec.actionId)
  if (idx >= 0) live[idx] = rec
  else live.push(rec)
  // 只留最近 200 条在内存里显示（更老的看落盘文件）
  if (live.length > 200) live = live.slice(live.length - 200)
}

function allRecords(): ActionRecord[] {
  // 历史在前、实时在后（同 actionId 以实时为准）
  const byId = new Map<string, ActionRecord>()
  for (const r of history) byId.set(r.actionId, r)
  for (const r of live) byId.set(r.actionId, r)
  return [...byId.values()]
}

export { renderActionsHtml } // 纯渲染在 actionPanelHtml（可单测）

function html(): string {
  const groups = groupByIntent(allRecords())
  const nameOf = (no: number): string => {
    for (const [vt, t] of terminals) if (t.sessionNo === no) return vt.name
    return `#${no}`
  }
  const nonce = String(Date.now())
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 10px 12px; }
  h1 { font-size: 13px; margin: 0 0 10px; color: var(--vscode-descriptionForeground); font-weight: 600; letter-spacing: .04em; }
  .intent { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px; margin: 0 0 10px; overflow: hidden; }
  .intent.err { border-left: 3px solid var(--vscode-errorForeground); }
  .intent.ok { border-left: 3px solid var(--vscode-testing-iconPassed, #3ba55d); }
  .intent.run { border-left: 3px solid var(--vscode-progressBar-background, #2f81f7); }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.08)); }
  .why { font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .synthetic { font-size: 11px; color: var(--vscode-descriptionForeground); border: 1px dashed currentColor; border-radius: 4px; padding: 0 4px; }
  ul { list-style: none; margin: 0; padding: 4px 10px 8px; }
  li.act { padding: 4px 0; border-top: 1px dashed rgba(128,128,128,.25); }
  li.act:first-child { border-top: 0; }
  .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; color: #fff; background: var(--vscode-badge-background, #555); }
  .badge.sm { font-size: 10px; }
  .badge.working { background: #2f81f7; }
  .badge.input_required { background: #bf8700; }
  .badge.completed { background: #3ba55d; }
  .badge.failed { background: var(--vscode-errorForeground, #d1242f); }
  .badge.cancelled { background: #6e7781; }
  button { font-size: 11px; padding: 1px 8px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-button-secondaryForeground, #fff); cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
  pre { margin: 6px 0 2px; padding: 6px 8px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .reason { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  footer { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
</style></head><body>
<h1>行动面板（预览）· 最近 ${groups.length} 组动作</h1>
<div id="root">${renderActionsHtml(groups, { sessionName: nameOf })}</div>
<footer>数据来自本扩展的作业账本；「按时间归并」= AI 没传 intentId，仅按会话与时间相邻归并。凭据类参数已脱敏。</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    vscode.postMessage({ type: el.dataset.act, id: el.dataset.id });
  });
</script>
</body></html>`
}

function rerender(): void {
  if (!panel) return
  panel.webview.html = html()
}

export function showActionPanel(load: () => Promise<ActionRecord[]>): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside)
    rerender()
    return
  }
  panel = vscode.window.createWebviewPanel('bastionshell.actions', 'BastionShell 行动面板', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true
  })
  panel.onDidDispose(() => {
    panel = undefined
    unsubscribe?.()
    unsubscribe = undefined
  })
  panel.webview.onDidReceiveMessage(async (msg: { type?: string; id?: string }) => {
    if (msg.type === 'cancel' && msg.id) {
      const job = getJob(msg.id)
      if (job) {
        const hit = [...terminals.values()].find((t) => t.sessionNo === job.sessionNo)
        await hit?.write('\x03')
        log(`行动面板：请求取消 ${msg.id}`)
      }
    }
  })
  // 先读历史，再订阅实时；打开面板时把"已经在跑"的作业也抓进来（它们的事件发生在面板打开之前）
  live = allJobs().map((j) => recordFromJob(j))
  void load()
    .then((recs) => {
      history = recs
      rerender()
    })
    .catch((e) => log(`行动面板：读取账本失败 ${(e as Error).message}`))
  unsubscribe = onJobEvent((e) => {
    absorb(e.jobId)
    rerender()
  })
  rerender()
  panel.reveal(vscode.ViewColumn.Beside)
}