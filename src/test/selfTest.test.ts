// 「自检执行协议」的断言逻辑（不碰真终端，纯逻辑测试）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SELF_TEST_STEPS, formatSelfTestTable, runSelfTest } from '../selfTest'
import type { ExecResponse } from '../execResult'

const ok = (extra: Record<string, unknown> = {}, text = ''): ExecResponse => ({
  text,
  structured: { status: 'completed', exitCode: 0, markerSeen: true, elapsedMs: 120, ...extra }
})

/** 按命令分派的假 exec / wait */
function fakeImpl(over: {
  trueRes?: ExecResponse
  falseRes?: ExecResponse
  echoRes?: ExecResponse
  firstRes?: ExecResponse
  waitRes?: ExecResponse
}) {
  const exec = async (input: { command: string }): Promise<ExecResponse> => {
    if (input.command === 'true') return over.trueRes ?? ok()
    if (input.command === 'false') return over.falseRes ?? ok({ status: 'failed', exitCode: 1 }, '')
    if (input.command.startsWith('echo')) return over.echoRes ?? ok({}, 'selftest-a\nselftest-b\n')
    return over.firstRes ?? { text: '', structured: { status: 'working', jobId: 'j-1' } }
  }
  const wait = async (): Promise<ExecResponse> => over.waitRes ?? ok({}, 'selftest-done\n')
  return { exec, wait }
}

test('四条内置命令：全绿时 ok=true，且表里 4 行都通过', async () => {
  const { rows, ok: allOk } = await runSelfTest(...Object.values(fakeImpl({})) as [never, never])
  assert.equal(rows.length, 4)
  assert.equal(allOk, true, rows.map((r) => `${r.name}:${r.pass}${r.why ? ' ' + r.why : ''}`).join(' | '))
})

test('★ 退出码 0 被当成"没拿到退出码" → 第一条必须红（0.3.10 的真实 bug）', async () => {
  const { rows, ok: allOk } = await runSelfTest(
    ...(Object.values(
      fakeImpl({ trueRes: { text: '[退出码未知：没拿到结束标记]', structured: { status: 'completed', exitCode: 0, markerSeen: false } } })
    ) as [never, never])
  )
  // 结构化是对的（exitCode 0），所以这条应通过；但如果 exitCode 缺失就必须红
  assert.equal(rows[0].pass, true)
  assert.equal(allOk, true)

  const missing = await runSelfTest(
    ...(Object.values(fakeImpl({ trueRes: { text: '', structured: { status: 'completed', markerSeen: false } } })) as [never, never])
  )
  assert.equal(missing.rows[0].pass, false, 'exitCode 缺失时必须判失败')
})

test('★ 静默命令永远不完成（作业自持完成坏了）→ 第四条必须红', async () => {
  const { rows } = await runSelfTest(
    ...(Object.values(
      fakeImpl({ waitRes: { text: '', structured: { status: 'working', jobId: 'j-1', elapsedMs: 20000 } } })
    ) as [never, never])
  )
  assert.equal(rows[3].pass, false)
  assert.match(rows[3].why ?? '', /作业自持完成/)
})

test('★ 正文被哨兵截断（有输出那条）→ 第三条必须红', async () => {
  const { rows } = await runSelfTest(
    ...(Object.values(fakeImpl({ echoRes: ok({}, 'selftest-a\n') })) as [never, never])
  )
  assert.equal(rows[2].pass, false)
  assert.match(rows[2].why ?? '', /哨兵/)
})

test('表格渲染：含期望/实际/结论，失败项带原因', () => {
  const text = formatSelfTestTable(
    [
      { name: '成功命令', expect: 'completed + exitCode 0', pass: true, actual: 'status=completed exitCode=0' },
      { name: '失败命令', expect: 'failed + exitCode 1', pass: false, actual: 'status=completed', why: '期望 failed' }
    ],
    '#1 deploy@host'
  )
  assert.match(text, /#1 deploy@host/)
  assert.match(text, /✅ 成功命令/)
  assert.match(text, /❌ 失败命令/)
  assert.match(text, /期望：failed \+ exitCode 1/)
  assert.match(text, /原因：期望 failed/)
  assert.match(text, /结论：1\/2 通过/)
})

test('四条命令都是内置的、不含任何用户输入（安全边界）', () => {
  assert.deepEqual(
    SELF_TEST_STEPS.map((s) => s.command),
    ['true', 'false', 'echo selftest-a; echo selftest-b', 'sleep 8; echo selftest-done']
  )
  for (const s of SELF_TEST_STEPS) {
    assert.doesNotMatch(s.command, /rm|dd|mkfs|shutdown|reboot|>|\$\(/)
  }
})
