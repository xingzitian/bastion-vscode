/**
 * 连接与会话：建立/复用 SSH 连接、过堡垒机菜单落到目标机、多会话管理、只读模式、连接档案的增删。
 *
 * 「一次 MFA + 连接复用」的入口都在这：ensureConnection 拿共享连接，
 * openTerminal 在同一条连接上开新 shell。
 */

import * as vscode from 'vscode'
import { BastionTerminal, stripAnsi, type ScreenMark } from './terminal'
import { ConnectionManager, SharedConnection } from './connection'
import type { ConnectionProfile } from './profiles'
import { getProfiles, saveProfiles, getPassword, savePassword, deletePassword } from './profiles'
import type { BastionTreeItem } from './profilesTree'
import { stopForwardsOfConn } from './forward'
import {
  HOST_STEP, SHELL_STEP, AFTER_HOST_TIMING, AFTER_HOST_ORDER,
  planAfterHost, shouldSelectUser, resolveMenuHints, hintsToRegexes, detectPrompt,
  type MenuHints, type MenuHintKey, type MenuStep
} from './menu'
import { log } from './log'
import { sleep, nextSessionNo, setLastBastionTerminal, setLastBastionProfile } from './state'
import {
  ctx,
  terminals,
  manager,
  lastBastionTerminal,
  lastBastionProfile,
  reconnectNotified,
  activeIsBastion,
  profilesProvider,
  forwardProvider,
  activeSession
} from './state'
import { updateStatusBar, updateForwardSlot, updateReadOnlySlot } from './slots'

export interface ProfilePickItem extends vscode.QuickPickItem {
  profile?: ConnectionProfile
}

/** 获取或新建该档案的已认证连接（复用免 MFA；首次会提示密码/MFA） */
export async function ensureConnection(profile: ConnectionProfile): Promise<SharedConnection | undefined> {
  const existing = manager.get(profile)
  if (existing) {
    setLastBastionProfile(profile)
    attachReconnectNotice(existing, profile)
    return existing
  }

  let password = ''
  let passphrase = ''
  if (profile.authMethod === 'password') {
    password = await getPassword(ctx, profile.name)
    if (!password) {
      const p = await vscode.window.showInputBox({
        prompt: `密码（${profile.username}@${profile.host}）`,
        password: true,
        ignoreFocusOut: true
      })
      if (p === undefined) return undefined
      password = p
      const save = await vscode.window.showQuickPick(['不保存', '保存到本机（加密）'], { placeHolder: '是否保存密码？' })
      if (save === '保存到本机（加密）') {
        await savePassword(ctx, profile.name, password)
      }
    }
  } else if (profile.authMethod === 'key') {
    passphrase =
      (await vscode.window.showInputBox({ prompt: '私钥口令（无则回车）', password: true, ignoreFocusOut: true })) ?? ''
  }

  log(`新建连接（${profile.name}）`)
  const conn = manager.getOrCreate(profile, password, passphrase)
  setLastBastionProfile(profile)
  attachReconnectNotice(conn, profile)
  return conn
}

/** 断连时弹一次提示（带「重连」按钮），每个连接只挂一次避免多会话重复弹 */
export function attachReconnectNotice(conn: SharedConnection, profile: ConnectionProfile): void {
  if (reconnectNotified.has(conn)) return
  reconnectNotified.add(conn)
  conn.onClose(() => {
    reconnectNotified.delete(conn)
    // 连接没了，挂在它上面的端口转发也已经失效：必须清掉，
    // 否则状态栏会一直显示一堆早就断了的隧道（原来的 stopForwardsOfConn 导入了却没人调）
    stopForwardsOfConn(conn)
    forwardProvider.refresh()
    updateForwardSlot()
    updateReadOnlySlot()
    void vscode.window
      .showWarningMessage(`连接已断开（${profile.name} · ${profile.username}@${profile.host}）`, '重连')
      .then((sel) => {
        if (sel === '重连') void reconnect()
      })
  })
}

