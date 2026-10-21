/**
 * 「AI 访问」的数据与**人话**（左侧树、右侧总览、签发对话框共用同一份）。
 *
 * 为什么单独抽出来：令牌的权限档如果只写 `observer/operator/full`，用户根本不知道
 * 它到底限制了 AI 什么（维护者原话："我都不知道现在令牌还能限制 ai 做什么"）。
 * 所以这里把每一档**能做什么 / 不能做什么**写成固定文案，三处 UI 都引用它，
 * 避免"签发时说一套、树里显示另一套"。
 *
 * 这个模块不 import vscode —— 纯数据，好测。
 */

export type AiScope = 'observer' | 'operator' | 'full'

export interface ScopeInfo {
  /** 短名（树/徽标） */
  label: string
  /** 一句话总结（UI 上直接显示） */
  plain: string
  can: string[]
  cannot: string[]
}

export const SCOPE_INFO: Record<AiScope, ScopeInfo> = {
  observer: {
    label: '只读',
    plain: '只能看，不能动',
    can: ['列会话', '读屏幕（tail）', '端点自检', '绑定会话（只是记住看哪条）'],
    cannot: ['执行命令', '上传/下载文件', '连新机器', '写个人习惯']
  },
  operator: {
    label: '可写',
    plain: '能干活，但不能自己开新机器',
    can: ['列会话 / 读屏幕', '执行命令', '上传/下载文件', '写个人习惯'],
    cannot: ['连新机器（connect 只给「全权」）']
  },
  full: {
    label: '全权',
    plain: '和主令牌一样，什么都能做',
    can: ['执行命令', '上传/下载文件', '连新机器', '写个人习惯'],
    cannot: []
  }
}

/**
 * 「没签发令牌、只靠请求头识别」的客户端。
 *
 * 这类客户端（例如带了 `X-BastionShell-Client: dsh` 的）拿的是**主令牌**，
 * 所以它的实际权限是**全权** —— 页面上必须这么写，不能让它显示成"没有权限"，
 * 否则用户会以为"我限制过它了"。
 */
export const HEADER_ONLY_INFO: ScopeInfo = {
  label: '未签发令牌',
  plain: '靠请求头识别，用的是主令牌 → 实际权限是全权',
  can: ['执行命令', '上传/下载文件', '连新机器', '写个人习惯'],
  cannot: []
}

/** 与 sessionBindings.normalizeClientId 同一套规则（这里不 import vscode，保持纯函数） */
export function normalizeAiClientId(raw: string): string {
  const v = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 32)
  return v || 'default'
}
/** 取某一档的说明（'header' = 没签发令牌、靠请求头识别） */
export function scopeInfoOf(scope: AiScope | 'header'): ScopeInfo {
  return scope === 'header' ? HEADER_ONLY_INFO : SCOPE_INFO[scope]
}

export function normalizeAiScope(raw: unknown): AiScope {
  return raw === 'observer' || raw === 'operator' || raw === 'full' ? raw : 'observer'
}

/** 一行总结：给树/总览/签发框共用 */
export function scopeOneLiner(scope: AiScope | 'header'): string {
  const s = scopeInfoOf(scope)
  const no = s.cannot.length ? `；不能：${s.cannot.join('、')}` : ''
  return `${s.label}（${s.plain}）—— 能：${s.can.join('、')}${no}`
}

/** 两行详情：树里的 tooltip 用 */
export function scopeDetail(scope: AiScope | 'header'): string {
  const s = scopeInfoOf(scope)
  return `权限：${s.label}（${s.plain}）\n能：${s.can.join('、')}\n不能：${s.cannot.length ? s.cannot.join('、') : '（没有限制）'}`
}

export function isAiScope(raw: string): raw is AiScope {
  return raw === 'observer' || raw === 'operator' || raw === 'full'
}

// ───────────────── 展示模型（纯函数，可测）─────────────────

export interface RawToken {
  label: string
  scope: string
  token: string
}

export interface RawBinding {
  alias: string
  sessionId: string
  name: string
}

export interface RawClientBindings {
  label: string
  sessions: Record<string, { sessionId: string; name: string }>
}

export interface RawSession {
  id: string
  name: string
}

export interface AiClientRow {
  /** 主令牌固定是 default */
  clientId: string
  label: string
  scope: AiScope | 'header'
  scopeLabel: string
  plain: string
  can: string[]
  cannot: string[]
  /** 令牌只显示尾部几位；签发时就提示"只显示一次" */
  tokenMasked: string
  isMain: boolean
  /** 没有独立令牌，靠请求头识别（权限实际是全权） */
  headerOnly: boolean
  bindings: RawBinding[]
}

