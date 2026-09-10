import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile, writeJsonFile, migrateJsonExtension, configFilePath, ensureJsonFile } from './config'
import { log } from './log'

/**
 * 快捷命令（quickCommands.jsonc）
 *
 * 设计取舍：命令长了、或者想自己维护，就不该逼人把一长串 shell 塞进 JSON 字符串里转义。
 * 所以 command 支持两种写法：
 *   - 字符串：短命令直接写
 *   - 字符串数组：一行一个元素，长命令/多行命令不用写 \n
 * 另外还支持 file：把命令写成一个真正的 .sh 文件，这里只放路径 ——
 * 长脚本能享受语法高亮、能单独用 git 管，比塞在 JSON 里舒服得多。
 */
export interface QuickCommand {
  id: string
  label: string
  /** 要发送的命令：字符串，或「一行一个元素」的数组（更便于维护长命令） */
  command?: string | string[]
  /** 命令内容放在外部文件里（与 command 二选一；填了 file 就忽略 command） */
  file?: string
  /** 可选说明，显示在侧边栏和 tooltip 里 */
  description?: string
  /** 发送后是否自动回车执行，默认 true。填 false 只把命令打进终端，让你确认后再回车 */
  sendEnter?: boolean
}

const KEY = 'bastion.quickCommands'
export const QUICK_COMMANDS_FILE = 'quickCommands.jsonc'

export const QUICK_COMMANDS_HEADER = [
  '// ============================================================',
  '// BastionShell 快捷命令',
  '// 直接编辑本文件并保存即可生效（保存后侧边栏自动刷新）。',
  '// 打开方式：侧边栏「快捷命令」标题栏的铅笔图标，或命令面板搜「打开快捷命令配置文件」。',
  '// ------------------------------------------------------------',
  '// 每个命令的字段说明（只有 id 和 label 必填）：',
  '//   id          唯一 ID（自己起、别重复，如 "qc-restart"）',
  '//   label       显示名称（如 "重启服务"）',
  '//   command     要发送的命令。两种写法：',
  '//                 "systemctl restart nginx"        短命令直接写字符串',
  '//                 ["cd /etc", "ls -l"]             长/多行命令写成数组，一行一个',
  '//   file        命令太长就写到 .sh 文件里，这里只填路径（填了 file 就忽略 command）',
  '//                 例："file": "D:/work/scripts/restart.sh"',
  '//                 支持绝对路径；相对路径按工作区根目录解析',
  '//   description 可选说明，显示在侧边栏',
  '//   sendEnter   发送后是否自动回车执行，默认 true；填 false 只打进终端，你自己确认再回车',
  '// ------------------------------------------------------------',
  '// 例子：下面三个分别是「短命令」「多行命令」「外部脚本文件」。',
  '// 用不到就删掉，commands 留空数组 [] 也没问题。',
  '// ============================================================'
].join('\n')

const EXAMPLE_COMMANDS: QuickCommand[] = [
  { id: 'qc-example-short', label: '示例：看磁盘', command: 'df -h', description: '短命令直接写字符串' },
  {
    id: 'qc-example-multiline',
    label: '示例：多行命令',
    command: ['cd /etc', 'ls -l | head -20'],
    description: '数组写法，一行一个元素，不用写 \\n'
  },
  {
    id: 'qc-example-file',
    label: '示例：外部脚本',
    file: 'D:/work/scripts/restart.sh',
    description: '命令写在 .sh 文件里，这里只填路径（改成你自己的路径）'
  }
]

/** 校验：id/label 必填；command 必须存在其一（command 或 file），且类型正确 */
function isValidCmd(c: unknown): c is QuickCommand {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.label !== 'string') return false
  const cmdOk =
    o.command === undefined ||
    typeof o.command === 'string' ||
    (Array.isArray(o.command) && o.command.every((x) => typeof x === 'string'))
  const fileOk = o.file === undefined || typeof o.file === 'string'
  return cmdOk && fileOk
}