/** 一键重连最近使用的档案（复用 SecretStorage 里存的密码，免重新输入） */
export async function reconnect(): Promise<void> {
  const profile = lastBastionProfile
  if (!profile) {
    vscode.window.showWarningMessage('没有可重连的档案')
    return
  }
  await connectToProfile(profile)
}

/** 在共享连接上开一个 shell 终端（复用免 MFA） */
export function openTerminal(conn: SharedConnection, profile: ConnectionProfile, title: string): { term: BastionTerminal; vt: vscode.Terminal } {
  const term = new BastionTerminal(conn, profile)
  term.sessionNo = nextSessionNo()
  // 会话号前缀便于人区分、也便于 AI 用 bastion_exec 的 terminal 参数精确指定
  // （AI 那边是按 includes 匹配的，加了前缀仍能匹配 user@host）
  const numbered = vscode.workspace.getConfiguration('bastion').get<boolean>('sessionNumber', true)
  const location =
    vscode.workspace.getConfiguration('bastion').get<string>('terminalLocation', 'editor') === 'panel'
      ? vscode.TerminalLocation.Panel
      : vscode.TerminalLocation.Editor
  const vt = vscode.window.createTerminal({
    name: numbered ? `#${term.sessionNo} ${title}` : title,
    pty: term,
    location
  })
  term.attachTerminal(vt)
  terminals.set(vt, term)
  setLastBastionTerminal(term)
  log(`已创建会话 #${term.sessionNo}：${vt.name}（档案 ${profile.name}）`)
  void vscode.commands.executeCommand('setContext', 'bastion.hasSession', true)
  updateStatusBar()
  return { term, vt }
}

export async function connectToProfile(profile: ConnectionProfile): Promise<void> {
  const conn = await ensureConnection(profile)
  if (!conn) return
  // 手动连接：直接开 shell，堡垒机自己的选机/选用户菜单原样出现在终端里，由用户自己操作（不拦截）
  const { vt } = openTerminal(conn, profile, `${profile.username}@${profile.host}`)
  vt.show()
}

// ---- 部署任务 ----

/** 命令面板入口：先选档案再连接 */
export async function connect(): Promise<void> {
  const profile = await pickOrCreateProfile()
  if (!profile) return
  await connectToProfile(profile)
}

/** 侧边栏点击 / 右键「连接」 */
export function connectProfile(item?: BastionTreeItem): void {
  if (item && item.profile) {
    void connectToProfile(item.profile)
  } else {
    void connect()
  }
}

/**
 * menuStep / awaitScreen 只用到终端这几个方法。
 * 用**结构化类型**而不是直接写 BastionTerminal，测试里就能塞一个假终端
 * （否则要为了测「认不认得出菜单」去搭 SSH 连接，实际上永远测不到）。
 */
export interface ScreenReader {
  markOutput(): ScreenMark
  readSince(mark: ScreenMark, maxLines?: number): string
  settleScreen(mark: ScreenMark, opts?: { firstMs?: number; quietMs?: number; maxMs?: number }): Promise<boolean>
  getTail(maxLines?: number): string
}

/**
 * 等「这次操作之后画出来的画面」里出现某一类提示，返回匹配到的东西（null = 没等到）。
 *
 * 为什么要**循环**：堡垒机查完资产库之后常常**分几段画**屏（先表头、再表格、再提示），
 * 段与段之间有短暂停顿。只等一次静止就可能在「画了一半」时被判成没认出来 ——
 * 这正是用户反复遇到的「菜单明明出来了，日志里也看得见，就是没捕获到」。
 *
 * 所以：等一段静止 → 拿**从头累积**的画面去匹配 → 没认出来就再等下一段，最多 4 轮。
 * 匹配用的是累积画面（从 mark 起），所以第 2 段的表头不会把第 1 段的提示挤掉。
 */
