import * as vscode from 'vscode'
import { terminals } from './state'
import type { BastionTerminal } from './terminal'
import { getActiveTransfers, getTransferHistory } from './transfer'
import { listRunningDeploys } from './deployRunning'
import { getLastDeployReport, getDeployTerminalPolicy } from './deployRun'
import { listActiveForwards, stopForward } from './forward'
import { abortDeployTask } from './deployRun'
import { fmtBytes, fmtDuration, fmtSpeed, progressBar } from './status'
import { log, outChannel } from './log'

/**
 * 「总览与进度」面板 —— 停在右侧辅助侧边栏里的一个固定小窗。
 *
 * 为什么做这个：状态栏那些格子只能靠**悬停**看详情，悬停本来就难用（要停在原位、
 * 一动就消失，也没法点里面的东西）。所以把会话 / 传输 / 部署 / 转发全集中到一个
 * 能一直看着、能直接点按钮的面板里。
 *
 * ⚠️ 平台限制（说清楚免得误解）：VS Code **没有**「右下角悬浮小窗」这种 API ——
 * 没有任何接口能创建浮在工作台右下角、始终置顶的窗口。能做到「固定 + 可交互 + 有进度条」
 * 的对应物就是**停靠式视图**。这里选右侧辅助侧边栏（而不是底部面板），
 * 因为底部面板要留给终端 —— 堡垒机操作基本都盯着终端，右侧才能两者兼顾。
 * 面板本身可以被拖到别的容器，VS Code 会记住。
 *
 * 刷新策略：状态变化时由各处调用 refresh()；同时面板可见时每 1 秒自刷一次，
 * 这样「速率 / 剩余时间 / 已连时长」这类跟时间相关的数字才会动。
 */

interface OverviewSession {
  no: number
  name: string
  profile: string
  host: string
  mode: string
  ready: boolean
  readOnly: boolean
  upMs: number
  reused: number
  active: boolean
}

interface OverviewTransfer {
  name: string
  direction: 'send' | 'receive'
  received: number
  total: number
  ratio: number
  speed: number
  remainMs: number
  elapsedMs: number
}

interface OverviewDeploy {
  taskId: string
  name: string
  done: number
  total: number
  ratio: number
  elapsedMs: number
}

interface OverviewForward {
  id: string
  label: string
  from: string
  to: string
  profile: string
}

interface OverviewState {
  hasAny: boolean
  sessions: OverviewSession[]
  transfers: OverviewTransfer[]
  deploys: OverviewDeploy[]
  forwards: OverviewForward[]
  overwrite: string
  /** 「部署结束保留终端」开关的当前状态（面板上那个按钮要显示开/关） */
  keepTerminal: boolean
  recent: Array<{ name: string; ok: boolean; size: string; dir: string }>
  /** 最近一次部署的结果（跑完多久都能回来点开报告） */
  lastDeploy: { name: string; okCount: number; total: number; agoMs: number } | null
}

