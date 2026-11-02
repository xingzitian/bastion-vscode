# 内核架构（TS core + 多个壳）

> 状态：**M0 / M1 / M2 已完成**（2026-11-02）：`src/core/` 35 个文件、7,147 行，0 处 vscode；全量测试 718 绿。下一步是 M3（SessionEngine）。
> 一句话目标：**一份语义，多个壳。** 判定标准只有一条 ——
> `src/core/` 里 `import ... from 'vscode'` 的数量为 **0**，且 core 的测试**不加载 vscode 桩**。

## 0. 冻结事项

| 事项 | 决定 |
|---|---|
Go 桌面版（`../bastion-wails`） | **冻结**：不加功能、不镜像修复；只修安全/严重 bug |
Electron 版（`../_archive/bastion-shell-electron-0.14.2`） | **归档**：只作参考实现（连接复用/重连/分屏/高亮），不参与构建 |
DSH 插件 | 独立仓库/包，**只依赖 wire 协议**（`docs/ui-api.md`） |
扩展 0.3.13 | 已发布；**迁移期间 `/ui` 与 MCP 的对外行为不许变** |

## 1. 不做（写死，防止边做边膨胀）

- ❌ 不重写 zmodem / 传输（批 1 完全不碰 transfer）
- ❌ 不把 VS Code 的 PTY 流改成 WS（扩展保持进程内嵌）
- ❌ 不复活 Go 内核、不复活 Electron
- ❌ 不在 M4 之前宣布"有独立版了"

## 2. 目标形态

```
src/core/                 ← 一份语义（不 import vscode）
  ports.ts                ← Logger / CredentialStore / TerminalSink / HostEvents / Paths
  format.ts               ← fmtBytes / fmtDuration / fmtSpeed / progressBar（从 status.ts 拆出）
  types.ts                ← 跨模块共享类型（DeployTask 等；从宿主侧下沉）
  session/                ← SessionEngine（stream、哨兵扫描、tail、cursor、屏幕状态）  [M3]
  exec/                   ← orchestrator(execRemote) / execJobs / execTee / execSchema / mrt  [M2/M3]
  ledger/                 ← actionLedger / actionLedgerIo / commandSummary                   [M2]
  mcp/                    ← mcpServer / mcpTools / mcpEra                                    [M2]
  ui/                     ← actionPanelHtml / uiPage（纯字符串，宿主决定塞哪）              [M2]
  runtime/                ← owner/pid 探测与协调（A+ 模型）                                 [M4]
        ↑ 注入端口
   host-vscode（Pseudoterminal / SecretStorage / workspace / 树 / Webview）
   host-daemon（http + pty-ws）        [M4]
   host-dsh / host-desktop（薄壳）      [M5]
```

## 3. 端口（唯一的耦合面，只做加法）

```ts
export interface Logger {
  info(msg: string): void
  error(msg: string): void
  /** 详细日志（对应 bastion.verboseLog）；不实现则忽略 */
  verbose?(msg: string): void
}
export interface CredentialStore {
  get(key: string): Promise<string | undefined>
  set(key: string, v: string): Promise<void>
  delete(key: string): Promise<void>
}
export interface TerminalSink {
  write(s: string): void
  close(code: number): void
  setTitle?(s: string): void
  dimensions?(): { cols: number; rows: number }
}
export interface HostEvents {
  notify(level: 'info' | 'warn' | 'error', msg: string): void
}
export interface Paths {
  configDir(): string
}
```

**组合根注入**：宿主在启动时调 `configureCore({ logger, paths, events })`；
core 内部通过 `coreLog()` / `corePaths()` 取用 —— 不把 logger 一路当参数传（27 个模块的签名不值得为此全改）。

**事件总线不动**：`onJobEvent` 已经是面板、账本、`/ui/stream` 三条路径的公共缝，天生就是 core 的接口。

## 4. A+ 模型（内嵌为默认，发现已有实例就复用）

