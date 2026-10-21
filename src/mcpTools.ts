/**
 * MCP 工具层：把 BastionShell 的会话能力暴露成 MCP 工具。
 *
 * 这一层**既不 import vscode、也不 import aiBridge** —— 能力是注入进来的
 * （`McpSessionApi`）。这么设计有两个硬理由：
 *
 *   1. **能测**：可以在普通 Node 里起真实的 HTTP 端点、发真实的 JSON-RPC，
 *      不需要启动 VS Code、不需要真会话；
 *   2. **不会跑偏**：语言模型工具（Copilot 直接用）和 MCP 工具共用同一份
 *      工具定义和同一份实现（`aiSessionApi.ts`）。两条路各写一套的话，
 *      迟早会出现「Copilot 走的那条拦高危命令、MCP 那条不拦」这种事。
 *
 * 工具名刻意和语言模型工具保持一致（`bastion_exec` 等）：文档、提示词、
 * 用户心智都只有一套名字。
 */

import type { ExecResponse } from './execResult'

/** 一个 MCP 工具的元数据（`tools/list` 直接返回它） */
export interface McpToolDef {
  name: string
  title: string
  /** 给模型看的说明：什么时候用、要传什么。这段文字决定了模型会不会用对 */
  description: string
  /** JSON Schema（入参） */
  inputSchema: Record<string, unknown>
  /**
   * 只读工具：MCP 客户端据此**不弹确认框**（VS Code 的 `readOnlyHint`）。
   * 有副作用的工具绝不能标成只读。
   */
  readOnly: boolean
}

export interface McpToolResult {
  text: string
  /** 机器可读结果（MCP 侧会转成 structuredContent）；只读文本的客户端忽略它即可 */
  structured?: Record<string, unknown>
  isError?: boolean
}

/** 调用了不存在的工具（HTTP 层会翻译成 JSON-RPC -32602） */
export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`未知的工具：${name}`)
    this.name = 'UnknownToolError'
  }
}

/**
 * 会话能力接口。真实实现见 `aiSessionApi.ts`（包着 aiBridge + 高危规则 + 个人习惯），
 * 测试里注入假实现。
 */
export interface ToolCallContext {
  /** 调用者标识：令牌对应的客户端（P0b），没有令牌身份时取请求头 X-BastionShell-Client，再没有就是 default */
  clientId?: string
  /**
   * 权限档（P0b）：observer 只能调只读工具；operator 可写但不能 connect；full 全都能做。
   * 不传 = full（内部调用 / 测试 / VS Code 内的 Copilot 直连）。
   */
  scope?: 'observer' | 'operator' | 'full'
}

