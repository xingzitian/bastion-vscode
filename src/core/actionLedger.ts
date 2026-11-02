/**
 * 行动账本（Action Ledger）：每个 AI 动作一条记录，落盘 JSONL，跨重载还在。
 *
 * 为什么单独一层：面板是"视图"，能不能画出东西取决于账本里有没有事实。
 * 这里只做三件事 —— 从作业生成记录、按 intent 分组、追加/裁剪文件。
 * **不 import vscode**（目录由调用方注入），这样分组与解析能直接单测。
 */

import type { ExecJob, ExecStatus } from './execJobs'

export interface ActionRecord {
  /** 格式版本：以后加字段靠它兼容 */
  v: 1
  actionId: string
  intentId?: string
  sessionNo: number
  sessionId: string
  /** AI 声明的一句目的；空串 = 未说明（面板要显式标出来，不能假装有） */
  why: string
  /** 一行摘要（4 步：cd · git pull · …） */
  brief: string
  steps: number
  /** 已脱敏的命令原文 */
  command: string
  /** 原文里是否有凭据参数被脱敏过 */
  redacted: boolean
  status: ExecStatus
  exitCode?: number
  reason?: string
  startedAt: number
  /** 进入终态的时间（没结束就没有） */
  endedAt?: number
  elapsedMs?: number
}

export const TERMINAL: ExecStatus[] = ['completed', 'failed', 'cancelled']

export function isTerminal(s: ExecStatus): boolean {
  return TERMINAL.includes(s)
}

/** 从作业生成一条记录（command 用摘要里的脱敏版，绝不落明文凭据） */
export function recordFromJob(job: ExecJob, now = Date.now()): ActionRecord {
  const ended = isTerminal(job.state)
  return {
    v: 1,
    actionId: job.id,
    intentId: job.intentId,
    sessionNo: job.sessionNo,
    sessionId: job.sessionId,
    why: job.why ?? '',
    brief: job.summary.brief,
    steps: job.summary.steps,
    command: job.summary.raw, // 已脱敏
    redacted: job.summary.redacted,
    status: job.state,
    exitCode: job.exitCode,
    reason: job.reason,
    startedAt: job.startedAt,
    endedAt: ended ? (job.completedAt ?? now) : undefined,
    elapsedMs: ended ? (job.completedAt ?? now) - job.startedAt : undefined
  }
}

export function toJsonl(r: ActionRecord): string {
  return JSON.stringify(r)
}

/** 解析 JSONL；同一 actionId 以**最后一条**为准（记录会从 working 更新到 completed） */
export function parseLedger(text: string): ActionRecord[] {
  const byId = new Map<string, ActionRecord>()
  for (const line of (text ?? '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as ActionRecord
      if (!r || typeof r.actionId !== 'string' || r.v !== 1) continue
      byId.set(r.actionId, r) // 后来的覆盖先前的，且保持插入顺序（Map 保序）
    } catch {
      // 坏行跳过：账本不能因为一行损坏就整体读不出来
    }
  }
  return [...byId.values()]
}

/** 按 actionId 插入或替换（内存里合并实时与历史用） */
export function upsertRecord(list: ActionRecord[], rec: ActionRecord): ActionRecord[] {
  const out = list.filter((r) => r.actionId !== rec.actionId)
  out.push(rec)
  return out
}

/** 裁剪：只留最近 max 条（老的丢掉，避免账本无限长） */
export function pruneRecords(list: ActionRecord[], max = 500): ActionRecord[] {
  if (list.length <= max) return list
  return list.slice(list.length - max)
}

export interface IntentGroup {
  key: string
  intentId?: string
  /** 分组标题：优先用 AI 写的 why；没写就是"未说明" */
  why: string
  sessionNo: number
  /** 聚合状态：有在跑的就算 working；否则有等输入就是 input_required；否则有失败就是 failed */
  status: ExecStatus
  actions: ActionRecord[]
  steps: number
  failed: number
  startedAt: number
  endedAt?: number
  /** true = 这条记录没带 intentId，是按"同会话 + 时间相邻"归并出来的（面板要说明，不能冒充 AI 的分组） */
  synthetic: boolean
}

/** 没带 intentId 的动作，相隔多久以内算一组（60s：一次任务里的连续命令通常在这个尺度内） */
export const SYNTHETIC_GAP_MS = 60_000

function aggregateStatus(actions: ActionRecord[]): ExecStatus {
  if (actions.some((a) => a.status === 'working')) return 'working'
  if (actions.some((a) => a.status === 'input_required')) return 'input_required'
  if (actions.some((a) => a.status === 'failed')) return 'failed'
  if (actions.every((a) => a.status === 'cancelled')) return 'cancelled'
  return 'completed'
}

/**
 * 按 Intent 分组。
 *
 * - 有 `intentId` 的按它分（AI/客户端显式声明的意图，最可信）
 * - 没有的按「同会话 + 与上一条相隔 < 60s」**连续**归并，并标 `synthetic` ——
 *   面板上必须写明"这是按时间归并的"，否则就是把猜测当事实
 */
export function groupByIntent(records: ActionRecord[]): IntentGroup[] {
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt)
  const named = new Map<string, IntentGroup>()
  const unnamed: IntentGroup[] = []
  let last: IntentGroup | undefined

  for (const r of sorted) {
    if (r.intentId) {
      const key = `i:${r.intentId}`
      let g = named.get(key)
      if (!g) {
        g = {
          key,
          intentId: r.intentId,
          why: r.why,
          sessionNo: r.sessionNo,
          status: r.status,
          actions: [],
          steps: 0,
          failed: 0,
          startedAt: r.startedAt,
          synthetic: false
        }
        named.set(key, g)
      }
      g.actions.push(r)
      g.steps += r.steps
      if (r.status === 'failed') g.failed++
      if (!g.why && r.why) g.why = r.why
      if (r.endedAt) g.endedAt = Math.max(g.endedAt ?? 0, r.endedAt)
      last = undefined
      continue
    }

    const canJoin =
      last && last.sessionNo === r.sessionNo && r.startedAt - (last.endedAt ?? last.startedAt) < SYNTHETIC_GAP_MS
    if (canJoin && last) {
      last.actions.push(r)
      last.steps += r.steps
      if (r.status === 'failed') last.failed++
      if (r.endedAt) last.endedAt = Math.max(last.endedAt ?? 0, r.endedAt)
      continue
    }

    const g: IntentGroup = {
      key: `t:${r.sessionNo}:${r.startedAt}`,
      why: r.why,
      sessionNo: r.sessionNo,
      status: r.status,
      actions: [r],
      steps: r.steps,
      failed: r.status === 'failed' ? 1 : 0,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      synthetic: true
    }
    unnamed.push(g)
    last = g
  }

  const groups = [...named.values(), ...unnamed]
  for (const g of groups) g.status = aggregateStatus(g.actions)
  // 最近的在上面
  return groups.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
}

/** 一句话描述分组（面板表头 / 日志都能用） */
export function describeGroup(g: IntentGroup): string {
  const bits: string[] = []
  bits.push(g.why || '（AI 未说明目的）')
  bits.push(`${g.actions.length} 条命令 / ${g.steps} 步`)
  if (g.failed > 0) bits.push(`${g.failed} 条失败`)
  if (g.synthetic) bits.push('按时间归并')
  return bits.join('｜')
}
