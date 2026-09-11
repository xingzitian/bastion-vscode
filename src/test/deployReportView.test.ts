// 部署报告面板：数据模型 + HTML 产物
//
// 和 overview 面板同样的道理 —— 面板的 JS 写在模板字符串里，任何漏转义的 ${...}
// 都会被 TS 在构建期吃掉，产物变成坏掉的 JS（面板一片空白，编译期毫无提示）。
// 所以这里既测「数据模型对不对」，也测「产物能不能被 JS 引擎解析」。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vm from 'node:vm'
import { toReportView, sortHostsForPanel, buildReportHtml, type ReportHostView } from '../deployReportView'
import type { DeployRun } from '../deployReport'
import type { DeployTask } from '../deploy'

const host = (over: Partial<ReportHostView>): ReportHostView => ({
  host: '10.0.0.1',
  ok: true,
  ms: 1200,
  steps: [],
  ...over
})

const run = (results: DeployRun['results']): DeployRun => ({
  task: {
    name: '部署配置',
    profileId: 'p',
    hosts: [],
    uploads: [],
    preCommand: [],
    script: [],
    userChoice: '1'
  } as unknown as DeployTask,
  results,
  ms: 5000
})

test('toReportView：汇总台数与成功数，并带上任务名', () => {
  const view = toReportView([run([host({ ok: true }), host({ host: '10.0.0.2', ok: false, error: '连不上' })])])
  assert.equal(view.total, 2)
  assert.equal(view.okCount, 1)
  assert.equal(view.name, '部署配置')
  assert.equal(view.hosts.length, 2)
})

test('toReportView：失败置顶（没跑的 > 失败 > 成功）', () => {
  const view = toReportView([
    run([
      host({ host: 'ok1', ok: true }),
      host({ host: 'skip1', ok: false, skipped: true }),
      host({ host: 'bad1', ok: false, error: 'x' }),
      host({ host: 'ok2', ok: true })
    ])
  ])
  assert.deepEqual(
    view.hosts.map((h) => h.host),
    ['skip1', 'bad1', 'ok1', 'ok2'],
    '顺序应为：未执行 → 失败 → 成功（同档内保持原顺序）'
  )
})

test('sortHostsForPanel：稳定排序，不改原数组', () => {
  const input = [host({ host: 'a', ok: true }), host({ host: 'b', ok: false })]
  const out = sortHostsForPanel(input)
  assert.deepEqual(out.map((h) => h.host), ['b', 'a'])
  assert.deepEqual(input.map((h) => h.host), ['a', 'b'], '不应就地改原数组')
})

test('toReportView：保留每条命令的输出与「没等到结束标记」标记', () => {
  const view = toReportView([
    run([
      host({
        steps: [
          { label: '脚本', command: 'cat README.md', output: '# hi', captured: true, ms: 100 },
          { label: '脚本', command: 'sleep 1', output: '', captured: true, pending: true, ms: 3000 }
        ]
      })
    ])
  ])
  assert.equal(view.hosts[0].steps.length, 2)
  assert.equal(view.hosts[0].steps[1].pending, true, 'pending 必须带过去，否则面板会把它显示成「跑了但没输出」')
})

test('toReportView：可 JSON 序列化（要写 .json 副本，重启后还能开面板）', () => {
  const view = toReportView(
    [run([host({ ok: false, error: 'boom', steps: [{ label: '脚本', command: 'a', output: 'out', captured: true, ms: 5 }] })])],
    'file:///t.jsonc'
  )
  const round = JSON.parse(JSON.stringify(view)) as typeof view
  assert.equal(round.taskUri, 'file:///t.jsonc')
  assert.equal(round.okCount, 0)
  assert.equal(round.total, 1)
  const s = round.hosts[0].steps[0]
  assert.equal(s.label, '脚本')
  assert.equal(s.command, 'a')
  assert.equal(s.output, 'out', '每条命令的输出要无损还原')
  assert.equal(s.captured, true)
  assert.equal(round.hosts[0].error, 'boom')
  // 明确：值为 undefined 的可选字段（direct/skipped/pending）被 JSON 丢掉是正常的、无害的
  assert.equal('direct' in round.hosts[0], false)
  assert.equal('pending' in s, false)
})

test('HTML：是一份完整 HTML，且插值不出 undefined', () => {
  const html = buildReportHtml('vscode-webview://t', toReportView([run([host({})])]))
  assert.match(html, /^<!DOCTYPE html>/)
  assert.match(html, /<\/html>$/)
  assert.match(html, /<div id="root">/)
  assert.doesNotMatch(html, /undefined/)
})

test('HTML：CSP 的 nonce 和 script 标签上的一致', () => {
  const html = buildReportHtml('vscode-webview://t', toReportView([run([host({})])]))
  const inCsp = html.match(/script-src 'nonce-([a-z0-9]+)'/)
  const inTag = html.match(/<script nonce="([a-z0-9]+)">/)
  assert.ok(inCsp && inTag)
  assert.equal(inCsp![1], inTag![1], '两处 nonce 必须一致，否则脚本被 CSP 拦掉、面板空白')
})

test('HTML：面板脚本能被 JS 引擎解析（模板字符串事故会被这条挡住）', () => {
  const html = buildReportHtml('vscode-webview://t', toReportView([run([host({})])]))
  const body = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.indexOf('</script>'))
  assert.ok(body.length > 500)
  assert.match(body, /acquireVsCodeApi\(\)/)
  assert.doesNotThrow(() => new vm.Script(body, { filename: 'report-panel.js' }), '面板脚本必须是合法 JS')
})

test('HTML：把执行结果内嵌成 JSON（不是拼字符串进 DOM），避免 XSS/破坏结构', () => {
  // 恶意/带尖括号的输出不该出现在 HTML 里当标签用
  const evil = '10.0.0.9'
  const html = buildReportHtml(
    'vscode-webview://t',
    toReportView([
      run([
        host({
          host: evil,
          ok: false,
          steps: [{ label: '脚本', command: 'echo </script><img src=x>', output: '<b>bold</b>', captured: true, ms: 1 }]
        })
      ])
    ])
  )
  const injected = html.slice(0, html.indexOf('<script nonce='))
  assert.ok(!injected.includes('<img src=x>'), '命令内容不该直接进 DOM 结构（它在 JSON 里，由前端 esc 处理）')
  assert.match(html, /\\u003c\/script>/, 'JSON 里的 </script> 必须转义，否则会把脚本标签提前闭合')
})

test('HTML：三个操作按钮都在（重跑这台 / 发 AI / 打开 Markdown）', () => {
  const html = buildReportHtml('vscode-webview://t', toReportView([run([host({ ok: false })])]))
  for (const t of ['rerunHost', 'sendToAI', 'openMarkdown']) {
    assert.ok(html.includes(t), `面板应支持 ${t}`)
  }
  assert.ok(html.includes('重跑这台'))
})

test('HTML：失败的那台默认展开（不用再点一下）', () => {
  const html = buildReportHtml(
    'vscode-webview://t',
    toReportView([run([host({ host: 'bad', ok: false, error: 'e' }), host({ host: 'good', ok: true })])])
  )
  assert.match(html, /class="card' \+ \(h\.ok \? '' : ' open'\)/, '渲染逻辑里失败卡片带 open 类')
  assert.match(html, /\.card\.open \.body \{ display: block; \}/, 'open 类要真的把内容展开')
})
