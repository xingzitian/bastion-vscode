// rsync 桥的纯逻辑：把那一轮的实测结论固化成断言。
//
// 这组测试的价值在于：它把「协议起点被终端噪声污染」「按值猜噪声会踩坑」这两条
// 从"当年的一条说法"变成**改坏了就会红**的东西。全部数据来自真机实测
// （见 shell_tools/bastion-wails/tools/rsync-probe/RESULTS.md）。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RsyncGreetingFilter,
  RSYNC_DONE_MARK,
  RSYNC_RAW_MARK,
  REMOTE_ERR_FILE,
  REMOTE_ERR_FALLBACK_NAME,
  seenRawMark,
  parseRsyncServerCmd,
  buildRemoteInjectCmd,
  parseDoneMark,
  describeRemoteRc,
  rsyncCandidates,
  buildClientArgs,
  parseStats,
  formatProgress,
  totalBytesOf
} from '../rsyncBridge'

/** 实测噪声：bash/readline 关掉括号粘贴模式时吐的 10 字节 */
const NOISE = Buffer.from('\x1b[?2004l\r\n', 'latin1')

/** 造一个 rsync 握手开头：协议号 + 三个 0 */
const greeting = (proto: number): Buffer => Buffer.from([proto, 0, 0, 0])

test('噪声：实测的 10 字节终端噪声要正好被丢掉，协议一个字节都不能少', () => {
  for (const proto of [31, 32]) {
    const f = new RsyncGreetingFilter()
    const wire = Buffer.concat([NOISE, greeting(proto), Buffer.from([0x81, 0xff, 0x11])])
    const out = f.feed(wire)
    assert.equal(f.dropped, NOISE.length, `协议 ${proto}：噪声长度应当就是 10`)
    assert.deepEqual([...out], [...Buffer.concat([greeting(proto), Buffer.from([0x81, 0xff, 0x11])])])
  }
})

test('⚠️ 协议号 32 是 0x20，和空格一模一样 —— 绝不能当空白丢掉', () => {
  const f = new RsyncGreetingFilter()
  const out = f.feed(Buffer.concat([NOISE, greeting(32)]))
  assert.equal(out[0], 0x20, '0x20 必须留下来（它就是协议号）')
  assert.equal(out.length, 4)
})

test('⚠️ CSI 的 `[`(0x5b) 不能当成转义序列的结束字节', () => {
  const f = new RsyncGreetingFilter()
  const out = f.feed(Buffer.concat([NOISE, greeting(31)]))
  // 如果 `[` 被当成结束字节，剩下的 `?2004l` 就会留在流里 → rsync 读到垃圾
  assert.equal(f.dropped, 10)
  assert.equal(out[0], 31)
})

test('噪声分块到达（pty 经常一块一块给）：状态要跨块保持', () => {
  const f = new RsyncGreetingFilter()
  const wire = Buffer.concat([NOISE, greeting(31), Buffer.from([0x81, 0xff])])
  let out = Buffer.alloc(0)
  for (const byte of wire) out = Buffer.concat([out, f.feed(Buffer.from([byte]))])
  assert.equal(f.dropped, 10)
  assert.deepEqual([...out], [...Buffer.concat([greeting(31), Buffer.from([0x81, 0xff])])])
})

test('握手还没收全时不能先放行半个（要等够 4 字节再判）', () => {
  const f = new RsyncGreetingFilter()
  assert.equal(f.feed(Buffer.concat([NOISE, Buffer.from([31, 0])])).length, 0, '只到 2 字节，还不能放行')
  const out = f.feed(Buffer.from([0, 0, 0xaa]))
  assert.deepEqual([...out], [31, 0, 0, 0, 0xaa], '凑够握手后一次放行，后面原样带出')
})

test('干净流（没有噪声）原样通过：不能因为过滤把好数据改坏', () => {
  const f = new RsyncGreetingFilter()
  const wire = Buffer.concat([greeting(31), Buffer.from([1, 2, 3, 4])])
  const out = f.feed(wire)
  assert.equal(f.dropped, 0)
  assert.deepEqual([...out], [...wire])
})

test('握手之后不再过滤：协议中间出现 0x1b/0x0d 也一个字节都不许动', () => {
  const f = new RsyncGreetingFilter()
  f.feed(Buffer.concat([NOISE, greeting(31)]))
  const payload = Buffer.from([0x1b, 0x0d, 0x0a, 0x20, 0xff])
  assert.deepEqual([...f.feed(payload)], [...payload])
})

