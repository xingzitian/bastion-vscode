// bastion_listSessions 的返回内容。
//
// 这个工具的返回是 AI 唯一的「现状说明书」，所以它必须包含两件事：
//   1. 每条会话现在**能不能用**（在 shell 里 / 还停在菜单上）—— 人机共用会话的前提；
//   2. **本次调用来自哪个 MCP 端点** —— AI 报「工具出错」时，这一行能立刻分清
//      「端点根本没连上（不会有返回）」和「连上了、工具里出错（返回里会有这一行）」；
//      多窗口时也看得出这次调的是哪个窗口的端点。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { exitCodeNote, listSessions, pullFile, pushFile, tailScreen } from '../aiBridge'
import { judgeUpload, md5Hex } from '../uploadVerify'
import { healthReport } from '../aiSessionApi'
import { classifySessionScreen } from '../menu'
import { setMcpEndpointInfo, terminals } from '../state'
import type { BastionTerminal } from '../terminal'

const REAL_ASSET_LIST = [
  'ID | 名称                  | 地址          | 平台    | 组织     | 备注',
  '  1  | 172.20.30.143         | 172.20.30.143 | Linux   | 默认组织 |',
  '  2  | 研发网域172.20.30.143 | 172.20.30.143 | Gateway | 默认组织 |',
  '提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192'
].join('\n')

function putSession(name: string, tail: string): vscode.Terminal {
  const vt = { name } as unknown as vscode.Terminal
  terminals.set(vt, { getTail: () => tail, profile: undefined } as unknown as BastionTerminal)
  return vt
}

test('没有会话时也要说明本次调用来自哪个端点（区分「没连上」和「连上了但没会话」）', () => {
  setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false })
  const text = listSessions()
  assert.match(text, /没有活动堡垒机会话/)
  assert.match(text, /本次调用来自 MCP 端点 http:\/\/127\.0\.0\.1:39311\/mcp/)
  setMcpEndpointInfo(undefined)
})

test('会话状态标进返回里：在 shell 里的可以直接用，停在菜单上的要人先做完', () => {
  setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false })
  const a = putSession('deploy@10.0.0.1', '[deploy@10.0.0.1 ~]$ ')
  const b = putSession('deploy@172.20.30.143', REAL_ASSET_LIST)
  try {
    const text = listSessions()
    assert.match(text, /deploy@10\.0\.0\.1：✅ 在 shell 里/)
    assert.match(text, /deploy@172\.20\.30\.143：⚠️ 还停在堡垒机菜单上/)
    assert.match(text, /人和 AI 共用/, '要写清人和 AI 共用这条会话')
  } finally {
    terminals.delete(a)
    terminals.delete(b)
    setMcpEndpointInfo(undefined)
  }
})

test('端口回退过的话要在返回里点出来（那正是「工具调用连不上」的常见原因）', () => {
  setMcpEndpointInfo({ url: 'http://127.0.0.1:51234/mcp', port: 51234, portFallback: true })
  const text = listSessions()
  assert.match(text, /默认端口被占用，已退到随机端口/)
  setMcpEndpointInfo(undefined)
})
// ---- 退出码备注：AI 能不能判断「命令到底成没成」全靠它 ----

/** 造一个足够像 BastionTerminal 的对象（exitCodeNote 只读这两个字段） */
function fakeTermWith(rc: number | undefined, markerSeen: boolean): BastionTerminal {
  return { lastExitCode: rc, lastExecMarkerSeen: markerSeen } as unknown as BastionTerminal
}

test('退出码：成功/失败/拿不到，三种说法必须分开（AI 的下一步完全不同）', () => {
  assert.match(exitCodeNote(fakeTermWith(0, true)), /退出码 0：命令成功/)
  assert.match(exitCodeNote(fakeTermWith(1, true)), /退出码 1：命令以非 0 退出，通常表示失败/)
  assert.match(exitCodeNote(fakeTermWith(127, true)), /退出码 127/)
  // 交互式命令：有哨兵语义但没有 rc → 说「未知」
  assert.match(exitCodeNote(fakeTermWith(undefined, true)), /退出码未知/)
  // 没等到哨兵：这条命令很可能压根没执行完 —— 不能把输出当正常结果
  assert.match(exitCodeNote(fakeTermWith(undefined, false)), /没等到命令结束标记/)
  assert.match(exitCodeNote(fakeTermWith(undefined, false)), /bastion_tail/)
})

// ---- bastion_tail ----

test('tailScreen：带上会话名和状态，并回屏幕最后几行', () => {
  const vt = putSession('deploy@10.0.0.9', 'total 0\n-rw-r--r-- 1 root root 12 x.conf\n[deploy@10.0.0.9 ~]$ ')
  try {
    const text = tailScreen({ terminal: 'deploy@10.0.0.9', lines: 5 })
    assert.match(text, /会话 deploy@10\.0\.0\.9/)
    assert.match(text, /在 shell 里/)
    assert.match(text, /x\.conf/)
  } finally {
    terminals.delete(vt)
  }
})

