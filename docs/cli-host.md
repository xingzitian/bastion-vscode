# CLI 宿主：一份语义，终端就是界面

> 状态：**A1 + A2 + A3 已完成**（2026-11-23）。`bastionshell run xzt --exec "…"` 真机通过；
> `core/screen.ts` 抽取完成（扩展零行为变化，全量测试 784 绿）。
> 下一步：A2（MCP 接线）。
> 决策日期：2026-11-23。背景：桌面版 0.9.2 已冻结，但**有人真的在用它的 MCP**；
> 直接给 Go 版补功能等于维护第二份语义（我们已经为此付过代价：`rz -y`、菜单识别、静默判定都写了两遍）。

## 0. 一句话

**把会话层从 VS Code 里拿出来，做成 CLI 宿主：一个进程 = 一条会话 = 终端 + MCP 服务端。**
`src/core`（39 文件 / 8,011 行，vscode-free）原样复用；不打包 JS 运行时（要求自备 Node ≥ 22）。

## 1. 体积策略（这条决定一切）

| 做法 | 结果 |
|---|---|
**用系统 Node（选定）** | npm 包 **3–5MB**；开发者本来就有 Node（DSH 自己就是 Node 跑的） |
打包 Node SEA / bun compile | +80–90MB —— **不做** |
打包 Electron/WebView 运行时 | 更重 —— **不做** |

> 之前的“100MB”是把运行时塞进安装包的账，不是 CLI 的账。**不打包运行时，就没有 100MB。**

## 2. 形态

```
bastionshell connect <档案>
   ├─ 终端（raw 模式）：stdin/stdout 字节直通 SSH shell 通道；SIGWINCH → window-change
   ├─ MCP 服务端：127.0.0.1:<随机端口>/mcp，token + url 写到 ~/.bastionshell/mcp-cli.json
   └─ core：执行协议 / 作业 / 账本 / 传输 / 菜单识别（原样复用）
```

- **一进程一会话**：不做 hub。要三条会话就开三个终端（每个进程一个端口，`mcp-cli.json` 里列出来）。
- **为什么不做 hub**：hub 要本地 socket + attach/detach + 单实例协商，多 1–2 周；等真的有人抱怨“三个端口太麻烦”再做。
- **退出**：`Ctrl-]`（telnet 习惯）退出 CLI；远端进程一并收尾。
- **日志**：写 stderr（不能污染 stdout 的终端字节流）。

## 3. 与其它宿主的关系

| 宿主 | 状态 | 说明 |
|---|---|---|
VS Code 扩展 | **主线**，13 工具 | 功能最全（面板/账本/`/ui`/自检/SFTP） |
**CLI** | **本次要做** | 给“不想开 VS Code 又要 MCP”的人；工具集见 §5 |
桌面 Wails 0.9.2 | **冻结** | 先用 CLI 回答“要 MCP 的人”；GUI 是否跟进见 §7 |

**三者的语义只有一份**：`src/core`。CLI 不复制任何业务逻辑。

## 4. 会话层怎么抽（这是唯一的真工程）

现在 `terminal.ts`(1,539) 里绑着 vscode 的部分要变成无头的 `engine/`：

| 要搬的 | 搬到哪 | 复用 |
|---|---|---|
`stripAnsi` / `tailText` / `readMarkerLine` / `isMarkerSafe` | **`core/screen.ts`**（纯函数） | 直接从 terminal.ts 移出，terminal 改为 re-export |
开 shell 通道、字节直通、resize | `engine/session.ts` | `ssh2` |
exec 完成判定（哨兵 / 静默规则） | `engine/session.ts` | 语义与 0.3.21 一致：**能挂哨兵就只认哨兵** |
屏幕状态 / 提示识别 | 复用 `core/menu.ts` | — |
作业 / exec 状态机 | 复用 `core/execJobs.ts` | — |
MCP 协议 / 工具分发 | 复用 `core/mcpServer.ts` + `core/mcpTools.ts` | — |
账本 | 复用 `core/actionLedger*.ts` | — |
传输 | 复用 `core/transferPath.ts` + `core/sftpTransfer.ts` | — |

