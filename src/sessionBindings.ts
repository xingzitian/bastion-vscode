/**
 * 会话绑定：**服务端记住「哪个客户端在哪条会话上」**，并统一解析「要用哪条会话」。
 *
 * 为什么需要它（真实故障）：一个 AI 同时操作两条会话，或者两个 AI 并行排查时，
 * 以前的解析顺序是「没传会话 → 用 VS Code 的活动终端 → 再退到最近会话」——
 * 而"活动终端"是**全局 UI 焦点**，谁点一下就变。结果就是命令被发到别人的会话上，
 * 或者 AI 看到"光标位置不对"就误以为会话变了、于是新开一条（很危险）。
 *
 * 这个模块**不认识 VS Code**（纯函数 + 一个 JSON 文件），所以能单独测；
 * 会话列表由调用方（aiBridge）传进来。契约见 docs/session-identity.md。
 */
import { readJsonFile, writeJsonFile } from './config'
import { log } from './log'

export const BINDINGS_FILE = 'mcp-bindings.json'

/** 一个客户端最多绑定几条会话（别名 A..H） */
const MAX_ALIASES = 32
/** 绑定多久没更新就丢掉 */
const TTL_MS = 12 * 60 * 60 * 1000

/** 解析会话时用到的最小信息（由 aiBridge 从 terminals 里整理出来） */
export interface SessionRef {
  id: string
  /** 完整终端名（含 `#N` 前缀，如果开了编号） */
  name: string
  no: number
  /** 给人看的简短状态：shell / menu / dead … */
  state: string
  /** 屏幕游标：每次有输出 +1（乐观并发校验用；老数据可能没有 → 当 0 处理） */
  cursor: number
}

/**
 * 乐观并发校验：写操作带着"我上次读到的 cursor"来，对不上就拒绝。
 * 返回 null = 放行；返回字符串 = 拒绝原因（直接给模型看）。
 */
export function expectCursorProblem(expected: number | undefined, actual: number): string | null {
  if (expected === undefined) return null
  if (!Number.isFinite(expected) || expected === actual) return null
  return (
    `会话在你上次读取之后被改动过（cursor ${expected} → ${actual}）：可能是用户在那个终端里敲了东西，` +
    `或者另一个 AI/客户端执行了命令。先 bastion_tail 看一眼确认，再用新的 cursor 重试；` +
    `如果你确定要不管它直接执行，就别传 expectCursor。`
  )
}

export interface Binding {
  sessionId: string
  name: string
  since: string
}

export interface ClientBindings {
  label: string
  updatedAt: string
  /** 别名（A/B/…）→ 会话 */
  sessions: Record<string, Binding>
}

export interface BindingsFile {
  version: number
  clients: Record<string, ClientBindings>
}

const BINDINGS_HEADER = [
  '// BastionShell 的 AI 会话绑定（自动生成，别手改）',
  '//',
  '// 用途：让每个 AI 客户端记住「我正在操作哪条会话」。会话 id 与别名都由服务端保存，',
  '// 所以模型自己的上下文被压缩/重开也不影响 —— 它问一次 listSessions 就能拿回自己的绑定。',
  '//',
  '// clients.<clientId>.sessions.<别名> = { sessionId, name, since }',
  '// clientId 来自请求头 X-BastionShell-Client（没带就是 default）。',
  '// 注意：这个头**不是鉴权**，只是区分用途；真正隔离请用每个客户端独立的 token。'
].join('\n')

function emptyFile(): BindingsFile {
  return { version: 1, clients: {} }
}

function isBinding(v: unknown): v is Binding {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.sessionId === 'string' && typeof o.name === 'string'
}

function isValidFile(v: unknown): v is BindingsFile {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (!o.clients || typeof o.clients !== 'object') return false
  for (const cb of Object.values(o.clients as Record<string, unknown>)) {
    if (!cb || typeof cb !== 'object') return false
    const c = cb as Record<string, unknown>
    if (!c.sessions || typeof c.sessions !== 'object') return false
    for (const b of Object.values(c.sessions as Record<string, unknown>)) if (!isBinding(b)) return false
  }
  return true
}

export function loadBindings(): BindingsFile {
  const f = readJsonFile<BindingsFile | undefined>(BINDINGS_FILE, undefined, (v): v is BindingsFile | undefined => v === undefined || isValidFile(v))
  return f ?? emptyFile()
}

