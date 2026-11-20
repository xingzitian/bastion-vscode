/**
 * SFTP 传输（纯逻辑，不依赖 vscode / ssh2 具体版本）。
 *
 * 为什么要有它：`rz`/`base64` 是"堡垒机后面只有一条交互式 shell"逼出来的两条路 ——
 * 要占 pty、要看对端装没装 lrzsz、还会被键盘输入打断。
 * 而**直连**档案的 SSH 连接本身就是那台机器，ssh2 直接能开 sftp 子系统：
 * 复用同一条已认证连接（不再输 MFA）、零配置、不占终端、还能断点续传。
 *
 * 分工：
 *   mode = direct  → 优先 sftp，失败回退 rz → base64
 *   mode = bastion → 保持 rz → base64（堡垒机上 sftp 大概率落在堡垒机自己身上，见 transferPath 的注释）
 *
 * 这个模块只做"把字节搬过去并校验"，宿主的 ssh2 适配、进度展示、锁键盘在外面。
 */

import * as fs from 'fs'
import * as path from 'path'

/** ssh2 的 SFTPWrapper 够用的一小部分（包成 Promise，便于测试与替换） */
export interface SftpLike {
  stat(remotePath: string): Promise<{ size: number; mtime?: number; mode?: number; isDirectory?: () => boolean }>
  createReadStream(remotePath: string, opts?: { start?: number }): NodeJS.ReadableStream
  createWriteStream(
    remotePath: string,
    opts?: { flags?: string; start?: number; mode?: number }
  ): NodeJS.WritableStream
  mkdir(remotePath: string): Promise<void>
  realpath(remotePath: string): Promise<string>
  unlink(remotePath: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /**
   * ssh2 自带的多并发上传/下载（默认 64 并发、32KB 块）——
   * 这是 `ssh2-sftp-client` / vscode-sftp 这些成熟项目走的路，比手写 pipe 快且稳。
   * 没有提供时自动退回流实现（测试里的假 sftp 就是这种情况）。
   * **注意：不支持偏移**，所以只有"从 0 开始"才用它；续传走流。
   */
  fastPut?(localPath: string, remotePath: string, opts?: { step?: (total: number, chunk: number, total2: number) => void }): Promise<void>
  fastGet?(remotePath: string, localPath: string, opts?: { step?: (total: number, chunk: number, total2: number) => void }): Promise<void>
}

export interface ProgressInfo {
  /** 本次已传字节（含续传的起点） */
  transferred: number
  /** 文件总大小 */
  total: number
  /** 0..1 */
  ratio: number
  /** 字节/秒（拿不到就是 undefined） */
  bytesPerSec?: number
  /** 这次是接着已有内容传的（断点续传） */
  resumed: boolean
}

export interface TransferOptions {
  /** 进度回调（已做节流：默认每 120ms 或每 1% 一次） */
  onProgress?: (p: ProgressInfo) => void
  /** 续传：远端已有部分内容时从它的末尾接着传（默认 true） */
  resume?: boolean
  /** 进度节流间隔（测试用） */
  progressIntervalMs?: number
  now?: () => number
}

export interface PutResult {
  ok: boolean
  remotePath: string
  bytes: number
  /** 远端本来就有同样大小 → 没传（部署重复执行时很常见） */
  skipped: boolean
  resumed: boolean
  error?: string
}

export interface GetResult {
  ok: boolean
  localPath: string
  bytes: number
  resumed: boolean
  error?: string
}

/** 远端风格路径拼接（SFTP 永远用 `/`，不要用 path.join —— Windows 会给出反斜杠） */
export function remoteJoin(dir: string, name: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const n = name.replace(/\\/g, '/').replace(/^\/+/, '')
  return d ? `${d}/${n}` : `/${n}`
}

/** 远端路径的目录部分（`/a/b.txt` → `/a`；`/b.txt` → `/`） */
export function remoteDirOf(remotePath: string): string {
  const p = remotePath.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  return i === 0 ? '/' : p.slice(0, i)
}

/** 本地路径 → 远端文件名（Windows 反斜杠也认） */
export function localBaseName(localPath: string): string {
  return path.basename(localPath.replace(/\\/g, '/'))
}

function humanError(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = String((e as { code?: unknown }).code)
    if (code === 'ENOENT') return '远端路径不存在'
    if (code === 'EACCES' || code === 'EPERM') return '权限不足（当前用户不能写这个目录）'
    if (code === 'ENOSPC') return '远端磁盘已满'
    if (code === 'SSH_FX_NO_SUCH_FILE') return '远端路径不存在'
    if (code === 'SSH_FX_PERMISSION_DENIED') return '权限不足'
  }
  return e instanceof Error ? e.message : String(e)
}

