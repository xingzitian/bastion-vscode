/**
 * **传输的标准工具**：所有"传文件"的入口最后都走这里。
 *
 * 为什么要有它（2026-09-14 的结论）：同一个动作以前有四套说法、四个入口 ——
 *   · 实现：rz / rz -y / rz -E（覆盖模式三件套）、目录要 rsync（实验、默认关）、部署里另有一套
 *   · 入口：右键上传、粘本地路径、部署任务 uploads、传输历史重试、AI 的 bastion_push
 *   · 结果：状态栏进度、传输历史、部署报告、给 AI 的文本 —— 四套话术
 * 人和 AI 都记不清"到底哪条路、成没成"。所以这里收敛成：
 *
 *   **一个入口** `pushPath()` / `pullPath()`
 *   **一套词汇** 跳过 / 覆盖 / 改名（`rz -y`、`rz -E`、base64 降级都是实现细节）
 *   **一份证据** 传完回读远端（哈希 + 大小 + 路径），成功失败都有依据
 *
 * 通道选择（**自动**，并把"用了哪条、为什么"明确告诉调用方）：
 *   上传：`rz`（装了 lrzsz）→ 没有 rz 就 **base64 分块塞进 shell**（不需要装任何东西，慢但通用）
 *   下载：`sz` → 没有 sz 就 **远端 base64 打出来、本地解码**
 *   目录：先本地 `tar -czf` 打包 → 传 → 远端 `tar -xzf` 解开 → 清理临时包
 *
 * 堡垒机那条链路的现实：**目标机在堡垒机后面，只给了我们一条交互式 shell**，
 * 所以 SFTP/端口转发都用不上 —— rz/sz 或 base64 是仅有的两条路
 * （rsync 那条还在"实验性未完成"，默认关）。
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { shQuote } from './shellQuote'
import { fmtBytes } from './status'
import { globSafe, judgeUpload, md5Hex, remoteInfo, type ExecLike, type RemoteFileInfo } from './uploadVerify'
import type { OverwriteMode } from './zmodem'

/** 传文件需要宿主提供的能力（真实实现是 BastionTerminal；测试里可以很薄） */
export interface TransferSession extends ExecLike {
  /** 会话名（日志 + 能力探测缓存 key） */
  readonly name: string
  /** 走 rz/sz 的通道；宿主没有 zmodem 就可以不提供（那就会自动只用 base64） */
  rzUpload?(paths: string[]): Promise<{ skipped: string[]; mode: OverwriteMode; error?: string }>
  szDownload?(remotePath: string, localDir: string): Promise<{ ok: boolean; localPath?: string; message?: string }>
  /** 当前生效的覆盖方式（来自 `bastion.uploadOverwrite`） */
  overwriteMode(): OverwriteMode
  log(msg: string): void
}

export type TransferMethod = 'rz' | 'sz' | 'base64' | 'tar+rz' | 'tar+base64'

export interface Capabilities {
  rz: boolean
  sz: boolean
  base64: boolean
  tar: boolean
  md5sum: boolean
  /** 探测失败时的原因（没探到 = 一律当作没有，走降级） */
  note?: string
}

export interface PushOutcome {
  ok: boolean
  method: TransferMethod
  /** 本机源文件（目录模式下是打包后的临时包路径） */
  localPath: string
  remotePath?: string
  bytes: number
  mode: OverwriteMode
  skipped?: boolean
  message: string
}

export interface PullOutcome {
  ok: boolean
  method: TransferMethod
  localPath?: string
  bytes?: number
  message: string
}

// ───────────────────────── 能力探测（每个会话探一次，缓存） ─────────────────────────

const capsCache = new Map<string, Capabilities>()