export async function awaitScreen<T>(
  term: ScreenReader,
  mark: ScreenMark,
  match: (screen: string) => T | null,
  budgetMs: number,
  quietMs = 900
): Promise<{ hit: T | null; screen: string }> {
  let waitMark = mark
  let screen = ''
  for (let round = 0; round < 4; round++) {
    const left = budgetMs - (Date.now() - mark.at)
    if (left <= 0) break
    const got = await term.settleScreen(waitMark, { firstMs: left, quietMs, maxMs: left })
    screen = term.readSince(mark, 40)
    const hit = match(screen)
    if (hit) return { hit, screen }
    if (!got) break // 一直没有新数据 → 别再空转
    waitMark = term.markOutput() // 又画了一段还没认出来 → 接着等下一段
  }
  return { hit: null, screen: screen || term.readSince(mark, 40) }
}

/**
 * 走一步菜单导航：等这一屏画完，读屏幕，看认不认得出来；认不出来就退回固定等待。
 * 返回 true = 认出来了（快且不怕慢），false = 走的兜底等待。
 *
 * 实现要点（这是第 N 版，前几版都栽在同一件事上）：
 * **不在数据流里找提示文本，而是等屏幕静止后读「这次的整屏」。**
 *
 * 数据流里的文字不可信：
 *   - 逐块剥离 ANSI 会把被 TCP 分块的转义序列切碎（`输\x1b[32m入`）；
 *   - 堡垒机画菜单是「一屏一屏刷」，夹着 `\r` 回行覆盖和光标移动，
 *     同一处在数据流里叠了好几遍，跟屏幕上真正显示的不是一回事。
 * 而 readSince() 拿到的是「去 ANSI + `\r` 只留最后一段」的整段文字，
 * 正好等于日志里那份 dump 出来的干净原文 —— 那份原文是能被规则匹配上的，
 * 所以这条路是对的。
 *
 * sourcesOf 可以覆盖「这一步用哪些规则」，用来区分强/弱特征：
 * 第一次等主菜单时裸提示符（Opt>）也算数；但判断「IP 被拒绝、又回到输 IP」
 * 只能用强特征 —— 见 menu.ts 里 hostPromptLoose 的说明。
 *
 * @param mark 可选：从这一刻开始等。传了就用它 —— 提示可能在本函数被调用前就到了
 *             （比如刚写完 userChoice，shell 提示符紧跟着出来），
 *             这时再打一个新标记会傻等一个「永远不会来的新数据」。
 */
export async function menuStep(
  term: ScreenReader,
  step: MenuStep,
  hints: MenuHints,
  sourcesOf?: (h: MenuHints) => string[],
  mark?: ScreenMark
): Promise<boolean> {
  const t0 = Date.now()
  if (step.settleMs > 0) await sleep(step.settleMs) // 先静置，避免把刚敲进去的回显误当提示
  const sources = sourcesOf ? sourcesOf(hints) : hints[step.key]
  const re = hintsToRegexes(sources)
  const matched = (text: string): boolean => re.some((r) => r.test(text))

  const m = mark ?? term.markOutput()

  // 先看**手上已经有的画面**：菜单/提示符很可能在我们开始等之前就画好了 ——
  // 实测这是最常见的情况（主菜单 400ms 就命中，靠的就是这里）。
  //   有 mark  → 看标记之后的部分（就是这次操作画出来的）
  //   没有 mark → 只有 includeBuffered 这一步允许看全部（第一次等主菜单）
  const first = mark ? term.readSince(m, 40) : step.includeBuffered ? term.getTail(40) : ''
  if (first && matched(first)) {
    log(`菜单导航「${step.label}」命中提示文本（${Date.now() - t0}ms，画面已经在手上）`)
    return true
  }

  const firstMs = step.timeoutMs
  await term.settleScreen(m, { firstMs, quietMs: 700, maxMs: firstMs + 6000 })
  if (matched(term.readSince(m, 40))) {
    log(`菜单导航「${step.label}」命中提示文本（${Date.now() - t0}ms）`)
    return true
  }
  // 认不出来：退回固定等待，等价于改造前的行为 —— 最坏情况不会更差
  log(`菜单导航「${step.label}」未识别到提示，退回固定等待 ${step.fallbackMs}ms`)
  dumpScreenForHints(term, step.key, term.readSince(m, 25))
  if (step.fallbackMs > 0) await sleep(step.fallbackMs)
  return false
}

