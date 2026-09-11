/**
 * vscode 模块打桩。
 *
 * 扩展代码里 `import * as vscode from 'vscode'`，编译成 CJS 后就是 require('vscode')，
 * 而 'vscode' 这个模块只存在于 VS Code 宿主进程里 —— 在 Node 下直接跑测试会挂在 require 上。
 * 这里用 Module._load 拦截，把它换成一个够用的假实现。
 *
 * 只实现「纯逻辑层」需要的那部分 API：状态栏、主题色、MarkdownString、TreeItem、EventEmitter。
 * 真正的窗口 / 终端 / 命令调度不在单测范围内 —— 那部分只能靠真机点。
 *
 * 用法：测试文件里第一行 `import './../testkit/vscode-stub'`（副作用式安装），
 * 之后再 require 被测模块就不会炸。
 */
// 注意：这里必须用 `import ... = require(...)`，不能用 `import * as`。
// esModuleInterop 会把 `import * as` 编译成 __importStar()，那会生成一个
// 只有 getter 的副本对象，给它赋 _load 会报 "has only a getter"。
import Module = require('module')

type Loader = { _load(request: string, parent: unknown, isMain: boolean): unknown }

const loader = Module as unknown as Loader

export interface FakeStatusBarItem {
  text: string
  tooltip: unknown
  command: { title: string; command: string; arguments?: unknown[] } | undefined
  color: unknown
  backgroundColor: { id: string } | undefined
  name: string
  shown: boolean
  disposed: boolean
  show(): void
  hide(): void
  dispose(): void
}

/** 本次测试进程里创建过的所有状态栏项，按创建顺序 */
export const statusBarItems: FakeStatusBarItem[] = []

export class FakeThemeColor {
  constructor(public readonly id: string) {}
}

export class FakeThemeIcon {
  constructor(public readonly id: string) {}
}

export class FakeMarkdownString {
  value: string
  constructor(v?: string) {
    this.value = v ?? ''
  }
  appendMarkdown(s: string): FakeMarkdownString {
    this.value += s
    return this
  }
}

export class FakeTreeItem {
  label?: string
  description?: string
  tooltip?: unknown
  iconPath?: unknown
  contextValue?: string
  command?: unknown
  collapsibleState?: number
  constructor(label?: string, collapsibleState?: number) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

export class FakeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = []
  readonly event = (fn: (e: T) => void): { dispose(): void } => {
    this.listeners.push(fn)
    return { dispose: () => {} }
  }
  fire(e: T): void {
    for (const l of this.listeners) l(e)
  }
  dispose(): void {
    this.listeners = []
  }
}

/** 让 vscode.workspace.getConfiguration(...).get(...) 可控 */
export const configValues = new Map<string, unknown>()

/** 让 vscode.workspace.workspaceFolders 可控（快捷命令的相对路径要用） */
export let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined = undefined

export function setWorkspaceFolder(fsPath: string | undefined): void {
  workspaceFolders = fsPath ? [{ uri: { fsPath } }] : undefined
}

/** showQuickPick 的调用记录与预设返回值（先进先出；队列空 → 返回 undefined，等同用户按 Esc） */
export const quickPickCalls: Array<{ items: unknown[]; options: unknown }> = []
const quickPickResponses: unknown[] = []

export function queueQuickPickResponse(value: unknown): void {
  quickPickResponses.push(value)
}

/** 记录到的 showInformationMessage / showWarningMessage 文本（按调用顺序） */
export const infoMessages: string[] = []
export const warningMessages: string[] = []

export function resetWindowRecords(): void {
  quickPickCalls.length = 0
  quickPickResponses.length = 0
  infoMessages.length = 0
  warningMessages.length = 0
}

function makeStatusBarItem(): FakeStatusBarItem {
  const item: FakeStatusBarItem = {
    text: '',
    tooltip: undefined,
    command: undefined,
    color: undefined,
    backgroundColor: undefined,
    name: '',
    shown: false,
    disposed: false,
    show(): void {
      item.shown = true
    },
    hide(): void {
      item.shown = false
    },
    dispose(): void {
      item.disposed = true
    }
  }
  statusBarItems.push(item)
  return item
}

/** 最近创建的一个状态栏项（仅在刚重置过状态时可靠） */
export function lastStatusBarItem(): FakeStatusBarItem {
  return statusBarItems[statusBarItems.length - 1]
}

/**
 * 按槽位名取状态栏项（推荐用这个）。
 * status.ts 创建槽位时会设 `item.name = 'BastionShell <slot>'`，
 * 而槽位是复用的 —— 靠「创建顺序」断言会在多次调用后失准。
 */
export function slotItem(slotName: string): FakeStatusBarItem | undefined {
  return statusBarItems.find((i) => i.name === `BastionShell ${slotName}`)
}

export function resetStatusBarItems(): void {
  statusBarItems.length = 0
}

const fakeVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeColor: FakeThemeColor,
  ThemeIcon: FakeThemeIcon,
  MarkdownString: FakeMarkdownString,
  TreeItem: FakeTreeItem,
  EventEmitter: FakeEventEmitter,
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
    joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
      fsPath: [base.fsPath, ...segs].join('/')
    })
  },
  workspace: {
    get workspaceFolders(): unknown {
      return workspaceFolders
    },
    getConfiguration: (section?: string) => ({
      get: <T>(key: string, def?: T): T => {
        const full = section ? `${section}.${key}` : key
        return (configValues.has(full) ? configValues.get(full) : def) as T
      },
      update: async (key: string, value: unknown): Promise<void> => {
        configValues.set(section ? `${section}.${key}` : key, value)
      }
    })
  },
  window: {
    createStatusBarItem: () => makeStatusBarItem(),
    createOutputChannel: () => ({
      appendLine(): void {},
      append(): void {},
      show(): void {},
      clear(): void {},
      dispose(): void {}
    }),
    showInformationMessage: async (msg: string) => {
      infoMessages.push(String(msg))
      return undefined
    },
    showWarningMessage: async (msg: string) => {
      warningMessages.push(String(msg))
      return undefined
    },
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async (items: unknown[], options: unknown) => {
      quickPickCalls.push({ items, options })
      const r = quickPickResponses.shift()
      // 支持传函数：有的命令的候选项是它自己现造的，测试拿不到引用，
      // 只能等命令把 items 递进来再决定"用户勾了哪几个"。
      return typeof r === 'function' ? (r as (items: unknown[]) => unknown)(items) : r
    },
    setStatusBarMessage: () => ({ dispose(): void {} })
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose(): void {} })
  }
}

let installed = false

/** 安装打桩（幂等）。测试文件在 require 被测模块之前调用即可 */
export function installVscodeStub(): void {
  if (installed) return
  installed = true
  const original = loader._load
  loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return fakeVscode
    return original.call(this, request, parent, isMain)
  }
}

// 副作用式安装：`import '../testkit/vscode-stub'` 即可
installVscodeStub()