export async function probeCapabilities(session: TransferSession, refresh = false): Promise<Capabilities> {
  const cached = capsCache.get(session.name)
  if (cached && !refresh) return cached
  const caps: Capabilities = { rz: false, sz: false, base64: false, tar: false, md5sum: false }
  try {
    // 一条命令问全：`command -v` 不输出就说明没有
    const out = await session.exec(
      'for c in rz sz base64 tar md5sum; do printf "%s=" "$c"; command -v "$c" >/dev/null 2>&1 && echo yes || echo no; done'
    )
    for (const line of out.split('\n')) {
      const m = /^(rz|sz|base64|tar|md5sum)=(yes|no)/.exec(line.trim())
      if (m && (m[1] === 'rz' || m[1] === 'sz' || m[1] === 'base64' || m[1] === 'tar' || m[1] === 'md5sum')) {
        caps[m[1]] = m[2] === 'yes'
      }
    }
  } catch (e) {
    caps.note = `探测失败：${(e as Error).message}`
  }
  session.log(
    `[transfer] 目标机能力：rz=${caps.rz ? '有' : '无'} sz=${caps.sz ? '有' : '无'} ` +
      `base64=${caps.base64 ? '有' : '无'} tar=${caps.tar ? '有' : '无'} md5sum=${caps.md5sum ? '有' : '无'}`
  )
  capsCache.set(session.name, caps)
  return caps
}

/** 测试/换会话时清缓存 */
export function clearCapabilities(name?: string): void {
  if (name) capsCache.delete(name)
  else capsCache.clear()
}

/** 纯逻辑：上传该用哪条通道（可单测） */
export function choosePushMethod(caps: Capabilities, isDir: boolean): TransferMethod | null {
  if (isDir) {
    if (!caps.tar) return null
    if (caps.rz) return 'tar+rz'
    if (caps.base64) return 'tar+base64'
    return null
  }
  if (caps.rz) return 'rz'
  if (caps.base64) return 'base64'
  return null
}

/** 纯逻辑：下载该用哪条通道（可单测） */
export function choosePullMethod(caps: Capabilities): TransferMethod | null {
  if (caps.sz) return 'sz'
  if (caps.base64) return 'base64'
  return null
}

/** 纯逻辑：base64 切块（可单测）。块大小要远小于 shell/代理的命令行上限 */
export function chunkBase64(b64: string, size = 4000): string[] {
  const out: string[] = []
  for (let i = 0; i < b64.length; i += size) out.push(b64.slice(i, i + size))
  return out
}

/** base64 降级的上限：太大就别硬塞（每块一次 exec，800KB 要两百多次往返） */
export const B64_SOFT_LIMIT = 256 * 1024
export const B64_HARD_LIMIT = 4 * 1024 * 1024

// ───────────────────────── 上传 ─────────────────────────

