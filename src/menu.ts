/**
 * 堡垒机菜单导航的「提示文本」识别。
 *
 * 背景：原来 openSessionToHost 全靠固定 sleep 串起来
 * （等 5 秒 → 输 IP → 等 3 秒 → sleep 1.5 秒 → 选用户 → sleep 2 秒）。
 * 网络慢一拍就错位 —— IP 打进一半、用户序号发给了还没画完的菜单。
 * 而这条路径是 AI 连接、批量部署、批量连接共用的。
 *
 * 新策略：**等到认得出来的提示就立刻走，认不出来就按原来的固定时长兜底。**
 * 这样最坏情况退化成改造前的行为（不会更差），常见情况能快 3 秒左右，
 * 而且菜单画得慢也不会错位。
 *
 * 为什么是「可覆盖的正则」而不是写死：齐治 / JumpServer / 各家自研的菜单文案都不一样，
 * 我在开发机上没法遍历。所以内置一套常见写法，同时留设置项让你直接改，不用等我。
 *
 * 规则来源优先级：VS Code 设置 > 共享文件（~/.bastionshell/menuHints.jsonc）> 内置默认。
 * 共享文件是**两个实现读同一份**的（见 menuHintsFile.ts），桌面版也读它。
 */

import { mergeMenuHints, readMenuHintsOverride } from './menuHintsFile'

export type MenuHintKey = 'hostPrompt' | 'hostPromptLoose' | 'userPrompt' | 'assetPrompt' | 'shellPrompt'

export interface MenuHints {
  /**
   * 主菜单的**强特征**：菜单正文里的措辞。
   * 用于两处：① 第一次等主菜单 ② 判断「IP 被拒绝、菜单又回到输 IP」。
   */
  hostPrompt: string[]
  /**
   * 主菜单的**弱特征**：只有提示符本身（如 `Opt>`、`ID>`）。
   * ⚠️ 只用于「第一次等主菜单」，**绝不能用于「又回到输 IP」的判断** ——
   * 因为输完 IP 后那行回显长这样：`Opt> Opt> 10.0.0.10`，
   * 堡垒机只要重画一次提示符就会被误判成「IP 被拒绝」而白白报错。
   */
  hostPromptLoose: string[]
  /** 二级菜单：提示你选登录用户 */
  userPrompt: string[]
  /**
   * **资产列表**：一个 IP 搜出多条资产时要你先选一条（输资产 ID）。
   *
   * 为什么必须和 userPrompt 分开认：两张表长得像（都是「编号 + 表」+ 等你输 ID），
   * 但语义完全不同 —— 一个是「用哪个账号登」，一个是「登哪台机器」。
   * 认错了就会把用户序号当成资产 ID 发出去（或者反过来），登录到**错的机器**上。
   *
   * 实测原文（用户真机）：
   *   `提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n`
   *   `搜索：172.20.30.143`（末行是搜索框回显）
   */
  assetPrompt: string[]
  /** 已落到目标机：shell 提示符出现 */
  shellPrompt: string[]
}

/**
 * 内置默认。注意刻意写得「具体」：
 * 宁可认不出来退回固定等待，也不要靠模糊模式抢跑 —— 抢跑比慢更糟。
 *
 * 里面的写法都是**实测过的真实菜单**，不是猜的：
 * - 某厂商堡垒机（已实测，见下面 hostPrompt 的注释）
 * - JumpServer / 齐治常见写法
 * 认不出来的会自动退回固定等待，并且把屏幕原文打进日志（见 sessions.ts 的 dumpScreenForHints），
 * 照着自己那家的文案补一条即可 —— 不用等作者改代码。
 */