test('扫太久还没找到握手：放弃过滤、原样放行（宁可让 rsync 报错，也别吞数据）', () => {
  const f = new RsyncGreetingFilter()
  const junk = Buffer.alloc(RsyncGreetingFilter.SCAN_LIMIT + 8, 0x41)
  const out = f.feed(junk)
  assert.ok(out.length > 0, '放弃过滤后要把数据放出去')
  assert.equal(f.finished, true)
})

// ⚠️ 这个坑真炸过一次（用户实机第一次试）：
//    过滤器是**单向**的 —— 只喂「通道 → 客户端」那一侧。
//    客户端发来的第一批字节就是它自己的协议版本握手，和远端握手**长得一模一样**；
//    要是把它也喂进同一个过滤器实例，过滤状态会被提前置成"已找到握手"，
//    于是远端那份带着终端回显噪声的数据就不再被过滤 →
//    客户端读到噪声 → `protocol version mismatch -- is your shell clean?`。
test('⚠️ 过滤器必须单向使用：喂了客户端的握手之后，远端噪声就过滤不掉了', () => {
  const wrong = new RsyncGreetingFilter()
  // 模拟接错方向：客户端自己的版本握手先进来
  wrong.feed(greeting(32))
  assert.equal(wrong.finished, true, '客户端的握手把状态提前置位了 —— 这正是接错方向的后果')
  // 此时远端那份「噪声 + 真握手」会被原样放行（噪声漏进协议）
  const leaked = wrong.feed(Buffer.concat([NOISE, greeting(32)]))
  assert.deepEqual([...leaked.subarray(0, NOISE.length)], [...NOISE], '噪声漏出去了 → 客户端会报 is your shell clean?')

  // 正确用法：只喂通道→客户端这一侧
  const right = new RsyncGreetingFilter()
  const ok = right.feed(Buffer.concat([NOISE, greeting(32)]))
  assert.equal(right.dropped, NOISE.length)
  assert.equal(ok[0], 32, '噪声被丢掉，协议从握手开始')
})

// ---- 解析客户端发来的远端命令 ----

test('从客户端命令里取出紧凑选项串', () => {
  const r = parseRsyncServerCmd('rsync --server -logDtpre.iLsfxCIvu . /tmp/dst/')
  assert.equal(r?.opts, '-logDtpre.iLsfxCIvu')
  assert.equal(parseRsyncServerCmd('ls -l'), undefined, '不是 rsync 命令就不认')
})