export function getQuickCommands(ctx: vscode.ExtensionContext): QuickCommand[] {
  migrateJsonExtension(QUICK_COMMANDS_FILE, 'quickCommands.json', QUICK_COMMANDS_HEADER)
  // 只要求「文件是个数组」，然后逐条筛 —— 手写文件里某一条字段写错，
  // 不该让整份列表被当成损坏丢进 .bak（那等于手工维护的内容全没了）。
  const raw = readJsonFile<QuickCommand[]>(QUICK_COMMANDS_FILE, [], (v): v is QuickCommand[] => Array.isArray(v))
  let cmds = raw.filter(isValidCmd)
  const bad = raw.length - cmds.length
  if (bad > 0) {
    log(`快捷命令有 ${bad} 条格式不合法（缺 id/label 或 command/file 类型不对），已跳过；文件本身未改动`)
  }

  const legacy = ctx.globalState.get<QuickCommand[]>(KEY)
  if (cmds.length === 0 && Array.isArray(legacy) && legacy.length > 0) {
    cmds = legacy.filter(isValidCmd)
    try {
      writeJsonFile(QUICK_COMMANDS_FILE, cmds, QUICK_COMMANDS_HEADER)
      void ctx.globalState.update(KEY, undefined)
      log(`已迁移 ${cmds.length} 条快捷命令到配置文件`)
    } catch (e) {
      log(`快捷命令迁移写入失败: ${(e as Error).message}`)
    }
  }
  return cmds
}

export function saveQuickCommands(cmds: QuickCommand[]): void {
  writeJsonFile(QUICK_COMMANDS_FILE, cmds, QUICK_COMMANDS_HEADER)
}

export function newQuickCommandId(): string {
  return `qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 文件不存在时建一份带中文说明 + 三个示例的模板（首次用「打开配置文件」时调用） */
export function ensureQuickCommandsFile(): void {
  if (fs.existsSync(configFilePath(QUICK_COMMANDS_FILE))) return
  ensureJsonFile(QUICK_COMMANDS_FILE, QUICK_COMMANDS_HEADER, EXAMPLE_COMMANDS)
}

/** 命令的可读预览（侧边栏 description 用），外部文件显示成 file:路径 */
export function quickCommandPreview(c: QuickCommand): string {
  if (c.file) return `file:${path.basename(c.file)}`
  if (Array.isArray(c.command)) return c.command.join(' ; ')
  return c.command ?? ''
}

/**
 * 解析出真正要发送的命令文本。
 * 外部文件优先；相对路径按工作区根目录解析，读不到就抛错（由调用方提示用户）。
 */
export function resolveQuickCommand(c: QuickCommand): string {
  if (c.file && c.file.trim()) {
    let p = c.file.trim()
    if (!path.isAbsolute(p)) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!root) throw new Error(`「${c.label}」用的是相对路径 ${p}，但当前没有打开工作区`)
      p = path.join(root, p)
    }
    if (!fs.existsSync(p)) throw new Error(`「${c.label}」引用的文件不存在：${p}`)
    return fs.readFileSync(p, 'utf8')
  }
  if (Array.isArray(c.command)) return c.command.join('\n')
  return c.command ?? ''
}

export class QuickCommandItem extends vscode.TreeItem {
  constructor(public readonly cmd: QuickCommand) {
    super(cmd.label || quickCommandPreview(cmd), vscode.TreeItemCollapsibleState.None)
    const preview = quickCommandPreview(cmd)
    this.description = cmd.description ? `${cmd.description} · ${preview}` : preview
    this.tooltip = new vscode.MarkdownString(
      [
        `**单击：直接发送到当前会话**`,
        '',
        `**${cmd.label}**`,
        cmd.description ? `\n${cmd.description}` : '',
        cmd.file ? `\n- 来源文件：\`${cmd.file}\`` : '',
        cmd.sendEnter === false ? '\n- 只打进终端，不自动回车' : '',
        '\n```sh',
        preview,
        '```',
        '',
        '右键可：发送 / 编辑快捷命令（打开配置文件）/ 删除命令'
      ]
        .filter(Boolean)
        .join('\n')
    )
    this.contextValue = 'quickCommand'
    this.iconPath = new vscode.ThemeIcon(cmd.file ? 'file-code' : 'terminal')
    this.command = { command: 'bastion.sendQuickCommand', title: '发送到会话', arguments: [this] }
  }
}

export class QuickCommandsProvider implements vscode.TreeDataProvider<QuickCommandItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<QuickCommandItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly loadCmds: () => QuickCommand[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(e: QuickCommandItem): vscode.TreeItem {
    return e
  }

  getChildren(): QuickCommandItem[] {
    return this.loadCmds().map((c) => new QuickCommandItem(c))
  }
}