test('tailScreen：会话名字写错时给的是可读提示，而不是空字符串', () => {
  const text = tailScreen({ terminal: '不存在的会话' })
  assert.match(text, /找不到会话/)
  assert.match(text, /bastion_listSessions/)
})

// ---- bastion_push / bastion_pull 的参数把关（这几条在碰到会话之前就该拦住）----

test('push：参数/文件不存在时明确拒绝，并说清为什么', async () => {
  assert.match(await pushFile({}), /需要 localPath/)
  assert.match(await pushFile({ localPath: 'Z:\\definitely-not-here-9f8a.txt' }), /找不到这个路径/)
  // 目录现在是**允许**传的（标准工具先本地打包、远端自动解开），所以这里不再断言"拒绝目录"。
  // 通道选择那部分逻辑在 transferPath.test.ts 里单独测。
})

test('pull：缺 remotePath 时明确拒绝', async () => {
  assert.match(await pullFile({}), /需要 remotePath/)
})


test('【真机教训 2026-09-14】菜单正文滚上去、底部只剩 Opt> 时，也必须判成 menu', () => {
  // 那天 AI 拿到的状态是「未知」，于是拦截没生效，它把命令（还带 # 注释）敲进了菜单。
  // 菜单正文（「进行搜索」）会随公告滚出屏幕，底部只剩提示符 —— 只认强特征就会漏。
  const scrolled = [
    '公告：示例生产堡垒机使用注意事项',
    '1、堡垒机域名已更新，请使用新地址登录(bastion.example.com)。',
    'Opt> Opt>'
  ].join('\n')
  assert.equal(classifySessionScreen(scrolled), 'menu', '底部只剩 Opt> 也是菜单')
  assert.equal(classifySessionScreen('Opt> Opt>'), 'menu')
  assert.equal(classifySessionScreen('[Host]> '), 'menu')
})

test('弱特征只认最后两行：shell 里翻到过菜单文本也不会被误判', () => {
  const tail = ['Opt> Opt>', 'root@h:~# cat menu.txt', '请选择资产：', 'root@h:~# '].join('\n')
  assert.equal(classifySessionScreen(tail), 'shell', '最后一行是 shell 提示符 → 就是 shell')
})

test('health 在「没有一个会话能直接执行命令」时必须说清为什么、该谁做', () => {
  const vt = putSession('deploy@10.0.0.7', '公告：堡垒机注意事项\nOpt> Opt>')
  try {
    setMcpEndpointInfo({ url: 'http://127.0.0.1:39311/mcp', port: 39311, portFallback: false, version: '0.3.0' })
    const text = healthReport()
    assert.match(text, /\*\*0 个能直接执行命令\*\*/)
    assert.match(text, /停在堡垒机菜单上/)
    assert.match(text, /让用户在终端里手动走完/)
    assert.match(text, /不要往菜单里发命令/)
  } finally {
    terminals.delete(vt)
    setMcpEndpointInfo(undefined)
  }
})



// ───────── 上传判定：**靠内容哈希**，绝不靠 mtime ─────────
//
// 2026-09-14 我先按 mtime 写了一版判定，结果自己搞错了：ZMODEM 会把**源文件的 mtime
// 一起传过去**（ZFILE 帧里带），实测本机 AGENT_RULES.md 是 2026-09-10 19:16:47，
// 刚传上去的远端那份也是 `Sep 10 19:16` —— 一模一样的 mtime、一样的 md5。
// 所以"mtime 很旧"根本不能说明上传失败；拿它当判据，凡是源文件几分钟没改过就全是误报。
// 下面第一条测试就是钉住这个教训。

const H_OK = '11acf3c52ba2b9c10689317dc885b810'

test('【教训】mtime 很旧但哈希一致 → 必须判成功（ZMODEM 会保留源文件 mtime）', () => {
  const v = judgeUpload({
    localHash: H_OK,
    // 5 天前的 mtime —— 这是源文件的 mtime，不是"旧文件"的证据
    remote: { hash: H_OK, size: 9200, mtime: 1_757_000_000, path: '/tmp/AGENT_RULES.md' },
    localSize: 9200,
    mode: 'overwrite',
    name: 'AGENT_RULES.md'
  })
  assert.equal(v.ok, true, '哈希一致就是成功，mtime 旧完全正常')
  assert.match(v.note, /逐字节一致/)
  assert.match(v.note, /源文件的时间戳/, '要顺手把这条事实讲清楚，免得下次又误判')
  assert.equal(v.remotePath, '/tmp/AGENT_RULES.md')
})

