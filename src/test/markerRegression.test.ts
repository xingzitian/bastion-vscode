// terminal.ts 依赖 vscode：测试必须先装桩（和别的 terminal 测试一样）
import '../testkit/vscode-stub'
// 压测回归：标记识别不能要求"行首"、elapsed 要按"完成时刻"、y/n 提示要识别。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMarkerLine } from '../terminal'
import { appendJobOutput, createJob, quietExpired, resetJobs, viewOf } from '../execJobs'
import { detectPrompt } from '../execJobs'

const M = '__BASTION_DONE_abc__'

test('★ 哨兵识别不要求行首（真机上前面常带 ANSI/提示符残留）', () => {
  // 上一版要求整行 equals/startsWith → 这里全部漏判，表现是"命令跑完了却报退出码未知"
  assert.deepEqual(readMarkerLine(`${M}:0`, M), { seen: true, rc: 0 })
  assert.deepEqual(readMarkerLine(`\x1b[K${M}:0`, M), { seen: true, rc: 0 })
  assert.deepEqual(readMarkerLine(`bash-5.1$ ${M}:7\r\n`, M), { seen: true, rc: 7 })
  assert.deepEqual(readMarkerLine(`prefix text ${M}:0 trailing`, M), { seen: true, rc: 0 })
})

test('哨兵识别：命令回显（字面量 $ec）不能当成完成', () => {
  assert.deepEqual(readMarkerLine(`true; ec=$?; echo ${M}:$ec`, M), { seen: false })
  assert.deepEqual(readMarkerLine('something else', M), { seen: false })
  assert.deepEqual(readMarkerLine('', M), { seen: false })
})

test('★ elapsed 按"完成时刻"算，不随再查询而变（压测里 25s 的命令报成 41s）', () => {
  resetJobs()
  const job = createJob({ sessionId: 's-ela', sessionNo: 1, command: 'sleep 25', cursorAtStart: 0, marker: M })
  const started = job.startedAt
  job.startedAt = started - 25000 // 假装 25 秒前开始
  job.completedAt = job.startedAt + 25000 // 刚完成
  const first = viewOf(job, Date.now()).elapsedMs
  const second = viewOf(job, Date.now() + 16000).elapsedMs
  assert.equal(first, 25000)
  assert.equal(second, 25000, '★ 再查一次也不能变成 41s')
})

test('y/n 提示：尾部带冒号也要识别（Continue? (y/n): ）', () => {
  const hit = detectPrompt('Continue? (y/n): ')
  assert.ok(hit, `应该识别为 input_required，实际 ${JSON.stringify(hit)}`)
  assert.match(hit!.hint, /y\/n|确认/)
  assert.ok(detectPrompt('Are you sure? (yes/no) '))
  // 凭据类仍然优先
  assert.match(detectPrompt('Password: ')!.hint, /密码/)
})

test('静默判定与标记判定互不干扰（标记先到 → 不需要等静默）', () => {
  resetJobs()
  const job = createJob({ sessionId: 's-both', sessionNo: 1, command: 'x', cursorAtStart: 0, marker: M, quietMs: 1000 })
  appendJobOutput(job, `done ${M}:0\n`)
  assert.equal(viewOf(job).status, 'completed')
  assert.equal(quietExpired(job, Date.now() + 5000), false, '已完成的作业不再需要静默兜底')
})