export async function pushPath(opts: {
  localPath: string
  remoteDir?: string
  session: TransferSession
  overwrite?: OverwriteMode
  /** 只允许某条通道（测试用；正常不用传） */
  forceMethod?: TransferMethod
}): Promise<PushOutcome> {
  const { session } = opts
  const localPath = opts.localPath.trim()
  const mode = opts.overwrite ?? session.overwriteMode()
  const fail = (message: string, method: TransferMethod = 'rz'): PushOutcome => ({
    ok: false,
    method,
    localPath,
    bytes: 0,
    mode,
    message
  })

  if (!localPath) return fail('错误：需要一个本机路径')
  if (!fs.existsSync(localPath)) return fail(`错误：本机找不到这个路径：${localPath}`)
  const st = fs.statSync(localPath)
  const isDir = st.isDirectory()
  const name = path.basename(localPath)

  // 目标目录：**必须在同一条命令里 `cd` + `pwd`**。
  //
  // ⚠️ 不能分成两条（2026-09-14 由端到端测试抓到的真 bug）：每条远端命令都可能是**独立的 shell**
  //    （非 pty 的 exec 就是这样），`cd` 不会保留，接着 `pwd` 会返回 $HOME ——
  //    文件被传到 home 目录，而校验因为"在同一个错地方自洽"还报成功。
  // 一条命令里 `cd && pwd` 对两种情况都正确：pty 常驻会话（cd 也会保留，和以前行为一致）
  // 和一次性 exec。
  const remoteDir = (opts.remoteDir ?? '').trim()
  const probe = remoteDir
    ? await session.exec(`cd ${shQuote(remoteDir)} 2>/dev/null && pwd || printf '__BASTION_CD_FAIL__\\n'`)
    : await session.exec('pwd')
  if (remoteDir && probe.includes('__BASTION_CD_FAIL__')) {
    return fail(
      `错误：远端目录 ${remoteDir} 进不去。请确认目录存在且有权限；` +
        '也可以不传 remoteDir，直接传到会话当前目录。'
    )
  }
  // 之后所有远端路径都用**绝对路径**：不依赖 cwd 是否保留，用户中途 cd 走了也不会传错地方
  const dirAbs = lastAbsolutePath(probe)
  const at = (n: string): string => (dirAbs ? `${dirAbs.replace(/\/+$/, '')}/${n}` : n)

  const caps = await probeCapabilities(session)
  const method = opts.forceMethod ?? choosePushMethod(caps, isDir)
  if (!method) {
    return fail(
      `❌ 目标机上既没有 **rz**（lrzsz），也没有 **base64**${isDir ? '，或者没有 tar（传目录要用）' : ''} —— ` +
        '两条通道都走不了。请让用户在这台机器上装一下（`yum install -y lrzsz` 或 `apt-get install -y lrzsz`），' +
        '或者把文件内容直接贴出来。'
    )
  }

  // 目录：先本地打包（Windows 10+ 自带 tar.exe，Linux/macOS 也有）
  let toSend = localPath
  let tempTar: string | undefined
  let sendBytes = st.size
  if (isDir) {
    const packed = packDir(localPath)
    if ('error' in packed) return fail(`❌ 本地打包失败：${packed.error}`, method)
    toSend = packed.tarPath
    tempTar = packed.tarPath
    sendBytes = fs.statSync(toSend).size
    session.log(`[transfer] 已把目录打包：${path.basename(toSend)}（${fmtBytes(sendBytes)}）`)
  }

  try {
    // 基线计数（改名模式判断"有没有多出一个新文件"）
    const sendName = path.basename(toSend)
    const beforeCount = globSafe(sendName) ? (await remoteInfo(session, shQuote(at(sendName)))).length : 0

    let uploadError: string | undefined
    let skippedNames: string[] = []
    if (method === 'rz' || method === 'tar+rz') {
      if (!session.rzUpload) return fail('❌ 这个宿主没有 rz 通道（正常不该发生）', method)
      const res = await session.rzUpload([toSend])
      uploadError = res.error
      skippedNames = res.skipped
    } else {
      const r = await pushViaBase64(session, toSend, at(sendName))
      if (!r.ok) return fail(`❌ base64 通道上传失败：${r.message}`, method)
    }

    if (uploadError) return fail(`❌ 上传失败：${uploadError}`, method)

    // 目录：远端解开
    if (isDir) {
      const tarRemote = at(sendName)
      const extract = await session.exec(`tar -xzf ${shQuote(tarRemote)} -C ${shQuote(dirAbs || '.')} && rm -f ${shQuote(tarRemote)}`)
      if (session.exitCode() !== 0) {
        return fail(
          `❌ 文件传上去了，但远端解包失败（tar 退出码 ${session.exitCode() ?? '未知'}）—— ` +
            `远端目录里留下了 ${sendName}，可以自己手动 \`tar -xzf ${sendName}\` 试。`,
          method
        )
      }
      return {
        ok: true,
        method,
        localPath,
        remotePath: remoteDir || '会话当前目录',
        bytes: sendBytes,
        mode,
        message:
          `✅ 目录已上传并解开：${name} → ${remoteDir || '会话当前目录'}\n` +
          `通道：${methodLabel(method)}（打包后 ${fmtBytes(sendBytes)}；解包成功后临时包已删除）。` +
          (caps.rz ? '' : '\n（目标机没有 lrzsz，走的是 base64 降级）')
      }
    }

    if (skippedNames.includes(sendName)) {
      return {
        ok: false,
        method,
        localPath,
        bytes: sendBytes,
        mode,
        skipped: true,
        message:
          `⚠️ 远端已存在同名文件，按「覆盖方式=${mode}」**跳过了，没有传**：${name}\n` +
          '要覆盖就让用户把 bastion.uploadOverwrite 改成 overwrite（或他自己传）。'
      }
    }

    const after = await remoteInfo(session, shQuote(at(sendName)) + (mode === 'rename' ? '*' : ''))
    const target = after.slice().sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]
    let localHash: string | undefined
    try {
      localHash = md5Hex(fs.readFileSync(toSend))
    } catch {
      localHash = undefined
    }
    const verdict = judgeUpload({
      localHash,
      remote: target,
      localSize: sendBytes,
      mode,
      name: sendName,
      beforeCount,
      afterCount: after.length
    })
    const methodNote = methodLabel(method) + (caps.rz ? '' : '（目标机没有 lrzsz，自动降级）')
    // 权限异常要**单独、显眼**地说一次。
    // 为什么要重复强调：真机上 AI 把 `----------`（0000）在总结里改写成 `-rw-r--r--` 了 ——
    // 一句夹在"判定依据"里的"读不了"它没当回事，而这件事的后果是**文件传上去等于白传**
    // （服务/非 root 用户读不了，部署的配置文件直接失效）。
    const unreadable = target?.readable === false
    const permWarning = unreadable
      ? '\n⚠️ **注意：远端这个文件当前账号读不了（权限 0000）—— 传上去等于白传**：服务/非 root 用户用不了它。\n' +
        '   成因：ZMODEM 上传时没带权限位（本扩展 0.3.2 起已修）。请重装扩展后**重新上传**这个文件；\n' +
        '   已经传上去的旧文件需要修一下：`chmod 644 <文件>`（脚本用 `chmod 755`）。'
      : ''
    return {
      ok: verdict.ok,
      method,
      localPath,
      remotePath: verdict.remotePath,
      bytes: sendBytes,
      mode,
      message:
        `${verdict.ok ? '✅ 已上传' : '❌ 上传没成功'} ${name}（本机 ${fmtBytes(sendBytes)}）→ ${verdict.remotePath ?? (remoteDir || '会话当前目录')}\n` +
        `通道：${methodNote}；覆盖方式：${mode}\n` +
        `判定依据（传完回读远端）：${verdict.note}${permWarning}\n` +
        '—— 这条回读就是证据，**不要再用 ls / md5sum 自己验一遍**。'
    }
  } finally {
    if (tempTar) {
      try {
        fs.rmSync(tempTar, { force: true })
      } catch {
        /* 临时包删不掉不影响结果 */
      }
    }
  }
}

