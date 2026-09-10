import { EventEmitter } from 'events';
import { basename } from 'path';
import Zmodem from 'zmodem.js';
import { log, logVerbose } from './log';

export interface ZmodemEventPayload {
  sessionId: string;
  transferId: string;
  direction: 'send' | 'receive';
  /**
   * skip = 远端已存在同名文件、按覆盖模式跳过了（**没传**）。
   * 单列一种类型而不是塞进 info：报告需要如实区分「传了」和「跳过了」，
   * 靠解析 info 的文案太脆。
   */
  type: 'start' | 'progress' | 'end' | 'error' | 'info' | 'skip';
  name?: string;
  bytesSent?: number;
  bytesTotal?: number;
  /** 本地文件路径：上传是源文件，下载是落盘目标（失败重试要用） */
  localPath?: string;
  message?: string;
}

export interface ZmodemFileInfo {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

export type OverwriteMode = 'skip' | 'overwrite' | 'rename';

export interface ZmodemSendOptions {
  overwrite?: OverwriteMode;
  skipUnchanged?: boolean;
}

/** 文件 I/O 抽象：扩展用真实 fs */
export interface ZmodemIo {
  statFiles(paths: string[]): Promise<ZmodemFileInfo[]>;
  pickDownloadDir(): Promise<string | null>;
  openWrite(dir: string, name: string): { fd: number; path: string };
  write(fd: number, data: Uint8Array): void;
  close(fd: number): void;
  openRead(path: string): number;
  read(fd: number, length: number): Buffer;
  closeRead(fd: number): void;
  hashFile(path: string, algo: 'sha256' | 'md5'): Promise<string>;
}

const READ_CHUNK = 16384;
const PROGRESS_INTERVAL_MS = 100;
let transferSeq = 0;

const RZ_FLAG: Record<OverwriteMode, string> = { skip: '', overwrite: ' -y', rename: ' -E' };

/** ZMODEM 十六进制帧签名：**\x18B（ZPAD ZPAD ZDLE ZHEX） */
const ZM_SIG = [0x2a, 0x2a, 0x18, 0x42];

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function parseHashOutput(out: string, algo: 'sha256' | 'md5'): Map<string, string> {
  const map = new Map<string, string>();
  const len = algo === 'sha256' ? 64 : 32;
  const re = new RegExp(`^([0-9a-f]{${len}})[ \\t]+(.+)$`, 'gim');
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const name = m[2].trim();
    map.set(name.startsWith('*') ? name.slice(1) : name, m[1].toLowerCase());
  }
  return map;
}

export function sanitizeName(name: string): string {
  const base = basename(name).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base || `file-${Date.now()}`;
}

/**
 * 过滤 lrzsz 数据期的 ZACK 流控帧（zmodem.js 0.1.10 发送侧数据阶段收到会抛异常）。
 */
export function stripZackHexFrames(data: Buffer): Buffer {
  const sig = [0x2a, 0x2a, 0x18, 0x42];
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    let idx = -1;
    for (let j = i; j + 6 <= data.length; j++) {
      if (data[j] === sig[0] && data[j + 1] === sig[1] && data[j + 2] === sig[2] && data[j + 3] === sig[3]) {
        idx = j;
        break;
      }
    }
    if (idx === -1) {
      for (let j = i; j < data.length; j++) out.push(data[j]);
      break;
    }
    for (let j = i; j < idx; j++) out.push(data[j]);
    const isZack = data[idx + 4] === 0x30 && data[idx + 5] === 0x33;
    if (!isZack) {
      for (let j = idx; j < idx + 4; j++) out.push(data[j]);
      i = idx + 4;
      continue;
    }
    let end = -1;
    for (let j = idx + 4; j < data.length && j < idx + 30; j++) {
      if (data[j] === 0x0a) {
        end = j + 1;
        if (j + 1 < data.length && data[j + 1] === 0x11) end = j + 2;
        break;
      }
    }
    if (end === -1) {
      for (let j = idx; j < data.length; j++) out.push(data[j]);
      break;
    }
    i = end;
  }
  return Buffer.from(out);
}

/**
 * 每个 SSH 会话一个控制器：拦截数据流，识别 ZMODEM 会话。
 * - sz（下载）：检测到 ZRQINIT → 选目录 → 逐文件落盘
 * - rz（上传）：写 rz 命令 → 等待 ZRINIT → 逐文件上传
 */