/**
 * 把未识别那一步的终端原文打到日志，并指出该改哪个设置。
 *
 * 没有这段文字，用户只能看着「未识别到提示」发愣 —— 既不知道自己的菜单长什么样，
 * 也没法把规则填进设置，这就成了死路。有了它，用户复制粘贴到 bastion.menuHints.*
 * 就能自己修好，不用等作者改代码。
 */
function dumpScreenForHints(term: ScreenReader, hintKey: MenuHintKey, screen = term.getTail(25)): void {
  const key = `bastion.menuHints.${hintKey}`
  log(`——— 这一步没认出来的终端原文（对照它改 ${key}）———`)
  for (const line of screen.split('\n')) {
    if (line.trim()) log(`| ${line}`)
  }
  log(`——— 原文结束 ———`)
  // 分清两种「没认出来」，否则用户不知道该改配置还是该留空 userChoice：
  //   屏幕上有菜单特征 → 是我们的规则没覆盖到，补一条正则就行
  //   屏幕上没有菜单特征 → 很可能压根没这一步（已经进目标机了），留空 userChoice 最省事
  const plain = stripAnsi(screen)
  const looksLikeMenu = /^\s*\d+\s*[).、]\s+\S/m.test(plain) || /[A-Za-z\u4e00-\u9fa5]{1,10}>\s*$/m.test(plain)
  log(
    looksLikeMenu
      ? `判断：屏幕上有「编号列表 / xxx> 提示符」—— **是菜单，只是规则没认出来**。把上面那句提示写成正则填进 ${key} 即可。`
      : `判断：屏幕上没有菜单特征 —— **很可能压根没有这一步**（已经直接进目标机了）。把该任务/档案的 userChoice 留空可省掉这段等待。`
  )
}

/**
 * 过堡垒机菜单落到目标机。**这一步是有分支的：**
 *
 * - 普通账号：输完 IP → 弹「选登录用户」菜单 → 选完才进目标机
 * - 管理员账号：输完 IP → **没有选用户这一步，直接进 shell**
 *
 * 所以输完 IP 之后同时等三类界面（选用户菜单 / shell 提示符 / 又回到输 IP），
 * 按先到的那个走。老实现是傻等选用户菜单，超时后还会把用户序号
 * 打进已经进去的 shell 里（执行了一条叫 `1` 的命令），既慢又错位。
 */
