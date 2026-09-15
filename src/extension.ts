/**
 * 扩展入口：只负责「装配」—— 建视图、注册命令和语言模型工具、挂文件监听。
 *
 * 具体实现按职责拆在各自模块里（原来这个文件有 1569 行，什么都在里面）：
 *   state.ts        共享状态（其它模块只能通过 setter 改）
 *   slots.ts        状态栏各槽位刷什么
 *   sessions.ts     连接、会话、堡垒机菜单导航、连接档案
 *   deployRun.ts    部署执行与报告        deployReport.ts  报告渲染（纯函数，可测）
 *   aiBridge.ts     AI 桥接（执行命令）    aiChat.ts        把终端内容发给 AI
 *   quickCmd.ts     快捷命令命令          forwardCmd.ts    端口转发命令
 *   transferCmd.ts  传输历史命令          configCmd.ts     配置文件入口
 */
import * as vscode from 'vscode'
import * as path from 'path'
import { BastionProfilesProvider } from './profilesTree'
import { DeployTasksProvider } from './deployTree'
import { QuickCommandsProvider, getQuickCommands, QUICK_COMMANDS_FILE } from './quickCommands'
import { ForwardRulesProvider, getForwardRules, FORWARD_FILE, FORWARD_HEADER } from './forward'
import {
  TransferHistoryProvider,
  getTransferHistory,
  setTransferTreeProvider,
  TRANSFER_FILE,
  TRANSFER_HEADER
} from './transfer'
import { getProfiles, PROFILES_FILE, PROFILES_HEADER } from './profiles'
import { listDeployTasks, migrateLegacyDeployTasks, migrateTaskFiles, exportDeployTasks } from './deploy'
import { HABITS_FILE } from './habits'
import { configDir } from './config'
import { disposeSlots } from './status'
import { log, setVerboseLogging } from './log'
import {
  ctx,
  manager,
  terminals,
  profilesProvider,
  deployProvider,
  quickCommandsProvider,
  forwardProvider,
  transferProvider,
  setCtx,  setActiveIsBastion,
  setProfilesProvider,
  setDeployProvider,
  setQuickCommandsProvider,
  setForwardProvider,
  setTransferProvider
} from './state'
import {
  updateStatusBar,
  updateReadOnlySlot,
  updateOverwriteSlot,
  updateKeepTerminalSlot,
  updateForwardSlot
} from './slots'
import { connect, connectProfile, addProfile, deleteProfile, reconnect, pickSession, toggleReadOnly } from './sessions'
import {
  addDeployTask,
  runDeployTask,
  stopDeployTask,
  deleteDeployTask,
  addFileToDeployTask,
  batchRunDeployTasks,
  batchConnect,
  openDeployTask,
  openLastDeployReport,
  toggleKeepDeployTerminal,
  sendLastReportToAI,
  restoreLastReport
} from './deployRun'
import { execRemote } from './aiBridge'
// 会话能力的唯一实现：语言模型工具和 MCP 工具都走它（这样两条路的行为不会分叉）
import { sessionApi } from './aiSessionApi'
import { registerMcp, showMcpInfo, stopMcp } from './mcpRegister'
import { sendSelectionToAI, sendTailToAI } from './aiChat'
import { addQuickCommand, sendQuickCommand, deleteQuickCommand, openQuickCommandsFile } from './quickCmd'
import {
  showForwards,
  stopAllForwardsCommand,
  addForwardRule,
  startForwardRule,
  stopForwardRule,
  deleteForwardRule
} from './forwardCmd'
import {
  uploadToSession,
  showTransferHistory,
  retryTransfer,
  clearTransferHistoryCommand,
  revealTransferItem,
  copyTransferPath
} from './transferCmd'
import { setDownloadDir, clearDownloadDir } from './downloadDir'
import { openConfigFile, openHabitsFile, showLog, pickOverwriteMode, openDangerRules } from './configCmd'
import { generateMenuRule } from './menuCmd'
import { toggleBroadcast, toggleBroadcastMode } from './broadcastCmd'
import { rsyncSyncToSession } from './rsyncTransfer'
import {
  OverviewProvider,
  setOverviewProvider,
  refreshOverview,
  revealOverview,
  disposeOverview
} from './overview'

