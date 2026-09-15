/**
 * 传输结果的**校验**：远端读了什么、这次到底成没成。
 *
 * 抽成独立模块（不依赖 vscode），是因为它同时被两条路用：
 *   · `aiBridge`（MCP / 语言模型工具那条路）
 *   · `transferPath`（给人用的上传/下载标准入口）
 * 两边必须用同一套判据，否则又会分叉出"一个说成功、一个说失败"。
 *
 * ⚠️ **绝对不要用 mtime 判断成功与否**（2026-09-14 我踩过这个坑）：
 * ZMODEM 会把**源文件的 mtime 一起传过去**（ZFILE 帧里带），所以传完之后
 * 远端文件的 mtime 就等于本机源文件的 mtime。实测两次：
 *   本机 AGENT_RULES.md  mtime 2026-09-10 19:16:47 / md5 11acf3c5…
 *   远端刚传上去的那份    mtime Sep 10 19:16       / md5 11acf3c5…
 *   本机 vsix 17:24 打的包 → 远端 mtime 17:24（传输发生在 17:26:58）
 * 我据此写过一版"mtime 太旧 → 判定失败"，结果**凡是源文件几分钟没改过就误报**。
 *
 * 唯一可靠的依据是**内容哈希**（远端 md5sum/sha256sum 与本机算的比），
 * 拿不到哈希时才退化成"大小一致"这个弱判据（并如实说明是弱判据）。
 */

import * as crypto from 'crypto'
import { fmtBytes } from './status'

/** 只要能跑命令就行 —— 真实实现是 BastionTerminal，测试里可以是假的 */
export interface ExecLike {
  exec(cmd: string): Promise<string>
  /** 上一条命令的退出码（拿不到就是 undefined） */
  exitCode(): number | undefined
}

export interface RemoteFileInfo {
  hash?: string
  size?: number
  mtime?: number
  path?: string
  /** 当前账号能不能读这个文件（读不了 → 算不出哈希，这时只能按大小判断） */
  readable?: boolean
}

/** 小写 hex 的 md5（上传校验用） */
export function md5Hex(data: Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex')
}

/** 文件名是否安全到可以拼进远端 glob（有特殊字符就跳过回读校验，不硬拼） */
export function globSafe(name: string): boolean {
  return /^[A-Za-z0-9._\u4e00-\u9fa5-]{1,120}$/.test(name)
}

/**
 * 读远端文件信息：**哈希**（md5，退 sha256）+ 大小 + mtime + 绝对路径。
 * 一次 exec 拿全，每个匹配的文件一行 `hash|size|mtime|path`。
 *
 * @param shellWord **已经由调用方做好 shell 引用**的文件名/glob（例如 `'a b.txt'` 或 `'a b.txt'*`）。
 *                  引用交给调用方，是为了让带空格/中文的绝对路径也能正确展开 glob。
 */
export async function remoteInfo(session: ExecLike, shellWord: string): Promise<RemoteFileInfo[]> {
  if (!shellWord.trim()) return []
  // ⚠️ 这里**刻意不依赖 awk/cut 之类的外部工具**（2026-09-14 真机教训）：
  //    远端回读时 `md5sum | awk '{print $1}'` 什么都没吐出来（哈希变成 NA），
  //    于是只能退化成"按大小判断"的弱证据 —— 而 awk 从来不在我们的能力探测里。
  //    现在改用 shell 自己的参数展开（`${h%% *}` 取第一个空格之前的部分），零外部依赖。
  //    同时多回一个 `readable`：文件不可读时算不出哈希，要能区分"没工具"和"没权限"。
  const cmd =
    `for f in ${shellWord}; do [ -f "$f" ] || continue; ` +
    `r=$([ -r "$f" ] && echo yes || echo no); ` +
    `h=''; if [ "$r" = yes ]; then ` +
    `h=$(md5sum "$f" 2>/dev/null); h=\${h%% *}; ` +
    `[ -n "$h" ] || { h=$(sha256sum "$f" 2>/dev/null); h=\${h%% *}; } ` +
    `fi; ` +
    `[ -n "$h" ] || h=NA; ` +
    `s=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f" 2>/dev/null || echo NA); ` +
    `m=$(stat -c %Y "$f" 2>/dev/null || echo NA); ` +
    `printf '%s|%s|%s|%s|%s\\n' "$h" "$s" "$m" "$r" "$f"; done`
  const out = await session.exec(cmd)
  const files: RemoteFileInfo[] = []
  for (const line of out.split('\n')) {
    const parts = line.split('|')
    if (parts.length < 5) continue
    const [hash, sizeRaw, mtimeRaw, readableRaw, ...rest] = parts
    const p = rest.join('|').trim()
    if (!p || p === 'NA') continue
    const size = sizeRaw !== 'NA' ? Number.parseInt(sizeRaw, 10) : undefined
    const mtime = mtimeRaw !== 'NA' ? Number.parseInt(mtimeRaw, 10) : undefined
    files.push({
      hash: hash === 'NA' ? undefined : hash,
      size,
      mtime,
      readable: readableRaw === 'yes',
      path: p
    })
  }
  return files
}

