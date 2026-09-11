// 广播输入（一次给多个会话发同一条命令）。
//
// 这块功能的风险不在"能不能用"，而在**它是不是被看见了**：
// 广播开着的时候，在测试机上敲的命令会同时在生产机上执行。
// 所以这里钉住三件事：
//   1. 转发对象永远不含自己、不含只读、不含已关闭的会话（否则底栏台数会骗人）
//   2. 开着的时候底栏必须有警告色的一格，点它就能改/关
//   3. 取消全部勾选 = 真的关掉广播，而不是"看起来关了其实还在转发"
import '../testkit/vscode-stub'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  configValues,
  resetStatusBarItems,
  resetWindowRecords,
  slotItem,
  quickPickCalls,
  queueQuickPickResponse,
  infoMessages
} from '../testkit/vscode-stub'
import * as vscode from 'vscode'
import { disposeSlots } from '../status'
import { updateBroadcastSlot, updateBroadcastModeSlot, updateStatusBar } from '../slots'
import {
  broadcastReceivers,
  broadcastPayload,
  resolveBroadcastMode,
  clearBroadcast,
  getBroadcastTargets,
  removeBroadcastTarget,
  setBroadcastTargets,
  terminals
} from '../state'
import {
  broadcastItemLabel,
  buildBroadcastItems,
  filterBroadcastRows,
  nextBroadcastTargets,
  toggleBroadcast,
  toggleBroadcastMode,
  type BroadcastRow
} from '../broadcastCmd'
import type { BastionTerminal } from '../terminal'

interface FakeOpts {
  sessionNo?: number
  readOnly?: boolean
  closed?: boolean
}

function fakeTerm(name: string, opts: FakeOpts = {}): { vt: vscode.Terminal; term: BastionTerminal } {
  const vt = { name } as unknown as vscode.Terminal
  const term = {
    sessionNo: opts.sessionNo ?? 1,
    isReadOnly: !!opts.readOnly,
    isClosed: !!opts.closed,
    name,
    // 会话概览那一格要读 conn.connectedAt —— 给个够用的假连接，让 updateStatusBar 能整体走通
    conn: {
      connectedAt: Date.now(),
      isAlive: true,
      channelCount: 1,
      profile: { name: '测试档案', username: 'root', host: '10.0.0.1' }
    }
  } as unknown as BastionTerminal
  return { vt, term }
}

function addSession(name: string, opts: FakeOpts = {}): BastionTerminal {
  const { vt, term } = fakeTerm(name, opts)
  terminals.set(vt, term)
  return term
}

function rowOf(term: BastionTerminal, opts: FakeOpts = {}): BroadcastRow {
  return {
    name: (term as unknown as { name: string }).name,
    sessionNo: opts.sessionNo ?? 1,
    readOnly: !!opts.readOnly,
    term
  }
}

beforeEach(() => {
  disposeSlots()
  resetStatusBarItems()
  resetWindowRecords()
  configValues.clear()
  terminals.clear()
  clearBroadcast()
})

// ---- 纯函数：谁该收到这份输入 ----

test('转发给除自己以外的所有目标（绝不把自己也算成接收者）', () => {
  const { term: a } = fakeTerm('#1 a')
  const { term: b } = fakeTerm('#2 b')
  const { term: c } = fakeTerm('#3 c')
  const got = broadcastReceivers(a, [a, b, c])
  assert.deepEqual(got, [b, c])
  assert.ok(!got.includes(a), '自己不能出现在接收者里（那会形成自我转发）')
})

test('只读会话不接收广播：它连人工输入都拦，广播不该往里面写', () => {
  const { term: a } = fakeTerm('#1 a')
  const { term: ro } = fakeTerm('#2 ro', { readOnly: true })
  const { term: b } = fakeTerm('#3 b')
  assert.deepEqual(broadcastReceivers(a, [a, ro, b]), [b])
})

test('已关闭的会话不接收广播（写了也是白写，别让底栏台数虚高）', () => {
  const { term: a } = fakeTerm('#1 a')
  const { term: dead } = fakeTerm('#2 dead', { closed: true })
  assert.deepEqual(broadcastReceivers(a, [a, dead]), [])
})