export interface McpSessionApi {
  listSessions(input?: ToolCallContext): Promise<string>
  listProfiles(): Promise<string>
  exec(input: {
    command?: string
    session?: string
    terminal?: string
    clientId?: string
    /** 仅 LM 直连用：没有绑定时允许回退到活动终端 */
    allowActiveFallback?: boolean
    /** P2-a：乐观并发校验 */
    expectCursor?: number
    /** P2-b：重试去重（同一件事重试时带同一个 key，服务端不会重复执行） */
    idempotencyKey?: string
    /** 本次最多阻塞多久（默认 15s，夹到 55s；更长的自动转作业） */
    waitMs?: number
    /** 输出静止多久算"没输出了"（默认 15s；旧值 3s 会把长构建误判成结束） */
    quietMs?: number
    /** shell（默认）| interactive（只发不等，用于 top/vi/菜单） */
    mode?: 'shell' | 'interactive'
    /** 立刻返回作业句柄，不阻塞 */
    background?: boolean
    /** 把日志 tee 到远端文件（人仍能在终端看到；扩展重启后还能 cat - 用返回里的 logPath） */
    logToFile?: boolean
    /** 会话上有命令在跑时强行插队（默认拒绝） */
    force?: boolean
  }): Promise<ExecResponse>
  connect(input: {
    profile?: string
    host?: string
    userChoice?: string
    assetId?: string
    clientId?: string
    /** 连接时直接给会话起别名（省掉一次 bastion_use） */
    as?: string
  }): Promise<string>
  /** 把调用者绑定到某条会话（别名 A/B…）：让"我在哪条会话上"由服务端记住 */
  use(input: { session?: string; as?: string; unbind?: boolean; clientId?: string }): Promise<string>
  habits(input: { action?: string; profile?: string; habit?: string; privilege?: string }): Promise<string>
  /** 某条会话屏幕上最后几行（排障 + 人工接手后确认走到哪一步） */
  tail(input: { session?: string; terminal?: string; lines?: number; clientId?: string }): Promise<string>
  /** 传文件到远端（rz） */
  push(input: {
    localPath?: string
    remoteDir?: string
    session?: string
    terminal?: string
    clientId?: string
    expectCursor?: number
  }): Promise<string>
  /** 从远端拉文件回来（sz） */
  pull(input: {
    remotePath?: string
    localDir?: string
    session?: string
    terminal?: string
    clientId?: string
    expectCursor?: number
  }): Promise<string>
  /** 等作业：状态变终态 / pattern 命中 / 超时（服务端阻塞，不用 AI 自己 sleep） */
  wait(input: { jobId?: string; pattern?: string; waitMs?: number; sinceOffset?: number }): Promise<ExecResponse>
  /** 按字节偏移增量读作业日志（滚屏也不丢） */
  job(input: { jobId?: string; sinceOffset?: number; maxBytes?: number }): Promise<ExecResponse>
  /** 取消作业（往那条会话发 Ctrl-C） */
  cancel(input: { jobId?: string }): Promise<ExecResponse>
  /** 端点自检：AI 遇到「工具调用出错」时用它分清端点坏了还是这次偶发 */
  health(input?: ToolCallContext): Promise<string>
}

const SESSIONS_DESC =
  '列出当前所有 BastionShell 堡垒机会话（每条带**不可变会话 id** `s-xxxx`、完整终端名、状态（✅ 在 shell 里 / ⚠️ 还停在堡垒机菜单上），' +
  '以及它被哪些 AI 客户端绑定）并返回**你自己**的绑定。' +
  '操作前先看一眼：执行命令时要传 session（id 或别名 A/B），或者先 bastion_use 绑定 —— ' +
  '没绑定时写入类工具会被拒绝（不会用"当前活动窗口"兜底，那可能是别的 AI 的会话）。'

const USE_DESC =
  '把**你自己**（这个 MCP 客户端）绑定到某条会话，之后就能用别名（A/B/…）或直接不传值来指认它。\n' +
  '- 绑定存在**服务端**（~/.bastionshell/mcp-bindings.json），不是靠模型记忆：' +
  '你的上下文被压缩/重开之后，bastion_listSessions 里仍会显示 `你的(A)`；\n' +
  '- 要**同时操作两台机器**：各 bastion_connect 一次（会自动绑定成 A、B），之后 exec 传 session:"A"/"B"；\n' +
  '- 绑定多于一条时，exec/push/pull **必须**指定 session —— 服务端不会替你猜；\n' +
  '- 别名只对你自己有效（别人的 A 不是你的 A）；unbind=true 解绑。'