export async function openSessionToHost(
  conn: SharedConnection,
  profile: ConnectionProfile,
  host: string,
  userChoice: string
): Promise<{ term: BastionTerminal; vt: vscode.Terminal }> {
  const { term, vt } = openTerminal(conn, profile, `${profile.username}@${host}`)
  vt.show()

  const cfg = vscode.workspace.getConfiguration('bastion')
  const hints = resolveMenuHints((k) => cfg.get(`menuHints.${k}`))
  const selectUser = shouldSelectUser(userChoice)

  // 1) 等主菜单出现（菜单可能在我们开始等之前就画好了，所以允许看已有缓冲）
  //    这一步可以把「弱特征」（裸提示符 Opt>）也算上 —— 第一次识别，宽松点没坏处
  await menuStep(term, HOST_STEP, hints, (h) => [...h.hostPrompt, ...h.hostPromptLoose])

  // 2) 输目标机。
  //    **先打屏幕标记再写** —— 后面只认标记之后画出来的画面，
  //    否则滚动缓冲里那份旧主菜单会让「又回到输 IP」误命中。
  const mark = term.markOutput()
  await term.write(`${host}\r`)

  // 3) 分支：等「选用户菜单 / shell 提示符 / 又回到输 IP」里先到的那个。
  //    分几段画的屏由 awaitScreen 负责多等几轮（见它的注释）。
  const tWait = Date.now()
  const keys: MenuHintKey[] = selectUser ? AFTER_HOST_ORDER : ['shellPrompt']
  // 顺序即优先级：同时命中时靠前的赢（选用户菜单优先于 shell 提示符）
  const judge = (text: string): MenuHintKey | null => keys.find((k) => detectPrompt(text, k, hints)) ?? null
  const { hit: matchedKey } = await awaitScreen(term, mark, judge, AFTER_HOST_TIMING.timeoutMs)
  if (matchedKey) {
    // 打出耗时：有些堡垒机查资产库很慢，这个数字能直接说明「菜单到底多久才出来」
    log(`菜单导航「输目标机后」命中「${matchedKey}」（${Date.now() - tWait}ms）`)
  }

  const plan = planAfterHost(matchedKey, selectUser)
  log(`菜单导航「输目标机后」：${plan.reason}`)

  if (plan.fail) {
    throw new Error(`连接 ${host} 失败：${plan.fail}`)
  }

  // 4) 需要的话选用户，然后等 shell。
  //    选用户之前打标记：shell 提示符可能在 menuStep 被调用前就到了，
  //    那样它能立刻命中，而不是白等一个「不会来的新数据」。
  let shellMark: ScreenMark = mark
  if (plan.sendUserChoice) {
    if (!matchedKey) {
      // 兜底路径：先按老行为等一会，再发 userChoice
      // 但**发之前**先把屏幕打出来 —— 否则日志里看不出「到底有没有选用户菜单」，
      // 用户就没法判断该不该把 userChoice 留空。
      await sleep(AFTER_HOST_TIMING.fallbackSleepMs)
      log('菜单导航「输目标机后」兜底前，先看一眼屏幕上有没有选用户菜单：')
      dumpScreenForHints(term, 'userPrompt', term.readSince(mark, 25))
    }
    shellMark = term.markOutput()
    await term.write(`${userChoice || '1'}\r`)
  }

  // 5) 等目标机 shell 提示符
  if (plan.waitShell) {
    await menuStep(term, SHELL_STEP, hints, undefined, shellMark)
  }
  return { term, vt }
}

/**
 * 命令：多会话快速切换（点状态栏触发）。
 *
 * 注意：以前「只有 1 个会话」时这里直接 show() 就返回了 —— 如果那个终端本来就可见，
 * 点了等于没反应，看起来就像「按钮点不动」。所以现在无论几个会话都弹列表，
 * 并额外带上「新建连接」，保证点了一定有可见反馈。
 */
export async function pickSession(): Promise<void> {
  const entries = [...terminals.entries()]
  log(`状态栏点击：切换会话（当前 ${entries.length} 个会话）`)
  if (entries.length === 0) {
    await connect()
    return
  }
  const items: Array<{ label: string; description: string; action: 'show' | 'new'; vt?: vscode.Terminal }> = entries.map(
    ([vt, t]) => ({
      label: `${t.isReadOnly ? '$(lock)' : '$(terminal)'} #${t.sessionNo} ${vt.name.replace(/^#\d+\s*/, '')}`,
      description: vscode.window.activeTerminal === vt ? '当前活动' : `${t.conn.profile.name} · 点击聚焦`,
      action: 'show' as const,
      vt
    })
  )
  items.push({ label: '$(add) 新建连接…', description: '再开一个堡垒机会话', action: 'new' })

  const pick = await vscode.window.showQuickPick(items, { placeHolder: '切换到会话' })
  if (!pick) return
  if (pick.action === 'new') {
    await connect()
    return
  }
  if (pick.vt) {
    pick.vt.show()
    log(`已切到会话 ${pick.vt.name}`)
  }
}

