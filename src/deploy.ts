import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { parse as parseJsonc, ParseError } from 'jsonc-parser'
import { log } from './log'

/** 部署任务：一个 JSON 文件（放在扩展专用目录，不混进用户项目文件） */
export interface DeployTask {
  id: string
  name: string
  /** 堡垒机档案名 */
  profileId: string
  hosts: string[]
  uploads: string[]
  /** 上传前要执行的命令，**一行一条**（解析时把字符串/数组两种写法都归一到这里） */
  preCommand: string[]
  /** 上传完成后要执行的命令，**一行一条** */
  script: string[]
  userChoice: string
  /** 任务文件 URI（编辑 / 运行 / 删除用） */
  uri: vscode.Uri
}

/**
 * 把任务文件里的命令字段归一成「一行一条」的数组。
 *
 * 支持两种写法，**推荐数组**（跟快捷命令、docker compose 一个手感）：
 *   "preCommand": ["cd /etc", "ls -l"]      ← 一行一个元素，不用写 \n
 *   "script": "cd /etc\nls -l"              ← 字符串也行，按行拆
 * 甚至可以混着来：数组里某个元素自己带换行也会被拆开。
 */
export function normalizeCommands(v: unknown): string[] {
  const one = (s: string): string[] =>
    s
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').flatMap(one)
  }
  if (typeof v === 'string') return one(v)
  return []
}

const TASKS_DIR = 'tasks'

/**
 * 任务文件的扩展名。
 * 用 .jsonc 而不是 .json —— 因为这里要写中文说明注释，
 * 而 VS Code 对 .json 里的注释会报「Comments are not permitted in JSON」。
 * 老的 .json 任务仍然能读（见 listDeployTasks / migrateTaskFiles）。
 */
export const TASK_EXT = '.jsonc'

export const DEPLOY_TASK_HEADER = [
  '// ============================================================',
  '// BastionShell 部署任务',
  '// ------------------------------------------------------------',
  '// 一个任务 = 「往哪些机器、上传哪些文件、跑什么命令」。',
  '// 保存即生效（侧边栏「部署任务」会自动刷新），右键任务即可运行。',
  '// ------------------------------------------------------------',
  '// 字段说明（鼠标悬停任一字段也会显示同样的说明）：',
  '//   name        任务名，显示在侧边栏和部署报告里',
  '//   profile     连接档案名，必须和 ~/.bastionshell/profiles.jsonc 里的 name 一致',
  '//   hosts       目标机器列表（IP 或主机名），逐台连接执行。',
  '//               直连档案不用填（目标机就是档案自己那台）；堡垒机档案必须填。',
  '//   uploads     要上传的本地文件路径（建议绝对路径），通过 rz 传到目标机当前目录',
  '//   preCommand  上传前要执行的命令。**推荐数组写法，一行一个元素**：',
  '//                 "preCommand": ["sudo -i", "cd /etc"]',
  '//               也支持字符串（用 \\n 分隔）："preCommand": "sudo -i\\ncd /etc"',
  '//   script      上传完成后要执行的命令，写法同上（数组更好维护）',
  '//   userChoice  堡垒机二级菜单选用户的序号，默认 "1"；',
  '//               留空字符串 "" 表示这台机器不需要选用户',
  '//               （有些管理员账号输完 IP 直接进 shell，没有这一步）',
  '// ------------------------------------------------------------',
  '// 命令是**逐行执行**的：一行的输出会和这一行对上，写进部署报告。',
  '// 所以像 sudo -i 这种交互式命令单独占一行最合适 —— 它下面那行能精确捕获输出。',
  '// ------------------------------------------------------------',
  '// 运行结束会生成一份 Markdown 报告：每台机器的成败 + **每条命令的实际输出**。',
  '// 遇到高危命令（rm -rf / 之类）会在开跑前弹确认；高危规则可在',
  '// dangerRules.jsonc 里关掉误报或加自己那套。',
  '// ============================================================'
].join('\n')

/** 新建任务时的模板内容（**命令用数组写法**，照着加行就行） */
export const DEPLOY_TASK_TEMPLATE = {
  name: '新任务',
  profile: '',
  hosts: [] as string[],
  uploads: [] as string[],
  preCommand: ['cd /tmp'],
  script: [] as string[],
  userChoice: '1'
}