export function activate(context: vscode.ExtensionContext): void {
  const activatedAt = Date.now()
  setCtx(context)
  setActiveIsBastion(false)

  updateStatusBar()

  setProfilesProvider(new BastionProfilesProvider(() => getProfiles(ctx)))
  setDeployProvider(new DeployTasksProvider(() => listDeployTasks(ctx)))
  setQuickCommandsProvider(new QuickCommandsProvider(() => getQuickCommands(ctx)))
  setForwardProvider(new ForwardRulesProvider(() => getForwardRules(ctx)))
  setTransferProvider(new TransferHistoryProvider(() => getTransferHistory()))
  setTransferTreeProvider(transferProvider)
  // 总览面板：实例只要活到 deactivate，其它模块通过 setOverviewProvider 拿到它
  const overviewProvider = new OverviewProvider()
  setOverviewProvider(overviewProvider)
  context.subscriptions.push({ dispose: () => disposeOverview() })

  // 迁移旧版 globalState 部署任务为文件
  migrateLegacyDeployTasks(ctx)
  // 老任务 .json → 带中文说明的 .jsonc（写新→验证→删旧，坏了不丢数据）
  migrateTaskFiles(ctx)

  // 恢复「最近一次部署报告」：以前它只在内存里，重启 VS Code 之后报告就再也找不回来了
  // （命令只会说「还没有生成过部署报告」），而报告是批量部署唯一的产物。
  void restoreLastReport(ctx)

  // 激活耗时写进日志：用户体感"冷启动变慢"时，这一行能直接看出是激活慢还是网络/MFA 慢
  log(`扩展激活完成：${Date.now() - activatedAt} ms（同步部分）`)

  // 详细日志开关跟着设置走
  setVerboseLogging(vscode.workspace.getConfiguration('bastion').get<boolean>('verboseLog', false))
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bastion.verboseLog')) {
        setVerboseLogging(vscode.workspace.getConfiguration('bastion').get<boolean>('verboseLog', false))
      }
      // 手动在设置里改了「部署完保留终端」，底栏那格也要跟着变
      // （不然开关显示的状态和你实际设置不一致，比没有还糟）
      if (e.affectsConfiguration('bastion.deployTerminalPolicy')) {
        updateKeepTerminalSlot()
      }
      // 改了「底栏显示哪几格」→ 立刻重刷所有常驻格子（不用重启）
      if (e.affectsConfiguration('bastion.statusBarItems')) {
        updateStatusBar()
        updateForwardSlot()
        log(`底栏格子设置已更新（bastion.statusBarItems）`)
      }
    })
  )

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('bastion.profiles', profilesProvider),
    vscode.window.registerTreeDataProvider('bastion.deployTasks', deployProvider),
    vscode.window.registerTreeDataProvider('bastion.quickCommands', quickCommandsProvider),
    vscode.window.registerTreeDataProvider('bastion.forwards', forwardProvider),
    vscode.window.registerTreeDataProvider('bastion.transfers', transferProvider),
    // 右侧辅助侧边栏里的「总览与进度」面板：点状态栏任意格子都会展开它
    vscode.window.registerWebviewViewProvider(OverviewProvider.viewId, overviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('bastion.showOverview', () => void revealOverview()),
    vscode.commands.registerCommand('bastion.connect', connect),
    vscode.commands.registerCommand('bastion.addProfile', addProfile),
    vscode.commands.registerCommand('bastion.connectProfile', connectProfile),
    vscode.commands.registerCommand('bastion.deleteProfile', deleteProfile),
    vscode.commands.registerCommand('bastion.refreshProfiles', () => profilesProvider.refresh()),
    vscode.commands.registerCommand('bastion.uploadToSession', uploadToSession),
    vscode.commands.registerCommand('bastion.addDeployTask', addDeployTask),
    vscode.commands.registerCommand('bastion.runDeployTask', runDeployTask),
    vscode.commands.registerCommand('bastion.stopDeployTask', stopDeployTask),
    vscode.commands.registerCommand('bastion.openLastDeployReport', () => void openLastDeployReport()),
    vscode.commands.registerCommand('bastion.deleteDeployTask', deleteDeployTask),
    vscode.commands.registerCommand('bastion.addFileToDeployTask', addFileToDeployTask),
    vscode.commands.registerCommand('bastion.batchRunDeployTasks', batchRunDeployTasks),
    vscode.commands.registerCommand('bastion.batchConnect', batchConnect),
    vscode.commands.registerCommand('bastion.openDeployTask', openDeployTask),
    vscode.commands.registerCommand('bastion.exportDeployTasks', () => void exportDeployTasks(ctx)),
    vscode.commands.registerCommand('bastion.exec', execRemote),
    vscode.commands.registerCommand('bastion.reconnect', () => void reconnect()),
    vscode.commands.registerCommand('bastion.openProfilesFile', () => openConfigFile(PROFILES_FILE, PROFILES_HEADER)),
    vscode.commands.registerCommand('bastion.openForwardsFile', () => openConfigFile(FORWARD_FILE, FORWARD_HEADER)),
    vscode.commands.registerCommand('bastion.openQuickCommandsFile', openQuickCommandsFile),
    vscode.commands.registerCommand('bastion.openHabitsFile', openHabitsFile),
    vscode.commands.registerCommand('bastion.openDangerRulesFile', openDangerRules),
    vscode.commands.registerCommand('bastion.sendSelectionToAI', sendSelectionToAI),
    vscode.commands.registerCommand('bastion.sendTailToAI', sendTailToAI),
    vscode.commands.registerCommand('bastion.pickSession', pickSession),
    vscode.commands.registerCommand('bastion.toggleReadOnly', toggleReadOnly),
    vscode.commands.registerCommand('bastion.toggleKeepDeployTerminal', toggleKeepDeployTerminal),
    vscode.commands.registerCommand('bastion.generateMenuRule', generateMenuRule),
    vscode.commands.registerCommand('bastion.sendLastReportToAI', sendLastReportToAI),
    vscode.commands.registerCommand('bastion.toggleBroadcast', toggleBroadcast),
    vscode.commands.registerCommand('bastion.toggleBroadcastMode', toggleBroadcastMode),
    // 右键菜单：用 rsync 增量同步（文件或目录）到当前会话。参数来自资源管理器右键
    vscode.commands.registerCommand('bastion.rsyncSyncToSession', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      rsyncSyncToSession(uri, uris)
    ),
    vscode.commands.registerCommand('bastion.pickOverwriteMode', pickOverwriteMode),
    // 查看/复制 MCP 端点信息（URL、token、给其它 AI 客户端的配置片段）
    vscode.commands.registerCommand('bastion.showMcpInfo', () => showMcpInfo()),
    vscode.commands.registerCommand('bastion.showForwards', showForwards),
    vscode.commands.registerCommand('bastion.showLog', showLog),
    vscode.commands.registerCommand('bastion.stopAllForwards', stopAllForwardsCommand),
    vscode.commands.registerCommand('bastion.showTransferHistory', showTransferHistory),
    // 下载目录：把"选目录"放到传输之外做（握手中途弹窗会把握手拖死，见 downloadDir.ts）
    vscode.commands.registerCommand('bastion.setDownloadDir', setDownloadDir),
    vscode.commands.registerCommand('bastion.resetDownloadDir', clearDownloadDir),
    vscode.commands.registerCommand('bastion.retryTransfer', retryTransfer),
    vscode.commands.registerCommand('bastion.clearTransferHistory', clearTransferHistoryCommand),
    vscode.commands.registerCommand('bastion.revealTransferItem', revealTransferItem),
    vscode.commands.registerCommand('bastion.copyTransferPath', copyTransferPath),
    vscode.commands.registerCommand('bastion.openTransferHistoryFile', () => openConfigFile(TRANSFER_FILE, TRANSFER_HEADER)),
    vscode.commands.registerCommand('bastion.addQuickCommand', addQuickCommand),
    vscode.commands.registerCommand('bastion.sendQuickCommand', sendQuickCommand),
    vscode.commands.registerCommand('bastion.deleteQuickCommand', deleteQuickCommand),
    vscode.commands.registerCommand('bastion.addForwardRule', addForwardRule),
    vscode.commands.registerCommand('bastion.startForward', startForwardRule),
    vscode.commands.registerCommand('bastion.stopForward', stopForwardRule),
    vscode.commands.registerCommand('bastion.deleteForwardRule', deleteForwardRule),
    vscode.window.onDidCloseTerminal((t) => {
      if (terminals.delete(t)) {
        if (terminals.size === 0) {
          void vscode.commands.executeCommand('setContext', 'bastion.hasSession', false)
        }
        // 关闭后重新判定：活动终端是否仍是堡垒机
        const vt = vscode.window.activeTerminal
        setActiveIsBastion(vt ? terminals.has(vt) : false)
        updateStatusBar()
        updateReadOnlySlot()
        refreshOverview()
      }
    }),
    vscode.window.onDidChangeActiveTerminal((t) => {
      setActiveIsBastion(t ? terminals.has(t) : false)
      updateStatusBar()
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // 焦点切到文本编辑器（文件预览页等）→ 不再是终端焦点。
      // 注意：切到终端时该事件会以 undefined 触发，此时不清标志，交给 onDidChangeActiveTerminal 处理。
      if (editor) setActiveIsBastion(false)
      updateStatusBar()
    })
  )

  // 监听任务目录变化，自动刷新部署任务树（编辑保存后名称/主机数即时更新）
  const taskWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(ctx.globalStorageUri, 'tasks/*.json')
  )
  taskWatcher.onDidCreate(() => deployProvider.refresh())
  taskWatcher.onDidChange(() => deployProvider.refresh())
  taskWatcher.onDidDelete(() => deployProvider.refresh())
  context.subscriptions.push(taskWatcher)

  // 监听 ~/.bastionshell/*.jsonc 变化：改了文件保存后侧边栏立即跟上，不用手动点刷新
  const cfgWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(configDir()), '*.jsonc')
  )
  const onCfgFileChanged = (uri: vscode.Uri): void => {
    const f = path.basename(uri.fsPath)
    log(`配置文件已变更：${f}`)
    if (f === QUICK_COMMANDS_FILE) quickCommandsProvider.refresh()
    else if (f === FORWARD_FILE) forwardProvider.refresh()
    else if (f === PROFILES_FILE) profilesProvider.refresh()
    else if (f === TRANSFER_FILE) transferProvider.refresh()
    else if (f === HABITS_FILE) updateOverwriteSlot()
  }
  cfgWatcher.onDidChange(onCfgFileChanged)
  cfgWatcher.onDidCreate(onCfgFileChanged)
  cfgWatcher.onDidDelete(onCfgFileChanged)
  context.subscriptions.push(cfgWatcher)

  // 设置在设置界面里被改（比如 uploadOverwrite）也要同步状态栏
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bastion.uploadOverwrite')) updateOverwriteSlot()
    })
  )

  // 注册语言模型工具：让 Copilot 等 AI 能直接调用（配合 package.json 的 languageModelTools 声明）
  context.subscriptions.push(
    vscode.lm.registerTool('bastion_exec', {
      prepareInvocation: (options) => {
        const input = options.input as { command?: string }
        return {
          invocationMessage: '在堡垒机服务器执行命令',
          confirmationMessages: {
            title: 'BastionShell 远程执行',
            message: new vscode.MarkdownString('执行命令：\n```sh\n' + (input.command ?? '') + '\n```')
          }
        }
      },
      invoke: async (options) => {
        const input = options.input as { command?: string; terminal?: string }
        // 高危命令的拦截在 sessionApi 里做（和 MCP 工具同一条路径）
        const output = await sessionApi.exec(input)
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_connect', {
      prepareInvocation: (options) => {
        const input = options.input as { profile?: string; host?: string }
        return {
          invocationMessage: '通过堡垒机连接目标机器',
          confirmationMessages: {
            title: 'BastionShell 连接目标机',
            message: new vscode.MarkdownString(
              `连接目标机：\n- 堡垒机档案：${input.profile ?? ''}\n- 目标主机：${input.host ?? ''}`
            )
          }
        }
      },
      invoke: async (options) => {
        const input = options.input as { profile?: string; host?: string; userChoice?: string; assetId?: string }
        const output = await sessionApi.connect(input)
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_listSessions', {
      invoke: async () => {
        const output = await sessionApi.listSessions()
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_tail', {
      // 只读：不弹确认（和 MCP 侧的 readOnlyHint 一致）
      invoke: async (options) => {
        const input = options.input as { terminal?: string; lines?: number }
        const output = await sessionApi.tail(input)
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_push', {
      prepareInvocation: (options) => {
        const input = options.input as { localPath?: string; remoteDir?: string }
        return {
          invocationMessage: '上传文件到远端',
          confirmationMessages: {
            title: 'BastionShell 上传文件',
            message: new vscode.MarkdownString(
              `上传本机文件到远端：\n- 本机：\`${input.localPath ?? ''}\`\n- 远端目录：\`${input.remoteDir || '（会话当前目录）'}\``
            )
          }
        }
      },
      invoke: async (options) => {
        const input = options.input as { localPath?: string; remoteDir?: string; terminal?: string }
        const output = await sessionApi.push(input)
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_pull', {
      prepareInvocation: (options) => {
        const input = options.input as { remotePath?: string; localDir?: string }
        return {
          invocationMessage: '从远端下载文件',
          confirmationMessages: {
            title: 'BastionShell 下载文件',
            message: new vscode.MarkdownString(
              `把远端文件拉回本机：\n- 远端：\`${input.remotePath ?? ''}\`\n- 本机目录：\`${input.localDir || '（工作区 .bastion-downloads/）'}\``
            )
          }
        }
      },
      invoke: async (options) => {
        const input = options.input as { remotePath?: string; localDir?: string; terminal?: string }
        const output = await sessionApi.pull(input)
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_listProfiles', {
      invoke: async () => {
        const output = await sessionApi.listProfiles()
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)])
      }
    }),
    vscode.lm.registerTool('bastion_habits', {
      prepareInvocation: (options) => {
        const input = options.input as { action?: string; profile?: string; habit?: string; privilege?: string }
        const action = input.action ?? 'read'
        if (action === 'read') return { invocationMessage: '读取 BastionShell 个人习惯' }
        const who = input.profile?.trim() || '全局'
        return {
          invocationMessage: action === 'remember' ? '记录个人习惯' : '设置提权习惯',
          confirmationMessages: {
            title: 'BastionShell 更新个人习惯',
            message: new vscode.MarkdownString(
              action === 'remember'
                ? `把这条习惯记下来，以后不再重复问：\n\n> ${input.habit ?? ''}\n\n作用范围：${who}`
                : `把提权习惯设为 \`${input.privilege ?? ''}\`\n\n作用范围：${who}`
            )
          }
        }
      },
      invoke: async (options) => {
        const input = options.input as { action?: string; profile?: string; habit?: string; privilege?: string }
        const text = await sessionApi.habits(input)
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
      }
    })
  )

  // MCP：把同一批会话工具通过 MCP 暴露出去（VS Code 里的 Copilot 等支持 MCP 的助手可用）
  registerMcp(context)
}

export function deactivate(): void {
  manager.dispose()
  disposeSlots()
  // 尽力关掉 MCP 端点（deactivate 不能 await；端口随进程结束也会释放）
  void stopMcp()
}