export class ZmodemSessionController extends EventEmitter {
  private sentry: any;
  private detectionRole: 'receive' | 'send' | null = null;
  private zsession: any = null;
  private roleWaiters: Array<() => void> = [];
  private destroyed = false;
  private filterZack = false;
  private capture: { buf: string } | null = null;
  /** 终端输出过滤的暂存缓冲（跨 chunk 的十六进制帧剥离） */
  private terminalCarry: number[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly writeToSession: (data: Buffer) => void,
    private readonly forwardToTerminal: (data: Buffer) => void,
    private readonly io: ZmodemIo,
    private readonly opts: { rzTimeoutMs?: number; hashTimeoutMs?: number } = {}
  ) {
    super();
    this.sentry = new Zmodem.Sentry({
      to_terminal: (octets: number[]) => {
        const filtered = this.filterTerminal(Buffer.from(octets));
        if (filtered.length > 0) {
          this.forwardToTerminal(filtered);
        }
      },
      sender: (octets: number[]) => {
        this.writeToSession(Buffer.from(octets));
      },
      on_retract: () => {
        this.emitEvent('info', { message: 'ZMODEM 检测已撤回' });
      },
      on_detect: (detection: any) => {
        const role: 'receive' | 'send' = detection.get_session_role();
        if (role === 'receive') {
          const session = detection.confirm();
          this.zsession = session;
          session.on('session_end', () => {
            this.zsession = null;
          });
          this.emitEvent('info', { message: '检测到远端 sz 文件传输，请选择保存目录' });
          void this.runReceiveSession(session);
        } else {
          this.detectionRole = 'send';
          try {
            const session = detection.confirm();
            this.zsession = session;
            session.on('session_end', () => {
              this.zsession = null;
              this.filterZack = false;
            });
          } catch (err) {
            this.emitEvent('error', { message: `ZMODEM 会话确认失败: ${err instanceof Error ? err.message : String(err)}` });
          }
          this.emitEvent('info', { message: '已进入 rz 接收模式（可上传文件）' });
        }
        for (const w of this.roleWaiters.splice(0)) w();
      },
    });
  }

