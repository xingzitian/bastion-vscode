/**
 * 网页终端 + 只读面板（A3）：一个独立的本地 HTTP + WS 服务。
 *
 * 为什么要单独一个端口：`core/mcpServer` 的 HTTP 层没有暴露"加路由"的口子，
 * 硬塞进去会污染 MCP 那个文件。终端/面板是**另一个面**，单开一个端口更干净，
 * 也方便将来桌面薄壳只指向 `/term`。
 *
 * 安全：只监听 127.0.0.1；所有请求要 `?token=`（与 MCP 用同一个 token）。
 * xterm.js 从 node_modules 里读**本地文件**发出去 —— 不依赖 CDN（内网/离线可用）。
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { renderStandalonePanel } from '../core/uiPage'
import { loadActionRecords } from '../core/actionLedgerIo'
import type { EngineSession } from '../engine/session'

export interface TermSessionRef {
  id: string
  name: string
  session: EngineSession
}

/** 行动面板要的宿主能力（CLI: CliHost；扩展里是另一套） */
export interface PanelBridge {
  /** 返回 {html, groupsTotal}；sessionId 为空 = 全部会话 */
  actions(sessionId: string | undefined, limit: number): Promise<{ html: string; groupsTotal: number }>
  /** 正在跑的作业数 */
  working(): number
  /** 取消某个作业（尽力而为） */
  cancel(jobId: string): void
  /** 作业状态变化订阅；返回取消订阅 */
  subscribe(cb: () => void): () => void
}

export interface TermServerOptions {
  /** 至少一条；多条时页面顶部出现会话切换 */
  sessions: TermSessionRef[]
  token: string
  /** 0 = 让系统分配 */
  port?: number
  /** 会话名（页面标题） */
  title: string
  log?: (msg: string) => void
  /** 只读面板的数据源（默认读账本） */
  listActions?: typeof loadActionRecords
  /** 面板的实时口子（由宿主注入；没有就退化成"打开时渲染一次"） */
  panel?: PanelBridge
}

export interface TermServer {
  url: string
  port: number
  close(): Promise<void>
}

const XTERM_DIR = path.join(path.dirname(require.resolve('@xterm/xterm/package.json')), 'lib')
const XTERM_CSS = path.join(path.dirname(require.resolve('@xterm/xterm/package.json')), 'css', 'xterm.css')
const FIT_JS = require.resolve('@xterm/addon-fit')

function page(title: string, token: string, list: Array<{ id: string; name: string }>, current: string): string {
  // 说明：token 放在 URL 上（同源限制 + 只监听 127.0.0.1；与扩展 /ui 的取舍一致）
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${title} — BastionShell CLI</title>
<link rel="stylesheet" href="/xterm/xterm.css?token=${encodeURIComponent(token)}">
<style>
  html,body{margin:0;height:100%;background:#1e1e1e;color:#ccc;font-family:system-ui,sans-serif}
  #bar{height:28px;display:flex;align-items:center;gap:12px;padding:0 10px;background:#252526;font-size:12px}
  #bar a{color:#4daafc;text-decoration:none}
  #bar select{background:#1e1e1e;color:#ccc;border:1px solid #3c3c3c;font-size:12px;padding:1px 4px}
  #term{position:absolute;top:28px;left:0;right:0;bottom:0}
</style></head>
<body>
<div id="bar"><b>BastionShell CLI</b>
  <select id="sess" title="切换会话">
    ${list.map((s) => `<option value="${s.id}"${s.id === current ? ' selected' : ''}>${s.name}（${s.id}）</option>`).join('')}
  </select>
  <span id="stat">连接中…</span>
  <a href="/ui?token=${encodeURIComponent(token)}" target="_blank">行动面板</a></div>
<div id="term"></div>
<script src="/xterm/xterm.js?token=${encodeURIComponent(token)}"></script>
<script src="/xterm/addon-fit.js?token=${encodeURIComponent(token)}"></script>
<script>
  const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000,
    theme: { background: '#1e1e1e' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  fit.fit();

  document.getElementById('sess').addEventListener('change', (ev) => {
    const id = ev.target.value;
    location.href = '/term?token=' + encodeURIComponent(${JSON.stringify(token)}) + '&session=' + encodeURIComponent(id);
  });
  const sessQ = new URLSearchParams(location.search).get('session');
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
    '/term/ws?token=' + encodeURIComponent(${JSON.stringify(token)}) +
    (sessQ ? '&session=' + encodeURIComponent(sessQ) : ''));
  const stat = document.getElementById('stat');
  ws.onopen = () => {
    stat.textContent = '已连接';
    sendSize();
    term.focus();
  };
  ws.onclose = () => { stat.textContent = '已断开'; };
  ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'in', d })); });

  function sendSize() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  }
  window.addEventListener('resize', () => { fit.fit(); sendSize(); });
