/**
 * rsync 增量上传：把本机的一个文件/目录**同步**到目标机（经当前堡垒机会话）。
 *
 * 与 rz 上传的区别：
 *   - rz 是往终端里灌 ZMODEM，目标机**必须装 lrzsz**，不能传目录，大文件也吃力；
 *   - rsync 是块级增量：目标机已装 rsync 就行，传过的内容不会重传，目录能整棵同步。
 *
 * 怎么穿得过堡垒机（这是这条路唯一可行的原因）：
 *   本地 rsync 客户端  --(-e 桥)-->  本机 TCP 环回  -->  堡垒机会话的 shell 通道(pty)
 *   --> 在目标机 shell 里注入 `rsync --server`
 *   也就是：**复用已经认证好、已经选完目标机的那条 shell 会话**，不开新通道。
 *
 * 两条实测得来、必须遵守的规矩（见 rsyncBridge.ts 的注释与
 * shell_tools/bastion-wails/tools/rsync-probe/RESULTS.md）：
 *   1. 协议起点前会有 10 字节终端噪声（`\x1b[?2004l\r\n`）→ 按握手形状找到起点再转发；
 *   2. 远端结束后必须让本地客户端看到 EOF 并让 shim 退出 → 否则双方互等，客户端永不退出。
 */

import * as vscode from 'vscode'
import * as net from 'net'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import { log } from './log'
import { ctx, activeSession } from './state'
import type { BastionTerminal } from './terminal'
import { setSlot, clearSlot, fmtBytes } from './status'
import {
  RsyncGreetingFilter,
  RSYNC_DONE_MARK,
  parseRsyncServerCmd,
  buildRemoteInjectCmd,
  parseDoneMark,
  describeRemoteRc,
  seenRawMark,
  rsyncCandidates,
  buildClientArgs,
  parseStats,
  formatProgress,
  fmtBytesShort,
  totalBytesOf,
  RSYNC_IO_TIMEOUT_SEC,
  REMOTE_ERR_FILE,
  REMOTE_ERR_FALLBACK_NAME
} from './rsyncBridge'

/** 桥的 shim：由本地 rsync 用 `-e` 拉起来，把远端命令转给扩展，并桥接字节流 */
const SHIM_SOURCE = `// BastionShell rsync 桥的 shim（由扩展自动生成，请勿手改）
const net = require('net')
const port = Number(process.argv[2])
// rsync 会这样调：node shim.js <port> <host> rsync --server ...
const cmd = process.argv.slice(4).join(' ')
const sock = net.connect(port, '127.0.0.1')
let done = false
function finish () {
  if (done) return
  done = true
  // 对面结束了：关掉 stdout 让 rsync 读到 EOF，然后**自己退出**。
  // 只关 stdout 不退出的话，rsync 会一直等这个子进程，双方互等（实测踩过）。
  try { process.stdout.end() } catch (e) {}
  process.exit(0)
}
sock.on('connect', () => sock.write(cmd + '\\n'))
sock.on('data', (d) => { if (!done) { try { process.stdout.write(d) } catch (e) { finish() } } })
sock.on('end', finish)
sock.on('close', finish)
sock.on('error', () => process.exit(1))
process.stdin.on('data', (d) => { if (!done) sock.write(d) })
process.stdin.on('end', () => { try { sock.end() } catch (e) {} })
`

/** 本机 rsync 路径：设置优先，其次按候选列表找 */
function findRsync(): string | undefined {
  const configured = vscode.workspace.getConfiguration('bastion').get<string>('rsyncPath', '').trim()
  const candidates = configured ? [configured] : rsyncCandidates(process.platform, process.env)
  for (const c of candidates) {
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c
    } else {
      return c // 交给 PATH 去找（spawn 时 ENOENT 会报错）
    }
  }
  return undefined
}

/** 写 shim；返回它的绝对路径。放在临时目录（不在项目里，也不进 git） */
function writeShim(): string {
  const dir = path.join(os.tmpdir(), 'bastionshell-rsync')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'shim.js')
  fs.writeFileSync(file, SHIM_SOURCE, 'utf8')
  return file
}

/**
 * 拼 `-e` 用的命令。
 *
 * ⚠️ rsync 是按**空格**切分 `-e` 的（实测坑：探针目录路径里有空格时 shim 起不来），
 * 所以路径必须加引号、并把反斜杠换成正斜杠（Windows 上 cwRsync 吃正斜杠更稳）。
 */
