import * as vscode from 'vscode'
import * as path from 'path'
import { ZmodemEventPayload } from './zmodem'
import { readJsonFile, writeJsonFile } from './config'
import { setSlot, flashSlot, clearSlot, fmtBytes, fmtDuration, fmtSpeed, progressBar } from './status'
import { log } from './log'

/**
 * 传输追踪：把 zmodem 的进度事件接成人能看的东西。
 *
 * 之前 zmodem.ts 一直在发 start/progress/end/error（带 direction、name、bytesSent、
 * bytesTotal），但 terminal.ts 只用了 end/error，进度被直接丢掉。这里把它接起来：
 *   - 进行中 → 状态栏实时进度（百分比 + 速率 + 剩余时间）
 *   - 结束   → 状态栏回执 + 写进历史文件
 *   - 失败   → 可在「传输历史」视图里右键重试（仅上传；下载重试需要远端原始命令，不做）
 */

export interface TransferRecord {
  id: string
  direction: 'send' | 'receive'
  name: string
  bytesSent: number
  bytesTotal: number
  /** 本地文件绝对路径：上传是源文件，下载是落盘目标 */
  localPath?: string
  /** 上传用：要重试就把这批文件再传一次 */
  retryPaths?: string[]
  ok: boolean | null
  error?: string
  startedAt: number
  endedAt?: number
  /** 平均速率（字节/秒） */
  speed?: number
}

export const TRANSFER_FILE = 'transferHistory.jsonc'

export const TRANSFER_HEADER = [
  '// ============================================================',
  '// BastionShell 传输历史',
  '// ------------------------------------------------------------',
  '// 这个文件由扩展自动维护（每次上传/下载结束后写入一条），',
  '// 一般不用手改；删掉整个文件等于清空历史。',
  '// ------------------------------------------------------------',
  '// 字段说明：',
  '//   direction  "send"=上传（rz）  "receive"=下载（sz）',
  '//   name       文件名',
  '//   bytesSent  实际传输字节数',
  '//   bytesTotal 文件总字节数',
  '//   localPath  本地路径（上传是源文件，下载是落盘位置）',
  '//   ok         true=成功 false=失败',
  '//   error      失败原因（成功时没有这个字段）',
  '//   startedAt / endedAt  起止时间（毫秒时间戳）',
  '//   speed      平均速率（字节/秒）',
  '// ============================================================'
].join('\n')

/** 历史条数上限：只保留最近这些条，避免文件无限长 */
const MAX_HISTORY = 200
/** 进度首次上报前至少要有这点数据，否则速率/剩余时间会乱跳 */
const MIN_SAMPLE_MS = 400

let history: TransferRecord[] = []
let loaded = false
/** 进行中的传输：transferId -> 记录 */
const active = new Map<string, TransferRecord>()
/** 当前这批上传的本地文件路径（zmodem 的 start 事件只给文件名，要靠它反查完整路径） */
let pendingUploadPaths: string[] = []

let treeProvider: TransferHistoryProvider | null = null

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  history = readJsonFile<TransferRecord[]>(
    TRANSFER_FILE,
    [],
    (v): v is TransferRecord[] => Array.isArray(v) && v.every((x) => !!x && typeof x === 'object' && typeof (x as TransferRecord).name === 'string')
  )
}

/** 上传前登记这批文件，供 start 事件反查本地路径（上传是顺序的，所以一个变量就够） */
export function beginUpload(paths: string[]): void {
  pendingUploadPaths = paths.slice()
}

function takeLocalPath(name: string): string | undefined {
  const hit = pendingUploadPaths.find((p) => path.basename(p) === name)
  return hit
}

/** 速率统一按「已传字节 / 已用时」算平均速率：不会像瞬时速率那样疯跳，剩余时间也稳 */
function speedOf(r: TransferRecord, now: number): number {
  const elapsed = now - r.startedAt
  if (elapsed < MIN_SAMPLE_MS || r.bytesSent <= 0) return 0
  return r.bytesSent / (elapsed / 1000)
}

function renderTooltip(r: TransferRecord, now: number): vscode.MarkdownString {
  const total = r.bytesTotal > 0 ? r.bytesTotal : r.bytesSent
  const ratio = total > 0 ? r.bytesSent / total : 0
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${r.direction === 'send' ? '上传' : '下载'}：${r.name}**\n\n`)
  md.appendMarkdown(`\`${progressBar(ratio)}\` ${(ratio * 100).toFixed(0)}%\n\n`)
  md.appendMarkdown(`- 进度：${fmtBytes(r.bytesSent)} / ${fmtBytes(total)}\n`)
  const sp = speedOf(r, now)
  if (sp > 0) {
    md.appendMarkdown(`- 速率：${fmtSpeed(sp)}（平均）\n`)
    const remain = total - r.bytesSent
    if (remain > 0) md.appendMarkdown(`- 剩余：约 ${fmtDuration((remain / sp) * 1000)}\n`)
  }
  md.appendMarkdown(`- 已用：${fmtDuration(now - r.startedAt)}`)
  return md
}