export const DEFAULT_MENU_HINTS: MenuHints = {
  hostPrompt: [
    // 某厂商堡垒机实测（原文见 test/menu.test.ts）：
    //   「1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).」
    //   「6) 输入 d 进行显示您有权限的数据库.」
    '进行搜索',
    // 注意「输入」和「IP/主机名」之间可能夹着东西，别把距离卡太死
    '(?:请输入|请选择|输入|选择)[^\\n]{0,40}(地址|IP|主机名|主机|资产|设备|节点|编号|数据库|kubernetes)',
    '(?:搜索|查找)[^\\n]{0,16}(资产|主机|设备)',
    '(?:资产|主机|设备|节点)[^\\n]{0,10}[:：>]\\s*$',
    // 英文界面：这台堡垒机支持中/英/日切换，所以同一套菜单可能是英文
    '(?:please\\s+)?(?:input|enter|select|search)[^\\n]{0,30}(?:host|ip|asset|node|device|database)'
  ],
  hostPromptLoose: [
    // 纯提示符。某厂商的是 `Opt>`，**而且会重复打印成 `Opt> Opt>`** ——
    // 所以不要锚定行尾（第一版写成 ^\s*opt>\s*$ 就栽在这，永远匹配不上）。
    '^\\s*opt>',
    // 新加坡那台是 `[Host]>`
    '^\\s*\\[host\\]>'
  ],
  userPrompt: [
    // 某厂商堡垒机实测：二级菜单是一张账号表 + 提示 + `ID>` 提示符
    //   「提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID」
    // 方括号里是资产名，长度不定 → 间隔放宽到 80
    '输入[^\\n]{0,80}(账号|账户|用户)\\s*ID',
    '^\\s*id>',
    // 账号表表头（很具体，不会误伤）
    '名称[^\\n]{0,20}用户名',
    '(?:请)?(?:选择|输入)[^\\n]{0,20}(用户|账号|账户|登录用户)',
    '(?:登录)?(?:用户|账号|账户)[^\\n]{0,10}[:：>]\\s*$',
    '(?:select|choose|login)[^\\n]{0,20}(?:user|account)',
    '(?:user|account|username)[^\\n]{0,20}[:：>]\\s*$'
  ],
  shellPrompt: [
    '[\\w.\\-]{1,32}@[\\w.\\-]{1,64}[:~][^\\n]{0,60}[$#]\\s*$',
    '\\][$#]\\s*$',
    // bash-4.2$ 这类「不以 user@host 开头」的提示符：要求 $/# 前面紧挨着的是
    // 字母数字或 )/]，这样 `#######` 这种装饰性分隔行不会被误判成提示符
    '(?:^|\\n)[^\\n#]{0,40}[A-Za-z0-9)\\]][$#]\\s*$',
    '(?:^|\\n)\\s*[#$]\\s*$'
  ],
  assetPrompt: [
    // ⚠️ 这一组必须写得**窄**：主菜单里也常出现「请输入资产名称/资产编号」，
    // 一旦被当成资产列表，主菜单那一步就会走错分支。所以只认带 ID 的写法。
    // 实测原文：提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192
    '资产\\s*ID\\s*直接登录',
    '(?:输入|请选择|选择)[^\\n]{0,8}资产\\s*ID',
    // 资产表页脚（账号表没有这个）
    '总数量\\s*[:：]\\s*\\d+',
    '(?:input|enter|select)[^\\n]{0,12}asset\\s*id'
  ]
}

export interface MenuStep {
  key: MenuHintKey
  /** 日志里显示的步骤名 */
  label: string
  /** 等「新画面」出现的最长时间（出现了就再等它静止，然后读屏匹配） */
  timeoutMs: number
  /** 认不出提示时退回的固定等待 */
  fallbackMs: number
  /** 先静置这么久再开始看，避开「刚敲进去的回显」被误当提示 */
  settleMs: number
  /** 是否先把**已有画面**也看一遍（只有第一次等主菜单需要） */
  includeBuffered: boolean
}

/**
 * 等主菜单（提示输目标机）。这一步是确定的，没有分支。
 *
 * timeoutMs 只给 2.5 秒的道理：菜单通常在我们开始等之前就画好了，
 * 所以先查已有画面（includeBuffered），查到立刻返回 —— 实测 400ms 左右命中。
 * 真需要等新数据的情况很少，等太久也没意义：没有就是没有，兜底更快。
 */
export const HOST_STEP: MenuStep = {
  key: 'hostPrompt',
  label: '主菜单（输目标机）',
  timeoutMs: 2500,
  fallbackMs: 1200,
  settleMs: 400,
  includeBuffered: true
}

