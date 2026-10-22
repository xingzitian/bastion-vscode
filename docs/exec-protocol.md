# 执行协议（exec / wait / job / cancel）

> 状态：**0.3.9 起在 VS Code 扩展实现**；桌面版待跟进（同一份语义）。
> 状态词直接对齐 MCP 官方 [Tasks 扩展](https://modelcontextprotocol.org/extensions/tasks/overview)
> （`working / input_required / completed / failed / cancelled`），这样将来升级到
> `2026-07-28` + `io.modelcontextprotocol/tasks` 时**对外形状不用改**，只是换个传输层。

## 1. 为什么要改（真实痛点）

旧协议只有一件事：写命令、等"结束标记"、把文本吐回去。三种完全不同的情况返回同一句话
「没等到命令结束标记」：

| 真实情况 | 旧返回 | 后果 |
|---|---|---|
| 命令还在跑 | 没等到结束标记 | AI 以为失败 → 重发命令（`rm` 跑两遍）或 `sleep` 空转 |
| 卡在交互提示（`password:` / `[Y/n]`） | 没等到结束标记 | 等满超时才叫人，浪费一整分钟 |
| 其实早就跑完，只是标记被吃/被折行 | 没等到结束标记 | AI 判"没成功"，白排查 |

而且旧实现的完成判定是「**输出静止 3 秒**」——日志阶段之间静默 5–30 秒的构建
（`docker build` 典型）会在第 3 秒就被判"结束"。**这是"没等到标记"的最大来源。**

## 2. 状态机

```
            ┌─────────────┐
   exec ───▶│   working   │──── 看到哨兵/退出码 ──▶ completed
            └─────────────┘
                   │  ├──── 退出码 ≠ 0 ─────────▶ failed（exitCode 非 0）
                   │  ├──── 检测到提示 ─────────▶ input_required（等人）
                   │  ├──── 提示符已回 + 静默 ──▶ completed（markerSeen=false）
                   │  └──── cancel ─────────────▶ cancelled
                   ├──── 会话丢了 ──────────────▶ failed（reason=session_lost）
                   └──── shell 退出（回菜单） ──▶ failed（reason=session_exited）
```

### 谁负责判完成（0.3.11 后的分工，很重要）

| 角色 | 职责 |
|---|---|
**作业** | 自己拿着哨兵与 `quietMs`：每来一块输出就扫一遍 `‹marker›:‹rc›`，命中即 `completed/failed`。**这条在 exec 已返回后仍然生效**。 |
**exec** | 只做"最多等 `waitMs`，然后如实报告当前状态"。**不再替作业下结论**（看到哨兵才收作业）。 |
**看门狗** | 每秒扫一次还在跑的作业：静默够久 **且提示符已回** → 兜底 `completed`（`markerSeen=false`）；屏幕回到堡垒机菜单 → `failed/session_exited`；会话没了 → `failed/session_lost`。 |

> 上一版把完成判定绑在 exec 的等待窗口里：exec 一超时返回，监听器被摘掉，就再没人看标记 ——
> 于是"命令早跑完了、状态永远 working、下一条命令被拒绝"，会话被锁死。这是压测抓到的 P0。
> 现在"静默"**不能单独**判完成（否则 `sleep 45` 会被误判），必须配合"提示符已回"。

| 状态 | 含义 | AI 该做什么 |
|---|---|---|
`working` | 还在跑 | **不要重发命令**，用 `bastion_wait` / `bastion_job` 跟进 |
`input_required` | 卡在交互提示，需要人 | 把 `prompt` 转告用户，让他在终端里输入（人或 AI 都能接着来） |
`completed` | 跑完且退出码 0 | 直接看输出 |
`failed` | 跑完但退出码非 0、会话丢失、或 shell 退出 | 看输出 + `exitCode` / `reason` 定位 |
`cancelled` | 被 cancel | —— |

**不可重发的硬规则**：`working` 期间重发同一条命令 = 可能重复执行（`rm`、`service restart`、
`kill -9`）。工具说明里必须写明，且 `idempotencyKey` 只能防"重试同一次调用"，防不了"故意再发一次"。

## 3. 四个工具

### 3.1 `bastion_exec`

```jsonc
{
  "session": "A",                 // 会话 id / 别名 / 唯一片段（沿用会话绑定规则）
  "command": "docker build -t x .",
  "waitMs": 20000,                // 本次最多阻塞多久；默认 15s
  "quietMs": 15000,               // 输出静止多久算"没输出了"；默认 15s（旧值是 3s）
  "mode": "shell",                // shell | interactive（interactive 只发不等，用于 top/vi/菜单）
  "background": false,            // true = 立刻返回 jobId，不阻塞
  "expectCursor": 12,             // 乐观并发（沿用）
  "idempotencyKey": "restart-nginx" // 幂等重试（沿用）
}
```

返回（文本 + 一段机器可读 JSON）：

```jsonc
{
  "status": "completed",
  "exitCode": 0,
  "elapsedMs": 241000,
  "cursor": 31,                   // 会话屏幕游标（下次可作 expectCursor）
  "cursorMoved": true,            // working 时据此判断"是不是真没动静"
  "lastLine": "Successfully tagged x:latest",
  "jobId": "j-7f3a",              // working 时一定有；completed 也可留着供复查
  "markerSeen": true,             // false = 靠静默判定完成，输出可能还差一点
  "logPath": "/tmp/bastion/job-j-7f3a.log"
}
```

**超时策略（重要）**：MCP 客户端对单次工具调用有自己的超时（本机 DSH 默认 **60 秒**，
`toolCallTimeoutMs` 可配）。所以：

- `waitMs` 会被夹到 **≤ 55 秒**（低于客户端预算），避免"客户端先超时、远端还在跑"这种最难诊断的状态；
- 请求的 `waitMs` 超过 55 秒 → **不阻塞**，直接转成作业并在返回里给 `jobId` + 说明。

### 3.2 `bastion_wait`

```jsonc
{ "jobId": "j-7f3a", "pattern": "阶段 5/9 完成", "waitMs": 30000 }
```

- 服务端阻塞（≤55s 一轮），满足任一条件即返回：状态变成终态、`pattern` 命中、超时。
- `pattern` 是**正则**，默认在"自上次读取以来的新输出"里找；不填就是纯等完成。
- 返回同 3.1 的形状 + `matched: true|false`、`matchedLine`。

这就是"不用 `sleep` 硬等"的正解：**等待发生在服务端，不消耗 AI 的轮次**。

### 3.3 `bastion_job`

```jsonc
{ "jobId": "j-7f3a", "sinceOffset": 0, "maxBytes": 65536 }
```

- 按**字节偏移**增量读完整日志（终端滚屏也不丢）。
- 返回 `chunk`（UTF-8 文本，可能按行截断）、`nextOffset`、`status`、`exitCode`、`logPath`。
- 日志在内存里滚动保存（上限 8MB，超出丢最老的）；`logPath` 是远端 `tee` 的文件副本，
  会话空闲时可用 `exec` 自己 `tail -c` 读（跨扩展重启仍然在）。

### 3.4 `bastion_cancel`

```jsonc
{ "jobId": "j-7f3a" }
```

- 往该会话发 `Ctrl-C`（`\x03`），并把作业标记 `cancelled`（协作式：不保证立刻停）。
- 没有它，误起的 `sleep 300` / `tail -f` 只能等人来按 Ctrl-C。

## 4. 作业日志：`tee`，不是 `nohup`

长命令（`background:true` 或 `waitMs` 超预算）会被包一层：

```sh
{ <command>; ec=$?; echo "$ec" > /tmp/bastion/job-<id>.rc; } 2>&1 | tee -a /tmp/bastion/job-<id>.log
```

为什么是 `tee`：

| 方案 | 人还能看到实时输出 | 会话稳定性 | 日志完整 |
|---|---|---|---|
`nohup` + 重定向 | ❌（终端被抢走） | ⚠️ 本机环境曾出现 nohup 把会话搞断 | ✅ |
**`tee -a`** | ✅（人的终端照常） | ✅（仍在同一个 shell 里，Ctrl-C 有效） | ✅ |

**核心不变量**：会话是**人和 AI 共用**的。任何让"人看不见"的方案都不能接受。

## 5. 兼容

- 所有新字段可选；不传 `waitMs` 时默认 15s（比旧的 3s 静默明显更稳）。
- 老客户端只读文本也能工作：文本里保留人话，末尾附机器可读 JSON。
- 状态词若将来接 Tasks 扩展，`working/input_required/completed/failed/cancelled` 原样对应。

## 6. 下一步（未做）

- `structuredContent` / `outputSchema`：把状态做成协议级结构化字段（现在先放文本 JSON）。
- `tasks/*`：升级到 `2026-07-28` 的 modern 协议后，把作业暴露成标准 task（`tasks/get`/`tasks/cancel`，
  可选 `notifications/tasks` = 真回调）。
- 桌面版对齐：桌面版的 `exec` 仍是旧的"哨兵 + 静默"逻辑。

## 7. 支持的交互提示模式（`input_required` 的判定依据）

识别是**正则匹配输出尾部 2KB**。当前认这些（大小写不敏感）：

| 模式 | 例子 |
|---|---|
sudo 密码 | `[sudo] password for deploy:` |
密码 | `Password:` / `密码：` |
动态码 | `Verification code:` / `动态码：` / `验证码：` / `OTP:` |
确认 | `(y/n)` / `(yes/no)` / `[y/n]` —— **尾部允许跟冒号/问号**（`Continue? (y/n): ` 也认） |
口令 | `Enter passphrase for key` |
菜单/选择 | `请选择目标机` / `输入编号` / `资产 ID` / `菜单` |
按键 | `Press any key` / `任意键继续` |

> 没被识别的自定义提示（例如 `[1-3] 请选择>` 之外的写法）会表现为"输出静止但不判完成" ——
> 这时用 `bastion_tail` 看屏幕，或按 `docs/exec-protocol.md` 报给我们加规则。

**凭据类**（密码/动态码/口令/验证码）在 MRTR 里**永远不代填**：客户端即使把值传上来也不会写进终端。

## 8. 客户端代际与功能可用性

| 能力 | legacy（initialize，≤2025-11-25） | modern（2026-07-28，每请求 `_meta`） |
|---|---|---|
`bastion_wait` / `bastion_job` / `bastion_cancel` | ✅ | ✅ |
`resultType` / `ttlMs` / `cacheScope` | ✗（不返回） | ✅ |
**Tasks**（`resultType:"task"`） | ❌ **拿不到**（扩展能力要按请求 `_meta` 声明） | ✅ |
**MRTR**（`input_required` 往返） | ❌ 拿不到 `requestState` | ✅ |
`subscriptions/listen` 推送 | ✅（收 `notifications/bastionshell/job`） | ✅（收 `notifications/tasks`） |

> 这就是压测里 "B8 声明了 tasks 却拿不到 task" 的原因：**legacy 客户端没法在 initialize 里声明扩展**，
> 服务端只认每个请求 `_meta` 里的 `clientCapabilities.extensions`。要让 AI 用上 Tasks/MRTR，
> 它的 MCP 客户端必须走 modern（每请求带 `_meta`）。