test('注入到远端的那一行：raw、无回显、提示符**存下来再恢复**、带完成标记、末尾 \\r', () => {
  const cmd = buildRemoteInjectCmd('--server -logDtpre.iLsfxCIvu . /tmp/dst/', '/tmp/dst')
  assert.match(cmd, /stty raw -echo -iexten/)
  assert.match(cmd, /OPS1=\$PS1; PS1=;/, '要先把原提示符存起来再清空')
  assert.match(cmd, /PS1=\$OPS1; unset OPS1;/, '跑完必须把提示符还回去（用户实测：没还的话终端看起来"回不来"）')
  assert.match(cmd, /rsync --server -logDtpre\.iLsfxCIvu \. \/tmp\/dst\//, '客户端给的参数要原样透传')
  assert.match(cmd, /stty sane/, '跑完要把终端恢复，会话还得继续用')
  assert.ok(cmd.includes(RSYNC_DONE_MARK), '要带完成标记，桥靠它知道远端结束了')
  assert.ok(cmd.endsWith('\r'), '末尾用一个 \\r 提交（pty 的 ICRNL 会翻译成换行）')
  // 恢复提示符要在 stty sane 之后、完成标记之前
  assert.ok(cmd.indexOf('PS1=$OPS1') < cmd.indexOf(RSYNC_DONE_MARK), '恢复提示符要在打印完成标记之前')
})

test('注入行：目标目录先 mkdir -p（单个文件同步要求目录已存在，否则 rsync 直接退 11）', () => {
  const cmd = buildRemoteInjectCmd('--server -opts . /opt/app/', '/opt/app')
  assert.ok(cmd.includes('mkdir -p "/opt/app"'), '要先建目录 —— 验证矩阵实测：不建就退出码 11')
  assert.ok(cmd.indexOf('mkdir -p') < cmd.indexOf('rsync --server'), 'mkdir 必须在 rsync 之前')
})

test('注入行：给远端套一个 timeout 兜底（扩展进程万一没了，远端也不至于永远挂着）', () => {
  const cmd = buildRemoteInjectCmd('--server -opts . ./', '.')
  assert.match(cmd, /command -v timeout/, '要用 command -v 探测，不能假设有 coreutils')
  assert.match(cmd, /timeout 1800/)
  assert.match(cmd, /\$T rsync --server/, '探测不到就不套，照样能跑')
})

test('⚠️ 必须先让远端确认 raw，再放客户端的字节过去（否则撞上 cooked 窗口）', () => {
  const cmd = buildRemoteInjectCmd('--server -opts . ./', '.')
  const rawAt = cmd.indexOf(RSYNC_RAW_MARK)
  const rsyncAt = cmd.indexOf('rsync --server')
  assert.ok(rawAt > 0, '注入行里要有 raw 标记')
  assert.ok(cmd.indexOf('stty raw') < rawAt, '标记必须在 stty raw 之后打印 —— 看到它就说明 raw 已经生效')
  assert.ok(rawAt < rsyncAt, '标记要在起 rsync 之前打印，才来得及在协议开始前放行')
  assert.equal(seenRawMark(`junk ${RSYNC_RAW_MARK}\r\n`), true)
  assert.equal(seenRawMark('stty raw -echo -iexten; PS1=;'), false, '普通回显不能被误判成"已 raw"')
})

test('注入行：stderr 落盘前先探测可写（/tmp 写不了就退到 $HOME，别让 bash 在重定向阶段就退出）', () => {
  const cmd = buildRemoteInjectCmd('--server -opts . ./', '.')
  assert.ok(cmd.includes(`ERR=${REMOTE_ERR_FILE}`), '先试 /tmp')
  assert.ok(cmd.includes('|| ERR=$HOME/'), '写不了要退到 $HOME —— 否则 bash 重定向失败直接退 1，rsync 根本不跑')
  assert.ok(cmd.includes('2>>"$ERR"'), 'rsync 的 stderr 要落到选好的那个文件（用追加，mkdir 的错误也在里面）')
  assert.ok(!cmd.includes('2>/tmp/bastion-rsync-err.txt;'), '不能再写死 /tmp')
})

test('完成标记能解析出远端退出码；没有标记就返回 undefined（不许瞎猜成 0）', () => {
  assert.equal(parseDoneMark(`junk ${RSYNC_DONE_MARK}0__\r\n`), 0)
  assert.equal(parseDoneMark(`${RSYNC_DONE_MARK}12__`), 12)
  assert.equal(parseDoneMark('rsync 还在跑，什么都没结束'), undefined)
})

test('远端退出码要翻译成人话：127 就是「目标机没装 rsync」（实测撞到过）', () => {
  const m = describeRemoteRc(127)!
  assert.match(m, /没有 rsync/)
  assert.match(m, /apt-get install -y rsync/, '要给出能直接照做的安装命令')
  assert.match(m, /rz/, '装不了要给退路')
  assert.match(describeRemoteRc(126)!, /执行权限/)
  assert.match(describeRemoteRc(1)!, /用法\/语法错/)
  assert.equal(describeRemoteRc(0), undefined, '成功不该有提示')
  assert.equal(describeRemoteRc(23), undefined, '没把握的码不乱解释')
})

// ---- 本机 rsync 与客户端参数 ----

test('找本机 rsync：Windows 先看 %LOCALAPPDATA%\\rsync\\rsync.exe，再退回 PATH', () => {
  const win = rsyncCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
  assert.equal(win[0], 'C:\\Users\\me\\AppData\\Local\\rsync\\rsync.exe')
  assert.ok(win.includes('rsync.exe'))
  const linux = rsyncCandidates('linux', {})
  assert.equal(linux[0], '/usr/bin/rsync')
})

test('客户端参数：假 host 走远端那条路径，-e 指向桥；**文件绝不能带末尾斜杠**', () => {
  const file = buildClientArgs('node /tmp/shim.js', [{ path: 'D:\\work\\bundle.tar.gz', isDir: false }], '/opt/app')
  assert.deepEqual(file, ['-a', '--partial', '--stats', '-e', 'node /tmp/shim.js', 'D:\\work\\bundle.tar.gz', 'bastion:/opt/app/'])
  // 实测（用户实机）：给文件加 / 会让 rsync 当目录去 change_dir →
  //   `change_dir "…bundle.tar.gz" failed: Invalid argument (22)`（退出码 23）
  assert.ok(!file[5].endsWith('/'), '文件源后面不能有斜杠')
})

test('客户端参数：目录带末尾斜杠（表示把目录里的内容同步过去），多选时全部带上', () => {
  const args = buildClientArgs(
    'node /tmp/shim.js',
    [
      { path: 'D:\\work\\conf', isDir: true },
      { path: 'D:\\work\\a.txt', isDir: false }
    ],
    '/opt/app'
  )
  assert.deepEqual(args, [
    '-a', '--partial', '--stats', '-e', 'node /tmp/shim.js', 'D:\\work\\conf/', 'D:\\work\\a.txt', 'bastion:/opt/app/'
  ])
})

test('客户端参数：源路径本来带斜杠也要规整（目录补一个、文件去掉）', () => {
  const args = buildClientArgs('x', [
    { path: 'D:\\work\\conf\\', isDir: true },
    { path: 'D:\\work\\a.txt/', isDir: false }
  ], '.')
  assert.equal(args[5], 'D:\\work\\conf/')
  assert.equal(args[6], 'D:\\work\\a.txt')
  assert.equal(args[7], 'bastion:./')
})

test('客户端参数：**一律带 --partial**（中断/卡住时目标机保留已传部分，再点一次就能续传）', () => {
  const args = buildClientArgs('x', [{ path: 'D:\\a.bin', isDir: false }], '.')
  assert.ok(args.includes('--partial'), '--partial 必须在：真机 87MB 卡住就是靠它才不用从头再来')
})

test('统计解析：拿得到就报文件数和字节数，拿不到不编', () => {
  const out = 'Number of regular files transferred: 12\nTotal transferred file size: 3,145,728 bytes\n'
  assert.deepEqual(parseStats(out), { files: 12, bytes: 3145728 })
  assert.deepEqual(parseStats('完全没见过的输出'), { files: undefined, bytes: undefined })
})

// ---- 进度上报（用户实测：看不到进度，把一次 91MB 的传输取消了）----

test('进度文案：单文件时报百分比，目录同步时不报（rsync 只传变化部分，分母会偏大）', () => {
  const p = formatProgress(45 * 1024 * 1024, 91 * 1024 * 1024, 50_000, true)
  assert.match(p, /45 MB/)
  assert.match(p, /49%/, '单文件要报百分比')
  assert.match(p, /KB\/s|MB\/s/)
  assert.match(p, /已用 50s/)

  const d = formatProgress(45 * 1024 * 1024, 91 * 1024 * 1024, 50_000, false)
  assert.doesNotMatch(d, /%/, '目录同步不假装知道百分比（只报已发/速率/耗时）')
  assert.match(d, /45 MB/)
})

test('进度文案：真实速率也报得出来（实测真机约 0.9 MB/s，这种"慢但活着"要看得见）', () => {
  // 45MB / 50s ≈ 0.9 MB/s → 用 KB/s 展示更直观
  assert.match(formatProgress(45 * 1024 * 1024, 0, 50_000, false), /9\d\d KB\/s/)
  // 快的时候用 MB/s
  assert.match(formatProgress(100 * 1024 * 1024, 0, 10_000, false), /10\.0 MB\/s/)
})

test('进度文案：百分比封顶 99%（别在还没结束时显示 100%）', () => {
  assert.match(formatProgress(1000, 1000, 1000, true), /99%/)
})

test('进度文案：小数据/极短耗时也不能出 NaN 或 Infinity', () => {
  for (const [sent, ms] of [
    [0, 0],
    [10, 0],
    [10, 1]
  ] as const) {
    const s = formatProgress(sent, 100, ms, true)
    assert.ok(!/NaN|Infinity/.test(s), `不该出现 NaN/Infinity：${s}`)
  }
})

test('总大小：文件累加、目录递归、读不到的按 0（不能因为算大小把同步搞失败）', () => {
  const tree: Record<string, { isDir: boolean; size: number; children?: string[] }> = {
    '/a.txt': { isDir: false, size: 100 },
    '/dir': { isDir: true, size: 0, children: ['/dir/b.bin', '/dir/sub'] },
    '/dir/b.bin': { isDir: false, size: 200 },
    '/dir/sub': { isDir: true, size: 0, children: ['/dir/sub/c.txt'] },
    '/dir/sub/c.txt': { isDir: false, size: 300 }
  }
  const stat = (p: string) => {
    const v = tree[p]
    if (!v) throw new Error('ENOENT')
    return v
  }
  assert.equal(totalBytesOf([{ path: '/a.txt', isDir: false }], stat), 100)
  assert.equal(totalBytesOf([{ path: '/dir', isDir: true }], stat), 500, '目录要递归累加')
  assert.equal(
    totalBytesOf([{ path: '/a.txt', isDir: false }, { path: '/dir', isDir: true }, { path: '/nope', isDir: false }], stat),
    600,
    '读不到的项按 0 算，不能抛'
  )
})