/** 等目标机 shell 提示符 */
export const SHELL_STEP: MenuStep = {
  key: 'shellPrompt',
  label: '目标机 shell 提示符',
  timeoutMs: 8000,
  fallbackMs: 2500,
  settleMs: 0,
  includeBuffered: false
}

/**
 * 输完目标机 IP 之后要等多久。
 * 这一步是**分支**：普通账号弹选用户菜单，管理员账号直接进 shell。
 *
 * ⚠️ timeoutMs 为什么给到 20 秒（实测教训）：
 * 某厂商的堡垒机在收到 IP 之后要**查一遍资产/账号库**，实测菜单要 8~10 秒才画出来。
 * 原来给 8 秒，正好差一点点 —— 每次都超时、退回兜底，白等一轮。
 *
 * 给长一点不会惩罚管理员账号：那种情况 shell 提示符很快就出现，
 * 同时看三类的逻辑会立刻命中 shellPrompt 提前返回，不会傻等满 20 秒。
 */
export const AFTER_HOST_TIMING = {
  timeoutMs: 20000,
  /** 认不出任何提示时的兜底：按老行为发 userChoice 再等 */
  fallbackSleepMs: 2000
}

/**
 * 输完 IP 之后，我们同时在等这几种界面。
 * **顺序即优先级** —— 万一同时命中，靠前的赢。
 *
 * `assetPrompt` 排最前：一个 IP 搜出多条资产时，堡垒机先让你选资产（输资产 ID），
 * 选完才轮到选账号。资产列表和账号表长得像，但它排前面 + 用**表结构**判定
 * （见 looksLikeAssetList），不会和账号表抢。
 */
export const AFTER_HOST_ORDER: MenuHintKey[] = ['assetPrompt', 'userPrompt', 'shellPrompt', 'hostPrompt']

export interface AfterHostPlan {
  /** 要不要把 userChoice 发出去 */
  sendUserChoice: boolean
  /** 要不要继续等 shell 提示符 */
  waitShell: boolean
  /** 屏幕上是一张资产列表：**先选资产 ID**，选完再继续（可能还要选用户） */
  pickAsset?: boolean
  /** 有值表示这一步该判失败（附原因） */
  fail?: string
  /** 日志用的一句话说明 */
  reason: string
}

/**
 * 输完目标机之后该怎么办。
 *
 * 这条逻辑来自一个真实问题：**有些管理员账号没有「选登录用户」这一步**，
 * 输完 IP 就直接进目标机了。旧实现会傻等选用户菜单超时，然后把用户序号
 * （默认 `1`）打进已经进去的 shell 里 —— 既白等 10 秒，又执行了一条叫 `1` 的
 * 命令，还让后续命令全部错位。
 *
 * 所以现在同时等「选用户菜单 / shell 提示符 / 又回到主菜单」，按先到的那个分支。
 *
 * @param matched 先等到了哪一类提示（null = 超时，什么都没认出来）
 * @param selectUser 配置上要不要选用户（userChoice 非空即为要）
 */
export function planAfterHost(matched: MenuHintKey | null, selectUser: boolean): AfterHostPlan {
  // 资产列表：先选资产 ID，再回来判下一步（选用户 / 直接进 shell）
  if (matched === 'assetPrompt') {
    return {
      sendUserChoice: false,
      waitShell: true,
      pickAsset: true,
      reason: '出现资产列表（一个 IP 匹配到多条资产），先选资产 ID 再继续'
    }
  }
  // 配置明确说了不选用户 → 直接等 shell
  if (!selectUser) {
    return {
      sendUserChoice: false,
      waitShell: true,
      reason: '配置为不选用户（userChoice 为空），跳过选用户步骤'
    }
  }
  if (matched === 'shellPrompt') {
    return {
      sendUserChoice: false,
      waitShell: false,
      reason: '这台机器没有选用户这一步（管理员账号输完 IP 直接进 shell），已跳过'
    }
  }
  if (matched === 'userPrompt') {
    return { sendUserChoice: true, waitShell: true, reason: '出现选用户菜单，发送 userChoice' }
  }
  if (matched === 'hostPrompt') {
    return {
      sendUserChoice: false,
      waitShell: false,
      fail: '又回到了「输入目标机」那一步，说明这个 IP 没被堡垒机接受（可能不存在、无权限或拼写有误）。请核对目标机地址后重试。',
      reason: '检测到菜单回到输 IP 步骤'
    }
  }
  // 超时：认不出提示。按老行为兜底 —— 老行为在「有选用户菜单」的正常场景下是对的，
  // 而这里分不清到底属于哪种，所以选「多数情况下正确」的那个。
  return {
    sendUserChoice: true,
    waitShell: true,
    reason: '没认出任何提示（超时），按老行为兜底发送 userChoice（如果这台机器其实不需要选用户，请把 userChoice 留空，或把菜单原文填进 bastion.menuHints.userPrompt）'
  }
}

