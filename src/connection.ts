import * as fs from 'fs';
import * as vscode from 'vscode';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import type { ConnectionProfile } from './profiles';
import { log } from './log';
import { setSlot, clearSlot, progressBar } from './status';
import { isPasswordPrompt, resolvePasswordPrompts } from './recognize';
import { isAuthFailure } from './authError';

/** MFA 倒计时：显示在状态栏 mfa 槽位（右下角），提示 TOTP 动态码剩余有效期 */
let mfaTimer: NodeJS.Timeout | null = null;

export function startMfaCountdown(): void {
  stopMfaCountdown();
  const tick = (): void => {
    const remain = 30 - (Math.floor(Date.now() / 1000) % 30);
    setSlot('mfa', {
      text: `$(key) MFA 剩余 ${remain}s  ${progressBar(remain / 30, 20)}`,
      tooltip: 'MFA 动态验证码有效期（每 30 秒刷新）',
    });
  };
  tick();
  mfaTimer = setInterval(tick, 500);
}

export function stopMfaCountdown(): void {
  if (mfaTimer) {
    clearInterval(mfaTimer);
    mfaTimer = null;
  }
  clearSlot('mfa');
}

/** MFA 提问器：返回用户输入的动态码。终端可用它把输入改到终端内 */
export type MfaPrompter = (prompt: string) => Promise<string>;

/** 兜底：用 VS Code 输入框（通常会被终端的 in-terminal 输入接管） */
async function defaultMfaPrompter(prompt: string): Promise<string> {
  void vscode.window.showInformationMessage('堡垒机请求 MFA 动态验证码，请在输入框输入');
  const ans = await vscode.window.showInputBox({
    prompt: `请输入 MFA 动态验证码：${prompt || '服务器二次验证'}`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: '动态验证码（每 30 秒变化）',
  });
  if (ans === undefined) {
    throw new Error('用户取消 MFA');
  }
  return ans;
}

/**
 * 一条已认证的 SSH 连接。
 * 认证成功后，可反复调用 openShell() 在**同一条连接**上开多个 shell 通道，
 * 实现「一次 MFA，多开会话」。
 */
export class SharedConnection {
  readonly profile: ConnectionProfile;
  private client!: Client;
  private channels = new Set<ClientChannel>();
  private dead = false;
  /** 「认证完成」的 promise。重试时会换成一个新的，所以不是 readonly */
  private ready: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private closeListeners: Array<() => void> = [];
  private mfaPrompter: MfaPrompter = defaultMfaPrompter;
  /** 认证成功的时间戳（0 = 还没连上），状态栏用来算「已连多久」 */
  private connectedAtMs = 0;
  /** 这次认证过程中问过动态码吗？（决定失败时该说「动态码错了」还是「密码错了」） */
  private mfaAsked = false;
  /**
   * 这次握手是**认证没通过**（而不是「用着用着断了」）。
   * 作用：认证失败后 ssh2 也会发 close，若照常走「连接已断开 → 弹重连提示」那条路，
   * 重试期间就会莫名其妙弹一个提示、还会把连接从池子里删掉。所以这条标志要拦住它。
   */
  private authFailed = false;

  /** 这次认证问过动态码没有 —— 供错误翻译用 */
  get mfaAttempted(): boolean {
    return this.mfaAsked;
  }

  /** 本次握手用的凭据（重试时沿用密码，只重新问动态码） */
  private readonly password: string;
  private readonly passphrase: string;

  /** 等这条连接认证完成（重试期间会指向新的 promise，所以用方法而不是直接暴露字段） */
  waitReady(): Promise<void> {
    return this.ready;
  }

  constructor(profile: ConnectionProfile, password: string, passphrase: string) {
    this.profile = profile;
    this.password = password;
    this.passphrase = passphrase;
    this.ready = this.newReady();
    this.handshake();
  }

  /** 造一个新的「认证完成」promise，并记下它的 resolve/reject */
  private newReady(): Promise<void> {
    return new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
  }

  /**
   * 重新握手（认证失败重试用）。
   *
   * 为什么不「丢掉旧对象、建一个新的」：**对象身份不变**才不会牵动一堆引用
   * （连接池、终端手里的引用、close 监听、端口转发都指着同一个对象）。
   * 这里只换底层 ssh2 Client，并把 `ready` 换成一个新的 promise。
   *
   * 密码沿用 —— 重试只重新问动态码，用户不用从「新建连接」再来一遍。
   * 旧 client 先摘监听再关：否则它 close 时会走「连接已断开 → 弹重连？」那条路，
   * 而重试正在自动进行，再弹一个提示只会更懵。
   */
  retryAuth(): Promise<void> {
    this.teardownClient();
    this.mfaAsked = false;
    this.authFailed = false; // 这次是全新一次握手，别被上一次的认证失败标志影响
    this.dead = false; // 对象又要活过来了：否则连接池会认为它已死、状态栏也会显示错
    this.ready = this.newReady();
    this.handshake();
    return this.ready;
  }

  /** 摘掉旧 client 的监听并关掉它（不触发 dead / close 通知） */
  private teardownClient(): void {
    const old = this.client;
    if (!old) return;
    try {
      old.removeAllListeners();
      old.end();
    } catch (e) {
      log(`关闭旧连接失败（${this.profile.name}）: ${(e as Error).message}`);
    }
  }