/**
 * 加载并**就地清扫**：丢掉"会话已经没了"的绑定。
 *
 * 为什么必须在加载时做：压测里出现过"死会话的绑定长期占着别名 A"，
 * 新会话只能拿到 B/C；而且 health 与 listSessions 两处显示不一致。
 * 现在所有读绑定的地方都走这个入口，别名分配就不会被僵尸占住。
 */
export function loadBindingsSwept(): BindingsFile {
  const f = loadBindings()
  if (sweepDeadBindings(f, liveSessionIds())) saveBindings(f)
  return f
}

/** 当前还活着的会话 id（由宿主注入，避免这个模块 import vscode/state） */
let liveIdsResolver: () => string[] = () => []
export function setLiveSessionIds(fn: () => string[]): void {
  liveIdsResolver = fn
}
function liveSessionIds(): string[] {
  try {
    return liveIdsResolver()
  } catch {
    return []
  }
}

/** 清掉绑定里指向已不存在会话的项；返回是否有改动 */
export function sweepDeadBindings(f: BindingsFile, live: string[]): boolean {
  const alive = new Set(live)
  const born = alive.size === 0
  let changed = false
  for (const cid of Object.keys(f.clients ?? {})) {
    const cb = f.clients[cid]
    for (const [alias, b] of Object.entries(cb.sessions ?? {})) {
      // 没有任何活会话时不清（扩展刚启动、还没连上任何会话，属于正常状态）
      if (born) break
      if (!alive.has(b.sessionId)) {
        delete cb.sessions[alias]
        changed = true
      }
    }
  }
  return changed
}

// ---- 变更通知：状态栏 / 面板据此刷新（不依赖 vscode，所以用最小的监听数组）----
type BindingsListener = () => void
const bindingsListeners: BindingsListener[] = []

export function onBindingsChanged(cb: BindingsListener): { dispose(): void } {
  bindingsListeners.push(cb)
  return {
    dispose: () => {
      const i = bindingsListeners.indexOf(cb)
      if (i >= 0) bindingsListeners.splice(i, 1)
    }
  }
}

function notifyBindingsChanged(): void {
  for (const cb of bindingsListeners.slice()) {
    try {
      cb()
    } catch (e) {
      log(`绑定变更通知的处理函数抛错（忽略）: ${(e as Error).message}`)
    }
  }
}

export function saveBindings(f: BindingsFile): void {
  try {
    writeJsonFile(BINDINGS_FILE, f, BINDINGS_HEADER)
    notifyBindingsChanged()
  } catch (e) {
    // 绑定写不进去不该让工具调用整体失败：内存里的绑定这次仍然有效（下次启动重新来）
    log(`保存会话绑定失败: ${(e as Error).message}`)
  }
}

/**
 * 客户端标识归一化。
 *
 * 只保留安全字符；空/超长一律退回 `default` —— 这个值会进 JSON 的 key，
 * 不能让请求头里的任意字符串污染文件结构。
 */
export function normalizeClientId(raw?: string): string {
  // 小写化：标签是给人写的（My AI 和 my_ai 应该指同一个客户端），不区分大小写更省事
  const v = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 32)
  return v || 'default'
}

export function bindingsOf(f: BindingsFile, clientId: string): ClientBindings {
  const id = normalizeClientId(clientId)
  return f.clients[id] ?? { label: id === 'default' ? '未标识客户端' : id, updatedAt: '', sessions: {} }
}

/** 某个 sessionId 被哪些客户端绑着（listSessions 的 owners 用） */
export function ownerClients(f: BindingsFile, sessionId: string): string[] {
  const out: string[] = []
  for (const [clientId, cb] of Object.entries(f.clients)) {
    if (Object.values(cb.sessions).some((b) => b.sessionId === sessionId)) out.push(clientId)
  }
  return out
}

/** 该客户端给这条会话起的别名（没有就 undefined） */
export function aliasOfSession(cb: ClientBindings, sessionId: string): string | undefined {
  for (const [alias, b] of Object.entries(cb.sessions)) if (b.sessionId === sessionId) return alias
  return undefined
}

/** 别名（大小写不敏感）→ 绑定 */
export function bindingByAlias(cb: ClientBindings, alias: string): Binding | undefined {
  const want = alias.trim().toLowerCase()
  for (const [a, b] of Object.entries(cb.sessions)) if (a.toLowerCase() === want) return b
  return undefined
}

