/**
 * 行动面板的 HTML 渲染（**纯函数，不 import vscode**）。
 *
 * 单独一层是为了能直接单测：渲染错了（漏字段、没转义、状态徽章不对）
 * 在真机上很不容易发现，但测试里一读 HTML 就知道。
 */

import type { ActionRecord, IntentGroup } from './actionLedger'

const STATUS_LABEL: Record<string, string> = {
  working: '在跑',
  input_required: '等输入',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
}

export function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function dur(ms: number | undefined): string {
  if (ms === undefined) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function renderActionsHtml(
  groups: IntentGroup[],
  opts: { sessionName?: (no: number) => string } = {}
): string {
  if (groups.length === 0) {
    return '<div class="empty">还没有 AI 动作。等它第一次执行命令，这里就会出现卡片。</div>'
  }
  const nameOf = opts.sessionName ?? ((no: number) => `#${no}`)
  const out: string[] = []
  for (const g of groups) {
    const bad = g.status === 'failed' ? ' err' : g.status === 'completed' ? ' ok' : ' run'
    out.push(`<section class="intent${bad}">`)
    out.push('<header>')
    out.push(`<span class="badge ${g.status}">${STATUS_LABEL[g.status] ?? g.status}</span>`)
    out.push(`<span class="why">${esc(g.why || '（AI 未说明这条命令为了什么）')}</span>`)
    out.push(
      `<span class="meta">${esc(nameOf(g.sessionNo))} · ${g.actions.length} 条 · ${g.steps} 步 · ${clock(g.startedAt)}` +
        `${g.endedAt ? ' · ' + dur(g.endedAt - g.startedAt) : ''}</span>`
    )
    if (g.synthetic) {
      out.push('<span class="synthetic" title="AI 没传 intentId，这些命令是按同会话 + 时间相邻归并的">按时间归并</span>')
    }
    out.push('</header>')
    out.push('<ul>')
    for (const a of g.actions) {
      const cls = a.status === 'failed' ? ' err' : a.status === 'completed' ? ' ok' : ' run'
      out.push(`<li class="act${cls}">`)
      out.push('<div class="line">')
      out.push(`<span class="badge sm ${a.status}">${STATUS_LABEL[a.status] ?? a.status}</span>`)
      out.push(`<code>${esc(a.brief || a.command)}</code>`)
      out.push(
        `<span class="meta">${a.exitCode !== undefined ? `退出码 ${a.exitCode}` : ''}` +
          `${a.elapsedMs ? (a.exitCode !== undefined ? ' · ' : '') + dur(a.elapsedMs) : ''}` +
          `${a.redacted ? ' · 已脱敏' : ''}</span>`
      )
      if (a.status === 'working') out.push(`<button data-act="cancel" data-id="${esc(a.actionId)}">取消</button>`)
      out.push('</div>')
      out.push(
        `<details><summary>看原文</summary><pre>${esc(a.command)}</pre>` +
          (a.reason ? `<div class="reason">结束原因：${esc(a.reason)}</div>` : '') +
          `</details>`
      )
      out.push('</li>')
    }
    out.push('</ul>')
    out.push('</section>')
  }
  return out.join('\n')
}

/** 供 actionPanel 复用：把记录里的 sessionNo 映射成终端名 */
export function sessionNameOf(no: number, pairs: Array<{ name: string; sessionNo: number }>): string {
  return pairs.find((p) => p.sessionNo === no)?.name ?? `#${no}`
}

export type { ActionRecord, IntentGroup }
