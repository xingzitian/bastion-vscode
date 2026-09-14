import * as vscode from 'vscode';
import { ClientChannel } from 'ssh2';
import type { ConnectionProfile } from './profiles';
import { SharedConnection } from './connection';
import { stopMfaCountdown } from './connection';
import { log } from './log';
import { ZmodemSessionController, ZmodemEventPayload, OverwriteMode } from './zmodem';
import { NodeFsZmodemIo } from './zmodemIo';
import { trackTransfer, beginUpload } from './transfer';
// 单向依赖：menu.ts 不 import terminal.ts，所以这里可以放心用它的提示符识别
import { resolveMenuHints, detectPrompt } from './menu';
import { describeConnectError, MAX_AUTH_ATTEMPTS, shouldOfferRetry } from './authError';
import {
  broadcastPayload,
  broadcastReceivers,
  getBroadcastMode,
  getBroadcastTargets,
  removeBroadcastTarget
} from './state';
import {
  detectLocalFilePath,
  InputLineTracker,
  resolveUploadPromptChoice,
  shouldHoldLocalPathInput,
  UPLOAD_PROMPT_RUN,
  UPLOAD_PROMPT_UPLOAD
} from './localPath';
import * as fs from 'fs';
import * as path from 'path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 屏幕标记：输出缓冲里的一个位置 + 打标记的时刻。
 * 菜单导航靠它做到「只看这次操作之后画出来的画面」——见 markOutput。
 */
export interface ScreenMark {
  /** 打标记的时刻，用来判断此后有没有新数据 */
  at: number
  /** 打标记时输出缓冲的长度 */
  len: number
}

/**
 * BastionTerminal：把一个 shell 通道桥接到 VS Code 终端（Pseudoterminal）。
 * 一条 SSH 连接可开多个 BastionTerminal（多开），共享认证、各自独立收发。
 * - handleInput → shell 通道 stdin（MFA 期间则收集验证码）
 * - shell stdout → onDidWrite（终端输出）
 */

