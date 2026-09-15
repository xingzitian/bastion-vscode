// 菜单提示识别：认得出来要认，认不出来要老实说认不出来（不能抢跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_INSTRUCTIONS, MCP_TOOL_DEFS } from '../mcpTools'
import {
  detectPrompt,
  hintsToRegexes,
  resolveMenuHints,
  planAfterHost,
  shouldSelectUser,
  judgeAfterHost,
  parseAssetTable,
  looksLikeAssetList,
  decideAsset,
  describeAsset,
  describeAssets,
  assetPickCancelledMessage,
  classifySessionScreen,
  menuStuckMessage,
  DEFAULT_MENU_HINTS,
  HOST_STEP,
  SHELL_STEP,
  AFTER_HOST_ORDER,
  AFTER_HOST_TIMING,
  type MenuHintKey
} from '../menu'

// —— 下面这几条来自**真实抓到的菜单原文**（用户贴回来的日志），不是编的样例 ——
// ⚠️ 已经脱敏：真实主机名 / 账号 / 人名 / 环境名一律换成了示例值。
//    改这些夹具时**不要**把真实环境的值填回去 —— 这个仓库是公开的。

/** 某厂商堡垒机 生产堡垒机实际菜单（原样复制，含公告和重复的 Opt> 提示符） */
const REAL_HOST_MENU = [
  '\t\t张三,  堡垒机-示例生产堡垒机',
  '\t1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).',
  '\t2) 输入 / + IP，主机名，备注 进行搜索，如：/192.168.',
  '\t3) 输入 p 进行显示您有权限的资产.',
  '\t4) 输入 g 进行显示您有权限的节点.',
  '\t5) 输入 h 进行显示您有权限的主机.',
  '\t6) 输入 d 进行显示您有权限的数据库.',
  '\t7) 输入 k 进行显示您有权限的Kubernetes.',
  '\t8) 输入 r 进行刷新最新的机器和节点信息.',
  '\t9) 输入 s 进行中文-English-日本語语言切换.',
  '\t10) 输入 ? 进行显示帮助.',
  '\t11) 输入 q 进行退出.',
  '公告：示例生产堡垒机使用注意事项',
  '1、堡垒机域名已更新，请使用新地址登录(bastion.example.com)。',
  'Opt> Opt>'
].join('\n')

/** 某厂商堡垒机 实测：输完 IP 后的**选用户菜单**（账号表 + 提示 + ID> 提示符） */
const REAL_USER_MENU = [
  'Opt> Opt> 10.0.0.10',
  '  ID    | 名称                                                                                  | 用户名',
  '--------+---------------------------------------------------------------------------------------+----------------------------------------------------------------------------------------',
  '  1     | deploy                                                                              | deploy',
  '  2     | appuser                                                                        | appuser',
  '提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID',
  '返回：B/b',
  'ID>'
].join('\n')

test('实测：某厂商的选用户菜单能认出来（旧规则在方括号资产名上栽了）', () => {
  assert.equal(detectPrompt(REAL_USER_MENU, 'userPrompt'), true)
})

test('实测：选用户提示里「输入」到「账号」之间夹着很长的资产名也要认', () => {
  // 旧规则是「输入…{0,20}(用户|账号)」，但中间夹了 [test-node-10.0.0.10(10.0.0.10)] 40+ 字符
  const line = '提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID'
  assert.equal(detectPrompt(line, 'userPrompt'), true)
})

test('实测：裸提示符 ID> 也算选用户菜单', () => {
  assert.equal(detectPrompt('ID>', 'userPrompt'), true)
  assert.equal(detectPrompt('ID> ', 'userPrompt'), true)
})

test('实测：账号表表头「名称 … 用户名」也是强信号', () => {
  assert.equal(detectPrompt('  ID    | 名称     | 用户名', 'userPrompt'), true)
})

test('⚠️ 输完 IP 的回显不能被当成「又回到输 IP」', () => {
  // 这是 hostPromptLoose 存在的原因：输完 IP 后屏幕上是
  //   `Opt> Opt> 10.0.0.10`
  // 裸提示符 Opt> 若参与「回到输 IP」的判断，堡垒机只要重画一次提示符，
  // 就会被误判成「IP 被拒绝」直接报错。
  const echo = 'Opt> Opt> 10.0.0.10'
  // 强特征（只放菜单正文）不该命中回显
  assert.equal(detectPrompt(echo, 'hostPrompt'), false, '强特征不该被回显骗到')
  // 弱特征会命中 —— 所以它只用于第一次等主菜单
  assert.equal(detectPrompt(echo, 'hostPromptLoose'), true)
  // 而真正的菜单正文仍然命中强特征
  assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt'), true)
})

