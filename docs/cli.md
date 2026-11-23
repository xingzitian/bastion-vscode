# BastionShell CLI —— 使用手册

> 同一份内核（`src/core`）的**第二个宿主**：不开 VS Code，也能在有 MFA 的堡垒机 / 生产机上
> 让 AI 干活。终端、MCP、行动面板都在一个进程里；不打包运行时，**npm 包只有 0.4MB**。

## 装

要求 **Node ≥ 22**。

```bash
npm install && npm run compile && npm pack      # 产出 bastion-vscode-<版本>.tgz（约 396 KB）
npm install -g ./bastion-vscode-0.3.21.tgz      # 之后直接用 `bastionshell`
```

不想装全局：在仓库里 `node out/cli/main.js …`，参数完全一样。

## 三条命令

```bash
# ① 交互式终端 + MCP（Ctrl-] 退出，远端字节原样直通）
bastionshell connect xzt

# ② 后台：会话 + MCP + 网页终端，远端输出实时打在当前终端
bastionshell serve xzt

# ③ 跑一条就走（脚本 / CI）
bastionshell run xzt --exec "systemctl status nginx"
```

`serve` 还可以一次连多条（**共用一个 MCP 端点**）：

```bash
bastionshell serve xzt xb cana
```

启动后会打印三个地址：

```
[bastion] MCP 已启动：http://127.0.0.1:51913/mcp
[bastion] 端点文件：C:\Users\…\.bastionshell\mcp-cli.json
[bastion] 网页终端：http://127.0.0.1:51914/term?token=…
[bastion] 浏览器打开：http://127.0.0.1:51914/term?token=…
```

| 地址 | 干什么 |
|---|---|
`/term?token=…` | 真终端（xterm.js，本地资源，**离线可用**）；多会话时顶栏有下拉 |
`/ui?token=…` | 行动面板：在跑数量、动作分组、可取消、可按会话筛 |
`/mcp` | AI 客户端的 MCP 端点 |

## 让 AI 连上

端点文件 `~/.bastionshell/mcp-cli.json`：

```json
{ "url": "http://127.0.0.1:51913/mcp", "token": "a8691d09…", "pid": 12345,
  "profile": "xzt+xb", "sessionId": "s-3fbc-1", "termUrl": "http://127.0.0.1:51914/term?token=…" }
```

客户端配置（Streamable HTTP）：

```json
{ "mcpServers": { "bastion": {
  "url": "http://127.0.0.1:51913/mcp",
  "headers": { "Authorization": "Bearer <上面的 token>" }
} } }
```

> 桌面版的「⚡ / 🗂」会直接把这段配好：顶栏有「复制客户端配置」。

## 工具（12 个）

| 工具 | 说明 |
|---|---|
`bastion_listSessions` | 列出本进程的会话（id + 档案名） |
`bastion_health` | 端点自检（版本、会话、屏幕状态、最近作业） |
`bastion_listProfiles` | 共享 `profiles.jsonc` 里的档案 |
`bastion_use` | 把某个客户端绑定到一条会话（之后可省略 `session`） |
`bastion_exec` | 执行命令（能挂哨兵就**只认哨兵**，不会把长命令误判成结束） |
`bastion_wait` / `bastion_job` / `bastion_cancel` | 作业查询与取消（Ctrl-C，尽力而为） |
`bastion_tail` | 读屏幕末尾（已去 ANSI、`\r` 覆盖只留最后一段） |
`bastion_push` / `bastion_pull` | 传文件（直连档案走 **SFTP**，堡垒机自动降级 base64） |
`bastion_habits` | 读/写个人习惯（`read` / `remember` / `setPrivilege`），写**共享** `habits.jsonc` |

**不做**：`bastion_connect`（连接必须由人在命令行发起 —— 一进程一条会话，AI 不新建连接）。

多会话时要指定 `session`（**会话 id 或档案名都行**）：

```json
{ "name": "bastion_exec", "arguments": { "command": "hostname", "session": "xb" } }
```

不指定且有多条时，会明确报错并列出可用会话 —— **不猜**。

