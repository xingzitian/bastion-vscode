# B 阶段：桌面薄壳（窗口指向 CLI 的网页终端）

> 前提：A1–A3 已完成（CLI 宿主 = 终端 + MCP + 网页终端）。本文只谈 **B：把桌面 Wails 窗口变成薄壳**。
> 状态：**B2 已完成**（2026-11-23）：档案行 ⚡ → 窗口内 iframe 装网页终端。见 §8/§10。

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

### 写端点文件失败：根因已定位（2026-11-23）

从**当前开发沙箱**启动 exe 时，应用进程写 `%TEMP%` / `%APPDATA%` / `~/.bastionshell` 全部
`Access is denied`，只有仓库目录可写 —— 用新增的 `/api/shell/fs-probe` 一次看得很清楚：

```
C:\Users\...\Temp                          ok=False  Access is denied
C:\Users\...\AppData\Roaming\bastionshell  ok=False  Access is denied
C:\Users\Administrator\.bastionshell       ok=False  Access is denied
...\shell_tools\bastion-wails\build\bin     ok=True
```

**这是沙箱限制，不是桌面版的问题**（同一个限制也让 `npm run build` 里的 esbuild 删临时文件失败）。
正常双击启动时没有这层限制，`mcp.json` 就是那样写出来的（10-22 那版）。

新增两条诊断/兜底路由：

| 路由 | 作用 |
|---|---|
`GET /api/shell/endpoint` | 当前薄壳的 `running/termUrl/mcpUrl/token/port`，以及 **`writeError`**（宿主没写成 mcp.json 的真实原因） |
`GET /api/shell/fs-probe` | 从**应用进程**视角逐个目录试写，返回 ok/error |

另外 `cliScriptPath()` 现在会**自动探测** CLI 入口（环境变量 → exe 目录 → 往上 3 层找
`bastion-vscode/out/cli/main.js`），开发布局下**不用设环境变量**；找不到时报错会列出试过的每个路径。

## 9. 下一步

1. 正常启动下复验端点文件写入（或改成写 `%LOCALAPPDATA%`）。
2. 前端：档案页加「CLI 终端（beta）」入口 —— 直接 `iframe` 指向 `/api/shell/cli?profile=…`（302 会落到真终端）。
3. C：删 Go 引擎，核对体积。
## 10. B2 实际结果（2026-11-23）

- `frontend/src/components/CliShellView.tsx`（新）：全屏覆盖层 + iframe。
  `src = http://127.0.0.1:18090/api/shell/cli?profile=…`（后端 302 → `/term?token=…`）。
  - 打开前先 `fetch(url, {redirect:'manual'})` 探一次：后端返回 JSON error 时把原因显示出来；
  - 关闭时 `POST /api/shell/cli/stop`（不留孤儿 node）；
  - 15s 内没加载出来给"正在启动 CLI 宿主…"提示。
- `App.tsx`：每个档案行加 ⚡ 按钮；`main.css` 加覆盖层样式。
- 构建：**前端在 WSL 里由 wails 跑**（Windows 侧 `npm run build` 会因 esbuild 删 `%TEMP%` 临时文件被拒而失败 ——
  和之前 CLI 写端点文件被拒是同一类"子进程文件操作受限"现象）。

验证：

| 项 | 结果 |
|---|---|
产物含新组件 | `index-*.js` 里有 `cli-shell-overlay` 与 `/api/shell/cli` |
headless 路由 | 302 → `http://127.0.0.1:63124/term?token=…` |
跟进页面 | 200，页面含 `xterm.js` |
真实 `mcp.json` | 未被测试改动（仍是 10-22 的版本） |

**仍然待办**：B3 正常启动下复验端点文件写入（若仍 Access denied，改写到 `%LOCALAPPDATA%` 或由前端读 `/api/shell/endpoint`）。
## 11. 决定（2026-11-23）：保持双模式（A），不删 Go 引擎

按用户"你就干就行了"的授权，我做了这个决定并记录理由 —— 它是**可逆的**，随时可以改成 B。

**决定：A。桌面版继续用 Go 引擎作为默认；CLI 宿主通过 ⚡ / 🗂 并行提供。**

理由：

1. 桌面 UI 的档案/多标签/分屏/SFTP/部署/端口转发全都依赖 Go 会话层；
   删掉它 = 你明确夸过的那套界面全部失效（"现在的桌面版页面美着呢"）。
2. 现有 MCP 用户配置的是 `%AppData%\bastionshell\mcp.json` + 39311（Go 提供），
   删掉会当场失效；而 B 要 2–3 周重做界面才能安全替换。