  /** 发起一次握手：新建 ssh2 Client、挂事件、连接 */
  private handshake(): void {
    const profile = this.profile;
    const password = this.password;
    const passphrase = this.passphrase;
    this.client = new Client();

    this.client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      log(`keyboard-interactive 挑战（${prompts.map((p) => p.prompt).join(' | ')}）`);
      void this.answerPrompts(prompts, password)
        .then((answers) => finish(answers))
        .catch((e) => {
          stopMfaCountdown();
          log(`MFA 应答失败: ${(e as Error).message}`);
          finish([]);
        });
    });

    this.client.on('ready', () => {
      this.connectedAtMs = Date.now();
      log(`认证成功（${profile.name}），连接可供复用`);
      this.readyResolve?.();
    });

    this.client.on('error', (err) => {
      if (isAuthFailure(err)) this.authFailed = true;
      log(`SSH 错误（${profile.name}）: ${err.message}`);
      this.readyReject?.(err); // ready 已 resolve 时为 no-op
    });

    this.client.on('close', () => {
      // 若认证尚未完成就断连，让 ready 拒绝（否则 openShell 会一直悬挂）
      this.readyReject?.(new Error('连接被远端关闭'));
      // 认证失败的收尾交给重试逻辑：这里既不算「断了」，也不该弹重连提示
      if (this.authFailed) return;
      if (!this.dead) {
        this.dead = true;
        log(`连接已断开（${profile.name}）`);
        const cbs = this.closeListeners.slice();
        this.closeListeners = [];
        for (const cb of cbs) cb();
      }
    });

    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
      readyTimeout: 60000, // 留足 MFA 输入时间
      keepaliveInterval: 30000, // 空闲保活，防止断连
      tryKeyboard: true, // 关键：允许 keyboard-interactive（堡垒机 MFA 必需）
    };
    if (profile.authMethod === 'key' && profile.privateKeyPath) {
      try {
        config.privateKey = fs.readFileSync(profile.privateKeyPath);
        if (passphrase) {
          config.passphrase = passphrase;
        }
      } catch (e) {
        this.readyReject?.(e as Error);
      }
    }
    if (password) {
      config.password = password;
    }

    try {
      this.client.connect(config);
      this.client.setNoDelay(true); // 关闭 Nagle，降低交互延迟
    } catch (e) {
      this.readyReject?.(e as Error);
    }
  }

  get isAlive(): boolean {
    return !this.dead;
  }

  /** 认证成功时间（0 = 尚未连上），用于显示「已连 12m」 */
  get connectedAt(): number {
    return this.connectedAtMs;
  }

  /** 这条连接上还开着几个 shell 通道（「复用 N 个会话」） */
  get channelCount(): number {
    return this.channels.size;
  }

  /** 底层 ssh2 Client（供端口转发 forwardIn/forwardOut 用） */
  get rawClient(): Client {
    return this.client;
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  /** 终端接管 MFA 输入（改成在终端内输动态码） */
  setMfaPrompter(p: MfaPrompter): void {
    this.mfaPrompter = p;
  }

  private async answerPrompts(
    prompts: Array<{ prompt: string; echo?: boolean }>,
    password: string
  ): Promise<string[]> {
    const answers: string[] = [];
    // 密码提示的文案是**厂商相关**的（password / 密码 / 口令 / パスワード…），
    // 写死三种会在别人的堡垒机上把密码提示当成 MFA 动态码来问。规则可配置，见 recognize.ts。
    const pwPatterns = resolvePasswordPrompts((k) => vscode.workspace.getConfiguration('bastion').get(k));
    for (const p of prompts) {
      if (isPasswordPrompt(p.prompt, pwPatterns)) {
        answers.push(password);
      } else {
        this.mfaAsked = true; // 问过动态码了：失败时才知道该说「动态码错了」
        startMfaCountdown();
        try {
          answers.push(await this.mfaPrompter(p.prompt));
        } finally {
          stopMfaCountdown();
        }
      }
    }
    return answers;
  }

  async openShell(cols: number, rows: number): Promise<ClientChannel> {
    await this.ready;
    if (this.dead) {
      throw new Error('连接已断开');
    }
    return new Promise<ClientChannel>((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        this.channels.add(stream);
        stream.once('close', () => this.channels.delete(stream));
        resolve(stream);
      });
    });
  }

  end(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.client.end();
    } catch (e) {
      log(`关闭连接失败（${this.profile.name}）: ${(e as Error).message}`);
    }
  }
}

/** 连接池：按档案名缓存已认证连接，实现连接复用（一次 MFA，多开会话） */
export class ConnectionManager {
  private connections = new Map<string, SharedConnection>();

  get(profile: ConnectionProfile): SharedConnection | undefined {
    const c = this.connections.get(profile.name);
    return c && c.isAlive ? c : undefined;
  }

  getOrCreate(profile: ConnectionProfile, password: string, passphrase: string): SharedConnection {
    const existing = this.get(profile);
    if (existing) {
      return existing;
    }
    const conn = new SharedConnection(profile, password, passphrase);
    this.connections.set(profile.name, conn);
    conn.onClose(() => {
      if (this.connections.get(profile.name) === conn) {
        this.connections.delete(profile.name);
      }
    });
    return conn;
  }

  dispose(): void {
    for (const conn of this.connections.values()) {
      conn.end();
    }
    this.connections.clear();
  }
}