/** 从命令输出里取最后一个绝对路径（`pwd` 的结果） */
export function lastAbsolutePath(out: string): string {
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
      .pop() ?? ''
  )
}

/** 本地打包目录（tar -czf，Windows 10+ 自带 tar.exe） */
export function packDir(dir: string): { tarPath: string } | { error: string } {
  const parent = path.dirname(path.resolve(dir))
  const base = path.basename(path.resolve(dir))
  const tarPath = path.join(path.dirname(dir), `.${base}.bastion-${Date.now().toString(36)}.tar.gz`)
  const r = spawnSync('tar', ['-czf', tarPath, '-C', parent, base], { encoding: 'utf8' })
  if (r.error) return { error: `本机没有可用的 tar（${r.error.message}）` }
  if (r.status !== 0) return { error: (r.stderr || '').trim() || `tar 退出码 ${r.status}` }
  return { tarPath }
}

/** base64 分块塞进 shell（不需要目标机装任何东西） */
async function pushViaBase64(
  session: TransferSession,
  localFile: string,
  /** 远端**绝对路径**（用绝对路径，避免依赖会话当前目录） */
  remotePath: string
): Promise<{ ok: boolean; message?: string }> {
  if (!session) return { ok: false, message: '会话不可用' }
  const size = fs.statSync(localFile).size
  if (size > B64_HARD_LIMIT) {
    return {
      ok: false,
      message: `文件 ${fmtBytes(size)} 超过 base64 通道的上限（${fmtBytes(B64_HARD_LIMIT)}）—— 这条路要一块一块发，大文件不划算`
    }
  }
  const b64 = fs.readFileSync(localFile).toString('base64')
  const chunks = chunkBase64(b64)
  const name = path.basename(localFile)
  const part = `${remotePath}.bastion-part`
  session.log(
    `[transfer] 目标机没有 rz，改用 base64 分块上传：${name}（${fmtBytes(size)}，${chunks.length} 块）` +
      (size > B64_SOFT_LIMIT ? ' —— 文件不小，会比较慢' : '')
  )
  for (let i = 0; i < chunks.length; i++) {
    const op = i === 0 ? '>' : '>>'
    await session.exec(`printf '%s' '${chunks[i]}' ${op} ${shQuote(part)}`)
    const rc = session.exitCode()
    if (rc !== 0 && rc !== undefined) {
      await session.exec(`rm -f ${shQuote(part)}`)
      return { ok: false, message: `第 ${i + 1}/${chunks.length} 块写入失败（退出码 ${rc}）` }
    }
  }
  await session.exec(`base64 -d < ${shQuote(part)} > ${shQuote(remotePath)} && rm -f ${shQuote(part)}`)
  const rc = session.exitCode()
  if (rc !== 0 && rc !== undefined) return { ok: false, message: `base64 解码失败（退出码 ${rc}）` }
  return { ok: true }
}

