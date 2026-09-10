// 菜单导航的「捕获」能力：这一组测试就是钉住用户反复遇到的那个问题 ——
// 菜单明明已经画在屏幕上了，程序却没认出来。
//
// 关键点（都用测试钉住了，改回去会红）：
//   1. 认不认得出来，看的是**屏幕上渲染出来的文字**（去 ANSI + `\r` 只留最后一段），
//      不是在原始数据流里找子串；
//   2. 每次操作**先打屏幕标记**，只看标记之后画出来的画面 ——
//      否则滚动缓冲里的旧菜单会让「IP 被拒绝」误判；
//   3. 堡垒机**分几段画屏**时要多等几轮，不能「画了一半」就判没认出来。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tailText, safeReadStart, type ScreenMark } from '../terminal'
import { menuStep, awaitScreen, type ScreenReader } from '../sessions'
import {
  DEFAULT_MENU_HINTS as H,
  HOST_STEP,
  AFTER_HOST_ORDER,
  detectPrompt,
  type MenuHintKey,
  type MenuStep
} from '../menu'

/**
 * 假终端：按「段」往外吐输出，模拟堡垒机一屏一屏画。
 * settleScreen 每次调用就交付下一段（有交付 → true，没交付 → false），
 * 所以测试不需要真等 —— 但也**不能假装时间在动**：
 * mark.at 必须是真实时间戳，否则 awaitScreen 算剩余预算时会立刻超时。
 */
class FakeScreen implements ScreenReader {
  buf = ''
  /** 待交付的「段」；每段模拟一次画屏（中间有停顿） */
  private pending: string[] = []
  /** settleScreen 被调用了几次 —— 用来断言「没有白等」 */
  settleCalls = 0

  /** 预先排好接下来会画出来的段 */
  schedule(...segments: string[]): this {
    this.pending.push(...segments)
    return this
  }

  /** 直接往缓冲里塞内容（模拟「我们开始等之前就已经画好了」） */
  preload(text: string): this {
    this.buf += text
    return this
  }

  markOutput(): ScreenMark {
    return { at: Date.now(), len: this.buf.length }
  }

  readSince(mark: ScreenMark, maxLines = 40): string {
    return tailText(this.buf.slice(safeReadStart(this.buf, mark.len)), maxLines)
  }

  async settleScreen(): Promise<boolean> {
    this.settleCalls++
    const next = this.pending.shift()
    if (next === undefined) return false
    this.buf += next
    return true
  }

  getTail(maxLines = 80): string {
    return tailText(this.buf, maxLines)
  }
}

/** 用很小的等待参数，测试不必真等 */
const FAST_HOST_STEP: MenuStep = { ...HOST_STEP, settleMs: 0, fallbackMs: 0, timeoutMs: 50 }
const FAST_SHELL_STEP: MenuStep = { ...FAST_HOST_STEP, key: 'shellPrompt', label: 'shell', includeBuffered: false }

/** 某厂商堡垒机实测的主菜单（原文照抄，含真实措辞） */
const REAL_HOST_MENU = [
  ' 1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).',
  ' 2) 输入 / 进行搜索.',
  ' 6) 输入 d 进行显示您有权限的数据库.',
  'Opt> Opt>'
].join('\r\n')

/** 某厂商堡垒机实测的选用户菜单 */
const REAL_USER_MENU = [
  '  ID    | 名称                    | 用户名',
  '--------+-------------------------+---------',
  '  1     | deploy                | deploy',
  '提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID',
  '返回：B/b',
  'ID>'
].join('\r\n')

test('主菜单：已经在画面上时立刻命中，不去白等新数据', async () => {
  const t = new FakeScreen().preload(REAL_HOST_MENU)
  const hit = await menuStep(t, FAST_HOST_STEP, H, (h) => [...h.hostPrompt, ...h.hostPromptLoose])
  assert.equal(hit, true)
  assert.equal(t.settleCalls, 0, '画面已经在手上，一次都不该等')
})

test('主菜单：稍后才画出来也能捕获（等新画面 → 读屏 → 匹配）', async () => {
  const t = new FakeScreen().schedule(REAL_HOST_MENU)
  const hit = await menuStep(t, { ...FAST_HOST_STEP, includeBuffered: true }, H)
  assert.equal(hit, true)
})

test('主菜单：裸提示符 Opt>（弱特征）在第一次识别时算数', async () => {
  // 只有提示符、没有任何菜单正文 —— 这正是「直接进去还是 opt」那种画面
  const t = new FakeScreen().schedule('Opt> Opt> ')
  const hit = await menuStep(t, { ...FAST_HOST_STEP, includeBuffered: true }, H, (h) => [
    ...h.hostPrompt,
    ...h.hostPromptLoose
  ])
  assert.equal(hit, true, '第一次等主菜单时允许用弱特征')
})

