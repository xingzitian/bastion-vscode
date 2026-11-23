/**
 * CLI 宿主的 MCP 适配层：把 `core/mcpTools` 要的 `McpSessionApi` 接在**无头会话**上。
 *
 * 原则（docs/cli-host.md）：
 *   - 语义在 `core/` 一份，这里只翻译成 EngineSession 调用；
 *   - 账本用**同一个** ActionRecord/JSONL（外部面板能直接读）；
 *   - 没做的能力明确回"未支持 + 为什么"，不假装成功。
 */

import * as fs from 'node:fs'
import { appendActionRecord } from '../core/actionLedgerIo'
import { recordFromJob } from '../core/actionLedger'
import { summarizeCommand, normalizeWhy } from '../core/commandSummary'
import type { ExecJob } from '../core/execJobs'
import type { ExecResponse } from '../core/execResult'
import type { McpSessionApi } from '../core/mcpTools'
import { pushPath, pullPath, type TransferSession } from '../core/transferPath'
import { putFile, getFile, resolveRemoteDir } from '../core/sftpTransfer'
import { defaultDownloadDir, openSftp } from '../engine/sftp'
import type { Client } from 'ssh2'
import type { EngineSession } from '../engine/session'
import { loadProfiles, type EngineProfile } from '../engine/profiles'

export interface CliHostOptions {
  profile: EngineProfile
  session: EngineSession
  /** 一进程一条会话，所以固定一个 id */
  sessionId: string
  /** 同一条已认证连接：push/pull 的 SFTP 要用它（不提供就只能走 base64） */
  client?: Client
  version: string
  log?: (msg: string) => void
  now?: () => number
}

type JobState = ExecJob['state']

interface CliJob {
  id: string
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
  private boundClient?: string
  /** 上一条命令的退出码（transferPath 的 ExecLike 要它） */
  private lastRc?: number
  private readonly now: () => number