test('哈希不一致 → 明确失败（这才是"没传上去/传坏了"的铁证）', () => {
  const v = judgeUpload({
    localHash: H_OK,
    remote: { hash: 'deadbeefdeadbeefdeadbeefdeadbeef', size: 9200, mtime: 1_800_000_000, path: '/tmp/a.txt' },
    localSize: 9200,
    mode: 'overwrite',
    name: 'a.txt'
  })
  assert.equal(v.ok, false)
  assert.match(v.note, /内容对不上/)
})

test('远端找不到文件 → 失败，并指向日志里的 zmodem 行', () => {
  const v = judgeUpload({ localHash: H_OK, remote: undefined, localSize: 9200, mode: 'overwrite', name: 'a.txt' })
  assert.equal(v.ok, false)
  assert.match(v.note, /找不到这个文件/)
  assert.match(v.note, /zmodem/)
})

test('远端没有哈希工具时退化成比大小，并如实说明是弱证据', () => {
  const same = judgeUpload({
    localHash: H_OK,
    remote: { size: 9200, mtime: 1_800_000_000, path: '/tmp/a.txt' },
    localSize: 9200,
    mode: 'overwrite',
    name: 'a.txt'
  })
  assert.equal(same.ok, true)
  assert.match(same.note, /弱证据/)

  const diff = judgeUpload({
    localHash: H_OK,
    remote: { size: 512, mtime: 1_800_000_000, path: '/tmp/a.txt' },
    localSize: 9200,
    mode: 'overwrite',
    name: 'a.txt'
  })
  assert.equal(diff.ok, false)
  assert.match(diff.note, /大小对不上/)
})

test('改名模式：远端文件数没增加 = 没传上去（旧文件本来就在）', () => {
  const stillOne = judgeUpload({
    localHash: H_OK,
    remote: { hash: 'aaaa', size: 100, mtime: 1, path: '/tmp/a.txt' },
    localSize: 9200,
    mode: 'rename',
    name: 'a.txt',
    beforeCount: 1,
    afterCount: 1
  })
  assert.equal(stillOne.ok, false)
  assert.match(stillOne.note, /没看到新文件/)

  const added = judgeUpload({
    localHash: H_OK,
    remote: { hash: H_OK, size: 9200, mtime: 2, path: '/tmp/a.txt.0' },
    localSize: 9200,
    mode: 'rename',
    name: 'a.txt',
    beforeCount: 1,
    afterCount: 2
  })
  assert.equal(added.ok, true)
})

test('md5Hex 和系统 md5 一致（回读比对用的就是它）', () => {
  assert.equal(md5Hex(Buffer.from('hello', 'utf8')), '5d41402abc4b2a76b9719d911017c592')
})

test('给 AI 的话里明确写了「不要再自己 ls/md5 验一遍」；mtime 的教训留在代码里', () => {
  const transfer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'transferPath.ts'), 'utf8')
  assert.match(transfer, /不要再用 ls \/ md5sum 自己验一遍/)
  const verify = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'uploadVerify.ts'), 'utf8')
  assert.match(verify, /绝对不要用 mtime 判断成功与否/, '这条教训要留在代码里')
})





test('哈希读不出来时，必须说清"为什么"（读不了 / 没工具 是两件事）', () => {
  const noPerm = judgeUpload({
    localHash: 'aaaa',
    remote: { hash: undefined, size: 9200, mtime: 1, path: '/tmp/a.txt', readable: false },
    localSize: 9200,
    mode: 'overwrite',
    name: 'a.txt'
  })
  assert.equal(noPerm.ok, true, '大小一致 + 读不了 → 仍然是弱证据成功')
  assert.match(noPerm.note, /读不了/)
  assert.match(noPerm.note, /弱证据/)

  const noTool = judgeUpload({
    localHash: 'aaaa',
    remote: { hash: undefined, size: 9200, mtime: 1, path: '/tmp/a.txt', readable: true },
    localSize: 9200,
    mode: 'overwrite',
    name: 'a.txt'
  })
  assert.match(noTool.note, /缺少 md5sum/)
  assert.doesNotMatch(noTool.note, /读不了/)
})

test('回读命令不依赖 awk/cut（真机教训：md5sum | awk 什么都没吐出来）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'uploadVerify.ts'), 'utf8')
  const cmdBlock = src.slice(src.indexOf('const cmd ='), src.indexOf('const out = await session.exec(cmd)'))
  assert.doesNotMatch(cmdBlock, /\bawk\b/, '回读命令里不能再出现 awk')
  assert.doesNotMatch(cmdBlock, /\bcut\b/)
  assert.match(cmdBlock, /\{h%% \*\}/, '用 shell 自己的参数展开取第一个字段')
  assert.match(cmdBlock, /wc -c/, 'stat 没有时要有 wc -c 兜底')
})

