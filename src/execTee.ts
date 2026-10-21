/**
 * 长命令的 `tee` 封装（纯函数，好测）。
 *
 * 为什么是 `tee` 而不是 `nohup`：
 * - `nohup` 把终端抢走 —— 人就看不到实时输出了，直接破坏"人和 AI 共用一条会话"这个核心不变量；
 *   而且这个环境里曾经出现过 nohup 把会话搞断。
 * - `tee -a` 只是"多一份副本"：人照常在终端里看到输出，心跳/提示符也都在；我们额外拿到一份完整日志。
 *
 * 退出码怎么拿：管道里 `$?` 是 `tee` 的，不是命令的。所以在 braces 里面把 `$?` 写进 `.rc` 文件，
 * 管道结束后再把 `.rc` 读出来拼到哨兵行 —— 这样退出码仍然是**命令**的，而不是 tee 的。
 */

export interface TeePlan {
  /** 要写到会话里的整条命令（已含 mkdir / tee / rc 读取 / 哨兵） */
  cmd: string
  logPath: string
  rcPath: string
}

/** 作业日志的落点（/tmp 不可写时退到 $HOME） */
export function teePaths(jobId: string): { logPath: string; rcPath: string; dir: string } {
  const dir = '/tmp/bastion'
  const logPath = `${dir}/job-${jobId}.log`
  return { dir, logPath, rcPath: `${logPath}.rc` }
}

/** POSIX 单引号转义（双引号里 $、`、\、" 都要处理，单引号最省事） */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 拼 `tee` 版命令。
 *
 * @param command 用户命令（末尾换行会被去掉）
 * @param logPath 远端日志
 * @param marker  哨兵前缀（**空字符串 = 不加哨兵**，用于可能弹密码的 sudo：加了等不到，反而误导）
 */
export function buildTeeCommand(input: {
  command: string
  logPath: string
  rcPath: string
  dir: string
  marker?: string
}): string {
  const cmd = input.command.replace(/\r?\n+$/, '')
  const log = shQuote(input.logPath)
  const rc = shQuote(input.rcPath)
  const head = `mkdir -p ${shQuote(input.dir)} 2>/dev/null`
  // 退出码写在 braces 里面：$? 是**命令**的状态，不是 tee 的
  const body = `{ ${cmd}; echo $? > ${rc}; } 2>&1 | tee -a ${log}`
  if (!input.marker) {
    // 不安全（可能弹密码）：不加哨兵，靠"输出静止"判定；日志照样有
    return `${head}; ${body}`
  }
  const readBack = `eb=$(cat ${rc} 2>/dev/null || echo 1); echo ${input.marker}:$eb`
  return `${head}; ${body}; ${readBack}`
}

/** 从 tee 日志里读某段（给"扩展重启后还能 cat"用；命令形式，交给 exec 执行） */
export function tailLogCommand(logPath: string, sinceOffset: number, maxBytes: number): string {
  const from = Math.max(1, Math.floor(sinceOffset) + 1)
  const len = Math.max(1, Math.min(256 * 1024, Math.floor(maxBytes)))
  return `tail -c +${from} ${shQuote(logPath)} | head -c ${len}`
}
