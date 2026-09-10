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
 */

export type MenuHintKey = 'hostPrompt' | 'hostPromptLoose' | 'userPrompt' | 'shellPrompt'

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
 * 输完 IP 之后，我们同时在等这三种界面。
 * **顺序即优先级** —— 万一同时命中，靠前的赢（选用户菜单优先于 shell 提示符）。
 */
export const AFTER_HOST_ORDER: MenuHintKey[] = ['userPrompt', 'shellPrompt', 'hostPrompt']

export interface AfterHostPlan {
  /** 要不要把 userChoice 发出去 */
  sendUserChoice: boolean
  /** 要不要继续等 shell 提示符 */
  waitShell: boolean
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
 * 解析最终生效的提示正则：设置里填了就用设置的（整组替换），没填用内置默认。
 * 用「替换」而不是「追加」，是因为内置规则万一在某家堡垒机上误判，用户需要能一键关掉它。
 */
export function resolveMenuHints(get: (key: string) => unknown): MenuHints {
  const pick = (key: MenuHintKey): string[] => {
    const v = get(key)
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      return v as string[]
    }
    return DEFAULT_MENU_HINTS[key]
  }
  return {
    hostPrompt: pick('hostPrompt'),
    hostPromptLoose: pick('hostPromptLoose'),
    userPrompt: pick('userPrompt'),
    shellPrompt: pick('shellPrompt')
  }
}

/** 一段输出里是否出现了某一类提示 */
export function detectPrompt(text: string, key: MenuHintKey, hints: MenuHints = DEFAULT_MENU_HINTS): boolean {
  const plain = stripAnsiForMatch(text)
  return hintsToRegexes(hints[key]).some((re) => re.test(plain))
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