const EXEC_DESC =
  '在一个**已经认证好**的 BastionShell 会话上执行 shell 命令，并返回命令输出。' +
  '这是操作远端服务器的主要手段。注意：\n' +
  '- 命令和输出会**实时显示在用户的终端里**（用户全程看得见，也能随时接手敲键盘）；\n' +
  '- 会话是复用的，不需要也不应该尝试输入密码/动态码 —— MFA 由用户自己在终端里完成；\n' +
  '- **会话是人和 AI 共用的**：需要人工操作时（MFA、选资产、选账号、输密码、过菜单），' +
  '让用户在终端里做完，然后你直接在**同一条会话**上继续执行命令，不需要重新连接；\n' +
  '- 如果会话还停在菜单上，这条工具**不会把命令发出去**（发出去会被菜单吃掉），而是告诉你去让用户先走完那一步；\n' +
  '- 提权方式按这个档案的「个人习惯」自动决定（免密 sudo 会直接 `sudo <命令>`，需要交互的会提示你让用户来输密码）；' +
  '只是**第一次**观察到某种提权做法时先别写进习惯（用户明确说了、或同一做法遇到 2~3 次再记；记录与实际不符则立刻更正）；\n' +
  '- 命中高危命令规则（删根、格式化、写块设备等）的命令会被**直接拒绝**，不要试图换写法绕过，而是把结论告诉用户；\n' +
  '- 交互式命令（`sudo -i`、`su`、`top`、`vi`）拿不到可靠的结束标记，输出会不完整，尽量不要用；\n' +
  '- **必须让服务端知道你要哪条会话**：传 session（id 或别名 A/B），或先 bastion_use 绑定。' +
  '什么都没绑定时这条工具会**拒绝执行**并告诉你该怎么做 —— 这是为了防止命令落到别的 AI/用户的会话上；\n' +
  '- **重试同一件事时带同一个 idempotencyKey**（例如 restart-nginx）：失败可能只是回包丢了、命令其实已经执行过，' +
  '带 key 重试会直接返回上次结果、不会重复执行（rm / service restart / kill -9 这类尤其重要）；不带 key 服务端无法保证；\n' +
  '- 可选 expectCursor（上次 tail/listSessions 返回的 cursor）：会话在你读取后被别人动过就**拒绝执行**，让你先 tail 确认。\n' +
  '- **长命令看返回的 status**：`completed`（跑完，带 exitCode）/ `working`（还在跑，带 jobId）/ `input_required`（卡在密码、动态码、y/n、菜单上，需要人）。\n' +
  '  返回 `working` 时**绝对不要重发这条命令**（会重复执行）—— 用 bastion_wait 等它、bastion_job 读增量日志、bastion_cancel 停掉它。\n' +
  '- waitMs 默认 15s、服务端夹到 55s（MCP 客户端单次调用有自己的超时，等太久客户端先超时反而更难诊断）；\n' +
  '  要等更久就分段调 bastion_wait，**不要用 sleep 硬等**（无进度、不可取消、白等）。\n' +
  '- quietMs 默认 15s：输出静止多久算"没输出了"。构建类命令阶段之间会静默几十秒，别把它当成结束。\n' +
  '- background:true = 立刻拿 jobId 不阻塞；mode:"interactive" = 只发不等（top/vi/sudo -i/菜单这类）。'

const WAIT_DESC =
  '等一个作业（bastion_exec 返回 working 时给的 jobId）。这是"不要用 sleep 硬等"的正解：' +
  '**等待发生在服务端**，不消耗你的轮次。\n' +
  '- 满足任一条件就返回：作业结束（completed/failed/cancelled）、pattern 命中、超时（仍在跑，返回 working）。\n' +
  '- pattern 是正则，默认只在"本次调用以来的新增输出"里找；典型用法：等构建出现"阶段 5/9 完成"，或等提示符出现。\n' +
  '- 一轮最多 55 秒（客户端单次调用预算内）。没等到就再调一次，**不要重发原来的命令**。\n' +
  '- 返回里带 status / exitCode / lastLine / cursor / matched，以及输出尾部。'

const JOB_DESC =
  '按字节偏移**增量读**某个作业的完整日志（终端滚屏也不会丢）。\n' +
  '- sinceOffset 从上一页的 nextOffset 接着读，直到 truncated=false。\n' +
  '- 输出很大时用它分页，不要用 bastion_tail（那只给屏幕末尾几十行）。\n' +
  '- 作业日志在扩展内存里滚动保存（上限 8MB）；如果开了 logToFile，远端还有一份文件副本（logPath），' +
  '扩展重启后可以自己 exec `tail -c` 读。'

const CANCEL_DESC =
  '取消一个还在跑的作业：往那条会话发 Ctrl-C，并把作业标记为 cancelled（协作式，不保证立刻停）。\n' +
  '误起的 sleep / tail -f / 卡住的构建用它收场 —— 没有它就只能等人来按 Ctrl-C。'

