# BastionShell 0.3.15

> 0.3.14 是本地试装包（未上架），这个版本包含它之后的**全部**改动：
> 内核抽出（M0–M2，行为零变化）+ 六道静态检查 + 多堡垒机档案策略 + **端口转发修成真正的本地转发**。

## 修复：端口转发根本没在本机监听（同端口必然失败、页面打不开）

旧实现用的是 `rawClient.forwardIn()`（让**远端** bind，等价 `ssh -R`），而文档和桌面版都是
`ssh -L`（**本机**监听 → `forwardOut` 到远端）。两个现象都由此而来：

- **本地和远端同端口（如 8006→8006）必然失败**：远端那个端口正是你要访问的服务本身，
  报 `Unable to bind to 127.0.0.1:8006`；
- **换了端口"启动成功"但打不开网页**：压根没有本地监听，浏览器连的是空气。

现在：`net.createServer` 本机监听，每个连接 `forwardOut` 到 `remoteHost:remotePort`，双向 pipe；
停止即关 listener；同一规则重复启动幂等。错误信息也说人话了：

```
本地 127.0.0.1:8006 已被占用（不是远端问题）；把 localPort 换成别的（例如 18006）
```

**堡垒机语义**：`forwardOut` 的目标是**堡垒机视角**能访问到的地址 ——
`remoteHost: 127.0.0.1` 指堡垒机自己；要访问目标机上的服务，请填**目标机 IP**（规则模板与 README 都改了）。

## 重构：抽出内核（行为零变化）

- 新增 `src/core/`（35 个文件 / 7,147 行）：执行/作业、账本/摘要、MCP 协议层、`/ui` 渲染、菜单识别、
  传输路径、zmodem、配置读写、危险命令、绑定……全部**不 import vscode**。
- 新增 `core/ports.ts`：`Logger` / `CredentialStore` / `TerminalSink` / `HostEvents` / `Paths` 五个端口。
- 宿主侧：70 个文件 / 17.5k 行 → **37 个 / 10.6k 行**。

## 新增：六道静态检查（都接进 `npm test`）

| 检查 | 抓什么 |
|---|---|
`check:core` | core 里出现 `vscode` 或反向引用宿主 → 红 |
`check:core-types` | `tsconfig.core.json` 不给 vscode 声明，`import 'vscode'` 在类型层直接失败 |
`check:load` | 用假 vscode **require 每一个 out 模块**（72 个） |
`check:requires` | out 里 421 处相对 `require()` 必须解析到真实文件（tsc 不看这些） |
`check:assets` | 源码引用的仓库资源必须存在 |
`check:cycles` | 新增循环依赖 → 红（已知遗留 5 个进基线，只允许变少） |
`check:unused` | core 里未使用的声明 → 红 |

外加 **激活冒烟测试**（不开 VS Code，用假 `vscode` 跑 `activate()`）。
每条检查都做过"故意制造故障 → 确认变红"的验证。**它们当场抓出一个真 bug**：
`core/menuHintsFile` 残留 `require('./log')`，真机装载期会崩。

## 多堡垒机：档案级资产策略 + 结构化提问

- 档案新增 `vendor` / `userChoice` / `assetPolicy`（`ask` / `first` / `id:3` / `name:研发`）。
- `decideAsset(assets, assetId, policy)`：**显式 `assetId` 永远优先**，其次档案策略，最后才问人。
- **AI 那条路不再弹窗**：`bastion_connect` 传 `ask:'fail'`，遇到"多条资产"时返回结构化问题
  （`options:[{id,label,hint}]` + `retry`），AI 念给用户、拿编号重试。
- **人选的答案会被记住**：档案没写过 `assetPolicy` 时自动写 `id:<n>`，下次不再问。

## 验证

- **726 用例 / 701 通过 / 0 失败**；六道静态检查全绿（载荷 138 个模块、0 个新增循环依赖）。

## 安装

```bash
code --install-extension bastion-vscode-0.3.15.vsix --force
```

装完**重载窗口**。验证顺序：`自检执行协议` 4/4 → `打开行动面板` 有卡片 → 浏览器面板正常 →
连一台机器跑条命令 → **启动一条端口转发，同端口（8006→8006）应当能启动，浏览器能打开**。
