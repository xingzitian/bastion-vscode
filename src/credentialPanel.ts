/**
 * 「凭据管理」面板（VS Code Webview）。
 *
 * 为什么要有它：密码在两边各自加密保存（扩展 SecretStorage / 桌面 DPAPI），
 * 以前谁都不知道"本机到底存了哪些密码、哪个档案还用着、哪些是改名留下的垃圾"。
 * 这个面板把两边的**元数据**并成一张表（清单见 core/credentialIndex），并提供
 * 设置 / 替换 / 查看 / 删除 / 测试连接 / 切换认证方式 —— 全部在这里做完，
 * 不用再去手改 `profiles.jsonc` 或猜钥匙串。
 *
 * 分两层，便于测试：
 *   - `buildCredentialsHtml(cspSource, model)`：纯函数，只负责把模型渲染成 HTML；
 *   - `CredentialPanel`：管 webview 生命周期、读模型、处理按钮消息。
 */

import * as vscode from 'vscode'
import { getProfiles, saveProfiles, getPassword, savePassword, deletePassword, getPassphrase, savePassphrase, deletePassphrase } from './profiles'
import type { ConnectionProfile } from './profiles'
import { readIndex, dropKey, credentialIndexPath, type CredentialEntry } from './core/credentialIndex'
import { log } from './log'
import { ensureConnection } from './sessions'
import { manager } from './state'

export interface CredentialSlot {
  has: boolean
  /** 哪些产品存了这份（vscode / desktop），空 = 没有 */
  owners: string[]
  updatedAt: string
}

export interface CredentialRow {
  name: string
  target: string
  authMethod: string
  password: CredentialSlot
  passphrase: CredentialSlot
}

export interface OrphanRow {
  key: string
  owners: string[]
  kinds: string[]
  updatedAt: string
}

