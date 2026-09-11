/**
 * 识别「用户往终端里粘/拖了一个本地文件路径」。
 *
 * 为什么做这个：Electron 版能「把文件拖进窗口就自动 rz 上传」，而 VS Code 的终端
 * 拿到拖拽只会**把路径当文本插进去**（这是 VS Code 的行为，扩展改不了）。
 * 所以我们退一步：盯住用户敲回车的那一刻 —— 如果这一整行是一个**存在的本地文件绝对路径**，
 * 就问一句「要上传这个文件吗」，而不是把它当命令发给远端（那只会得到 command not found）。
 *
 * ⚠️ 只认**绝对路径**（`D:\...`、`\\server\share\...`、`/mnt/c/...`）：
 * 相对路径（`Makefile`、`./deploy.sh`）是远端命令的常见写法，
 * 按本地文件系统去猜会造成误拦截 —— 那比不做这个功能更糟。
 *
 * 纯函数（exists 由调用方注入），见 test/localPath.test.ts。
 */

/** 判断这一行是不是「存在的本地文件绝对路径」；是的话返回它（去掉引号） */
export function detectLocalFilePath(
  line: string,
  exists: (p: string) => 'file' | 'dir' | 'none'
): string | undefined {
  let s = line.trim()
  if (!s) return undefined
  // 去掉成对引号（拖拽/复制路径常带引号）
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  // 先看整行（去掉引号后）是不是一个文件 —— 路径里可能带空格（"D:\\my file.txt"）
  if (isAbsoluteLocalPath(s) && exists(s) === 'file') return s
  // 再看「一行里多个路径」（有些终端拖多个文件会用空格分隔）→ 取第一个能认出来的
  const first = s.split(/\s+/)[0]
  if (first && isAbsoluteLocalPath(first) && exists(first) === 'file') return first
  return undefined
}

/**
 * 是不是「本地绝对路径」的写法。
 * Windows：盘符（`C:\`、`C:/`）或 UNC（`\\host\share`）；
 * WSL/远程开发：`/mnt/<盘>/...`（VS Code 在 WSL 里给的就是这种路径）。
 * 不认裸 `/tmp/x`：那在远端同样常见，认了会误拦截。
 */