**新增代码预估 600–900 行**（session 350–500、CLI 150–200、MCP 适配 150–200）。

## 5. 工具集（分两批）

| 批次 | 工具 |
|---|---|
A2（先做） | `bastion_listSessions` `bastion_health` `bastion_listProfiles` `bastion_use` `bastion_exec` `bastion_wait` `bastion_job` `bastion_cancel` `bastion_tail` |
A2 之后 | `bastion_push` `bastion_pull`（走 `core/transferPath`，SFTP 优先） |
**不做** | `bastion_connect`（一进程一会话，连接由人在命令行发起）、`bastion_habits`（先只读共享文件，不做写） |

返回 `未支持` 时必须明说原因，不能假装成功。

## 6. 凭据（**暂不定**）

v1 只做两条，都不落盘：

1. **密钥认证**（档案里 `authMethod: key` + `privateKeyPath`）—— 直接可用；
2. 否则**交互式问一次密码**（TTY 关闭回显），只在内存里用，进程退出即丢。

`~/.bastionshell/secrets.json`（桌面版）与 VS Code SecretStorage **都不读**。等想好了再统一。

## 7. 桌面 GUI 怎么办（B 阶段，可选）

**终端界面做成网页，由 CLI 进程自己提供**：

```
CLI 进程 ←─ WS ─→ xterm.js 页面（/term）
                        ↑
             浏览器直接开，或桌面 Wails 窗口把它装进去（19MB，Go 只改窗口 URL）
```

- 桌面版**不需要打包 Node**（引擎在 CLI 进程里）→ 体积仍是 19MB
- 桌面必须依赖 CLI 已安装并运行（启动时自动 spawn，找不到就提示装）
- 桌面 Go 里的会话引擎（约 5–6k 行）在 B 阶段之后删除

## 8. 里程碑与验收

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
**A1** | 文档 + `core/screen.ts` 抽取 + `engine/session.ts` + `engine/profiles.ts` + `engine/connect.ts` + CLI `run`/`connect` | 4–5 天 | `bastionshell run xzt --exec "echo hi"` 真机返回输出与退出码；`connect` 里能看到并敲命令 |
**A2** | MCP 接线（9 工具） | 3–4 天 | DSH 配 `mcp-cli.json` 后：`bastion_exec` 有输出、`bastion_tail` 能看到屏幕、账本落 `action-ledger.jsonl` |
**A3** | 网页终端（xterm.js + WS）+ `/ui` 面板 | 3–5 天 | 浏览器开 `http://127.0.0.1:<port>/term` 能敲命令；`/ui` 看得到动作 |
**B** | 桌面薄壳指向该页面 | 2–3 天 | 双击图标 → 自动起 CLI → 窗口里是真终端 |
**C** | 删 Go 引擎 | 2 天 | 构建通过、体积不涨 |

## 9. 止损点

- **A1 做不完**（会话层 5 天搞不定）：说明抽取得不够干净，先只做“桌面读扩展 `/ui` 的只读面板”（1–2 天）应急。
- **A2 之后没人用**：B/C 砍掉，桌面维持冻结 —— 只花了 1 周，且 `core/screen.ts` 抽取让扩展本身也更干净（净收益）。
- **不做的事**：不给 Go 引擎打功能补丁（B 阶段要删）；不做 hub；不打包运行时；不做 `bastion_connect`。

## 10. 已知缺口（先把话说明）

- **主机指纹不校验**（v1 接受任意 host key，只打日志）—— 必须实现 known_hosts 或用 `ssh2` 的 `hostVerifier`，属于安全债。
- 断线重连：v1 只提示并退出（不做自动重连）。
- zmodem（rz/sz）过 WS：A3 先只支持 SFTP/base64；rz/sz 后置。
- Windows 上的 raw 模式：`process.stdin.setRawMode` 在 Windows Terminal 可用，但老 conhost 需实测。

## 11. A1 实际结果（2026-11-23）

