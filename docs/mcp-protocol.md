# MCP 协议：我们支持到哪一代（dual-era）

> 状态：**0.3.10 起扩展实现**。桌面版仍是 legacy（`initialize` + 2025-06-18 上限），待跟进。

## 1. 两代协议的区别（按官方规范）

| | **legacy**（≤ 2025-11-25） | **modern**（2026-07-28 起） |
|---|---|---|
握手 | `initialize` + `notifications/initialized` | **没有握手**；每个请求自带版本/身份/能力 |
版本位置 | `initialize` 参数里 | 请求 `params._meta['io.modelcontextprotocol/protocolVersion']`（HTTP 还有 `MCP-Protocol-Version` 头） |
结果标记 | 无 | 每个结果**必须**带 `resultType: "complete"`（或 `"input_required"` / `"task"`） |
列表缓存 | 无 | `tools/list` 等结果**必须**带 `ttlMs` + `cacheScope` |
会话 | `Mcp-Session-Id` 头 | **没有协议级会话**；跨调用状态用显式句柄（我们就是 `jobId`） |
版本不支持 | — | HTTP **400** + `-32022`，`data.supported` 列出支持的版本 |
头与 body 不一致 | — | HTTP **400** + `-32020` |
未知方法 | 200 + `-32601` | HTTP **404** + `-32601` |
服务端发现 | — | `server/discover`（**必须实现**） |

我们只实现了「服务端」这一侧需要的东西：`tools/*`、`server/discover`、`tasks/*`。
没有实现 `resources/*`、`prompts/*`、`subscriptions/listen`、MRTR 的完整往返。

## 2. 我们怎么做到"两代都兼容"

1. **请求判定**：带了 `_meta` 版本（或 `MCP-Protocol-Version` 头）→ modern；都不带 → legacy。
2. **结果形状**：modern 加 `resultType`（列表再加 `ttlMs`/`cacheScope`）；legacy 保持原样。
3. **状态码**：只有 **modern 请求**才把 `-32022`/`-32020` 映射成 400、`-32601` 映射成 404。
   老客户端把 400 当"端点不存在"、转而探测旧传输（规范 Backward Compatibility 一节点名了这点），
   所以 legacy 请求一律 200 —— 错误留在 JSON-RPC 层。
4. **`initialize` 保留**：modern 客户端不会发它，legacy 客户端照旧能用。
5. **`server/discover` 一直可用**：它本身就是 modern 形状，谁愿意调都能调。

## 3. Tasks 扩展（`io.modelcontextprotocol/tasks`）

我们的作业（`docs/exec-protocol.md`）与 Tasks 是**同一套状态词**，所以映射是恒等的：

| 我们的作业 | Tasks |
|---|---|
`working` / `input_required` / `completed` / `failed` / `cancelled` | 同名 |

规则（照规范实现）：

- **服务端声明**：`server/discover` 的 `capabilities.extensions['io.modelcontextprotocol/tasks'] = {}`
- **客户端声明**：请求 `_meta.clientCapabilities.extensions['io.modelcontextprotocol/tasks']`
- **只有声明了的客户端才会收到任务**（规范原文："Never return a task to a client that did not declare support"）
- 长任务返回 `{ resultType: "task", taskId, status, ttlMs, pollIntervalMs }`
- `tasks/get`：终态带 `result`（completed）或 `error`（failed）；`input_required` 带 `inputRequests`（elicitation 形状）
- `tasks/cancel`：转成我们作业的 `cancel`（往会话发 Ctrl-C）
- `tasks/update`：只回 ack —— 我们的人是在**终端里**直接输入的，任务状态由终端输出自己推进

> 没声明 Tasks 的客户端（包括现在的 DSH）仍然用 `bastion_wait` / `bastion_job` / `bastion_cancel`，
> 功能一样，只是要自己轮询。

## 4. 怎么自己验一遍

```bash
# 真起一个端点，把 legacy/modern 十一种行为打一遍（不需要 VS Code、不需要真会话）
node scripts/probe-protocol.js
```

期望输出（2026-07-28 合规）：

```
legacy initialize        | 200 | 2025-06-18 | ok(no resultType)
legacy tools/list        | 200 | tools=13   | ok(no resultType)
modern server/discover   | 200 | resultType=complete | versions=2026-07-28,2025-11-25,2025-06-18,...
modern tools/list        | 200 | resultType=complete | ttlMs=300000
unsupported version      | 400 (want 400) | code=-32022 (want -32022)
modern tools/call        | 200 | resultType=complete
unknown method modern    | 404 (want 404) | code=-32601
unknown method legacy    | 200 (want 200) | code=-32601
header mismatch          | 400 (want 400) | code=-32020
header only (no _meta)   | 200 | resultType=complete
no token                 | 401 (want 401)
```

## 5. 已做 / 还没做

**已做**：MRTR（resultType input_required + inputResponses 重试，凭据类拒绝代填）、subscriptions/listen + notifications/tasks、outputSchema（exec 族）、头校验提示、桌面版 dual-era + Tasks。

## 6. 还没做的（按影响排序）

1. **MRTR**（`resultType: "input_required"` + `inputResponses` 重试）：需要把 sudo/OTP 的提示
   变成协议级往返。现在只通过任务状态 + `inputRequests` 暴露，客户端不一定展示。
2. **`subscriptions/listen`**：`notifications/tasks` 真回调的通道；现在只能轮询。
3. **`Mcp-Method` / `Mcp-Name` 头的强制校验**：规范要求，我们**接受但不强制**（强制会让
   现在手配的客户端全部 400，等客户端都发头了再收）。
4. **桌面版**：仍只到 2025-06-18，没有 `server/discover`、没有 Tasks。
