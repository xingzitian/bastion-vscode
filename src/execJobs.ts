/**
 * 执行作业（exec job）—— 状态机 + 滚动日志 + 偏移切片 + 模式等待。
 *
 * 契约见 `docs/exec-protocol.md`；状态词直接对齐 MCP 官方 Tasks 扩展：
 * `working / input_required / completed / failed / cancelled`。
 *
 * 这个模块**不 import vscode**：状态机是纯逻辑，单测能直接打桩。
 * 之所以要"作业"这一层，是因为旧协议只有"等结束标记 + 有没有看到"这一个布尔，
 * 三种完全不同的情况（还在跑 / 卡在提示 / 早跑完了标记被吃）返回同一句话，
 * AI 只能靠猜 —— 猜错的代价是重复执行命令。
 */

export type ExecStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

import { normalizeWhy, summarizeCommand, type CommandSummary } from './commandSummary'

/** 作业日志的滚动上限（超出丢最老的字节；绝对偏移不受影响） */
export const JOB_BUFFER_MAX = 8 * 1024 * 1024

/** 单轮 wait 的上限：低于 MCP 客户端的单次调用预算（本机 DSH 默认 60s） */
export const WAIT_BUDGET_MS = 55_000

export interface ExecJob {
  id: string
  sessionId: string
  sessionNo: number
  command: string
  startedAt: number
  state: ExecStatus
  exitCode?: number
  /** 滚动捕获（UTF-8 字节） */
  buffer: Buffer
  /** 已经被丢掉的最老字节数（绝对偏移 = dropped + buffer 内下标） */
  dropped: number
  lastLine: string
  /** 是否真的看到了哨兵（false = 靠"输出静止"判完成，可能还差一点） */
  markerSeen: boolean
  cursorAtStart: number
  /** 交互提示原文（input_required 时） */
  prompt?: string
  hint?: string
  /** 远端 tee 的日志路径（有则给 AI 事后 cat） */
  logPath?: string
  /** failed 的原因：session_lost / session_exited / exit_nonzero / force_superseded */
  reason?: string
  /** 哨兵（`<marker>:<rc>` 出现在输出里就算完成）——作业**自己**持有它，不依赖 exec 的等待窗口 */
  marker?: string
  /** 输出静止多久算"没输出了"（兜底完成判定；必须配合"提示符已回"） */
  quietMs: number
  /** 最后一次收到输出的时间（静默兜底的依据） */
  lastOutputAt: number
  /** 扫描标记时保留的重叠尾巴（防止标记被切在两块之间） */
  scanTail: string
  /** 等待者（waitJob 注册；状态或输出变化时唤醒） */
  waiters: Set<() => void>
  /** AI 声明的一句目的（≤60 字，已归一化；空 = 它没写） */
  why?: string
  /** 一串命令共用的 intentId（面板按它分组） */
  intentId?: string
  /** 命令摘要：步骤数 / 一行 brief / 脱敏原文 / 高危片段 */
  summary: CommandSummary
  /** 进入终态的时刻（elapsedMs 用它，避免再查一次就变成 41s） */
  completedAt?: number
}

export interface JobView {
  jobId: string
  status: ExecStatus
  exitCode?: number
  elapsedMs: number
  cursor: number
  cursorMoved: boolean
  lastLine: string
  markerSeen: boolean
  logPath?: string
  prompt?: string
  hint?: string
  reason?: string
  /** AI 说这条命令为了什么（空 = 它没写，面板显示"未说明"） */
  why?: string
  /** 同一串命令共用的 intent id（面板按它分组） */
  intentId?: string
  /** 摘要里的步骤数 */
  steps?: number
  /** 一行摘要（`4 步：cd · git pull · npm ci · systemctl restart`） */
  brief?: string
  /** 原文是否被脱敏过（有凭据参数时为 true） */
  redacted?: boolean
}

const jobs = new Map<string, ExecJob>()
/** 每条会话"当前正在跑"的作业（同一时刻只允许一个，避免命令互相插队） */
const activeBySession = new Map<string, string>()
let seq = 0

