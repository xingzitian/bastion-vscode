import * as vscode from 'vscode'
import type { DeployTask } from './deploy'
import { getRunningDeploy, type RunningInfo } from './deployRunning'

/**
 * 部署任务树。
 *
 * 运行中的任务会：
 * - 把图标换成旋转的同步符号（一眼看出哪个在跑）
 * - description 里带上进度（3/8 台）
 * - contextValue 变成 deployTaskRunning → 行内按钮从 ▶ 变成 ■
 *
 * 这里通过 getRunningDeploy 回调读运行时状态，而不是直接 import deployRun —— 
 * 后者会拉进整个执行链路（终端、SSH、会话），树视图不该依赖那些。
 */
export class DeployTaskItem extends vscode.TreeItem {
  constructor(
    public readonly task: DeployTask,
    private readonly loadRunning: (taskId: string) => RunningInfo | undefined
  ) {
    super(task.name || '（未命名）', vscode.TreeItemCollapsibleState.None)
    const run = loadRunning(task.id)

    const targets = task.hosts.length > 0 ? `${task.hosts.length} 台` : '（未填目标机）'
    const base = task.profileId ? `${task.profileId} · ${targets}` : targets
    this.description = run ? `运行中 ${run.done}/${run.total} · ${base}` : base

    this.tooltip = new vscode.MarkdownString(
      [
        // 第一行就把「点一下会发生什么」说清楚 ——
        // 各视图的单击语义本来就不一样（档案=连接、快捷命令=发送、任务=打开文件），
        // 与其偷偷改成语义统一（改错会误触发部署），不如把差异写在最显眼的地方。
        run ? `**单击：打开任务文件编辑**（正在运行中；点行尾 ■ 停止）` : `**单击：打开任务文件编辑**（点行尾 ▶ 运行）`,
        '',
        `**${task.name || '（未命名）'}**`,
        '',
        `- 档案：\`${task.profileId || '（未填）'}\``,
        `- 目标机：${task.hosts.length > 0 ? task.hosts.join('、') : '_（直连档案不用填；堡垒机档案必须填）_'}`,
        `- 选用户序号：${task.userChoice === '' ? '_（不选用户）_' : task.userChoice}`,
        task.uploads.length > 0 ? `- 上传：${task.uploads.map((p) => p.split(/[\\/]/).pop()).join('、')}` : '',
        run ? `- **运行中**：已完成 ${run.done}/${run.total} 台` : '',
        '',
        run ? '右键可：停止 / 打开编辑 / 删除' : '右键可：运行 / 打开编辑 / 删除',
        '',
        `\`${task.uri.fsPath}\``
      ]
        .filter(Boolean)
        .join('\n')
    )

    this.contextValue = run ? 'deployTaskRunning' : 'deployTask'
    this.iconPath = new vscode.ThemeIcon(run ? 'sync~spin' : 'json')
    // 单击 = 打开 JSON 文件编辑；运行/停止走行内按钮和右键菜单
    this.command = { command: 'bastion.openDeployTask', title: '打开编辑', arguments: [this] }
  }
}

export class DeployTasksProvider implements vscode.TreeDataProvider<DeployTaskItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DeployTaskItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly loadTasks: () => DeployTask[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(e: DeployTaskItem): vscode.TreeItem {
    return e
  }

  getChildren(): DeployTaskItem[] {
    return this.loadTasks().map((t) => new DeployTaskItem(t, getRunningDeploy))
  }
}