/** 进度节流器：同一次传输内按时间/百分比收敛事件数量 */
function makeReporter(
  total: number,
  base: number,
  resumed: boolean,
  opts: TransferOptions
): { report: (sent: number) => void; finish: () => void } {
  const now = opts.now ?? Date.now
  const interval = opts.progressIntervalMs ?? 120
  const startedAt = now()
  let lastAt = 0
  let lastRatio = -1

  return {
    report(sent: number) {
      if (!opts.onProgress) return
      const at = now()
      const transferred = base + sent
      const ratio = total > 0 ? Math.min(1, transferred / total) : 0
      const byTime = at - lastAt >= interval
      const byRatio = Math.floor(ratio * 100) > lastRatio
      if (!byTime && !byRatio) return
      lastAt = at
      lastRatio = Math.floor(ratio * 100)
      const elapsed = Math.max(1, at - startedAt)
      opts.onProgress({
        transferred,
        total,
        ratio,
        bytesPerSec: Math.round((sent / elapsed) * 1000),
        resumed
      })
    },
    finish() {
      if (!opts.onProgress) return
      const at = now()
      const elapsed = Math.max(1, at - startedAt)
      opts.onProgress({
        transferred: total,
        total,
        ratio: 1,
        bytesPerSec: Math.round(((total - base) / elapsed) * 1000),
        resumed
      })
    }
  }
}

/** 远端 stat：不存在返回 undefined（不抛） */
async function statOrUndefined(sftp: SftpLike, remotePath: string): Promise<{ size: number } | undefined> {
  try {
    const st = await sftp.stat(remotePath)
    return { size: Number(st.size) || 0 }
  } catch {
    return undefined
  }
}

/**
 * 上传一个文件（单文件；目录由调用方先打包）。
 *
 * 续传规则：远端已存在且**比本地小** → 从远端末尾接着传（flags `r+` + start）。
 * 远端已存在且**大小相同** → 视为已传完，跳过（部署重复执行时很常见，省一次传输）。
 * 远端已存在且**比本地大** → 不能续传（会截断成错的），直接覆盖重传。
 */
