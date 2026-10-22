# 会话身份与多客户端绑定（契约）

> 状态：**P0a / P0b / P2（cursor + 幂等键）已在 VS Code 扩展实现**（0.3.6 起）；**桌面版 P0a 已实现**（12 个工具），桌面版 P0b/P2 仍待做。这份文档是契约，VS Code 扩展（`bastion-vscode`）与桌面版（`bastion-shell`）都按它实现。
> 起因：一个 AI 同时操作两条会话时，"当前活动会话"是全局 UI 状态，两个 AI 会互相把指针挪走；会话名
> `用户@主机` 不唯一且用子串匹配 —— 结果是**命令可能落到错的机器上**，或者 AI 误判"位置不对"而新开会话。

## 不变式（任何实现都必须满足）

1. **写入类操作只能落到调用者自己绑定的会话上**；不确定就拒绝，**绝不回退到"当前活动终端"**。
2. **指认有歧义时拒绝**并列出候选，绝不"取第一个匹配"。
3. **绑定存在服务端**（文件 + 内存），AI 的上下文丢失/压缩不影响它的会话归属。
4. 人**看**会话（点开终端、`tail`）不受任何限制，且**不会改变 AI 的绑定**。
5. 任何拒绝都必须给出**下一步该做什么**（列出候选 id / 提示 `bastion_use`）。

## 1. 会话 id

- 会话创建时分配不可变 id：`s-` + 4 位小写十六进制（`s-7f3a`），进程内唯一、**不重用**；
  重建/重连 = 新会话 = 新 id（这是对的：它确实是一条新会话）。
- 终端名保持现状（`#3 deploy@10.0.0.1`，`bastion.sessionNumber` 控制是否带 `#N`），id 与名字并存。

## 2. 解析规则（所有 `session` 参数共用）

输入可以是：`会话 id` / `完整终端名` / `名字片段`。优先级与处理：

| 输入 | 行为 |
|---|---|
`数组内所有会话的 id 精确相等` | 命中（**首选**） |
`完整终端名精确相等`（含 `#N` 前缀） | 命中 |
`名字片段唯一命中`（忽略大小写、去空格） | 命中 |
`名字片段命中多条` | **拒绝**，列出候选（id + 完整名 + 状态） |
`没传 session` | 见 §3 |
`传了但一条都不命中` | 拒绝，附 `bastion_listSessions` 提示 |

## 3. 绑定与"没传 session"

- 绑定文件：`~/.bastionshell/mcp-bindings.json`（0600），按 **clientId** 分组：
  ```jsonc
  {
    "version": 1,
    "clients": {
      "default": {
        "label": "未标识客户端",
        "updatedAt": "2026-10-21T09:40:00+08:00",
        "sessions": {
          "A": { "sessionId": "s-7f3a", "name": "#3 deploy@10.0.0.1", "since": "..." },
          "B": { "sessionId": "s-9c21", "name": "#1 deploy@10.0.0.2", "since": "..." }
        }
      }
    }
  }
  ```
- 别名（`A`/`B`/…）由客户端自己取名（`bastion_use({session, as})`），服务端解析 —— **别名只对持有它的
  clientId 有效**，不同客户端的 `A` 互不相干。
- `没传 session` 时的解析顺序：
  1. 该 clientId 有 **1 条**绑定 → 用它；
  2. 该 clientId 有 **多条**绑定 → **拒绝**（"你有 2 条绑定，必须指定"）；
  3. **0 条**绑定 → 读取类（`listSessions`/`tail`/`health`）可以回退到"最近会话"，但**返回里必须写明用了哪条**；
     写入类 → **拒绝**（"先 bastion_listSessions + bastion_use"）。
- 绑定清理：会话不存在了 / 超过 12 小时未更新 → 加载时丢弃（不报错，只记日志）。

## 4. 客户端身份（分两阶段）

| 阶段 | clientId 来源 | 效果 |
|---|---|---|
**P0a** | 请求头 `X-BastionShell-Client: <label>`（可选）→ 用它；否则 `default` | 两个 AI 只要配不同的 header 就各自独立绑定；**都不配 → 共用一个 `default` 集合**，此时靠"多绑定必须指名"兜住安全（只会拒绝，不会打错机器） |
**P0b** | `mcp.json` 里的多把 token：`clients: [{token, label, scope}]`，主 `token` = `default`（full） | 真正的隔离 + 可吊销 + `observer`（只读）/`operator`/`full` 分档 |