test('弱特征（裸提示符）只有 Opt> 一条，不给别的场景留误伤面', () => {
  assert.ok(DEFAULT_MENU_HINTS.hostPromptLoose.length <= 2)
  // ID> 属于选用户菜单，不该出现在主菜单的弱特征里
  assert.equal(DEFAULT_MENU_HINTS.hostPromptLoose.some((p) => /id>/i.test(p)), false)
})

test('实测：某厂商堡垒机菜单能认出来（旧规则在这里栽过两次）', () => {
  assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt'), true)
})

test('实测：提示符重复打印成 "Opt> Opt>" 也要认（别锚定行尾）', () => {
  // 旧规则是 ^\s*opt>\s*$，要求整行只有 Opt>，遇到重复打印就永远匹配不上。
  // 现在裸提示符归到 hostPromptLoose（弱特征）—— 只用于第一次等主菜单。
  for (const s of ['Opt> Opt>', 'Opt>', '\tOpt> Opt>\n']) {
    assert.equal(detectPrompt(s, 'hostPromptLoose'), true, `弱特征应认出：${JSON.stringify(s)}`)
  }
})

test('实测：找菜单时强特征 + 弱特征一起用（第一次识别的实际做法）', () => {
  // sessions.ts 第一步等的是 hostPrompt ∪ hostPromptLoose
  const findMenu = (text: string): boolean =>
    detectPrompt(text, 'hostPrompt') || detectPrompt(text, 'hostPromptLoose')
  assert.equal(findMenu(REAL_HOST_MENU), true, '完整菜单（含正文）')
  assert.equal(findMenu('Opt> Opt>'), true, '只有提示符时也要认')
})

test('实测：菜单正文里没有「请」字也要认', () => {
  // 旧规则写的是「请输入…IP」，而实际是「输入 部分IP，主机名，备注 进行搜索登录」
  assert.equal(detectPrompt('1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).', 'hostPrompt'), true)
  assert.equal(detectPrompt('6) 输入 d 进行显示您有权限的数据库.', 'hostPrompt'), true)
  assert.equal(detectPrompt('7) 输入 k 进行显示您有权限的Kubernetes.', 'hostPrompt'), true)
})

test('英文界面也要认（同一台堡垒机可切中/英/日）', () => {
  assert.equal(detectPrompt('Please input host IP or name to search:', 'hostPrompt'), true)
  assert.equal(detectPrompt('Select asset:', 'hostPrompt'), true)
  assert.equal(detectPrompt('Please select user:', 'userPrompt'), true)
})

test('能认出齐治风格的「请输入资产编号或IP地址」', () => {
  const screen = [
    '  欢迎使用云堡垒机',
    '  1) 10.0.0.10   生产服务器',
    '  2) 10.0.0.5        测试机',
    '',
    '  请输入资产编号或IP地址：'
  ].join('\n')
  assert.equal(detectPrompt(screen, 'hostPrompt'), true)
})

test('能认出 JumpServer 风格的资产搜索提示', () => {
  assert.equal(detectPrompt('请输入主机 IP 或名称进行搜索：', 'hostPrompt'), true)
  assert.equal(detectPrompt('搜索资产: ', 'hostPrompt'), true)
  assert.equal(detectPrompt('Select host: ', 'hostPrompt'), true)
  // 裸提示符 Opt> 现在归弱特征（只用于第一次等主菜单）
  assert.equal(detectPrompt('Opt> ', 'hostPromptLoose'), true)
})

test('能认出选择用户的二级菜单', () => {
  const samples = [
    '请选择登录用户：',
    '请选择要使用的账号：',
    '登录用户 [1-3]:',
    'Username: ',
    'Account: '
  ]
  for (const s of samples) {
    assert.equal(detectPrompt(s, 'userPrompt'), true, `应认出用户菜单：${s}`)
  }
})

test('能认出落到目标机后的 shell 提示符', () => {
  const samples = [
    '[deploy@test-host ~]$ ',
    'root@10-0-0-10:/data# ',
    '$ ',
    '# ',
    'bash-4.2$ '
  ]
  for (const s of samples) {
    assert.equal(detectPrompt(s, 'shellPrompt'), true, `应认出提示符：${s}`)
  }
})