export async function putFile(
  sftp: SftpLike,
  localPath: string,
  remoteDir: string,
  opts: TransferOptions = {}
): Promise<PutResult> {
  const name = localBaseName(localPath)
  const remotePath = remoteJoin(remoteDir, name)
  const resume = opts.resume ?? true

  let localSize = 0
  try {
    localSize = fs.statSync(localPath).size
  } catch (e) {
    return { ok: false, remotePath, bytes: 0, skipped: false, resumed: false, error: `本地文件读不到：${humanError(e)}` }
  }

  const existing = await statOrUndefined(sftp, remotePath)
  let start = 0
  let skipped = false
  if (existing) {
    if (existing.size === localSize) skipped = true
    else if (resume && existing.size < localSize) start = existing.size
    // 远端更大 → start 保持 0（覆盖重传）
  }
  if (skipped) {
    return { ok: true, remotePath, bytes: localSize, skipped: true, resumed: false }
  }

  // 新建（不从中间接着传）优先用 ssh2 自带的 fastPut：它是库自己的多并发实现，
  // 比手写 readStream→writeStream 更快、处理窗口/背压更稳（成熟项目都走这条）。
  if (start === 0 && sftp.fastPut) {
    const reporterFast = makeReporter(localSize, 0, false, opts)
    try {
      await sftp.fastPut(localPath, remotePath, {
        step: (transferred: number) => reporterFast.report(transferred)
      })
    } catch (e) {
      return { ok: false, remotePath, bytes: 0, skipped: false, resumed: false, error: `上传失败：${humanError(e)}` }
    }
    const st = await statOrUndefined(sftp, remotePath)
    if (!st) return { ok: false, remotePath, bytes: 0, skipped: false, resumed: false, error: '上传后远端找不到文件' }
    if (st.size !== localSize) {
      return {
        ok: false,
        remotePath,
        bytes: st.size,
        skipped: false,
        resumed: false,
        error: `大小不一致：本地 ${localSize} 字节，远端 ${st.size} 字节`
      }
    }
    reporterFast.finish()
    return { ok: true, remotePath, bytes: localSize, skipped: false, resumed: false }
  }

  const reporter = makeReporter(localSize, start, start > 0, opts)
  const readable = fs.createReadStream(localPath, start > 0 ? { start } : undefined)
  const writable = start > 0
    ? sftp.createWriteStream(remotePath, { flags: 'r+', start })
    : sftp.createWriteStream(remotePath, { flags: 'w' })

  let sent = 0
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      readable.on('data', (chunk: string | Buffer) => {
        const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        sent += len
        reporter.report(sent)
      })
      readable.on('error', (e) => done(e as Error))
      writable.on('error', (e) => done(e as Error))
      writable.on('close', () => done())
      writable.on('finish', () => done())
      readable.pipe(writable)
    })
  } catch (e) {
    return {
      ok: false,
      remotePath,
      bytes: start + sent,
      skipped: false,
      resumed: start > 0,
      error: `上传失败：${humanError(e)}`
    }
  }

  // 校验：远端大小必须等于本地（SFTP 的写完成不代表已经 flush 到磁盘，stat 是最终事实）
  const after = await statOrUndefined(sftp, remotePath)
  if (!after) {
    return { ok: false, remotePath, bytes: start + sent, skipped: false, resumed: start > 0, error: '上传后远端找不到文件' }
  }
  if (after.size !== localSize) {
    return {
      ok: false,
      remotePath,
      bytes: after.size,
      skipped: false,
      resumed: start > 0,
      error: `大小不一致：本地 ${localSize} 字节，远端 ${after.size} 字节`
    }
  }
  reporter.finish()
  return { ok: true, remotePath, bytes: localSize, skipped: false, resumed: start > 0 }
}

/**
 * 下载一个文件。
 *
 * 续传规则：本地已有部分内容且**比远端小** → 从本地末尾接着写（`a` 追加）；
 * 本地和远端一样大 → 视为已下载完，跳过；本地比远端大 → 覆盖重下。
 */
export async function getFile(
  sftp: SftpLike,
  remotePath: string,
  localDir: string,
  opts: TransferOptions = {}
): Promise<GetResult> {
  const resume = opts.resume ?? true
  const name = remoteDirOf(remotePath) === '.' ? remotePath : remotePath.replace(/\\/g, '/').split('/').pop()!
  const localPath = path.join(localDir, name)

  let remoteSize = 0
  try {
    const st = await sftp.stat(remotePath)
    remoteSize = Number(st.size) || 0
  } catch (e) {
    return { ok: false, localPath, bytes: 0, resumed: false, error: `远端文件读不到：${humanError(e)}` }
  }

  let localSize = 0
  try {
    localSize = fs.statSync(localPath).size
  } catch {
    localSize = 0
  }

  let start = 0
  if (localSize === remoteSize && remoteSize > 0) {
    return { ok: true, localPath, bytes: remoteSize, resumed: false }
  }
  if (resume && localSize > 0 && localSize < remoteSize) start = localSize

  if (start === 0 && sftp.fastGet) {
    const reporterFast = makeReporter(remoteSize, 0, false, opts)
    try {
      await sftp.fastGet(remotePath, localPath, {
        step: (transferred: number) => reporterFast.report(transferred)
      })
    } catch (e) {
      return { ok: false, localPath, bytes: 0, resumed: false, error: `下载失败：${humanError(e)}` }
    }
    const size = fs.existsSync(localPath) ? fs.statSync(localPath).size : -1
    if (size !== remoteSize) {
      return {
        ok: false,
        localPath,
        bytes: size,
        resumed: false,
        error: `大小不一致：远端 ${remoteSize} 字节，本地 ${size} 字节`
      }
    }
    reporterFast.finish()
    return { ok: true, localPath, bytes: remoteSize, resumed: false }
  }

  const reporter = makeReporter(remoteSize, start, start > 0, opts)
  const readable = sftp.createReadStream(remotePath, start > 0 ? { start } : undefined)
  const writable = fs.createWriteStream(localPath, start > 0 ? { flags: 'a' } : { flags: 'w' })

  let got = 0
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      readable.on('data', (chunk: string | Buffer) => {
        const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        got += len
        reporter.report(got)
      })
      readable.on('error', (e) => done(e as Error))
      writable.on('error', (e) => done(e as Error))
      writable.on('close', () => done())
      writable.on('finish', () => done())
      readable.pipe(writable)
    })
  } catch (e) {
    return { ok: false, localPath, bytes: start + got, resumed: start > 0, error: `下载失败：${humanError(e)}` }
  }

  const afterSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : -1
  if (afterSize !== remoteSize) {
    return {
      ok: false,
      localPath,
      bytes: afterSize,
      resumed: start > 0,
      error: `大小不一致：远端 ${remoteSize} 字节，本地 ${afterSize} 字节`
    }
  }
  reporter.finish()
  return { ok: true, localPath, bytes: remoteSize, resumed: start > 0 }
}

