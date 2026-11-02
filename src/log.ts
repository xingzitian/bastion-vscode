import * as vscode from 'vscode';
import { configureCore } from './core/ports'

let _out: vscode.OutputChannel | null = null;
export function outChannel(): vscode.OutputChannel {
  if (!_out) _out = vscode.window.createOutputChannel('BastionShell');
  return _out;
}

/**
 * 详细日志开关（对应设置 bastion.verboseLog）。
 *
 * 有些诊断信息（ZMODEM 握手帧的原始十六进制等）平时打出来只会把日志刷满、
 * 把真正有用的行挤没，但排查协议问题时又非要不可。
 * 所以做成开关，而不是"要么一直打、要么彻底删掉"。
 */
let verbose = false;
export function setVerboseLogging(v: boolean): void {
  verbose = v;
  log(`详细日志已${v ? '开启' : '关闭'}（bastion.verboseLog）`);
}
export function isVerboseLogging(): boolean {
  return verbose;
}

export function log(msg: string): void {
  outChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/** 只在详细模式下打的日志 */
export function logVerbose(msg: string): void {
  if (verbose) log(msg);
}

// ── core 的 Logger 端口接在这里 ─────────────────────────────────────────
// core 不能 import vscode，所以它在启动时通过 configureCore 拿到 logger；
// 这里把 vscode 的 OutputChannel 适配成那个接口（verbose 走 bastion.verboseLog）。
let coreConfigured = false
export function wireCoreLogger(): void {
  if (coreConfigured) return
  coreConfigured = true
  configureCore({
    logger: {
      info: (m) => log(m),
      error: (m) => log(`[error] ${m}`),
      verbose: (m) => logVerbose(m)
    }
  })
}