test('不该抢跑：主菜单画面里不该被当成「用户菜单」', () => {
  // 这一步的语义是「刚发完 IP，等选用户」。此时屏幕上往往还留着主菜单，
  // 但我们只看新到的输出；这条用例守的是「别把资产列表误判成用户菜单」。
  const hostMenu = [
    '  1) 10.0.0.10   生产服务器',
    '  2) 10.0.0.5        测试机',
    '  请输入资产编号或IP地址：'
  ].join('\n')
  assert.equal(detectPrompt(hostMenu, 'userPrompt'), false, '资产列表不该被当成用户菜单')
})

test('不该抢跑：普通输出不该被当成 shell 提示符', () => {
  const samples = [
    '正在连接，请稍候...',
    'Last login: Mon Sep 10 10:44:48 2026',
    'total 12',
    'drwxr-xr-x 2 root root 4096 Sep 10 10:00 .',
    '? 帮助  q 退出',
    '############################', // 装饰性分隔行，不能当成 root 提示符
    '==== 登录成功 ==== ',
    '总耗时 12s #'
  ]
  for (const s of samples) {
    assert.equal(detectPrompt(s, 'shellPrompt'), false, `不该误判为提示符：${s}`)
  }
})

test('ANSI 颜色码不影响识别', () => {
  assert.equal(detectPrompt('\x1b[32m请输入资产编号或IP地址：\x1b[0m', 'hostPrompt'), true)
  assert.equal(detectPrompt('\x1b]0;title\x07[deploy@host ~]$ ', 'shellPrompt'), true)
})

test('空输出一律认不出来', () => {
  for (const key of ['hostPrompt', 'userPrompt', 'shellPrompt'] as MenuHintKey[]) {
    assert.equal(detectPrompt('', key), false)
  }
})

test('设置里填了提示就整组替换内置（用户能一键关掉误判规则）', () => {
  const hints = resolveMenuHints((k) => (k === 'hostPrompt' ? ['我的堡垒机专用提示'] : undefined))
  assert.deepEqual(hints.hostPrompt, ['我的堡垒机专用提示'])
  assert.deepEqual(hints.userPrompt, DEFAULT_MENU_HINTS.userPrompt, '没填的沿用内置')
  // 替换后，原来的中文规则应失效
  assert.equal(detectPrompt('请输入资产编号或IP地址：', 'hostPrompt', hints), false)
  assert.equal(detectPrompt('我的堡垒机专用提示', 'hostPrompt', hints), true)
})

test('四个提示键都能被单独覆盖', () => {
  const hints = resolveMenuHints((k) => (k === 'hostPromptLoose' ? ['^my-prompt>'] : undefined))
  assert.deepEqual(hints.hostPromptLoose, ['^my-prompt>'])
  assert.deepEqual(hints.hostPrompt, DEFAULT_MENU_HINTS.hostPrompt, '其它键不受影响')
})

test('设置里写空数组 = 用内置默认（不是禁用）', () => {
  const hints = resolveMenuHints(() => [])
  assert.deepEqual(hints.hostPrompt, DEFAULT_MENU_HINTS.hostPrompt)
})

test('设置里写错正则不会崩，只是那一条失效', () => {
  const hints = resolveMenuHints((k) => (k === 'hostPrompt' ? ['[', '正常的提示'] : undefined))
  assert.doesNotThrow(() => detectPrompt('正常的提示', 'hostPrompt', hints))
  assert.equal(detectPrompt('正常的提示', 'hostPrompt', hints), true, '好的那条仍然生效')
})

test('hintsToRegexes：坏正则被跳过，好的保留', () => {
  const res = hintsToRegexes(['[', 'abc', '(?<bad'])
  assert.equal(res.length, 1)
  assert.equal(res[0].source, 'abc')
})

test('「输目标机后」的超时给了足够余量（实测教训，别改回去）', () => {
  // 实测：某厂商堡垒机收到 IP 之后要查资产/账号库，菜单 8~10 秒才画出来。
  // 原来给 8 秒正好差一点点 —— 每次都超时、退回兜底、白等一轮。
  assert.ok(
    AFTER_HOST_TIMING.timeoutMs >= 15000,
    `超时必须给足（现在 ${AFTER_HOST_TIMING.timeoutMs}ms），否则慢的堡垒机会一直走兜底`
  )
  // 但也不能无限等：管理员账号没有这一步，靠的是「同时等三类、shellPrompt 提前命中」，
  // 所以给长了不会惩罚管理员 —— 但真认不出来时还是要有上限
  assert.ok(AFTER_HOST_TIMING.timeoutMs <= 60000, '超时也要有个上限')
})

