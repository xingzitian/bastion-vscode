import * as vscode from 'vscode';
import type { ConnectionProfile } from './profiles';

/**
 * 侧边栏树节点：一个连接档案。
 *
 * 单击语义：**单击 = 连接**（本视图的主操作）。行内也放了一个连接按钮，
 * 右键菜单里主操作/编辑/删除三组齐全 —— 三种入口都能做到同一件事，
 * 不必猜「点一下会发生什么」。
 */
export class BastionTreeItem extends vscode.TreeItem {
  constructor(public readonly profile: ConnectionProfile) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    const port = profile.port && profile.port !== 22 ? `:${profile.port}` : '';
    const modeTag = profile.mode === 'direct' ? '直连' : '堡垒机';
    this.description = `${profile.username}@${profile.host}${port} · ${modeTag}`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**单击：连接这台机器**`,
        '',
        `- 模式：${modeTag}${profile.mode === 'direct' ? '（直接 SSH，无选机/选用户）' : '（连上后过菜单选目标机）'}`,
        `- 认证：${profile.authMethod === 'key' ? '私钥' : '密码'}${profile.mode === 'bastion' ? ' + MFA' : ''}`,
        `- 地址：\`${profile.username}@${profile.host}:${profile.port || 22}\``,
        '',
        '右键可：连接 / 编辑档案（打开 profiles.jsonc）/ 删除档案'
      ].join('\n')
    );
    this.contextValue = 'profile';
    this.iconPath = new vscode.ThemeIcon(profile.mode === 'direct' ? 'terminal' : 'vm');
    this.command = {
      command: 'bastion.connectProfile',
      title: '连接',
      arguments: [this],
    };
  }
}

export class BastionProfilesProvider implements vscode.TreeDataProvider<BastionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BastionTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly loadProfiles: () => ConnectionProfile[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: BastionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): BastionTreeItem[] {
    return this.loadProfiles().map((p) => new BastionTreeItem(p));
  }
}
