/**
 * 无头会话引擎（CLI 宿主的会话层）。
 *
 * 从 `terminal.ts` 里"人看见的那部分"之外剥出来的东西：
 *   - 一条 shell 通道 + 裸字节直通（终端由调用方的 pty 负责渲染）
 *   - resize（SIGWINCH → window-change）
 *   - exec 的完成判定（哨兵 / 静默规则，语义与扩展 0.3.21 **逐条一致**）
 *   - 屏幕末尾文本（给 bastion_tail / AI 看）
 *
 * 刻意**不**做的事：渲染、键盘锁、zmodem、vscode 的任何东西。
 * 判定语义复用 `core/screen.ts`，所以不会出现"两份判定"。
 */

import { isMarkerSafe, readMarkerLine, stripAnsi, stripMarker, tailText } from '../core/screen'
import { classifySessionScreen, resolveMenuHints, type SessionScreenState } from '../core/menu'

/** ssh2 ClientChannel 里我们用到的部分（测试可以塞假的） */
export interface ShellChannel {
  write(data: string | Buffer): boolean | void
  on(ev: 'data', cb: (d: Buffer) => void): unknown
  on(ev: 'close', cb: () => void): unknown
  setWindow?(rows: number, cols: number, height: number, width: number): void
}

export interface ExecOptions {
  /** 挂不了哨兵的命令用"静默"兜底：默认 3s（与扩展一致） */
  quietMs?: number
  /** 单条命令上限：默认 30 分钟 */
  maxMs?: number
  /** 习惯里记了 sudo 免密时，`sudo <命令>` 也能精确捕获 */
  allowPlainSudo?: boolean
}

export interface ExecOutcome {
  text: string
  exitCode?: number
  markerSeen: boolean
  timedOut: boolean
  elapsedMs: number
}

export interface EngineSessionOptions {
  log?: (msg: string) => void
  now?: () => number
  /** 生成哨兵（测试可固定） */
  makeMarker?: () => string
}

export class EngineSession {
  private readonly bufMax = 2 * 1024 * 1024
  private buf = ''
  private closed = false
  private closeCbs: Array<() => void> = []
  private dataCbs: Array<(d: Buffer) => void> = []
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private readonly makeMarker: () => string