export interface AiSessionOwnerRow {
  clientId: string
  label: string
  alias: string
  scope: AiScope | 'header'
}

export interface AiSessionRow extends RawSession {
  owners: AiSessionOwnerRow[]
}

export interface AiModel {
  clients: AiClientRow[]
  sessions: AiSessionRow[]
  /** 是否签发过独立令牌（false = 所有人共用主令牌） */
  hasCustom: boolean
  /** 有没有绑定（没有的话树上给"怎么用"的提示） */
  hasBindings: boolean
}

function mask(t: string): string {
  const s = (t ?? '').trim()
  if (!s) return ''
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`
}

/**
 * 把「令牌 + 绑定 + 当前会话」拼成 UI 模型。
 *
 * 注意：**主令牌永远显示**（它是 default/full，没签发过任何独立令牌时所有人都在用它），
 * 这样用户一眼能看到"现在的 AI 到底有多大权限"，而不是以为"没有令牌 = 没有权限"。
 */
export function buildAiModel(input: {
  tokens: RawToken[]
  clients: Record<string, RawClientBindings | undefined>
  sessions: RawSession[]
  mainToken?: string
}): AiModel {
  const bySession = new Map<string, AiSessionRow>()
  for (const s of input.sessions) bySession.set(s.id, { ...s, owners: [] })

  const addOwners = (clientId: string, label: string, alias: string, sessionId: string, scope: AiScope | 'header'): void => {
    bySession.get(sessionId)?.owners.push({ clientId, label, alias, scope })
  }

  const rows: AiClientRow[] = []

  // 主令牌永远显示
  const mainBindings = Object.entries(input.clients.default?.sessions ?? {})
    .map(([alias, b]) => ({ alias, sessionId: b.sessionId, name: b.name }))
    .sort((a, b) => a.alias.localeCompare(b.alias))
  rows.push({
    clientId: 'default',
    label: '主令牌（VS Code 自己 + 未标识的客户端）',
    scope: 'full',
    scopeLabel: SCOPE_INFO.full.label,
    plain: SCOPE_INFO.full.plain,
    can: SCOPE_INFO.full.can,
    cannot: SCOPE_INFO.full.cannot,
    tokenMasked: mask(input.mainToken ?? ''),
    isMain: true,
    headerOnly: false,
    bindings: mainBindings
  })
  for (const b of mainBindings) addOwners('default', '主令牌', b.alias, b.sessionId, 'full')

  // 已签发令牌（按归一化 clientId 索引）
  const tokenById = new Map<string, RawToken>()
  for (const tok of input.tokens) {
    const id = normalizeAiClientId(tok.label)
    if (!tokenById.has(id)) tokenById.set(id, tok)
  }

  // 出现的客户端 = 已签发令牌 ∪ 绑定文件里出现的 clientId（后者可能只靠请求头识别）
  const ids: string[] = []
  for (const id of tokenById.keys()) ids.push(id)
  for (const id of Object.keys(input.clients)) {
    if (id !== 'default' && !ids.includes(id)) ids.push(id)
  }

  for (const id of ids) {
    const tok = tokenById.get(id)
    const bindings = Object.entries(input.clients[id]?.sessions ?? {})
      .map(([alias, b]) => ({ alias, sessionId: b.sessionId, name: b.name }))
      .sort((a, b) => a.alias.localeCompare(b.alias))
    const scope: AiScope | 'header' = tok ? normalizeAiScope(tok.scope) : 'header'
    const info = scope === 'header' ? HEADER_ONLY_INFO : SCOPE_INFO[scope]
    rows.push({
      clientId: id,
      label: tok ? tok.label : id,
      scope,
      scopeLabel: info.label,
      plain: info.plain,
      can: info.can,
      cannot: info.cannot,
      tokenMasked: tok ? mask(tok.token) : '',
      isMain: false,
      headerOnly: scope === 'header',
      bindings
    })
    for (const b of bindings) addOwners(id, tok ? tok.label : id, b.alias, b.sessionId, scope)
  }

  return {
    clients: rows,
    sessions: input.sessions.map((s) => bySession.get(s.id)!).filter(Boolean),
    hasCustom: input.tokens.length > 0,
    hasBindings: rows.some((c) => c.bindings.length > 0)
  }
}

/** 会话行的归属摘要：`A(主令牌) · B(claude)`；没有绑定返回空串 */
export function ownersSummary(s: AiSessionRow): string {
  return s.owners.map((o) => `${o.alias}（${o.label}）`).join(' · ')
}
