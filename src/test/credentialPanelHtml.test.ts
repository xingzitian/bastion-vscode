// 「凭据管理」面板的 HTML（纯函数部分）。
//
// 为什么单测盯 HTML：面板 JS/HTML 写在 TS 模板字符串里，漏一个转义就是
// "打开一片空白 + 编译期毫无提示"。这里至少保证：行数据都出现、按钮带对的数据属性、
// 危险内容被转义、CSP 里没有 inline script（只有带 nonce 的那段）。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCredentialsHtml, type CredentialsModel } from '../credentialPanel'

const model: CredentialsModel = {
  rows: [
    {
      name: '中转长期机器',
      target: 'root@66.85.92.49:22',
      authMethod: 'password',
      password: { has: true, owners: ['desktop'], updatedAt: '2026-11-27T03:20:00.000Z' },
      passphrase: { has: false, owners: [], updatedAt: '' }
    },
    {
      name: 'xzt',
      target: 'root@159.75.78.7:22',
      authMethod: 'key',
      password: { has: true, owners: ['vscode', 'desktop'], updatedAt: '2026-11-27T01:00:00.000Z' },
      passphrase: { has: true, owners: ['vscode'], updatedAt: '2026-11-27T01:00:00.000Z' }
    }
  ],
  orphans: [{ key: '中转2', owners: ['vscode'], kinds: ['密码'], updatedAt: '2026-11-20T00:00:00.000Z' }],
  indexFile: 'C:\\Users\\me\\.bastionshell\\credentials.json'
}

test('每个档案一行，名字/目标/认证方式都在', () => {
  const html = buildCredentialsHtml('vscode-webview://test', model)
  assert.ok(html.includes('中转长期机器'))
  assert.ok(html.includes('root@66.85.92.49:22'))
  assert.ok(html.includes('xzt'))
  assert.ok(html.includes('密钥'), '认证方式要能看出来')
})

test('"存在哪"要说清楚（扩展 / 桌面 / 两边都有）', () => {
  const html = buildCredentialsHtml('vscode-webview://test', model)
  assert.ok(/桌面/.test(html))
  assert.ok(/扩展 \+ 桌面/.test(html), '两个产品都存了要显示出来')
})

test('有密码才给「查看 / 删除」，没存给「设置」', () => {
  const html = buildCredentialsHtml('vscode-webview://test', model)
  assert.ok(html.includes('data-cmd="revealPassword"'))
  assert.ok(html.includes('data-cmd="deletePassword"'))
  assert.ok(html.includes('data-cmd="setPassword"'), '没存的也要有设置入口')
  assert.ok(html.includes('data-cmd="setPassphrase"'))
  assert.ok(html.includes('data-cmd="test"'), '测试连接')
  assert.ok(html.includes('data-cmd="switchAuth"'), '认证方式切换')
})

test('孤儿有独立分区，只能删扩展侧（桌面侧要提示去桌面删）', () => {
  const html = buildCredentialsHtml('vscode-webview://test', model)
  assert.ok(html.includes('孤儿凭据'))
  assert.ok(html.includes('中转2'))
  assert.ok(html.includes('data-cmd="dropOrphan"'))
  assert.ok(html.includes('请到桌面里删') === false, '这条孤儿只有扩展属主，不该出现"去桌面删"')
})

test('恶意/特殊字符被转义（不能把面板打坏）', () => {
  const nasty: CredentialsModel = {
    rows: [
      {
        name: '<img src=x onerror=alert(1)>',
        target: '" onmouseover="x',
        authMethod: 'password',
        password: { has: false, owners: [], updatedAt: '' },
        passphrase: { has: false, owners: [], updatedAt: '' }
      }
    ],
    orphans: [],
    indexFile: ''
  }
  const html = buildCredentialsHtml('vscode-webview://test', nasty)
  assert.ok(!html.includes('<img src=x'), '尖括号必须转义')
  assert.ok(html.includes('&lt;img'))
  assert.ok(!/onmouseover="x"/.test(html), '引号必须转义')
})

test('CSP 里只允许带 nonce 的脚本（不许 inline）', () => {
  const html = buildCredentialsHtml('vscode-webview://test', model)
  assert.ok(/script-src 'nonce-[a-z0-9]{32}'/.test(html), '脚本必须带 nonce')
  assert.ok(!/script-src 'unsafe-inline'/.test(html))
  assert.ok(html.includes('acquireVsCodeApi'), '面板脚本要在')
})

test('空档案表也有说明，不是一片空白', () => {
  const html = buildCredentialsHtml('vscode-webview://test', { rows: [], orphans: [], indexFile: 'x' })
  assert.ok(html.includes('还没有档案'))
  assert.ok(html.includes('没有孤儿凭据'))
})

test('说明里必须写清"不显示明文，点查看才出现一次"', () => {
  const html = buildCredentialsHtml('vscode-webview://test', model)
  assert.ok(/不显示明文/.test(html))
})