/** 刷新状态栏上的传输槽位（进行中显示进度，空闲则清掉） */
function renderSlot(): void {
  const now = Date.now()
  if (active.size === 0) {
    clearSlot('transfer')
    return
  }
  // 同时多个时显示最近开始的那个，前缀标出第几个
  const list = [...active.values()].sort((a, b) => a.startedAt - b.startedAt)
  const r = list[list.length - 1]
  const total = r.bytesTotal > 0 ? r.bytesTotal : r.bytesSent
  const pct = total > 0 ? Math.floor((r.bytesSent / total) * 100) : 0
  const icon = r.direction === 'send' ? '$(cloud-upload)' : '$(cloud-download)'
  const arrow = r.direction === 'send' ? '↑' : '↓'
  const multi = list.length > 1 ? `(${list.length} 个) ` : ''
  const sp = speedOf(r, now)
  let text = `${icon} ${multi}${arrow} ${r.name} ${pct}%`
  if (sp > 0) {
    text += ` · ${fmtSpeed(sp)}`
    const remain = total - r.bytesSent
    if (remain > 0) text += ` · 剩 ${fmtDuration((remain / sp) * 1000)}`
  }
  setSlot('transfer', { text, tooltip: renderTooltip(r, now), command: 'bastion.showOverview' })
}

function persist(): void {
  ensureLoaded()
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY)
  try {
    writeJsonFile(TRANSFER_FILE, history, TRANSFER_HEADER)
  } catch (e) {
    log(`写入传输历史失败: ${(e as Error).message}`)
  }
}

function finish(r: TransferRecord, ok: boolean, error?: string): void {
  const now = Date.now()
  r.ok = ok
  r.error = error
  r.endedAt = now
  // 小文件几毫秒就传完，样本太短算不出有意义的速率 —— 存 0 会让历史里出现
  // 没意义的「0 B/s」。直接不写这个字段（JSON.stringify 会丢掉 undefined）。
  const sp = speedOf(r, now)
  r.speed = sp > 0 ? sp : undefined
  active.delete(r.id)
  renderSlot()

  history.unshift(r)
  persist()
  treeProvider?.refresh()

  const verb = r.direction === 'send' ? '上传' : '下载'
  if (ok) {
    flashSlot(
      'transfer',
      {
        text: `$(check) ${r.name} ${verb}完成 · ${fmtBytes(r.bytesSent)} · ${fmtDuration(now - r.startedAt)}`,
        tooltip: `${verb}完成\n${r.name}\n${fmtBytes(r.bytesSent)}\n平均 ${fmtSpeed(r.speed)}`,
        command: 'bastion.showTransferHistory'
      },
      5000
    )
  } else {
    flashSlot(
      'transfer',
      {
        text: `$(error) ${r.name} ${verb}失败`,
        tooltip: `${verb}失败：${error ?? '未知原因'}\n点开传输历史可重试`,
        command: 'bastion.showTransferHistory',
        backgroundColor: new vscode.ThemeColor('statusBarItem.errorBackground')
      },
      8000
    )
  }
}