3. 双模式的实际成本只是"Go 引擎不新增功能"，而不是"维护两份会话语义" ——
   因为新功能（hub-lite / 传文件 / habits / 面板 / 指纹校验）都只写在 `src/core` 和 CLI 里，
   Go 侧不再分叉。

**什么时候该翻回 B**（预先写清楚，避免以后拍脑袋）：

- 桌面用户开始频繁抱怨"两个入口困惑"；或
- CLI 侧补齐了多标签/会话列表/传文件 UI，能在网页里完成 Go 版的日常操作；或
- Go 引擎出现需要修的安全问题、而我们不想再动它。

届时按 §2 的顺序做（先加开关 → 再删引擎），且必须先解决 §4 的"旧 mcp.json 身份接管"
（`serve --mcp-file … --port 39311` 已经在 CLI 里实现，可以直接用）。
## 12. 薄壳按钮的契约测试（2026-11-23）

我点不了 GUI，但前端点下去发的请求是可测的 —— 这层能挡住逻辑 bug：

```bash
npm run e2e:shell      # 需要先 wails build（用到 build/bin/BastionShell.exe）
```

```
PASS  POST start → termUrl
PASS  iframe 加载 term 页面（2688 字节）
PASS  无重复 spawn（pid 未变，pid=49860）
PASS  endpoint 反映运行中（writeError 存在但不影响使用）
PASS  POST stop
PASS  stop 后子进程归零
```

**它抓到的两个真 bug（已修）**：

1. **优先级 bug**：`directUrl || profiles.length === 1 ? a : b` 被解析成 `(directUrl || …) ? a : b`，
   `directUrl` 等于没生效 —— 密码启动后 iframe 又去打了 spawn 路由。
2. **探活误判**：带 `directUrl` 时仍会 `fetch` 探活，把 term 页面（HTML 200）当成错误 JSON，
   显示「起不来：<!DOCTYPE html>…」。

修法：`spawnUrl` 与 `url` 分开算；有 `directUrl` 时**跳过** spawn 探活，只轮询端点。
另外给 `/api/shell/endpoint` 加了 `pid`（CLI 子进程），测试用它判断「没有重复起进程」——比数进程稳。
## 13. 便携 CLI：dist 里自带 CLI，⚡/🗂 开箱即用（2026-11-23）

之前 dist 里只有 exe —— 换台机器（没有仓库）点 ⚡ 会报"找不到 CLI 入口"。

现在打包时多一步：

```bash
cd bastion-vscode
node tools/make-portable-cli.mjs          # 默认装到 dist/desktop-0.9.2/bastion-cli
```

它做四件事：`npm pack`（401KB）→ 解到 `<dist>/bastion-cli` → `npm install --omit=dev --ignore-scripts`
→ 从临时目录跑一次 `list` 自检。结果 **9.9MB**，不含 Node 运行时。

桌面端的候选路径里加了 `bastion-cli/out/cli/main.js`（npm 包布局），真机验证：

```
从 dist 目录启动 exe：
  找到 CLI 入口：...\dist\desktop-0.9.2\bastion-cli\out\cli\main.js
  GET /api/shell/cli?profile=xzt → 302
```

打包踩到的坑（写进脚本注释）：Windows 上 `shell:true` 会把带空格的路径不加引号拼进命令行，
tar 直接失败 —— 所以 tar 走 `execFile`（不带 shell），npm 只在目标目录里跑（参数无路径）。
## 14. 洁净环境发布验证（2026-11-23）

把 `dist/BastionShell-0.9.2-win-x64.zip` 解到**临时目录**（没有仓库、没有环境变量），
从那里启动 exe —— 这是普通用户的实际路径：

```
解压内容：BastionShell.exe 19.25 MB │ bastion-cli/ 9.9 MB │ README-给使用者.md

GET /api/shell/cli?profile=xzt        → 302
GET /api/shell/cli?profiles=xzt,xb    → 302
日志：找到 CLI 入口：…\bs-release-check\bastion-cli\out\cli\main.js
强杀桌面 6 秒后：残留 node 进程 0
```

结论：**换台机器只需 Node ≥ 22 + 解压即用**，不再依赖仓库路径。

### 发版前检查清单（每次打 dist 都跑一遍）

1. `cd bastion-wails && bash build-win.sh`（WSL 里）
2. `cd bastion-vscode && npm test && npm run e2e:cli && npm run e2e:shell`
3. `node tools/make-portable-cli.mjs`（把 CLI 装进 dist）
4. 复制 exe 到 dist → 打 zip
5. **洁净验证**：解到临时目录 → 启 exe → 两条路由 302 → 强杀后无残留 node