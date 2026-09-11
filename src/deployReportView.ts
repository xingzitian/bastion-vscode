/**
 * 部署报告面板（Webview）。
 *
 * 为什么不再只打开 .md：报告是批量部署**唯一**的产物，而「读一份 Markdown」看不出重点 ——
 * 哪台失败、哪条命令的输出对不上、要不要重跑这台，都得自己翻。面板里：
 *   - 失败的**置顶**
 *   - 每台机器可折叠，每条命令 + 它的输出在一起
 *   - **一键重跑这台**、**一键把报告发给 AI**
 *
 * 数据模型（ReportView）是**可序列化**的：除内存里留一份，还会在报告旁边写一份
 * `.json` 副本，这样重启 VS Code 之后面板照样能打开（否则只能退回看 .md）。
 */

import * as vscode from 'vscode'
import { log } from './log'
import { sendTextToAIChat } from './aiChat'
import { renderDeployReport, capForAi, type DeployRun } from './deployReport'

/** 面板用的「一台机器」视图数据（只保留要显示的字段，且能 JSON 序列化） */
export interface ReportHostView {
  host: string
  ok: boolean
  ms: number
  error?: string
  direct?: boolean
  skipped?: boolean
  steps: Array<{
    label: string
    command: string
    output: string
    captured: boolean
    pending?: boolean
    ms: number
  }>
}

export interface ReportView {
  name: string
  /** 生成时间（毫秒） */
  at: number
  okCount: number
  total: number
  /** 任务文件（用于「重跑这台」时重读最新配置）；直连/批量连接时为 undefined */
  taskUri?: string
  taskName: string
  hosts: ReportHostView[]
}

/** 把内存里的执行结果转成面板数据（纯函数，可测；顺带把失败排到前面） */
export function toReportView(runs: DeployRun[], taskUri?: string): ReportView {
  const hosts: ReportHostView[] = []
  let okCount = 0
  let total = 0
  for (const run of runs) {
    for (const r of run.results) {
      total++
      if (r.ok) okCount++
      hosts.push({
        host: r.host,
        ok: r.ok,
        ms: r.ms,
        error: r.error,
        direct: r.direct,
        skipped: r.skipped,
        steps: (r.steps ?? []).map((s) => ({
          label: s.label,
          command: s.command,
          output: s.output,
          captured: s.captured,
          pending: s.pending,
          ms: s.ms
        }))
      })
    }
  }
  return {
    name: runs.map((r) => r.task.name).join('、') || '部署',
    at: Date.now(),
    okCount,
    total,
    taskUri,
    taskName: runs.length === 1 ? runs[0].task.name : '批量任务',
    hosts: sortHostsForPanel(hosts)
  }
}

/**
 * 失败置顶：没跑的排最前，然后失败，最后成功。
 * 同一档内保持原顺序（稳定的排序直觉：还按 hosts 里写的顺序看）。
 */
export function sortHostsForPanel(hosts: ReportHostView[]): ReportHostView[] {
  const rank = (h: ReportHostView): number => (h.skipped ? 0 : h.ok ? 2 : 1)
  return hosts.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map((x) => x.h)
}