test('步骤表本身健康：超时都给够、优先顺序正确', () => {
  for (const [name, s] of [
    ['主菜单', HOST_STEP],
    ['shell 提示符', SHELL_STEP]
  ] as const) {
    assert.ok(s.timeoutMs > 0, `${name} 要有超时`)
    assert.ok(s.timeoutMs > s.fallbackMs, `${name}: 等提示(${s.timeoutMs}) 应长于兜底(${s.fallbackMs})`)
  }
  // 只有第一步需要看已有缓冲（菜单可能在我们开始等之前就画好了）
  assert.equal(HOST_STEP.includeBuffered, true)
  assert.equal(SHELL_STEP.includeBuffered, false, '只能看新输出，否则会被上一个菜单骗')
  // 优先级：资产列表 → 选用户菜单 → shell 提示符 → 又回到输 IP。
  // 资产排最前，是因为「同一 IP 匹配到多条资产」时它先出现，而且认错它的代价是
  // **登到错的机器上**（更糟的是像 2026-09-14 那次：被报成「IP 被拒绝」）。
  assert.deepEqual(AFTER_HOST_ORDER, ['assetPrompt', 'userPrompt', 'shellPrompt', 'hostPrompt'])
  assert.ok(AFTER_HOST_TIMING.timeoutMs > 0)
})

// ---------------------------------------------------------------------------
// 分支逻辑：有些管理员账号没有「选用户」这一步，输完 IP 直接进 shell。
// 这一组用例就是为那个真实场景写的。
// ---------------------------------------------------------------------------

test('管理员账号：等到 shell 提示符就跳过选用户，绝不把序号打进 shell', () => {
  const plan = planAfterHost('shellPrompt', true)
  assert.equal(plan.sendUserChoice, false, '不能发 userChoice —— 那会在 shell 里执行一条叫 1 的命令')
  assert.equal(plan.waitShell, false, '已经进去了，不用再等')
  assert.match(plan.reason, /没有选用户这一步/)
})

test('普通账号：等到选用户菜单就正常发 userChoice', () => {
  const plan = planAfterHost('userPrompt', true)
  assert.equal(plan.sendUserChoice, true)
  assert.equal(plan.waitShell, true)
  assert.match(plan.reason, /发送 userChoice/)
})

test('超时认不出：按老行为兜底发 userChoice（宁可照旧，也别卡在菜单上）', () => {
  const plan = planAfterHost(null, true)
  assert.equal(plan.sendUserChoice, true, '有选用户菜单的正常场景下老行为是对的')
  assert.equal(plan.waitShell, true)
  assert.match(plan.reason, /兜底/)
  assert.match(plan.reason, /menuHints/, '要告诉用户怎么调')
})

test('又回到输 IP 那一步 → 判定失败，而不是硬着头皮往下发', () => {
  const plan = planAfterHost('hostPrompt', true)
  assert.ok(plan.fail, '应该判失败')
  assert.match(plan.fail!, /没被堡垒机接受/)
  assert.equal(plan.sendUserChoice, false, '失败路径不该再发任何东西')
})

test('userChoice 留空 = 明确不选用户，直接等 shell', () => {
  const plan = planAfterHost(null, false)
  assert.equal(plan.sendUserChoice, false)
  assert.equal(plan.waitShell, true)
  assert.match(plan.reason, /不选用户/)
  // 即使真的看到了选用户菜单，配置说不选就不选
  assert.equal(planAfterHost('userPrompt', false).sendUserChoice, false)
})

test('shouldSelectUser：空串 / - / skip / none 都表示不选用户', () => {
  for (const v of ['', '   ', '-', 'skip', 'SKIP', 'none', 'None']) {
    assert.equal(shouldSelectUser(v), false, `「${v}」应表示不选用户`)
  }
  for (const v of ['1', '2', '0', 'admin', undefined]) {
    assert.equal(shouldSelectUser(v), true, `「${v}」应表示要选用户`)
  }
})

