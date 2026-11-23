# ⑤ 删除 Go 会话/执行/MCP 代码（清单与前置）

2026-11-23。统一核心 ①–④ 已完成（界面/会话/上传/转发都跑在 core 上），这一步只删**不再被使用的 Go 实现**。

## 删前闸门（已跑，全绿）

```
npm test                      800 用例 / 775 通过 / 0 失败
node tools/desktop-core-ui-e2e.mjs   3/3（profiles 来自 core、WS 握手、input→data 回显）
npm run e2e:cli               30/30（MCP/终端/面板/上传/多会话）
```

## 删除集（约 6.6k 行）

| 文件 | 行数 | 说明 |
|---|---|---|
session.go | 745 | Go 的 pty 会话 |
exec.go / exec_job.go | 337 / 566 | Go 的执行与作业 |
menu.go | 390 | 堡垒机菜单识别 |
transfer.go / upload.go / upload_verify.go | 625 / 51 / 219 | rz/sz、上传校验 |
forward.go | 87 | 端口转发 |
session_bindings.go | 380 | 会话绑定 |
ssh.go | 147 | 连接封装 |
lrzsz.go / deploy.go | 30 / 25 | 内嵌 lrzsz、部署入口 |
mcp_era.go / mcp_server.go / mcp_tools.go / mcp_register.go / mcp_output_schema.go | 1554 | Go 的 MCP |
ai_api.go / ai_access.go | 637 / 256 | AI 访问与会话 API |

## 保留（壳 + 共享配置）

- `main.go` / `app.go` / `assets.go` / `version.go` / `shell_cli*.go`：窗口、WebView2、拉起 core 后端
- `secrets*.go`（DPAPI）、`profile.go`、`shared_config.go`、`shared_rules.go`、`danger.go`、`jsonc.go`、`termtext.go`、`tailbuf.go`：配置与规则（core 侧也会读同一份文件）
- `server.go`：**只留壳路由**（`/api/secret`、`/api/upload`、`/api/pick-files`、`/api/profiles` 的写操作、`/api/quick-commands`、`/api/forwards`、`/api/shell/*`、`/api/shell/fs-probe`），`/ws` 与终端会话一起删

## 执行顺序（每步都可回退）

1. 先改 `server.go`：删 `/ws` 与已迁移路由，只留代理用的 4 条 → 构建 + 跑桌面验收（core 仍在 18090）
2. 再删会话/执行/MCP 文件 → 构建（此时编译器会把残留引用全部报出来，逐个清）
3. 再跑三套闸门 + 双击桌面副本人工验收（列档案/连接/终端/上传/转发）
4. 失败就 `git revert` 到 `8ef5e45`（④ 完成点）

## 注意

- `ai_api.go` 里可能有 core 端 MCP 仍需要的辅助函数（如 habits 解析）—— 删前先看被谁引用
- 删完后 Go 侧不再有 SSH 能力：**上传/转发/secret 仍走 core 的代理请求**，所以这 4 条路由不能一起删
## ⑤ 实际进展与剩余依赖（2026-11-23，分支 cleanup-go-mcp）

- `6f654ce` 第一刀：删 MCP + AI 层（mcp_*.go / ai_api.go / ai_access.go 及配套测试）→ **go build + go test 通过**。
- `3ed88d1` 第二刀 WIP：删 session/exec/transfer/upload/forward/ssh/lrzsz/deploy → **编译未通过**，原因是
  配置层与档案层引用了被删文件里的类型与函数：

```
shared_config.go:149,187   forwardRule        （原在 forward.go，被配置引用）
profile.go:334             forwardRule
server.go:86,94,121,122    connect / rememberConn / connMeta / forgetConn / stopForwardsOfConn
server.go:148              registerUploadRoutes
main.go:37                 initLrzsz
```

### 第二刀的正确顺序（下一轮照这个做）

1. 把 `forwardRule` **类型**从 forward.go 挪到 `shared_config.go`（只搬类型，不搬实现）
2. `server.go` 只保留 4 条代理路由（secret/upload/forwards/pick-files），删 `/ws` 与连接池
3. `main.go` 去掉 `initLrzsz()`（lrzsz 属于已删的传输层）
4. 再删实现文件 → `go build` / `go test` 通过
5. 三套闸门 + 桌面人工验收 → 合并回 main

## ⑤ 完成情况（2026-11-23，第三次续做）

第二刀已收尾，`go build ./...` / `go vet ./...` / `go test ./...` 全绿。

做了什么：

- `forwardRule` 类型（含 `ProfileID`/`Label`）搬进 `shared_config.go`，只在共享文件读写里用
- `server.go` 从 368 行砍到 80 行：删掉 `wsMsg` / `upgrader` / 连接池（`acquireConn` / `releaseConn`）/
  `handleForwardMsg` / `controlChannel` / `handleWS` / `/ws` 路由；只留壳路由的注册 + CORS
- `main.go` 去掉 `initLrzsz()`（内嵌 lrzsz 属于已删的传输层）
- 删 `transfer_test.go`（被测文件已随第二刀删除）

### 踩到的两处「界面契约」（删之前没注意，差点删过头）

1. **`/api/upload` 与 `/api/pick-files` 不能一起删。**
   界面是「浏览器环境」，拿不到真实文件路径：`shim.js` 先把文件字节 POST `/api/upload`
   让后端落成临时文件，再把**路径**喂给 WS 上传；选文件则要 `/api/pick-files` 弹系统对话框。
   这两件事都不是 SSH 能力，而是**壳能力**（写临时文件 / 系统对话框）。
   现在它们单独放在 `shell_routes.go`，由 core 反向代理过来（与 DPAPI 的 `/api/secret` 同一类）。

2. **`/api/ai-access` 是 Go 的 MCP 层产出的，必须由 core 接手。**
   桌面界面的「AI 访问」页读它（端点、令牌、客户端、绑定、会话）。
   现在 core 侧 `src/core/aiAccessView.ts` 用**扩展侧同一套** `buildAiModel` 生成，
   字段名与 Go 版保持一致，界面不改；`/api/ai-access/unbind` 也由 core 直接改
   `~/.bastionshell/mcp-bindings.json`。
   与 Go 版的差别只有一处，且是如实写出来的：桌面 MCP 现在只有一个令牌，所以
   `mainOnly: true`，页面上明说「要分档限权请去 VS Code 扩展签独立令牌」。

### 顺带修掉的一个老 404

`/api/profiles` 的 **GET** 由 core 直接回（为了不再依赖 Go 读档案），但「加机器/改机器/删机器」
仍是 POST/DELETE 走 Go 的档案存储。①–④ 期间这两条落到代理名单之外 → 404，
界面能看不能改。现在 `/api/profiles` 也进了代理名单（GET 在它之前就被 core 拦下了）。