const CONNECT_DESC =
  '通过堡垒机菜单连接到一台目标机器（会复用已认证的连接，不重新输密码/动态码）。' +
  '堡垒机档案必须给 host（目标机 IP）；直连档案只需要 profile。' +
  '连接成功后返回终端名和这台机器的提权习惯，之后用 bastion_exec 在它上面执行命令。\n' +
  '⚠️ **一个 IP 可能匹配到多条资产**（例如同一 IP 上既有 Linux 本体、又有一台 Gateway），' +
  '这时堡垒机会列一张资产表让你输资产 ID。这时：\n' +
  '- 你知道要哪条 → 传 assetId（就是表里 ID 列那个数字）；\n' +
  '- 不知道 → **不要猜**，先不传 assetId 调用；只有一条候选会自动选，多条会弹给用户选，' +
  '返回值里会写明这次登录的是哪条资产、还有哪些候选。\n' +
  '登录到错的机器上后果很严重，所以拿不准时宁可问用户。'

const PROFILES_DESC =
  '列出连接档案（档案名、账号@主机、直连还是堡垒机、提权习惯）。' +
  '第一次操作某台机器、或用户只说了「生产那台」时，先用它确认档案名。'

const HABITS_DESC =
  '读写「个人习惯」：这个用户在目标机上怎么干活（提权方式 none/sudo/sudo-i/ask、常用目录、口头约定）。' +
  'action=read 看当前习惯；action=remember 记一条（habit 参数）；' +
  'action=setPrivilege 改提权习惯（privilege 参数）。\n' +
  '⚠️ **什么时候才该写**（写进去会长期影响以后所有会话，所以宁可多问一次）：\n' +
  '- 用户**明确说了**做法（例如「这台机器 sudo 免密」）→ 立刻记；\n' +
  '- 只是你自己**第一次**观察到某个做法 → **先别写**；等同一个做法再遇到一次（累计 2~3 次观察）再记；\n' +
  '- 记录与实际**不符**（习惯写的是免密 sudo，实际弹了密码）→ **立刻更正**，并顺手 remember 记下真实做法；\n' +
  '- 只是猜的、或只见过一次 → **不写**。错误记忆比没有记忆更糟。'

const TAIL_DESC =
  '读某条会话**屏幕上最后几行**（默认 40 行，最多 200）。用途：\n' +
  '- 命令看起来没反应、输出不完整、或者你不确定远端现在是什么状态时，**看一眼屏幕**再决定下一步；\n' +
  '- 用户在终端里手动操作完（过了菜单、输了密码、选了资产）之后，用它确认走到了哪一步；\n' +
  '- 它返回的是屏幕上真正渲染出来的文字（去掉颜色码），比你手里的输出拼接更接近现状。'

const PUSH_DESC =
  '把一个**本机文件**传到远端（走 rz / ZMODEM，和用户在终端里敲 rz 是同一套实现）。\n' +
  '- 只支持**单个文件**；目录请先在本地打包（tar/zip），或让用户用部署任务/rsync 传；\n' +
  '- `remoteDir` 会先 `cd` 过去再传（rz 只能传到会话当前目录），不传就传到当前目录；\n' +
  '- 远端已有同名文件时按用户设置 `bastion.uploadOverwrite` 处理（skip 会**跳过并告诉你**）。'

const PULL_DESC =
  '把一个**远端文件**拉回本机（`sz`）。拉回来的文件默认落在工作区的 `.bastion-downloads/` 下 —— ' +
  '这样你（AI）可以直接用自己的文件工具读它。想放别处就传 `localDir`。'