export interface CredentialsModel {
  rows: CredentialRow[]
  orphans: OrphanRow[]
  indexFile: string
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function slotOf(entries: CredentialEntry[], key: string, kind: 'password' | 'passphrase', localHas: boolean): CredentialSlot {
  const mine = entries.filter((e) => e.key === key && e.kind === kind)
  const owners = new Set(mine.map((e) => e.owner))
  if (localHas) owners.add('vscode')
  const updatedAt = mine.map((e) => e.updatedAt).sort().pop() ?? ''
  return { has: owners.size > 0, owners: [...owners].sort(), updatedAt }
}

function slotText(slot: CredentialSlot): string {
  if (!slot.has) return '<span class="no">未存</span>'
  const who = slot.owners.map((o) => (o === 'vscode' ? '扩展' : '桌面')).join(' + ')
  const when = slot.updatedAt ? slot.updatedAt.slice(0, 16).replace('T', ' ') : ''
  return `<span class="ok">已存</span> <span class="who">${esc(who)}</span>${when ? ` <span class="when">${esc(when)}</span>` : ''}`
}

/** 纯函数：模型 → HTML（单测盯它，避免模板里漏转义/漏插值） */
export function buildCredentialsHtml(cspSource: string, model: CredentialsModel): string {
  const nonce = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
  const rows = model.rows
    .map((r) => {
      const keyAuth = r.authMethod === 'key'
      return `<tr>
  <td class="name">${esc(r.name)}<div class="target">${esc(r.target)}</div></td>
  <td>${keyAuth ? '<span class="badge">密钥</span>' : '<span class="badge">密码</span>'}</td>
  <td>${slotText(r.password)}</td>
  <td>${slotText(r.passphrase)}</td>
  <td class="ops">
    <button data-cmd="setPassword" data-name="${esc(r.name)}">${r.password.has ? '替换密码' : '设置密码'}</button>
    ${r.password.has ? `<button data-cmd="revealPassword" data-name="${esc(r.name)}">查看</button>` : ''}
    ${r.password.has ? `<button class="danger" data-cmd="deletePassword" data-name="${esc(r.name)}">删除密码</button>` : ''}
    <button data-cmd="setPassphrase" data-name="${esc(r.name)}">${r.passphrase.has ? '替换口令' : '设置口令'}</button>
    ${r.passphrase.has ? `<button class="danger" data-cmd="deletePassphrase" data-name="${esc(r.name)}">删除口令</button>` : ''}
    <button data-cmd="test" data-name="${esc(r.name)}">测试连接</button>
    <button data-cmd="switchAuth" data-name="${esc(r.name)}">改用${keyAuth ? '密码' : '密钥'}认证</button>
  </td>
</tr>`
    })
    .join('\n')

  const orphans = model.orphans
    .map(
      (o) => `<tr>
  <td class="name">${esc(o.key)}<div class="target">${esc(o.kinds.join(' / '))}${o.updatedAt ? ' · ' + esc(o.updatedAt.slice(0, 16).replace('T', ' ')) : ''}</div></td>
  <td>${esc(o.owners.map((x) => (x === 'vscode' ? '扩展' : '桌面')).join(' + '))}</td>
  <td class="ops">${o.owners.includes('vscode') ? `<button class="danger" data-cmd="dropOrphan" data-name="${esc(o.key)}">删除（扩展侧）</button>` : '<span class="no">请到桌面里删</span>'}</td>
</tr>`
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 10px; }
  h2 { font-size: 13px; margin: 4px 0 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { font-weight: 600; opacity: .8; }
  .name { font-weight: 600; }
  .target { font-weight: 400; opacity: .7; font-size: 11px; }
  .badge { padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .ok { color: var(--vscode-charts-green); }
  .no { opacity: .6; }
  .who { opacity: .8; }
  .when { opacity: .5; font-size: 11px; }
  .ops { white-space: nowrap; }
  button { margin: 0 4px 4px 0; padding: 2px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
  .section { margin-top: 18px; }
  .muted { opacity: .65; font-size: 11px; }
  .empty { opacity: .6; padding: 8px 0; }
</style>
</head>
<body>
<h2>凭据（本机）</h2>
<div class="muted">密码与口令都是加密保存的：扩展存在 VS Code 钥匙串，桌面存在 Windows DPAPI。
这里只合并显示"有没有、存在哪、什么时候存的"，**不显示明文**（点「查看」才会在输入框里出现一次）。</div>
<table>
  <thead><tr><th>档案</th><th>认证</th><th>密码</th><th>私钥口令</th><th>操作</th></tr></thead>
  <tbody>
${rows || '<tr><td colspan="5" class="empty">还没有档案。先在「连接档案」里加一台机器。</td></tr>'}
  </tbody>
</table>

<div class="section">
  <h2>孤儿凭据${model.orphans.length > 0 ? `（${model.orphans.length}）` : ''}</h2>
  <div class="muted">下面这些存着密码，但档案表里已经没有这个名字了（改过名 / 删过档案）。
  它们还能被清掉，但先看清楚是不是改名留下的 —— 改名的话下次保存档案会自动搬过去。</div>
  <table>
    <thead><tr><th>名字</th><th>存在哪</th><th>操作</th></tr></thead>
    <tbody>
${orphans || '<tr><td colspan="3" class="empty">没有孤儿凭据。</td></tr>'}
    </tbody>
  </table>
</div>

<div class="section muted">清单文件：${esc(model.indexFile)}（只有元数据，不含密码）</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    vscode.postMessage({ type: btn.dataset.cmd, name: btn.dataset.name });
  });
</script>
</body>
</html>`
}

/** 面板与消息处理 */
export class CredentialPanel {
  public static current: CredentialPanel | undefined
  private panel: vscode.WebviewPanel

  static show(ctx: vscode.ExtensionContext): CredentialPanel {
    if (CredentialPanel.current) {
      CredentialPanel.current.panel.reveal()
      void CredentialPanel.current.refresh()
      return CredentialPanel.current
    }
    const panel = vscode.window.createWebviewPanel('bastion.credentials', 'BastionShell 凭据', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true
    })
    const inst = new CredentialPanel(ctx, panel)
    CredentialPanel.current = inst
    return inst
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    panel: vscode.WebviewPanel
  ) {
    this.panel = panel
    panel.onDidDispose(() => {
      CredentialPanel.current = undefined
    })
    panel.webview.onDidReceiveMessage((msg: { type?: string; name?: string }) => void this.onMessage(msg))
    void this.refresh()
  }

  async refresh(): Promise<void> {
    const model = await this.buildModel()
    this.panel.webview.html = buildCredentialsHtml(this.panel.webview.cspSource, model)
  }

  private async buildModel(): Promise<CredentialsModel> {
    const profiles = getProfiles(this.ctx)
    const index = readIndex()
    const rows: CredentialRow[] = []
    for (const p of profiles) {
      const pw = await getPassword(this.ctx, p.name)
      const pp = await getPassphrase(this.ctx, p.name)
      rows.push({
        name: p.name,
        target: `${p.username}@${p.host}:${p.port ?? 22}`,
        authMethod: p.authMethod === 'key' ? 'key' : 'password',
        password: slotOf(index, p.name, 'password', pw !== ''),
        passphrase: slotOf(index, p.name, 'passphrase', pp !== undefined)
      })
    }
    const names = new Set(profiles.map((p) => p.name))
    const orphanKeys = [...new Set(index.filter((e) => !names.has(e.key)).map((e) => e.key))]
    const orphans: OrphanRow[] = orphanKeys.map((key) => {
      const mine = index.filter((e) => e.key === key)
      return {
        key,
        owners: [...new Set(mine.map((e) => e.owner))].sort(),
        kinds: [...new Set(mine.map((e) => e.kind))].map((k) => (k === 'password' ? '密码' : '私钥口令')),
        updatedAt: mine.map((e) => e.updatedAt).sort().pop() ?? ''
      }
    })
    return { rows, orphans, indexFile: credentialIndexPath() }
  }

  private findProfile(name: string): ConnectionProfile | undefined {
    return getProfiles(this.ctx).find((p) => p.name === name)
  }

  private async onMessage(msg: { type?: string; name?: string }): Promise<void> {
    const name = (msg.name ?? '').trim()
    if (!name) return
    try {
      switch (msg.type) {
        case 'setPassword': {
          const p = await vscode.window.showInputBox({
            prompt: `新密码（${name}）—— 只存在本机钥匙串，不写进档案文件`,
            password: true,
            ignoreFocusOut: true
          })
          if (p === undefined || p === '') return
          await savePassword(this.ctx, name, p)
          // 换了密码之后，池子里那条旧连接还捏着旧密码（见 connection.forget 的注释）
          manager.forget(name)
          log(`凭据面板：已更新「${name}」的密码`)
          break
        }
        case 'revealPassword': {
          const p = await getPassword(this.ctx, name)
          if (!p) {
            void vscode.window.showInformationMessage(`「${name}」本机没有存密码。`)
            return
          }
          await vscode.window.showInputBox({
            prompt: `「${name}」当前保存的密码（只在本机显示，可直接复制）`,
            value: p,
            ignoreFocusOut: true
          })
          break
        }
        case 'deletePassword': {
          const ok = await vscode.window.showWarningMessage(`删除「${name}」保存的密码？`, { modal: true }, '删除')
          if (ok !== '删除') return
          await deletePassword(this.ctx, name)
          manager.forget(name)
          log(`凭据面板：已删除「${name}」的密码`)
          break
        }
        case 'setPassphrase': {
          const p = await vscode.window.showInputBox({
            prompt: `私钥口令（${name}）—— 这把私钥本身没有口令就留空后回车`,
            password: true,
            ignoreFocusOut: true
          })
          if (p === undefined) return
          await savePassphrase(this.ctx, name, p)
          manager.forget(name)
          log(`凭据面板：已更新「${name}」的私钥口令`)
          break
        }
        case 'deletePassphrase': {
          const ok = await vscode.window.showWarningMessage(`删除「${name}」保存的私钥口令？`, { modal: true }, '删除')
          if (ok !== '删除') return
          await deletePassphrase(this.ctx, name)
          manager.forget(name)
          log(`凭据面板：已删除「${name}」的私钥口令`)
          break
        }
        case 'test': {
          const profile = this.findProfile(name)
          if (!profile) {
            void vscode.window.showErrorMessage(`找不到档案「${name}」`)
            return
          }
          const conn = await ensureConnection(profile)
          if (!conn) return // 用户取消了输入
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `正在测试 ${name}…` },
            async () => conn.waitReady()
          )
          void vscode.window.showInformationMessage(`「${name}」连接测试通过（${profile.username}@${profile.host}）`)
          log(`凭据面板：连接测试通过（${name}）`)
          break
        }
        case 'switchAuth': {
          const profile = this.findProfile(name)
          if (!profile) return
          const toKey = profile.authMethod !== 'key'
          const detail = toKey
            ? '切到密钥认证后，登录用私钥（可选口令）。已保存的**密码**可以保留（切回来还能用），也可以现在就删掉。'
            : '切回密码认证后，登录要输密码。已保存的私钥口令同样可以保留或删除。'
          const pick = await vscode.window.showWarningMessage(
            `把「${name}」改成${toKey ? '密钥' : '密码'}认证？`,
            { modal: true, detail },
            '只改认证方式',
            toKey ? '改并删除已存密码' : '改并删除已存口令'
          )
          if (!pick) return
          const next = { ...profile, authMethod: toKey ? ('key' as const) : ('password' as const) }
          saveProfiles(
            this.ctx,
            getProfiles(this.ctx).map((p) => (p.name === name ? next : p))
          )
          if (pick === '改并删除已存密码') await deletePassword(this.ctx, name)
          if (pick === '改并删除已存口令') await deletePassphrase(this.ctx, name)
          manager.forget(name)
          log(`凭据面板：${name} → ${toKey ? '密钥' : '密码'}认证`)
          break
        }
        case 'dropOrphan': {
          const ok = await vscode.window.showWarningMessage(
            `删除「${name}」这条孤儿凭据（扩展侧）？`,
            { modal: true, detail: '如果桌面里也存了这一条，需要到桌面里删（那边不归这里管）。' },
            '删除'
          )
          if (ok !== '删除') return
          await deletePassword(this.ctx, name)
          await deletePassphrase(this.ctx, name)
          const left = readIndex().filter((e) => e.key === name)
          if (left.length === 0) dropKey(name)
          log(`凭据面板：已清理孤儿「${name}」`)
          break
        }
        default:
          return
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`凭据面板操作失败：${(e as Error).message}`)
      log(`凭据面板操作失败（${msg.type}/${name}）：${(e as Error).message}`)
    }
    await this.refresh()
  }
}

