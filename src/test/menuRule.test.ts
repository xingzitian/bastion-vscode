// 从屏幕原文生成菜单规则：这组测试用的是**真机上抓下来的原文形状**
// （脱敏后的版本见 menuNav.test.ts），保证生成的规则确实能匹配回那行。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeRegex,
  generalizeMenuLine,
  suggestHintKey,
  buildMenuRuleSuggestions,
  appendMenuRule,
  HINT_KEY_LABEL
} from '../menuRule'
import { hintsToRegexes, DEFAULT_MENU_HINTS } from '../menu'

test('转义：正则元字符都当普通字符处理', () => {
  assert.equal(escapeRegex('1) 输入IP(如果唯一).'), '1\\) 输入IP\\(如果唯一\\)\\.')
  assert.equal(escapeRegex('a+b*c?'), 'a\\+b\\*c\\?')
  assert.equal(escapeRegex('[Host]>'), '\\[Host\\]>')
})

test('泛化：编号和数字换成 \\d+，连续空白换成 \\s+', () => {
  assert.equal(generalizeMenuLine('1) 输入 部分IP，主机名'), '^\\s*\\d+\\)\\s+输入\\s+部分IP，主机名')
  assert.equal(generalizeMenuLine('  10) 输入 ? 进行显示帮助.'), '^\\s*\\d+\\)\\s+输入\\s+\\?\\s+进行显示帮助\\.')
})

test('泛化：生成的规则真的能匹配回那行原文（这是它唯一的意义）', () => {
  const samples = [
    ' 1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).',
    '提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID',
    'Opt> Opt>',
    'ID>',
    '[root@srv tmp]#'
  ]
  for (const line of samples) {
    const re = new RegExp(generalizeMenuLine(line), 'im')
    assert.ok(re.test(line), `生成的规则应能匹配原文：${line} → ${generalizeMenuLine(line)}`)
  }
})

test('泛化：数字变了也还认得（编号/IP 每次都不一样）', () => {
  const re = new RegExp(generalizeMenuLine(' 3) 输入 部分IP，主机名 进行搜索登录'), 'im')
  assert.ok(re.test(' 7) 输入 部分IP，主机名 进行搜索登录'), '编号变了应仍匹配')
  assert.ok(re.test(' 12) 输入 部分IP，主机名 进行搜索登录'))
})

test('泛化：空行返回空串（不生成没意义的规则）', () => {
  assert.equal(generalizeMenuLine(''), '')
  assert.equal(generalizeMenuLine('   \t  '), '')
})

test('猜类别：shell 提示符', () => {
  assert.equal(suggestHintKey('[root@srv tmp]#'), 'shellPrompt')
  assert.equal(suggestHintKey('opsuser@srv:/tmp$'), 'shellPrompt')
  assert.equal(suggestHintKey('bash-4.2$'), 'shellPrompt')
})

test('猜类别：选用户菜单（含裸 ID> 这种提示符）', () => {
  assert.equal(suggestHintKey('提示：输入资产[test-node-10.0.0.10(10.0.0.10)]的账号ID'), 'userPrompt')
  assert.equal(suggestHintKey('请选择登录用户:'), 'userPrompt')
  assert.equal(suggestHintKey('ID>'), 'userPrompt', 'ID> 是选用户菜单的提示符，不是主菜单')
})

test('猜类别：主菜单正文 vs 裸提示符', () => {
  assert.equal(suggestHintKey(' 1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).'), 'hostPrompt')
  assert.equal(suggestHintKey('公告：示例生产堡垒机使用注意事项'), 'hostPrompt')
  assert.equal(suggestHintKey('Opt>'), 'hostPromptLoose')
  assert.equal(suggestHintKey('[Host]>'), 'hostPromptLoose')
})

