/**
 * rsync 传输桥的纯逻辑部分（可单测，不碰 vscode / 不碰网络）。
 *
 * 这一路的结论全部来自 `shell_tools/bastion-wails/tools/rsync-probe/` 里的实测
 * （两台发行版 × 两个 rsync 版本 × 5 种搭法，10 格全通），关键的两条：
 *
 * 1. **协议起点会被终端噪声污染**：在 pty 上跑交互式 shell 时，客户端最先收到的是
 *    `\x1b[?2004l\r\n`（bash/readline 关括号粘贴模式时吐的），rsync 把它当成协议版本号，
 *    于是报 `protocol version mismatch -- is your shell clean?`。
 *    → 必须**按握手形状**找到协议起点再开始转发，而不是"丢掉像噪声的字符"。
 *      按值猜会踩坑：协议号 32 就是 `0x20`，和空格一模一样（AlmaLinux 上被吃掉过）。
 *
 * 2. **收尾要把结束传下去**：远端 rsync 退出后，桥必须让客户端看到 EOF 并自己退出，
 *    否则 rsync 等它的 rsh 子进程、子进程等 rsync 关 stdin —— 双方互等，
 *    表现为「文件已经传完、远端 rc=0，但客户端永远不退出」。
 *    → 标记（`__BASTION_RSYNC_DONE_<rc>__`）就是收尾信号：见到它就不再转发、
 *      关掉写方向，并让 shim 进程退出。
 */

/** rsync 二进制握手：协议号（1 字节）+ 三个 0。协议号大致落在 29..34。 */
const GREETING_MIN = 0x1c
const GREETING_MAX = 0x22

/** 收尾标记前缀；后面跟远端 rsync 的退出码 */
export const RSYNC_DONE_MARK = '__BASTION_RSYNC_DONE_'

/**
 * 「pty 已经是 raw 了」的握手标记，由远端 shell 打印。
 *
 * 为什么需要它（实测踩到）：注入的那一行是
 *   `stty raw -echo -iexten; PS1=; rsync --server ...`
 * —— **在 `stty raw` 真正生效之前**，pty 还是 cooked 模式（会做 ICRNL 翻译、会把
 * `0x03/0x04/0x1a` 当信号、按行缓冲）。而客户端的第一批协议字节可能正好在这个窗口里到达，
 * 那批字节就会被当成"下一行输入"搅在一起，协议从此对不上 —— 现象是
 * **远端一个字节都不再吐，界面永远卡住**。
 * 所以：先让远端把 raw 打开并打印这个标记，**看到标记之后才放客户端的字节过去**。
 */
export const RSYNC_RAW_MARK = '__BASTION_RSYNC_RAW__'

/** 远端是否已经报告「pty 已 raw」 */
export function seenRawMark(text: string): boolean {
  return text.includes(RSYNC_RAW_MARK)
}

/**
 * 把「协议开始之前」的终端噪声丢掉：扫描到 rsync 的二进制握手开头，从那儿开始放行。
 *
 * 这条规则是实测定的，不是猜的：
 *  - Ubuntu 3.2.7（协议 31）与 AlmaLinux 3.4.4（协议 32）噪声都正好 10 字节；
 *  - 一旦找到握手，**后面一个字节都不能动**（改一个字节协议就废了）。
 */
export class RsyncGreetingFilter {
  private done = false
  private buf = Buffer.alloc(0)
  private droppedBytes = 0

  /** 扫太多还没找到就放弃过滤、原样放行（宁可让 rsync 自己报错，也别把数据吞了） */
  static readonly SCAN_LIMIT = 4096

  get dropped(): number {
    return this.droppedBytes
  }

  get finished(): boolean {
    return this.done
  }