/** HTML 转义（会话名/命令/输出都可能带 < >） */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** 面板 HTML（纯字符串构造，便于测试：产物必须是完整 HTML、非空、无 undefined） */
export function buildReportHtml(cspSource: string, view: ReportView): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const state = JSON.stringify(view).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>部署报告</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 10px 14px; color: var(--vscode-foreground); }
  h1 { font-size: 16px; margin: 0 0 4px 0; }
  .sub { opacity: .75; margin-bottom: 10px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
  .hd { padding: 6px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px; background: var(--vscode-editorWidget-background); }
  .hd .host { font-weight: 600; }
  .hd .meta { opacity: .7; margin-left: auto; font-size: 12px; }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .bad { color: var(--vscode-testing-iconFailed, #f85149); }
  .skip { color: var(--vscode-descriptionForeground); }
  .body { padding: 8px 10px; display: none; }
  .card.open .body { display: block; }
  .step { margin-bottom: 8px; }
  .step .cmd { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; display: inline-block; }
  pre { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; margin: 4px 0; }
  .note { opacity: .8; font-style: italic; }
  .warn { color: var(--vscode-editorWarning-foreground, #d29922); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; border-radius: 4px; cursor: pointer; margin-right: 6px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .fail { color: var(--vscode-errorForeground); margin: 4px 0; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const state = ${state};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHost(h) {
  const mark = h.skipped ? '⏹ 未执行（已停止）' : h.ok ? '✅ 成功' : '❌ 失败';
  const cls = h.skipped ? 'skip' : h.ok ? 'ok' : 'bad';
  const steps = h.steps.map(function (s) {
    const out = String(s.output || '').trim();
    let inner = '';
    if (!s.captured) {
      inner = '<div class="note">交互式 / 后台命令，输出无法可靠捕获</div>';
    } else if (s.pending) {
      inner = '<div class="warn">⚠️ 没等到这条命令的结束标记 —— 它很可能没有真正执行</div>' +
              (out ? '<pre>' + esc(out) + '</pre>' : '');
    } else if (out) {
      inner = '<pre>' + esc(out) + '</pre>';
    } else {
      inner = '<div class="note">（无输出）</div>';
    }
    return '<div class="step"><span class="cmd">' + esc(s.command) + '</span>' +
      ' <span class="sub">' + esc(s.label) + ' · ' + (s.ms / 1000).toFixed(1) + 's</span>' + inner + '</div>';
  }).join('');
  const err = h.error ? '<div class="fail">失败原因：' + esc(h.error) + '</div>' : '';
  const tag = h.direct ? ' · 直连' : '';
  return '<div class="card' + (h.ok ? '' : ' open') + '">' +
    '<div class="hd" data-toggle><span class="' + cls + '">' + mark + '</span>' +
    '<span class="host">' + esc(h.host) + '</span>' +
    '<span class="meta">' + (h.ms / 1000).toFixed(1) + 's' + tag + '</span></div>' +
    '<div class="body">' + err + steps +
    '<div><button data-rerun="' + esc(h.host) + '">重跑这台</button>' +
    '<button data-ai="1">把报告发给 AI</button>' +
    '<button data-md="1">打开 Markdown</button></div>' +
    '</div></div>';
}

function render() {
  const failed = state.total - state.okCount;
  document.getElementById('root').innerHTML =
    '<h1>部署报告：' + esc(state.name) + '</h1>' +
    '<div class="sub">' + new Date(state.at).toLocaleString() + ' · 共 ' + state.total + ' 台，' +
    (failed ? '<span class="bad">' + failed + ' 台失败</span>' : '<span class="ok">全部成功</span>') +
    '（失败的排在最前，点标题展开）</div>' +
    state.hosts.map(renderHost).join('');
}

document.addEventListener('click', function (e) {
  const t = e.target;
  // 用 closest 而不是 e.target.dataset：点标题里的文字/按钮时，e.target 是里层的 span/button，
  // 直接读它的 dataset 会什么都读不到（折叠点了没反应）。
  const rerun = t.closest('[data-rerun]');
  if (rerun) { vscode.postMessage({ type: 'rerunHost', host: rerun.dataset.rerun }); return; }
  if (t.closest('[data-ai]')) { vscode.postMessage({ type: 'sendToAI' }); return; }
  if (t.closest('[data-md]')) { vscode.postMessage({ type: 'openMarkdown' }); return; }
  const hd = t.closest('[data-toggle]');
  if (hd) {
    const card = hd.closest('.card');
    if (card) card.classList.toggle('open');
  }
});

render();
</script>
</body>
</html>`
}

let panel: vscode.WebviewPanel | null = null

/**
 * 打开（或复用）报告面板。
 * `rerunHost` 由外部注入：面板不直接依赖 deployRun，避免循环 import。
 */
export function showReportPanel(
  view: ReportView,
  handlers: {
    rerunHost: (host: string) => Promise<void>
    openMarkdown: () => Promise<void>
    /** 取报告 Markdown 文本（发给 AI 用） */
    markdown: () => Promise<string>
  }
): void {
  if (panel) {
    panel.webview.html = buildReportHtml(panel.webview.cspSource, view)
    panel.reveal()
    return
  }
  panel = vscode.window.createWebviewPanel('bastionDeployReport', `部署报告 · ${view.name}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true
  })
  panel.onDidDispose(() => {
    panel = null
  })
  panel.webview.html = buildReportHtml(panel.webview.cspSource, view)
  panel.webview.onDidReceiveMessage(async (msg: { type?: string; host?: string }) => {
    try {
      if (msg.type === 'rerunHost' && msg.host) {
        await handlers.rerunHost(msg.host)
      } else if (msg.type === 'sendToAI') {
        const md = await handlers.markdown()
        if (!md.trim()) {
          void vscode.window.showWarningMessage('读不到报告内容（文件可能已被删除）')
          return
        }
        const capped = capForAi(md)
        if (capped.omitted > 0) {
          // 只让 AI 知道截断了不够：用户以为整份都发过去了，而切掉的可能是失败那台
          log(`报告过长，发给 AI 前截断：省略 ${capped.omitted} 字符`)
          void vscode.window.showInformationMessage(
            `报告较长（${md.length} 字符），已截断后再发给 AI —— 后面 ${capped.omitted} 个字符没发出去。`
          )
        }
        await sendTextToAIChat(
          capped.text,
          '以下是我刚才那次部署的报告，请帮我分析失败原因和下一步排查方向：'
        )
      } else if (msg.type === 'openMarkdown') {
        await handlers.openMarkdown()
      }
    } catch (e) {
      log(`报告面板操作失败（${msg.type}）：${(e as Error).message}`)
      void vscode.window.showErrorMessage(`操作失败：${(e as Error).message}`)
    }
  })
}

/** 供测试用：把内部状态清掉（面板是模块级单例） */
export function __resetReportPanelForTest(): void {
  panel = null
}