export const MCP_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'bastion_listSessions',
    title: '列出堡垒机会话',
    description: SESSIONS_DESC,
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'bastion_use',
    title: '绑定会话（记住我在哪条会话上）',
    description: USE_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id（如 s-7f3a）或终端名的一部分（必须唯一命中）' },
        as: { type: 'string', description: '别名（默认自动取 A/B/…），之后可以写 session:"A"' },
        unbind: { type: 'boolean', description: 'true = 解绑这个别名/会话' }
      },
      required: ['session'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_health',
    title: '端点自检',
    description:
      'BastionShell MCP 端点自检：返回端点地址/端口、扩展版本、工具个数、每条会话的状态。' +
      '**当其它 bastion_* 工具调用失败时先调它**：\n' +
      '- 它能正常返回 → 说明端点、鉴权、协议都是好的，刚才那次多半是偶发（例如扩展刚重载完）→ **直接重试原来那次调用**；\n' +
      '- 它自己调用也失败 → 端点没在跑 → 明确告诉用户：在 VS Code 里重启 MCP 服务器' +
      '（命令面板 → `MCP: List Servers` → BastionShell → Restart），或重载窗口。\n' +
      '不要因为一次工具调用失败就让用户手工去敲命令 —— 先重试、再自检，然后把准确的原因告诉用户。',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'bastion_tail',
    title: '读会话屏幕',
    description: TAIL_DESC,
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id（s-xxxx）或别名（A/B）；不填则：有唯一绑定用它，否则（读操作）回退到活动/最近会话并说明' },
        terminal: { type: 'string', description: '旧参数，等价于 session' },
        lines: { type: 'number', description: '要读多少行（默认 40，最多 200）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'bastion_listProfiles',
    title: '列出连接档案',
    description: PROFILES_DESC,
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'bastion_exec',
    title: '在远端执行命令',
    description: EXEC_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要在远端执行的 shell 命令（单条命令；需要多条时用 && 或在部署任务里做）' },
        session: {
          type: 'string',
          description:
            '目标会话：会话 id（s-xxxx）或你绑定过的别名（A/B）。不填时只会用你自己的唯一绑定；' +
            '没有绑定或绑定多于一条会被拒绝（不会猜）'
        },
        terminal: { type: 'string', description: '旧参数，等价于 session（按终端名精确匹配；片段必须唯一）' },
        expectCursor: {
          type: 'number',
          description:
            '乐观并发校验：把上一次 tail/listSessions 返回的 cursor 带上来。会话在你读取之后被改动过'
            + '（用户在那个终端里敲了东西、或另一个客户端执行了命令）就会**拒绝执行**并让你先 tail 确认。'
        },
        idempotencyKey: {
          type: 'string',
          description:
            '重试去重：同一件事**重试**时带同一个 key（例如 "restart-nginx"）。服务端在 10 分钟内见过这个 key 就直接返回上次的结果、不再执行。'
            + '不确定是"没执行"还是"执行了但回包丢了"时，这正是你需要的。'
        }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_wait',
    title: '等作业（完成 / 等某个输出出现）',
    description: WAIT_DESC,
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '作业 id（bastion_exec 返回里的 jobId，形如 j-0001）' },
        pattern: { type: 'string', description: '要等的正则片段（例如 "阶段 5/9 完成"）；不填就是纯等结束' },
        waitMs: { type: 'number', description: '最多等多久（默认 20000，服务端夹到 55000）' },
        sinceOffset: { type: 'number', description: '从哪个字节偏移之后开始找 pattern（默认从现在开始）' }
      },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_job',
    title: '读作业日志（增量）',
    description: JOB_DESC,
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '作业 id' },
        sinceOffset: { type: 'number', description: '从哪个字节偏移开始读（默认 0 = 从头）' },
        maxBytes: { type: 'number', description: '这次最多读多少字节（默认 65536，上限 262144）' }
      },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_cancel',
    title: '取消作业',
    description: CANCEL_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '作业 id' }
      },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_connect',
    title: '连接目标机器',
    description: CONNECT_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: '连接档案名（和 profiles.jsonc 里的 name 一致）' },
        host: { type: 'string', description: '目标机 IP 或主机名（堡垒机档案必填；直连档案不用填）' },
        userChoice: { type: 'string', description: '堡垒机菜单里选用户的序号，默认 "1"；某些机器不需要选用户则传空字符串' },
        as: {
          type: 'string',
          description:
            '连接时直接给这条会话起别名（如 db1 / jump / 排障-A）：之后 exec 传 session:"db1" 就行，'
            + '不用再调一次 bastion_use 改名。不填则自动按 A/B/C… 分配'
        },
        assetId: {
          type: 'string',
          description:
            '资产 ID：同一个 IP 在堡垒机里匹配到多条资产时，用它指明要登录哪一条（就是资产表里 ID 列的数字）。' +
            '不传时：只有一条候选会自动选，多条会弹给用户选（返回值里会说明选了哪条、还有哪些候选）'
        }
      },
      required: ['profile'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_habits',
    title: '个人习惯（提权方式等）',
    description: HABITS_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'remember', 'setPrivilege'], description: '要做的动作' },
        profile: { type: 'string', description: '档案名；不填＝全局习惯' },
        habit: { type: 'string', description: 'action=remember 时要记下来的那句话' },
        privilege: { type: 'string', enum: ['none', 'sudo', 'sudo-i', 'ask'], description: 'action=setPrivilege 时的提权方式' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_push',
    title: '上传文件到远端',
    description: PUSH_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: '本机文件路径（建议绝对路径）' },
        remoteDir: { type: 'string', description: '远端目标目录（不填 = 会话当前目录）；会先 cd 过去再传' },
        session: { type: 'string', description: '会话 id（s-xxxx）或别名（A/B）；不填则用你自己的唯一绑定（没有/多于一条会拒绝）' },
        expectCursor: { type: 'number', description: '乐观并发校验：带上一次读取拿到的 cursor；会话被改动过就拒绝' },
        terminal: { type: 'string', description: '旧参数，等价于 session' }
      },
      required: ['localPath'],
      additionalProperties: false
    }
  },
  {
    name: 'bastion_pull',
    title: '从远端下载文件',
    description: PULL_DESC,
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        remotePath: { type: 'string', description: '远端文件路径' },
        localDir: { type: 'string', description: '本机落盘目录；默认工作区下的 .bastion-downloads/' },
        session: { type: 'string', description: '会话 id（s-xxxx）或别名（A/B）；不填则用你自己的唯一绑定（没有/多于一条会拒绝）' },
        expectCursor: { type: 'number', description: '乐观并发校验：带上一次读取拿到的 cursor；会话被改动过就拒绝' },
        terminal: { type: 'string', description: '旧参数，等价于 session' }
      },
      required: ['remotePath'],
      additionalProperties: false
    }
  }
]

