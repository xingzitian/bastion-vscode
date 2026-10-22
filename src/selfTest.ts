/**
 * 「自检执行协议」的核心逻辑（不依赖 vscode，可单测）。
 *
 * 为什么要有它：哨兵前缀漏判、退出码 0 被当 falsy、静默误判成完成、会话被锁死 ——
 * 这几个坑**只有真机才暴露**，前前后后花了三个 AI 会话、四五次往返才逐个发现。
 * 这套自检把"该验的四件事"固化成四条内置命令 + 断言，换环境/换堡垒机/换客户端时
 * 30 秒自证协议层没坏，不必再拉人复测。
 *
 * 安全边界：只跑内置的四条命令（true/false/echo/printf），**不接受自定义命令**，
 * 也不在菜单态会话上跑。
 */

import type { ExecResponse } from './execResult'

export interface SelfTestStep {
  name: string
  command: string
  /** 期望（人话，显示在表里） */
  expect: string
}

export const SELF_TEST_STEPS: SelfTestStep[] = [
  { name: '成功命令', command: 'true', expect: 'completed + exitCode 0' },
  { name: '失败命令', command: 'false', expect: 'failed + exitCode 1' },
  { name: '有输出的命令', command: 'echo selftest-a; echo selftest-b', expect: 'completed，正文含 a、b' },
  { name: '先静默后输出的命令', command: 'sleep 8; echo selftest-done', expect: 'working → 等一会自动 completed' }
]

export interface SelfTestRow {
  name: string
  expect: string
  pass: boolean
  /** 实际看到的关键字段（一行） */
  actual: string
  /** 失败原因（pass=false 时给） */
  why?: string
}

const status = (r: ExecResponse): string =>
  typeof r.structured?.status === 'string' ? (r.structured.status as string) : '(缺 status)'
const exitCodeOf = (r: ExecResponse): number | undefined =>
  typeof r.structured?.exitCode === 'number' ? (r.structured.exitCode as number) : undefined

function actualOf(r: ExecResponse): string {
  const parts = [`status=${status(r)}`]
  const ec = exitCodeOf(r)
  if (ec !== undefined) parts.push(`exitCode=${ec}`)
  if (typeof r.structured?.markerSeen === 'boolean') parts.push(`markerSeen=${r.structured.markerSeen}`)
  if (typeof r.structured?.elapsedMs === 'number') parts.push(`${Math.round((r.structured.elapsedMs as number) / 1000)}s`)
  if (typeof r.structured?.jobId === 'string') parts.push(`job=${r.structured.jobId}`)
  return parts.join(' ')
}

/**
 * 跑四条自检。
 *
 * `exec` / `wait` 由调用方注入（真实实现走 aiSessionApi，测试里注入假实现）。
 * `waitMs` 给得小一点：先确认"会返回 working"，再等它自己完成 —— 这正是上一版坏掉的地方。
 */