test('没开广播时谁都不转发', () => {
  const { term: a } = fakeTerm('#1 a')
  assert.deepEqual(broadcastReceivers(a, []), [])
})

// ---- 两种模式：原样同步 / 整行发送 ----
//
// 原样同步是桌面版的行为：逐键镜像。**vim 里改配置文件必须靠它** ——
// vim 的插入/命令模式切换、方向键、`:wq` 的回车，都不是"一行"。
// 整行发送适合"给几台机器各敲一条命令"：敲到一半的内容不会打扰对面。
test('原样模式：逐键镜像 —— 连回车都要转发（vim 里 :wq 的回车过不去就存不了盘）', () => {
  assert.equal(broadcastPayload('l', { multiLine: false }, 'raw'), 'l')
  assert.equal(broadcastPayload('s', { multiLine: false }, 'raw'), 's')
  assert.equal(broadcastPayload('\r', { line: 'ls', multiLine: false }, 'raw'), '\r', '回车必须过去')
  assert.equal(broadcastPayload('\x1b[A', { multiLine: false }, 'raw'), '\x1b[A', '方向键必须过去')
  assert.equal(broadcastPayload('\x1b', { multiLine: false }, 'raw'), '\x1b', 'vimg 的 ESC 必须过去')
})

test('原样模式：空串不转发（没有内容可发）', () => {
  assert.equal(broadcastPayload('', { multiLine: false }, 'raw'), undefined)
})

test('原样模式：扣住又补发的那段也要一起镜像（否则本地和对面从此对不上）', () => {
  // terminal.ts 传的是 `held + data`：补发的字符如果只发给本地，对面就少了那几个字符
  const held = 'c:/tmp/notes.txt'
  assert.equal(broadcastPayload(`${held}l`, { multiLine: false }, 'raw'), `${held}l`)
})

test('整行模式：还在敲（没回车）→ 什么都不发', () => {
  assert.equal(broadcastPayload('systemctl', { multiLine: false }, 'line'), undefined)
  assert.equal(broadcastPayload('systemctl res', { multiLine: false }, 'line'), undefined, '敲到一半的内容绝不能过去')
})

test('整行模式：按回车 → 把这一整行 + 回车同步过去', () => {
  assert.equal(broadcastPayload('\r', { line: 'systemctl restart nginx', multiLine: false }, 'line'), 'systemctl restart nginx\r')
})

test('整行模式：空回车不同步（那只是想要个新提示符，不该把对方的交互菜单也推进一步）', () => {
  assert.equal(broadcastPayload('\r', { line: '', multiLine: false }, 'line'), undefined)
  assert.equal(broadcastPayload('\r', { line: '   ', multiLine: false }, 'line'), undefined)
})

test('两种模式：多行粘贴都整块同步（只发第一行就把后面几行丢了）', () => {
  const block = 'cd /opt\r./deploy.sh\r'
  assert.equal(broadcastPayload(block, { line: 'cd /opt', multiLine: true }, 'line'), block)
  assert.equal(broadcastPayload(block, { line: 'cd /opt', multiLine: true }, 'raw'), block)
})

test('模式解析：默认原样（和桌面版一致），只有明确写 line 才是整行', () => {
  assert.equal(resolveBroadcastMode(undefined), 'raw')
  assert.equal(resolveBroadcastMode('raw'), 'raw')
  assert.equal(resolveBroadcastMode('line'), 'line')
  for (const junk of ['', '整行', 42, null, {}, []]) {
    assert.equal(resolveBroadcastMode(junk), 'raw', `设置里写错（${JSON.stringify(junk)}）应当退回原样，而不是乱选一个`)
  }
})

test('会话关闭时把自己从广播目标里摘掉', () => {
  const { term: a } = fakeTerm('#1 a')
  const { term: b } = fakeTerm('#2 b')
  setBroadcastTargets([a, b])
  removeBroadcastTarget(b)
  assert.deepEqual(getBroadcastTargets(), [a])
  removeBroadcastTarget(a)
  assert.deepEqual(getBroadcastTargets(), [])
})