/**
 * userChoice 是否表示「需要选用户」。
 *
 * 注意区分两种「空」：
 * - `undefined` = **没指定**，按默认走（选用户 1）—— AI 调用时常常不传这个参数
 * - `''`       = **明确不要选用户**，跳过这一步
 * 另外 `-` / `skip` / `none` 也当「不选」处理，方便在配置里写得可读一点。
 */
export function shouldSelectUser(userChoice: string | undefined): boolean {
  if (userChoice === undefined) return true
  const v = userChoice.trim().toLowerCase()
  return v !== '' && v !== '-' && v !== 'skip' && v !== 'none'
}

/** 把正则源码编译成 RegExp；坏正则跳过而不是让整条路径崩掉 */
export function hintsToRegexes(sources: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const src of sources) {
    try {
      out.push(new RegExp(src, 'im'))
    } catch {
      // 用户在设置里写错正则是常事，忽略这一条即可，不要连累其它
    }
  }
  return out
}

/**
 * 解析最终生效的提示正则：设置 > 共享文件 > 内置默认。
 *
 * - 设置里填了某一组 → 那一组**整组替换**（内置规则万一在某家堡垒机上误判，用户要能一键关掉）
 * - `~/.bastionshell/menuHints.jsonc`（**两个实现读同一份**）：可以按原文关掉某条内置规则、
 *   也可以追加自己那家堡垒机的提示语 —— 见 menuHintsFile.ts
 * - 都没有 → 内置默认
 */
export function resolveMenuHints(get: (key: string) => unknown): MenuHints {
  const fromSettings: Partial<Record<MenuHintKey, string[]>> = {}
  for (const key of ['hostPrompt', 'hostPromptLoose', 'userPrompt', 'assetPrompt', 'shellPrompt'] as MenuHintKey[]) {
    const v = get(key)
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      fromSettings[key] = v as string[]
    }
  }
  try {
    return mergeMenuHints(fromSettings, readMenuHintsOverride(), DEFAULT_MENU_HINTS)
  } catch {
    // 读共享文件出任何问题都退回内置默认：识别规则不该因为一个配置文件把会话搞坏
    return mergeMenuHints(fromSettings, {}, DEFAULT_MENU_HINTS)
  }
}

/** 一段输出里是否出现了某一类提示 */
export function detectPrompt(text: string, key: MenuHintKey, hints: MenuHints = DEFAULT_MENU_HINTS): boolean {
  const plain = stripAnsiForMatch(text)
  return hintsToRegexes(hints[key]).some((re) => re.test(plain))
}

// ───────────────────────── 资产列表（一个 IP 搜出多条） ─────────────────────────

/** 资产表里的一行 */
export interface AssetCandidate {
  /** 资产 ID（要打给堡垒机的那个数字） */
  id: string
  name: string
  address: string
  platform: string
  org: string
  note: string
}

/** 表头单元格 → 我们的字段 */
const ASSET_COLS: Array<{ key: keyof AssetCandidate; re: RegExp }> = [
  { key: 'name', re: /^(名称|名字|资产名|name)$/i },
  { key: 'address', re: /^(地址|ip|ip\s*地址|主机|主机名|address|host)$/i },
  { key: 'platform', re: /^(平台|系统|操作系统|类型|platform|os|type)$/i },
  { key: 'org', re: /^(组织|部门|分组|org|dept)$/i },
  { key: 'note', re: /^(备注|说明|描述|note|comment)$/i }
]
const ASSET_ID_COL = /^(id|编号|序号|资产\s*id|asset\s*id)$/i
/** 账号表的标志列：有它就不是资产表（两张表都有「ID + 名称」，靠这一列区分） */
const ACCOUNT_COL = /^(用户名|账号|账户|用户|user|username|account)$/i

