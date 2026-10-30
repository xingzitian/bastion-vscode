# BastionShell 0.3.13

> 这一版的主题是**让"AI 在干什么"可见**：新增行动面板（VS Code 内的 Webview + 浏览器网页版），
> 每条命令都带一句"为了什么"，按意图分组、落盘成账本、并对外提供一个只读 HTTP 接口给别的宿主（比如 DSH 浮窗）。
>
> 过程中真机跑出来的 4 个 bug 也一并修了 —— 其中一个（`why` 参数被转发器吞掉）不报错、不告警，
> 只表现为"参数传了但没生效"，最难查。

## 新增：行动面板

- **命令 `BastionShell: 打开行动面板（预览）`**（侧边打开）：按 **Intent（一次目的）** 折叠成卡片；
  每条命令给摘要 / 状态 / 退出码 / 耗时；正在跑的能「取消」；「看原文」展开脱敏后的命令。
- **命令 `BastionShell: 在浏览器打开行动面板（给 DSH/外部预览）`**：用同一份数据起一个独立网页版。
- **`exec` 新增两个参数**：
  - `why`（≤60 字）：AI 对"这条命令为了什么"的一句话声明，服务端截断、压平换行；
  - `intentId`：同一次任务的多条命令复用同一个值，面板据此把它们折叠成一张卡片。
  - **不写 `why` 会明确显示「AI 未说明」**，不假装有；`bastion_health` 会统计声明率（低于 80% 给提醒）。
- **命令摘要与脱敏**（纯函数 `commandSummary`）：
  `cd /data/app && git pull && npm ci && systemctl restart app` → `4 步：cd · git pull · npm ci · systemctl restart`；
  `--password=` / `-pXXX` / `-u user:pass` / `NAME=xxx` 脱敏，**但 `ssh -p 22` 的端口不误伤**。
- **`bastion_job` 的文本开头多一行**：`为了：部署新版本到两台｜4 步：cd · git pull · npm ci · systemctl restart`。
- **账本落盘**：`~/.bastionshell/action-ledger.jsonl`（同 `actionId` 后者覆盖；超 2MB 原子裁剪到 500 条）。
  **落盘的命令已脱敏**，凭据不进文件。
- **Intent 分组**：有 `intentId` 按它分；没有的按「同会话 + 60 秒相邻」连续归并，卡片上明确标「按时间归并」——
  不把猜测当事实。聚合状态优先级 `working > input_required > failed > completed`。

## 新增：给外部宿主的只读 HTTP 接口（`/ui/*`）

跑在扩展既有的 MCP 端点上（只监听 127.0.0.1，token 鉴权），**只读、不新增执行路径**：

| 路由 | 用途 |
|---|---|
`GET /ui/` | 自包含 HTML 面板；`embed=1` 去掉标题/页脚并收紧留白（浮窗用），`theme=light\|dark` 切配色 |
`GET /ui/actions` | `{ total, groups, groupsTotal, html }` —— 卡片片段可直接注入 |
`GET /ui/status` | `{ ok, working, inputRequired, checkedAt, version, capabilities }`，读**实时作业表**（不读账本，避免脏行） |
`GET /ui/stream` | SSE：`retry: 3000` + `ready` + 每个作业事件一个 `action` |
`POST /ui/cancel` | 同源取消（走既有的 cancel 能力） |

- `version` / `capabilities` 是**版本握手**：外部插件据此提示"升级 BastionShell"，而不是给用户一个空白面板。
- 契约文档：`docs/ui-api.md`。**在 `/ui/groups` 提供之前，消费方请走 `iframe + embed=1`**，
  不要在前端重写分组与状态回滚（那会导致两份语义漂移）。

## 修复（真机跑出来的）

- **`why` / `intentId` 被转发器吞掉**：`aiSessionApi` 的 exec 转发是逐字段列举的，新参数不在列表里
  → 面板与账本里全是"未说明"。改成**整体透传** `execRemote({ ...input, command })`，以后加字段不用再改这里。
  （同类事故第 4 次：headers / meta / 权限 / 这次。）
- **"在跑"的作业对面板完全不可见**：`emitJobEvent` 只在状态变化时发，创建时不发
  → 后台任务要等结束才突然出现在面板上。现在 `createJob` 在登记之后广播一次。
- **没有提示符 ≠ 停在菜单**：后台任务运行时 `health` 会输出"会话状态未知 / 请让用户走完菜单"，
  而屏幕没有提示符是因为**命令正在跑**。现在区分 `🔧 正在跑作业`，并给出"用 bastion_wait 跟进、不要发新命令"。

## 文档

- 新增 `docs/ui-api.md`（外部消费者契约）；README 补「行动面板」一节。

## 安装

```bash
code --install-extension bastion-vscode-0.3.13.vsix
```

装完**重载窗口**。验证三步：
1. 命令面板 → `BastionShell: 自检执行协议` → 四个用例应全绿
2. 让 AI 跑一条长命令 → 面板出现「在跑 + 取消」卡片 → 结束后变「完成」并带退出码
3. `bastion_health` 里应有一行 `动作声明：本次运行 N 个作业，intentId X%、why Y%`
