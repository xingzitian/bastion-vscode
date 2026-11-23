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
- `server.go`：**只留** `/api/secret`、`/api/upload`、`/api/forwards`、`/api/pick-files` 这几条给 core 反向代理用，`/ws` 与其余路由一起删

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