test('四种分支互斥且都有明确理由（不会有「发了又没发」的模糊态）', () => {
  const cases: Array<[MenuHintKey | null, boolean]> = [
    ['userPrompt', true],
    ['shellPrompt', true],
    ['hostPrompt', true],
    [null, true],
    ['userPrompt', false],
    ['shellPrompt', false]
  ]
  for (const [m, sel] of cases) {
    const p = planAfterHost(m, sel)
    assert.ok(p.reason.length > 0, `${m}/${sel} 要有理由`)
    if (p.fail) assert.equal(p.sendUserChoice, false, '判失败时不能再发东西')
    if (!sel) assert.equal(p.sendUserChoice, false, '配置不选用户时绝不能发')
  }
})

// ───────────────────── 资产列表（一个 IP 搜出多条） ─────────────────────
//
// 这一组来自一次**真实的误判**（2026-09-14）：用户输 172.20.30.143 之后，
// 堡垒机列出一张资产表（同一个 IP 既有 Linux 本体、又有 Gateway），
// 而表里那句「提示：输入资产ID直接登录」命中了主菜单规则里的
// `输入[^\n]{0,40}(...|资产|...)` —— 于是程序判定「又回到了输 IP，
// 说明这个 IP 没被接受」，AI 收到的错误结论就是「目标地址或档案不匹配」。
//
// 所以下面第一条用例是**最重要的回归测试**：这一屏必须判成「选资产」，
// 绝不能判成「IP 被拒绝」。

/** 用户贴回来的真实屏幕（已脱敏：IP / 组织名换成示例值，结构一字未改） */
const REAL_ASSET_LIST = [
  'ID | 名称                      | 地址          | 平台                                       | 组织                                            | 备注                                       ',
  '-----+---------------------------+---------------+--------------------------------------------+-------------------------------------------------+--------------------------------------------',
  '  1  | 172.20.30.143             | 172.20.30.143 | Linux                                      | 默认组织                                        |                                            ',
  '  2  | 研发网域172.20.30.143     | 172.20.30.143 | Gateway                                    | 默认组织                                        |                                            ',
  '页码：1，每页行数：23，总页数：1，总数量：2',
  '提示：输入资产ID直接登录，二级搜索使用 // + 字段，如：//192 上一页：b 下一页：n',
  '搜索：172.20.30.143'
].join('\n')

test('【回归】资产列表不能被判成「又回到输 IP」（那会让 AI 以为 IP 被拒绝）', () => {
  assert.equal(
    judgeAfterHost(REAL_ASSET_LIST, DEFAULT_MENU_HINTS, true),
    'assetPrompt',
    '这一屏是「选资产」，判成 hostPrompt 就会报「IP 不被接受」——这正是用户遇到的那次误判'
  )
  assert.equal(looksLikeAssetList(REAL_ASSET_LIST), true)
  assert.equal(detectPrompt(REAL_ASSET_LIST, 'assetPrompt'), true)
})

test('资产列表里那句提示确实会命中主菜单规则（所以必须靠顺序 + 表结构把它拦下来）', () => {
  // 说明这条规则本身没错（主菜单真的长这样），是「先判什么」的顺序问题：
  // judgeAfterHost 里资产列表排在最前面，所以上面那条回归才算守住了。
  assert.equal(detectPrompt(REAL_ASSET_LIST, 'hostPrompt'), true)
  assert.equal(judgeAfterHost(REAL_ASSET_LIST, DEFAULT_MENU_HINTS, true), 'assetPrompt')
})

test('解析真实资产表：两条候选，字段各就各位', () => {
  const rows = parseAssetTable(REAL_ASSET_LIST)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    id: '1',
    name: '172.20.30.143',
    address: '172.20.30.143',
    platform: 'Linux',
    org: '默认组织',
    note: ''
  })
  assert.equal(rows[1].id, '2')
  assert.equal(rows[1].name, '研发网域172.20.30.143')
  assert.equal(rows[1].platform, 'Gateway')
})

test('给 AI / 人看的候选文字：ID、平台、组织都在，重复字段不重复显示', () => {
  const rows = parseAssetTable(REAL_ASSET_LIST)
  const d1 = describeAsset(rows[0])
  assert.match(d1, /^ID 1 · 172\.20\.30\.143 · Linux · 默认组织$/, '名称和地址相同 → 只显示一次')

  const text = describeAssets(rows, '172.20.30.143')
  assert.match(text, /匹配到 2 条资产/)
  assert.match(text, /Gateway/, '第二条的平台必须出现 —— 这是人/AI 判断该选哪条的关键信息')
})