/**
 * 造一个「工具名 → 结果」的分发函数。
 *
 * 分发本身很薄，但它把所有工具的**参数缺省与错误处理**收在一处：
 * 参数缺失、能力抛异常，都变成给模型看得懂的文本，而不是让整个会话炸掉。
 */
export function createToolDispatch(
  api: McpSessionApi
): (name: string, args: Record<string, unknown>, ctx?: ToolCallContext) => Promise<McpToolResult> {
  return async (name, args, ctx) => {
    const a = args ?? {}
    /** 调用者标识：由 MCP 端从请求头取（X-BastionShell-Client）；工具层只透传 */
    const clientId = ctx?.clientId
    switch (name) {
      case 'bastion_listSessions':
        return { text: await api.listSessions({ clientId }) }
      case 'bastion_health':
        return { text: await api.health({ clientId }) }
      case 'bastion_listProfiles':
        return { text: await api.listProfiles() }
      case 'bastion_wait': {
        const jobId = typeof a.jobId === 'string' ? a.jobId : ''
        const pattern = typeof a.pattern === 'string' ? a.pattern : undefined
        const waitMs = typeof a.waitMs === 'number' ? a.waitMs : undefined
        const sinceOffset = typeof a.sinceOffset === 'number' ? a.sinceOffset : undefined
        const r = await api.wait({ jobId, pattern, waitMs, sinceOffset })
        return { text: r.text, structured: r.structured }
      }
      case 'bastion_job': {
        const jobId = typeof a.jobId === 'string' ? a.jobId : ''
        const sinceOffset = typeof a.sinceOffset === 'number' ? a.sinceOffset : undefined
        const maxBytes = typeof a.maxBytes === 'number' ? a.maxBytes : undefined
        const r = await api.job({ jobId, sinceOffset, maxBytes })
        return { text: r.text, structured: r.structured }
      }
      case 'bastion_cancel': {
        const jobId = typeof a.jobId === 'string' ? a.jobId : ''
        const r = await api.cancel({ jobId })
        return { text: r.text, structured: r.structured }
      }
      case 'bastion_tail': {
        const session = typeof a.session === 'string' ? a.session : undefined
        const terminal = typeof a.terminal === 'string' ? a.terminal : undefined
        const lines = typeof a.lines === 'number' ? a.lines : undefined
        return { text: await api.tail({ session, terminal, lines, clientId }) }
      }
      case 'bastion_push': {
        const localPath = typeof a.localPath === 'string' ? a.localPath : ''
        if (!localPath.trim()) return { text: '错误：bastion_push 需要 localPath（本机文件路径）', isError: true }
        return {
          text: await api.push({
            localPath,
            remoteDir: typeof a.remoteDir === 'string' ? a.remoteDir : undefined,
            session: typeof a.session === 'string' ? a.session : undefined,
            terminal: typeof a.terminal === 'string' ? a.terminal : undefined,
            clientId
          })
        }
      }
      case 'bastion_pull': {
        const remotePath = typeof a.remotePath === 'string' ? a.remotePath : ''
        if (!remotePath.trim()) return { text: '错误：bastion_pull 需要 remotePath（远端文件路径）', isError: true }
        return {
          text: await api.pull({
            remotePath,
            localDir: typeof a.localDir === 'string' ? a.localDir : undefined,
            session: typeof a.session === 'string' ? a.session : undefined,
            terminal: typeof a.terminal === 'string' ? a.terminal : undefined,
            clientId
          })
        }
      }
      case 'bastion_exec': {
        const command = typeof a.command === 'string' ? a.command : ''
        if (!command.trim()) return { text: '错误：bastion_exec 需要 command 参数（要执行的命令）', isError: true }
        const session = typeof a.session === 'string' ? a.session : undefined
        const terminal = typeof a.terminal === 'string' ? a.terminal : undefined
        const r = await api.exec({
          command,
          session,
          terminal,
          clientId,
          expectCursor: typeof a.expectCursor === 'number' ? a.expectCursor : undefined,
          idempotencyKey: typeof a.idempotencyKey === 'string' ? a.idempotencyKey : undefined,
          waitMs: typeof a.waitMs === 'number' ? a.waitMs : undefined,
          quietMs: typeof a.quietMs === 'number' ? a.quietMs : undefined,
          mode: a.mode === 'interactive' ? 'interactive' : undefined,
          background: a.background === true,
          logToFile: a.logToFile === true,
          force: a.force === true
        })
        return { text: r.text, structured: r.structured }
      }
      case 'bastion_connect': {
        const profile = typeof a.profile === 'string' ? a.profile : ''
        if (!profile.trim()) return { text: '错误：bastion_connect 需要 profile 参数（连接档案名）', isError: true }
        const host = typeof a.host === 'string' ? a.host : undefined
        const userChoice = typeof a.userChoice === 'string' ? a.userChoice : undefined
        const assetId = typeof a.assetId === 'string' ? a.assetId : undefined
        return {
          text: await api.connect({
            profile,
            host,
            userChoice,
            assetId,
            clientId,
            as: typeof a.as === 'string' ? a.as : undefined
          })
        }
      }
      case 'bastion_habits': {
        const action = typeof a.action === 'string' ? a.action : 'read'
        return {
          text: await api.habits({
            action,
            profile: typeof a.profile === 'string' ? a.profile : undefined,
            habit: typeof a.habit === 'string' ? a.habit : undefined,
            privilege: typeof a.privilege === 'string' ? a.privilege : undefined
          })
        }
      }
      case 'bastion_use': {
        const session = typeof a.session === 'string' ? a.session : ''
        if (!session.trim()) {
          return {
            text: '错误：bastion_use 需要 session 参数（会话 id 如 s-7f3a，或终端名的一部分 —— 必须唯一命中）',
            isError: true
          }
        }
        return {
          text: await api.use({
            session,
            as: typeof a.as === 'string' ? a.as : undefined,
            unbind: a.unbind === true,
            clientId
          })
        }
      }
      default:
        throw new UnknownToolError(name)
    }
  }
}