/** 下一个空闲别名 A..H；满了返回 undefined */
/**
 * 第 n 个默认别名的名字（0→A … 25→Z, 26→AA, 27→AB …）。
 *
 * 用 Excel 列那种进制：26 个单字母用完之后接着 AA/AB/…，所以上限 32 时
 * 名字是 A..Z + AA..AF —— 不再受"A 到 H 只有 8 个"的限制。
 */
export function aliasName(index: number): string {
  let n = Math.max(0, Math.floor(index))
  const chars: string[] = []
  for (;;) {
    chars.unshift(String.fromCharCode(65 + (n % 26)))
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return chars.join("")
}

export function nextAlias(cb: ClientBindings): string | undefined {
  const used = new Set(Object.keys(cb.sessions).map((a) => a.toUpperCase()))
  for (let i = 0; i < MAX_ALIASES; i++) {
    const a = aliasName(i)
    if (!used.has(a)) return a
  }
  return undefined
}

export interface BindResult {
  alias: string
  /** 同名会话已绑定过时返回旧别名（幂等，不重复占位） */
  existing: boolean
}

/**
 * 绑定一条会话。同名会话已经绑过就返回旧别名（幂等）——
 * AI 反复调 `use` 不该堆出一串指向同一条会话的别名。
 */
export function bindSession(f: BindingsFile, clientId: string, ref: SessionRef, as?: string): BindResult | { error: string } {
  const id = normalizeClientId(clientId)
  const now = new Date().toISOString()
  const cb = bindingsOf(f, id)
  const already = aliasOfSession(cb, ref.id)
  if (already) return { alias: already, existing: true }

  let alias = (as ?? '').trim()
  if (alias) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(alias)) return { error: `别名只能是 1~16 个字母/数字/_/-（收到「${alias}」）` }
    if (cb.sessions[alias] && cb.sessions[alias].sessionId !== ref.id) {
      return { error: `别名 ${alias} 已经指向 ${cb.sessions[alias].name}了；换一个别名，或先 bastion_use({session:"${ref.id}"}) 覆盖它` }
    }
  } else {
    const auto = nextAlias(cb)
    if (!auto) return { error: `一个客户端最多绑定 ${MAX_ALIASES} 条会话（A..H）。先解绑不用的（bastion_use({session:"…", unbind:true})）` }
    alias = auto
  }

  cb.sessions[alias] = { sessionId: ref.id, name: ref.name, since: now }
  cb.updatedAt = now
  f.clients[id] = cb
  return { alias, existing: false }
}

export function unbind(f: BindingsFile, clientId: string, target: { alias?: string; sessionId?: string }): boolean {
  const id = normalizeClientId(clientId)
  const cb = f.clients[id]
  if (!cb) return false
  let removed = false
  for (const [alias, b] of Object.entries(cb.sessions)) {
    const hit = (target.alias && alias.toLowerCase() === target.alias.trim().toLowerCase()) || (target.sessionId && b.sessionId === target.sessionId)
    if (hit) {
      delete cb.sessions[alias]
      removed = true
    }
  }
  if (removed) cb.updatedAt = new Date().toISOString()
  return removed
}

/**
 * 清掉「会话已经不存在」和「太久没动」的绑定。
 * 只在加载时调用；返回是否发生了改动。
 */
export function cleanupBindings(f: BindingsFile, liveIds: string[]): boolean {
  const live = new Set(liveIds)
  const now = Date.now()
  let changed = false
  for (const cb of Object.values(f.clients)) {
    for (const [alias, b] of Object.entries(cb.sessions)) {
      const stale = !live.has(b.sessionId) || (b.since ? now - Date.parse(b.since) > TTL_MS : false)
      if (stale) {
        delete cb.sessions[alias]
        changed = true
      }
    }
  }
  return changed
}

/** 给 bastion_health / 工具返回用的一段文字 */
export function describeBindings(f: BindingsFile, clientId: string): string {
  const cb = bindingsOf(f, clientId)
  const entries = Object.entries(cb.sessions)
  if (entries.length === 0) return '当前客户端还没有绑定任何会话（写入类工具需要先 bastion_use 绑定）。'
  return (
    `当前客户端（${normalizeClientId(clientId)}）绑定：` +
    entries.map(([a, b]) => `${a}=${b.sessionId}（${b.name}）`).join('、')
  )
}

// ───────────────────────── 解析「用哪条会话」 ─────────────────────────

export type ResolveVia = 'id' | 'name' | 'alias' | 'fragment' | 'binding' | 'fallback'