/** waitMs 的默认值与预算夹紧（纯函数，便于测试；避免用例真的等 55 秒） */

export function clampWaitMs(ms?: number, def = 15_000): number {
  const v = ms === undefined ? def : ms
  if (!Number.isFinite(v)) return def
  return Math.max(0, Math.min(Math.floor(v), WAIT_BUDGET_MS))
}

export function newJobId(): string {
  seq += 1
  return `j-${seq.toString(16).padStart(4, '0')}`
}

export function createJob(input: {
  sessionId: string
  sessionNo: number
  command: string
  cursorAtStart: number
  logPath?: string
  /** 哨兵：作业自己拿着它扫输出，这样 exec 超时返回后仍然能判完成 */
  marker?: string
  /** 静默兜底窗口（默认 15s） */
  quietMs?: number
  /** AI 声明的一句目的（可选；服务端截断到 60 字） */
  why?: string
  /** 一串命令共用的 intent id（面板据此分组） */
  intentId?: string
  now?: number
}): ExecJob {
  const now = input.now ?? Date.now()
  const job: ExecJob = {
    id: newJobId(),
    sessionId: input.sessionId,
    sessionNo: input.sessionNo,
    command: input.command,
    startedAt: now,
    state: 'working',
    why: normalizeWhy(input.why),
    intentId: input.intentId,
    summary: summarizeCommand(input.command),
    buffer: Buffer.alloc(0),
    dropped: 0,
    lastLine: '',
    markerSeen: false,
    cursorAtStart: input.cursorAtStart,
    logPath: input.logPath,
    marker: input.marker,
    quietMs: input.quietMs ?? 15_000,
    lastOutputAt: now,
    scanTail: '',
    waiters: new Set()
  }
  jobs.set(job.id, job)
  activeBySession.set(job.sessionId, job.id)
  return job
}

export function getJob(id: string): ExecJob | undefined {
  return jobs.get(id)
}

/** 某条会话上还在跑的作业（没有就 undefined） */
export function activeJobOf(sessionId: string): ExecJob | undefined {
  const id = activeBySession.get(sessionId)
  return id ? jobs.get(id) : undefined
}

export function allJobs(): ExecJob[] {
  return [...jobs.values()]
}

function wake(job: ExecJob): void {
  for (const fn of [...job.waiters]) fn()
}

function clearActive(job: ExecJob): void {
  if (activeBySession.get(job.sessionId) === job.id) activeBySession.delete(job.sessionId)
}

/** 追加一块输出（终端数据流每来一块就调它） */
export function appendJobOutput(job: ExecJob, chunk: Buffer | string): void {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
  if (buf.length === 0) return
  job.buffer = Buffer.concat([job.buffer, buf])
  if (job.buffer.length > JOB_BUFFER_MAX) {
    const drop = job.buffer.length - JOB_BUFFER_MAX
    job.buffer = job.buffer.subarray(drop)
    job.dropped += drop
  }
  const text = buf.toString('utf8')
  job.lastOutputAt = Date.now()
  const tail = job.buffer.subarray(Math.max(0, job.buffer.length - 4096)).toString('utf8')
  const lines = tail.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length > 0) job.lastLine = lines[lines.length - 1].slice(0, 300)

  // ★ 完成判定归作业自己：exec 超时返回后，标记仍然能被这里解析出来。
  //   （上一版把完成判定绑在 exec 的等待窗口里，超时一返回就没人再看标记了 → 作业永远 working）
  const hit = scanMarkerTick(job, text)
  // ⚠️ 退出码 0 是 falsy —— 必须用 !== undefined（否则"成功"会被当成"没命中"，永远 working）
  if (hit !== undefined) {
    completeJob(job, { exitCode: hit, markerSeen: true })
    return
  }
  wake(job)
}