function tasksDir(ctx: vscode.ExtensionContext): string {
  const dir = path.join(ctx.globalStorageUri.fsPath, TASKS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function parseTaskFileFromUri(uri: vscode.Uri): DeployTask | undefined {
  try {
    const errors: ParseError[] = []
    const raw = parseJsonc(fs.readFileSync(uri.fsPath, 'utf8'), errors, { allowTrailingComma: true }) as Record<string, unknown>
    if (errors.length > 0 || !raw || typeof raw !== 'object') return undefined
    const id = path.basename(uri.fsPath).replace(/\.jsonc?$/i, '')
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      profileId: typeof raw.profile === 'string' ? raw.profile : '',
      hosts: Array.isArray(raw.hosts) ? raw.hosts.filter((h: unknown) => typeof h === 'string') : [],
      uploads: Array.isArray(raw.uploads) ? raw.uploads.filter((u: unknown) => typeof u === 'string') : [],
      preCommand: normalizeCommands(raw.preCommand),
      script: normalizeCommands(raw.script),
      userChoice: typeof raw.userChoice === 'string' ? raw.userChoice : '1',
      uri
    }
  } catch (e) {
    log(`任务文件解析失败 ${uri.fsPath}: ${(e as Error).message}`)
    return undefined
  }
}

/** 列出任务目录里所有任务（跳过非法 JSON） */
export function listDeployTasks(ctx: vscode.ExtensionContext): DeployTask[] {
  const dir = tasksDir(ctx)
  const out: DeployTask[] = []
  let files: string[] = []
  try {
    // 同时认 .jsonc（新）和 .json（老任务，迁移前的）
    files = fs.readdirSync(dir).filter((f) => /\.jsonc?$/i.test(f))
  } catch (e) {
    log(`读取任务目录失败: ${(e as Error).message}`)
    return out
  }
  for (const f of files) {
    const t = parseTaskFileFromUri(vscode.Uri.file(path.join(dir, f)))
    if (t) out.push(t)
  }
  return out
}

/** 按文件 URI 读一个任务（支持「右键任意 JSON/JSONC → 作为任务运行」） */
export function readDeployTaskByUri(uri: vscode.Uri): DeployTask | undefined {
  return parseTaskFileFromUri(uri)
}

/** 新建任务：生成带中文说明的 .jsonc 模板并返回 URI（调用方负责打开编辑器） */
export function createDeployTask(ctx: vscode.ExtensionContext, profile = ''): vscode.Uri {
  const dir = tasksDir(ctx)
  const id = `task-${Date.now().toString(36)}`
  return writeTaskFile(dir, id, { ...DEPLOY_TASK_TEMPLATE, profile })
}

/** 按「说明头 + JSON 体」的格式写一个任务文件，返回它的 URI */
function writeTaskFile(dir: string, id: string, data: unknown): vscode.Uri {
  const uri = vscode.Uri.file(path.join(dir, `${id}${TASK_EXT}`))
  fs.writeFileSync(uri.fsPath, `${DEPLOY_TASK_HEADER}\n${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return uri
}

/**
 * 把老的 .json 任务迁成带中文说明的 .jsonc。
 *
 * 顺序刻意是「先写新文件 → 解析验证 → 再删旧文件」：
 * 万一写坏了，旧文件还在，不会出现「任务凭空消失」。
 * 解析不过的老文件原地保留，并记一条日志让人自己处理。
 */
export function migrateTaskFiles(ctx: vscode.ExtensionContext): void {
  const dir = tasksDir(ctx)
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch (e) {
    log(`任务迁移：读取目录失败 ${(e as Error).message}`)
    return
  }
  let migrated = 0
  for (const f of files) {
    const oldPath = path.join(dir, f)
    const id = f.replace(/\.json$/i, '')
    const newPath = path.join(dir, `${id}${TASK_EXT}`)
    if (fs.existsSync(newPath)) continue // 已经有新的了，跳过
    try {
      const errors: ParseError[] = []
      const data = parseJsonc(fs.readFileSync(oldPath, 'utf8'), errors, { allowTrailingComma: true })
      if (errors.length > 0) {
        log(`任务迁移：${f} 解析不过，保留原文件不动，请手动检查`)
        continue
      }
      writeTaskFile(dir, id, data)
      // 写完先回读验证，确认新文件能解析出任务，再删旧的
      const check = parseTaskFileFromUri(vscode.Uri.file(newPath))
      if (!check) {
        log(`任务迁移：${f} 写出的新文件解析失败，已删除新文件并保留原文件`)
        try {
          fs.unlinkSync(newPath)
        } catch {
          /* ignore */
        }
        continue
      }
      fs.unlinkSync(oldPath)
      migrated++
    } catch (e) {
      log(`任务迁移失败 ${f}: ${(e as Error).message}`)
    }
  }
  if (migrated > 0) log(`已把 ${migrated} 个部署任务迁移为带中文说明的 .jsonc`)
}

/** 删除任务文件 */
export function deleteDeployTaskFile(ctx: vscode.ExtensionContext, task: DeployTask): void {
  try {
    fs.unlinkSync(task.uri.fsPath)
  } catch (e) {
    log(`删除任务文件失败 ${task.uri.fsPath}: ${(e as Error).message}`)
  }
}

/** 导出：把任务目录复制到用户选的目标文件夹 */
export async function exportDeployTasks(ctx: vscode.ExtensionContext): Promise<void> {
  const dir = tasksDir(ctx)
  const target = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: '选择导出目录'
  })
  if (!target || target.length === 0) return
  const dest = path.join(target[0].fsPath, 'bastion-tasks')
  fs.mkdirSync(dest, { recursive: true })
  for (const f of fs.readdirSync(dir)) {
    fs.copyFileSync(path.join(dir, f), path.join(dest, f))
  }
  vscode.window.showInformationMessage(`已导出 ${fs.readdirSync(dir).length} 个任务到 ${dest}`)
}

/** 迁移旧版 globalState 任务（对象数组）到文件 */
export function migrateLegacyDeployTasks(ctx: vscode.ExtensionContext): void {
  const KEY = 'bastion.deployTasks'
  const legacy = ctx.globalState.get<unknown[]>(KEY, [])
  if (!Array.isArray(legacy) || legacy.length === 0) return
  const dir = tasksDir(ctx)
  let migrated = 0
  for (const item of legacy) {
    const t = item as Partial<DeployTask>
    if (!t || typeof t !== 'object') continue
    const json = {
      name: t.name ?? '迁移任务',
      profile: t.profileId ?? '',
      hosts: t.hosts ?? [],
      uploads: t.uploads ?? [],
      preCommand: t.preCommand ?? '',
      script: t.script ?? '',
      userChoice: t.userChoice ?? '1'
    }
    const id = typeof t.id === 'string' ? t.id : `task-${Date.now().toString(36)}-${migrated}`
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(json, null, 2), 'utf8')
    migrated++
  }
  void ctx.globalState.update(KEY, undefined)
  if (migrated > 0) {
    vscode.window.showInformationMessage(`已迁移 ${migrated} 个旧部署任务为文件`)
  }
}