</script></body></html>`
}

/** 只允许读这几个文件（防止路径穿越） */
function assetFor(urlPath: string): string | undefined {
  const map: Record<string, string> = {
    '/xterm/xterm.js': path.join(XTERM_DIR, 'xterm.js'),
    '/xterm/xterm.css': XTERM_CSS,
    '/xterm/addon-fit.js': FIT_JS
  }
  return map[urlPath]
}

export async function startTermServer(opts: TermServerOptions): Promise<TermServer> {
  const log = opts.log ?? (() => undefined)
  const token = opts.token
  const sessions = opts.sessions
  if (sessions.length === 0) throw new Error('TermServer 至少要一条会话')
  const pick = (url: URL): TermSessionRef => {
    const want = (url.searchParams.get('session') ?? '').trim().toLowerCase()
    if (!want) return sessions[0]
    return (
      sessions.find((s) => s.id.toLowerCase() === want) ??
      sessions.find((s) => s.name.toLowerCase() === want) ??
      sessions[0]
    )
  }
  const authed = (url: URL): boolean => url.searchParams.get('token') === token

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!authed(url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('需要 ?token=…（token 见 mcp-cli.json）')
      return
    }
    if (url.pathname === '/' || url.pathname === '/term') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page(opts.title, token, sessions.map((s) => ({ id: s.id, name: s.name })), pick(url).id))
      return
    }
    if (url.pathname === '/ui/actions') {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
      const sess = (url.searchParams.get('session') ?? '').trim() || undefined
      void (async () => {
        try {
          const r = opts.panel
            ? await opts.panel.actions(sess, limit)
            : { html: '', groupsTotal: 0 }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(r))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })()
      return
    }
    if (url.pathname === '/ui/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ working: opts.panel?.working() ?? 0 }))
      return
    }
    if (url.pathname === '/ui/cancel') {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let body = ''
      req.on('data', (d) => (body += String(d)))
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}') as { jobId?: string }
          if (j.jobId) opts.panel?.cancel(j.jobId)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400).end()
        }
      })
      return
    }
    if (url.pathname === '/ui/stream') {
      // 极简 SSE：有变化就推一条；另外每 20s 心跳（防代理掐断）
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      const unsub = opts.panel?.subscribe(() => {
        res.write('event: action\ndata: {}\n\n')
      })
      const hb = setInterval(() => res.write(': ping\n\n'), 20_000)
      req.on('close', () => {
        clearInterval(hb)
        unsub?.()
      })
      return
    }
    if (url.pathname === '/ui') {
      void renderUi(res, token)
      return
    }
    const asset = assetFor(url.pathname)
    if (asset && fs.existsSync(asset)) {
      const type = asset.endsWith('.css') ? 'text/css' : 'application/javascript'
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'max-age=3600' })
      res.end(fs.readFileSync(asset))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  async function renderUi(res: http.ServerResponse, tok: string, sessionId?: string): Promise<void> {
    try {
      const list = (opts.listActions ?? loadActionRecords)(300)
      // 面板页是"全量"视图；按会话筛选走 /ui/actions?session=（页面会自己刷新）
      const html = renderStandalonePanel(await list, tok, { embed: false, theme: 'dark', limit: 100 })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`面板渲染失败：${(e as Error).message}`)
    }
  }

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/term/ws' || !authed(url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const send = (d: Buffer): void => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'out', d: d.toString('base64') }))
      }
      const onData = (d: Buffer): void => send(d)
      const target = pick(url)
      target.session.onData(onData)
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw)) as { t?: string; d?: string; cols?: number; rows?: number }
          if (m.t === 'in' && typeof m.d === 'string') target.session.write(m.d)
          else if (m.t === 'resize' && m.cols && m.rows) target.session.resize(m.cols, m.rows)
        } catch {
          /* 忽略坏帧 */
        }
      })
      ws.on('close', () => {
        // EngineSession 没有"取消订阅"接口；靠 closed 标记让回写自然失效
        log('网页终端断开')
      })
      log('网页终端已连接')
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `http://127.0.0.1:${port}/term?token=${encodeURIComponent(token)}`
  log(`网页终端：${url}`)

  return {
    url,
    port,
    async close() {
      await new Promise<void>((resolve) => {
        for (const client of wss.clients as Set<WebSocket>) {
          try {
            client.close()
          } catch {
            /* ignore */
          }
        }
        wss.close(() => resolve())
      })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