/**
 * 把一行表格拆成单元格。
 * 优先按 `|` 拆（实测那家堡垒机就是这么画的）；没有竖线时按「2 个以上空格」拆。
 */
function splitCells(line: string): string[] {
  if (line.includes('|')) {
    const raw = line.split('|').map((c) => c.trim())
    // `| a | b |` 这种首尾竖线会多出空单元格，去掉才不会整体错位
    if (raw.length > 1 && raw[0] === '') raw.shift()
    if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()
    return raw
  }
  return line
    .trim()
    .split(/\s{2,}/)
    .map((c) => c.trim())
}

/**
 * 从一屏文字里解析资产表。
 *
 * 形状（实测原文）：
 * ```
 * ID | 名称                      | 地址          | 平台    | 组织     | 备注
 * -----+---------------------------+---------------+---------+----------+------
 *   1  | 172.20.30.143             | 172.20.30.143 | Linux   | 默认组织 |
 *   2  | 研发网域172.20.30.143     | 172.20.30.143 | Gateway | 默认组织 |
 * 页码：1，每页行数：23，总页数：1，总数量：2
 * 提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n
 * ```
 *
 * **靠表结构判定，不靠提示语**：必须同时有 ID 列、名称列，以及「地址/平台」列，
 * 且**不能有用户名/账号列** —— 后者是账号表的标志。这样同一台机器上
 * 「选资产」和「选账号」两张表不会被认成同一件事。
 */
export function parseAssetTable(screen: string): AssetCandidate[] {
  const plain = stripAnsiForMatch(screen)
  const lines = plain.split('\n')

  let headerIdx = -1
  let idIdx = -1
  const colIdx = new Map<keyof AssetCandidate, number>()

  for (let i = 0; i < lines.length; i++) {
    const cells = splitCells(lines[i])
    if (cells.length < 3) continue
    const idAt = cells.findIndex((c) => ASSET_ID_COL.test(c))
    if (idAt < 0) continue
    if (!cells.some((c) => ASSET_COLS.some((col) => col.key === 'name' && col.re.test(c)))) continue
    if (cells.some((c) => ACCOUNT_COL.test(c))) continue // 账号表，不是资产表
    const hasAssetish = cells.some((c) => ASSET_COLS.some((col) => col.key !== 'name' && col.re.test(c)))
    if (!hasAssetish) continue

    headerIdx = i
    idIdx = idAt
    for (const { key, re } of ASSET_COLS) {
      const at = cells.findIndex((c) => re.test(c))
      if (at >= 0) colIdx.set(key, at)
    }
    break
  }
  if (headerIdx < 0) return []

  const rows: AssetCandidate[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCells(lines[i])
    const id = (cells[idIdx] ?? '').trim()
    if (!/^\d+$/.test(id)) {
      // 分隔线（-----+-----）、页脚、空行都跳过；一旦已经开始收行，遇到非数据行就收工，
      // 免得把后面别的表（比如账号表）的行也吃进来
      if (rows.length > 0) break
      continue
    }
    const get = (k: keyof AssetCandidate): string => {
      const at = colIdx.get(k)
      return at === undefined ? '' : (cells[at] ?? '').trim()
    }
    rows.push({
      id,
      name: get('name'),
      address: get('address'),
      platform: get('platform'),
      org: get('org'),
      note: get('note')
    })
  }
  return rows
}

/**
 * 这一屏是不是「要你选资产」。
 *
 * 两个信号取或：① 提示语命中（可配置的 assetPrompt）；② 解析出了资产表。
 * 两个都要，是因为两边都可能缺：有的机型提示语不一样，有的屏被截断只剩表格。
 */
export function looksLikeAssetList(screen: string, hints: MenuHints = DEFAULT_MENU_HINTS): boolean {
  if (detectPrompt(screen, 'assetPrompt', hints)) return true
  return parseAssetTable(screen).length > 0
}