// ---- 候选列表 ----

test('列表标签用统一的 #n 前缀，并去掉终端名里重复的那一段', () => {
  assert.equal(broadcastItemLabel({ name: '#3 10.0.0.1', sessionNo: 3 }), '#3 10.0.0.1')
  assert.equal(broadcastItemLabel({ name: 'root@10.0.0.1', sessionNo: 7 }), '#7 root@10.0.0.1')
  assert.equal(broadcastItemLabel({ name: 'root@10.0.0.1', sessionNo: 0 }), '#? root@10.0.0.1')
})

test('只读会话不进候选列表，也不在勾选状态里冒充目标', () => {
  const { term: a } = fakeTerm('#1 a')
  const { term: ro } = fakeTerm('#2 ro', { readOnly: true })
  const { term: b } = fakeTerm('#3 b')
  const rows = [rowOf(a), rowOf(ro, { readOnly: true }), rowOf(b, { sessionNo: 3 })]
  const cands = filterBroadcastRows(rows)
  assert.deepEqual(cands.map((r) => r.term), [a, b])
  const items = buildBroadcastItems(cands, [b])
  assert.deepEqual(items.map((i) => i.picked), [false, true], '勾选状态必须等于当前真正在广播的目标')
  assert.equal(items[1].label, '#3 b')
})

test('同一会话重复出现时只算一个', () => {
  const { term: a } = fakeTerm('#1 a')
  assert.equal(nextBroadcastTargets([a, a]).length, 1)
  assert.deepEqual(nextBroadcastTargets([]), [], '一个都不勾 = 关闭广播')
})

// ---- 底栏那一格：开着必须看得见 ----

test('没开广播时不占底栏格子', () => {
  addSession('#1 a')
  updateBroadcastSlot()
  const item = slotItem('broadcast')
  assert.ok(!item || !item.shown)
})

test('开着广播时底栏出现「广播 N 台」，警告色，点击就是那个开关命令', () => {
  const a = addSession('#1 a')
  const b = addSession('#2 b')
  setBroadcastTargets([a, b])
  updateBroadcastSlot()
  const item = slotItem('broadcast')
  assert.ok(item, '应当创建了这个槽位')
  assert.equal(item!.shown, true, '广播开着却看不到，等于让人蒙着眼睛敲生产')
  assert.match(item!.text, /广播 2 台/)
  assert.equal(item!.command?.command, 'bastion.toggleBroadcast')
  assert.ok(item!.backgroundColor, '必须是警告色，普通格子太容易看漏')
  // tooltip 里带 markdown：必须是 MarkdownString，纯字符串会被 VS Code 原样显示（用户看到字面的 **）
  assert.ok(item!.tooltip instanceof vscode.MarkdownString, '带 markdown 的 tooltip 必须包成 MarkdownString')
  // 悬停必须说清当前是哪种模式 —— 两种模式的后果完全不同（原样模式连 vim 里的按键都会跑过去）
  const tip = (item!.tooltip as unknown as { value: string }).value
  assert.match(tip, /当前模式/)
  assert.match(tip, /原样同步/, '默认就是原样（和桌面版一致）')
})

test('广播模式那一格：只在广播开着时出现，点击可切模式', () => {
  const a = addSession('#1 a')
  updateBroadcastModeSlot()
  assert.ok(!slotItem('broadcastmode')?.shown, '没广播时不该摆一个「原样同步」在底栏')

  setBroadcastTargets([a])
  updateBroadcastModeSlot()
  const item = slotItem('broadcastmode')!
  assert.equal(item.shown, true)
  assert.match(item.text, /原样同步/)
  assert.equal(item.command?.command, 'bastion.toggleBroadcastMode', '点它就该能切模式')

  configValues.set('bastion.broadcastMode', 'line')
  updateBroadcastModeSlot()
  assert.match(slotItem('broadcastmode')!.text, /整行发送/)
})