test('资产表列顺序变了也要认（按表头映射，不写死列号）', () => {
  const screen = [
    '资产ID | 名称        | 平台   | 地址          | 组织',
    '  3    | 核心库      | Linux  | 10.1.1.5      | 默认组织'
  ].join('\n')
  const rows = parseAssetTable(screen)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    id: '3',
    name: '核心库',
    address: '10.1.1.5',
    platform: 'Linux',
    org: '默认组织',
    note: ''
  })
})

test('没有竖线、用多个空格分隔的表也要能解析', () => {
  const screen = ['ID    名称        地址         平台', ' 7    DB-01       10.2.2.7     Linux'].join('\n')
  const rows = parseAssetTable(screen)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '7')
  assert.equal(rows[0].name, 'DB-01')
  assert.equal(rows[0].platform, 'Linux')
})

test('账号表（有「用户名」列）绝不能被当成资产表', () => {
  const accountTable = [
    'ID | 名称      | 用户名   | 组织',
    ' 1  | test-node | deploy   | 默认组织',
    '提示：输入资产[test-node]的账号ID'
  ].join('\n')
  assert.deepEqual(parseAssetTable(accountTable), [], '有用户名列 → 这是账号表')
  assert.equal(judgeAfterHost(accountTable, DEFAULT_MENU_HINTS, true), 'userPrompt')
})

test('主菜单不会被误判成资产列表', () => {
  const menus = [
    ['  1) 10.0.0.10   生产服务器', '  请输入资产编号或IP地址：'].join('\n'),
    ['  1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).', '  Opt> '].join('\n'),
    '请输入主机 IP 或名称进行搜索：'
  ]
  for (const m of menus) {
    assert.equal(looksLikeAssetList(m), false, `不该当成资产列表：${m}`)
    assert.equal(judgeAfterHost(m, DEFAULT_MENU_HINTS, true), 'hostPrompt')
  }
})

test('选资产的决定：明确指定就用它（哪怕我们没解析到，表可能被截断）', () => {
  const rows = parseAssetTable(REAL_ASSET_LIST)
  const a = decideAsset(rows, '2')
  assert.equal(a.kind, 'use')
  assert.equal(a.kind === 'use' && a.id, '2')
  assert.equal(a.kind === 'use' && a.candidate?.platform, 'Gateway')

  const b = decideAsset(rows, '9')
  assert.equal(b.kind, 'use')
  assert.equal(b.kind === 'use' && b.id, '9', '人不一定错：我们的表只有屏幕前 40 行')
  assert.match(b.kind === 'use' ? b.why : '', /不在已解析的候选里/)
})

test('选资产的决定：只有一条就自动用，多条/没解析出来就得问人（绝不盲发数字）', () => {
  const rows = parseAssetTable(REAL_ASSET_LIST)
  const one = decideAsset([rows[0]])
  assert.equal(one.kind, 'use')
  assert.equal(one.kind === 'use' && one.id, '1')

  const many = decideAsset(rows)
  assert.equal(many.kind, 'ask')
  assert.match(many.kind === 'ask' ? many.why : '', /2 条/)

  const none = decideAsset([])
  assert.equal(none.kind, 'ask', '屏幕上要选资产但没解析出表 → 也得问，不能瞎发')
})

test('是否要选用户，不影响资产列表的识别', () => {
  // userChoice 留空（不选用户）时，keys 里没有 userPrompt —— 但资产那一步照样要认
  assert.equal(judgeAfterHost(REAL_ASSET_LIST, DEFAULT_MENU_HINTS, false), 'assetPrompt')
})

test('planAfterHost：资产列表 → 先选资产，别急着发 userChoice', () => {
  const plan = planAfterHost('assetPrompt', true)
  assert.equal(plan.pickAsset, true)
  assert.equal(plan.sendUserChoice, false, '资产还没选完，先别发用户序号')
  assert.match(plan.reason, /资产/)
})

test('AFTER_HOST_ORDER：资产列表排在用户菜单前面', () => {
  assert.equal(AFTER_HOST_ORDER[0], 'assetPrompt')
  assert.ok(AFTER_HOST_ORDER.indexOf('assetPrompt') < AFTER_HOST_ORDER.indexOf('userPrompt'))
})