/**
 * 输完 IP 之后，这一屏属于哪一步。
 *
 * 顺序很关键：**先判资产列表**。资产表和账号表形状接近，但资产那一步在前，
 * 而且「选错资产」的代价是**登到错的机器上**，比多问一次严重得多。
 */
export function judgeAfterHost(
  screen: string,
  hints: MenuHints = DEFAULT_MENU_HINTS,
  selectUser = true
): MenuHintKey | null {
  if (looksLikeAssetList(screen, hints)) return 'assetPrompt'
  const keys = AFTER_HOST_ORDER.filter((k) => (selectUser ? true : k !== 'userPrompt'))
  return keys.find((k) => detectPrompt(screen, k, hints)) ?? null
}

/** 选资产的结论 */
export type AssetDecision =
  /** 直接用这个 ID（明确指定，或只有唯一候选） */
  | { kind: 'use'; id: string; candidate?: AssetCandidate; why: string }
  /** 得问人（候选 >1，或屏幕上认得出要选但没解析出表） */
  | { kind: 'ask'; why: string }

/**
 * 选哪条资产 —— **纯决策**，弹窗交给调用方（这样能单测）。
 *
 * 规则（顺序即优先级）：
 *   1. 明确给了 assetId（AI 传的 / 任务文件里写的）→ **照用**。
 *      即使它不在我们解析出来的候选里也用：我们的表是屏幕前 40 行，
 *      长表会被截断，而人/AI 可能比我们更清楚（找不到时只记日志，不拦）。
 *   2. 只有一条候选 → 直接用（就是人也会做的选择）。
 *   3. 多条候选 / 没解析出表 → 问人。**绝不盲发一个数字** ——
 *      盲发可能登到错的机器上（这正是加这一步的原因）。
 */
export function decideAsset(assets: AssetCandidate[], assetId?: string): AssetDecision {
  const want = (assetId ?? '').trim()
  if (want) {
    const hit = assets.find((a) => a.id === want)
    return {
      kind: 'use',
      id: want,
      candidate: hit,
      why: hit ? `按指定的资产 ID ${want}（${describeAsset(hit)}）` : `按指定的资产 ID ${want}（不在已解析的候选里，可能是表被截断了）`
    }
  }
  if (assets.length === 1) {
    return { kind: 'use', id: assets[0].id, candidate: assets[0], why: `只有一条候选，直接用它：${describeAsset(assets[0])}` }
  }
  if (assets.length === 0) {
    return { kind: 'ask', why: '屏幕上要求输入资产 ID，但没能解析出候选列表' }
  }
  return { kind: 'ask', why: `匹配到 ${assets.length} 条资产，需要选一条` }
}