export class BastionTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  private stream: ClientChannel | null = null;
  private closed = false;
  private zmodem: ZmodemSessionController | null = null;
  private cols = 120;
  private rows = 30;
  private vt: vscode.Terminal | null = null;
  private shellReadyResolve: (() => void) | null = null;
  private shellReady: Promise<void>;

  /** 最近输出的原始文本（滚动保留），用于「把终端最近输出发给 AI」 */
  private tailBuf = '';
  private static readonly TAIL_MAX = 120_000;

  /** 只读模式：只拦人工敲键盘，不影响 MFA 输入、AI 执行和部署注入 */
  private readOnly = false;
  private lastReadOnlyHint = 0;

  /** 会话号（#1、#2…），由 extension.ts 在创建时分配，仅用于显示和区分 */
  sessionNo = 0;

  /** 本次上传里被跳过的文件（远端拒绝了传输），供部署报告如实呈现 */
  private recentSkips: string[] = [];

  /** 最近一次收到远端数据的时间戳，settleScreen 靠它判断输出是否静止 */
  private lastDataAt = 0;

  /** 终端打开的时刻（算「冷启动」耗时用，见 "shell 已就绪" 那行日志） */
  private openedAt = Date.now();

  /** MFA 在终端内输入的状态 */
  private mfaBuffer = '';
  private mfaResolve: ((code: string) => void) | null = null;
  private mfaReject: ((e: Error) => void) | null = null;

  constructor(
    readonly conn: SharedConnection,
    readonly profile: ConnectionProfile
  ) {
    this.shellReady = new Promise<void>((resolve) => {
      this.shellReadyResolve = resolve;
    });
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.openedAt = Date.now();
    if (initialDimensions) {
      this.cols = Math.max(1, initialDimensions.columns);
      this.rows = Math.max(1, initialDimensions.rows);
    }
    // 接管 MFA 输入：改成在终端里直接输动态码
    this.conn.setMfaPrompter((prompt) => this.promptMfaInTerminal(prompt));
    void this.connect();
  }

  close(): void {
    this.finish(0);
  }

  /** 由 extension.ts 绑定 VS Code Terminal 对象，用于 MFA 时聚焦 */
  attachTerminal(vt: vscode.Terminal): void {
    this.vt = vt;
  }

  handleInput(data: string): void {
    if (this.mfaResolve) {
      // MFA 输入永远放行，否则只读模式下连认证都过不去
      this.handleMfaInput(data);
    } else if (this.readOnly) {
      this.notifyReadOnly();
    } else if (this.stream) {
      // 「把本地文件路径粘/拖进来」的识别：先攒出「当前这一行」，回车那一刻再看它是不是本地文件。
      // **每一块输入都要喂给攒行器** —— 只在带回车的那一块才喂的话，
      // 「粘一行、再单独按回车」永远攒不出内容，识别永远不触发。
      const fed = this.lineTracker.feed(data);
      const receivers = broadcastReceivers(this, getBroadcastTargets());

      if (fed.line !== undefined && !fed.multiLine) {
        const local = detectLocalFilePath(fed.line, (p) => {
          try {
            const st = fs.statSync(p);
            return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'none';
          } catch {
            return 'none';
          }
        });
        if (local) {
          // 这一行被本地"截胡"了：不发远端、不广播。
          // 但如果这一行的字符**已经被发出去过**（手打、或没带回车地粘），远端那行上就留着这串字符，
          // 后面再发 `rz -y` 会被接在同一行上执行 —— 用户看到的就是
          // `-bash: c:/Users/.../DeepSeek: No such file or directory`。
          // 所以先发一个 Ctrl-U（kill line）把它擦掉。
          if (this.lineEchoed) {
            this.stream.write('\x15');
            // 原样模式下这些字符也同步给过其它会话，所以对面那一行同样要擦掉，
            // 否则对面命令行上会留着半截路径，接着执行的什么都会带上去
            if (getBroadcastMode() === 'raw') {
              for (const t of receivers) t.sendRaw('\x15');
            }
            this.lineEchoed = false;
          }
          this.heldPathText = '';
          this.askUploadLocalPath(local, fed.line, receivers);
          return;
        }
      }

      // 还没回车、又看起来正在粘一个本机路径 → 先扣住不发，等下一块输入再决定
      if (shouldHoldLocalPathInput(data, this.lineTracker.current)) {
        this.heldPathText += data;
        return;
      }

      // 扣住的内容要按原顺序补发（顺序错了远端就乱了）
      const held = this.heldPathText;
      if (held) this.heldPathText = '';
      this.stream.write(held + data);
      this.lineEchoed = /[\r\n]/.test(data) ? false : true;

      // 广播：原样模式逐键镜像（桌面版的行为，vim 里改文件靠它）；整行模式按回车发一整行。
      // 注意这里传的是 `held + data` —— 补发的那段也必须一起镜像，
      // 否则原样模式下本地和别的会话从这一刻起就**对不上了**（本地有那几个字符，对面没有）。
      if (receivers.length > 0) {
        const payload = broadcastPayload(held + data, fed, getBroadcastMode());
        if (payload) {
          for (const t of receivers) t.sendRaw(payload);
        }
      }
    }
  }

  /** 直接往远端写一段输入（广播用；不走只读/MFA 判断，也不会回调 handleInput） */
  sendRaw(data: string): void {
    if (this.closed || !this.stream) return;
    try {
      this.stream.write(data);
    } catch (e) {
      log(`广播写入失败（${this.profile.name}）: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 独占通道（rsync 桥用，见 rsyncTransfer.ts）
  //
  // 为什么需要它：rsync 走的是**这条会话自己的 shell 通道**（这样才穿得过堡垒机），
  // 而同一个通道上原本跑着终端 UI 和 zmodem。协议期间必须由桥独占：
  //   - 收到：不再交给终端/zmodem（它们会把二进制当成文本或 zmodem 握手，协议就废了）
  //   - 发送：桥直接 write 通道
  // 用完必须 releaseRawBridge()，否则这个会话就永远回不到可交互状态。
  // ---------------------------------------------------------------------------
  private rawBridge: { onData: (d: Buffer) => void; onClose: () => void } | null = null;

  get hasRawBridge(): boolean {
    return this.rawBridge !== null;
  }

  acquireRawBridge(h: { onData: (d: Buffer) => void; onClose: () => void }): boolean {
    if (this.closed || !this.stream || this.rawBridge) return false;
    this.rawBridge = h;
    log(`rsync 桥接管会话通道（${this.profile.name}）`);
    return true;
  }

  releaseRawBridge(): void {
    if (this.rawBridge) {
      this.rawBridge = null;
      log(`rsync 桥已交还会话通道（${this.profile.name}）`);
    }
  }

  /** 桥往远端写（只在持有时用；写完不用管，通道归桥独占） */
  writeRawBridge(data: Buffer): void {
    if (!this.stream) return;
    try {
      this.stream.write(data);
    } catch (e) {
      log(`rsync 桥写入失败（${this.profile.name}）: ${(e as Error).message}`);
    }
  }

  /**
   * 给远端会话发信号（rsync 桥中止时用）。
   *
   * 注意：实测 OpenSSH **不认**客户端发的 signal 请求（发了没反应），所以这只是"能发就发"；
   * 真正让远端那个卡住的 rsync 收场的是客户端侧的 `--timeout`
   * （见 rsyncBridge.RSYNC_IO_TIMEOUT_SEC）。
   */
  signalRemote(name: string): void {
    try {
      this.stream?.signal?.(name);
      log(`已向远端发送信号 ${name}（${this.profile.name}）`);
    } catch (e) {
      log(`发送信号失败（${this.profile.name}）: ${(e as Error).message}`);
    }
  }

  /**
   * 跨按键块攒出「当前正在敲的这一行」（逻辑在 localPath.InputLineTracker，那里有测试）。
   * 攒行的用途：① 回车那一刻判断整行是不是本机文件路径 ② 回车时把整行同步给广播目标。
   */
  private lineTracker = new InputLineTracker();

  /** 还在「先扣住不发」的本机路径文本（等下一块输入决定是上传还是当命令执行） */
  private heldPathText = '';

  /** 远端当前那一行上是否已经有我们发过去的字符（拦下这一行时要用 Ctrl-U 擦掉） */
  private lineEchoed = false;

  /**
   * 问一句要不要把这个本地文件上传到目标机当前目录。
   *
   * `line` 是整行原文（可能不止这个路径，比如 `D:\a.txt --check`）——
   * 用户选「当命令执行」时要把**整行**发出去，只发路径等于把他后面敲的东西偷偷丢了。
   *
   * 三个结果（见 localPath.resolveUploadPromptChoice）：上传 / 执行整行 /
   * **关掉询问框 = 把整行放回命令行（不执行）**。最后这条是必需的：
   * 用户自己取消了询问，唯一不能做的就是把他敲的那一行吞掉。
   */
  private askUploadLocalPath(local: string, line: string, receivers: BastionTerminal[]): void {
    const name = path.basename(local);
    void vscode.window
      .showInformationMessage(`这是本机文件：${local}\n要上传到目标机当前目录吗？`, UPLOAD_PROMPT_UPLOAD, UPLOAD_PROMPT_RUN)
      .then(async (pick) => {
        const choice = resolveUploadPromptChoice(pick);
        if (choice === 'upload') {
          log(`识别到本地文件路径，改为上传：${local}`);
          // 上传不该广播：每台机器都要各传一次，悄悄替别人传是危险行为
          await this.upload([local]);
          return;
        }
        // 「当命令执行」和「把询问框关掉」都要**把整行落到远端命令行上**：
        // 前者立刻执行，后者只放回去不执行 —— 用户自己取消询问时，绝不能把他的这一行吞掉。
        const suffix = choice === 'run' ? '\r' : '';
        this.stream?.write(line + suffix);
        this.lineEchoed = choice === 'run' ? false : true;
        if (choice === 'run') {
          for (const t of receivers) t.sendRaw(line + '\r');
        } else {
          // 放回命令行：原样模式下必须让对面也回退到同一状态，否则从这一刻起两边就不一样了
          log(`用户取消了上传询问，已把这一行放回命令行：${line}`);
          this.emitOutput('\r\n\x1b[2m[已把这一行放回命令行，没有执行 —— 想执行就按回车，想去掉就按 Ctrl-C]\x1b[0m\r\n');
          if (getBroadcastMode() === 'raw') {
            for (const t of receivers) t.sendRaw(line);
          }
        }
      });
    // 提示里也说明一下，避免用户以为卡住了
    this.emitOutput(`\r\n\x1b[33m[检测到本地文件「${name}」，正在问你要不要上传（不想上传就选「${UPLOAD_PROMPT_RUN}」；关掉询问框＝把这一行放回命令行，不会执行）]\x1b[0m\r\n`);
  }

  /** 只读模式开关（生产环境防手滑）。返回设置后的状态 */
  setReadOnly(v: boolean): boolean {
    this.readOnly = v;
    if (!this.closed) {
      this.writeEmitter.fire(
        `\r\n\x1b[33m[只读模式${v ? '已开启：键盘输入会被拦截，查看和复制不受影响' : '已关闭'}]\x1b[0m\r\n`
      );
    }
    return this.readOnly;
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** 会话是否已结束（广播转发前要过滤掉，见 state.broadcastReceivers） */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 被只读拦住时的提示：限流，不然敲一下就刷一行 */
  private notifyReadOnly(): void {
    const now = Date.now();
    if (now - this.lastReadOnlyHint < 2500) return;
    this.lastReadOnlyHint = now;
    this.writeEmitter.fire(
      '\r\n\x1b[33m[只读模式] 键盘输入已被拦截。命令面板搜「BastionShell: 切换只读模式」，或点右下角状态栏解锁。\x1b[0m\r\n'
    );
  }

  setDimensions?(dimensions: vscode.TerminalDimensions): void {
    this.cols = Math.max(1, dimensions.columns);
    this.rows = Math.max(1, dimensions.rows);
    if (this.stream && (this.stream as any).setWindow) {
      (this.stream as any).setWindow(dimensions.rows, dimensions.columns);
    }
  }

  /**
   * 上传文件。返回**实际使用的覆盖模式**和**被跳过**的文件名。
   *
   * 为什么要连模式一起返回：以前报告只说「跳过」，设了「覆盖」却仍被跳过时，
   * 用户根本分不清是「我的设置没生效」还是「对端拒绝了覆盖」——
   * 把实际模式带出来，这两件事就分开了。
   */
  async upload(paths: string[]): Promise<{ skipped: string[]; mode: OverwriteMode }> {
    if (!this.zmodem) {
      vscode.window.showWarningMessage('会话未就绪');
      return { skipped: [], mode: 'skip' };
    }
    // 覆盖模式走配置（跳过 / 覆盖 / 改名），不在上传时弹窗打断
    const raw = vscode.workspace.getConfiguration('bastion').get<string>('uploadOverwrite', 'skip');
    const mode: OverwriteMode = raw === 'overwrite' || raw === 'rename' ? raw : 'skip';
    log(`上传 ${paths.length} 个文件：覆盖模式读出来是 ${mode}（设置 bastion.uploadOverwrite=${JSON.stringify(raw)}）`);
    beginUpload(paths); // 登记本地路径，进度器和失败重试都要用
    this.recentSkips = []; // 本次上传的跳过记录，由 zmodem 的 skip 事件填充
    try {
      await this.zmodem.sendFiles(paths, { overwrite: mode });
    } catch (e) {
      const msg = `上传失败: ${(e as Error).message}`;
      log(msg);
      vscode.window.showErrorMessage(msg);
    }
    // 上传结束后等提示符回来，再交还给调用方。
    //
    // 就这一件事：zmodem 协议结束（本地 close() 返回）不等于远端 rz 已经退出。
    // 那个窗口里发过去的命令会被 rz 吃掉（实测 10 次里 5 次，丢的时候耗时正好
    // 是 exec 的 3 秒静止兜底），而提示符就是「shell 又接管了」的信号。
    // 等不到也不报错 —— 只是慢一点，跟以前一样。
    await this.waitShellBackAfterTransfer();
    return { skipped: this.recentSkips.slice(), mode };
  }

  /** 最近一次 exec 有没有等到结束标记（false = 命令很可能没执行） */
  private execMarkerSeen = true;
  get lastExecMarkerSeen(): boolean {
    return this.execMarkerSeen;
  }

  /**
   * 传输结束后等 shell 提示符回来（最多 waitMs）。
   *
   * 为什么用「提示符」而不是「固定 sleep 一下」：提示符是远端自己发的、
   * 代表「shell 又接管了终端」，快的时候 100ms 就回来，慢就多等一会；
   * 而固定 sleep 要么不够、要么白等。返回 true = 看到提示符了。
   */
  private async waitShellBackAfterTransfer(waitMs = 3000): Promise<boolean> {
    if (this.closed || !this.stream) return true;
    const mark = this.markOutput();
    await this.settleScreen(mark, { firstMs: 800, quietMs: 400, maxMs: waitMs });
    const hints = resolveMenuHints((k) => vscode.workspace.getConfiguration('bastion').get(`menuHints.${k}`));
    const ok = detectPrompt(this.readSince(mark, 20), 'shellPrompt', hints);
    if (!ok) log('上传后没等到提示符（远端 rz 可能收尾较慢）—— 后面的命令可能不会被接受');
    return ok;
  }

  /** 等 shell 就绪（用于批量部署编排） */
  async ready(): Promise<void> {
    await this.shellReady;
  }

  /**
   * 取最近 maxLines 行输出（去掉 ANSI 颜色码、\r 覆盖、尾部空行）。
   * 用于「把终端最近输出发给 AI」——VS Code 没有 API 能读终端内容，
   * 但输出本来就经过我们这里，顺手留一份滚动缓冲即可。
   */
  getTail(maxLines = 80): string {
    return tailText(this.tailBuf, maxLines);
  }

  /** 输出统一出口：既写进 VS Code 终端，也记进滚动缓冲 */
  private emitOutput(d: Buffer | string): void {
    const s = typeof d === 'string' ? d : d.toString('utf8');
    this.writeEmitter.fire(s);
    this.tailBuf += s;
    if (this.tailBuf.length > BastionTerminal.TAIL_MAX) {
      this.tailBuf = this.tailBuf.slice(-BastionTerminal.TAIL_MAX);
    }
    this.lastDataAt = Date.now(); // settleScreen 靠它判断「输出是否静止」
  }

  /**
   * 记一个「屏幕标记」：此刻缓冲区的长度 + 时间。
   *
   * 为什么要它：tailBuf 是**滚动缓冲**，里面有上一步留下的旧菜单。
   * 输完 IP 之后再读 getTail()，旧主菜单还在里面 —— 于是「又回到输 IP」
   * 这种强特征会被旧内容误命中，直接报「IP 没被接受」。
   * 所以每次操作前先打标记，之后只看标记**之后**画出来的东西。
   */
  markOutput(): ScreenMark {
    return { at: Date.now(), len: this.tailBuf.length };
  }

  /** 取标记之后的新输出（已去 ANSI、`\r` 覆盖、尾部空行），供菜单识别使用 */
  readSince(mark: ScreenMark, maxLines = 40): string {
    return tailText(this.tailBuf.slice(safeReadStart(this.tailBuf, mark.len)), maxLines);
  }

  private safeMarkIndex(len: number): number {
    return safeReadStart(this.tailBuf, len);
  }

  /**
   * 等「从标记开始画的那一屏画完」：先等标记之后出现数据（最多 firstMs），再等输出静止 quietMs。
   *
   * 为什么用「等静止 + 读整屏」而不是「在数据流里找提示文本」——
   * 这是踩了两次坑之后改的：
   *   1. 逐块剥离 ANSI 会把被 TCP 分块的转义序列切碎（`输\x1b[32m入`），文字对不上；
   *   2. 堡垒机画菜单是「一屏一屏刷」的，中间夹着 `\r` 回行覆盖和光标移动，
   *      数据流里同一行会有好几遍叠在一起，跟屏幕上真正显示的东西不是一回事。
   * 而 readSince() 是对**整段缓冲**做「去 ANSI + `\r` 只留最后一段」的 ——
   * 拿到的就是屏幕上看到的文字（日志里 dump 出来的干净原文就是它）。
   * 所以正确做法是：等它画完，直接读屏幕。
   *
   * 返回 true = 标记之后收到了数据；false = firstMs 内一直没数据（可能已经进 shell 了）。
   */
  async settleScreen(mark: ScreenMark, opts: { firstMs?: number; quietMs?: number; maxMs?: number } = {}): Promise<boolean> {
    await this.shellReady;
    if (this.closed) return false;
    const firstMs = opts.firstMs ?? 8000;
    const quietMs = opts.quietMs ?? 800;
    const maxMs = opts.maxMs ?? 20000;
    let sawData = this.lastDataAt >= mark.at;
    for (;;) {
      const now = Date.now();
      if (this.lastDataAt >= mark.at) sawData = true;
      // 有数据，且已经静止够久 → 画完了
      if (sawData && now - this.lastDataAt >= quietMs) return true;
      // 一直没数据，且超过了「第一段」的等待窗口 → 别再等了
      if (!sawData && now - mark.at >= firstMs) return false;
      // 兜底上限：某些命令会一直输出（比如 tail -f），不能无限等
      if (now - mark.at >= maxMs) return sawData;
      await sleep(100);
    }
  }

  /** 向 shell 通道程序化写入命令（批量部署注入选机/选用户/脚本等） */
  async write(data: string): Promise<void> {
    await this.shellReady;
    if (this.stream && !this.closed) {
      this.stream.write(data);
    }
  }

  /**
   * 执行一条远程命令：写命令到终端（人实时看到回显与输出），同时抓取输出回传。
   * 完成判定优选用哨兵标记；标记不安全时退化为「输出静止 quietMs 毫秒」。
   * allowPlainSudo：当习惯文件记录该账号 sudo 免密时置 true，让 `sudo <命令>` 也能用哨兵
   * （否则一旦弹密码提示就会卡住，只能靠静止判定）。
   * 输出封顶 2MB，避免超大输出撑爆内存。
   */
  async exec(command: string, opts: { quietMs?: number; maxMs?: number; allowPlainSudo?: boolean } = {}): Promise<string> {
    await this.shellReady;
    if (this.closed || !this.stream) {
      return '';
    }
    const quietMs = opts.quietMs ?? 3000;
    const maxMs = opts.maxMs ?? 30 * 60 * 1000;
    const MAX_CAPTURE = 2 * 1024 * 1024;
    this.vt?.show(); // 聚焦终端，让人看到 AI 在做什么

    // 哨兵标记：命令结束后单独打印一行，见到即判定完成，能扛住「中间长时间静默」的命令（如 sleep 10 && echo）
    const marker = `__BASTION_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}__`;
    const safe = isMarkerSafe(command, opts.allowPlainSudo === true);
    const cmd = safe ? `${command.replace(/\r?\n+$/, '')}; echo ${marker}` : command;

    return new Promise<string>((resolve) => {
      const stream = this.stream!;
      let buf = '';
      let quietTimer: NodeJS.Timeout | null = null;
      let maxTimer: NodeJS.Timeout | null = null;
      let settled = false;
      let markerSeen = false;

      const cleanup = (): void => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = null;
        if (maxTimer) clearTimeout(maxTimer);
        maxTimer = null;
        stream.removeListener('data', onData);
        stream.removeListener('close', onClose);
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // 没等到哨兵 = 命令很可能压根没被执行（终端还被别的程序占着）。
        // 不信的代价很大：报告里看起来像「跑了但没输出」，会让人一直去查自己的脚本。
        this.execMarkerSeen = !safe || markerSeen;
        resolve(safe ? stripMarker(buf, marker) : buf);
      };
      const onData = (d: Buffer): void => {
        if (buf.length < MAX_CAPTURE) {
          buf += d.toString('utf8');
        }
        // 哨兵命中（真实输出行 == marker，而不是命令回显里的 marker）→ 立刻完成
        if (safe && hasMarkerLine(buf, marker)) {
          markerSeen = true;
          finish();
          return;
        }
        // 有新输出 → 重置「静止」计时
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };
      const onClose = (): void => finish();

      stream.on('data', onData);
      stream.on('close', onClose);
      stream.write(cmd.replace(/\r\n/g, '\n') + '\r');

      // 兜底最大超时
      maxTimer = setTimeout(finish, maxMs);
    });
  }

  private onZmodemEvent(p: ZmodemEventPayload): void {
    // 进度 / 结果全部交给传输追踪器：状态栏实时进度 + 写入传输历史
    trackTransfer(p);
    if (p.type === 'skip') {
      if (p.name) this.recentSkips.push(p.name);
      log(p.message ?? `已跳过 ${p.name ?? ''}（远端已存在）`);
    } else if (p.type === 'error') {
      const msg = p.message ?? '传输失败';
      log(msg);
      vscode.window.showErrorMessage(msg);
    } else if (p.type === 'end') {
      // 完成不再弹窗打断（状态栏会闪一条回执），只留日志
      log(`${p.direction === 'receive' ? '下载' : '上传'}完成：${p.name ?? ''}${p.message ? `（${p.message}）` : ''}`);
    } else if (p.type === 'info') {
      log(p.message ?? 'ZMODEM 提示');
    }
  }

  /** 在终端内提示并收集 MFA 验证码（输入用 * 掩码，回车提交） */
  private promptMfaInTerminal(prompt: string): Promise<string> {
    this.mfaBuffer = '';
    this.vt?.show(); // 聚焦终端，确保用户看到 MFA 提示
    this.writeEmitter.fire(`\r\n\x1b[33m请输入 MFA 动态验证码：${prompt || '服务器二次验证'}（输入后回车）\x1b[0m\r\n`);
    return new Promise<string>((resolve, reject) => {
      this.mfaResolve = resolve;
      this.mfaReject = reject;
    });
  }

  private handleMfaInput(data: string): void {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const resolve = this.mfaResolve;
        this.mfaResolve = null;
        this.mfaReject = null;
        this.writeEmitter.fire('\r\n');
        const code = this.mfaBuffer;
        this.mfaBuffer = '';
        resolve?.(code);
        return;
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.mfaBuffer.length > 0) {
          this.mfaBuffer = this.mfaBuffer.slice(0, -1);
          this.writeEmitter.fire('\b \b');
        }
      } else {
        this.mfaBuffer += ch;
        this.writeEmitter.fire('*');
      }
    }
  }

  /** 致命错误：写终端 + 弹窗 + 输出通道，然后以退出码 1 关闭 */
  private handleFatal(msg: string): void {
    log(msg);
    this.writeEmitter.fire(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
    void vscode.window.showErrorMessage(`BastionShell：${msg}`);
    this.finish(1);
  }

  /** 关闭本 shell（只关通道，不动共享连接；连接留给连接池复用） */
  private finish(exitCode: number, message?: string): void {
    if (this.closed) return;
    this.closed = true;
    // 会话没了就别再当广播目标：否则底栏台数会虚高，还会留着一堆已死对象
    removeBroadcastTarget(this);
    this.shellReadyResolve?.();
    stopMfaCountdown();
    if (this.mfaResolve) {
      const reject = this.mfaReject;
      this.mfaResolve = null;
      this.mfaReject = null;
      reject?.(new Error('终端已关闭'));
    }
    if (message !== undefined) {
      this.writeEmitter.fire(`\r\n\x1b[33m${message}\x1b[0m\r\n`);
    }
    if (this.zmodem) {
      this.zmodem.destroy();
      this.zmodem = null;
    }
    if (this.stream) {
      try {
        this.stream.close();
      } catch (e) {
        log(`关闭 shell 通道失败: ${(e as Error).message}`);
      }
      this.stream = null;
    }
    this.closeEmitter.fire(exitCode);
  }

  private async connect(): Promise<void> {
    // 认证失败自动重试：动态码 30 秒换一次，输错/输慢了是日常（实测连着错 6 次都要从头来）。
    // 重试**只重新问动态码**（密码沿用，见 ConnectionManager.recreate），
    // 而且必须在**这个位置**重试 —— 因为动态码是在终端里问的，
    // 只有到了这里 setMfaPrompter 才挂上（见 open()）。
    for (let attempt = 1; ; attempt++) {
      try {
        const stream = await this.conn.openShell(this.cols, this.rows);
        if (this.closed) {
          try {
            stream.close();
          } catch (e) {
            log(`关闭已废弃 shell 通道失败: ${(e as Error).message}`);
          }
          return;
        }
        this.stream = stream;
        this.shellReadyResolve?.();
        log(
          `shell 已就绪（${this.profile.name}）${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}` +
            // 冷启动耗时：从「点了连接」到「shell 可用」。用户体感慢的时候，这一行能区分
            // 是网络/MFA/菜单识别慢，还是我们自己的激活慢。
            `｜冷启动 ${Date.now() - this.openedAt} ms`
        );

        // ZMODEM 控制器接管数据流：sz/rz 走 zmodem.js，其余透传给终端
        this.zmodem = new ZmodemSessionController(
          `vscode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          (d) => stream.write(d),
          (d) => this.emitOutput(d),
          new NodeFsZmodemIo()
        );
        this.zmodem.on('event', (p: ZmodemEventPayload) => this.onZmodemEvent(p));

        stream.on('data', (data: Buffer) => {
          // 独占通道优先：rsync 桥在跑的时候，pty 上的字节是二进制协议，谁都不能碰
          // （终端会把它当文本渲染、zmodem 会去解析握手 —— 两边都会毁掉协议流）。
          if (this.rawBridge) {
            this.rawBridge.onData(data);
            return;
          }
          if (this.zmodem) {
            this.zmodem.consume(data);
          } else {
            this.emitOutput(data);
          }
        });
        stream.on('close', () => {
          const bridge = this.rawBridge;
          if (bridge) bridge.onClose();
          log(`远端 shell 已断开（${this.profile.name}）`);
          this.finish(0, '[会话已断开]');
        });
        stream.stderr?.on('data', (data: Buffer) => {
          if (!this.rawBridge && !this.zmodem) {
            this.emitOutput(data);
          }
        });
        return;
      } catch (e) {
        // 认证/网络类错误统一翻成人话（原始串也会留在说明里，方便搜索）
        const info = describeConnectError(e, {
          usedMfa: this.conn.mfaAttempted,
          target: `${this.profile.username}@${this.profile.host}`
        });
        log(`连接失败（${this.profile.name}）: ${info.message}`);

        const canRetry = shouldOfferRetry(info, attempt);
        if (!canRetry) {
          // 用户自己按的取消：静默收场。以前这里按失败处理 —— 会弹一个红色的
          // 「BastionShell：已取消连接」，明明是他的意思，看起来却像出了故障。
          if (info.kind === 'cancelled') {
            log(`连接已取消（${this.profile.name}）`);
            this.emitOutput(`\r\n\x1b[2m[${info.message}]\x1b[0m\r\n`);
            this.finish(0);
            return;
          }
          this.handleFatal(info.message);
          return;
        }

        // **提示 + 自动重试**，不弹「要不要重试」的窗。
        // 以前这里弹一个带按钮的警告框，必须点一下「重新输入动态码」才会重问 ——
        // 动态码 30 秒就换，为了点一个按钮把码等过期，是实打实的难受。
        // 现在只把说明写进终端（用户的视线本来就在那儿），然后直接重问。
        // 想放弃就关掉终端窗口；次数上限见 authError.MAX_AUTH_ATTEMPTS。
        this.emitOutput(`\r\n\x1b[33m[${info.message}]\x1b[0m\r\n`);
        this.emitOutput(
          `\r\n\x1b[33m[正在自动重试（第 ${attempt + 1}/${MAX_AUTH_ATTEMPTS} 次）—— 只重新问动态码，密码不用再输；` +
            `不想重试就关掉这个终端窗口]\x1b[0m\r\n`
        );
        log(`自动重试第 ${attempt + 1}/${MAX_AUTH_ATTEMPTS} 次：${info.message}`);

        // 重新握手：**同一个连接对象**换一条底层 ssh2 通道，密码沿用、只重新问动态码。
        // 对象身份不变，所以连接池、终端引用、close 监听、端口转发都不受影响。
        await this.conn.retryAuth();
      }
    }
  }
}

/**
 * 判断命令是否适合追加哨兵标记（标记永远不会打印的命令不能加，否则只能等超时）。
 * - su / sudo -i / sudo -s 会换成交互式 shell → 不适合
 * - 尾部 `&` 后台任务、`exec` 换 shell → 不适合
 * - 普通 `sudo <命令>` 本身是安全的，但只有当习惯文件确认该账号 sudo 免密
 *   （allowPlainSudo）时才启用；否则一旦弹密码提示命令就卡住，只能靠「输出静止」兜底。
 */
export function isMarkerSafe(command: string, allowPlainSudo = false): boolean {
  const c = command.trim();
  if (!c) return false;
  if (/^(sudo|su)(\s|$)/.test(c)) {
    if (!allowPlainSudo) return false;
    if (!/^sudo\s+/.test(c)) return false; // su 一律不加
    // 保守起见：只要出现 -i / -s / --login / --shell 就当交互式 shell 处理
    // （哪怕像 `sudo grep -i` 这样被误判，也只是退回静止判定，不会出错）
    if (/(^|\s)(-i|-s|--login|--shell)(\s|$)/.test(c)) return false;
  }
  if (/&\s*$/.test(c)) return false;
  if (/(^|[;&|]\s*)exec(\s|$)/.test(c)) return false;
  return true;
}

/**
 * 清掉终端输出里的 ANSI 转义序列（颜色、光标、标题等），只留可见文本。
 * ZMODEM 控制序列不在这里处理 —— 那是 zmodem.ts 的职责。
 */
export function stripAnsi(s: string): string {
  if (!s) return '';
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][A-Za-z0-9]/g, '') // 字符集切换
    .replace(/\x1b[=>78]/g, ''); // 其他单字符转义
}

/**
 * 把终端原始输出整理成人类/AI 可读的纯文本：
 * 去掉 ANSI 转义序列、按 \r 覆盖只保留最后一段（进度条）、去掉尾部空行，最后取末 maxLines 行。
 */
export function tailText(raw: string, maxLines = 80): string {
  if (!raw) return '';
  const clean = stripAnsi(raw);
  const lines: string[] = [];
  for (const line of clean.split('\n')) {
    // \r 覆盖：同一行被反复重写的进度条只保留最后一段
    const segs = line.split('\r').filter((s) => s.length > 0);
    lines.push((segs.length ? segs[segs.length - 1] : '').replace(/\s+$/, ''));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

/**
 * 读取起点：标记落在缓冲区里的位置。如果它正好把一个 ANSI 转义序列切成两半，
 * 就退回到那个 `\x1b` 再开始读。
 *
 * 为什么非要有这个函数：切出来的后半段开头会粘着 `2m` 这种残渣，
 * 而 `^\s*opt>`、`^\s*id>` 这类**行首锚定**的规则就再也匹配不上了 ——
 * 这正是之前「菜单明明在屏幕上、日志里也看得见，就是认不出来」的元凶。
 * （导出成纯函数是为了能直接测 —— 见 test/terminal.test.ts）
 */
export function safeReadStart(buf: string, len: number): number {
  if (len <= 0 || len > buf.length) return 0;
  const from = Math.max(0, len - 32);
  const esc = buf.lastIndexOf('\x1b', len - 1);
  if (esc < from) return len;
  // \x1b 之后若已出现「终止字符」（跳过 [ ] ( ) # % 这些引导符），说明这条转义序列在标记之前就结束了
  const body = buf.slice(esc + 1, len).replace(/^[\[\]()#%]/, '');
  return /[\x40-\x7e]/.test(body) ? len : esc;
}

/** 检测哨兵是否作为「独立输出行」出现（区别于命令回显里 `; echo __MARKER__` 的 token） */
function hasMarkerLine(s: string, marker: string): boolean {
  return s.split(/\r?\n/).some((line) => line.trim() === marker);
}

/** 从返回给 AI 的输出里剔除哨兵相关行（命令回显行 + 哨兵输出行） */
function stripMarker(s: string, marker: string): string {
  if (!marker) return s;
  return s
    .split(/\r?\n/)
    .filter((line) => !line.includes(marker))
    .join('\n');
}
