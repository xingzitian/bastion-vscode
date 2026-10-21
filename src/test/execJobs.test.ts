// 执行作业的状态机 / 滚动日志 / 偏移切片 / 模式等待（契约见 docs/exec-protocol.md）。
//
// 这一组测试盯的是"AI 靠什么判断命令到底怎么样了"：
//   - 还在跑 vs 卡在提示 vs 跑完了 —— 必须是**三种不同状态**，不能同一句话；
//   - 日志不能因为滚屏而丢；按 offset 读要能一段段读全；
//   - 等待必须发生在服务端（不等 AI 用 sleep 空转）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JOB_BUFFER_MAX,
  activeJobOf,
  appendJobOutput,
  cancelJob,
  completeJob,
  createJob,
  detectPrompt,
  endOffset,
  failJob,
  getJob,
  jobText,
  markInputRequired,
  resetJobs,
  resumeJob,
  sliceJob,
  waitJob,
  clampWaitMs,
  WAIT_BUDGET_MS
} from '../execJobs'

function job(sessionId = 's-1', cursorAtStart = 3) {
  return createJob({ sessionId, sessionNo: 1, command: 'make', cursorAtStart })
}

test('新建作业是 working，并且能被 activeJobOf 找到（同会话只允许一个）', () => {
  resetJobs()
  const j = job()
  assert.equal(j.state, 'working')
  assert.equal(activeJobOf('s-1')?.id, j.id)
  assert.equal(activeJobOf('s-2'), undefined)
})

test('追加输出：记录 lastLine，偏移按字节算', () => {
  resetJobs()
  const j = job()
  appendJobOutput(j, 'building...\n')
  appendJobOutput(j, 'step 2/9\n')
  assert.equal(j.lastLine, 'step 2/9')
  assert.equal(endOffset(j), Buffer.byteLength('building...\nstep 2/9\n'))
})

test('★ 三种状态必须分得开：还在跑 / 卡在提示 / 跑完了', () => {
  resetJobs()
  const running = job('s-1')
  appendJobOutput(running, 'compiling\n')
  assert.equal(running.state, 'working')

  const blocked = job('s-2')
  appendJobOutput(blocked, 'Password: ')
  markInputRequired(blocked, 'Password: ', '在等密码')
  assert.equal(blocked.state, 'input_required')
  assert.equal(blocked.prompt, 'Password: ')
  assert.ok(blocked.hint)

  const done = job('s-3')
  completeJob(done, { exitCode: 0, markerSeen: true })
  assert.equal(done.state, 'completed')
  assert.equal(done.exitCode, 0)
})

test('退出码非 0 → failed（而不是 completed），并写明原因', () => {
  resetJobs()
  const j = job()
  completeJob(j, { exitCode: 2, markerSeen: true })
  assert.equal(j.state, 'failed')
  assert.equal(j.reason, 'exit_nonzero')
})

test('没见到哨兵也算完成，但 markerSeen=false（提示"可能还差一点"）', () => {
  resetJobs()
  const j = job()
  completeJob(j, { exitCode: 0, markerSeen: false })
  assert.equal(j.state, 'completed')
  assert.equal(j.markerSeen, false)
})

test('人能输入之后回到 working（input_required ⇄ working）', () => {
  resetJobs()
  const j = job()
  markInputRequired(j, '[Y/n]', '等确认')
  assert.equal(j.state, 'input_required')
  resumeJob(j)
  assert.equal(j.state, 'working')
  assert.equal(j.prompt, undefined)
})

test('★ 日志滚动：超过上限丢最老的，但绝对偏移连续、能按 offset 读全', () => {
  resetJobs()
  const j = job()
  appendJobOutput(j, 'A'.repeat(JOB_BUFFER_MAX))
  appendJobOutput(j, 'B'.repeat(1000)) // 触发丢弃
  assert.ok(j.dropped > 0, '应该丢了最老的字节')
  assert.ok(j.buffer.length <= JOB_BUFFER_MAX)

  // 从"当前还在的起点"读：读到的应该是 B 段
  const fromTail = endOffset(j) - 1000
  const { chunk, nextOffset } = sliceJob(j, fromTail)
  assert.match(chunk, /^B+$/)
  assert.equal(nextOffset, endOffset(j))

  // 从头（已被丢掉的部分）读：不报错，返回剩下的全部
  const all = sliceJob(j, 0, JOB_BUFFER_MAX)
  assert.ok(all.chunk.length > 0)
})

