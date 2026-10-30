/**
 * 独立网页版行动面板（`GET /ui/`）。
 *
 * 为什么先做这个而不是直接写 DSH 插件：
 * DSH 的插件是 profile 包 + cordis patch，client 侧要接它的 slot API —— 那是"包装"成本，
 * 在确认"这张卡片长得对不对、字段够不够"之前不值得付。
 * 同一个 HTML 以后可以原样塞进 DSH 插件的 iframe，或者在插件里重画。
 *
 * 这里**只用浏览器能力**（fetch + EventSource），不需要 vscode。
 */

import { groupByIntent, type ActionRecord } from './actionLedger'
import { renderActionsHtml } from './actionPanelHtml'

export function renderStandalonePanel(records: ActionRecord[], token: string, limit = 100): string {
  const groups = groupByIntent(records.slice(-limit))
  const body = renderActionsHtml(groups)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>BastionShell 行动面板</title>
<style>
  :root { color-scheme: dark; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #e6edf3; background: #0d1117; margin: 0; padding: 12px 14px; }
  h1 { font-size: 13px; margin: 0 0 10px; color: #8b949e; font-weight: 600; letter-spacing: .04em; }
  .intent { border: 1px solid #30363d; border-radius: 8px; margin: 0 0 10px; overflow: hidden; }
  .intent.err { border-left: 3px solid #f85149; }
  .intent.ok { border-left: 3px solid #3fb950; }
  .intent.run { border-left: 3px solid #2f81f7; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; background: #161b22; }
  .why { font-weight: 600; }
  .meta { color: #8b949e; font-size: 12px; }
  .synthetic { font-size: 11px; color: #8b949e; border: 1px dashed currentColor; border-radius: 4px; padding: 0 4px; }
  ul { list-style: none; margin: 0; padding: 4px 10px 8px; }
  li.act { padding: 4px 0; border-top: 1px dashed #30363d; }
  li.act:first-child { border-top: 0; }
  .line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  code { font-family: ui-monospace, Consolas, monospace; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; color: #fff; background: #484f58; }
  .badge.sm { font-size: 10px; }
  .badge.working { background: #2f81f7; }
  .badge.input_required { background: #bf8700; }
  .badge.completed { background: #3fb950; }
  .badge.failed { background: #f85149; }
  .badge.cancelled { background: #6e7781; }
  button { font-size: 11px; padding: 1px 8px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; }
  pre { margin: 6px 0 2px; padding: 6px 8px; background: #161b22; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  details summary { cursor: pointer; color: #8b949e; font-size: 12px; }
  .reason { color: #8b949e; font-size: 12px; }
  .empty { color: #8b949e; font-style: italic; }
  footer { margin-top: 8px; color: #6e7781; font-size: 11px; }
  .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #3fb950; margin-right: 5px; }
  .live.off { background: #f85149; }
</style></head><body>
<h1><span id="dot" class="live"></span>BastionShell 行动面板 · <span id="count">${groups.length}</span> 组（独立网页版）</h1>
<div id="root">${body}</div>
<footer>数据来自扩展的作业账本与实时事件；凭据类参数已脱敏。取消动作会往对应会话发 Ctrl-C。</footer>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const dot = document.getElementById('dot');
  const count = document.getElementById('count');

  // 取消：走 MCP 的 tools/call（复用现有权限与安全策略，不新开写接口）
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.dataset.act !== 'cancel') return;
    el.disabled = true;
    try {
      // 同源 POST（token 在 query 里）：不触跨域预检，也不给 /mcp 放开 CORS
      await fetch('/ui/cancel?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: el.dataset.id })
      });
    } catch {}
  });

  // 实时：订阅 action 事件，收到就重画列表
  function connect() {
    const es = new EventSource('/ui/stream?token=' + encodeURIComponent(TOKEN));
    es.onopen = () => { dot.className = 'live'; };
    es.onerror = () => { dot.className = 'live off'; es.close(); setTimeout(connect, 3000); };
    es.onmessage = () => { void refresh(); };
    es.addEventListener('action', () => { void refresh(); });
  }
  async function refresh() {
    try {
      const r = await fetch('/ui/actions?limit=100&token=' + encodeURIComponent(TOKEN));
      const j = await r.json();
      document.getElementById('root').innerHTML = j.html || '<div class="empty">暂无动作</div>';
      count.textContent = j.groups ?? 0;
    } catch {}
  }
  connect();
</script>
</body></html>`
}
