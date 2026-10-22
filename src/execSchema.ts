/**
 * exec 族工具的结构化返回 schema（`outputSchema`）。
 *
 * 声明了 `outputSchema` 之后，规范要求 `structuredContent` **必须**符合它 ——
 * 所以这里只声明"一定会出现"的字段，可选字段用 required 之外的属性表达。
 *
 * 与 `docs/exec-protocol.md` 的状态机对应。
 */
const STATUS_ENUM = ['working', 'input_required', 'completed', 'failed', 'cancelled']

/** exec / wait 共用的形状（exec 多 session 与 timedOut） */
const jobStateProps: Record<string, unknown> = {
  status: { type: 'string', enum: STATUS_ENUM },
  jobId: { type: 'string' },
  exitCode: { type: 'number' },
  elapsedMs: { type: 'number' },
  cursor: { type: 'number' },
  cursorMoved: { type: 'boolean' },
  lastLine: { type: 'string' },
  markerSeen: { type: 'boolean' },
  prompt: { type: 'string' },
  hint: { type: 'string' },
  reason: { type: 'string' },
  logPath: { type: 'string' },
  matched: { type: 'boolean' },
  matchedLine: { type: 'string' }
}

export const EXEC_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ...jobStateProps,
    session: { type: 'string' },
    timedOut: { type: 'boolean' }
  },
  required: ['status'],
  additionalProperties: true
}

export const WAIT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: jobStateProps,
  required: ['status'],
  additionalProperties: true
}

export const JOB_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    status: { type: 'string', enum: STATUS_ENUM },
    exitCode: { type: 'number' },
    markerSeen: { type: 'boolean' },
    reason: { type: 'string' },
    sinceOffset: { type: 'number' },
    nextOffset: { type: 'number' },
    truncated: { type: 'boolean' },
    totalBytes: { type: 'number' },
    logPath: { type: 'string' },
    chunk: { type: 'string' }
  },
  required: ['jobId', 'status'],
  additionalProperties: true
}

export const CANCEL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    status: { type: 'string', enum: STATUS_ENUM },
    reason: { type: 'string' }
  },
  required: ['status'],
  additionalProperties: true
}