| 交付 | 状态 |
|---|---|
`docs/cli-host.md`（本文） | ✅ |
`src/core/screen.ts`（stripAnsi / tailText / readMarkerLine / isMarkerSafe / safeReadStart / stripMarker） | ✅ 从 terminal.ts 原样搬出，terminal re-export，**零行为变化** |
`src/engine/session.ts`（无头会话：裸字节、resize、exec 完成判定、tail、waitShellReady） | ✅ |
`src/engine/profiles.ts`（读共享 profiles.jsonc，不碰凭据存储） | ✅ |
`src/engine/connect.ts`（ssh2 连接 + shell 通道包装；host key 暂不校验） | ✅ |
`src/cli/main.ts`（`list` / `run` / `connect`；入口守卫，require 不执行） | ✅ |
测试 | `engineSession.test.ts` 4 条（静默不判完成 / unsafe 兜底 / 退出码透传 / tail 去 ANSI 与 \r） |

真机验证（xzt，密钥认证）：

```
$ node out/cli/main.js run xzt --exec "echo cli-ok; hostname"
cli-ok
VM-24-4-debian
[bastion] 退出码=0｜耗时 0s
```

**A1 踩到的两个坑**（都写进代码注释了）：

1. `check:load` 会把 `out/` 每个模块 require 一遍 —— CLI 一被加载就 `process.exit(1)`，
   把检查弄挂。修法：`if (require.main === module)` 入口守卫。
2. 连上就 exec，**登录 banner/MOTD 还在刷**，会被算进这次命令输出（真机看到 Debian 版权声明混进 stdout）。
   修法：`waitShellReady()` 等屏幕上出现 shell 提示符（最多 8s）。
## 12. A2 实际结果（2026-11-23）—— MCP 接上了

`src/cli/host.ts`（`McpSessionApi` 适配器）+ `src/cli/mcp.ts`（起端点、写 `mcp-cli.json`），
复用 `core/mcpServer` + `core/mcpTools` + `core/actionLedger`。

**新增 `serve` 命令**（非交互长驻）：起会话 + MCP，把远端输出实时打在当前终端 ——
这就是将来桌面薄壳要指向的"后台"。

```
$ node out/cli/main.js serve xzt
[bastion] MCP 已启动：http://127.0.0.1:52341/mcp
[bastion] 端点文件：C:\Users\...\.bastionshell\mcp-cli.json
```

真机 e2e（`tools/cli-mcp-e2e.mjs`，直接 POST `/mcp`）：

| 用例 | 结果 |
|---|---|
`bastion_health` | ✅ 返回版本/宿主/会话/屏幕状态 |
`bastion_exec` | ✅ `echo cli-mcp-ok; id -un` → 输出 + `completed` + 退出码 0 |
`bastion_tail` | ✅ 读到屏幕（含上一条命令的输出） |
`bastion_connect` | ✅ 明确回"CLI 版不支持由 AI 新建连接"（不假装成功） |
`bastion_listSessions` | ✅ 标出"CLI 宿主，一进程一条" |
账本 | ✅ 写进**同一份** `action-ledger.jsonl`：`brief/ steps / why / status / exitCode / elapsedMs` 与扩展一致 |

`mcp-cli.json` 示例（端口随机，**不抢**扩展的 39311；与扩展的 `mcp.json` 互不覆盖）：

```json
{ "url": "http://127.0.0.1:52341/mcp", "port": 52341, "token": "<32 hex>", "pid": 12345,
  "profile": "xzt", "sessionId": "s-72dc", "version": "0.3.21-cli" }
```

**A2 明确不做**（返回可读文案，不假装成功）：`bastion_connect`（一进程一连接）、
`bastion_push` / `bastion_pull`（下一批接 `core/transferPath`）、`bastion_habits`（写共享文件需确认流程）。

下一步 A3：网页终端（xterm.js over WS）+ `/ui` 面板，然后 B 阶段桌面窗口指向它。
## 13. A3 实际结果（2026-11-23）—— 网页终端 + 面板

`src/cli/termServer.ts`（新）：一个独立的本地 HTTP + WS 服务（单开端口，不污染 MCP 的 HTTP 层）。