> P0a 的 `X-BastionShell-Client` **不是鉴权**，只是区分用途；能被伪造，但在 127.0.0.1 本地使用场景够用。
> 文档与工具说明里必须这么写，别让人误以为它是安全边界。

## 5. 工具签名变更（向后兼容）

| 工具 | 变更 |
|---|---|
`bastion_listSessions` | 每条加 `id`、`完整终端名`、`profile`、`state`、`owners[]`、`yours`；末尾附"你的绑定：A=s-7f3a …" |
`bastion_connect` | 返回文案加 **id + 完整终端名**：`已连接到目标 10.0.0.1（会话 s-7f3a：#3 deploy@10.0.0.1）` |
`bastion_use`（**新增**） | `{session, as?}` → 绑定并返回 `A = s-7f3a（#3 deploy@10.0.0.1）` |
`bastion_exec` | 参数 `session`（`terminal` 保留为别名）+ 可选 `idempotencyKey`（P2 生效） |
`bastion_tail` / `bastion_push` / `bastion_pull` | 同样接受 `session` |
`bastion_health` | 增加"当前客户端绑定"一段 |

**行为变化（要写进工具说明，避免旧提示词踩坑）**：`bastion_exec` 不传会话时，
以前会落到"当前活动/最近会话"，现在**只会落在调用者自己的绑定上**，否则拒绝。

## 6. 拒绝文案（冻结，测试按这个断言）

- 多绑定未指定：
  `你现在绑定了 2 条会话：A=s-7f3a（#3 deploy@10.0.0.1）、B=s-9c21（#1 deploy@10.0.0.2）。请用 session 参数指定要操作哪一条 —— 这里不会替你猜。`
- 歧义：
  `「deploy@10.0.0.1」匹配到 2 条会话：s-7f3a（#3 deploy@10.0.0.1）、s-9c21（#7 deploy@10.0.0.1）。请用 session id 指定。`
- 未绑定（写入类）：
  `你还没有绑定任何会话（这是为了避免把命令发到别的 AI/人的会话上）。先 bastion_listSessions，再 bastion_use({session: "s-xxxx"})。`
- 绑定已失效：
  `绑定 A 指向的会话 s-7f3a 已经不在了（可能被关闭）。先 bastion_listSessions 重新选一条。`

### 6.1 一处刻意的例外：VS Code 内的 Copilot 直连

`vscode.lm` 注册的语言模型工具没有"客户端身份"，而且**人就坐在 VS Code 前面** —— 它保留旧行为
（没绑定时回退到活动终端），否则"手动连上机器、再让 Copilot 跑一条命令"这种最常见的用法会被卡死。
MCP 的外部客户端一律严格：带 `X-BastionShell-Client` 的各自隔离，不带的归 `default`（多绑定即拒绝）。
这条例外写在代码里（`allowActiveFallback`），不要顺手删掉。
## 7. 显式不做（本阶段）

- 不改认证/连接/认证重试/端口转发/文件传输语义；
- 不做 `compare` / `fanout`（会话组）—— 那是 P2 之后的事，但字段与 id 先留好；
- 不做 cursor/expect 与幂等键的实际拦截（P2），P0a 只在签名里占位。

## 8. 测试计划

- 解析：id 精确、全名精确、片段唯一、片段多条 → 拒绝文案、大小写/空格。
- 绑定：两个 clientId 互不干扰；别名解析；未绑定写入 → 拒绝；多绑定写入 → 拒绝；会话消失 → 绑定失效文案。
- 端到端（MCP HTTP）：同一 token + 不同 header 的两个"客户端"各 `use` 一条 → 各自 `exec` 落到自己的会话；
  都不传 header 时 → 第二次 `use` 后写入被拒（不会打错机器）。
- 兼容：老客户端只传 `terminal` 名字 → 仍能精确命中。

## 9. 实现状态

| 部分 | VS Code 扩展 | 桌面版 |
|---|---|---|
P0a（id / 解析 / 绑定 / fail-closed / listSessions） | ✅ | ✅ |
P0b（多令牌 + 权限分档） | ✅ | ⏳ 仍单令牌（clientId 固定 `default`） |
P2-a（cursor / expectCursor） | ✅ | ⏳ 只上报 cursor，写入暂不校验 |
P2-b（exec 幂等键） | ✅ | ⏳ 未做 |

两边**共用** `~/.bastionshell/mcp-bindings.json`（同一份格式），所以在哪边绑的 A/B 另一边都认。