test('候选行：过滤空行、分隔线、纯编号；保留有信息量的行', () => {
  const screen = [
    '',
    '=========== 主菜单 ===========',
    '  1',
    ' 1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).',
    '--------+----------',
    'Opt> Opt>',
    ' 1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).' // 重复行
  ].join('\n')
  const s = buildMenuRuleSuggestions(screen)
  const lines = s.map((x) => x.line)
  assert.ok(lines.includes('1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).'), '候选里应有那条菜单正文（首尾空白已去掉）')
  assert.ok(lines.includes('Opt> Opt>'))
  assert.equal(
    lines.filter((l) => l === '1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).').length,
    1,
    '重复行应只留一次'
  )
  assert.ok(!lines.some((l) => /^[-=]{3,}$/.test(l)), '分隔线不该出现在候选里')
  assert.ok(!lines.includes('1'), '纯编号行没有信息量')
})

test('候选行：limit 生效、且带了猜出来的类别和可用规则', () => {
  const screen = Array.from({ length: 50 }, (_, i) => `第 ${i} 行提示`).join('\n')
  const s = buildMenuRuleSuggestions(screen, 10)
  assert.equal(s.length, 10)
  for (const x of s) {
    assert.ok(x.pattern.startsWith('^\\s*'))
    assert.ok(HINT_KEY_LABEL[x.key], '每个类别都要有可读名（菜单里要显示）')
  }
})

test('生成的规则能直接喂给 hintsToRegexes（不会被当成坏正则丢掉）', () => {
  const s = buildMenuRuleSuggestions(' 1) 输入 部分IP，主机名 进行搜索登录')
  assert.equal(s.length, 1)
  const res = hintsToRegexes([s[0].pattern])
  assert.equal(res.length, 1, '生成的规则必须是合法正则')
  assert.ok(res[0].test(' 1) 输入 部分IP，主机名 进行搜索登录'))
})

test('生成的规则不会误伤内置默认能认的内容（保守性抽查）', () => {
  // 一个很具体的行生成的规则，不该匹配到完全无关的屏幕内容
  const pattern = generalizeMenuLine(' 1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).')
  const re = new RegExp(pattern, 'im')
  assert.equal(re.test('[root@srv ~]# systemctl status nginx'), false)
  assert.ok(
    DEFAULT_MENU_HINTS.hostPrompt.length > 0,
    '同时确认内置默认没被动过（这是回归保护，不是本测试的主角）'
  )
})

// ---------------------------------------------------------------------------
// 追加规则时最容易踩的坑：本项目设置是「填了就整组替换内置默认」，
// 所以「加一条」必须把内置的一起带上，否则加完反而认得比原来少。
// ---------------------------------------------------------------------------
test('appendMenuRule：设置里为空时，先抄上内置默认再加新规则', () => {
  const r = appendMenuRule(undefined, 'userPrompt', '^\\s*账户编号>')!
  assert.ok(r.includes('^\\s*账户编号>'), '新规则要在里面')
  for (const d of DEFAULT_MENU_HINTS.userPrompt) {
    assert.ok(r.includes(d), `内置默认不能被挤掉：${d}`)
  }
  assert.equal(r.length, DEFAULT_MENU_HINTS.userPrompt.length + 1)
})

test('appendMenuRule：设置里已有自己的规则时，在其后追加（且不重复加内置）', () => {
  const mine = ['^\\s*我的规则一>']
  const r = appendMenuRule(mine, 'userPrompt', '^\\s*我的规则二>')!
  assert.deepEqual(r, ['^\\s*我的规则一>', '^\\s*我的规则二>'])
})

test('appendMenuRule：已经在里面了就不改（返回 null，别制造重复项）', () => {
  assert.equal(appendMenuRule(['a'], 'hostPrompt', 'a'), null)
  assert.equal(appendMenuRule(undefined, 'userPrompt', DEFAULT_MENU_HINTS.userPrompt[0]), null, '内置里已有的也不该重复加')
  assert.equal(appendMenuRule(undefined, 'hostPrompt', '   '), null, '空规则不写')
})
