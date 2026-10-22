# BastionShell 0.3.11

> 0.3.10 上线后，用三个 AI 会话做了 4 轮实机压测（40+ 用例，含协议层 curl 探测）。
> 本版修完压测报告里的**全部问题**，并补上 2026-07-28 协议的最后几块。

## 三个 P0（都是"看起来能用、实际会卡死"）

| # | 症状 | 根因 |
|---|---|---|
1 | 命令跑完状态永不翻转 → 下一条命令被拒，**会话被锁死** | 完成判定绑在 exec 的等待窗口里，exec 一超时返回监听器就被摘掉，再没人扫结束标记 |
2 | `true` 的文字写"退出码未知"，但结构化是 `exitCode:0` | 退出码 `0` 是 falsy，`if (hit)` 把成功当"没命中" |
3 | 25 秒的命令报"用时 41 秒" | ①哨兵行前面带 ANSI/提示符残留时"整行匹配"判不出来 → 只能等静默兜底；②`elapsedMs` 按"你查询的时刻"算 |

## 修了什么

**执行协议**
- 完成判定**归作业自己**：作业持有哨兵与 `quietMs`，每块输出都扫 `‹marker›:‹rc›`，命中即完成并让出会话
- 哨兵识别改为**任意位置 + 必须带数字**（容错前缀、又不把命令回显误判成完成）
- 静默**不能单独**判完成：兜底 = 静默 + 提示符已回；`elapsedMs` 按完成时刻算
- 终态区分：回到堡垒机菜单 → `session_exited`；终端被关/连接断 → `session_lost`

**AI 接口**
- `exec` 的 `inputSchema` 补齐 `waitMs/quietMs/mode/background/logToFile/force/session`（之前只在分发里读，严格客户端传不进来）
- 「会话已关闭」与「指认不到」分开；`maxBytes` 下限 1024 → **1**
- 绑定加载即清扫；`interactive` 模式也返回 `jobId`；`force` 后旧作业 `reason` 可见

**协议 2026-07-28**
- `server/discover`、`initialize` 非法版本 → `-32022`、未知方法 modern 404 / legacy 200
- **MRTR**：`input_required` + `inputRequests` + `requestState`，带 `inputResponses` 重试即可续跑
  —— **密码/动态码/口令永远不代填**
- **`subscriptions/listen`**（SSE 推送）、**Tasks 扩展**（`resultType:"task"` + `tasks/get|cancel|update`）
- **能力驱动降级**：客户端没声明 elicitation 就**不给** `InputRequiredResult`（否则它会抛 `no handler` 把作业卡死），
  退化成普通结果 + `hint`
- exec 族四个工具补 `outputSchema`

## 新增

- **命令「BastionShell: 自检执行协议」**：在选定会话上跑 `true` / `false` / `echo` / `sleep+echo` 四条内置命令，
  输出断言表。这是三轮回测踩的坑固化成的一键自证 —— 换环境 30 秒验完，不必再拉人复测。只跑内置命令。
- **设置 `bastion.inputPromptRules`**：自定义交互提示规则，先于内置匹配、坏正则跳过、改完即时生效
- **`bastion_health` 升级为诊断面板**：协议代际、客户端能力（`tasks` / `elicitation` ✓✗）、
  在跑作业、绑定清扫条数、请求头三连、提示识别规则数

## 文档

- `docs/exec-protocol.md`：谁负责判完成 / 支持的交互提示模式 / 客户端代际与能力可用性
- `docs/mcp-protocol.md`：能力矩阵与降级规则（一张表：声明什么 → 得到什么）

## 安装

```bash
code --install-extension bastion-vscode-0.3.11.vsix
```

装完**重载窗口**。验证：

1. 命令面板 → `BastionShell: 自检执行协议` → 应 4/4 通过
2. 让 AI 调 `bastion_health` → 应看到代际/能力/在跑作业/提示识别四行

## 桌面版

同步同一套语义（0.9.2）：作业自持完成、哨兵容错、dual-era 协议、`outputSchema`、本机作业日志。