/**
 * 续传时远端文件可能比本地"多写了一半坏数据"（上次中途失败）。
 * 这个函数判断"能不能安全续传"：只有远端内容严格是本地前缀时才该续 ——
 * 但校验前缀要读全量，代价高。实践上用**大小**判断足够：
 * 大小不同就重传（putFile 已按此实现：远端更大 → 覆盖）。
 *
 * 这里保留一个显式的说明函数，供将来接哈希校验时替换。
 */
export function canResumeBySize(localSize: number, remoteSize: number): boolean {
  return remoteSize > 0 && remoteSize < localSize
}

/**
 * 该不该用 SFTP（纯判定，宿主只负责把设置和档案模式递进来）。
 *
 * 规则：
 *   - 设置 rz / base64 → 一律不用（用户明确要老路径）
 *   - 设置 sftp → 强试（含堡垒机；可能落到堡垒机自己身上，属高级用法）
 *   - auto（默认）→ 只有**直连**档案用；堡垒机保持 rz/base64
 *
 * 为什么 auto 不给堡垒机：堡垒机的 sftp 子系统通常指向**堡垒机自己**，
 * 上传会"成功"但文件落在错的机器上 —— 比失败更糟。
 */
export function shouldUseSftp(profileMode: string | undefined, channel: string | undefined): boolean {
  const ch = (channel ?? 'auto').trim()
  if (ch === 'rz' || ch === 'base64') return false
  if (ch === 'sftp') return true
  return profileMode === 'direct'
}
/**
 * 把"要传到哪个远端目录"解析成**确定存在**的绝对路径。
 *
 * ⚠️ 这是 0.3.17 真实事故的修复点：以前宿主拿不到目录时（shell 探测返回空）
 * 会**悄悄退回 `realpath('.')`**（= 登录用户的 home），于是 `remoteDir: "/tmp"`
 * 变成了 `/root/config.json` —— 报告还写"成功"。宁可失败，也不能传错地方。
 *
 * 规则：
 *   - 给了 remoteDir → 必须是已存在的**目录**；不存在/不可访问/不是目录 → 抛错
 *   - 没给 → 用 sftp 的当前目录（realpath('.')）；连这个都失败 → 抛错
 */
export async function resolveRemoteDir(sftp: SftpLike, requested?: string): Promise<string> {
  const want = (requested ?? '').trim()
  let abs: string
  try {
    abs = await sftp.realpath(want || '.')
  } catch (e) {
    throw new Error(`远端目录不存在或不可访问：${want || '(当前目录)'}（${humanError(e)}）`)
  }
  if (!abs || abs === '.') throw new Error(`远端目录解析失败：${want || '(当前目录)'}`)
  let st: { isDirectory?: () => boolean } | undefined
  try {
    st = await sftp.stat(abs)
  } catch (e) {
    // 真机观察（2026-11-20，OpenSSH）：对**不存在**的路径调 realpath 也可能"成功"返回同一路径，
    // 真正的 ENOENT 要到 stat 才出现。所以统一按"不存在"报，而不是含糊的"不可访问"。
    throw new Error(`远端目录不存在：${abs}（${humanError(e)}）`)
  }
  if (st && typeof st.isDirectory === 'function' && !st.isDirectory()) {
    throw new Error(`远端路径不是目录：${abs}`)
  }
  return abs
}