## 和扩展的差别

| 能力 | 扩展 | CLI |
|---|---|---|
工具数 | 13（多 `connect`） | 12 |
行动面板 | ✅ 右侧停靠 / 独立网页 | ✅ `/ui`（可按会话筛） |
传输期键盘锁 / zmodem rz-sz | ✅ | ❌（只有 SFTP + base64；网页终端用不到键盘锁） |
部署任务 / 端口转发 / 目录同步 | ✅ | ❌ |
凭据存储 | SecretStorage | **不落盘**：密钥认证，或每次问密码 |
共享文件 | `~/.bastionshell/*`（profiles / habits / 账本） | 同一份 ✅ |

## 安全边界（先看清楚再用）

1. **主机指纹不校验**：v1 只把 sha256 打进日志，**接受任何 host key**。
   在不可信网络里先用 `ssh` 连一次核对指纹，或等后续版本补 known_hosts。
2. **密码只在内存**：桌面 spawn 时经 **stdin** 传入（不进 argv —— argv 在任务管理器里可见）。
3. **token 在 URL 上**：与扩展 `/ui` 的取舍一致；只监听 `127.0.0.1`。
4. `http://` 不是 `https://`：本机回环，不经过网络。

## 多会话（hub-lite）

```
 bastionshell serve xzt xb
        │
        ├─ 会话 s-xxxx-1（xzt）──┐
        ├─ 会话 s-xxxx-2（xb） ──┤ 同一个 MCP 端点
        └─ 网页终端 / 面板 ──────┘（顶栏下拉切换）
```

- 一个进程一个端点 → AI 客户端**只配一次**；
- `bastion_use` 绑定按客户端隔离（多个 AI 各绑各的）；
- 关掉这个进程，端点就没了（这是"一进程多会话"的直接后果；要常驻就用它当服务跑）。

## 常见问题

**Q：报 `找不到 CLI 入口`？**
桌面版会自动探测（环境变量 → exe 同目录 → 往上 3 层找 `bastion-vscode/out/cli/main.js`）。
都没有时设 `BASTIONSHELL_CLI_JS=<仓库>/out/cli/main.js`（先 `npm run compile`）。

**Q：`connect` 说"需要交互式终端"？**
`connect` 要 TTY（raw 模式）。脚本里用 `run` 或 `serve`。

**Q：为什么 `serve` 起来的终端里，我敲键盘没反应？**
`serve` 不接管键盘（那是 `connect`）。它的终端在浏览器 `/term` 里。

**Q：传文件怎么选通道？**
直连档案默认 SFTP（复用已认证连接、可续传）；堡垒机档案降级 base64。
覆盖策略：`BASTIONSHELL_OVERWRITE=skip|overwrite|rename`（默认 skip）。

**Q：账本在哪？和扩展是同一份吗？**
`~/.bastionshell/action-ledger.jsonl`，字段与扩展一致（`actionId/brief/steps/status/exitCode/elapsed`），
外部面板不用区分宿主。

## 进程生命周期（为什么不该看到一堆 node）

桌面（Wails）会 spawn 一个 `serve` 子进程，**它跟着桌面进程活**：

- 桌面正常退出 → 子进程收 SIGTERM 退出；
- 桌面被强杀（更新/崩溃/任务管理器结束任务）→ 子进程每 5 秒检查父进程，发现没了就自己退出。

如果哪天又看到残留的 `node out/cli/main.js serve`，可以直接结束掉；
它们只是占着 SSH 连接和两个回环端口，不会影响档案或账本。

排查用的一行（PowerShell）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'out[\\/]cli[\\/]main\.js' } |
  Select-Object ProcessId, CommandLine
```

## 自己验证（真机 e2e）

```bash
npm run e2e:cli
# ✓ MCP 基础 6 / ✓ 网页终端 5 / ✓ 行动面板 9 / ✓ 传文件 5 / ✓ 多会话 5   → 30 pass / 0 fail
```

需要真档案（默认 `xzt` / `xb`）。设计与取舍见 `docs/cli-host.md`。
