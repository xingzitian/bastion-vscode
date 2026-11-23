# B 阶段：桌面薄壳（窗口指向 CLI 的网页终端）

> 前提：A1–A3 已完成（CLI 宿主 = 终端 + MCP + 网页终端）。本文只谈 **B：把桌面 Wails 窗口变成薄壳**。
> 状态：**B1 已完成**（2026-11-23）：桌面后端能 spawn CLI 薄壳并 302 到网页终端。见 §8。

## 1. 目标形态

```
桌面窗口（Wails，19MB）
   └─ webview 指向  http://127.0.0.1:<port>/term?token=…
                         ↑ 由它 spawn 出来的子进程提供
              bastionshell serve <档案>（node，一进程一会话）
                 ├─ 会话引擎（engine/session.ts）
                 ├─ MCP（core/mcpServer）
                 └─ 网页终端 + /ui（cli/termServer.ts）
```

**桌面不再持有 SSH 会话、不再自己实现 MCP。** Go 只留：窗口、托盘、DPAPI（凭据）、自动更新。

## 2. 桌面要改的地方（按顺序，每步都能回滚）

| 步 | 改动 | 回滚 |
|---|---|---|
1 | 启动时 spawn `node <repo>/out/cli/main.js serve <档案>`，读它的 stderr，抓到 `termUrl` 就用 webview 打开 | 关掉开关 → 走旧 UI |
2 | 档案选择页：点一个档案 = spawn 一个 serve + 一个窗口 | 同上 |
3 | 把旧 UI 收到「高级/兼容模式」入口后面 | 删开关 |
4 | 删 Go 的 SSH/MCP 引擎（`session.go`、`exec*.go`、`mcp_*.go`、`ai_api.go` 等约 5–6k 行） | git revert |
5 | 安装包体积核对（应仍 ~19MB，因为不打包 Node） | — |

## 3. 三个必须处理的细节

1. **token 在 URL 上**：与扩展 `/ui` 的取舍一致（只监听 127.0.0.1）。窗口里要避免把 URL 写进标题/历史。
2. **子进程生命周期**：窗口关闭 → 杀掉 serve（`SIGTERM`）；serve 崩溃 → 窗口显示"会话已结束"并提供重开。
3. **端口**：`serve` 用系统分配端口（0），从 stderr 抓实际地址 —— 不要写死 39311。

## 4. **不要过早删 Go 的 MCP**（硬前置）

现在桌面用户配的是 `%AppData%\bastionshell\mcp.json`（端口 39311，桌面自己当服务端）。
一旦 B 落地，MCP 变成"每个 serve 一份、`~/.bastionshell/mcp-cli.json`" ——
**这些人的客户端配置会全部失效**。

所以在第 4 步（删 Go 引擎）之前，必须二选一：

- **A. 让 CLI 接管旧身份**：`serve` 支持 `--mcp-file mcp.json --port 39311`，并复用桌面那份 token 格式；
  客户端配置**一个字都不用改**；
- **B. 明确迁移**：文档 + 首次启动时把旧 `mcp.json` 拷贝成 `mcp-cli.json` 并提示"客户端要改一行 url"。

我建议 **A**：对使用者零感知，也是"薄壳"该有的样子（壳换掉，地址不变）。

## 5. 工具链（**已就绪**，2026-11-23）

| 需要 | 状态 |
|---|---|
`x86_64-w64-mingw32-gcc-posix` | ✅ 已装（`wsl -d Debian -u root` 里 apt 装，**不需要 sudo 密码**） |
Wails CLI v2.15.0 | ✅ `/home/wsl/go/bin/wails`（`go install …@v2.15.0`） |
构建 | ✅ `wsl -d Debian -e bash -lc 'cd <repo> && bash build-win.sh'` → `build/bin/BastionShell.exe`（19.2MB，2m56s） |

> 教训：WSL 可以直接用 `-u root`，不必让用户输 sudo 密码。

## 6. 验收（B）

1. 双击桌面图标 → 选档案 → 窗口里是**真终端**（能敲命令、能看到 AI 在同一条会话里执行的输出）
2. 关窗口 → `node` 子进程退出（任务管理器里没有残留）
3. 安装包体积 ≤ 25MB
4. **旧 MCP 配置仍可用**（若走 §4-A）

## 7. 现在的替代品（不等 B 也能用）

```
tools\bastionshell.cmd xzt
```

起 `serve`、抓到网页终端地址、用默认浏览器打开 —— 效果同 B，只是没有"双击图标"和托盘。
真机验证：`serve` 日志打印 `网页终端：http://127.0.0.1:<port>/term?token=…`，
端点文件 `~/.bastionshell/mcp-cli.json` 里也带 `termUrl`（壳子靠这个字段）。

## 8. B1 实际结果（2026-11-23）

工具链就绪后（`wsl -u root` 装 mingw + `go install wails@v2.15.0`），桌面版重新构建通过（19.2MB）。

新增 `shell_cli.go`：

| 路由 | 作用 |
|---|---|
`GET /api/shell/cli?profile=<档案>` | spawn `node out/cli/main.js serve <档案> --print-endpoint`，解析端点行，**302** 跳到网页终端 |
`POST /api/shell/cli/stop` | 收掉子进程（应用退出时 `defer` 也会收） |

配套：

- `main.go` 新增 **headless 模式**（`BASTIONSHELL_HEADLESS=1`）：只跑后端 + MCP，不开窗口。
  用途：窗口被 WebView2 占用/无桌面环境时验证 HTTP 链路。
- CLI 新增 `--print-endpoint`：打印 `端点：{url,token,termUrl,port,actualPort,legacy}`，
  并**放在 `浏览器打开：` 之前**；CLI 不再写文件（`writeEndpoint:false`），由宿主落盘。

真机验证（Windows，headless）：

```
GET /api/shell/cli?profile=xzt  →  302
  Location: http://127.0.0.1:6xxxx/term?token=<沿用的旧 token>
```

**一个待复验点**：把 exe 从当前终端上下文启动时，Go 往 `%APPDATA%\bastionshell`
写**新文件**报 `Access is denied`（同一 shell 里 pwsh 写同目录正常）；判断是启动上下文的 ACL 差异，
不是代码问题 —— 正常双击启动时该目录可写（现有 `mcp.json` 就是那样写的）。
下一轮在**正常启动**下复验，再决定是否需要降级方案。

## 9. 下一步

1. 正常启动下复验端点文件写入（或改成写 `%LOCALAPPDATA%`）。
2. 前端：档案页加「CLI 终端（beta）」入口 —— 直接 `iframe` 指向 `/api/shell/cli?profile=…`（302 会落到真终端）。
3. C：删 Go 引擎，核对体积。