export type ResolveResult =
  | { ok: true; ref: SessionRef; via: ResolveVia }
  | { ok: false; message: string; isError: true }

const fmtRef = (r: SessionRef): string => `${r.id}（${r.name}）`

function listCandidates(list: SessionRef[]): string {
  return list.map((r) => `${fmtRef(r)}[${r.state}]`).join('、')
}

/**
 * 解析会话选择。**只有一条路能通，其余全部拒绝**（契约 §2/§3）。
 *
 * 优先级：id 精确 > 完整终端名精确 > 客户端别名 > 唯一片段
 * 没传选择时：唯一绑定 > （读操作才允许）回退 > 拒绝
 */
export function resolveSessionRef(
  list: SessionRef[],
  sel: string | undefined,
  opts: { mode: 'read' | 'write'; client?: ClientBindings; fallback?: SessionRef; allowWriteFallback?: boolean }
): ResolveResult {
  const want = (sel ?? '').trim()
  const cb = opts.client ?? { label: 'default', updatedAt: '', sessions: {} }

  if (!want) {
    const bound = Object.values(cb.sessions)
    if (bound.length === 1) {
      const ref = list.find((r) => r.id === bound[0].sessionId)
      if (ref) return { ok: true, ref, via: 'binding' }
      return {
        ok: false,
        isError: true,
        message:
          `绑定指向的会话 ${bound[0].sessionId}（${bound[0].name}）已经不在了（可能被关闭）。` +
          `先 bastion_listSessions 重新选一条，再 bastion_use。`
      }
    }
    if (bound.length > 1) {
      const parts = Object.entries(cb.sessions).map(([a, b]) => `${a}=${b.sessionId}（${b.name}）`).join('、')
      return {
        ok: false,
        isError: true,
        message:
          `你现在绑定了 ${bound.length} 条会话：${parts}。` +
          `请用 session 参数指定要操作哪一条 —— 这里不会替你猜。`
      }
    }
    // 只有"读"或者显式允许（VS Code 内的 Copilot 直连）才回退到活动终端。
    // MCP 的外部 AI 一律不回退 —— 那正是两个 AI 互相踩的根源。
    if ((opts.mode === 'read' || opts.allowWriteFallback === true) && opts.fallback) {
      return { ok: true, ref: opts.fallback, via: 'fallback' }
    }
    return {
      ok: false,
      isError: true,
      message:
        opts.mode === 'read'
          ? '现在没有任何会话。请让用户先在 BastionShell 里连接一台机器。'
          : '你还没有绑定任何会话（这是为了避免把命令发到别的 AI 或用户的会话上）。' +
            '先 bastion_listSessions，再 bastion_use({session: "s-xxxx"})。'
    }
  }

  const byId = list.find((r) => r.id.toLowerCase() === want.toLowerCase())
  if (byId) return { ok: true, ref: byId, via: 'id' }

  const byName = list.find((r) => r.name === want)
  if (byName) return { ok: true, ref: byName, via: 'name' }

  // 客户端自己起的别名（A/B…）：只在**这个客户端**的绑定里找
  const byAlias = bindingByAlias(cb, want)
  if (byAlias) {
    const ref = list.find((r) => r.id === byAlias.sessionId)
    if (ref) return { ok: true, ref, via: 'alias' }
    return {
      ok: false,
      isError: true,
      message: `别名 ${want} 指向的会话 ${byAlias.sessionId}（${byAlias.name}）已经不在了。先 bastion_listSessions 重新选一条。`
    }
  }

  // 片段：**只允许唯一命中**。以前的 includes 取首个就是"打到错机器"的根源。
  const low = want.toLowerCase()
  const frag = list.filter((r) => r.name.toLowerCase().includes(low))
  if (frag.length === 1) return { ok: true, ref: frag[0], via: 'fragment' }
  if (frag.length > 1) {
    return {
      ok: false,
      isError: true,
      message: `「${want}」匹配到 ${frag.length} 条会话：${listCandidates(frag)}。请用 session id 指定要操作哪一条。`
    }
  }
  return {
    ok: false,
    isError: true,
    message:
      list.length === 0
        ? `找不到会话「${want}」—— 现在**一条会话都没有**。请让用户先在 BastionShell 里连接一台机器，连上之后用 bastion_listSessions 看它的会话 id。`
        : `找不到会话「${want}」。当前有：${listCandidates(list)}。先用 bastion_listSessions 看一遍，再用 session id 指定。`
  }
}
