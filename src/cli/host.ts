/**
 * CLI 宿主的 MCP 适配层：把 `core/mcpTools` 要的 `McpSessionApi` 接在**无头会话**上。
 *
 * 原则（docs/cli-host.md）：
 *   - 语义在 `core/` 一份，这里只翻译成 EngineSession 调用；
 *   - 账本用**同一个** ActionRecord/JSONL（外部面板能直接读）；
 *   - 没做的能力明确回"未支持 + 为什么"，不假装成功。
 *
 * 多会话（hub-lite）：一个进程可以持有多条会话、共用一个 MCP 端点。
 * 工具里用 `session:` 指定（会话 id 或**档案名**都行）；没指定时：
 * 绑定过就用绑定的，只有一条就用那一条，多条且没绑定 → 明确要求指定。
 */

import * as fs from 'node:fs'
import type { Client } from 'ssh2'
import { appendActionRecord } from '../core/actionLedgerIo'
import { recordFromJob } from '../core/actionLedger'
import { summarizeCommand, normalizeWhy } from '../core/commandSummary'
import type { ExecJob } from '../core/execJobs'
import type { ExecResponse } from '../core/execResult'
import type { McpSessionApi } from '../core/mcpTools'
import { putFile, getFile, resolveRemoteDir } from '../core/sftpTransfer'
import { pushPath, pullPath, type TransferSession } from '../core/transferPath'
import { defaultDownloadDir, openSftp } from '../engine/sftp'
import type { EngineProfile } from '../engine/profiles'
import type { EngineSession } from '../engine/session'

export interface CliSessionEntry {
  /** 不可变会话 id（s-xxxx） */
  id: string
  profile: EngineProfile
  session: EngineSession
  /** 同一条已认证连接：push/pull 的 SFTP 要用它 */
  client?: Client
}

export interface CliHostOptions {
  sessions: CliSessionEntry[]
  /**
   * AI 要求新建连接时怎么开（astion_connect）。
   * 由宿主的 main 注入：它才知道密码表、指纹策略、日志。
   */
  connectSession?: (profileName: string) => Promise<CliSessionEntry>
  version: string
  log?: (msg: string) => void
  now?: () => number
}

type JobState = ExecJob['state']

interface CliJob {
  id: string
  sessionId: string
  command: string
  why?: string
  intentId?: string
  state: JobState
  text: string
  exitCode?: number
  startedAt: number
  completedAt?: number
}

const TERMINAL: JobState[] = ['completed', 'failed', 'cancelled']

export class CliHost {
  private seq = 0
  private readonly jobs = new Map<string, CliJob>()
  private readonly order: string[] = []
  /** clientId → 会话 id（bastion_use 绑定） */
  private readonly bound = new Map<string, string>()
  /** 每条会话最近一次命令的退出码（transferPath 的 ExecLike 要它） */
  private readonly lastRc = new Map<string, number>()
  private readonly subs = new Set<() => void>()
  private readonly now: () => number

  constructor(private readonly opts: CliHostOptions) {
    if (opts.sessions.length === 0) throw new Error('CliHost 至少要一条会话')
    this.now = opts.now ?? Date.now
  }

  private entry(byIdOrProfile: string): CliSessionEntry | undefined {
    const want = byIdOrProfile.trim().toLowerCase()
    if (!want) return undefined
    return (
      this.opts.sessions.find((s) => s.id.toLowerCase() === want) ??
      this.opts.sessions.find((s) => s.profile.name.toLowerCase() === want)
    )
  }

  /** 解析这次调用该落到哪条会话；解析不了就返回可读错误 */
  private resolve(input?: { session?: string; clientId?: string }): CliSessionEntry | { error: string } {
    if (input?.session) {
      const hit = this.entry(input.session)
      return hit ?? { error: `没有这条会话：${input.session}（可用：${this.opts.sessions.map((s) => `${s.id}=${s.profile.name}`).join('、')}）` }
    }
    if (input?.clientId) {
      const sid = this.bound.get(input.clientId)
      const hit = sid ? this.entry(sid) : undefined
      if (hit) return hit
    }
    if (this.opts.sessions.length === 1) return this.opts.sessions[0]
    return {
      error: `这个端点有 ${this.opts.sessions.length} 条会话，请用 session 指定（可用：${this.opts.sessions
        .map((s) => `${s.id}=${s.profile.name}`)
        .join('、')}）`
    }
  }

