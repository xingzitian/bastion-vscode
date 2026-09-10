// 部署报告渲染：命令输出要能看到、失败原因不丢、边界不崩
// （这些以前埋在 1569 行的 extension.ts 里，拆出来之后第一次能被单测覆盖）
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDeployReport, type DeployRun, type HostResult } from '../deployReport'
import type { DeployTask } from '../deploy'

function task(over: Partial<DeployTask> = {}): DeployTask {
  return {
    id: 't1',
    name: '部署 myapp 配置',
    profileId: '生产',
    hosts: [],
    uploads: [],
    preCommand: [],
    script: [],
    userChoice: '1',
    uri: { fsPath: '/tmp/t1.jsonc' } as never,
    ...over
  }
}

function run(over: Partial<DeployRun> = {}): DeployRun {
  return { task: task(), results: [], ms: 0, ...over }
}

function host(over: Partial<HostResult> = {}): HostResult {
  return { host: '10.0.0.1', ok: true, ms: 1200, ...over }
}

test('全成功：标题带总数，每台一个小节，标记 ✅', () => {
  const r = renderDeployReport([
    run({ results: [host({ host: '10.0.0.1' }), host({ host: '10.0.0.2' })], ms: 2000 })
  ])
  assert.equal(r.okCount, 2)
  assert.equal(r.total, 2)
  assert.match(r.markdown, /^# 部署报告/)
  assert.match(r.markdown, /2\/2 台成功/)
  assert.doesNotMatch(r.markdown, /台失败/, '全成功时不该提失败')
  assert.match(r.markdown, /### 10\.0\.0\.1 · ✅ 成功 · 1\.2s/)
  assert.match(r.markdown, /### 10\.0\.0\.2 · ✅ 成功 · 1\.2s/)
})

test('有失败：总数里带上失败台数，失败原因写在主机小节里', () => {
  const r = renderDeployReport([
    run({ results: [host({ host: '10.0.0.1' }), host({ host: '10.0.0.9', ok: false, ms: 300, error: '连接超时' })], ms: 1300 })
  ])
  assert.equal(r.okCount, 1)
  assert.equal(r.total, 2)
  assert.match(r.markdown, /1\/2 台成功\*\*，1 台失败/)
  assert.match(r.markdown, /### 10\.0\.0\.9 · ❌ 失败 · 0\.3s/)
  assert.match(r.markdown, /\*\*失败原因\*\*：连接超时/)
})

test('命令输出被记进报告（这才是「执行结果」，比耗时表有用）', () => {
  const r = renderDeployReport([
    run({
      results: [
        host({
          steps: [
            { label: '前置命令', command: 'cd /etc', output: '', captured: true, ms: 100 },
            {
              label: '脚本',
              command: 'systemctl restart myapp',
              output: 'Job for myapp.service failed because the control process exited',
              captured: true,
              ms: 2400
            }
          ]
        })
      ]
    })
  ])
  assert.match(r.markdown, /\*\*脚本\*\* `systemctl restart myapp` · 2\.4s/)
  assert.match(r.markdown, /```sh\nJob for myapp\.service failed[\s\S]*?\n```/)
})

test('无输出的命令标成「（无输出）」，不是留一片空白让人猜', () => {
  const r = renderDeployReport([
    run({ results: [host({ steps: [{ label: '前置命令', command: 'cd /etc', output: '   ', captured: true, ms: 50 }] })] })
  ])
  assert.match(r.markdown, /_（无输出）_/)
})

test('交互式命令说明为什么没输出，并指路怎么去看现场', () => {
  const r = renderDeployReport([
    run({ results: [host({ steps: [{ label: '前置命令', command: 'sudo -i', output: '', captured: false, ms: 1500 }] })] })
  ])
  assert.match(r.markdown, /输出无法可靠捕获/)
  assert.match(r.markdown, /deployTerminalPolicy/)
  assert.doesNotMatch(r.markdown, /```sh/, '没输出就不该有空代码块')
})

// ---------------------------------------------------------------------------
// 「上传之后命令没被执行」这个真实故障的报告表现。
// 实测：上传成功后紧跟着的 `cat README.md` 只捕获到一个提示符、耗时 3.1s
// （正好是 exec 的 3 秒静止兜底 → 哨兵从未出现），而上传失败的那次同一句
// `cat` 秒回并捕获到了 `Permission denied`。差别就是远端 rz 还没退出。
// 以前报告只显示「有这一步、没输出」，看起来像脚本没打印东西 —— 得说清楚。
// ---------------------------------------------------------------------------
test('没等到结束标记的命令：明确警告「很可能没被执行」，并点出常见原因是 rz 占着终端', () => {
  const r = renderDeployReport([
    run({
      results: [
        host({
          steps: [
            {
              label: '脚本',
              command: 'cat README.md',
              output: '[root@srv tmp]#',
              captured: true,
              pending: true,
              ms: 3100
            }
          ]
        })
      ]
    })
  ])
  assert.match(r.markdown, /没等到这条命令的结束标记/)
  assert.match(r.markdown, /没有真正执行/)
  assert.match(r.markdown, /rz/)
  assert.match(r.markdown, /\[root@srv tmp\]#/, '捕获到的那点东西仍然照实显示')
})

test('正常等到结束标记的命令不出现「没等到」警告（别误报）', () => {
  const r = renderDeployReport([
    run({
      results: [
        host({ steps: [{ label: '脚本', command: 'cat README.md', output: '# MYAPP', captured: true, ms: 120 }] })
      ]
    })
  ])
  assert.doesNotMatch(r.markdown, /没等到这条命令的结束标记/)
})

test('超长输出被截断，并写明截断（避免报告变成巨型日志）', () => {
  const long = 'x'.repeat(9000)
  const r = renderDeployReport([
    run({ results: [host({ steps: [{ label: '脚本', command: 'cat big.log', output: long, captured: true, ms: 10 }] })] })
  ])
  assert.match(r.markdown, /已截断到 4000 字符/)
  assert.ok(r.markdown.length < 6000, '报告不该把 9000 字符原样塞进去')
})

test('输出里带 ``` 时换更长的围栏，不让 markdown 破掉', () => {
  const out = '这里有个围栏\n```\necho hi\n```\n结束'
  const r = renderDeployReport([
    run({ results: [host({ steps: [{ label: '脚本', command: 'cat a.md', output: out, captured: true, ms: 10 }] })] })
  ])
  assert.match(r.markdown, /````sh/, '应升级成四引号围栏')
})

test('直连档案：报告标明是直连且不写「选用户序号」', () => {
  const r = renderDeployReport([run({ results: [host({ direct: true })] })])
  assert.match(r.markdown, /直连（目标机就是档案本身）/)
  assert.doesNotMatch(r.markdown, /选用户序号/, '直连没有选用户这一步，报表里不该出现')
})

test('堡垒机档案：照旧标明选用户序号', () => {
  const r = renderDeployReport([run({ task: task({ profileId: '国内', userChoice: '2' }), results: [host()] })])
  assert.match(r.markdown, /堡垒机，选用户序号 2/)
})

test('被手动停止的主机标成「未执行」并计入总数', () => {
  const r = renderDeployReport([
    run({
      results: [host({ host: 'a', ok: true }), host({ host: 'b', ok: false, skipped: true, error: '用户手动停止，未执行', ms: 0 })]
    })
  ])
  assert.equal(r.total, 2)
  assert.equal(r.okCount, 1)
  assert.match(r.markdown, /其中 1 台因手动停止未执行/)
  assert.match(r.markdown, /### b · ⏹ 未执行（已停止）/)
})

test('上传文件只显示文件名，带反引号', () => {
  const r = renderDeployReport([run({ task: task({ uploads: ['D:/work/myapp.yaml', '/home/u/a.sh'] }), results: [host()] })])
  assert.match(r.markdown, /- 上传：`myapp\.yaml`、`a\.sh`/)
  assert.doesNotMatch(r.markdown, /D:\/work/, '不该把完整路径铺在报告里')
})

test('没有 uploads 时不写这一行', () => {
  const r = renderDeployReport([run({ task: task({ uploads: [] }), results: [host()] })])
  assert.doesNotMatch(r.markdown, /- 上传：/)
})

test('没填要执行的命令时明确写出来，不留空白', () => {
  const r = renderDeployReport([run({ results: [host({ steps: [] })] })])
  assert.match(r.markdown, /_（没有要执行的命令）_/)
})

test('多任务：一个任务一个二级标题，汇总跨任务累计', () => {
  const r = renderDeployReport([
    run({ task: task({ name: '任务A' }), results: [host({ host: 'a1' })], ms: 100 }),
    run({ task: task({ name: '任务B' }), results: [host({ host: 'b1', ok: false, error: 'x' })], ms: 200 })
  ])
  assert.equal(r.total, 2)
  assert.equal(r.okCount, 1)
  assert.match(r.markdown, /## 任务A（1\/1 成功/)
  assert.match(r.markdown, /## 任务B（0\/1 成功/)
  assert.match(r.markdown, /- 任务数：2/)
  assert.match(r.markdown, /1\/2 台成功/)
})

test('userChoice 为空（不选用户）时不编造默认值 —— 现状是原样留空', () => {
  const r = renderDeployReport([run({ task: task({ userChoice: '' }), results: [host()] })])
  // 现状：模板直接插值，空串就留空 → 报告里是「选用户序号 ）」。
  // 不算错，但读起来别扭；要改成「（不需要选用户）」的话改 renderDeployReport 即可，这条用例会跟着变。
  assert.match(r.markdown, /选用户序号 \）/)
  assert.doesNotMatch(r.markdown, /选用户序号 1/, '绝不能凭空补一个 1 进报告')
})

test('userChoice 为 "1" 时正常呈现', () => {
  const r = renderDeployReport([run({ task: task({ userChoice: '1' }), results: [host()] })])
  assert.match(r.markdown, /选用户序号 1\）/)
})

test('没有任何结果时不崩（边界）', () => {
  const r = renderDeployReport([run({ results: [], ms: 0 })])
  assert.equal(r.total, 0)
  assert.equal(r.okCount, 0)
  assert.match(r.markdown, /0\/0 台成功/)
})

test('总耗时按各任务之和呈现', () => {
  const r = renderDeployReport([run({ ms: 61000 }), run({ ms: 2000 })])
  assert.match(r.markdown, /- 总耗时：1m3s/)
})