function shimCommand(port: number): string {
  const node = process.execPath.replace(/\\/g, '/')
  const shim = writeShim().replace(/\\/g, '/')
  return `"${node}" "${shim}" ${port}`
}

export interface BridgeResult {
  ok: boolean
  /** 本次实际往会话通道里发了多少字节 —— 让用户看见「增量到底省了多少」 */
  sentBytes?: number
  files?: number
  bytes?: number
  remoteRc?: number
  message?: string
}

/** 桥需要的「会话通道」能力（真机上是 BastionTerminal 的独占通道，测试里是 ssh2 的 shell 通道） */
export interface RsyncBridgeChannel {
  acquire(handlers: { onData: (d: Buffer) => void; onClose: () => void }): boolean
  release(): void
  write(data: Buffer): void
  /**
   * 给远端会话发信号（中止时用）。
   * 实测 OpenSSH 不认客户端发的 signal 请求，所以它只是"能发就发"的补充手段；
   * 真正管用的是客户端侧 `--timeout`（见 RSYNC_IO_TIMEOUT_SEC）。
   */
  signal?(name: string): void
}

/**
 * 跑一次 rsync 同步（阻塞到结束）。
 *
 * **导出是为了能在真机之外跑端到端测试**（`test/rsyncE2E.test.ts` + `tools/rsync-e2e/`）：
 * 这段代码在运行期只依赖 `log()` 和 `clearSlot()`（都走 `require('vscode')`，测试里用打桩），
 * 通道能力由调用方注入 —— 所以 headless 测试跑的就是**扩展真正在跑的这一段**，
 * 不是另抄一份。前面那三个只有真机才暴露的 bug（过滤器方向、raw 竞态、文件带斜杠）
 * 都应该被它当场拦下。
 */
