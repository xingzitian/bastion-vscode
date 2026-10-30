# 行动面板 HTTP 契约（`/ui/*`）

给外部消费者（DSH 插件、网页、脚本）用的**只读**接口。全部只监听 `127.0.0.1`，需要 token。

> 这份文档是**契约**，改字段要在这里先改、再改代码。已合入 0.3.13（含版本握手）。

## 端点与鉴权

| 项 | 值 |
|---|---|
基址 | `~/.bastionshell/mcp.json` 的 `url`（形如 `http://127.0.0.1:39311/mcp`）→ **去掉结尾 `/mcp`** |
token | 同一个文件的 `token` 字段 |
默认端口 | `39311`；**被占用时会退到随机端口**，所以必须读文件，不要写死 |
传 token | 查询参数 `?token=…`（浏览器/EventSource 只能这样）；`Authorization: Bearer …` 也接受 |
CORS | `/ui/*` 的 GET 返回 `Access-Control-Allow-Origin: *`；`/ui/cancel` 请**同源** POST |

## `GET /ui/status`

浮窗/小程序用的最轻接口（建议 5s 轮询，或直接用 `/ui/stream` 的事件驱动）。

```json
{
  "ok": true,
  "working": 1,
  "inputRequired": 0,
  "checkedAt": 1793328000000,
  "version": "0.3.13",
  "capabilities": ["status", "actions", "stream", "cancel", "embed", "theme"]
}
```

- `working` / `inputRequired` 来自**实时作业表**，不是账本。
  账本在宿主崩溃时会留下永远 `working` 的脏行 —— 消费方不要用账本自己数。
- `version` 是**扩展版本**：插件用它做握手，低于要求就提示"升级 BastionShell"，
  **不要**让用户面对空白面板。
- `capabilities` 是能力位：按需降级（例如没有 `embed` 就不要用 iframe 参数）。

## `GET /ui/?token=…&embed=1&theme=dark|light&limit=100`

自包含 HTML 面板（就是卡片本体）。

| 参数 | 说明 |
|---|---|
`embed=1` | 不渲染标题与页脚，padding 收紧（浮窗 420px 宽用） |
`theme` | `dark`（默认）/ `light` |
`limit` | 纳入分组的最近条数，默认 100，夹到 500 |

不传任何参数 = 完整页面（带标题/页脚/说明）。

## `GET /ui/actions?limit=100`

```json
{ "total": 42, "groups": 3, "groupsTotal": 17, "html": "<section class=\"intent …\">…" }
```

- `total`：账本总条数
- `groups`：**切片后**（最近 `limit` 条）的分组数 —— 旧字段，语义不变
- `groupsTotal`：**全量**分组数（浮窗上"共 N 组"用它）
- `html`：可直接注入的卡片片段（已转义、已脱敏）

## `GET /ui/stream?token=…`（SSE）

```
retry: 3000

event: ready
data: {"ok":true}

event: action
data: {"actionId":"j-0003","intentId":"deploy-42","sessionNo":1,"status":"working",
       "exitCode":0,"reason":"","why":"部署新版本","brief":"2 步：cd · git pull",
       "steps":2,"redacted":false,"elapsedMs":1200}
```

`status ∈ working | input_required | completed | failed | cancelled`。
`retry: 3000` 是标准重连提示；客户端自定义重连可以保留作兜底。

## `POST /ui/cancel?token=…`

```json
// 请求
{ "jobId": "j-0003" }
// 响应
{ "ok": true, "jobId": "j-0003" }
```

同源调用（不要给 `/mcp` 加 CORS 去代它）。取消会往对应会话发 Ctrl-C。

## 尚未提供

- **`/ui/groups`（结构化分组）** —— 给"原生渲染 + 按会话筛选/跳转"用。
  在它出现之前，插件请走 **iframe + `embed=1`**，不要在前端重写 `groupByIntent`
  （"同会话 + 时间相邻归并"和状态回滚在扩展侧算；两份实现必然漂）。

## 版本要求

- `capabilities` 里有 `embed` / `theme` / `status` 需要 **BastionShell ≥ 0.3.13**。
- 插件的 README 请写明最低扩展版本，并在握手里检查 `version`。
