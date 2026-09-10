import * as fs from 'fs';
import * as vscode from 'vscode';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import type { ConnectionProfile } from './profiles';
import { log } from './log';
import { setSlot, clearSlot, progressBar } from './status';
import { isPasswordPrompt, resolvePasswordPrompts } from './recognize';

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
  private client: Client;
  private channels = new Set<ClientChannel>();
  private dead = false;
  readonly ready: Promise<void>;
  private closeListeners: Array<() => void> = [];
  private mfaPrompter: MfaPrompter = defaultMfaPrompter;
  /** 认证成功的时间戳（0 = 还没连上），状态栏用来算「已连多久」 */
  private connectedAtMs = 0;

  constructor(profile: ConnectionProfile, password: string, passphrase: string) {
    this.profile = profile;
    this.client = new Client();

    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });

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
      readyResolve();
    });

    this.client.on('error', (err) => {
      log(`SSH 错误（${profile.name}）: ${err.message}`);
      readyReject(err); // ready 已 resolve 时为 no-op
    });

    this.client.on('close', () => {
      // 若认证尚未完成就断连，让 ready 拒绝（否则 openShell 会一直悬挂）
      readyReject(new Error('连接被远端关闭'));
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
        readyReject(e as Error);
      }
    }
    if (password) {
      config.password = password;
    }

    try {
      this.client.connect(config);
      this.client.setNoDelay(true); // 关闭 Nagle，降低交互延迟
    } catch (e) {
      readyReject(e as Error);
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