export async function runBridge(
  term: RsyncBridgeChannel,
  sources: Array<{ path: string; isDir: boolean }>,
  remoteDir: string,
  rsyncBin: string,
  token: { onCancellationRequested(cb: () => void): void },
  opts: {
    ioTimeoutSec?: number
    onProgress?: (text: string) => void
    /** 卡住时的提示（一段时间里两个方向都没有字节流动） */
    onStall?: (text: string) => void
    totalBytes?: number
  } = {}
): Promise<BridgeResult> {
  const ioTimeoutSec = opts.ioTimeoutSec ?? RSYNC_IO_TIMEOUT_SEC
  /** 是否只有一个源文件（只有这种情况百分比才是准的：目录同步时 rsync 只传变化的部分） */
  const singleSource = sources.length === 1 && !sources[0].isDir
  let c2rBytes = 0
  let r2cBytes = 0
  const startedAt = Date.now()
  let lastProgressAt = 0
  let lastProgressLogAt = 0
  /** 上一次"有字节流动"的时刻与当时的计数（用来判定卡住：两个方向都不动） */
  let lastMoveAt = Date.now()
  let lastMoveBytes = 0
  let stallNoticed = false
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as net.AddressInfo).port
  log(
    `rsync 桥：本地环回端口 ${port}；本机 rsync=${rsyncBin}；源=${sources
      .map((s) => s.path + (s.isDir ? '/' : ''))
      .join('、')}；目标目录=${remoteDir}`
  )

  let client: ChildProcess | undefined
  let socket: net.Socket | undefined
  const filter = new RsyncGreetingFilter()
  let remoteRc: number | undefined
  let protocolDone = false
  let r2cChunks = 0
  let c2rChunks = 0
  let rawReady = false
  const pendingC2R: Buffer[] = []
  /** 协议开始前那段噪声的可读文本（远端 shell 的报错都在里面） */
  let noiseText = ''
  let stdout = ''
  let stderr = ''
  let released = false
  let firstByteAt = 0
  /**
   * 这条通道是不是**我们**占上的。
   *
   * ⚠️ 这个标志是验证矩阵逼出来的一个真 bug：手里的通道已经被别的传输占用时，
   * `acquire()` 会返回 false，而原来的收尾**照样**调了 `term.release()` ——
   * 那等于把**别人正在用的通道**给放了（正在进行的那次传输立刻断掉，界面卡死）。
   * 所以：占上了才还；没占上就只清自己的东西（TCP 环回、子进程、槽位）。
   */
  let ownsChannel = false

  const release = (): void => {
    if (released) return
    released = true
    if (ownsChannel) {
      term.release()
      ownsChannel = false
    }
    try {
      socket?.destroy()
    } catch {
      /* ignore */
    }
    try {
      server.close()
    } catch {
      /* ignore */
    }
    try {
      if (client && client.exitCode === null) client.kill()
    } catch {
      /* ignore */
    }
    clearSlot('transfer')
  }

  const finished = new Promise<BridgeResult>((resolve) => {
    let settled = false
    const timers: NodeJS.Timeout[] = []
    const done = (r: BridgeResult): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      // 结束时把「协议开始前的噪声文本」打出来 —— 远端 shell 的报错都在这里面
      if (noiseText.trim()) {
        log(`rsync 桥：协议开始前的远端输出（${noiseText.length} 字符，已去掉不可打印字符）：\n${noiseText.trimEnd()}`)
      }
      // 失败/取消时给远端补一枪信号（能发就发）：
      // 光杀本机客户端，远端那个 `rsync --server` 会继续阻塞读 pty，会话会看起来"冻住"。
      // 真正收场靠客户端侧的 --timeout（见 RSYNC_IO_TIMEOUT_SEC），这只是让支持它的服务端更快一点。
      if (!r.ok && ownsChannel) {
        try {
          term.signal?.('INT')
        } catch {
          /* ignore */
        }
        // 中止后不额外"排空"：实测这样会让取消路径变得不稳（E2E 里开始挂住）。
        // 代价是远端残余的协议输出可能刷一小段到终端 —— 比不稳定好，接受。
      }
      release()
      resolve(r)
    }

    // 会话被占用 / 没就绪：直接说清，别静默失败
    const acquired = term.acquire({
      onData: (data: Buffer) => {
        if (!firstByteAt) firstByteAt = Date.now()
        if (protocolDone) return
        r2cBytes += data.length
        lastMoveAt = Date.now()
        // 诊断：把「通道 → 客户端」这一侧的头几块原样记进日志。
        // 这一路出问题时（噪声没滤干净 / 远端没起来）只有字节能说明问题，
        // 光看 rsync 的报错是猜（这次就是靠它定位的）。
        if (r2cChunks < 4) {
          r2cChunks++
          log(
            `rsync 桥 R2C#${r2cChunks} 原始 ${data.length} 字节: ` +
              data.subarray(0, 120).toString('hex') +
              (data.length > 120 ? '…' : '')
          )
        }
        const asText = data.toString('latin1')
        // 诊断用：把「协议开始之前」的噪声也留一份可读文本。
        // 远端 shell 的报错（命令找不到、重定向失败、rsync 用法错）全在这段里，
        // 而它们会被过滤器按设计丢掉 —— 不额外留一份就永远看不到。
        // （这次就是吃了这个亏：只记了前 4 块 R2C，真相在被丢弃的 279 字节里。）
        if (!filter.finished && noiseText.length < 600) {
          noiseText += asText.replace(/[^\x20-\x7e\r\n\t]/g, '')
        }
        // 远端确认「pty 已经是 raw」之后，才把先前扣住的客户端字节放过去
        if (!rawReady && seenRawMark(asText)) {
          rawReady = true
          log(`rsync 桥：远端已确认 raw，放行先前扣住的 ${pendingC2R.length} 块客户端数据`)
          for (const b of pendingC2R.splice(0)) term.write(b)
        }
        const rc = parseDoneMark(asText)
        if (rc !== undefined) {
          protocolDone = true
          remoteRc = rc
          log(`rsync 桥：远端完成标记 rc=${rc}；过滤器丢弃了 ${filter.dropped} 字节前导噪声`)
          // 见到完成标记：① 停止转发 ② 关掉写方向（shim 收到 EOF 就退出 → 本地客户端才能退出）
          // ③ **立刻把通道还给终端** —— 标记之后紧跟的是 shell 的提示符输出，
          //    还握着通道的话那段输出会被桥吃掉，用户就看到终端"没有提示符"了。
          try {
            socket?.end()
          } catch {
            /* ignore */
          }
          if (ownsChannel) {
            term.release()
            ownsChannel = false
          }
          return
        }
        const out = filter.feed(data)
        if (out.length > 0 && socket && !socket.destroyed) {
          socket.write(out)
        }
      },
      onClose: () => done({ ok: false, message: '会话在同步过程中断开了' })
    })
    if (!acquired) {
      // 注意：这里**不能**把通道还回去 —— 它不是我们的（见 ownsChannel 的注释）
      done({
        ok: false,
        message:
          '当前会话正忙（上次同步还在收场，或者这条会话被别的东西占着）。' +
          '等几秒再点一次即可 —— 已经传过去的部分会保留在目标机上，重跑不会从头再来。'
      })
      return
    }
    ownsChannel = true

    server.on('connection', (s) => {
      socket = s
      // 两种形态的数据：先是「客户端请远端执行什么命令」这一行文本，之后全是二进制协议。
      // 必须严格分开 —— 把那一行转发进通道会污染协议（它是请求，不是协议数据）。
      let head = ''
      let headDone = false
      s.on('data', (d) => {
        if (headDone) {
          // ⚠️ 客户端方向（客户端 → 通道）：**原样转发，绝不能过过滤器**。
          //    客户端发来的第一批字节就是它自己的协议版本握手（`1f/20 00 00 00`），
          //    和"远端握手"长得一模一样；喂给过滤器会把过滤状态提前置成"已找到握手"，
          //    于是远端那份带着回显噪声的数据就不再生效 —— 实测就是这么炸的。
          //    过滤器是**单向**的：只管「通道 → 客户端」那一侧。
          if (d.length === 0) return
          // 进度：客户端发出去多少字节，就是"已传多少"。
          // 用户实测就是因为看不到任何进度，以为卡死了、把一次 91MB 的传输取消了
          // ——（其实它一直在传）。所以这里必须报出去。
          c2rBytes += d.length
          const now = Date.now()
          if (now - lastProgressAt >= 500) {
            lastProgressAt = now
            const text = formatProgress(c2rBytes, opts.totalBytes ?? 0, now - startedAt, singleSource)
            opts.onProgress?.(text)
            if (now - lastProgressLogAt >= 3000) {
              lastProgressLogAt = now
              // 把**两个方向**都记上：真机上就是这么定位到"对端停止消费"的
              // （客户端发到 87MB 就不动了，远端也不再回数据 → 堵在缓冲里）
              log(`rsync 桥：已发送 ${text}；远端回了 ${fmtBytesShort(r2cBytes)}`)
            }
          }
          if (c2rChunks < 4) {
            c2rChunks++
            log(`rsync 桥 C2R#${c2rChunks} 原始 ${d.length} 字节: ${d.subarray(0, 80).toString('hex')}`)
          }
          // 远端还没确认 raw 之前先扣住：那时候 pty 还是 cooked，
          // 二进制字节会被当输入行搅乱（实测现象：远端从此一个字节都不吐，界面卡死）。
          if (!rawReady) {
            pendingC2R.push(d)
            log(`rsync 桥：远端还没确认 raw，先扣住客户端 ${d.length} 字节`)
            return
          }
          term.write(d)
          return
        }
        head += d.toString('latin1')
        const nl = head.indexOf('\n')
        if (nl < 0) return
        headDone = true
        const line = head.slice(0, nl)
        const rest = Buffer.from(head.slice(nl + 1), 'latin1')
        const parsed = parseRsyncServerCmd(line)
        if (!parsed) {
          log(`rsync 桥：收到的远端命令看不懂：${line}`)
          s.destroy()
          return
        }
        log(`rsync 桥：客户端请求远端执行 ${parsed.raw}`)
        if (!firstByteAt) firstByteAt = Date.now()
        // 往会话里注入（raw/无回显/raw 标记/mkdir/timeout/完成标记，见 rsyncBridge）。
        // 参数用客户端给的那份**原样** —— 它是 rsync 自己生成的，改了就可能跟客户端对不上。
        const injectLine = buildRemoteInjectCmd(parsed.args, remoteDir)
        log(`rsync 桥：实际注入远端的是：${injectLine.replace(/\r$/, '')}`)
        term.write(Buffer.from(injectLine, 'utf8'))
        // 命令之后紧跟的客户端字节同样先扣住（等 raw 确认）
        if (rest.length > 0) {
          pendingC2R.push(rest)
          log(`rsync 桥：远端还没确认 raw，先扣住客户端 ${rest.length} 字节`)
        }
      })
      s.on('error', () => {
        /* 客户端被杀等，交给退出码处理 */
      })
    })

    // 本地 rsync 客户端
    const args = buildClientArgs(shimCommand(port), sources, remoteDir, [`--timeout=${ioTimeoutSec}`])
    log(`rsync 桥：启动本机客户端 ${rsyncBin} ${args.join(' ')}`)
    try {
      client = spawn(rsyncBin, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true
      })
    } catch (e) {
      done({ ok: false, message: `起不了本机 rsync：${(e as Error).message}` })
      return
    }
    client.on('error', (e) => {
      const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `找不到本机 rsync（${rsyncBin}）。装一个 rsync，或用 bastion.rsyncPath 指定路径`
        : `本机 rsync 启动失败：${e.message}`
      done({ ok: false, message: msg })
    })
    client.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    client.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      stderr += s
      log(`rsync: ${s.trimEnd()}`)
    })
    client.on('exit', (code) => {
      const stats = parseStats(stdout)
      if (code === 0) {
        done({ ok: true, files: stats.files, bytes: stats.bytes, remoteRc, sentBytes: c2rBytes })
        return
      }
      const tail = stderr.trim().split('\n').slice(-3).join(' / ')
      const remote = remoteRc === undefined ? '' : `；远端 rsync 退出码 ${remoteRc}`
      // 远端退出码能直接翻译成人话（127 = 目标机没装 rsync 这种），
      // 否则用户只能看到「connection unexpectedly closed」这种猜不出原因的句子。
      const hint = remoteRc === undefined ? undefined : describeRemoteRc(remoteRc)
      done({
        ok: false,
        files: stats.files,
        bytes: stats.bytes,
        remoteRc,
        sentBytes: c2rBytes,
        message: `本机 rsync 退出码 ${code}${remote}${tail ? `：${tail}` : ''}${hint ? `\n\n${hint}` : ''}`
      })
    })

    // 看门狗。
    //
    // ⚠️ 这里踩过一次：原来判的是「有没有收到**任何**字节」，而远端回显注入命令也算字节，
    //    于是条件永远不成立 —— 出问题时界面**一直卡着不报错**，只能干等到 10 分钟。
    //    现在判的是「**协议有没有真正开始**」（过滤器是否找到了远端握手），这才是关键信号。
    timers.push(
      setTimeout(() => {
        if (protocolDone) return
        if (!filter.finished) {
          const extra = rawReady
            ? '远端已把 pty 切成 raw，但之后再没吐任何协议数据'
            : '远端一直没确认 pty 已 raw（注入的那行命令可能没生效）'
          done({
            ok: false,
            message:
              `等了 20 秒协议都没开始。${extra}。` +
              '常见原因：目标机没装 rsync（不在 PATH）、会话当时不在 shell 提示符上（比如停在 vim/菜单里）。' +
              '可以到目标机看 /tmp/bastion-rsync-err.txt，或看日志里 C2R/R2C 的 hex。'
          })
        }
      }, 20000)
    )
    timers.push(setTimeout(() => done({ ok: false, message: '同步超过 10 分钟还没结束，已中止' }), 10 * 60 * 1000))
    token.onCancellationRequested(() => done({ ok: false, message: '已取消' }))

    // 卡住检测：**两个方向**都长时间没有字节流动才算卡住（只有客户端不动、远端还在回话是正常的收尾）。
    // 真机第一次出现时（87MB / 95% 卡住 2 分 40 秒）没有这个提示，只能靠人猜；
    // 现在会明确说出来，并把两个方向的计数写进日志。
    const stallTimer = setInterval(() => {
      if (protocolDone) return
      const moved = c2rBytes + r2cBytes
      if (moved > lastMoveBytes) {
        lastMoveBytes = moved
        lastMoveAt = Date.now()
        stallNoticed = false
        return
      }
      const idleSec = Math.round((Date.now() - lastMoveAt) / 1000)
      if (idleSec >= 30 && !stallNoticed) {
        stallNoticed = true
        const left = opts.totalBytes && opts.totalBytes > c2rBytes ? fmtBytesShort(opts.totalBytes - c2rBytes) : '未知量'
        const text =
          `已经 ${idleSec} 秒没有任何字节流动了（已发送 ${fmtBytesShort(c2rBytes)}，还差 ${left}；` +
          `远端也没有再回数据）。这通常是**链路/堡垒机侧在缓冲或限速**，不是本地卡死。\n\n` +
          '**目标机上已传的部分会保留**（用了 `--partial`）：直接**再点一次同步**就会接着传 —— ' +
          'rsync 会算出已传部分里相同的块，只补差的那一段，不用从头再来。\n\n' +
          '如果反复卡在同一个位置，说明这条通道不适合传这么大的单个文件，可以改用普通上传（rz）。'
        log(`rsync 桥：${idleSec}s 无进展 —— 已发送 ${c2rBytes} 字节，远端回了 ${r2cBytes} 字节`)
        opts.onStall?.(text)
      }
    }, 3000)
    timers.push(stallTimer as unknown as NodeJS.Timeout)
  })

  return finished
}