  private latest(): CliJob | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const j = this.jobs.get(this.order[i])
      if (j) return j
    }
    return undefined
  }

  /**
   * 把一次执行的记录写成 `ExecJob` 兼容的形状交给 `recordFromJob` ——
   * 这样账本字段（actionId/brief/steps/redacted/status/exitCode/elapsed）与扩展完全一致。
   */
  private toExecJob(j: CliJob): ExecJob {
    return {
      id: j.id,
      sessionId: j.sessionId,
      sessionNo: 1,
      command: j.command,
      startedAt: j.startedAt,
      state: j.state,
      exitCode: j.exitCode,
      buffer: Buffer.alloc(0),
      dropped: 0,
      lastLine: '',
      markerSeen: j.state !== 'failed' || j.exitCode !== undefined,
      cursorAtStart: 0,
      quietMs: 0,
      lastOutputAt: j.completedAt ?? j.startedAt,
      scanTail: '',
      waiters: new Set<() => void>(),
      why: j.why,
      intentId: j.intentId,
      summary: summarizeCommand(j.command),
      completedAt: j.completedAt
    }
  }

  /**
   * 把无头会话适配成 `core/transferPath` 要的传输会话。
   *
   * 与扩展 `aiBridge.transferSessionOf` 同构：rz/sz 不提供（CLI 没有 zmodem 通道），
   * 于是直连档案走 SFTP、堡垒机档案自动降级到 base64 —— 降级链是 core 的逻辑，不在这里。
   */
  private transferSession(e: CliSessionEntry): TransferSession {
    const self = this
    return {
      name: e.profile.name,
      exec: async (cmd) => (await e.session.exec(cmd, { maxMs: 5 * 60_000 })).text,
      exitCode: () => self.lastRc.get(e.id),
      sftpAllowed: () => e.profile.mode === 'direct' && !!e.client,
      sftpPut: async (localPath, remoteDir) => {
        if (!e.client) return { ok: false, message: '这条会话没有可用的 SFTP 连接' }
        const h = await openSftp(e.client)
        try {
          // 用 resolveRemoteDir 把目标目录解析成绝对路径（不能拿空串去 realpath，那是 /root 那个坑）
          const dir = await resolveRemoteDir(h.sftp, remoteDir)
          const r = await putFile(h.sftp, localPath, dir, {
            onProgress: (pr) => {
              if (pr.ratio < 1) self.opts.log?.(`[${e.profile.name}] SFTP 上传 ${Math.round(pr.ratio * 100)}%`)
            }
          })
          return r.ok
            ? { ok: true, remotePath: r.remotePath, message: 'ok', bytes: r.bytes, skipped: r.skipped, resumed: r.resumed }
            : { ok: false, message: r.error ?? '未知原因' }
        } catch (err) {
          return { ok: false, message: (err as Error).message }
        } finally {
          h.close()
        }
      },
      sftpGet: async (remotePath, localDir) => {
        if (!e.client) return { ok: false, message: '这条会话没有可用的 SFTP 连接' }
        // 落盘目录要先建好：否则 fastGet 会因为**本机**目录不存在报 ENOENT，
        // 而 core 的 humanError 会把它显示成「远端路径不存在」（挺误导的）
        fs.mkdirSync(localDir, { recursive: true })
        const h = await openSftp(e.client)
        try {
          const r = await getFile(h.sftp, remotePath, localDir, {})
          return r.ok
            ? { ok: true, localPath: r.localPath, message: 'ok', bytes: r.bytes, resumed: r.resumed }
            : { ok: false, message: r.error ?? '未知原因' }
        } catch (err) {
          return { ok: false, message: (err as Error).message }
        } finally {
          h.close()
        }
      },
      overwriteMode: () => {
        const v = (process.env.BASTIONSHELL_OVERWRITE ?? 'skip').toLowerCase()
        return v === 'overwrite' || v === 'rename' ? v : 'skip'
      },
      log: (m) => self.opts.log?.(`[${e.profile.name}] ${m}`)
    }
  }

  private toResponse(e: CliSessionEntry, j: CliJob): ExecResponse {
    const secs = Math.round(((j.completedAt ?? this.now()) - j.startedAt) / 1000)
    const head =
      `会话 ${j.sessionId}（${e.profile.name}）｜作业 ${j.id}｜${j.state}` +
      (j.exitCode === undefined ? '' : `｜退出码 ${j.exitCode}`) +
      `｜${secs}s`
    const summary = summarizeCommand(j.command)
    const why = j.why ? `\n为了：${j.why}｜${summary.brief}` : `\n${summary.brief}`
    return {
      text: `${head}${why}\n\n${j.text || '(无输出)'}`,
      structured: {
        jobId: j.id,
        sessionId: j.sessionId,
        status: j.state,
        exitCode: j.exitCode,
        why: j.why,
        intentId: j.intentId,
        steps: summary.steps,
        brief: summary.brief,
        redacted: summary.redacted
      }
    }
  }

  private async run(e: CliSessionEntry, command: string, input: { why?: string; intentId?: string; quietMs?: number }): Promise<ExecResponse> {
    const id = `j-${(++this.seq).toString(16).padStart(4, '0')}`
    const job: CliJob = {
      id,
      sessionId: e.id,
      command,
      why: input.why ? normalizeWhy(input.why) : undefined,
      intentId: input.intentId,
      state: 'working',
      text: '',
      startedAt: this.now()
    }
    this.jobs.set(id, job)
    this.order.push(id)

    try {
      const r = await e.session.exec(command, { quietMs: input.quietMs, maxMs: 15 * 60_000 })
      this.lastRc.set(e.id, r.exitCode ?? 0)
      job.text = r.text
      job.exitCode = r.exitCode
      job.state = r.markerSeen && (r.exitCode ?? 0) === 0 ? 'completed' : 'failed'
      job.completedAt = this.now()
    } catch (err) {
      job.text = `执行失败：${(err as Error).message}`
      job.state = 'failed'
      job.completedAt = this.now()
    }

    this.notify()
    try {
      await appendActionRecord(recordFromJob(this.toExecJob(job), this.now()))
    } catch (err) {
      this.opts.log?.(`写账本失败（不影响执行）：${(err as Error).message}`)
    }
    return this.toResponse(e, job)
  }

  /** 运行期新增一条会话（bastion_connect 用），返回会话 id */
  addSession(entry: CliSessionEntry): string {
    if (this.opts.sessions.some((s) => s.id === entry.id)) throw new Error(`会话 id 冲突：${entry.id}`)
    this.opts.sessions.push(entry)
    return entry.id
  }
  /** 账本里属于本进程会话的记录（面板用；sessionId 为空 = 全部） */
  async ledgerRecords(sessionId?: string, limit = 200): Promise<import('../core/actionLedger').ActionRecord[]> {
    const { loadActionRecords } = await import('../core/actionLedgerIo')
    const all = await loadActionRecords(Math.max(limit, 200))
    const ids = new Set(this.opts.sessions.map((s) => s.id))
    const own = all.filter((r) => ids.has(String(r.sessionId ?? '')))
    const picked = sessionId ? own.filter((r) => r.sessionId === sessionId) : own
    return picked.slice(-limit)
  }

  /** 正在跑的作业数（面板的"在跑 N"） */
  workingCount(): number {
    let n = 0
    for (const j of this.jobs.values()) if (j.state === 'working') n += 1
    return n
  }

  /** 面板点"取消"：给对应会话发 Ctrl-C（尽力而为） */
  cancelJob(jobId: string): void {
    const j = this.jobs.get(jobId)
    const target = j ? this.opts.sessions.find((s) => s.id === j.sessionId) : this.opts.sessions[0]
    target?.session.write('\u0003')
    if (j && !TERMINAL.includes(j.state)) {
      j.state = 'cancelled'
      j.completedAt = this.now()
    }
  }

  /** 作业状态变化订阅（SSE 用）；返回取消订阅 */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  private notify(): void {
    for (const cb of this.subs) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }

  api(): McpSessionApi {
    const self = this
    const sessions = this.opts.sessions
    return {
      async listSessions() {
        return [
          `会话（CLI 宿主，共 ${sessions.length} 条）：`,
          ...sessions.map(
            (s) =>
              `  ${s.id}（${s.profile.name}：${s.profile.username}@${s.profile.host}）[${s.session.isClosed ? '已关闭' : 'shell'}]`
          ),
          '说明：AI 可以用 bastion_connect 新建连接（密钥认证直接连；密码认证需要宿主提供密码）。多条会话时用 session 指定（id 或档案名都行）。'
        ].join('\n')
      },

      async health(input) {
        const j = self.latest()
        return [
          'BastionShell CLI 自检',
          `- 版本：${self.opts.version}`,
          `- 宿主：CLI（${sessions.length} 条会话，共用这一个 MCP 端点）`,
          ...sessions.map(
            (s) =>
              `- ${s.id}：${s.profile.name}（${s.profile.username}@${s.profile.host}:${s.profile.port}，${s.profile.mode}）` +
              `${s.session.isClosed ? '（已关闭）' : ''}`
          ),
          `- 客户端：${input?.clientId ?? '(未声明)'}｜绑定：${input?.clientId ? self.bound.get(input.clientId) ?? '(无)' : '(无)'}`,
          `- 最近作业：${j ? `${j.id} ${j.state}（${j.sessionId}）` : '(无)'}`,
          '',
          '能力：connect（AI 新建连接）已支持；habits（读写个人习惯）已支持。'
        ].join('\n')
      },

      async listProfiles() {
        const { loadProfiles } = await import('../engine/profiles')
        const list = loadProfiles()
        return [
          `连接档案（${list.length} 条，来自共享 profiles.jsonc）：`,
          ...list.map((p) => `- ${p.name}：${p.username}@${p.host}:${p.port}（${p.mode}）`),
          '',
          `本进程已连：${sessions.map((s) => `${s.id}=${s.profile.name}`).join('、')}（换档案请重开进程）`
        ].join('\n')
      },

      async use(input) {
        const clientId = input?.clientId ?? 'default'
        if (input?.unbind) {
          self.bound.delete(clientId)
          return '已解绑。'
        }
        if (!input?.session) return '需要 session（会话 id 或档案名）'
        const hit = self.entry(input.session)
        if (!hit) return `没有这条会话：${input.session}`
        self.bound.set(clientId, hit.id)
        return `已把客户端 ${clientId} 绑定到 ${hit.id}（${hit.profile.name}）。`
      },

      async exec(input) {
        if (!input?.command) return { text: '错误：需要 command', isError: true }
        const e = self.resolve(input)
        if ('error' in e) return { text: e.error, isError: true }
        if (input.mode === 'interactive') {
          e.session.write(input.command + '\r')
          return { text: `已发送（interactive，不等结果）：${input.command}（会话 ${e.id}）` }
        }
        return self.run(e, input.command, { why: input.why, intentId: input.intentId, quietMs: input.quietMs })
      },

      async job(input) {
        const id = (input as { jobId?: string })?.jobId
        const j = id ? self.jobs.get(id) : self.latest()
        if (!j) return { text: '没有作业记录。', isError: true }
        const e = self.opts.sessions.find((s) => s.id === j.sessionId)
        return e ? self.toResponse(e, j) : { text: `作业 ${j.id} 的会话已不在`, isError: true }
      },

      async wait(input) {
        const id = (input as { jobId?: string })?.jobId
        const j = id ? self.jobs.get(id) : self.latest()
        if (!j) return { text: '没有可等待的作业。', isError: true }
        const e = self.opts.sessions.find((s) => s.id === j.sessionId)
        return e ? self.toResponse(e, j) : { text: `作业 ${j.id} 的会话已不在`, isError: true }
      },

      async cancel(input) {
        const id = (input as { jobId?: string })?.jobId
        const j = id ? self.jobs.get(id) : self.latest()
        const target = j ? self.opts.sessions.find((s) => s.id === j.sessionId) : self.opts.sessions[0]
        target?.session.write('\u0003') // 尽力而为：让远端自己收场
        if (j && !TERMINAL.includes(j.state)) {
          j.state = 'cancelled'
          j.completedAt = self.now()
        }
        return { text: `已发送 Ctrl-C${j ? `（作业 ${j.id} → 会话 ${j.sessionId}）` : ''}。` }
      },

      async tail(input) {
        const e = self.resolve(input)
        if ('error' in e) return e.error
        const lines = Math.max(1, Math.min(200, input?.lines ?? 40))
        return [`会话 ${e.id}（${e.profile.name}）屏幕最后 ${lines} 行：`, e.session.tail(lines)].join('\n')
      },

      async resumeTask() {
        return { text: 'CLI 版没有需要人工接手的挂起作业（exec 是同步等待）。', isError: true }
      },

      async connect(input) {
        const name = (input?.profile ?? '').trim()
        // 返回类型：错误走 string，成功走 {text, structured}（McpSessionApi 的约定）
        if (!name) return '错误：bastion_connect 需要 profile（档案名）'
        if (!self.opts.connectSession) {
          return '这个宿主没有开启「AI 新建连接」的能力（connectSession 未注入）'
        }
        try {
          const entry = await self.opts.connectSession(name)
          self.addSession(entry)
          return {
            text:
              `已连接：${entry.profile.name}（${entry.profile.username}@${entry.profile.host}）` +
              `\n会话 id：${entry.id}（之后可用 session:"${entry.id}" 或 "${entry.profile.name}" 指定）`,
            structured: { sessionId: entry.id, profile: entry.profile.name, host: entry.profile.host }
          }
        } catch (e) {
          return `连接失败：${(e as Error).message}`
        }
      },

      async push(input) {
        const localPath = (input?.localPath ?? '').trim()
        if (!localPath) return '错误：需要 localPath（本机文件路径）'
        const e = self.resolve(input)
        if ('error' in e) return e.error
        const out = await pushPath({ localPath, remoteDir: input?.remoteDir, session: self.transferSession(e) })
        const tail = out.remotePath ? `\n远端：${out.remotePath}` : ''
        return `${out.ok ? '已上传' : '上传失败'}：${out.message}${tail}`
      },

      async pull(input) {
        const remotePath = (input?.remotePath ?? '').trim()
        if (!remotePath) return '错误：需要 remotePath（远端文件路径）'
        const e = self.resolve(input)
        if ('error' in e) return e.error
        const localDir = (input?.localDir ?? '').trim() || defaultDownloadDir()
        const out = await pullPath({ remotePath, localDir, session: self.transferSession(e) })
        const tail = out.localPath ? `\n本机：${out.localPath}` : ''
        return `${out.ok ? '已下载' : '下载失败'}：${out.message}${tail}`
      },

      async habits(input) {
        const { getHabits, habitsForAI, appendHabit, setPrivilege, isPrivilegeMode } = await import('../core/habits')
        const action = (input?.action ?? 'read').toLowerCase()
        const target = (input?.profile ?? '').trim() || sessions[0].profile.name
        if (action === 'read') {
          const h = getHabits()
          return [`档案「${target}」的个人习惯（只读展示）：`, habitsForAI(target)].join('\n')
        }
        if (action === 'remember') {
          const text = (input?.habit ?? '').trim()
          if (!text) return '错误：remember 需要 habit（要记的那句话）'
          const ok = appendHabit(target, text)
          return ok ? `已记下（${target}）：${text}` : '写入习惯文件失败（看 CLI 日志里的原因）'
        }
        if (action === 'setprivilege') {
          const mode = input?.privilege
          if (!isPrivilegeMode(mode)) return '错误：privilege 只能是 none / sudo / sudo-i / ask'
          const ok = setPrivilege(target, mode)
          return ok ? `已设置（${target}）提权习惯=${mode}` : '写入习惯文件失败（看 CLI 日志里的原因）'
        }
        return `未知 action：${action}（可用 read / remember / setPrivilege）`
      }
    }
  }
}