/** terminal.ts 收到 zmodem 事件后转发到这里 */
export function trackTransfer(p: ZmodemEventPayload): void {
  const now = Date.now()
  const direction = p.direction ?? 'send'
  const name = p.name ?? '未命名文件'

  if (p.type === 'start') {
    // 优先用事件自带的 localPath（zmodem 现在会带上），拿不到再按文件名反查
    // pendingUploadPaths —— 只靠反查太脆：任何没走 beginUpload 的发送路径都会丢重试能力。
    const local = p.localPath ?? (direction === 'send' ? takeLocalPath(name) : undefined)
    const r: TransferRecord = {
      id: p.transferId || `${direction}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      direction,
      name,
      bytesSent: 0,
      bytesTotal: p.bytesTotal ?? 0,
      localPath: local,
      retryPaths: direction === 'send' && local ? [local] : undefined,
      ok: null,
      startedAt: now
    }
    active.set(r.id, r)
    renderSlot()
    return
  }

  if (p.type === 'progress') {
    const r = active.get(p.transferId)
    if (!r) return
    r.bytesSent = p.bytesSent ?? r.bytesSent
    if (p.bytesTotal) r.bytesTotal = p.bytesTotal
    renderSlot()
    return
  }

  if (p.type === 'end') {
    const r = active.get(p.transferId)
    const local = p.localPath ?? (direction === 'send' ? takeLocalPath(name) : undefined)
    const done: TransferRecord = r ?? {
      id: p.transferId || `x-${now}`,
      direction,
      name,
      bytesSent: p.bytesSent ?? 0,
      bytesTotal: p.bytesTotal ?? p.bytesSent ?? 0,
      localPath: local,
      retryPaths: undefined,
      ok: null,
      startedAt: now
    }
    if (direction === 'send' && done.localPath) done.retryPaths = [done.localPath]
    done.bytesSent = p.bytesSent ?? done.bytesSent
    if (p.bytesTotal) done.bytesTotal = p.bytesTotal
    finish(done, true)
    return
  }

  if (p.type === 'error') {
    const r = p.transferId ? active.get(p.transferId) : undefined
    const local = p.localPath ?? (direction === 'send' ? takeLocalPath(name) : undefined)
    const target: TransferRecord = r ?? {
      id: p.transferId || `e-${now}`,
      direction,
      name,
      bytesSent: 0,
      bytesTotal: p.bytesTotal ?? 0,
      localPath: local,
      ok: null,
      startedAt: now
    }
    finish(target, false, p.message)
  }
  // 'info' 不入历史（只是会话级的提示）
}

export function getTransferHistory(): TransferRecord[] {
  ensureLoaded()
  return history.slice()
}

/** 进行中的传输（总览面板要显示实时进度条） */
export function getActiveTransfers(): TransferRecord[] {
  return [...active.values()].sort((a, b) => a.startedAt - b.startedAt)
}

export function clearTransferHistory(): void {
  history = []
  active.clear()
  persist()
  treeProvider?.refresh()
  clearSlot('transfer')
}

export function setTransferTreeProvider(p: TransferHistoryProvider): void {
  treeProvider = p
}

// ---- 树视图 ----

export class TransferItem extends vscode.TreeItem {
  constructor(public readonly rec: TransferRecord) {
    super(rec.name, vscode.TreeItemCollapsibleState.None)
    const verb = rec.direction === 'send' ? '↑' : '↓'
    const secs = rec.endedAt ? (rec.endedAt - rec.startedAt) / 1000 : 0
    const speedTxt = rec.speed ? ` · ${fmtSpeed(rec.speed)}` : ''
    const state = rec.ok === null ? '进行中' : rec.ok ? `${secs.toFixed(1)}s` : '失败'
    this.description = `${verb} ${fmtBytes(rec.bytesSent)} · ${state}${rec.speed && rec.ok ? speedTxt : ''}`
    this.tooltip = new vscode.MarkdownString(
      [
        `**单击：不执行任何操作**（传输历史是只读记录）`,
        '',
        `**${rec.direction === 'send' ? '上传' : '下载'}：${rec.name}**`,
        '',
        `- 大小：${fmtBytes(rec.bytesSent)}${rec.bytesTotal && rec.bytesTotal !== rec.bytesSent ? ` / ${fmtBytes(rec.bytesTotal)}` : ''}`,
        `- 开始：${new Date(rec.startedAt).toLocaleString()}`,
        rec.endedAt ? `- 用时：${fmtDuration(rec.endedAt - rec.startedAt)}` : '- 状态：进行中',
        rec.speed ? `- 平均速率：${fmtSpeed(rec.speed)}` : '',
        rec.localPath ? `- 本地：\`${rec.localPath}\`` : '',
        rec.error ? `- 失败原因：${rec.error}` : '',
        '',
        rec.ok === false && rec.retryPaths?.length
          ? '右键可：重试这次上传 / 在文件夹中显示 / 复制路径'
          : '右键可：在文件夹中显示 / 复制路径'
      ]
        .filter(Boolean)
        .join('\n')
    )
    this.iconPath = new vscode.ThemeIcon(
      rec.ok === null ? 'sync~spin' : rec.ok ? (rec.direction === 'send' ? 'cloud-upload' : 'cloud-download') : 'error'
    )
    // 只有失败的上传才给重试菜单（下载重试需要远端原始命令，不做）
    this.contextValue = rec.ok === false && rec.retryPaths?.length ? 'transferFailed' : 'transfer'
  }
}

export class TransferHistoryProvider implements vscode.TreeDataProvider<TransferItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TransferItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly load: () => TransferRecord[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(e: TransferItem): vscode.TreeItem {
    return e
  }

  getChildren(): TransferItem[] {
    return this.load().map((r) => new TransferItem(r))
  }
}