  consume(data: Buffer): void {
    if (this.destroyed) {
      this.forwardToTerminal(data);
      return;
    }
    if (this.capture) this.capture.buf += data.toString('utf8');
    // 诊断：会话未建立时，含 ZDLE(0x18) 的数据多半是 ZMODEM 握手帧。
    // 只在详细日志模式下打（bastion.verboseLog）—— 平时打会把几百字节十六进制
    // 刷进日志，把真正有用的行挤没。
    if (!this.zsession && data.includes(0x18)) {
      logVerbose(`[zmodem] 握手帧 ${data.length} 字节: ${data.toString('hex').slice(0, 200)}`);
    }
    const payload: Buffer = this.filterZack ? stripZackHexFrames(data) : data;
    try {
      this.sentry.consume(payload);
    } catch (err) {
      this.emitEvent('error', {
        message: `ZMODEM 处理失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  isActive(): boolean {
    return this.zsession !== null;
  }

  abortAll(): void {
    if (this.zsession) {
      try {
        this.zsession.abort();
      } catch {
        /* ignore */
      }
      this.zsession = null;
    }
  }

  private resetSession(): void {
    this.abortAll();
    this.detectionRole = null;
    this.filterZack = false;
  }

  destroy(): void {
    this.abortAll();
    this.destroyed = true;
    this.removeAllListeners();
  }

  /** 判断 bytes 是否为 ZMODEM 十六进制帧签名 **\x18B 的前缀 */
  private isSigPrefix(bytes: number[]): boolean {
    for (let k = 0; k < bytes.length; k++) {
      if (bytes[k] !== ZM_SIG[k]) return false;
    }
    return true;
  }

  /**
   * 过滤终端输出：剥离 ZMODEM 十六进制握手帧（**\x18B + 14 hex + CR/LF[+XON]）。
   * zmodem.js 检测会话时会把这些握手帧原样抛给 to_terminal，而 xterm 不认识 ZMODEM，
   * 直接显示就成乱码（� / B010000...）。这里跨 chunk 有状态地剥离掉。
   */
  private filterTerminal(data: Buffer): Buffer {
    const all = this.terminalCarry.concat(Array.from(data));
    this.terminalCarry = [];
    const out: number[] = [];
    let i = 0;
    while (i < all.length) {
      let idx = -1;
      for (let j = i; j + 4 <= all.length; j++) {
        if (all[j] === ZM_SIG[0] && all[j + 1] === ZM_SIG[1] && all[j + 2] === ZM_SIG[2] && all[j + 3] === ZM_SIG[3]) {
          idx = j;
          break;
        }
      }
      if (idx === -1) {
        // 无签名：放行全部，仅保留可能是签名前缀的尾部（跨 chunk 拼接）
        let keep = 0;
        for (let k = 1; k <= 3 && all.length - k >= i; k++) {
          if (this.isSigPrefix(all.slice(all.length - k))) keep = k;
        }
        for (let j = i; j < all.length - keep; j++) out.push(all[j]);
        this.terminalCarry = all.slice(all.length - keep);
        break;
      }
      // 放行签名之前的字节
      for (let j = i; j < idx; j++) out.push(all[j]);
      // 找帧尾 LF（0x0a 或 lrzsz 的 0x8a）
      let lf = -1;
      const limit = Math.min(all.length, idx + 30);
      for (let j = idx + 4; j < limit; j++) {
        if (all[j] === 0x0a || all[j] === 0x8a) {
          lf = j;
          break;
        }
      }
      if (lf === -1) {
        if (all.length - idx >= 30) {
          // 30 字节内无 LF → 不是十六进制帧，放行签名并继续
          out.push(all[idx], all[idx + 1], all[idx + 2], all[idx + 3]);
          i = idx + 4;
          continue;
        }
        // 帧不完整，暂存等待下一 chunk
        this.terminalCarry = all.slice(idx);
        break;
      }
      // 完整帧：跳过整帧（含可选 XON）
      let end = lf + 1;
      if (all[end] === 0x11) end++;
      i = end;
    }
    return Buffer.from(out);
  }

  /** 上传入口：默认不做哈希比对，直接按覆盖模式启动 rz 逐个发送 */
  async sendFiles(paths: string[], options: ZmodemSendOptions = {}): Promise<void> {
    if (this.destroyed) throw new Error('会话已关闭');
    const overwrite: OverwriteMode = options.overwrite ?? 'skip';
    const skipUnchanged = options.skipUnchanged ?? false;
    const files = await this.io.statFiles(paths);
    if (files.length === 0) throw new Error('没有可发送的文件');

    let toSend = files;
    if (skipUnchanged) {
      try {
        toSend = await this.skipUnchangedFiles(files);
        if (toSend.length === 0) {
          this.emitEvent('info', { message: '全部文件均未变化，无需上传' });
          return;
        }
      } catch {
        toSend = files;
      }
    }

    if (this.detectionRole !== 'send' || !this.zsession) {
      const rzCmd = `rz${RZ_FLAG[overwrite]}`;
      // 把**实际要发的命令**和它对应的模式打进日志。
      // 覆盖模式以前只有状态栏一个显示，用户没法验证「我设的覆盖，到底发出去了什么」——
      // 出问题时只能猜。现在日志里能直接看到。
      log(`[zmodem] 启动上传：\`${rzCmd}\`（覆盖模式=${overwrite}，来自设置 bastion.uploadOverwrite）`);
      this.writeToSession(Buffer.from(`${rzCmd}\r`, 'utf8'));
      const ok = await this.waitForRole('send', this.opts.rzTimeoutMs ?? 10000);
      if (!ok) {
        this.emitEvent('error', { message: '等待服务器 rz 就绪超时（请确认目标机已装 lrzsz）' });
        throw new Error('等待 rz 就绪超时');
      }
    }

    const zsession = this.zsession ?? this.sentry.get_confirmed_session();
    if (!zsession) {
      this.emitEvent('error', { message: '无法确认 ZMODEM 会话' });
      throw new Error('ZMODEM 会话不可用');
    }

    let bytesRemaining = toSend.reduce((a, f) => a + f.size, 0);
    try {
      for (let i = 0; i < toSend.length; i++) {
        const f = toSend[i];
        bytesRemaining -= f.size;
        await this.sendOne(
          zsession,
          f,
          { files_remaining: toSend.length - i - 1, bytes_remaining: bytesRemaining },
          overwrite
        );
      }
      try {
        await zsession.close();
      } catch (err) {
        this.emitEvent('info', { message: `会话收尾: ${err instanceof Error ? err.message : String(err)}` });
      }
    } catch (err) {
      this.resetSession();
      throw err;
    }
  }

  private runShellCommand(cmd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      if (this.destroyed) {
        resolve('');
        return;
      }
      const cap = { buf: '' };
      this.capture = cap;
      const finish = (): void => {
        if (this.capture === cap) this.capture = null;
        resolve(cap.buf);
      };
      this.writeToSession(Buffer.from(cmd + '\r', 'utf8'));
      setTimeout(finish, timeoutMs);
    });
  }

  private async skipUnchangedFiles(files: ZmodemFileInfo[]): Promise<ZmodemFileInfo[]> {
    const query = async (tool: 'sha256' | 'md5'): Promise<string> => {
      const cmd = `${tool}sum -- ${files.map((f) => shellQuote(f.name)).join(' ')}`;
      const timeout = Math.max(this.opts.hashTimeoutMs ?? 3000, 800 + files.length * 400);
      return this.runShellCommand(cmd, timeout);
    };
    let out = await query('sha256');
    let tool: 'sha256' | 'md5' = 'sha256';
    if (/command not found|sha256sum:\s*not found/i.test(out)) {
      out = await query('md5');
      if (/command not found|md5sum:\s*not found/i.test(out)) return files;
      tool = 'md5';
    }
    const remote = parseHashOutput(out, tool);
    const remaining: ZmodemFileInfo[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const rh = remote.get(f.name);
      if (rh == null) {
        remaining.push(f);
        continue;
      }
      try {
        const lh = await this.io.hashFile(f.path, tool);
        if (lh === rh) {
          skipped.push(f.name);
          continue;
        }
      } catch {
        /* 本地哈希失败按"已变化"处理 */
      }
      remaining.push(f);
    }
    if (skipped.length > 0) {
      this.emitEvent('info', { message: `已跳过 ${skipped.length} 个未变化文件：${skipped.join('、')}` });
    }
    return remaining;
  }

  private async sendOne(
    zsession: any,
    f: ZmodemFileInfo,
    counters: { files_remaining: number; bytes_remaining: number },
    overwrite: OverwriteMode
  ): Promise<void> {
    const transferId = `z${++transferSeq}`;
    const offer: any = { name: f.name, size: f.size, mtime: f.mtime, mode: 0 };
    if (counters.files_remaining > 0) {
      offer.files_remaining = counters.files_remaining;
      offer.bytes_remaining = counters.bytes_remaining;
    }
    const xfer: any = await zsession.send_offer(offer);
    if (!xfer) {
      // 远端拒绝了这次传输。原因分两种情况，**必须说清是哪一种** ——
      // 以前这条消息写死「覆盖模式=跳过」，于是设了「覆盖」却仍被拒时，
      // 日志会骗人（说成是跳过模式造成的），排错方向直接跑偏。
      const why =
        overwrite === 'skip'
          ? `覆盖模式=skip：远端已存在同名文件，按设置跳过`
          : `覆盖模式=${overwrite}：我方已发出覆盖请求（rz${RZ_FLAG[overwrite]}），但**对端拒绝了**` +
            `（对端 rz 可能不支持该参数，或堡垒机在中间拦了文件传输）`;
      this.emitEvent('skip', {
        direction: 'send',
        name: f.name,
        localPath: f.path,
        message: `远端已存在 ${f.name}，未上传 —— ${why}`,
      });
      return;
    }
    this.filterZack = true;
    this.emitEvent('start', { transferId, direction: 'send', name: f.name, bytesTotal: f.size, localPath: f.path });

    let fd = -1;
    try {
      fd = this.io.openRead(f.path);
      let offset = 0;
      let sent = 0;
      let lastEmit = 0;
      while (offset < f.size) {
        const len = Math.min(READ_CHUNK, f.size - offset);
        const chunk = this.io.read(fd, len);
        offset += chunk.length;
        sent += chunk.length;
        if (offset >= f.size) {
          await xfer.end(chunk);
        } else {
          await xfer.send(chunk);
          await new Promise<void>((r) => setImmediate(r));
        }
        const now = Date.now();
        if (now - lastEmit > PROGRESS_INTERVAL_MS || offset >= f.size) {
          lastEmit = now;
          this.emitEvent('progress', {
            transferId,
            direction: 'send',
            name: f.name,
            bytesSent: sent,
            bytesTotal: f.size,
          });
        }
      }
      this.emitEvent('end', { transferId, direction: 'send', name: f.name, bytesSent: f.size, bytesTotal: f.size });
    } catch (err) {
      this.emitEvent('error', {
        transferId,
        direction: 'send',
        name: f.name,
        localPath: f.path,
        message: `上传失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    } finally {
      if (fd >= 0) {
        try {
          this.io.closeRead(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** sz 下载：接收对端会话，逐文件落盘 */
  private async runReceiveSession(zsession: any): Promise<void> {
    let dir: string | null = null;
    try {
      dir = await this.io.pickDownloadDir();
      if (!dir) {
        try {
          zsession.abort();
        } catch {
          /* ignore */
        }
        this.emitEvent('info', { message: '用户取消接收' });
        return;
      }
    } catch (err) {
      this.emitEvent('error', { message: `选择保存目录失败: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const open: Array<{ transferId: string; fd: number; name: string; path: string; received: number; total: number }> = [];

    zsession.on('offer', (xfer: any) => {
      const transferId = `z${++transferSeq}`;
      const details = xfer.get_details() ?? {};
      const name = sanitizeName(details.name ?? `file-${Date.now()}`);
      let fd = -1;
      let path = '';
      try {
        const dest = this.io.openWrite(dir, name);
        fd = dest.fd;
        path = dest.path;
      } catch (err) {
        this.emitEvent('error', {
          transferId,
          direction: 'receive',
          name,
          message: `无法创建文件: ${err instanceof Error ? err.message : String(err)}`,
        });
        try {
          zsession.abort();
        } catch {
          /* ignore */
        }
        return;
      }
      const rec = { transferId, fd, name, path, received: 0, total: details.size ?? 0, _lastEmitAt: 0 };
      open.push(rec);
      this.emitEvent('start', { transferId, direction: 'receive', name, bytesTotal: rec.total, localPath: path });

      xfer.on('complete', () => {
        try {
          this.io.close(fd);
        } catch {
          /* ignore */
        }
        this.emitEvent('end', {
          transferId,
          direction: 'receive',
          name,
          localPath: path,
          bytesSent: rec.received,
          bytesTotal: rec.total,
          message: `已保存到 ${path}`,
        });
      });
      try {
        xfer.accept({
          on_input: (payload: number[]) => {
            const buf = Buffer.from(payload);
            this.io.write(fd, buf);
            rec.received += buf.length;
            const now = Date.now();
            if (now - rec._lastEmitAt > PROGRESS_INTERVAL_MS) {
              rec._lastEmitAt = now;
              this.emitEvent('progress', {
                transferId,
                direction: 'receive',
                name,
                bytesSent: rec.received,
                bytesTotal: rec.total,
              });
            }
          },
        });
      } catch (err) {
        this.emitEvent('error', {
          transferId,
          direction: 'receive',
          name,
          message: `接收失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    zsession.on('session_end', () => {
      for (const r of open) {
        try {
          this.io.close(r.fd);
        } catch {
          /* ignore */
        }
      }
      open.length = 0;
      this.emitEvent('info', { message: 'ZMODEM 接收会话结束' });
    });

    try {
      zsession.start();
    } catch (err) {
      this.emitEvent('error', { message: `启动接收会话失败: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private waitForRole(role: 'receive' | 'send', timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.detectionRole === role && this.zsession) {
        resolve(true);
        return;
      }
      let waiter: () => void;
      const timer = setTimeout(() => {
        this.roleWaiters = this.roleWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      waiter = (): void => {
        clearTimeout(timer);
        resolve(this.detectionRole === role && this.zsession !== null);
      };
      this.roleWaiters.push(waiter);
    });
  }

  private emitEvent(type: ZmodemEventPayload['type'], extra: Partial<ZmodemEventPayload>): void {
    if (this.destroyed) return;
    const payload: ZmodemEventPayload = {
      sessionId: this.sessionId,
      transferId: extra.transferId ?? `info-${Date.now()}`,
      direction: extra.direction ?? 'send',
      type,
      ...extra,
    };
    this.emit('event', payload);
  }
}
