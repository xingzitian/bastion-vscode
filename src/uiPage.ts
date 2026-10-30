/**
 * 独立网页版行动面板（`GET /ui/`）。
 *
 * 为什么有它：先不啃 DSH 插件 ABI，用最低成本验证"这张卡片长什么样"。
 * 现在它的第二个用途是**浮窗**（DSH 侧 420px 宽）：于是多了两个开关：
 *  - `embed=1`：不渲染自己的标题与页脚、padding 收紧（浮窗里那两块白占地方）
 *  - `theme=light|dark`：浅色/深色（默认深色，与之前完全一致）
 *
 * 硬约束：这里只有**展示**。取消走 `/ui/cancel` 同源 POST，执行/状态机一律不碰。
 */

import { groupByIntent, type ActionRecord } from './actionLedger'
import { renderActionsHtml } from './actionPanelHtml'

export interface PanelOpts {
  embed?: boolean
  theme?: 'dark' | 'light'
  limit?: number
  /** 全量分组数（浮窗上"共 N 组"用；与 limit 切片后的 groups 区分开） */
  groupsTotal?: number
}

export function renderStandalonePanel(records: ActionRecord[], token: string, opts: PanelOpts = {}): string {
  const limit = opts.limit ?? 100
  const groups = groupByIntent(records.slice(-limit))
  const body = renderActionsHtml(groups)
  const embed = opts.embed === true
  const light = opts.theme === 'light'
  const total = opts.groupsTotal ?? groups.length
  const title = embed
    ? ''
    : `<h1><span id="dot" class="live"></span>BastionShell 行动面板 · <span id="count">${groups.length}</span> 组（独立网页版）</h1>`
  const footer = embed
    ? ''
    : '<footer>数据来自扩展的作业账本与实时事件；凭据类参数已脱敏。取消动作会往对应会话发 Ctrl-C。</footer>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BastionShell 行动面板</title>
<style>
  :root {
    color-scheme: ${light ? 'light' : 'dark'};
    --bg: ${light ? '#ffffff' : '#0d1117'};
    --fg: ${light ? '#1f2328' : '#e6edf3'};
    --panel: ${light ? '#f6f8fa' : '#161b22'};
    --border: ${light ? '#d0d7de' : '#30363d'};
    --muted: ${light ? '#57606a' : '#8b949e'};
    --faint: ${light ? '#8c959f' : '#6e7781'};
    --btn: ${light ? '#f6f8fa' : '#21262d'};
    --btn-fg: ${light ? '#1f2328' : '#e6edf3'};
  }
  body { font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: ${embed ? '8px' : '12px 14px'}; }
  h1 { font-size: 13px; margin: 0 0 10px; color: var(--muted); font-weight: 600; letter-spacing: .04em; }
  .intent { border: 1px solid var(--border); border-radius: 8px; margin: 0 0 ${embed ? '8px' : '10px'}; overflow: hidden; }
  .intent.err { border-left: 3px solid #f85149; }
  .intent.ok { border-left: 3px solid #3fb950; }
  .intent.run { border-left: 3px solid #2f81f7; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: ${embed ? '6px 8px' : '8px 10px'}; background: var(--panel); }
  .why { font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .synthetic { font-size: 11px; color: var(--muted); border: 1px dashed currentColor; border-radius: 4px; padding: 0 4px; }
  ul { list-style: none; margin: 0; padding: ${embed ? '2px 8px 6px' : '4px 10px 8px'}; }
  li.act { padding: 4px 0; border-top: 1px dashed var(--border); }
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
  button { font-size: 11px; padding: 1px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--btn); color: var(--btn-fg); cursor: pointer; }
  pre { margin: 6px 0 2px; padding: 6px 8px; background: var(--panel); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  .reason { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); font-style: italic; }
  footer { margin-top: 8px; color: var(--faint); font-size: 11px; }
  .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #3fb950; margin-right: 5px; }
  .live.off { background: #f85149; }
</style></head><body class="${embed ? 'embed' : ''} ${light ? 'theme-light' : ''}">
${title}
<div id="root">${body}</div>
${footer}
<script>
  const TOKEN = ${JSON.stringify(token)};
  const GROUPS_TOTAL = ${total};
  const dot = document.getElementById('dot');
  const count = document.getElementById('count');
  const post = (working, total) => {
    try { if (window.parent !== window) window.parent.postMessage({ source: 'bastionshell-ui', working, total }, '*'); } catch {}
  };

  // 取消：同源 POST（不触跨域预检，也不给 /mcp 放开 CORS）
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.dataset.act !== 'cancel') return;
    el.disabled = true;
    try {
      await fetch('/ui/cancel?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: el.dataset.id })
      });
    } catch { el.disabled = false; }
  });

  async function refresh() {
    try {
      const r = await fetch('/ui/actions?limit=${limit}&token=' + encodeURIComponent(TOKEN));
      const j = await r.json();
      document.getElementById('root').innerHTML = j.html || '<div class="empty">暂无动作</div>';
      if (count) count.textContent = j.groupsTotal ?? j.groups ?? 0;
    } catch {}
  }

  // 在跑数量：浮窗用的轻量接口（5 秒一次），同时 postMessage 给宿主，省掉它自己轮询
  async function pollStatus() {
    try {
      const r = await fetch('/ui/status?token=' + encodeURIComponent(TOKEN));
      const j = await r.json();
      if (dot) dot.className = j.working > 0 ? 'live' : 'live off';
      post(j.working, GROUPS_TOTAL);
    } catch { if (dot) dot.className = 'live off'; }
  }

  function connect() {
    const es = new EventSource('/ui/stream?token=' + encodeURIComponent(TOKEN));
    es.onopen = () => { if (dot) dot.className = 'live'; };
    es.onerror = () => { if (dot) dot.className = 'live off'; es.close(); setTimeout(connect, 3000); };
    es.onmessage = () => { void refresh(); };
    es.addEventListener('action', () => { void refresh(); void pollStatus(); });
  }

  void pollStatus();
  setInterval(pollStatus, 5000);
  connect();
</script>
</body></html>`
}