/**
 * `initialize` 返回里带的一段「使用说明」。模型看得到它，
 * 所以把最容易出错的三件事写在这里：先看会话、MFA 是人的事、高危命令会被拒。
 */
export const MCP_INSTRUCTIONS =
  'BastionShell 提供的是**用户已经手动认证过**的堡垒机会话（密码 + MFA + 选目标机都由人完成）。\n' +
  '典型流程：bastion_listSessions 看有哪些会话 → bastion_connect 连一台新目标机 → bastion_exec 执行命令。\n' +
  '不要尝试输入密码、动态码，也不要试图重新登录：MFA 只能由用户在终端里手动完成，需要时请让用户操作。\n' +
  '**「个人习惯」什么时候写**：用户明确说了做法 → 立刻记；只是你第一次观察到 → 先别写，等同一做法再遇到一次（累计 2~3 次）再记；记录与实际不符 → 立刻更正。错误记忆比没有记忆更糟。\n' +
  '**会话是人和 AI 共用的同一条**：用户随时可以自己敲（输动态码、选资产、过菜单、改一条命令都行），' +
  '做完之后你直接在同一条会话上接着干 —— 不需要重新认证，也不需要重新连接。' +
  '所以遇到「需要人来一下」的情况（要选资产、要选账号、要输密码、屏幕认不出来），' +
  '正确做法是**把情况说清楚并让用户操作**，而不是猜一个数字发进去、也不是断言目标机不存在。\n' +
  '**会话绑定（很重要）**：写入类工具（exec / push / pull）必须让服务端知道你要哪条会话 —— ' +