/** 一条候选的一行文字（日志 / 给 AI 看）。重复的字段（名称和地址常常一样）只留一个 */
export function describeAsset(a: AssetCandidate): string {
  const seen = new Set<string>()
  const bits: string[] = []
  for (const v of [a.name, a.address, a.platform, a.org, a.note]) {
    const t = (v ?? '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    bits.push(t)
  }
  return `ID ${a.id}${bits.length ? ' · ' + bits.join(' · ') : ''}`
}

/** 候选列表 → 给 AI / 用户看的文本（表头 + 每行一条） */
export function describeAssets(assets: AssetCandidate[], host?: string): string {
  if (assets.length === 0) return ''
  const head = `匹配到 ${assets.length} 条资产${host ? `（${host}）` : ''}：`
  return [head, ...assets.map((a) => `- ${describeAsset(a)}`)].join('\n')
}

/**
 * 用户在选资产那一步按了取消时，说给 AI / 人听的话。
 *
 * 必须带上**候选列表和下一步怎么做**：AI 读到之后可以带 assetId 重试，
 * 人也能看懂为什么没连上 —— 只说一句「已取消」等于把球踢没了。
 */
export function assetPickCancelledMessage(host: string, candidates: AssetCandidate[], why: string): string {
  const lines = [`已取消选择资产（${host}）。${why}。`]
  if (candidates.length > 0) lines.push(describeAssets(candidates, host))
  lines.push('再试一次时：让 AI 带 assetId 调 bastion_connect，或在部署任务里写 "assetId": "<ID>"。')
  lines.push(HANDOFF_HINT)
  return lines.join('\n')
}

/**
 * 「人工接手」提示：这是我们和那些自己连 SSH 的 MCP 工具**最大的区别**，所以要反复说。
 *
 * 会话是**人和 AI 共用的同一条**：人随时可以自己敲（输动态码、选资产、过菜单、
 * 输密码、甚至改一条写错的命令），做完之后 AI 直接接着用 —— 不用重新认证，
 * 也不用把密码/验证码交给 AI 那一侧。
 */
export const HANDOFF_HINT =
  '（会话是人和 AI **共用**的同一条：你也可以在终端里自己操作 —— 选资产、选账号、输密码、输动态码都行；' +
  '做完告诉 AI 一声，它会用 bastion_listSessions 看会话、再用 bastion_exec 接着干，不需要重新认证。）'

/** 会话现在处于什么状态（给 AI 判断「能不能直接执行命令」用） */
export type SessionScreenState = 'shell' | 'menu' | 'unknown'

/**
 * 从屏幕最后几行的原文判断会话状态。
 *
 * 为什么要这个：AI 只能通过文本了解现状，而「这条会话停在菜单上」和
 * 「这条会话已经落到 shell」在文本上差别很大、在后果上差别更大 ——
 * 往菜单里发命令，菜单会把命令当成它的输入吃掉（或者误触某个选项）。
 *
 * 判定上**偏保守**：只有在「明确认出是菜单」且「明确不是 shell」时才报 menu；
 * 认不出来一律 unknown（照旧执行），免得自定 PS1 的正常会话被误拦。
 */
export function classifySessionScreen(tail: string, hints: MenuHints = DEFAULT_MENU_HINTS): SessionScreenState {
  if (!tail.trim()) return 'unknown'
  // 只看**最后几行**：菜单提示一定在最底下，翻滚缓冲里那些旧内容不算
  const lines = tail.split('\n').filter((l) => l.trim())
  const bottom = lines.slice(-6).join('\n')
  if (detectPrompt(bottom, 'shellPrompt', hints)) return 'shell'
  const menuLike =
    detectPrompt(bottom, 'assetPrompt', hints) ||
    detectPrompt(bottom, 'userPrompt', hints) ||
    detectPrompt(bottom, 'hostPrompt', hints) ||
    looksLikeAssetList(bottom, hints) ||
    // 弱特征（裸提示符 `Opt>` / `[Host]>`）**只认最后两行**。
    //
    // 为什么必须带上它（2026-09-14 真机教训）：堡垒机菜单正文（那句「进行搜索」）
    // 会随公告一起滚上去，屏幕最底下往往只剩 `Opt> Opt>` —— 只认强特征的话就判成
    // 「未知」，于是 exec 的拦截不生效，**AI 的命令真的被敲进了菜单里**。
    // 只认最后两行 + 这两个很窄的模式（`^\s*opt>` / `^\s*\[host\]>`），
    // 所以不会把自定 PS1 的正常 shell 误判成菜单。
    detectPrompt(lines.slice(-2).join('\n'), 'hostPromptLoose', hints)
  return menuLike ? 'menu' : 'unknown'
}

/** 「这条会话停在菜单上」时给 AI 的话（不要发命令，先说清怎么办） */
export function menuStuckMessage(screenTail: string): string {
  const lines = [
    '⚠️ 这条会话现在停在**堡垒机菜单**上（还没落到目标机的 shell），所以命令没有发出去 ——',
    '发出去只会被菜单当成菜单输入吃掉，甚至误触某个选项。',
    '请让用户在终端里手动走完这一步（选资产 / 选账号 / 输密码 / 输动态码都可以），完成后你再用',
    'bastion_listSessions（会标出每条会话的状态）+ bastion_exec 在**同一条会话**上接着干。',
    HANDOFF_HINT
  ]
  const tail = screenTail
    .split('\n')
    .filter((l) => l.trim())
    .slice(-8)
    .join('\n')
  if (tail) lines.push('—— 屏幕最后几行 ——\n' + tail)
  return lines.join('\n')
}

/** 只做最简单的转义清理，避免和 terminal.ts 互相 import */
function stripAnsiForMatch(s: string): string {
  if (!s) return ''
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78]/g, '')
}