- **写**：成为 owner 时写 `~/.bastionshell/mcp.json` 的 `owner` / `pid` / `coreVersion`（M4 引入）
- **读**：启动时先读 —— `pid` 存活且版本兼容 → **作为客户端连它**（会话共享）；不存活 → 清理后接管
- **降级**：文件损坏/不可写 → 退化为纯内嵌。**永远不能因为协调失败而不可用**
- **心跳**：owner 每 30s 更新 `checkedAt`；60s 未更新视为失效

## 5. 两类契约：谁必须跟着升

| 契约 | 载体 | 破坏性改动时谁必须升 |
|---|---|---|
**宿主端口 API** | `core/ports.ts` + `package.json` 的 `"core": "^1.x"` | 所有内嵌宿主（vscode / DSH host / daemon） |
**外部 wire** | `docs/ui-api.md` + MCP + `mcp.json` | DSH 插件、脚本、薄壳 |

规矩：**端口只加可选成员；wire 只加字段**。真要破坏就出 `core@2` / `/ui/v2`，让旧宿主原地不动。

## 6. 分批迁移

### 批 1 · 无风险搬家（M2，≈6.5k 行）

`commandSummary` `actionLedger` `actionLedgerIo` `actionPanelHtml` `uiPage` `selfTest`
`mcpServer` `mcpTools` `mcpEra` `execSchema` `execTee` `execIdempotency` `mrt`
`menu` `menuRule` `menuHintFile` `recognize` `authError` `danger` `habits` `sessionBindings`
`deployReport` `transferPath` `uploadVerify` `localPath` `shellQuote` `closedSessions` `execResult`
`execJobs` `config` `zmodem` `zmodemIo` `zmodem-js.d.ts`（实际搬家时发现它们也是纯的，一并进 core）

先做 4 处解耦（M1）：

| 现在 | 改成 |
|---|---|
`log.ts`（vscode，28 行） | core 用 `ports.coreLog()`；宿主在组合根注入 |
`status.ts` 的 `fmtBytes`/`fmtDuration`/`fmtSpeed`/`progressBar` | 拆到 `core/format.ts`，`status.ts` re-export（宿主代码零改动） |
`deployReport` → `deploy` 的类型 | `DeployTask` 下沉到 `core/types.ts` |
`config.ts` → `log` | 去掉，走 `coreLog()` |

### 批 2 · 最硬的一刀（M3，`terminal.ts` 1,122 行）

| 移到 core | 留在宿主 |
|---|---|
stream 生命周期与数据回填 | `vscode.Pseudoterminal` 的 `open/close/handleInput/setDimensions` |
哨兵扫描（含 ANSI 容错）与退出码解析 | `writeEmitter` 接线 |
tail buffer / `cursor` / 屏幕状态分类 | 只读模式（人手输入拦截） |
exec 接线、作业创建与广播、提示识别 | 终端命名/聚焦（`Terminal` 对象） |

目标：宿主侧 `terminal.ts` **≤120 行**。

### 批 3 · 宿主收口（M3 之后）

- `aiBridge` 拆两层：**exec 编排（状态文案、幂等、作业）→ core**；命令面板/通知/树刷新 → 宿主
- `connection.ts` 去 vscode（主要是通知与日志）
- `profiles` 拆「档案数据（core）」+「凭据（`CredentialStore`）」
- `slots` / `overview` / `*Tree` / `*Cmd` / `deployRun` / `transfer` **全部留宿主**（UI/终端密集）

### 批 4 · 新宿主（M4/M5）

- `bastionshelld`：core + `mcpServer` + `/ui`（HTTP 层已是纯的，≈200 行）
- DSH host：内嵌 core（DSH 本身是 Node，**零额外运行时**）
- 桌面薄壳：WebView2 指向 daemon 的 `/ui`（先只读面板）

## 7. 里程碑与验收