// ───────────────────────── 下载 ─────────────────────────

export async function pullPath(opts: {
  remotePath: string
  /** 落盘目录（必填：默认目录的规则由调用方决定，这样这个模块不依赖 vscode） */
  localDir: string
  session: TransferSession
  forceMethod?: TransferMethod
}): Promise<PullOutcome> {
  const { session } = opts
  const remotePath = opts.remotePath.trim()
  if (!remotePath) return { ok: false, method: 'sz', message: '错误：需要 remotePath（远端文件路径）' }
  const localDir = opts.localDir.trim()
  if (!localDir) return { ok: false, method: 'sz', message: '错误：需要 localDir（本机落盘目录）' }
  const caps = await probeCapabilities(session)
  const method = opts.forceMethod ?? choosePullMethod(caps)
  if (!method) {
    return {
      ok: false,
      method: 'sz',
      message:
        '❌ 目标机上既没有 **sz**（lrzsz），也没有 **base64** —— 两条通道都走不了。' +
        '请让用户装一下 lrzsz，或者让他 `cat` 出来给你看。'
    }
  }

  if (method === 'sz') {
    if (!session.szDownload) return { ok: false, method: 'sz', message: '❌ 这个宿主没有 sz 通道（正常不该发生）' }
    const r = await session.szDownload(remotePath, localDir)
    if (!r.ok) return { ok: false, method: 'sz', message: `❌ 下载失败：${r.message ?? '未知原因'}\n（远端：${remotePath}）` }
    let bytes: number | undefined
    try {
      bytes = fs.statSync(r.localPath ?? '').size
    } catch {
      /* 拿不到大小就算了 */
    }
    return {
      ok: true,
      method: 'sz',
      localPath: r.localPath,
      bytes,
      message: `✅ 已下载 ${path.basename(r.localPath ?? remotePath)}${bytes === undefined ? '' : `（${fmtBytes(bytes)}）`} → ${r.localPath ?? localDir}`
    }
  }

  return pullViaBase64(session, remotePath, localDir)
}

