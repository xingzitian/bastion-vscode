// 菜单提示识别：认得出来要认，认不出来要老实说认不出来（不能抢跑）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPrompt,
  hintsToRegexes,
  resolveMenuHints,
  planAfterHost,
  shouldSelectUser,
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
  // 优先级：选用户菜单必须排在 shell 提示符前面
  assert.deepEqual(AFTER_HOST_ORDER, ['userPrompt', 'shellPrompt', 'hostPrompt'])
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