  feed(data: Buffer): Buffer {
    if (this.done) return data
    this.buf = Buffer.concat([this.buf, data])
    const n = this.buf.length
    let i = 0
    while (i < n) {
      const b = this.buf[i]
      if (b === 0x1b) {
        // 转义序列：CSI 是 ESC [ 参数(0x20..0x3f) 结束字节(0x40..0x7e)。
        // ⚠️ 坑：只在 0x40..0x7e 里找结束字节的话，`[`(0x5b) 自己就"结束"了序列，
        //    于是 `\x1b[?2004l` 会变成留下 `?2004l`，噪声照样进协议。
        let j = i + 1
        if (j < n && this.buf[j] === 0x5b) {
          j++
          while (j < n && this.buf[j] >= 0x20 && this.buf[j] <= 0x3f) j++
        } else {
          while (j < n && !(this.buf[j] >= 0x40 && this.buf[j] <= 0x7e)) j++
        }
        if (j >= n) {
          this.droppedBytes += i
          this.buf = this.buf.subarray(i)
          return Buffer.alloc(0)
        }
        i = j + 1
        continue
      }
      if (b === 0x0d || b === 0x0a) {
        i++
        continue
      }
      if (b >= GREETING_MIN && b <= GREETING_MAX) {
        if (i + 4 > n) break // 还看不出是不是握手，等更多字节
        if (this.buf[i + 1] === 0 && this.buf[i + 2] === 0 && this.buf[i + 3] === 0) {
          this.done = true
          this.droppedBytes += i
          const out = this.buf.subarray(i)
          this.buf = Buffer.alloc(0)
          return out
        }
      }
      if (i > RsyncGreetingFilter.SCAN_LIMIT) {
        this.done = true
        this.droppedBytes += i
        const out = this.buf
        this.buf = Buffer.alloc(0)
        return out
      }
      i++ // 其它字节当噪声跳过，继续找握手
    }
    this.droppedBytes += i
    this.buf = this.buf.subarray(i)
    return Buffer.alloc(0)
  }
}

/**
 * 客户端 I/O 静默超时（秒）。
 *
 * ⚠️ 这是「取消/中断之后远端不再挂着」的关键（验证矩阵逼出来的）：
 * 远端 `rsync --server` 会一直阻塞读 pty，而 pty 是 raw（ISIG 关掉 → tty 层的 Ctrl-C 无效），
 * sshd **也不认**客户端发的 signal 请求（实测：`stream.signal('INT')` 毫无作用）。
 * 于是取消一次传输，整条会话就废了（用户敲什么都没反应）。
 * 加上 `--timeout=N` 之后，远端静默 N 秒就自己退出 → 注入行里的 `stty sane` 才跑得到 → 会话恢复。
 * 顺带也治了「链路卡死一直挂着」。
 */
export const RSYNC_IO_TIMEOUT_SEC = 20

/** 从 rsync 让远端执行的那条命令里取出紧凑选项串，以及**去掉 rsync 之后的原样参数** */
export function parseRsyncServerCmd(line: string): { opts: string; raw: string; args: string } | undefined {
  const raw = line.trim()
  if (!/^rsync\s/.test(raw)) return undefined
  let opts = ''
  for (const tok of raw.split(/\s+/)) {
    if (tok.startsWith('-') && tok !== '--server' && !tok.startsWith('--')) opts = tok
  }
  // 参数原样透传（包含 --timeout=… / --stats 这些长选项）：
  // 这条命令是 rsync 客户端自己生成的，最忠实的做法就是照它说的执行 ——
  // 早期版本我「只取紧凑选项串、丢掉长选项」，等于擅自改了客户端的意图。
  return { opts, raw, args: raw.replace(/^rsync\s+/, '') }
}

/**
 * 注入到远端 shell 的那一行。
 *
 * 顺序很重要：
 *  1. `stty raw -echo -iexten` —— 二进制协议要在 raw 模式、且不能回显，否则 pty 会改写字节；
 *  2. `PS1=` —— 别让提示符混进协议流；
 *  3. **打印 raw 标记** —— 桥看到它才放客户端的字节过去（否则会撞上"还没 raw"的竞态，见 RSYNC_RAW_MARK）；
 *  4. **先试 stderr 落哪个文件** —— `2>/tmp/...` 如果写不了（/tmp 只读、受控 shell），
 *     bash 会在**重定向阶段**就失败退出（退出码 1），`rsync` 根本不跑，现场看起来像"远端一个字节都不吐"；
 *  5. **`mkdir -p` 目标目录** —— 单个文件的同步要求目标目录已存在，否则 rsync 直接退 11
 *     （验证矩阵实测）；顺手把"多级目录不存在"这种情况治好；
 *  6. `timeout 1800` 兜底（有就用）—— 万一扩展进程自己没了（VS Code 被关），远端也不会永远挂着；
 *  7. 跑客户端给的那条 `rsync` 命令（**原样透传**，含 `--timeout` 等长选项）；
 *  8. `stty sane` 把终端恢复原样（会话要留着继续用）；
 *  9. 打印完成标记 —— 桥靠它知道"远端结束了、退出码是多少"。
 *
 * 末尾用 `\r`：pty 在 cooked 模式下 ICRNL 会把它变成换行（这也是为什么必须靠第 3 步确认 raw）。
 */