/** 命令：切换当前会话的只读模式（生产防手滑） */
export function toggleReadOnly(): void {
  const s = activeSession()
  log(`状态栏/命令面板：切换只读模式（活动会话 ${s ? s.vt.name : '无'}）`)
  if (!s) {
    vscode.window.showWarningMessage('没有活动的堡垒机会话')
    return
  }
  const on = s.term.setReadOnly(!s.term.isReadOnly)
  updateStatusBar() // 会话 tooltip 里也带只读状态，一起刷新
  log(`${on ? '开启' : '关闭'}只读模式：${s.vt.name}`)
  vscode.window.setStatusBarMessage(
    on ? `$(lock) 已开启只读：${s.vt.name}（键盘输入被拦截）` : `$(unlock) 已关闭只读：${s.vt.name}`,
    4000
  )
}

export async function addProfile(): Promise<void> {
  const p = await createProfile()
  if (p) profilesProvider.refresh()
}

export async function deleteProfile(item: BastionTreeItem): Promise<void> {
  if (!item || !item.profile) return
  const confirm = await vscode.window.showWarningMessage(
    `删除档案「${item.profile.name}」（${item.profile.username}@${item.profile.host}）？`,
    { modal: true },
    '删除'
  )
  if (confirm !== '删除') return
  const profiles = getProfiles(ctx)
  const idx = profiles.findIndex(
    (p) => p.name === item.profile!.name && p.host === item.profile!.host && p.username === item.profile!.username
  )
  if (idx >= 0) profiles.splice(idx, 1)
  saveProfiles(ctx, profiles)
  await deletePassword(ctx, item.profile!.name)
  profilesProvider.refresh()
}

export async function pickOrCreateProfile(): Promise<ConnectionProfile | undefined> {
  const profiles = getProfiles(ctx)
  const items: ProfilePickItem[] = [
    ...profiles.map((p) => ({ label: `${p.name}  (${p.username}@${p.host})`, profile: p })),
    { label: '$(add) 新建连接档案…' }
  ]
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择连接档案或新建' })
  if (!picked) return undefined
  if (picked.profile) return picked.profile
  return createProfile()
}

export async function createProfile(): Promise<ConnectionProfile | undefined> {
  const name = await vscode.window.showInputBox({ prompt: '档案名', placeHolder: '生产堡垒机', ignoreFocusOut: true })
  if (!name) return undefined
  const host = await vscode.window.showInputBox({ prompt: '主机', ignoreFocusOut: true })
  if (!host) return undefined
  const portStr = await vscode.window.showInputBox({ prompt: '端口', value: '22', ignoreFocusOut: true })
  const username = await vscode.window.showInputBox({ prompt: '用户名', value: 'root', ignoreFocusOut: true })
  if (!username) return undefined
  const modePick = await vscode.window.showQuickPick(
    [
      { label: '直接 SSH', description: '普通服务器：登录后直接进 shell', mode: 'direct' as const },
      { label: '堡垒机', description: '登录后需过菜单选目标机/用户', mode: 'bastion' as const }
    ],
    { placeHolder: '连接模式' }
  )
  const authMethod = await vscode.window.showQuickPick(['password', 'key'], { placeHolder: '认证方式' })

  const profile: ConnectionProfile = {
    name,
    host,
    port: parseInt(portStr || '22', 10) || 22,
    username,
    authMethod: authMethod === 'key' ? 'key' : 'password',
    mode: modePick?.mode === 'direct' ? 'direct' : 'bastion'
  }
  if (authMethod === 'key') {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: '选择私钥'
    })
    if (uris && uris.length > 0) {
      profile.privateKeyPath = uris[0].fsPath
    }
  }

  const profiles = getProfiles(ctx)
  profiles.push(profile)
  saveProfiles(ctx, profiles)
  return profile
}