test('按 offset 分页读：三页拼起来等于原文（不丢不重）', () => {
  resetJobs()
  const j = job()
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join('')
  appendJobOutput(j, text)
  let off = 0
  let got = ''
  for (let i = 0; i < 100; i++) {
    const r = sliceJob(j, off, 97)
    if (r.chunk === '') break
    got += r.chunk
    off = r.nextOffset
  }
  assert.equal(got, text)
})

test('★ wait 命中模式立刻返回（不用等满超时）', async () => {
  resetJobs()
  const j = job()
  const p = waitJob(j, { pattern: '阶段 5/9 完成', waitMs: 5000 })
  setTimeout(() => appendJobOutput(j, '阶段 4/9 完成\n阶段 5/9 完成\n'), 20)
  const started = Date.now()
  const r = await p
  assert.equal(r.matched, true)
  assert.match(r.matchedLine ?? '', /阶段 5\/9 完成/)
  assert.ok(Date.now() - started < 2000, '不应该等满 5 秒')
})

test('wait 超时返回 matched=false 但状态仍是 working（不是错误）', async () => {
  resetJobs()
  const j = job()
  const r = await waitJob(j, { pattern: 'never', waitMs: 50 })
  assert.equal(r.status, 'working')
  assert.equal(r.matched, false)
})

test('wait 在作业完成时返回，带退出码', async () => {
  resetJobs()
  const j = job()
  const p = waitJob(j, { waitMs: 5000 })
  setTimeout(() => completeJob(j, { exitCode: 0, markerSeen: true }), 20)
  const r = await p
  assert.equal(r.status, 'completed')
  assert.equal(r.exitCode, 0)
})
test('waitMs 夹紧：默认 15s，上限是客户端预算内（不许让 AI 等到客户端超时）', () => {
  assert.equal(clampWaitMs(undefined), 15_000)
  assert.equal(clampWaitMs(0), 0)
  assert.equal(clampWaitMs(20_000), 20_000)
  assert.equal(clampWaitMs(WAIT_BUDGET_MS * 10), WAIT_BUDGET_MS)
  assert.equal(clampWaitMs(Number.NaN), 15_000)
})

test('模式只是正则片段时不会崩（非法正则会退化成"不等模式"）', async () => {
  resetJobs()
  const j = job()
  const r = await waitJob(j, { pattern: '([', waitMs: 30 })
  assert.equal(r.matched, false)
})

test('取消 → cancelled，并且不再占用会话', () => {
  resetJobs()
  const j = job()
  cancelJob(j)
  assert.equal(j.state, 'cancelled')
  assert.equal(activeJobOf('s-1'), undefined)
})

test('会话丢了 → failed + reason=session_lost（要和"参数指认不到"区分开）', () => {
  resetJobs()
  const j = job()
  failJob(j, 'session_lost')
  assert.equal(j.state, 'failed')
  assert.equal(j.reason, 'session_lost')
})

test('终态之后再取消/再完成都不改变状态（幂等）', () => {
  resetJobs()
  const j = job()
  completeJob(j, { exitCode: 0, markerSeen: true })
  cancelJob(j)
  failJob(j, 'session_lost')
  assert.equal(j.state, 'completed')
})

test('输入提示识别：密码 / 动态码 / y-n / 菜单 / passphrase', () => {
  assert.ok(detectPrompt('[sudo] password for deploy: '))
  assert.ok(detectPrompt('Password: '))
  assert.ok(detectPrompt('Verification code: '))
  assert.ok(detectPrompt('Are you sure? (yes/no) '))
  assert.ok(detectPrompt('Enter passphrase for key /root/.ssh/id_ed25519: '))
  assert.ok(detectPrompt('请选择目标机 [1-9]: '))
  assert.equal(detectPrompt('build ok\n'), undefined)
})

test('jobText 只给尾部时也不炸（超大日志）', () => {
  resetJobs()
  const j = job()
  appendJobOutput(j, 'x'.repeat(40 * 1024))
  const t = jobText(j, 1024)
  assert.ok(t.length < 2048)
  assert.equal(getJob(j.id)?.id, j.id)
})