/**
 * 命令入口：对资源管理器里选中的文件/目录做 rsync 增量同步。
 * 只传 `uri`（右键单个）或 `uris`（多选，多个就是批量同步到同一个目标目录）。
 */
export async function rsyncSyncToSession(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const picked = (uris && uris.length > 0 ? uris : uri ? [uri] : []).filter((u) => u.scheme === 'file')
  if (picked.length === 0) {
    void vscode.window.showWarningMessage('请先在资源管理器里选中要同步的文件或目录')
    return
  }
  const session = activeSession()
  if (!session) {
    void vscode.window.showWarningMessage('还没有堡垒机会话 —— 先连一个，再同步')
    return
  }
  const rsyncBin = findRsync()
  if (!rsyncBin) {
    void vscode.window.showErrorMessage(
      '找不到本机 rsync。Windows 上默认找 %LOCALAPPDATA%\\rsync\\rsync.exe；' +
        '也可以装一个或用设置 bastion.rsyncPath 指定。'
    )
    return
  }

  // 收窄后的类型要带进下面的闭包（TS 不会把 const 的收窄带进嵌套函数，所以取一份 const）
  const rsyncBinPath: string = rsyncBin
  const lastDir = ctx.globalState.get<string>('rsync.lastRemoteDir', '.')
  const remoteDir = await vscode.window.showInputBox({
    title: 'rsync 增量同步到目标机的哪个目录？',
    prompt: '只填目录。`.` 表示目标机当前目录（会话停在哪个目录就传到哪）',
    value: lastDir,
    ignoreFocusOut: true
  })
  if (remoteDir === undefined) return
  const dir = remoteDir.trim() || '.'
  await ctx.globalState.update('rsync.lastRemoteDir', dir)

  // 目录 / 文件要分开：**文件绝不能带末尾斜杠**（实测：会报 change_dir Invalid argument (22)），
  // 目录带斜杠表示"把目录里的内容同步过去"。多选时全部一起给 rsync。
  const sources: Array<{ path: string; isDir: boolean }> = []
  for (const u of picked) {
    let isDir = false
    try {
      isDir = fs.statSync(u.fsPath).isDirectory()
    } catch (e) {
      log(`rsync 同步：读不了 ${u.fsPath}（${(e as Error).message}）—— 跳过`)
      continue
    }
    sources.push({ path: u.fsPath, isDir })
  }
  if (sources.length === 0) {
    void vscode.window.showWarningMessage('选中的路径都读不了，已中止')
    return
  }

  const term = session.term
  const names = sources.map((s) => path.basename(s.path)).join('、')
  log(`rsync 同步：${names} → ${dir}（会话 ${session.vt.name}）`)

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `rsync 同步：${names}`, cancellable: true },
    async (progress, token) => {
      setSlot('transfer', { text: `$(sync~spin) rsync ${names}`, tooltip: `正在同步到 ${dir}` })
      // 把会话的独占通道包装成桥需要的接口（测试里换成 ssh2 的 shell 通道，跑的是同一段桥代码）
      const channel: RsyncBridgeChannel = {
        acquire: (h) => term.acquireRawBridge(h),
        release: () => term.releaseRawBridge(),
        write: (d) => term.writeRawBridge(d),
        signal: (name) => term.signalRemote(name)
      }
      // 总大小：单文件时百分比才准（目录同步 rsync 只传变化的部分，分母会偏大）
      const total = totalBytesOf(sources, (p) => {
        const st = fs.statSync(p)
        return st.isDirectory()
          ? { isDir: true, size: 0, children: fs.readdirSync(p).map((n) => path.join(p, n)) }
          : { isDir: false, size: st.size }
      })

      // 最多两轮：卡住时用户可以选「断开并续传」——因为带着 --partial，第二轮只补差的那一段。
      // 这样就不需要用户自己记着"再点一次"，也不会撞上"上一次还在收场"。
      let result = await oneAttempt()
      if (result.retry) {
        log('rsync 桥：按用户选择断开并续传（上一轮已传的部分会保留）')
        setSlot('transfer', { text: `$(sync~spin) rsync 续传 ${names}`, tooltip: `接着上次继续（只补差）` })
        result = await oneAttempt()
      }

      async function oneAttempt(): Promise<BridgeResult & { retry?: boolean }> {
        const cts = new vscode.CancellationTokenSource()
        token.onCancellationRequested(() => cts.cancel())
        let wantRetry = false
        const r = await runBridge(channel, sources, dir, rsyncBinPath, cts.token, {
          totalBytes: total,
          onStall: (text) => {
            void vscode.window.showWarningMessage(text, '断开并续传', '继续等').then((pick) => {
              if (pick === '断开并续传') {
                wantRetry = true
                cts.cancel()
              }
            })
          },
          onProgress: (text) => {
            // 状态栏 + 通知里都显示 —— 用户实测就是因为看不到进度，把一次 91MB 的传输取消了
            setSlot('transfer', { text: `$(sync~spin) rsync ${text}`, tooltip: `正在同步到 ${dir}｜${names}` })
            progress.report({ message: text })
          }
        })
        cts.dispose()
        return { ...r, retry: wantRetry && !r.ok }
      }
      if (result.ok) {
        const size = result.bytes !== undefined ? fmtBytes(result.bytes) : '未知大小'
        const n = result.files
        // 「0 个文件」不是没干活：rsync 按**大小 + 修改时间**判定"目标机已有相同的文件"。
        // 以前这里只写「0 个文件 / 0 B」，用户实测看到就以为没同步（其实这正是增量的意义）。
        const what =
          n === 0
            ? '没有需要传的内容：目标机已有同名且大小/时间一致的文件（这是 rsync 的增量判定，不是失败）'
            : `rsync 同步完成：${n ?? '?'} 个文件、${size}`
        // 「本次实际发了多少」直接摆出来：这样一眼就能看出 tar.gz（每次全量）和目录同步（只补差）的差别
        const sent = result.sentBytes !== undefined ? `｜本次实际发送 ${fmtBytesShort(result.sentBytes)}` : ''
        log(`${what}${sent} → ${dir}`)
        void vscode.window.showInformationMessage(
          `${what}${sent} → ${dir}\n（会话保持不动 —— rsync 跑在你当前这条会话里，不会把它关掉）`
        )
      } else {
        log(`rsync 同步失败：${result.message ?? '未知原因'}`)
        void vscode.window.showErrorMessage(`rsync 同步失败：${result.message ?? '未知原因'}`)
        // 远端 rsync 的 stderr 落在目标机的 /tmp 里（我们注入的那一行就是这么写的）。
        // **直接 cat 到终端** —— 否则用户得自己登到目标机去翻文件，而这段报错往往正是
        // 唯一的线索（比如"未知选项"、"目标目录不存在"）。
        // 只在远端确认过收尾标记时这么做：那时才确定 shell 已经回到提示符。
        if (result.remoteRc !== undefined) {
          const hint = describeRemoteRc(result.remoteRc)
          if (hint) {
            // rc 已经能说明问题（比如 127 = 目标机没装 rsync）—— 直接说结论。
            // 这时候 /tmp 里那个 stderr 文件是空的（命令根本没跑），
            // 再 cat 一遍只会让用户以为"没报错"。
            term.sendRaw(`echo "[BastionShell] ${hint.replace(/`/g, '')}"\r`)
          } else {
            log('rsync 桥：把远端 rsync 的 stderr 打到终端里给用户看')
            term.sendRaw('echo "[BastionShell] 远端 rsync 的报错："\r')
            // 两个候选位置都试（注入行里探测过：/tmp 写不了会退到 $HOME）
            term.sendRaw(`cat ${REMOTE_ERR_FILE} ~/${REMOTE_ERR_FALLBACK_NAME} 2>/dev/null\r`)
            term.sendRaw('echo "[BastionShell] （以上是远端报错，结束）"\r')
          }
        }
      }
    }
  )
}