export function isAbsoluteLocalPath(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (/^\\\\[^\\]+\\/.test(p)) return true
  if (/^\/mnt\/[a-z]\//i.test(p)) return true
  return false
}

/**
 * 这一行**看起来正在输入一个本机绝对路径**吗（还没回车）。
 *
 * 用来「先扣住不发」：粘贴过来的路径常常不带回车，如果照原样发给远端，
 * 远端会把它当命令执行（`-bash: c:/Users/...: No such file or directory`），
 * 然后我们才弹「要不要上传」—— 用户看到的是**一串莫名其妙的报错 + rz**。
 * 扣住之后，如果下一块输入证明这不是本机文件（不存在），再原样补发出去。
 */
export function looksLikeLocalPathPrefix(line: string): boolean {
  let s = line.trim()
  if (!s) return false
  if (s.startsWith('"') || s.startsWith("'")) s = s.slice(1).trim()
  return isAbsoluteLocalPath(s)
}

/**
 * 这一块输入要不要先扣住不发（等下一块再决定）。
 *
 * 只扣「正在粘一个本机路径」这一种情况：
 *  - 带回车 → 不扣，交给回车那套判断（那儿才是决定上传还是执行的地方）
 *  - 带 Ctrl-C / 方向键 → 不扣，让用户的操作先过去
 */
export function shouldHoldLocalPathInput(data: string, currentLine: string): boolean {
  if (/[\r\n]/.test(data)) return false
  if (/[\x03\x1b]/.test(data)) return false
  return looksLikeLocalPathPrefix(currentLine)
}

// ---------------------------------------------------------------------------
// 「要不要上传？」这个询问框的三个结果
// ---------------------------------------------------------------------------

/** 询问框的两个按钮文案（写成常量，免得文案改了、判断没跟着改） */
export const UPLOAD_PROMPT_UPLOAD = '上传'
export const UPLOAD_PROMPT_RUN = '当命令执行'

export type UploadPromptChoice = 'upload' | 'run' | 'restore'

/**
 * 用户点了什么 → 我们该做什么。
 *
 * **关掉/Esc 一律 `restore`（把这一行放回命令行）**，绝不当成"丢掉"：
 * 那一行是用户敲/粘进来的内容，被我们拦下来询问之后，如果他自己取消了询问，
 * 唯一不能做的就是把它吞掉 —— 他会以为终端吃了他的输入（实测就是这么反馈的）。
 * 也不能默认当成「执行」（那是让"关掉一个弹窗"变成一个写操作）。
 */
export function resolveUploadPromptChoice(picked: string | undefined): UploadPromptChoice {
  if (picked === UPLOAD_PROMPT_UPLOAD) return 'upload'
  if (picked === UPLOAD_PROMPT_RUN) return 'run'
  return 'restore'
}

/** 喂进去一块输入之后，攒行器告诉你的事 */
export interface FedLine {
  /** 这一块输入里**以回车结束**的那一行（这块里没有回车就没有这个字段） */
  line?: string
  /**
   * 这块输入除了那一行之外**还有别的内容**（多行粘贴）。
   *
   * 调用方必须据此放弃「本地路径」判断：多行块的第一行恰好是本机文件路径时，
   * 若当成上传处理，后面几行就整段被丢掉了 —— 那是丢用户的输入，比不识别更糟。
   */
  multiLine: boolean
  /**
   * 这一行是否**从更早的输入块里攒过来**的（即：这块之前已经往远端发过字符）。
   * 用来决定要不要在拦住这一行时先给远端发一个 Ctrl-U 把已发的字符擦掉。
   */
  hadBuffer: boolean
}

/**
 * 跨「按键块」攒出当前这一行。
 *
 * 终端给 `handleInput` 的是**按键流**：手打是一个字符一块，粘贴是一整块，
 * 而一行可能分好几块到达。所以缓冲区必须**每一块都喂** ——
 * 原来只在「这一块里有回车」时才喂，于是「粘一行、再单独按回车」永远攒不出内容，
 * 识别也就永远不触发（功能看着写了，实际只在「路径和回车同一块」时才生效）。
 *
 * 纯逻辑、无 vscode 依赖，见 test/localPath.test.ts。
 */
export class InputLineTracker {
  private buf = ''

  /** 攒行上限：长命令不该无限攒着 */
  static readonly MAX = 512

  feed(data: string): FedLine {
    const firstNl = data.search(/[\r\n]/)
    if (firstNl < 0) {
      const hadBuffer = this.buf.length > 0
      this.push(data)
      return { multiLine: false, hadBuffer }
    }
    const hadBuffer = this.buf.length > 0
    this.push(data.slice(0, firstNl))
    const line = this.buf
    this.buf = ''
    // 吃掉紧跟其后的换行：Windows 上「粘贴一行」常常带 \r\n，那是一次回车而不是两次
    const rest = data.slice(firstNl + 1).replace(/^[\r\n]+/, '')
    if (rest) {
      // 后面的内容里可能还有回车：只把最后一段当作「当前这一行」
      const lastNl = Math.max(rest.lastIndexOf('\r'), rest.lastIndexOf('\n'))
      const tail = lastNl >= 0 ? rest.slice(lastNl + 1) : rest
      // 控制序列（方向键等）/ Ctrl-C 之后的内容不可信，直接放弃这一行
      this.buf = /[\x1b\x03]/.test(rest) ? '' : tail.replace(/[\x00-\x1f\x7f]/g, '').slice(-InputLineTracker.MAX)
    }
    return { line, multiLine: rest !== '', hadBuffer }
  }

  /** 当前这一行攒到哪儿了（还没有回车，所以还没"完成"） */
  get current(): string {
    return this.buf
  }

  /** 可见字符入队、退格去掉一个、控制序列清空这一行 */
  private push(text: string): void {
    for (const ch of text) {
      if (ch === '\x7f' || ch === '\b') {
        this.buf = this.buf.slice(0, -1)
        continue
      }
      if (ch === '\x1b' || ch === '\x03') {
        // 方向键/功能键等控制序列，或者 Ctrl-C：这一行内容已不可信（Ctrl-C 在远端就是把这一行丢掉）
        // → 清空，并且**丢掉同一块里剩下的字符**（它们是这个转义序列的尾巴，比如 `[A`，
        // 留下来只会被当成"用户敲的内容"，反而攒出一串假的行）
        this.buf = ''
        return
      }
      if (ch >= ' ') this.buf = (this.buf + ch).slice(-InputLineTracker.MAX)
    }
  }
}