/** 远端 base64 打出来、本地解码（目标机没有 sz 时的通用退路） */
async function pullViaBase64(session: TransferSession, remotePath: string, localDir: string): Promise<PullOutcome> {
  try {
    fs.mkdirSync(localDir, { recursive: true })
  } catch (e) {
    return { ok: false, method: 'base64', message: `创建本地目录失败：${(e as Error).message}` }
  }
  const sizeOut = await session.exec(`stat -c %s ${shQuote(remotePath)} 2>/dev/null || echo NA`)
  const remoteSize = /(\d+)/.exec(sizeOut)?.[1]
  const size = remoteSize ? Number.parseInt(remoteSize, 10) : undefined
  if (size !== undefined && size > B64_HARD_LIMIT) {
    return {
      ok: false,
      method: 'base64',
      message: `❌ 远端文件 ${fmtBytes(size)} 超过 base64 通道上限（${fmtBytes(B64_HARD_LIMIT)}）—— 这条路要整段打出来，大文件不划算`
    }
  }
  session.log(`[transfer] 目标机没有 sz，改用 base64 拉取：${remotePath}${size === undefined ? '' : `（${fmtBytes(size)}）`}`)
  // 用哨兵把 payload 夹住：exec 的输出里还带着命令回显，不能直接当 base64 解。
  //
  // ⚠️ 三个坑都在这一小段里，别改回去（2026-09-15 由测试和桌面版实机一起逼出来的）：
  //   1. **两个** base64 调用都要吞掉 stderr（`2>/dev/null`）。原来兜底那条没吞，
  //      文件不存在时 `base64: ...: No such file or directory` 会**混进 payload**，
  //      报出来的错是 `illegal base64 data at input byte 6` —— 完全指不到真实原因。
  //   2. 哨兵要带**本次调用的随机后缀**：固定字符串的话，命令回显里那一份会和真正的
  //      payload 撞车（pty 折行时回显残片照样带完整哨兵），`indexOf` 会从残片开始截。
  //   3. 取的时候用 **lastIndexOf**（真正的 payload 一定在回显之后）。
  const nonce = crypto.randomBytes(6).toString('hex')
  const beginTok = `__B64_BEGIN_${nonce}__`
  const endTok = `__B64_END_${nonce}__`
  const out = await session.exec(
    `printf '${beginTok}\\n'; base64 -w0 ${shQuote(remotePath)} 2>/dev/null || base64 ${shQuote(remotePath)} 2>/dev/null; printf '\\n${endTok}\\n'`
  )
  const begin = out.lastIndexOf(beginTok)
  const end = out.lastIndexOf(endTok)
  if (begin < 0 || end < 0 || end <= begin) {
    return { ok: false, method: 'base64', message: `❌ 没能从远端拿到 base64 内容（可能是路径不对或没权限）：${remotePath}` }
  }
  const b64 = out.slice(begin + beginTok.length, end).replace(/\s+/g, '')
  if (!b64) {
    // 空 payload 的三种可能分开说清楚：**不能**当成"传回了一个空文件"就报成功 ——
    // 那会让 AI 以为拿到了内容。
    if (size === undefined) {
      return {
        ok: false,
        method: 'base64',
        message:
          `❌ 远端文件不存在或当前账号读不到：${remotePath}\n` +
          '（远端 `stat` 拿不到大小，base64 也是空的；先确认路径和权限，别把它当成空文件。）'
      }
    }
    if (size > 0) {
      return {
        ok: false,
        method: 'base64',
        message:
          `❌ 远端报告这个文件有 ${fmtBytes(size)}，但一个字节都没回出来：${remotePath}\n` +
          '（多半是没读权限，或者远端的 base64 不接受这些参数。）'
      }
    }
  }
  // base64 字符集之外的任何东西都说明「有别的输出混进来了」。
  // 为什么必须显式查一遍：Node 的 `Buffer.from(x, 'base64')` **不会抛错** ——
  // 它会把非法字符直接丢掉，把一堆命令原文悄悄变成乱码字节。这条防线不能省。
  if (!/^[A-Za-z0-9+/=]*$/.test(b64)) {
    return {
      ok: false,
      method: 'base64',
      message: `❌ 远端回出来的内容不是有效的 base64（有别的输出混进来了）：${remotePath}\n${b64.slice(0, 120)}`
    }
  }
  const buf = Buffer.from(b64, 'base64')
  const localPath = path.join(localDir, path.basename(remotePath))
  try {
    fs.writeFileSync(localPath, buf)
  } catch (e) {
    return { ok: false, method: 'base64', message: `❌ 本地写盘失败：${(e as Error).message}` }
  }
  return {
    ok: true,
    method: 'base64',
    localPath,
    bytes: buf.length,
    message:
      `✅ 已下载 ${path.basename(remotePath)}（${fmtBytes(buf.length)}）→ ${localPath}\n` +
      '通道：base64（目标机没有 lrzsz，自动降级）'
  }
}

/** 通道名（给人和 AI 看的人话） */
export function methodLabel(m: TransferMethod): string {
  switch (m) {
    case 'rz':
      return 'rz（lrzsz）'
    case 'sz':
      return 'sz（lrzsz）'
    case 'base64':
      return 'base64 降级（目标机没有 lrzsz）'
    case 'tar+rz':
      return 'tar 打包 + rz'
    case 'tar+base64':
      return 'tar 打包 + base64 降级'
  }
}

export type { RemoteFileInfo }