  constructor(
    readonly name: string,
    private readonly chan: ShellChannel,
    opts: EngineSessionOptions = {}
  ) {
    this.log = opts.log ?? (() => undefined)
    this.now = opts.now ?? Date.now
    this.makeMarker =
      opts.makeMarker ??
      (() => `__BASTION_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}__`)

    chan.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      if (this.buf.length < this.bufMax) this.buf += s
      else this.buf = this.buf.slice(-this.bufMax) + s
      for (const cb of this.dataCbs) cb(d)
    })
    chan.on('close', () => {
      if (this.closed) return
      this.closed = true
      for (const cb of this.closeCbs) cb()
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** 把原始字节写进远端（CLI 的键盘、粘贴、AI 的执行都走这里） */
  write(data: string | Buffer): void {
    if (this.closed) return
    this.chan.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.chan.setWindow?.(rows, cols, 0, 0)
    } catch {
      /* 通道已关就算了 */
    }
  }

  /**
   * 等 shell 真的就绪（屏幕上出现 shell 提示符）。
   *
   * 为什么需要：连上后立刻 exec，**登录 banner / MOTD 还在往下刷**，
   * 这些字节会被算进这次命令的输出里（真机 2026-11-23：`run` 的 stdout 混进了
   * Debian 的版权声明和 Last login）。等提示符是最便宜、最可靠的信号。
   */
  async waitShellReady(timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.closed) return false
      if (this.screenState() === 'shell') return true
      await new Promise<void>((r) => setTimeout(r, 150))
    }
    this.log('等 shell 提示符超时（继续执行，输出里可能混入登录 banner）')
    return false
  }

  /** 屏幕最后 maxLines 行（已去 ANSI、\r 覆盖只留最后一段） */
  tail(maxLines = 80): string {
    return tailText(this.buf, maxLines)
  }

  /** 会话当前"像什么"：shell / menu / unknown（复用 core/menu 的判定） */
  screenState(): SessionScreenState {
    return classifySessionScreen(this.tail(12), resolveMenuHints(() => undefined))
  }

  onData(cb: (d: Buffer) => void): void {
    this.dataCbs.push(cb)
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      cb()
      return
    }
    this.closeCbs.push(cb)
  }

  close(): void {
    this.closed = true
    try {
      this.chan.write('\x04') // EOT：让远端 shell 收尾（关不干净也不阻塞退出）
    } catch {
      /* ignore */
    }
  }

  /**
   * 执行一条命令并按**与扩展相同的规则**判定完成：
   *   - 能挂哨兵（单行、非交互）：只认哨兵（或会话关闭 / maxMs），静默**不算**完成；
   *   - 挂不了哨兵（sudo -i 等）：静默兜底，从写出去那一刻开始计时。
   *
   * 这条规则是 0.3.21 真机修出来的（`sleep 10` 曾被 3 秒静默判成"没执行"），
   * 这里不是重新实现，而是照着 `core/screen.ts` 的判定走。
   */
  exec(command: string, opts: ExecOptions = {}): Promise<ExecOutcome> {
    const quietMs = opts.quietMs ?? 3000
    const maxMs = opts.maxMs ?? 30 * 60_000
    const startedAt = this.now()

    if (this.closed) {
      return Promise.resolve({ text: '', markerSeen: false, timedOut: false, elapsedMs: 0 })
    }

    const marker = this.makeMarker()
    const safe = isMarkerSafe(command, opts.allowPlainSudo === true)
    const cmd = safe ? `${command.replace(/\r?\n+$/, '')}; ec=$?; echo ${marker}:$ec` : command

    // 执行期间我们单独攒一份"这次命令的输出"，不与屏幕缓冲混在一起
    let buf = ''
    let quietTimer: NodeJS.Timeout | null = null
    let maxTimer: NodeJS.Timeout | null = null
    let settled = false
    let markerSeen = false
    let exitCode: number | undefined

    return new Promise<ExecOutcome>((resolve) => {
      const cleanup = (): void => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = null
        if (maxTimer) clearTimeout(maxTimer)
        maxTimer = null
        this.dataCbs = this.dataCbs.filter((cb) => cb !== onData)
        this.closeCbs = this.closeCbs.filter((cb) => cb !== onClose)
      }
      const finish = (timedOut: boolean): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          text: stripAnsi(safe ? stripMarker(buf, marker) : buf),
          exitCode,
          markerSeen: !safe || markerSeen,
          timedOut,
          elapsedMs: this.now() - startedAt
        })
      }
      const onData = (d: Buffer): void => {
        if (buf.length < this.bufMax) buf += d.toString('utf8')
        if (safe) {
          const found = readMarkerLine(buf, marker)
          if (found.seen) {
            markerSeen = true
            exitCode = found.rc
            finish(false)
            return
          }
          // 有输出 → 推迟"仍在跑"的提示（不改判定）
          if (quietTimer) clearTimeout(quietTimer)
          quietTimer = setTimeout(() => {
            if (settled) return
            this.log(`命令仍在跑（已静默 ${Math.round(quietMs / 1000)}s，等哨兵）—— 继续等，不判完成`)
            quietTimer = null
          }, quietMs)
        } else {
          if (quietTimer) clearTimeout(quietTimer)
          quietTimer = setTimeout(() => finish(false), quietMs)
        }
      }
      const onClose = (): void => finish(false)
      this.dataCbs.push(onData)
      this.closeCbs.push(onClose)

      this.write(cmd.replace(/\r\n/g, '\n') + '\r')

      // 挂不了哨兵：从写出去那一刻开始静默计时（不然遇到"一个字节不回"会干等到 maxMs）
      if (!safe) quietTimer = setTimeout(() => finish(false), quietMs)
      maxTimer = setTimeout(() => finish(true), maxMs)
    })
  }
}
