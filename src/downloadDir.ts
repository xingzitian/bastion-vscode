import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { configDir } from './config';

/**
 * 「下载存到哪儿」的唯一出处。
 *
 * 背景（2026-09-15 真机故障）：原来人工下载（用户在终端里自己敲 `sz`）是在
 * **ZMODEM 握手中途弹一个「选择保存目录」对话框** —— 于是 ZRINIT 发不出去，
 * 对端重发的 ZRQINIT 撞上刚启动的会话，报 `Unhandled header: ZRQINIT`，下载全废。
 *
 * 结论：协议握手期间**不能等任何人**。目录必须是"已经定好的"，选择动作放到传输之外：
 *   - 想固定一个目录 → `bastion.downloadDir` 设置，或者命令 `BastionShell: 设置下载目录`；
 *   - 不设 → 落到工作区的 `.bastion-downloads/`（这样 AI 和你的文件工具都能直接读它），
 *     没有工作区就落到 `~/.bastionshell/downloads/`。
 *
 * 这条规则和 `bastion_pull` 的默认落点**刻意一致** —— 人工下载和 AI 下载不该有两个说法。
 */

/** 展开设置里可能写的 `~`（用户很自然会这么写） */
export function expandHome(p: string): string {
  const t = p.trim();
  if (!t) return '';
  if (t === '~') return os.homedir();
  if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(os.homedir(), t.slice(2));
  return t;
}

/** 默认下载目录：工作区 `.bastion-downloads/`，没有工作区就用 `~/.bastionshell/downloads/` */
export function defaultDownloadDir(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return path.join(folders[0].uri.fsPath, '.bastion-downloads');
  }
  try {
    return path.join(configDir(), 'downloads');
  } catch {
    return path.join(os.tmpdir(), 'bastion-downloads');
  }
}

/**
 * 解析人工下载的落盘目录 —— **同步、绝不弹窗**（弹窗会把握手拖死，见文件头注释）。
 * 优先级：`bastion.downloadDir` 设置 > 工作区默认目录。
 */
export function resolveDownloadDir(): string {
  const cfg = vscode.workspace.getConfiguration('bastion').get<string>('downloadDir', '');
  const dir = expandHome(typeof cfg === 'string' ? cfg : '');
  return dir || defaultDownloadDir();
}

/** `BastionShell: 设置下载目录` —— 把「选目录」这件事放到传输外面来做 */
export async function setDownloadDir(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: '选为下载保存目录',
    defaultUri: vscode.Uri.file(resolveDownloadDir()),
  });
  if (!picked || picked.length === 0) return;
  const dir = picked[0].fsPath;
  await vscode.workspace
    .getConfiguration('bastion')
    .update('downloadDir', dir, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`BastionShell：以后下载的文件保存到 ${dir}`);
}

/** `BastionShell: 打开发送/下载目录`（临时想换个地方时用） */
export async function clearDownloadDir(): Promise<void> {
  await vscode.workspace
    .getConfiguration('bastion')
    .update('downloadDir', undefined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`BastionShell：下载目录已恢复默认（${defaultDownloadDir()}）`);
}