  constructor(private readonly opts: CliHostOptions) {
    this.now = opts.now ?? Date.now
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
   * 这样账本字段（actionId/brief/steps/redacted/status/exitCode/elapsed）与扩展完全一致，
   * 外部面板不用区分是哪个宿主写的。
   */
  private toExecJob(j: CliJob): ExecJob {
    return {
      id: j.id,
      sessionId: this.opts.sessionId,
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
  private transferSession(): TransferSession {
    const self = this
    return {
      name: this.opts.profile.name,
      exec: async (cmd) => (await self.opts.session.exec(cmd, { maxMs: 5 * 60_000 })).text,
      exitCode: () => self.lastRc,
      sftpAllowed: () => self.opts.profile.mode === 'direct' && !!self.opts.client,
      sftpPut: async (localPath, remoteDir) => {
        if (!self.opts.client) return { ok: false, message: '这条会话没有可用的 SFTP 连接' }
        const h = await openSftp(self.opts.client)
        try {
          // 用 resolveRemoteDir 把目标目录解析成绝对路径（不能拿空串去 realpath，那是 /root 那个坑）
          const dir = await resolveRemoteDir(h.sftp, remoteDir)
          const r = await putFile(h.sftp, localPath, dir, {
            onProgress: (pr) => {
              if (pr.ratio < 1) self.opts.log?.(`SFTP 上传 ${Math.round(pr.ratio * 100)}%`)
            }
          })
          return r.ok
            ? { ok: true, remotePath: r.remotePath, message: 'ok', bytes: r.bytes, skipped: r.skipped, resumed: r.resumed }
            : { ok: false, message: r.error ?? '未知原因' }
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        } finally {
          h.close()
        }
      },
      sftpGet: async (remotePath, localDir) => {
        if (!self.opts.client) return { ok: false, message: '这条会话没有可用的 SFTP 连接' }
        // 落盘目录要先建好：否则 fastGet 会因为**本机**目录不存在报 ENOENT，
        // 而 core 的 humanError 会把它显示成「远端路径不存在」（挺误导的）
        fs.mkdirSync(localDir, { recursive: true })
        const h = await openSftp(self.opts.client)
        try {
          const r = await getFile(h.sftp, remotePath, localDir, {})
          return r.ok
            ? { ok: true, localPath: r.localPath, message: 'ok', bytes: r.bytes, resumed: r.resumed }
            : { ok: false, message: r.error ?? '未知原因' }
        } catch (e) {
          return { ok: false, message: (e as Error).message }
        } finally {
          h.close()
        }
      },
      overwriteMode: () => {
        const v = (process.env.BASTIONSHELL_OVERWRITE ?? 'skip').toLowerCase()
        return v === 'overwrite' || v === 'rename' ? v : 'skip'
      },
      log: (m) => self.opts.log?.(m)
    }
  }

  private toResponse(j: CliJob): ExecResponse {
    const secs = Math.round(((j.completedAt ?? this.now()) - j.startedAt) / 1000)
    const head =
      `会话 ${this.opts.sessionId}（${this.opts.profile.name}）｜作业 ${j.id}｜${j.state}` +
      (j.exitCode === undefined ? '' : `｜退出码 ${j.exitCode}`) +
      `｜${secs}s`
    const summary = summarizeCommand(j.command)
    const why = j.why ? `\n为了：${j.why}｜${summary.brief}` : `\n${summary.brief}`
    return {
      text: `${head}${why}\n\n${j.text || '(无输出)'}`,
      structured: {
        jobId: j.id,
        sessionId: this.opts.sessionId,
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

  private async run(command: string, input: { why?: string; intentId?: string; quietMs?: number }): Promise<ExecResponse> {
    const id = `j-${(++this.seq).toString(16).padStart(4, '0')}`
    const job: CliJob = {
      id,
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
      const r = await this.opts.session.exec(command, { quietMs: input.quietMs, maxMs: 15 * 60_000 })
      this.lastRc = r.exitCode
      job.text = r.text
      job.exitCode = r.exitCode
      job.state = r.markerSeen && (r.exitCode ?? 0) === 0 ? 'completed' : 'failed'
      job.completedAt = this.now()
    } catch (e) {
      job.text = `执行失败：${(e as Error).message}`
      job.state = 'failed'
      job.completedAt = this.now()
    }

    try {
      await appendActionRecord(recordFromJob(this.toExecJob(job), this.now()))
    } catch (e) {
      this.opts.log?.(`写账本失败（不影响执行）：${(e as Error).message}`)
    }
    return this.toResponse(job)
  }

  api(): McpSessionApi {
    // 对象字面量里的 this 指向返回的对象，不是 CliHost —— 先存一份
    const self = this
    const profile = self.opts.profile
    const sessionId = self.opts.sessionId
    return {
      async listSessions() {
        return [
          '会话（CLI 宿主，一进程一条）：',
          `  ${sessionId}（#1 ${profile.username}@${profile.host}）[shell]`,
          `档案：${profile.name}｜模式：${profile.mode}`,
          '说明：CLI **不能由 AI 新建连接**（连接由人在命令行发起）；换机器请新开一个 bastion 进程。'
        ].join('\n')
      },

      async health(input) {
        const j = self.latest()
        return [
          'BastionShell CLI 自检',
          `- 版本：${self.opts.version}`,
          '- 宿主：CLI（一进程一条会话）',
          `- 档案：${profile.name}（${profile.username}@${profile.host}:${profile.port}，${profile.mode}）`,
          `- 会话：${sessionId}（${self.opts.session.isClosed ? '已关闭' : '在 shell 里'}）`,
          `- 客户端：${input?.clientId ?? '(未声明)'}｜绑定：${self.boundClient ?? '(无)'}`,
          `- 最近作业：${j ? `${j.id} ${j.state}` : '(无)'}`,
          `- 屏幕状态：${self.opts.session.screenState()}`,
          '',
          '未实现（A2）：connect / push / pull / habits。需要这些请用 VS Code 扩展。'
        ].join('\n')
      },

      async listProfiles() {
        const list = loadProfiles()
        return [
          `连接档案（${list.length} 条，来自共享 profiles.jsonc）：`,
          ...list.map((p) => `- ${p.name}：${p.username}@${p.host}:${p.port}（${p.mode}）`),
          '',
          `CLI 当前使用的档案：${profile.name}（换档案请重开进程）`
        ].join('\n')
      },

      async use(input) {
        if (input?.unbind) {
          self.boundClient = undefined
          return '已解绑。'
        }
        self.boundClient = input?.clientId ?? 'default'
        return `已绑定客户端 ${self.boundClient} 到会话 ${sessionId}（CLI 一进程只有这一条）。`
      },

      async exec(input) {
        if (!input?.command) return { text: '错误：需要 command', isError: true }
        if (input.mode === 'interactive') {
          self.opts.session.write(input.command + '\r')
          return { text: `已发送（interactive，不等结果）：${input.command}` }
        }
        return self.run(input.command, { why: input.why, intentId: input.intentId, quietMs: input.quietMs })
      },

      async job(input) {
        const j = (input as { jobId?: string })?.jobId ? self.jobs.get((input as { jobId: string }).jobId) : self.latest()
        return j ? self.toResponse(j) : { text: '没有作业记录。', isError: true }
      },

      async wait(input) {
        const id = (input as { jobId?: string })?.jobId
        const j = id ? self.jobs.get(id) : self.latest()
        return j ? self.toResponse(j) : { text: '没有可等待的作业。', isError: true }
      },

      async cancel(input) {
        const id = (input as { jobId?: string })?.jobId
        const j = id ? self.jobs.get(id) : self.latest()
        self.opts.session.write('\u0003') // 尽力而为：让远端自己收场
        if (j && !TERMINAL.includes(j.state)) {
          j.state = 'cancelled'
          j.completedAt = self.now()
        }
        return { text: `已发送 Ctrl-C${j ? `（作业 ${j.id}）` : ''}。` }
      },

      async resumeTask() {
        return { text: 'CLI 版没有需要人工接手的挂起作业（exec 是同步等待）。', isError: true }
      },

      async tail(input) {
        const lines = Math.max(1, Math.min(200, input?.lines ?? 40))
        return [`会话 ${sessionId}（${profile.name}）屏幕最后 ${lines} 行：`, self.opts.session.tail(lines)].join('\n')
      },

      async connect() {
        return (
          'CLI 版不支持由 AI 新建连接（一进程一条会话）。' +
          '请让人在终端里运行：bastionshell connect <档案>。'
        )
      },

      async push(input) {
        const localPath = (input?.localPath ?? '').trim()
        if (!localPath) return '错误：需要 localPath（本机文件路径）'
        const out = await pushPath({
          localPath,
          remoteDir: input?.remoteDir,
          session: self.transferSession()
        })
        const tail = out.remotePath ? `\n远端：${out.remotePath}` : ''
        return `${out.ok ? '已上传' : '上传失败'}：${out.message}${tail}`
      },

      async pull(input) {
        const remotePath = (input?.remotePath ?? '').trim()
        if (!remotePath) return '错误：需要 remotePath（远端文件路径）'
        const localDir = (input?.localDir ?? '').trim() || defaultDownloadDir()
        const out = await pullPath({ remotePath, localDir, session: self.transferSession() })
        const tail = out.localPath ? `\n本机：${out.localPath}` : ''
        return `${out.ok ? '已下载' : '下载失败'}：${out.message}${tail}`
      },

      async habits() {
        return 'CLI 版暂不支持写个人习惯（会改共享文件，需要单独设计确认流程）。'
      }
    }
  }
}
