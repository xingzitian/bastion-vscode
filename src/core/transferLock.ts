/**
 * 传输期间的键盘锁（纯逻辑，可单测）。
 *
 * 为什么需要：`rz`/`sz` 在跑的时候终端仍然把人工按键原样送进 pty，而
 * **ESC（0x1B）正是 ZMODEM 的转义字符** —— 用户以为传完了、按一下 `↑`
 * 发出去的是 `ESC [ A`，`rz` 会把它当协议数据吃进去：传输被打断、块错乱，
 * 数据其实已经落盘大半，我们却判定"上传失败"（2026-11-18 真机）。
 *
 * 所以传输的三个阶段（前提探测 → rz/sz 传输 → 上传后校验）里，人工输入一律丢弃：
 * **丢弃而不是缓存重放** —— 缓存会在解锁瞬间把 `↑`＋回车灌进 shell，
 * 那时正好停在目标目录，等于把事故延后执行，更危险。
 *
 * 这个模块只做判定（该不该丢、还剩多少、超时没有），
 * 具体的 readOnly 切换、终端提示、状态栏由宿主做。
 */

export type TransferLockScreen = 'shell' | 'menu' | 'unknown'

export interface TransferLockOptions {
  /** 硬超时：到点必须自动解锁，防止会话异常导致键盘永久锁死。默认 10 分钟 */
  hardTimeoutMs?: number
  /**
   * 解锁的"逃生"宽限：锁定期间如果屏幕回来了 shell 提示符、且已经锁了这么久，
   * 就认为宿主自己的探测/校验卡住了（不是 rz 在跑），放行人工输入。
   * 默认 60 秒。
   */
  stuckGraceMs?: number
  now?: () => number
}

export interface TransferLockExit {
  /** 这一次退出是否真的解除了锁（嵌套调用时只有最外层为 true） */
  released: boolean
  /** 期间丢弃的按键次数 */
  dropped: number
  /** 应该恢复成"进入前的只读状态"的值（released 为 true 时才有意义） */
  restoreReadOnly: boolean
  /** 是否因为硬超时被迫解锁 */
  timedOut: boolean
}

export class TransferLock {
  private depth = 0
  private prevReadOnly = false
  private droppedCount = 0
  private enteredAt = 0
  private timedOutFlag = false

  private readonly hardTimeoutMs: number
  private readonly stuckGraceMs: number
  private readonly now: () => number

  constructor(opts: TransferLockOptions = {}) {
    this.hardTimeoutMs = opts.hardTimeoutMs ?? 10 * 60_000
    this.stuckGraceMs = opts.stuckGraceMs ?? 60_000
    this.now = opts.now ?? Date.now
  }

  get active(): boolean {
    return this.depth > 0
  }

  get dropped(): number {
    return this.droppedCount
  }

  get totalDepth(): number {
    return this.depth
  }

  /** 已经锁了多久（没锁时返回 0） */
  get heldForMs(): number {
    return this.depth > 0 ? this.now() - this.enteredAt : 0
  }

  /**
   * 进入锁。返回 true 表示这是**最外层**（宿主据此做一次提示、记住原只读状态）。
   * 嵌套进入（例如编排层先锁、内部上传再锁一次）返回 false，不重复提示。
   */
  enter(prevReadOnly: boolean): boolean {
    if (this.depth === 0) {
      this.enteredAt = this.now()
      this.droppedCount = 0
      this.timedOutFlag = false
      this.prevReadOnly = prevReadOnly
    }
    this.depth++
    return this.depth === 1
  }

  /** 退出锁。嵌套时只有最外层会 released=true（此时宿主才恢复 readOnly） */
  exit(): TransferLockExit {
    if (this.depth === 0) {
      return { released: false, dropped: 0, restoreReadOnly: this.prevReadOnly, timedOut: false }
    }
    this.depth--
    if (this.depth > 0) {
      return { released: false, dropped: this.droppedCount, restoreReadOnly: this.prevReadOnly, timedOut: this.timedOutFlag }
    }
    const out: TransferLockExit = {
      released: true,
      dropped: this.droppedCount,
      restoreReadOnly: this.prevReadOnly,
      timedOut: this.timedOutFlag
    }
    this.enteredAt = 0
    return out
  }

  /** 清空状态（会话关闭时调用，避免残留） */
  reset(): void {
    this.depth = 0
    this.prevReadOnly = false
    this.droppedCount = 0
    this.enteredAt = 0
    this.timedOutFlag = false
  }

  /**
   * 硬超时到了没有。宿主按这个返回值主动 `exitAll()`（不要指望输入来触发）。
   * 返回 true 时会把标记置上，后续 exit 的 `timedOut` 为 true。
   */
  isHardTimedOut(): boolean {
    if (this.depth === 0) return false
    if (this.now() - this.enteredAt < this.hardTimeoutMs) return false
    this.timedOutFlag = true
    return true
  }

  /** 硬超时兜底：强制清空（宿主调用后自行恢复 readOnly） */
  exitAll(): TransferLockExit {
    if (this.depth === 0) {
      return { released: false, dropped: 0, restoreReadOnly: this.prevReadOnly, timedOut: false }
    }
    const out: TransferLockExit = {
      released: true,
      dropped: this.droppedCount,
      restoreReadOnly: this.prevReadOnly,
      timedOut: true
    }
    this.depth = 0
    this.enteredAt = 0
    return out
  }

  /**
   * 这次人工输入该不该丢掉？丢掉时内部计数 +1。
   *
   * 两种放行（否则会死锁在"人在等密码、键盘却被锁着"上）：
   *   1. 屏幕明确是**登录菜单/资产菜单**（`menu`）—— 堡垒机登录要人操作；
   *   2. 屏幕已经回到 **shell 提示符**且锁了超过 `stuckGraceMs` —— 说明不是 rz 在跑，
   *      而是我们自己的探测/校验卡住了，必须让人能接手。
   *
   * 其余（`unknown`、以及刚锁上时的 `shell`）一律丢 —— 传输窗口里 rz 的输出
   * 本来就常被归类成 unknown，那里正是 ESC 会打断传输的地方。
   */
  shouldDrop(screen: TransferLockScreen): boolean {
    if (this.depth === 0) return false
    if (screen === 'menu') return false
    if (screen === 'shell' && this.heldForMs > this.stuckGraceMs) return false
    this.droppedCount++
    return true
  }
}