export function buildRemoteInjectCmd(remoteArgs: string, remoteDir: string): string {
  return (
    'stty raw -echo -iexten 2>/dev/null; ' +
    // ⚠️ PS1 必须**存下来再恢复**：直接 `PS1=` 会改到用户自己那条 shell 的变量（赋值是持久的），
    //    命令跑完提示符就成了空字符串 —— 用户看到的是"终端没退回来"（敲命令有效但没有任何提示符）。
    //    实测就是这么被发现的。
    'OPS1=$PS1; PS1=; ' +
    `echo ${RSYNC_RAW_MARK}; ` +
    `ERR=${REMOTE_ERR_FILE}; : >"$ERR" 2>/dev/null || ERR=$HOME/${REMOTE_ERR_FALLBACK_NAME}; ` +
    `mkdir -p "${remoteDir}" 2>>"$ERR"; ` +
    'T=; command -v timeout >/dev/null 2>&1 && T="timeout 1800"; ' +
    `$T rsync ${remoteArgs} 2>>"$ERR"; rc=$?; ` +
    'stty sane 2>/dev/null; ' +
    'PS1=$OPS1; unset OPS1; ' +
    `echo ${RSYNC_DONE_MARK}\${rc}__\r`
  )
}

/** 远端 rsync 的 stderr 落到哪儿（先试这个，写不了退到 $HOME 下的同名文件） */
export const REMOTE_ERR_FILE = '/tmp/bastion-rsync-err.txt'
export const REMOTE_ERR_FALLBACK_NAME = '.bastion-rsync-err.txt'

/** 从桥收到的数据里解析远端 rsync 的退出码（没见过标记就返回 undefined） */
export function parseDoneMark(text: string): number | undefined {
  const m = text.match(new RegExp(`${RSYNC_DONE_MARK}(\\d+)__`))
  return m ? Number(m[1]) : undefined
}

/**
 * 远端 rsync 的退出码 → 能给用户照着做的说明。
 *
 * 实测（2026-09-11 用户实机）：目标机没装 rsync 时，注入的那行会拿到 **127**，
 * 而客户端只会报一句 `connection unexpectedly closed (0 bytes received so far)` ——
 * 光看那句根本猜不到是"目标机没装 rsync"。所以这里把码翻译成人话。
 */
export function describeRemoteRc(rc: number): string | undefined {
  switch (rc) {
    case 127:
      return (
        '目标机上没有 rsync（command not found）。装上就行：Debian/Ubuntu `apt-get install -y rsync`，' +
        'CentOS/RHEL `yum install -y rsync`，Alpine `apk add rsync`。' +
        '装不了的话就用普通上传（rz）—— 那条路只要目标机有 lrzsz。'
      )
    case 126:
      return '目标机上的 rsync 没有执行权限（或不是可执行文件）：`ls -l $(command -v rsync)` 看一眼。'
    case 1:
      return (
        '远端 rsync 报了用法/语法错。看一下远端输出（日志里「协议开始前的远端输出」那段，' +
        '或目标机上的 /tmp/bastion-rsync-err.txt）—— 通常是 rsync 太老或目标目录不可用。'
      )
    case 12:
      return '远端 rsync 的协议流断了（多半是它刚起来就退出）—— 看远端输出那段。'
    default:
      return undefined
  }
}

/**
 * 本机 rsync 可执行文件候选（按顺序找第一个存在的）。
 * Windows 默认装在 `%LOCALAPPDATA%\rsync\rsync.exe`（cwRsync 风格），
 * 类 Unix 一般是 /usr/bin/rsync。
 */
export function rsyncCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    const out: string[] = []
    if (local) out.push(`${local}\\rsync\\rsync.exe`)
    out.push('rsync.exe', 'rsync')
    return out
  }
  return ['/usr/bin/rsync', '/usr/local/bin/rsync', 'rsync']
}

