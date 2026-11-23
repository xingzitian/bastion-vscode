/**
 * 「AI 访问」页面数据：把 core 的 {@link buildAiModel} 摊成桌面界面（`/api/ai-access`）认的字段。
 *
 * 为什么要有这一层：桌面界面是 ①–④ 阶段「一字不改」保留下来的，它读的是原来 Go 后端
 * `ai_access.go` 生成的字段名（endpoint / tokenMasked / clients / sessions / bindingsFile …）。
 * 统一核心之后 Go 的 MCP 层删了，这份数据由 core 出，字段名保持兼容，界面就不用改。
 *
 * 与 Go 版的一处**语义差别**（有意为之）：Go 版还能列出「扩展侧签发的独立令牌」，
 * 因为它在同一个进程里管着令牌表；桌面版的 MCP 现在由 core 的 CLI 宿主提供，
 * 只有一个令牌，所以这里如实写 `mainOnly: true`，并在 note 里说清去哪儿分档限权。
 */

import { buildAiModel } from './aiAccess'
import type { BindingsFile } from './sessionBindings'

/** 一条绑定（哪个 AI 客户端、用哪个别名、指向哪条会话） */
export interface DesktopAiBinding {
  alias: string
  sessionId: string
  name: string
}

/** 一个 AI 客户端（桌面版通常只有「主令牌」这一行） */
export interface DesktopAiClient {
  clientId: string
  label: string
  scope: string
  scopeLabel: string
  plain: string
  can: string[]
  cannot: string[]
  isMain: boolean
  /** 不是本机主令牌（绑定文件里出现了别的 clientId） */
  external: boolean
  bindings: DesktopAiBinding[]
}

/** 会话行 + 它被谁绑着 */
export interface DesktopAiSession {
  id: string
  name: string
  owners: { clientId: string; label: string; alias: string }[]
}

export interface DesktopAiAccess {
  /** MCP 端点（`http://127.0.0.1:39311/mcp` 这种） */
  endpoint: string
  /** 打码后的令牌（给人看） */
  tokenMasked: string
  /** 原文令牌（"复制客户端配置"用；只在本机 127.0.0.1 上返回） */
  token: string
  /** 只有一个令牌（桌面版没有分档令牌表） */
  mainOnly: boolean
  clients: DesktopAiClient[]
  sessions: DesktopAiSession[]
  bindingsFile: string
  note: string
}

export interface DesktopAiAccessInput {
  endpoint: string
  token?: string
  bindings: BindingsFile
  sessions: { id: string; name: string }[]
  bindingsFile: string
  /** 主令牌那一行的显示名（桌面版和扩展侧说法不同） */
  mainLabel?: string
  note?: string
}

const DEFAULT_MAIN_LABEL = '主令牌（桌面版只有一个令牌）'

const DEFAULT_NOTE =
  '桌面版只有一个令牌：拿到它的 AI 都是「全权」（能执行命令、能上传下载、能连新机器）。' +
  '要按客户端分档限权，请在 VS Code 扩展里签发独立令牌。'

/**
 * 拼出页面要的整块数据。
 *
 * 纯函数：绑定文件、会话表都由调用方读好传进来（好测，也不让 core 去碰文件系统）。
 */
export function buildDesktopAiAccessView(input: DesktopAiAccessInput): DesktopAiAccess {
  const model = buildAiModel({
    tokens: [], // 桌面版这条链路没有独立令牌表
    clients: input.bindings.clients ?? {},
    sessions: input.sessions,
    mainToken: input.token ?? ''
  })

  const main = model.clients.find((c) => c.isMain)
  const clients: DesktopAiClient[] = model.clients.map((c) => ({
    clientId: c.clientId,
    // 主令牌那行换成桌面版的说法；其它行（绑定文件里出现的 clientId）保留原样
    label: c.isMain ? input.mainLabel ?? DEFAULT_MAIN_LABEL : c.label,
    scope: c.scope,
    scopeLabel: c.scopeLabel,
    plain: c.plain,
    can: c.can,
    cannot: c.cannot,
    isMain: c.isMain,
    external: !c.isMain,
    bindings: c.bindings.map((b) => ({ alias: b.alias, sessionId: b.sessionId, name: b.name }))
  }))

  return {
    endpoint: input.endpoint,
    tokenMasked: main?.tokenMasked ?? '',
    token: input.token ?? '',
    mainOnly: true,
    clients,
    sessions: model.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      owners: s.owners.map((o) => ({ clientId: o.clientId, label: o.label, alias: o.alias }))
    })),
    bindingsFile: input.bindingsFile,
    note: input.note ?? DEFAULT_NOTE
  }
}