/** 判断这次上传到底成没成 —— **纯函数**，可单测 */
export function judgeUpload(opts: {
  /** 本机源文件的哈希（hex，小写）；算不出来就传 undefined */
  localHash?: string
  /** 远端读到的信息；undefined = 文件不存在 */
  remote?: RemoteFileInfo
  localSize: number
  mode: 'skip' | 'overwrite' | 'rename'
  name: string
  /** 改名模式用：上传前后远端同名/同前缀文件个数 */
  beforeCount?: number
  afterCount?: number
}): { ok: boolean; note: string; remotePath?: string } {
  const stamp = (t?: number): string =>
    t === undefined ? '未知' : new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19)

  if (!opts.remote) {
    return {
      ok: false,
      note: '上传后远端**找不到这个文件** —— 这次上传没有成功（可看日志里 `[zmodem]` / `[transfer]` 那几行）'
    }
  }
  const r = opts.remote

  if (opts.mode === 'rename') {
    const before = opts.beforeCount ?? 0
    const after = opts.afterCount ?? (r.path ? 1 : 0)
    if (after <= before) {
      return {
        ok: false,
        note: `改名模式下没看到新文件（远端原有 ${before} 个同名/同前缀文件，上传后还是 ${after} 个）—— 这次上传很可能没成功`,
        remotePath: r.path
      }
    }
  }

  // 首选：内容哈希一致 = 铁证
  if (opts.localHash && r.hash) {
    if (r.hash === opts.localHash) {
      return {
        ok: true,
        note:
          `远端内容与本机**逐字节一致**（哈希 ${r.hash.slice(0, 12)}…，${fmtBytes(r.size ?? opts.localSize)}）；` +
          `远端 mtime ${stamp(r.mtime)} 是**源文件的时间戳**（ZMODEM 会带过去），不代表文件旧`,
        remotePath: r.path
      }
    }
    return {
      ok: false,
      note: `内容对不上：本机哈希 ${opts.localHash.slice(0, 12)}…，远端哈希 ${r.hash.slice(0, 12)}… —— 传输不完整或对端没换掉旧文件`,
      remotePath: r.path
    }
  }

  // 退而求其次：远端算不出哈希，只能比大小（**弱判据**，而且要如实说清"为什么算不出"）
  if (r.size !== undefined && r.size === opts.localSize) {
    const why = r.readable === false ? '当前账号**读不了**这个文件（权限），所以算不出哈希' : '远端没能算出哈希（目标机缺少 md5sum/sha256sum）'
    return {
      ok: true,
      note: `远端大小与本机一致（${fmtBytes(r.size)}）—— ${why}，**只能按大小判断，属于弱证据**`,
      remotePath: r.path
    }
  }
  return {
    ok: false,
    note: `大小对不上：本机 ${fmtBytes(opts.localSize)}，远端 ${r.size === undefined ? '读不到' : fmtBytes(r.size)}`,
    remotePath: r.path
  }
}
