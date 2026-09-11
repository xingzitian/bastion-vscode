// 总览面板的 HTML 产物
//
// 为什么要测这个：面板的 JS 写在 TS 模板字符串里，任何忘记转义的 ${...}
// 都会被 TS 当插值吃掉，产物变成坏掉的 JS —— 面板打开就是一片空白，
// 编译期毫无提示，只能靠打开面板才发现。这几条用测试把它挡住。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vm from 'node:vm'
import { buildOverviewHtml } from '../overview'

const html = buildOverviewHtml('vscode-webview://test')

test('产出的是一份完整 HTML', () => {
  assert.match(html, /^<!DOCTYPE html>/)
  assert.match(html, /<html lang="zh-CN">/)
  assert.match(html, /<\/html>$/)
  assert.match(html, /<div id="root">/)
})

test('CSP 里的 nonce 和 script 标签上的 nonce 是同一个', () => {
  const inCsp = html.match(/script-src 'nonce-([a-z0-9]{32})'/)
  const inTag = html.match(/<script nonce="([a-z0-9]{32})">/)
  assert.ok(inCsp, 'CSP 里应有 nonce')
  assert.ok(inTag, 'script 标签上应有 nonce')
  assert.equal(inCsp![1], inTag![1], '两处 nonce 必须一致，否则脚本被 CSP 拦掉、面板空白')
})

test('CSP 用的是传入的 cspSource，没有留下 undefined', () => {
  assert.match(html, /style-src vscode-webview:\/\/test 'unsafe-inline'/)
  assert.doesNotMatch(html, /undefined/, '插值遗漏会留下 undefined')
})

test('面板 JS 能被 JS 引擎解析（模板字符串事故会被这条挡住）', () => {
  // 面板 JS 写在 TS 模板字符串里：漏转义的 ${...} 会被 TS 在构建期吃掉，
  // 产物变成一段坏掉的 JS —— 编译不报错，打开面板却一片空白。
  // 真正能抓它的是「让 JS 引擎解析这段产物」。
  const body = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.indexOf('</script>'))
  assert.ok(body.length > 200, 'script 段应有内容')
  assert.match(body, /acquireVsCodeApi\(\)/)
  assert.doesNotThrow(() => new vm.Script(body, { filename: 'overview-panel.js' }), '面板脚本必须是合法 JS')
})

test('快捷操作里有「部署后保留终端」开关，并且显示当前状态', () => {
  assert.match(html, /toggleKeepTerminal/, '按钮要指向切换命令')
  assert.match(html, /部署后保留终端/, '标题要看得懂')
  assert.match(html, /keepTerminal/, '要按状态显示开/关，而不是写死')
})

test('总览面板里也能看见广播：快捷开关 + 每台会话的「广播中」标记', () => {
  assert.match(html, /toggleBroadcast/, '按钮要指向广播命令')
  assert.match(html, /广播输入/, '标题要看得懂')
  assert.match(html, /broadcastCount/, '要按状态显示开/关，而不是写死')
  // 广播开着时，必须一眼看出是哪几台在收 —— 否则在同一排会话卡片里分不清
  assert.match(html, /x\.broadcasting/, '会话卡片要按 broadcasting 标记')
  assert.match(html, /广播中/, '要有看得见的标记文字')
})

test('每台会话卡片上能直接勾广播（不用再过一个多选列表）', () => {
  assert.match(html, /toggleBroadcastSession/, '要有「加入/移出广播」这个动作')
  assert.match(html, /加入广播/)
  assert.match(html, /移出广播/, '已在广播里的那台要显示成「移出」')
  // 只读会话不参与广播：这点必须**看得见**（禁用的按钮也要渲染出来并说明原因）
  assert.match(html, /不参与广播/)
  assert.match(html, /btnOff|disabled/, '禁用态要渲染出来，而不是把按钮藏掉')
})

test('广播开着时面板里要能看见并切换「原样同步 / 整行发送」', () => {
  assert.match(html, /toggleBroadcastMode/, '要有切模式的动作')
  assert.match(html, /广播模式：/)
  assert.match(html, /broadcastModeLabel/, '要按当前设置显示，而不是写死')
})

test('面板依赖的关键契约都在：消息类型', () => {
  for (const t of ['state', 'focusSession', 'toggleReadOnly', 'closeSession', 'stopForward', 'stopDeploy', 'action']) {
    assert.ok(html.includes(`'${t}'`), `面板应处理消息类型 ${t}`)
  }
  assert.match(html, /vscode\.postMessage/, '按钮要能回发消息')
  assert.match(html, /addEventListener\('message'/)
})

test('面板对内容做了转义（会话名/文件名可能含 < >）', () => {
  assert.match(html, /replace\(\/\[&<>"'\]\/g/, '应有 HTML 转义函数')
})

test('渲染出来的 HTML 里 div 标签是配平的', () => {
  const open = (html.match(/<div\b/g) ?? []).length
  const close = (html.match(/<\/div>/g) ?? []).length
  assert.equal(open, close, `<div> 开合数量不一致：${open} vs ${close}`)
})