export async function runSelfTest(
  exec: (input: { command: string; waitMs?: number; quietMs?: number }) => Promise<ExecResponse>,
  wait: (input: { jobId: string; waitMs?: number }) => Promise<ExecResponse>
): Promise<{ rows: SelfTestRow[]; ok: boolean }> {
  const rows: SelfTestRow[] = []

  const record = (step: SelfTestStep, pass: boolean, actual: string, why?: string): void => {
    rows.push({ name: step.name, expect: step.expect, pass, actual, why })
  }

  // ① true → completed / 0（退出码 0 是 falsy，最容易错的一条）
  try {
    const r = await exec({ command: SELF_TEST_STEPS[0].command, waitMs: 10_000 })
    const ok = status(r) === 'completed' && exitCodeOf(r) === 0
    record(SELF_TEST_STEPS[0], ok, actualOf(r), ok ? undefined : '期望 completed 且 exitCode 0 —— 注意 exitCode 0 不能当成"没拿到退出码"')
  } catch (e) {
    record(SELF_TEST_STEPS[0], false, '抛错', e instanceof Error ? e.message : String(e))
  }

  // ② false → failed / 1
  try {
    const r = await exec({ command: SELF_TEST_STEPS[1].command, waitMs: 10_000 })
    const ok = status(r) === 'failed' && exitCodeOf(r) === 1
    record(SELF_TEST_STEPS[1], ok, actualOf(r), ok ? undefined : '期望 failed 且 exitCode 1')
  } catch (e) {
    record(SELF_TEST_STEPS[1], false, '抛错', e instanceof Error ? e.message : String(e))
  }

  // ③ 有输出 → completed 且正文完整（哨兵解析失败时这里会露出来）
  try {
    const r = await exec({ command: SELF_TEST_STEPS[2].command, waitMs: 10_000 })
    const hasA = r.text.includes('selftest-a')
    const hasB = r.text.includes('selftest-b')
    const ok = status(r) === 'completed' && hasA && hasB
    record(
      SELF_TEST_STEPS[2],
      ok,
      `${actualOf(r)}${hasA ? ' 有a' : ' 无a'}${hasB ? ' 有b' : ' 无b'}`,
      ok ? undefined : '期望 completed 且正文同时包含 selftest-a / selftest-b（缺正文通常是哨兵行把输出截断了）'
    )
  } catch (e) {
    record(SELF_TEST_STEPS[2], false, '抛错', e instanceof Error ? e.message : String(e))
  }

  // ④ 先静默 8 秒 → 先 working，再自己 completed（静默不能单独判完成，也不能永远不完成）
  try {
    const first = await exec({ command: SELF_TEST_STEPS[3].command, waitMs: 3_000, quietMs: 15_000 })
    const st = status(first)
    const jobId = typeof first.structured?.jobId === 'string' ? (first.structured.jobId as string) : ''
    if (st === 'working' && jobId) {
      const done = await wait({ jobId, waitMs: 20_000 })
      const ok = status(done) === 'completed' && done.text.includes('selftest-done')
      record(SELF_TEST_STEPS[3], ok, `先 ${st} → ${actualOf(done)}`, ok ? undefined : '期望最终 completed 且正文含 selftest-done（没自动完成 = 作业自持完成坏了）')
    } else if (st === 'completed' && first.text.includes('selftest-done')) {
      // 命令可能在 3 秒窗口内就跑完了（极快机器）—— 也算通过，但要说明
      record(SELF_TEST_STEPS[3], true, `${actualOf(first)}（3s 内就跑完了，没经过 working）`)
    } else {
      record(SELF_TEST_STEPS[3], false, actualOf(first), '期望先返回 working + jobId（这样才验证得了"作业自持完成"）')
    }
  } catch (e) {
    record(SELF_TEST_STEPS[3], false, '抛错', e instanceof Error ? e.message : String(e))
  }

  return { rows, ok: rows.every((r) => r.pass) }
}

/** 把结果排成一张等宽的表（输出通道里看） */
export function formatSelfTestTable(rows: SelfTestRow[], sessionLabel?: string): string {
  const lines: string[] = []
  lines.push('BastionShell 执行协议自检' + (sessionLabel ? `（会话：${sessionLabel}）` : ''))
  lines.push('')
  for (const r of rows) {
    lines.push(`${r.pass ? '✅' : '❌'} ${r.name}`)
    lines.push(`   期望：${r.expect}`)
    lines.push(`   实际：${r.actual}`)
    if (!r.pass && r.why) lines.push(`   原因：${r.why}`)
  }
  const passed = rows.filter((r) => r.pass).length
  lines.push('')
  lines.push(`结论：${passed}/${rows.length} 通过${passed === rows.length ? ' —— 协议层正常' : ' —— 见上面 ❌ 项'}`)
  lines.push('')
  lines.push('说明：这四条命令都是内置的（true / false / echo / sleep+echo），不会碰你的生产命令；')
  lines.push('     它验的是「状态机 + 哨兵解析 + 作业自持完成」这三件事，')
  lines.push('     也是 0.3.10 期间踩过的坑：退出码 0 被当 falsy、哨兵行判成"没拿到"、静默误判成完成。')
  return lines.join('\n')
}