| 里程碑 | 产出 | 验收 | 估 |
|---|---|---|---|
**M0** | `src/core/`、`scripts/check-core.mjs`、`tsconfig.core.json`、本文档 | `npm run check:core` = 0 处 vscode；`npm test` 全绿 | 0.5d |
**M1** | `core/ports.ts` `core/format.ts` `core/types.ts`；4 处解耦 | core 里 grep `./log` `./status` `./deploy` = 0；测试绿 | 1d |
**M2** | 27 个模块搬进 `src/core/`，宿主改引用 | core 测试**不加载 vscode 桩**通过；`/ui` 与 MCP 行为不变（回放对比） | 1.5d |
**M3** | `SessionEngine` + `TerminalSink` | 录制字节流回放：`ExecResult` 逐字段相等 | 2–3d |
**M4** | runtime（owner/pid）+ `daemon` | `curl /ui/status` 200；关掉 VS Code 仍在；两宿主同时启动只有一个 owner | 2d |
**M5** | 桌面薄壳 | 面板可用、取消生效 | 2d |

**关键路径是 M3。**

## 8. 护栏

1. **CI 双构建**：`tsc -p tsconfig.core.json --noEmit`（`types: []`，导入 vscode 会直接编译失败）
2. **`scripts/check-core.mjs`**：扫 `src/core/**` —— 禁止 `vscode`、禁止反向引用宿主模块；核心模块清单与白名单校验
3. **行为等价测试**（M3）：录 20 份真机字节流（ANSI、切块哨兵、静默、菜单）作黄金样本
4. **wire 冻结**：迁移期间 `/ui/*` 与 MCP 字段/状态码不许变；`docs/ui-api.md` 是唯一事实

## 9. 风险

| 风险 | 对策 |
|---|---|
PTY 语义（回显、`\r` 覆盖、光标） | M3 用录制回放做等价验收，不靠肉眼 |
zmodem 时序被 sink 改动破坏 | 批 1 不碰 transfer；批 3 才动，且单独回归 rz/sz |
凭据：SecretStorage 带不走 | daemon 用 DPAPI/keytar；**没有等价存储就不做 daemon** |
同机多份 core、会话不共享 | A+：先探测 owner，有就复用（M4） |
daemon 运维（自启/端口/防火墙） | M4 只发"开发者自用"版，不进安装包 |

## 10. 收益（说实话）

- ✅ **语义一份**：`why` / 哨兵 / 静默 / `session_lost` 这类 bug 只修一次，不再镜像到 Go
- ✅ **新宿主变便宜**：只需实现 4 个端口 + 一个 UI
- ✅ **外部契约稳定**：DSH 插件几个月不用改
- ⚠️ **壳不会变成 100 行**：`host-vscode` 预计从 9.6k 降到 **~6k**（部署/传输/树/状态栏本来就在宿主侧）。
  核心收益是可复用，不是壳更小。

## 11. M0–M2 实际结果（2026-11-02）

| 指标 | 搬家前 | 搬家后 |
|---|---|---|
`src/core/` 文件数 | 0 | **35 个 .ts（7,147 行）** |
宿主侧 `src/*.ts` | 70 个 / 17,532 行 | 37 个 / 10,557 行 |
core 里的 vscode 引用 | — | **0**（脚本 + 独立编译双护栏） |
全量测试 | 718 | **718 绿** |

实际多搬了 5 个（计划里没列，但它们是纯的且被 core 依赖）：
`execJobs`、`config`、`menuHintsFile`、`zmodem`、`zmodemIo`、`zmodem-js.d.ts`。

过程中的三处真实耦合（已按计划解掉）：

1. `log`（vscode OutputChannel）→ `core/ports.ts` 的 `Logger`，宿主在组合根 `wireCoreLogger()` 注入
2. `status.fmtBytes/fmtDuration/fmtSpeed/progressBar` → `core/format.ts`，`status.ts` re-export
3. `DeployTask` 带 `vscode.Uri`，**不能**整体下沉 → `core/types.ts` 只放报告需要的窄类型
   `DeployReportTask`（结构化类型，宿主 `DeployTask` 天然满足）

护栏（两条，失败即红）：

- `npm run check:core` → `scripts/check-core.mjs` 文本层扫描（vscode / 反向引用）
- 同一个脚本里再跑 `tsc -p tsconfig.core.json` —— `types: ["node"]` 不给 vscode 声明，
  所以任何 `import 'vscode'` 在类型层就编译失败
- 两者都接进了 `npm test`（`npm run check:core && tsc -p ./ && node --test …`）