test('已经在目标机上：认不出菜单，如实返回 false 并退回兜底等待', async () => {
  const t = new FakeScreen().schedule('[root@test-node-10.0.0.10 ~]# ')
  const hit = await menuStep(t, FAST_HOST_STEP, H)
  assert.equal(hit, false, '屏幕上是 shell 提示符而不是菜单 → 不该硬说命中了主菜单')
})

test('分几段画屏：表头和表格分开到达，仍然能认出来', async () => {
  const t = new FakeScreen().schedule(
    '  ID    | 名称                    | 用户名\r\n',
    '  1     | deploy                | deploy\r\n',
    '提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID\r\n',
    'ID>'
  )
  const mark = t.markOutput()
  const judge = (s: string): MenuHintKey | null => (detectPrompt(s, 'userPrompt', H) ? 'userPrompt' : null)
  const { hit } = await awaitScreen(t, mark, judge, 5000)
  assert.equal(hit, 'userPrompt', '分四段画出来也要认出来')
})

test('只看标记之后的新画面：旧菜单留在缓冲里也不能算命中', async () => {
  // 场景：主菜单已经画过（留在滚动缓冲里），现在输了 IP、屏幕还没更新
  const t = new FakeScreen().preload(REAL_HOST_MENU)
  const mark = t.markOutput()
  // 缓冲里明明有主菜单的强特征……
  assert.equal(detectPrompt(t.getTail(40), 'hostPrompt', H), true, '前提：旧菜单确实还在缓冲里')
  // ……但以标记之后为空，就不该被当成「又回到输 IP」
  assert.equal(detectPrompt(t.readSince(mark, 40), 'hostPrompt', H), false, '旧画面不能算这次的新画面')
})

test('IP 没被接受：新画面又画了一遍主菜单 → 判成 hostPrompt', async () => {
  const t = new FakeScreen().preload(REAL_HOST_MENU)
  const mark = t.markOutput()
  t.schedule('Opt> Opt> 10.0.0.99\r\n' + REAL_HOST_MENU) // 堡垒机重新画主菜单
  const judge = (s: string): MenuHintKey | null =>
    AFTER_HOST_ORDER.find((k) => detectPrompt(s, k, H)) ?? null
  const { hit } = await awaitScreen(t, mark, judge, 5000)
  assert.equal(hit, 'hostPrompt', '真回到输 IP 就该判 hostPrompt（旧菜单残留不算）')
})

test('管理员账号：没有选用户这一步，输完 IP 直接出现 shell 提示符', async () => {
  const t = new FakeScreen().preload(REAL_HOST_MENU)
  const mark = t.markOutput()
  t.schedule('Opt> Opt> 10.0.0.10\r\nLast login: Mon Jan  1\r\n[root@test-node ~]# ')
  const judge = (s: string): MenuHintKey | null =>
    AFTER_HOST_ORDER.find((k) => detectPrompt(s, k, H)) ?? null
  const { hit } = await awaitScreen(t, mark, judge, 5000)
  assert.equal(hit, 'shellPrompt', '直接进 shell 就该走 shellPrompt 分支，不该傻等选用户菜单')
})

test('选用户菜单优先于 shell 提示符（同一屏里同时像的时候）', async () => {
  const t = new FakeScreen().schedule(REAL_USER_MENU + '\r\n[root@other ~]# ')
  const mark = t.markOutput()
  const judge = (s: string): MenuHintKey | null =>
    AFTER_HOST_ORDER.find((k) => detectPrompt(s, k, H)) ?? null
  const { hit } = await awaitScreen(t, mark, judge, 5000)
  assert.equal(hit, 'userPrompt', 'AFTER_HOST_ORDER 的顺序就是优先级')
})

test('已经进 shell 时，SHELL_STEP 用传进来的标记立刻命中（不白等一轮）', async () => {
  // 模拟真实调用顺序：先打标记 → 写 userChoice → shell 提示符在 menuStep 之前就到了
  const t = new FakeScreen()
  const shellMark = t.markOutput()
  t.preload('Last login: Mon Jan  1\r\n[root@test-node ~]# ')
  const hit = await menuStep(t, FAST_SHELL_STEP, H, undefined, shellMark)
  assert.equal(hit, true, '提示已经在了，靠传进来的标记应当立刻认出来')
  assert.equal(t.settleCalls, 0, '不该再去等一个「不会来的新数据」')
})

test('兜底路径不会无限等：屏幕上一直没有数据就按时返回 false', async () => {
  const t = new FakeScreen()
  const t0 = Date.now()
  const hit = await menuStep(t, { ...FAST_SHELL_STEP, timeoutMs: 30 }, H)
  assert.equal(hit, false)
  assert.ok(Date.now() - t0 < 2000, '兜底必须是有限等待，不能挂住整个连接流程')
})