/**
 * 在"上一块的尾巴 + 这一块"里找哨兵，返回退出码。
 *
 * 为什么要拼尾巴：标记可能被切在两次数据块之间。
 * 为什么不担心匹配到命令回显：回显里是字面量 `: $ec`（没有数字），正则要求 `:<数字>` 才算。
 */
function scanMarkerTick(job: ExecJob, chunkText: string): number | undefined {
  if (!job.marker || (job.state !== 'working' && job.state !== 'input_required')) return undefined
  const hay = job.scanTail + chunkText
  const esc = job.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${esc}:(\\d+)`).exec(hay)
  job.scanTail = hay.slice(-(job.marker.length + 64))
  if (!m) return undefined
  const rc = Number.parseInt(m[1], 10)
  return Number.isFinite(rc) ? rc : undefined
}

/** 输出已经静止够久了吗（静默兜底的**前提**是"提示符已回"，不能只看时间） */
export function quietExpired(job: ExecJob, now = Date.now()): boolean {
  if (job.state !== 'working') return false
  return now - job.lastOutputAt >= job.quietMs
}

/**
 * 静默兜底完成：没看到哨兵，但提示符已经回来了，说明命令确实跑完了。
 *
 * 调用方必须自己判断"提示符已回"（那需要终端/屏幕状态，不在这个纯逻辑模块里）。
 */
export function completeByQuiet(job: ExecJob, exitCode?: number): void {
  completeJob(job, { exitCode, markerSeen: false })
}


/** 结束（正常/非 0） */
export function completeJob(job: ExecJob, input: { exitCode?: number; markerSeen?: boolean }): void {
  if (job.state !== 'working' && job.state !== 'input_required') return
  job.exitCode = input.exitCode
  job.markerSeen = input.markerSeen === true
  const ok = input.exitCode === undefined ? true : input.exitCode === 0
  job.state = ok ? 'completed' : 'failed'
  job.completedAt = Date.now()
  if (!ok) job.reason = 'exit_nonzero'
  clearActive(job)
  emitJobEvent(job)
  wake(job)
}

/** 卡在交互提示上（等人） */
export function markInputRequired(job: ExecJob, prompt: string, hint: string): void {
  if (job.state !== 'working') return
  job.state = 'input_required'
  job.prompt = prompt
  job.hint = hint
  emitJobEvent(job)
  wake(job)
}

/** 人能输入之后，命令继续跑 → 回到 working */
export function resumeJob(job: ExecJob): void {
  if (job.state !== 'input_required') return
  job.state = 'working'
  job.prompt = undefined
  job.hint = undefined
  wake(job)
}

/** 取消（协作式） */
export function cancelJob(job: ExecJob): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') return
  job.state = 'cancelled'
  job.completedAt = Date.now()
  job.reason = 'cancelled'
  clearActive(job)
  emitJobEvent(job)
  wake(job)
}

/** 会话丢了（会话被关掉/断线）—— 必须和"参数指认不到"区分开 */
export function failJob(job: ExecJob, reason: 'session_lost' | 'session_exited' | 'force_superseded' | 'exec_error', note?: string): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') return
  job.state = 'failed'
  job.completedAt = Date.now()
  job.reason = reason
  if (note) job.lastLine = note
  clearActive(job)
  emitJobEvent(job)
  wake(job)
}

/** 绝对结束偏移（下一次 sinceOffset 用这个） */
export function endOffset(job: ExecJob): number {
  return job.dropped + job.buffer.length
}

/** 按绝对偏移切片（可能按字节截断；返回 nextOffset 不丢数据） */
export function sliceJob(
  job: ExecJob,
  sinceOffset: number,
  maxBytes = 64 * 1024
): { chunk: string; nextOffset: number; truncated: boolean } {
  const absStart = Math.max(0, Math.floor(sinceOffset))
  const start = Math.max(0, absStart - job.dropped)
  if (start >= job.buffer.length) return { chunk: '', nextOffset: endOffset(job), truncated: false }
  const end = Math.min(job.buffer.length, start + Math.max(1, maxBytes))
  return {
    chunk: job.buffer.subarray(start, end).toString('utf8'),
    nextOffset: job.dropped + end,
    truncated: job.dropped + end < endOffset(job)
  }
}

/** 整个作业的文本（导出/复盘用；太大时只给尾部） */
export function jobText(job: ExecJob, maxBytes = 16 * 1024): string {
  if (job.buffer.length <= maxBytes) return job.buffer.toString('utf8')
  return `…（前面省略 ${(job.buffer.length - maxBytes).toLocaleString()} 字节）\n` +
    job.buffer.subarray(job.buffer.length - maxBytes).toString('utf8')
}

export function viewOf(job: ExecJob, now = Date.now(), cursorNow?: number): JobView {
  const cursor = cursorNow ?? job.cursorAtStart
  return {
    jobId: job.id,
    status: job.state,
    exitCode: job.exitCode,
    elapsedMs: (job.completedAt ?? now) - job.startedAt,
    cursor,
    // 还在跑但屏幕游标没动 = 真没动静（可能是命令卡住/等输入），这是很便宜的活性判据
    cursorMoved: cursorNow === undefined ? false : cursorNow > job.cursorAtStart,
    lastLine: job.lastLine,
    markerSeen: job.markerSeen,
    logPath: job.logPath,
    prompt: job.prompt,
    hint: job.hint,
    reason: job.reason,
    // 叙事：面板/账本靠这三个字段说清「这条命令在干什么」
    why: job.why,
    intentId: job.intentId,
    steps: job.summary.steps,
    brief: job.summary.brief,
    redacted: job.summary.redacted
  }
}

/** 交互提示的识别（它是"input_required"，不是"还在跑"） */
const PROMPTS: Array<{ re: RegExp; hint: string }> = [
  { re: /\[sudo\]\s*password\s*for\s+\S+\s*:/i, hint: 'sudo 在等密码 —— 让用户在终端里输入，或改用免密 sudo' },
  { re: /(^|\n)\s*(password|passwd|密码)\s*(for\s+\S+)?\s*[:：]\s*$/im, hint: '在等密码 —— 让用户在终端里输入（不要把密码交给 AI）' },
  { re: /(verification code|动态码|验证码|otp)\s*[:：]/i, hint: '在等动态码 —— 让用户在终端里输入' },
  // 允许尾部有冒号/问号/空格（真机上常见 `Continue? (y/n): `，之前因为要求行尾而漏判）
  { re: /(\(yes\/no\)|\[y\/n\]|\(y\/n\))\s*[:：?]*\s*$/im, hint: '在等确认（y/n）—— 让用户决定' },
  { re: /(enter passphrase|passphrase for key)/i, hint: '在等口令（passphrase）—— 让用户输入' },
  { re: /(请选择|请选择目标机|请选择账号|输入编号|资产\s*ID|菜单)/, hint: '停在堡垒机菜单/选择项上 —— 让用户在终端里走完这一步' },
  { re: /(press any key|任意键继续)/i, hint: '在等按键 —— 让用户在终端里按一下' }
]

/** 用户自定义规则（设置项 bastion.inputPromptRules）：先于内置规则匹配，坏正则会被跳过 */
let extraRules: Array<{ re: RegExp; hint: string }> = []

export function configurePromptRules(rules: Array<{ pattern?: string; hint?: string }> | undefined): void {
  const next: Array<{ re: RegExp; hint: string }> = []
  for (const r of rules ?? []) {
    const p = (r?.pattern ?? '').trim()
    if (!p) continue
    try {
      next.push({ re: new RegExp(p, 'i'), hint: r?.hint?.trim() || '自定义提示 —— 需要人工输入' })
    } catch {
      // 坏正则不注册（别让一条配错把整组规则带坏）
    }
  }
  extraRules = next
}

export function customPromptRuleCount(): number {
  return extraRules.length
}

export function detectPrompt(text: string): { prompt: string; hint: string } | undefined {
  const tail = text.slice(-2000)
  // 自定义规则优先（用户加的那条就是要立刻生效）
  for (const p of [...extraRules, ...PROMPTS]) {
    const m = p.re.exec(tail)
    if (m) {
      const line = m[0].trim().slice(0, 200)
      return { prompt: line, hint: p.hint }
    }
  }
  return undefined
}

/**
 * 等作业：状态变终态 / pattern 命中 / 超时，任一条件即返回。
 *
 * 这是"不要用 sleep 硬等"的正解 —— 等待发生在服务端，不消耗 AI 的轮次。
 * `pattern` 是正则，默认只匹配**本次调用以来新增**的输出（sinceOffset 之后）。
 */
export function waitJob(
  job: ExecJob,
  opts: { pattern?: string; waitMs?: number; sinceOffset?: number } = {}
): Promise<JobView & { matched: boolean; matchedLine?: string }> {
  const waitMs = clampWaitMs(opts.waitMs, 20_000)
  const re = opts.pattern ? safeRegex(opts.pattern) : undefined
  const from = opts.sinceOffset ?? endOffset(job)

  const snapshot = (): JobView & { matched: boolean; matchedLine?: string } => {
    const v = viewOf(job)
    if (!re) return { ...v, matched: false }
    const { chunk } = sliceJob(job, Math.min(from, endOffset(job)), 512 * 1024)
    const m = re.exec(chunk)
    return { ...v, matched: !!m, matchedLine: m ? m[0].slice(0, 300) : undefined }
  }

  const terminal = (): boolean =>
    job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled'

  const matched = (): boolean => {
    if (!re) return false
    const { chunk } = sliceJob(job, Math.min(from, endOffset(job)), 512 * 1024)
    return re.test(chunk)
  }

  if (terminal() || matched()) return Promise.resolve(snapshot())

  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      job.waiters.delete(check)
      resolve(snapshot())
    }
    const check = (): void => {
      if (terminal() || matched()) finish()
    }
    const timer = setTimeout(finish, waitMs)
    job.waiters.add(check)
  })
}

function safeRegex(p: string): RegExp | undefined {
  try {
    return new RegExp(p)
  } catch {
    return undefined
  }
}

/** 测试用：清空注册表 */
export function resetJobs(): void {
  jobs.clear()
  activeBySession.clear()
  seq = 0
}

// ── 作业事件（subscriptions/listen 的 notifications/tasks 数据源）──

export type JobEventListener = (event: {
  jobId: string
  status: ExecStatus
  exitCode?: number
  reason?: string
  /** 会话号（面板按它分组/定位） */
  sessionNo?: number
  intentId?: string
  /** AI 说这条命令为了什么（空 = 没写） */
  why?: string
  /** 一行命令摘要 */
  brief?: string
  steps?: number
  /** 原文是否被脱敏过 */
  redacted?: boolean
  elapsedMs?: number
}) => void
const jobListeners = new Set<JobEventListener>()

/** 订阅作业状态变化（返回取消订阅函数） */
export function onJobEvent(cb: JobEventListener): () => void {
  jobListeners.add(cb)
  return () => jobListeners.delete(cb)
}

/** 广播一次作业状态（由状态机在变化时调用） */
export function emitJobEvent(job: ExecJob): void {
  if (jobListeners.size === 0) return
  const payload = {
    jobId: job.id,
    status: job.state,
    exitCode: job.exitCode,
    reason: job.reason,
    // 账本/面板要的叙事字段（订阅者按需取用）
    sessionNo: job.sessionNo,
    intentId: job.intentId,
    why: job.why,
    brief: job.summary.brief,
    steps: job.summary.steps,
    redacted: job.summary.redacted,
    elapsedMs: (job.completedAt ?? Date.now()) - job.startedAt
  }
  for (const cb of [...jobListeners]) {
    try {
      cb(payload)
    } catch {
      // 订阅者出错不能影响状态机
    }
  }
}
/** 内置的交互提示规则条数（health 里向 AI 说明"能认多少种"） */
export function promptRuleCount(): number {
  return PROMPTS.length
}