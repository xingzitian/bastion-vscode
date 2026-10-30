// 行动账本：记录生成 / 落盘格式 / 分组 / 面板渲染（纯逻辑，不碰 vscode）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeGroup,
  groupByIntent,
  parseLedger,
  pruneRecords,
  recordFromJob,
  toJsonl,
  upsertRecord,
  type ActionRecord
} from '../actionLedger'
import { renderActionsHtml } from '../actionPanelHtml'
import { completeJob, createJob, failJob, resetJobs } from '../execJobs'

function rec(over: Partial<ActionRecord> = {}): ActionRecord {
  return {
    v: 1,
    actionId: 'j-1',
    sessionNo: 1,
    sessionId: 's-1',
    why: '',
    brief: 'true',
    steps: 1,
    command: 'true',
    redacted: false,
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    elapsedMs: 1000,
    ...over
  }
}

test('从作业生成记录：带 why / 摘要 / 脱敏标记，跑完的才有 endedAt', () => {
  resetJobs()
  const job = createJob({
    sessionId: 's-9',
    sessionNo: 9,
    command: 'mysql -pS3cret -e "select 1"',
    cursorAtStart: 0,
    why: '  查  一下数据 ',
    intentId: 'i-9'
  })
  const running = recordFromJob(job, 5000)
  assert.equal(running.why, '查 一下数据', 'why 要归一化')
  assert.equal(running.intentId, 'i-9')
  assert.equal(running.redacted, true)
  assert.ok(!running.command.includes('S3cret'), '落盘的命令不能有明文密码')
  assert.equal(running.status, 'working')
  assert.equal(running.endedAt, undefined, '还在跑就不该有结束时间')

  completeJob(job, { exitCode: 0, markerSeen: true })
  const done = recordFromJob(job, 9999)
  assert.equal(done.status, 'completed')
  assert.equal(done.exitCode, 0)
  assert.ok(done.endedAt && done.endedAt > 0)
})

test('JSONL：同一 actionId 后来者覆盖；坏行跳过；顺序保持', () => {
  const a = rec({ actionId: 'j-1', status: 'working', endedAt: undefined })
  const b = rec({ actionId: 'j-1', status: 'completed' })
  const c = rec({ actionId: 'j-2', startedAt: 3000 })
  const text = [toJsonl(a), 'not-json', toJsonl(b), toJsonl(c)].join('\n')
  const out = parseLedger(text)
  assert.equal(out.length, 2)
  assert.equal(out[0].actionId, 'j-1')
  assert.equal(out[0].status, 'completed', '后来者覆盖')
  assert.equal(out[1].actionId, 'j-2')
})

test('裁剪：只留最近 N 条', () => {
  const list = Array.from({ length: 10 }, (_, i) => rec({ actionId: `j-${i}` }))
  const kept = pruneRecords(list, 3)
  assert.deepEqual(
    kept.map((r) => r.actionId),
    ['j-7', 'j-8', 'j-9']
  )
})

test('upsert：同 id 替换、其他保留', () => {
  const list = [rec({ actionId: 'a' }), rec({ actionId: 'b' })]
  const out = upsertRecord(list, rec({ actionId: 'a', status: 'failed' }))
  assert.equal(out.length, 2)
  assert.equal(out.find((r) => r.actionId === 'a')!.status, 'failed')
})

test('★ 分组：有 intentId 按它分，标题用 AI 写的 why', () => {
  const g = groupByIntent([
    rec({ actionId: 'a', intentId: 'i-1', why: '部署新版本', steps: 4, startedAt: 1 }),
    rec({ actionId: 'b', intentId: 'i-1', why: '', steps: 2, startedAt: 2 })
  ])
  assert.equal(g.length, 1)
  assert.equal(g[0].intentId, 'i-1')
  assert.equal(g[0].why, '部署新版本', '组标题取第一个非空 why')
  assert.equal(g[0].actions.length, 2)
  assert.equal(g[0].steps, 6)
  assert.equal(g[0].synthetic, false)
})

test('★ 分组：没有 intentId 时按"同会话 + 60s 内连续"归并，并标 synthetic', () => {
  const g = groupByIntent([
    rec({ actionId: 'a', sessionNo: 3, startedAt: 1000, endedAt: 2000 }),
    rec({ actionId: 'b', sessionNo: 3, startedAt: 5000, endedAt: 6000 }),
    rec({ actionId: 'c', sessionNo: 3, startedAt: 120000, endedAt: 121000 }),
    rec({ actionId: 'd', sessionNo: 4, startedAt: 5500, endedAt: 6000 })
  ])
  const s3 = g.filter((x) => x.sessionNo === 3)
  assert.equal(s3.length, 2, '60s 内的 a/b 归一组，隔太久的 c 单独一组')
  assert.equal(s3.every((x) => x.synthetic), true)
  assert.equal(s3.find((x) => x.actions.length === 2)!.actions.length, 2)
  assert.equal(g.find((x) => x.sessionNo === 4)!.actions.length, 1, '不同会话不能归到一起')
})

test('聚合状态优先级：working > input_required > failed > completed', () => {
  const run = groupByIntent([
    rec({ actionId: 'a', intentId: 'i', status: 'completed' }),
    rec({ actionId: 'b', intentId: 'i', status: 'working', endedAt: undefined })
  ])
  assert.equal(run[0].status, 'working')
  const need = groupByIntent([
    rec({ actionId: 'a', intentId: 'i', status: 'completed' }),
    rec({ actionId: 'b', intentId: 'i', status: 'input_required' })
  ])
  assert.equal(need[0].status, 'input_required')
  const bad = groupByIntent([
    rec({ actionId: 'a', intentId: 'i', status: 'completed' }),
    rec({ actionId: 'b', intentId: 'i', status: 'failed' })
  ])
  assert.equal(bad[0].status, 'failed')
  assert.equal(bad[0].failed, 1)
})

test('describeGroup：未说明目的要明说，合成分组要标注', () => {
  const g = groupByIntent([rec({ actionId: 'a', why: '' })])[0]
  const d = describeGroup(g)
  assert.match(d, /AI 未说明目的/)
  assert.match(d, /按时间归并/)
})

test('★ 面板渲染：有 why 显示 why，没 why 明确写"未说明"', () => {
  const withWhy = renderActionsHtml(groupByIntent([rec({ intentId: 'i', why: '重启服务' })]))
  assert.match(withWhy, /重启服务/)
  const noWhy = renderActionsHtml(groupByIntent([rec({ intentId: 'i', why: '' })]))
  assert.match(noWhy, /AI 未说明这条命令为了什么/)
})

test('★ 面板渲染：只有正在跑的才给「取消」按钮', () => {
  const running = renderActionsHtml(
    groupByIntent([rec({ actionId: 'a', intentId: 'i', status: 'working', endedAt: undefined })])
  )
  assert.match(running, /data-act="cancel"/)
  const done = renderActionsHtml(groupByIntent([rec({ actionId: 'a', intentId: 'i', status: 'completed' })]))
  assert.doesNotMatch(done, /data-act="cancel"/)
})

test('★ 面板渲染要转义（命令里带 HTML 不能注入）', () => {
  const html = renderActionsHtml(
    groupByIntent([rec({ intentId: 'i', command: '<img src=x onerror=alert(1)>', brief: '<b>x</b>' })])
  )
  assert.ok(!html.includes('<img src=x'), '不能把命令原文当 HTML 插进去')
  assert.match(html, /&lt;img/)
})

test('空账本：面板给出人话提示，不空白', () => {
  assert.match(renderActionsHtml([]), /还没有 AI 动作/)
})
