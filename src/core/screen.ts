/**
 * 终端文本的纯函数（不依赖 vscode，也不依赖 ssh2）。
 *
 * 为什么单独一个文件：这些是**两个宿主都要用**的东西 ——
 * VS Code 扩展（`terminal.ts`）和 CLI 引擎（`engine/session.ts`）。
 * 2026-11-23 从 terminal.ts 里原样搬出来，terminal 改为 re-export，行为零变化。
 *
 * 搬家的原因不是"好看"：CLI 若要重写一遍 `readMarkerLine`/`stripAnsi`，
 * 就会出现第二份判定语义 —— 而 `sleep 10` 被静默误判这种 bug，我们已经为"两份实现"付过一次学费。
 */

/** 能安全挂哨兵的命令：单行、非交互、非后台、不 exec 换 shell */
export function isMarkerSafe(command: string, allowPlainSudo = false): boolean {
  const c = command.trim()
  if (!c) return false
  if (/^(sudo|su)(\s|$)/.test(c)) {
    if (!allowPlainSudo) return false
    if (!/^sudo\s+/.test(c)) return false // su 一律不加
    // 保守起见：只要出现 -i / -s / --login / --shell 就当交互式 shell 处理
    // （哪怕像 `sudo grep -i` 这样被误判，也只是退回静止判定，不会出错）
    if (/(^|\s)(-i|-s|--login|--shell)(\s|$)/.test(c)) return false
  }
  if (/&\s*$/.test(c)) return false
  if (/(^|[;&|]\s*)exec(\s|$)/.test(c)) return false
  return true
}

/** 清掉 ANSI 转义序列（颜色、光标、标题等），只留可见文本。ZMODEM 控制序列不在这里处理 */
export function stripAnsi(s: string): string {
  if (!s) return ''
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][A-Za-z0-9]/g, '') // 字符集切换
    .replace(/\x1b[=>78]/g, '') // 其他单字符转义
}

/**
 * 把终端原始输出整理成人类/AI 可读的纯文本：
 * 去掉 ANSI、按 \r 覆盖只保留最后一段（进度条）、去掉尾部空行，最后取末 maxLines 行。
 */
export function tailText(raw: string, maxLines = 80): string {
  if (!raw) return ''
  const clean = stripAnsi(raw)
  const lines: string[] = []
  for (const line of clean.split('\n')) {
    // \r 覆盖：同一行被反复重写的进度条只保留最后一段
    const segs = line.split('\r').filter((s) => s.length > 0)
    lines.push((segs.length ? segs[segs.length - 1] : '').replace(/\s+$/, ''))
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-Math.max(1, maxLines)).join('\n')
}

/**
 * 读取起点：标记落在缓冲区里的位置。如果它正好把一个 ANSI 转义序列切成两半，
 * 就退回到那个 `\x1b` 再开始读。
 *
 * 为什么非要有这个函数：切出来的后半段开头会粘着 `2m` 这种残渣，
 * 而 `^\s*opt>`、`^\s*id>` 这类**行首锚定**的规则就再也匹配不上了 ——
 * 这正是之前「菜单明明在屏幕上、日志里也看得见，就是认不出来」的元凶。
 */
export function safeReadStart(buf: string, len: number): number {
  if (len <= 0 || len > buf.length) return 0
  const from = Math.max(0, len - 32)
  const esc = buf.lastIndexOf('\x1b', len - 1)
  if (esc < from) return len
  const body = buf.slice(esc + 1, len).replace(/^[\[\]()#%]/, '')
  return /[\x40-\x7e]/.test(body) ? len : esc
}

/** 检测哨兵是否作为「独立输出行」出现（区别于命令回显里 `; echo __MARKER__` 的 token） */
export function hasMarkerLine(s: string, marker: string): boolean {
  return readMarkerLine(s, marker).seen
}

/**
 * 在输出里找哨兵，并把它带的**退出码**读出来（`<marker>:<rc>`）。
 *
 * **不要求行首**：真机上哨兵那行前面常残留 ANSI 或提示符刷新（`\x1b[K__BASTION…`），
 * 用"整行 equals/startsWith"会漏判 —— 表现就是"命令明明跑完了却报退出码未知"。
 * 回显里的 `echo <marker>:$ec` 是**字面量**（`$ec` 没展开成数字），
 * 所以 `marker:(数字)` 不会把命令回显误当成完成。
 */
export function readMarkerLine(s: string, marker: string): { seen: boolean; rc?: number } {
  if (!marker) return { seen: false }
  const idx = s.lastIndexOf(marker + ':')
  if (idx < 0) return { seen: false }
  const rest = s.slice(idx + marker.length + 1)
  const m = /^(\d+)/.exec(rest)
  // 必须带数字才算：回显里的 `echo MARKER:` 是字面量，没有数字 → 不能当完成
  if (!m) return { seen: false }
  return { seen: true, rc: Number.parseInt(m[1], 10) }
}

/** 从返回给 AI 的输出里剔除哨兵相关行（命令回显行 + 哨兵输出行） */
export function stripMarker(s: string, marker: string): string {
  if (!marker) return s
  return s
    .split(/\r?\n/)
    .filter((line) => !line.includes(marker))
    .join('\n')
}