'传 session（会话 id 或别名 A/B），或者先 bastion_use 绑定一次。没绑定（或绑定多于一条）时会**拒绝执行**，' +
'不会用"当前活动窗口"兜底（那可能是别的 AI 或用户正在用的会话）。要同时操作两台机器：各 bastion_connect 一次' +
'（会自动绑定成 A、B），之后每次 exec 传 session:"A" / "B"。绑定存在服务端，你的上下文被压缩后照样有效。\n' +
  '**执行长命令（构建/部署/安装）：别用 sleep 硬等**：\n' +
  '- `bastion_exec` 返回里看 `status`：`completed`（跑完，带 exitCode）/ `working`（还在跑）/ `input_required`（卡在密码/动态码/y-n/菜单上，需要人）。\n' +
  '- 返回 `working` 时**绝对不要重发同一条命令**（会重复执行，`rm`/`restart` 尤其危险）：用 `bastion_wait({jobId})` 等，' +
  '或 `bastion_job({jobId, sinceOffset})` 增量读完整日志，要停掉用 `bastion_cancel({jobId})`。\n' +
  '- `waitMs` 默认 15s（服务端夹到 55s，因为 MCP 客户端单次调用有自己的超时）；要等更久就**分段**调 `bastion_wait`。\n' +
  '- `quietMs` 默认 15s：构建的阶段之间会静默几十秒 —— 不要因为「暂时没输出」就以为命令结束了。\n' +
  '- 交互式命令（top/vi/sudo -i/菜单）用 `mode:"interactive"`（只发不等），然后让人接手。\n' +
  '**执行前先看清 cursor，重试要带幂等键**：' +
'tail / listSessions 会返回每个会话的 cursor（屏幕每有输出就 +1）。准备执行写操作时把刚才读到的 cursor 作为 expectCursor 带上 —— ' +
'这期间用户在那个终端里敲了东西、或另一个 AI 动了它，服务端会**拒绝执行**并让你先 tail。' +
'**重试同一件事时带同一个 idempotencyKey**：失败可能只是回包丢了（命令其实已经跑过），带 key 重试不会重复执行。\n' +
'**工具调用失败时按这个顺序处理，不要直接放弃**：\n' +
  '1. 先**原样重试一次** —— 扩展刚重载完（比如刚装了新版本）时会出现一次瞬时失败；\n' +
  '2. 还失败就调 **bastion_health**：它能返回 → 端点是好的，回到第 1 步重试或换个工具；\n' +
  '3. 连 bastion_health 都调不动 → 端点没在跑，请**明确告诉用户**：在 VS Code 里重启 MCP 服务器' +
  '（命令面板 → `MCP: List Servers` → BastionShell → Restart）或重载窗口，然后再试；\n' +
  '4. 无论哪种情况，都**不要**因为一次失败就转去让用户手工执行命令 —— 那会把「一个可修的小问题」变成「用户自己干活」。\n' +
  '命中高危规则的命令会被拒绝执行，这时请把结论告诉用户，由用户自己决定是否在终端里手动执行。'