test('assetPrompt 规则可以由设置整组覆盖（用户填了自己的文案）', () => {
  const hints = resolveMenuHints((k) => (k === 'assetPrompt' ? ['请选择要登录的资产'] : undefined))
  assert.equal(detectPrompt('请选择要登录的资产：', 'assetPrompt', hints), true)
  assert.equal(detectPrompt('提示：输入资产ID直接登录', 'assetPrompt', hints), false, '覆盖后内置那套就不再生效')
  assert.equal(detectPrompt('提示：输入资产ID直接登录', 'assetPrompt'), true, '不覆盖时内置的仍然生效')
})

test('取消选资产时说给 AI 的话：带候选列表 + 下一步怎么做（不能只说一句「已取消」）', () => {
  const rows = parseAssetTable(REAL_ASSET_LIST)
  const msg = assetPickCancelledMessage('172.20.30.143', rows, '匹配到 2 条资产，需要选一条')
  assert.match(msg, /已取消选择资产/)
  assert.match(msg, /匹配到 2 条资产/)
  assert.match(msg, /ID 2 · 研发网域172\.20\.30\.143/, '候选要列出来，AI 才知道该传哪个 assetId 重试')
  assert.match(msg, /assetId/)
})


// ───────────────────── 人工接手（人和 AI 共用同一条会话） ─────────────────────
//
// 这是我们相对那些「自己连 SSH 的 MCP 工具」最大的区别：会话是人和 AI **共用**的。
// 人随时可以自己敲（输动态码、选资产、过菜单、改一条命令），AI 接着用同一条会话，
// 不需要重新认证。这一组守两件事：
//   1. 「这条会话能不能直接执行命令」判断得准（认不出就别乱拦）；
//   2. 拦下来时给 AI 的话必须说清「怎么办」（让人做完，你接着来）。

test('会话状态判定：在 shell 里 → shell；停在菜单/资产列表 → menu', () => {
  assert.equal(classifySessionScreen('[deploy@test-host ~]$ '), 'shell')
  assert.equal(classifySessionScreen('root@10-0-0-10:/data# '), 'shell')
  assert.equal(classifySessionScreen(REAL_ASSET_LIST), 'menu', '资产列表 = 还没落到目标机')
  assert.equal(
    classifySessionScreen('  1) 10.0.0.10   生产服务器\n  请输入资产编号或IP地址：'),
    'menu'
  )
  assert.equal(classifySessionScreen('提示：输入资产[test-node]的账号ID\nID>'), 'menu')
})

test('会话状态判定偏保守：认不出来就 unknown（照旧执行，不自定 PS1 误拦）', () => {
  assert.equal(classifySessionScreen(''), 'unknown')
  assert.equal(classifySessionScreen('total 0\ndrwxr-xr-x 2 root root 6 Jan 1 00:00 .'), 'unknown')
  assert.equal(classifySessionScreen('my-custom-prompt> '), 'unknown', '只认得出内置那些，别乱猜')
})

test('会话状态判定只看最后几行：翻滚缓冲里的旧菜单不算数', () => {
  const tail = ['  请输入资产编号或IP地址：', ...Array.from({ length: 12 }, (_, i) => `line ${i}`), '[deploy@h ~]$ '].join('\n')
  assert.equal(classifySessionScreen(tail), 'shell', '提示符在最后 → 已经在 shell 里了')
})

test('拦下「停在菜单上」的执行时，给 AI 的话要包含：原因、怎么办、屏幕最后几行', () => {
  const msg = menuStuckMessage(REAL_ASSET_LIST)
  assert.match(msg, /停在\*\*堡垒机菜单\*\*上/)
  assert.match(msg, /命令没有发出去/)
  assert.match(msg, /让用户.*手动走完/)
  assert.match(msg, /bastion_listSessions/)
  assert.match(msg, /屏幕最后几行/)
  assert.match(msg, /Gateway/, '把屏幕内容带上，AI 才知道卡在哪一步')
})

test('人工接手这件事要在工具说明里讲清楚（AI 才知道可以这么协作）', () => {
  const sessions = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_listSessions')!
  const exec = MCP_TOOL_DEFS.find((t) => t.name === 'bastion_exec')!
  assert.match(sessions.description, /停在堡垒机菜单/)
  assert.match(exec.description, /人和 AI 共用|人工操作/)
  assert.match(exec.description, /不会把命令发出去/)
  assert.match(MCP_INSTRUCTIONS, /人和 AI 共用/)
  assert.match(MCP_INSTRUCTIONS, /不需要重新认证/)
})
