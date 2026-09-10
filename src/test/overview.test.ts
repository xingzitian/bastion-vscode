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