| 路由 | 用途 |
|---|---|
`GET /term?token=…` | xterm.js 页面（**本地文件**，不依赖 CDN —— 内网/离线可用） |
`WS /term/ws?token=…` | 双向字节：`{t:'in',d}` / `{t:'out',d:base64}` / `{t:'resize',cols,rows}` |
`GET /ui?token=…` | 只读行动面板（复用 `core/uiPage`，数据来自同一份账本 JSONL） |
`GET /xterm/*` | xterm.js / css / addon-fit（从 node_modules 读白名单文件） |

只监听 127.0.0.1；所有路由要 `?token=`（与 MCP 同一个 token）。

真机 e2e（`tools/cli-term-e2e.mjs`，起 `serve xzt` 后真开 WS 敲命令）：

| 用例 | 结果 |
|---|---|
`/term` 页面 | ✅ 200，含 xterm 引用 |
无 token | ✅ 401 |
xterm.js 本地资源 | ✅ 200（>10KB） |
**WS 输入→远端→输出** | ✅ 发 `echo web-term-ok\r`，收到回显（真终端回路） |
`/ui` 面板 | ✅ 200，渲染出账本卡片 |

依赖变化（都是 npm 依赖，**不打运行时**）：`@xterm/xterm`、`@xterm/addon-fit`、`ws`（+ `@types/ws` 仅开发）。

下一步 B：桌面 Wails 窗口指向这个 `/term` 页面（Go 只改窗口 URL，不碰 MCP/会话逻辑）。
## 14. B 的硬前置已实现：CLI 可以接管旧 `mcp.json` 身份

```
bastionshell serve <档案> --mcp-file "%AppData%\bastionshell\mcp.json" --port 39311
```

- **复用文件里已有的 token**（不换 token），并按**旧桌面版 schema** 写回
  （`url` / `port` / `actualPort` / `token` / `updatedAt` / `note`）；
- 端口被占（比如 VS Code 扩展在跑 39311）→ 自动退到随机端口并在 `note` 里说明；
- 现有客户端配置**一个字都不用改**。

真机验证（2026-11-23）：39311 被扩展占用 → 退到 55994，token 保持 `LEGACY_TOKEN_…`，
`schema` 判定为旧版，网页终端也用同一个 token。

测试：`src/test/cliMcpEndpoint.test.ts` 4 条（默认 schema / 旧 schema / token 复用 / 端口退让）。
## 15. 传文件接上了（2026-11-23）

`src/engine/sftp.ts`（新）+ `CliHost.transferSession()`：把无头会话适配成 `core/transferPath` 要的传输会话。

- **每次传输新开 sftp 通道**、15s 开通道超时、`finally` 里 `end()`
  —— 这三条是从扩展那两次真机事故抄过来的（缓存通道会在断线后永远等不到回调；一次 push 开 3 个通道会撞 MaxSessions）。
- `sftpAllowed()` = 档案是 `direct` 且有 client；堡垒机档案不提供 sftp → `transferPath` 自动降级到 base64。
- `resolveRemoteDir` 先解析成绝对路径再传 —— 避免 `/root` 那个坑（空串 `realpath` 会落到家目录）。
- 下载落盘前 `mkdir -p`：否则 fastGet 会因**本机**目录不存在报 ENOENT，而 core 会显示成「远端路径不存在」。
- 覆盖策略：`BASTIONSHELL_OVERWRITE=skip|overwrite|rename`（默认 skip）。

真机 e2e（`tools/cli-sftp-e2e.mjs`，xzt 直连，5/5）：

| 用例 | 结果 |
|---|---|
`bastion_push` → `/tmp` | ✅ 通道：SFTP（复用已认证连接），239 B |
远端 md5 与本机一致 | ✅ |
同大小再传 → 跳过 | ✅ |
`bastion_pull` 回本机 `downloads/`，内容一致 | ✅ |
缺 `localPath` → 明确报错 | ✅ |
## 16. hub-lite：一个进程、多条会话、一个 MCP 端点（2026-11-23）