export class OverviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'bastion.overview'
  private view: vscode.WebviewView | null = null
  private timer: NodeJS.Timeout | null = null

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = renderHtml(view.webview)
    view.webview.onDidReceiveMessage((msg: { type?: string; [k: string]: unknown }) => {
      void this.onMessage(msg)
    })
    view.onDidChangeVisibility(() => {
      if (view.visible) this.startTimer()
      else this.stopTimer()
    })
    if (view.visible) this.startTimer()
    this.refresh()
  }

  /** 面板可见时每秒自刷一次（速率/剩余时间/已连时长这些要动） */
  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => this.refresh(), 1000)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.stopTimer()
  }

  /** 把最新状态推给面板。面板没打开时什么都不做（不产生开销） */
  refresh(): void {
    if (!this.view) return
    const state = collectState()
    void this.view.webview.postMessage({ type: 'state', data: state })
  }

  /** 展开面板（点状态栏任意格子都会走这里） */
  async reveal(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${OverviewProvider.viewId}.focus`)
    } catch (e) {
      log(`展开总览面板失败: ${(e as Error).message}`)
    }
  }

  private async onMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    const no = typeof msg.no === 'number' ? msg.no : -1
    const find = (): { vt: vscode.Terminal; term: BastionTerminal } | undefined => {
      for (const [vt, term] of terminals) if (term.sessionNo === no) return { vt, term }
      return undefined
    }
    switch (msg.type) {
      case 'focusSession': {
        find()?.vt.show()
        break
      }
      case 'toggleReadOnly': {
        const s = find()
        if (s) {
          const on = s.term.setReadOnly(!s.term.isReadOnly)
          log(`总览面板：${on ? '开启' : '关闭'}只读 —— ${s.vt.name}`)
        }
        break
      }
      case 'closeSession': {
        find()?.vt.dispose()
        break
      }
      case 'stopForward': {
        const id = String(msg.id ?? '')
        stopForward(id)
        log(`总览面板：已停止转发 ${id}`)
        break
      }
      case 'stopDeploy': {
        abortDeployTask(String(msg.taskId ?? ''))
        break
      }
      case 'action':
        await runAction(String(msg.name ?? ''))
        break
      default:
        log(`总览面板收到未知消息：${JSON.stringify(msg)}`)
    }
    this.refresh()
  }
}

/** 面板上的全局快捷操作 */
async function runAction(name: string): Promise<void> {
  switch (name) {
    case 'newConnection':
      await vscode.commands.executeCommand('bastion.connect')
      break
    case 'newSession':
      await vscode.commands.executeCommand('bastion.pickSession')
      break
    case 'openLog':
      outChannel().show()
      break
    case 'openTransferHistory':
      await vscode.commands.executeCommand('bastion.showTransferHistory')
      break
    case 'stopAllForwards':
      await vscode.commands.executeCommand('bastion.stopAllForwards')
      break
    case 'pickOverwrite':
      await vscode.commands.executeCommand('bastion.pickOverwriteMode')
      break
    case 'openHabits':
      await vscode.commands.executeCommand('bastion.openHabitsFile')
      break
    case 'openLastReport':
      await vscode.commands.executeCommand('bastion.openLastDeployReport')
      break
    case 'toggleKeepTerminal':
      await vscode.commands.executeCommand('bastion.toggleKeepDeployTerminal')
      break
    default:
      log(`总览面板收到未知操作：${name}`)
  }
}

/** 汇总当前所有要展示的状态 */
function collectState(): OverviewState {
  const now = Date.now()
  const activeVt = vscode.window.activeTerminal

  const sessions: OverviewSession[] = [...terminals.entries()].map(([vt, term]) => ({
    no: term.sessionNo,
    name: vt.name.replace(/^#\d+\s*/, ''),
    profile: term.profile?.name ?? '',
    host: term.profile?.host ?? '',
    mode: term.profile?.mode === 'direct' ? '直连' : '堡垒机',
    ready: term.conn.connectedAt > 0 && term.conn.isAlive,
    readOnly: term.isReadOnly,
    upMs: term.conn.connectedAt > 0 ? now - term.conn.connectedAt : 0,
    reused: term.conn.channelCount,
    active: vt === activeVt
  }))

  const transfers: OverviewTransfer[] = getActiveTransfers().map((t) => {
    const total = t.bytesTotal > 0 ? t.bytesTotal : t.bytesSent
    const elapsed = now - t.startedAt
    const speed = elapsed > 400 && t.bytesSent > 0 ? t.bytesSent / (elapsed / 1000) : 0
    const remain = total - t.bytesSent
    return {
      name: t.name,
      direction: t.direction,
      received: t.bytesSent,
      total,
      ratio: total > 0 ? Math.min(1, t.bytesSent / total) : 0,
      speed,
      remainMs: speed > 0 && remain > 0 ? (remain / speed) * 1000 : 0,
      elapsedMs: elapsed
    }
  })

  const deploys: OverviewDeploy[] = listRunningDeploys().map((d) => ({
    taskId: d.taskId,
    name: d.taskName,
    done: d.done,
    total: d.total,
    ratio: d.total > 0 ? Math.min(1, d.done / d.total) : 0,
    elapsedMs: now - d.startedAt
  }))

  const forwards: OverviewForward[] = listActiveForwards().map((r) => ({
    id: r.id,
    label: r.label,
    from: `${r.localHost}:${r.localPort}`,
    to: `${r.remoteHost}:${r.remotePort}`,
    profile: r.profileId
  }))

  const recent = getTransferHistory()
    .slice(0, 5)
    .map((r) => ({ name: r.name, ok: r.ok === true, size: fmtBytes(r.bytesSent), dir: r.direction === 'send' ? '↑' : '↓' }))

  const overwriteRaw = vscode.workspace.getConfiguration('bastion').get<string>('uploadOverwrite', 'skip')
  const overwrite = { skip: '跳过', overwrite: '覆盖', rename: '改名' }[overwriteRaw] ?? '跳过'
  const keepTerminal = getDeployTerminalPolicy() === 'keep'

  const lr = getLastDeployReport()
  const lastDeploy = lr ? { name: lr.name, okCount: lr.okCount, total: lr.total, agoMs: now - lr.at } : null

  return {
    hasAny: sessions.length > 0 || transfers.length > 0 || deploys.length > 0 || forwards.length > 0,
    sessions,
    transfers,
    deploys,
    forwards,
    overwrite,
    keepTerminal,
    recent,
    lastDeploy
  }
}

function renderHtml(webview: vscode.Webview): string {
  return buildOverviewHtml(webview.cspSource)
}

/**
 * 生成面板 HTML（纯函数，便于单测）。
 *
 * 单测能抓一类很隐蔽的 bug：面板 JS 写在 TS 模板字符串里，
 * 里面任何一个忘记转义的 `${...}` 都会被 TS 当插值吃掉，产物变成一段
 * 坏掉的 JS —— 面板打开是一片空白，而且编译期毫无提示。
 */
export function buildOverviewHtml(cspSource: string): string {
  const nonce = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { --gap: 10px; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px 10px 16px;
    margin: 0;
  }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .06em; opacity: .7; margin: 14px 0 6px;
  }
  h2:first-child { margin-top: 4px; }
  .empty { opacity: .55; font-style: italic; padding: 4px 0; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 5px; padding: 7px 8px; margin-bottom: 6px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .row { display: flex; align-items: center; gap: 6px; }
  .row + .row { margin-top: 4px; }
  .grow { flex: 1; min-width: 0; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { opacity: .7; font-size: .92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge {
    font-size: .85em; padding: 1px 5px; border-radius: 3px; white-space: nowrap;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .badge.warn { background: var(--vscode-statusBarItem-warningBackground, #b89500); color: #fff; }
  .badge.err  { background: var(--vscode-statusBarItem-errorBackground, #a1260d); color: #fff; }
  .badge.ok   { background: var(--vscode-testing-iconPassed, #3fb950); color: #fff; }
  .bar-wrap { margin-top: 5px; }
  .bar-track { height: 6px; border-radius: 3px; background: rgba(128,128,128,.28); overflow: hidden; }
  .bar-fill { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); }
  button {
    font-family: inherit; font-size: .9em; cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
    border: none; border-radius: 3px; padding: 2px 7px; white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.35)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div id="root"><div class="empty">正在读取状态…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m < 60 ? m + 'm' + (s % 60 ? (s % 60) + 's' : '') : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
  };
  const bytes = (n) => {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
  };
  const bar = (ratio) => \`<div class="bar-track"><div class="bar-fill" style="width:\${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%"></div></div>\`;
  const btn = (label, msg, cls) =>
    \`<button class="\${cls || ''}" data-msg='\${esc(JSON.stringify(msg))}'>\${esc(label)}</button>\`;

  function render(s) {
    const parts = [];

    parts.push('<h2>会话 ' + (s.sessions.length ? '(' + s.sessions.length + ')' : '') + '</h2>');
    if (!s.sessions.length) {
      parts.push('<div class="empty">还没有会话</div>');
    } else {
      for (const x of s.sessions) {
        const state = x.ready
          ? '<span class="badge ok">已认证</span>'
          : '<span class="badge err">已断开</span>';
        const ro = x.readOnly ? '<span class="badge warn">只读</span>' : '';
        const cur = x.active ? '<span class="badge">当前</span>' : '';
        parts.push('<div class="card">' +
          '<div class="row"><span class="title">#' + x.no + ' ' + esc(x.name) + '</span>' + state + ro + cur + '</div>' +
          '<div class="row sub">' + esc(x.mode) + ' · 已连 ' + dur(x.upMs) + ' · 复用 ' + x.reused + ' 会话</div>' +
          '<div class="row">' +
            btn(x.active ? '已在前面' : '聚焦', { type: 'focusSession', no: x.no }, x.active ? '' : 'primary') +
            btn(x.readOnly ? '解除只读' : '设为只读', { type: 'toggleReadOnly', no: x.no }) +
            btn('关闭', { type: 'closeSession', no: x.no }) +
          '</div></div>');
      }
    }

    parts.push('<h2>传输 ' + (s.transfers.length ? '· 进行中 ' + s.transfers.length : '') + '</h2>');
    if (!s.transfers.length) {
      parts.push('<div class="empty">没有进行中的传输</div>');
    } else {
      for (const t of s.transfers) {
        parts.push('<div class="card">' +
          '<div class="row"><span class="title">' + (t.direction === 'send' ? '↑ 上传' : '↓ 下载') + ' ' + esc(t.name) + '</span>' +
          '<span class="badge">' + Math.round(t.ratio * 100) + '%</span></div>' +
          '<div class="row sub mono">' + bytes(t.received) + ' / ' + bytes(t.total) +
            (t.speed ? ' · ' + bytes(t.speed) + '/s · 剩 ' + dur(t.remainMs) : '') +
            ' · 已用 ' + dur(t.elapsedMs) + '</div>' +
          bar(t.ratio) +
        '</div>');
      }
    }
    if (s.recent.length) {
      parts.push('<div class="row sub" style="flex-wrap:wrap;gap:4px">最近：' +
        s.recent.map((r) => '<span class="badge' + (r.ok ? '' : ' err') + '">' + r.dir + ' ' + esc(r.name) + ' ' + esc(r.size) + '</span>').join('') +
        '</div>');
    }

    if (s.deploys.length) {
      parts.push('<h2>部署</h2>');
      for (const d of s.deploys) {
        parts.push('<div class="card">' +
          '<div class="row"><span class="title">' + esc(d.name) + '</span>' +
          '<span class="badge">' + d.done + '/' + d.total + '</span></div>' +
          '<div class="row sub">已用 ' + dur(d.elapsedMs) + '</div>' +
          bar(d.ratio) +
          '<div class="row" style="margin-top:5px">' + btn('停止（跑完当前这台）', { type: 'stopDeploy', taskId: d.taskId }) + '</div>' +
        '</div>');
      }
    }

    parts.push('<h2>端口转发 ' + (s.forwards.length ? '(' + s.forwards.length + ')' : '') + '</h2>');
    if (!s.forwards.length) {
      parts.push('<div class="empty">没有运行中的转发</div>');
    } else {
      for (const f of s.forwards) {
        parts.push('<div class="card">' +
          '<div class="row"><span class="title">' + esc(f.label) + '</span><span class="badge ok">运行中</span></div>' +
          '<div class="row sub mono">' + esc(f.from) + ' → ' + esc(f.to) + ' · ' + esc(f.profile) + '</div>' +
          '<div class="row">' + btn('停止', { type: 'stopForward', id: f.id }) + '</div>' +
        '</div>');
      }
    }

    // 最近一次部署：跑完多久都能回来点开报告 ——
    // 以前只弹一条几秒就消失的提示，没点到就再也找不回来了
    if (s.lastDeploy) {
      const d = s.lastDeploy;
      const allOk = d.okCount === d.total;
      parts.push('<h2>最近一次部署</h2>');
      parts.push('<div class="card">' +
        '<div class="row"><span class="title">' + esc(d.name || '（未命名）') + '</span>' +
        '<span class="badge ' + (allOk ? 'ok' : 'err') + '">' + d.okCount + '/' + d.total + ' 成功</span></div>' +
        '<div class="row sub">' + dur(d.agoMs) + '前</div>' +
        '<div class="row">' + btn('打开报告', { type: 'action', name: 'openLastReport' }) + '</div>' +
      '</div>');
    }

    parts.push('<h2>快捷操作</h2>');    parts.push('<div class="actions">' +
      btn('新建连接', { type: 'action', name: 'newConnection' }, 'primary') +
      btn('切换会话', { type: 'action', name: 'newSession' }) +
      btn('上传覆盖：' + s.overwrite, { type: 'action', name: 'pickOverwrite' }) +
      btn(s.keepTerminal ? '部署后保留终端：开' : '部署后保留终端：关', { type: 'action', name: 'toggleKeepTerminal' }) +
      btn('传输历史', { type: 'action', name: 'openTransferHistory' }) +
      btn('个人习惯', { type: 'action', name: 'openHabits' }) +
      btn('停止全部转发', { type: 'action', name: 'stopAllForwards' }) +
      btn('打开日志', { type: 'action', name: 'openLog' }) +
    '</div>');

    root.innerHTML = parts.join('');
  }

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-msg]');
    if (!el) return;
    try { vscode.postMessage(JSON.parse(el.getAttribute('data-msg'))); } catch {}
  });

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data.data);
  });
</script>
</body>
</html>`
}

/** 便于其它模块在状态变化时通知面板刷新 */
let provider: OverviewProvider | null = null
export function setOverviewProvider(p: OverviewProvider): void {
  provider = p
}
export function refreshOverview(): void {
  provider?.refresh()
}
export function revealOverview(): void {
  void provider?.reveal()
}
export function disposeOverview(): void {
  provider?.dispose()
}
/** 让「展开总览面板」也能从别处直接调用（点状态栏走的就是它） */
export function showOverview(): void {
  void vscode.commands.executeCommand(`${OverviewProvider.viewId}.focus`)
}