/**
 * 本地 rsync 客户端的参数。
 *
 * `host:` 里的 host 是假的 —— 真正的传输走 `-e` 指定的桥，
 * 桥会把 rsync 让远端执行的命令转给堡垒机会话。用假 host 是为了让 rsync
 * 走「远端」那条代码路径（否则它会当成本地拷贝）。
 *
 * ⚠️ **末尾斜杠只给目录加，文件绝不能带**（2026-09-11 用户实机踩到）：
 *    给文件加 `/`（`bundle.tar.gz/`）之后 rsync 会把它当目录去 `change_dir`，
 *    Windows 上直接报
 *      `[sender] change_dir "…/bundle.tar.gz" failed: Invalid argument (22)`
 *    退出码 23。实测对照：带斜杠有错、不带斜杠没有。
 *    目录带 `/` 是有语义的：`dir/` = 把**目录里的内容**同步过去，
 *    `dir` = 把目录本身放到目标目录下。这里选前者（用户选的是"目标目录"）。
 */
export function buildClientArgs(
  shimCmd: string,
  sources: Array<{ path: string; isDir: boolean }>,
  remoteDir: string,
  extra: string[] = []
): string[] {
  const stripTrailing = (p: string): string => p.replace(/[\\/]+$/, '')
  const srcs = sources.map((s) => {
    const clean = stripTrailing(s.path) || s.path
    return s.isDir ? `${clean}/` : clean
  })
  // `--partial` 一直带着：中断/取消/卡住时**目标机上保留已传的部分**，
  // 再点一次同步时 rsync 的差分算法只会补差的那一段（真机上 87MB 卡住的场景就靠它救）。
  return ['-a', '--partial', '--stats', ...extra, '-e', shimCmd, ...srcs, `bastion:${remoteDir}/`]
}

/** 从 `rsync --stats` 的输出里抠出两个人类可读的数字（拿不到就算了） */
export function parseStats(stdout: string): { files?: number; bytes?: number } {
  const files = stdout.match(/Number of regular files transferred:\s*([\d,]+)/)
  const bytes = stdout.match(/Total transferred file size:\s*([\d,]+)/)
  const num = (s: string | undefined): number | undefined =>
    s === undefined ? undefined : Number(s.replace(/,/g, ''))
  return { files: num(files?.[1]), bytes: num(bytes?.[1]) }
}

/**
 * 进度上报所需的「要传多少字节」。
 *
 * 为什么自己算而不用 rsync 的 `--info=progress2`：实测**它的进度行在 stdout 不是终端时会被抑制**
 * （我们的桥就是把客户端 stdout 接成管道的），拿不到。所以用「本地源的总大小」当分母，
 * 用「客户端已经发出去的字节数」当分子 —— 后者桥本来就在数。
 *
 * `isDir` 的目录会递归累加；读不到的项按 0 处理（宁可少报，也不要因此报错）。
 */
export function totalBytesOf(
  sources: Array<{ path: string; isDir: boolean }>,
  stat: (p: string) => { isDir: boolean; size: number; children?: string[] }
): number {
  let total = 0
  const walk = (p: string, depth: number): void => {
    if (depth > 32) return
    let st: { isDir: boolean; size: number; children?: string[] }
    try {
      st = stat(p)
    } catch {
      return
    }
    if (!st.isDir) {
      total += st.size
      return
    }
    for (const c of st.children ?? []) walk(c, depth + 1)
  }
  for (const s of sources) walk(s.path, 0)
  return total
}

/**
 * 进度文案（纯函数，便于测）。
 *
 * 有意**不假装精确**：目录同步时 rsync 只传变化的部分，分母是"源的总大小"、
 * 分子是"客户端实际发出去的字节"，所以百分比只在一个文件时才是准的 ——
 * 那就只在一个文件时报百分比，其余报"已发送 + 速率 + 已用时间"。
 * 这恰好回答了用户最关心的问题："它到底在传吗？"
 */
export function formatProgress(sent: number, total: number, elapsedMs: number, single: boolean): string {
  const secs = Math.max(0.001, elapsedMs / 1000)
  const rate = sent / secs
  const speed = rate >= 1024 * 1024 ? `${(rate / 1024 / 1024).toFixed(1)} MB/s` : `${Math.max(1, Math.round(rate / 1024))} KB/s`
  const done = `${fmtBytesShort(sent)}`
  const pct = single && total > 0 ? ` ${Math.min(99, Math.floor((sent / total) * 100))}%` : ''
  return `${done}${pct} · ${speed} · 已用 ${fmtSecsShort(secs)}`
}

/** 状态栏/日志里用的短格式（不引 status.ts，保持这个模块零依赖） */
export function fmtBytesShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function fmtSecsShort(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '?'
  const sec = Math.round(s)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const rs = sec % 60
  return rs ? `${m}m${rs}s` : `${m}m`
}
