# BastionShell 0.3.14

> 两件事：**内核抽出第一阶段（M0–M2，行为零变化）** + **六道静态检查**（它们当场抓出一个真 bug）。
> 另外把「多堡垒机」的厂商知识下沉到档案，并让 AI 遇到多资产时**给结构化选项而不是弹窗**。

## 重构：抽出内核（行为零变化）

- 新增 `src/core/`（35 个文件 / 7,147 行）：执行/作业、账本/摘要、MCP 协议层、`/ui` 渲染、菜单识别、
  传输路径、zmodem、配置读写、危险命令、绑定……全部**不 import vscode**。
- 新增 `core/ports.ts`：`Logger` / `CredentialStore` / `TerminalSink` / `HostEvents` / `Paths` 五个端口，
  宿主启动时 `configureCore()` 注入。
- `status.ts` 的格式化函数拆到 `core/format.ts` 并 re-export；`DeployTask` 带 `vscode.Uri` 不下沉，
  `core/types.ts` 只放报告需要的窄类型。
- 宿主侧：70 个文件 / 17.5k 行 → **37 个 / 10.6k 行**。

## 新增：六道静态检查（都接进 `npm test`）

| 检查 | 抓什么 |
|---|---|
`check:core` | core 里出现 `vscode` 或反向引用宿主 → 红 |
`check:core-types` | `tsconfig.core.json` 不给 vscode 声明，`import 'vscode'` 在类型层直接失败 |
`check:load` | 用假 vscode **require 每一个 out 模块**（72 个）：捕获 `Cannot find module`、顶层崩溃 |
`check:requires` | out 里 419 处相对 `require()` 必须解析到真实文件（tsc 不看这些） |
`check:assets` | 源码引用的仓库资源（图标/文档/语法）必须存在 |
`check:cycles` | 新增循环依赖 → 红（已知遗留 5 个进基线，只允许变少） |
`check:unused` | core 里未使用的声明 → 红（宿主侧 52 处记为债务） |

外加 **激活冒烟测试**：不开 VS Code，用假 `vscode` 跑 `activate()`，断言命令都注册、订阅都挂上。
每条检查都做过"故意制造故障 → 确认变红"的验证。

## 修复（被新检查抓出来的真 bug）

- **`core/menuHintsFile` 还留着 `require('./log')`**：模块搬进 core 后这行没改，`log.ts` 依赖 vscode，
  **真机上会在装载期崩**。`check:requires` 一跑就露出来了。顺手删掉那段"惰性 require"的历史包袱。

## 多堡垒机：档案级资产策略 + 结构化提问

- 档案新增三个可选字段：`vendor`（厂商画像）、`userChoice`（选用户序号）、
  `assetPolicy`（`ask` / `first` / `id:3` / `name:研发`）。
- `decideAsset(assets, assetId, policy)`：**显式 assetId 永远优先**，其次档案策略，最后才问人。
- **AI 那条路不再弹窗**：`bastion_connect` 传 `ask:'fail'`，遇到"多条资产"时不再弹 QuickPick
  （弹窗会卡在 VS Code 那侧等人点），而是返回结构化问题：

  ```
  { status:'input_required', kind:'choose_asset', host, why,
    options:[{id,label,hint}], retry:{tool:'bastion_connect', params:{…}} }
  ```

  AI 把 `options` 念给用户，拿到编号后带 `assetId` 重试。
- **人选的答案会被记住**：通过 QuickPick 选完后，若档案没写过 `assetPolicy`，自动写 `id:<n>`，
  下次不再问；写失败只记日志，不影响连接。

## 验证

- **722 用例 / 697 通过 / 0 失败**；六道静态检查全绿。
- 新增测试：资产策略 `first`/`id`/`name`、显式 ID 优先于策略、结构化 options 形状。

## 安装

```bash
code --install-extension bastion-vscode-0.3.14.vsix --force
```

装完**重载窗口**。验证：`自检执行协议` 4/4 → `打开行动面板` 有卡片 → `在浏览器打开行动面板` 正常 →
连一台机器跑条命令 → `bastion_health` 里有"在跑作业/动作声明"。