```
bastionshell serve xzt xb          # 两条会话，共用一个端点
```

- `CliHost` 内部从"一条会话"改成"会话表"；工具里用 `session:` 指定（**会话 id 或档案名都行**）。
- 没指定 session 时：绑定过就用绑定的 → 只有一条就用那一条 → 多条且没绑定 **明确报错并列出可用会话**（不猜）。
- `bastion_use` 的绑定按 `clientId` 存（一个 AI 客户端绑一条，互不干扰）。
- 网页终端：`/term?session=<id|档案名>`，页面顶栏有会话下拉；WS 也按 session 路由。
- 端点文件里的 `profile` 变成 `xzt+xb`，`sessionId` 是第一条（仅作标识）。

真机 e2e（`tools/cli-hub-e2e.mjs`，xzt + xb，5/5）：

| 用例 | 结果 |
|---|---|
`listSessions` 看到两条 | ✅ |
多条且不指定 session → 明确报错（`isError=true`） | ✅ |
`session: "xzt"` / `"xb"` 落到不同机器 | ✅（VM-24-4-debian vs 另一台） |
`bastion_use` 绑定后不带 session 也能用 | ✅ |
`bastion_tail` 指向指定会话 | ✅ |

**顺手修了 core 的一个真问题**：`bastion_exec` 的返回把 `isError` 吞掉了（只透传 text/structured），
导致"多条会话又没指定"这种客户端错误被 AI 当成执行成功。现在 `mcpTools` 会把 `r.isError` 透传 —— 扩展同样受益。
## 17. habits 接上了（2026-11-23）

`bastion_habits` 三个动作都可用（复用 `core/habits.ts`，写的是**共享** `~/.bastionshell/habits.jsonc`）：

| action | 行为 |
|---|---|
`read` | 展示该档案的提权习惯与个人习惯 |
`remember` | 追加一条习惯 |
`setPrivilege` | 改提权方式（none / sudo / sudo-i / ask） |

真机（MCP 调用）：`remember` → "已记下（xzt）"；`setPrivilege` → "已设置（xzt）提权习惯=sudo"；
`read` 立刻能看到；文件里落在 `"xzt"` 段下。测试写的是临时目录（`BASTIONSHELL_SHARED_DIR`），
不碰真实配置 —— 单测 `src/test/cliHabits.test.ts` 覆盖写入位置与非法参数。
## 18. 行动面板做成"活的"（2026-11-23）

之前 `/ui` 只是**打开时渲染一次**，而面板页里的 JS 会去轮询 `/ui/actions`、`/ui/status`、
订阅 `/ui/stream` —— 在 CLI 里全是 404（页面看着能用，其实不刷新）。

现在补齐四个接口（`src/cli/termServer.ts` + `CliHost` 的面板方法）：

| 接口 | 内容 |
|---|---|
`/ui/actions?limit&session` | `{html, groupsTotal}`：读同一份账本，用 `core/actionPanelHtml` 渲染；可按会话筛 |
`/ui/status` | `{working}`：本进程正在跑的作业数 |
`/ui/cancel`（仅 POST） | 给对应会话发 Ctrl-C，并把作业标成 cancelled |
`/ui/stream` | 极简 SSE：作业状态变化推 `event: action`，20s 心跳 |

真机 e2e（`tools/cli-panel-e2e.mjs`，7/7）：页面 / actions 有刚跑的动作 / status / cancel 405+POST /
SSE 收到 `: connected` / 无 token 一律 401。
## 19. 面板加了会话筛选（2026-11-23）

`/ui` 现在是"外壳"（会话下拉 + iframe），真正渲染在 `/ui/panel?session=`：

- 下拉里有「全部会话」+ 每个会话（id 显示在后面，方便和 `bastion_listSessions` 对上）；
- 内层面板仍走 `/ui/actions?session=` 轮询，所以筛选后刷新也是对的；
- 「← 回终端」链接直接跳 `/term`。

e2e 扩到 9 条（新增：`/ui` 有会话下拉、`/ui/panel` 可渲染）。