test('切模式：真的写进设置，底栏两格跟着变（显示不能落后于设置）', async () => {
  const a = addSession('#1 a')
  setBroadcastTargets([a])
  updateStatusBar()
  assert.match(slotItem('broadcastmode')!.text, /原样同步/)

  await toggleBroadcastMode()
  assert.equal(configValues.get('bastion.broadcastMode'), 'line', '要真的写进设置，不能只改显示')
  assert.match(slotItem('broadcastmode')!.text, /整行发送/)

  await toggleBroadcastMode()
  assert.equal(configValues.get('bastion.broadcastMode'), 'raw', '再点一次切回原样')
})

test('设置里删掉 broadcast 这一格 → 真的不显示（用户的底栏选择要生效）', () => {
  const a = addSession('#1 a')
  setBroadcastTargets([a])
  updateBroadcastSlot()
  assert.equal(slotItem('broadcast')!.shown, true, '先确认默认是显示的')
  configValues.set('bastion.statusBarItems', ['session'])
  updateBroadcastSlot()
  assert.equal(slotItem('broadcast')!.shown, false, '用户删掉了这一格就必须收起来')
})

test('updateStatusBar 会顺带刷新广播格子（不用等下一次事件）', () => {
  const a = addSession('#1 a')
  updateStatusBar()
  assert.equal(slotItem('broadcast')?.shown ?? false, false)
  setBroadcastTargets([a])
  updateStatusBar()
  assert.equal(slotItem('broadcast')!.shown, true)
})

// ---- 命令：一个入口管开、改、关 ----

test('没有会话时给出明确说明，不弹一个空列表', async () => {
  await toggleBroadcast()
  assert.match(infoMessages.join('\n'), /还没有堡垒机会话/)
  assert.equal(quickPickCalls.length, 0, '没会话就不该弹列表')
})

test('只有一个可写会话时拒绝开启，并说清为什么（广播给自己没意义）', async () => {
  addSession('#1 a')
  addSession('#2 ro', { readOnly: true })
  await toggleBroadcast()
  assert.equal(quickPickCalls.length, 0)
  assert.match(infoMessages.join('\n'), /只读会话不参与广播/)
})

test('勾选后生效：目标写入状态、底栏跟着出现（状态和显示不脱节）', async () => {
  addSession('#1 a')
  addSession('#2 b')
  addSession('#3 c')
  const options = { canPickMany: true }
  queueQuickPickResponse((items: unknown[]) => [items[1], items[2]])
  await toggleBroadcast()
  assert.equal((quickPickCalls[0].options as typeof options).canPickMany, true, '必须多选')
  assert.equal(getBroadcastTargets().length, 2)
  assert.equal(slotItem('broadcast')!.shown, true)
  assert.match(infoMessages.join('\n'), /广播输入已开启：2 个会话/)
})

test('取消（Esc）什么都不改：这个命令也用来「看一眼现在广播到哪几台」', async () => {
  const a = addSession('#1 a')
  addSession('#2 b')
  setBroadcastTargets([a])
  await toggleBroadcast()
  assert.deepEqual(getBroadcastTargets(), [a], 'Esc 不该把已开的广播关掉')
})

test('全部取消勾选 = 真的关闭广播（不是只改了显示）', async () => {
  const a = addSession('#1 a')
  const b = addSession('#2 b')
  setBroadcastTargets([a, b])
  updateBroadcastSlot()
  queueQuickPickResponse(() => [])
  await toggleBroadcast()
  assert.deepEqual(getBroadcastTargets(), [], '状态必须真的清空')
  assert.equal(slotItem('broadcast')!.shown, false, '底栏那一格要跟着收起来')
  assert.match(infoMessages.join('\n'), /已关闭广播输入/)
})

test('只读会话不会因为列表里出现过就被写进目标', async () => {
  const a = addSession('#1 a')
  addSession('#2 b')
  addSession('#3 ro', { readOnly: true })
  // 用户"全选"了列表 —— 列表里本来就没有只读会话
  queueQuickPickResponse((items: unknown[]) => items)
  await toggleBroadcast()
  const targets = getBroadcastTargets()
  assert.equal(targets.length, 2)
  assert.ok(targets.includes(a))
})
