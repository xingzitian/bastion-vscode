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

export function normalizeAiScope(raw: unknown): AiScope {
  return raw === 'observer' || raw === 'operator' || raw === 'full' ? raw : 'observer'
}

/** 一行总结：给树/总览/签发框共用 */
export function scopeOneLiner(scope: AiScope): string {
  const s = SCOPE_INFO[scope]
  const no = s.cannot.length ? `；不能：${s.cannot.join('、')}` : ''
  return `${s.label}（${s.plain}）—— 能：${s.can.join('、')}${no}`
}

/** 两行详情：树里的 tooltip 用 */
export function scopeDetail(scope: AiScope): string {
  const s = SCOPE_INFO[scope]
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
  scope: AiScope
  scopeLabel: string
  plain: string
  /** 令牌只显示尾部几位；签发时就提示"只显示一次" */
  tokenMasked: string
  isMain: boolean
  bindings: RawBinding[]
}

export interface AiSessionOwnerRow {
  clientId: string
  label: string
  alias: string
  scope: AiScope
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

  const clients: AiClientRow[] = []
  // 主令牌
  const mainBindings = Object.entries(input.clients.default?.sessions ?? {})
    .map(([alias, b]) => ({ alias, sessionId: b.sessionId, name: b.name }))
    .sort((a, b) => a.alias.localeCompare(b.alias))
  clients.push({
    clientId: 'default',
    label: '主令牌（VS Code 自己 + 未标识的客户端）',
    scope: 'full',
    scopeLabel: SCOPE_INFO.full.label,
    plain: SCOPE_INFO.full.plain,
    tokenMasked: mask(input.mainToken ?? ''),
    isMain: true,
    bindings: mainBindings
  })
  for (const b of mainBindings) {
    bySession.get(b.sessionId)?.owners.push({ clientId: 'default', label: '主令牌', alias: b.alias, scope: 'full' })
  }

  for (const t of input.tokens) {
    const scope = normalizeAiScope(t.scope)
    const cid = t.label
    const bindings = Object.entries(input.clients[cid]?.sessions ?? {})
      .map(([alias, b]) => ({ alias, sessionId: b.sessionId, name: b.name }))
      .sort((a, b) => a.alias.localeCompare(b.alias))
    clients.push({
      clientId: cid,
      label: t.label,
      scope,
      scopeLabel: SCOPE_INFO[scope].label,
      plain: SCOPE_INFO[scope].plain,
      tokenMasked: mask(t.token),
      isMain: false,
      bindings
    })
    for (const b of bindings) {
      bySession.get(b.sessionId)?.owners.push({ clientId: cid, label: t.label, alias: b.alias, scope })
    }
  }

  return {
    clients,
    sessions: input.sessions.map((s) => bySession.get(s.id)!).filter(Boolean),
    hasCustom: input.tokens.length > 0,
    hasBindings: clients.some((c) => c.bindings.length > 0)
  }
}

/** 会话行的归属摘要：`A(主令牌) · B(claude)`；没有绑定返回空串 */
export function ownersSummary(s: AiSessionRow): string {
  return s.owners.map((o) => `${o.alias}（${o.label}）`).join(' · ')
}
