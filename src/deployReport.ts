/**
 * 部署报告渲染（纯函数，不碰 VS Code API）。
 *
 * 单独放一个模块是为了能直接被单元测试覆盖 —— 报告是给人看的，
 * 格式错了（比如漏了失败原因、表格串列）不该靠肉眼发现。
 */

import * as path from 'path'
import { fmtDuration } from './status'
import type { DeployTask } from './deploy'

/** 单台部署的结果 */
export interface HostResult {
  host: string
  ok: boolean
  ms: number
  error?: string
  /** 逐条命令的执行结果（含输出），报告的主体就是它 */
  steps?: StepResult[]
  /** 直连档案没有「选机/选用户」两步，报告里标注一下 */
  direct?: boolean
  /** 因为用户点了停止而没跑 */
  skipped?: boolean
}

/** 一条命令的执行结果 */
export interface StepResult {
  /** '前置命令' | '脚本' | '等待 shell' 等 */
  label: string
  command: string
  output: string
  /** 输出是否可靠捕获；false 表示是交互式/后台命令，得自己去窗口看 */
  captured: boolean
  /**
   * 发下去了但**没等到结束标记** —— 多半是命令压根没被执行
   * （终端还被 rz / 交互式程序占着），也可能还在跑。此时输出不可信。
   *
   * 为什么单独标出来：以前这种情况报告只显示「有这一步、没输出」，
   * 看起来像「命令跑了、只是没打印东西」，于是所有人都会去怀疑自己的脚本 ——
   * 而真因是上一步（上传）把终端占住了。
   */
  pending?: boolean
  ms: number
}

/** 一次任务的执行汇总 */
export interface DeployRun {
  task: DeployTask
  results: HostResult[]
  ms: number
}

/** 单条命令的输出最多保留多少字符（超了截断，避免报告变巨型日志） */
const MAX_OUTPUT_CHARS = 4000

function fence(output: string): string {
  // 输出里可能带 ``` 把围栏弄坏，遇到就换成更长的围栏
  const ticks = output.includes('```') ? '````' : '```'
  return `${ticks}sh\n${output.replace(/\s+$/, '')}\n${ticks}`
}

export function renderDeployReport(runs: DeployRun[]): { markdown: string; okCount: number; total: number } {
  const lines: string[] = []
  const all = runs.flatMap((r) => r.results)
  const ran = all.filter((r) => !r.skipped)
  const okCount = all.filter((r) => r.ok).length
  const totalMs = runs.reduce((a, r) => a + r.ms, 0)

  lines.push(`# 部署报告`)
  lines.push('')
  lines.push(`- 时间：${new Date().toLocaleString()}`)
  lines.push(`- 任务数：${runs.length}`)
  lines.push(
    `- 结果：**${okCount}/${all.length} 台成功**${all.length - okCount > 0 ? `，${all.length - okCount} 台失败` : ''}` +
      (all.length - ran.length > 0 ? `（其中 ${all.length - ran.length} 台因手动停止未执行）` : '')
  )
  lines.push(`- 总耗时：${fmtDuration(totalMs)}`)
  lines.push('')

  for (const run of runs) {
    const ok = run.results.filter((r) => r.ok).length
    lines.push(`## ${run.task.name}（${ok}/${run.results.length} 成功 · ${fmtDuration(run.ms)}）`)
    lines.push('')
    const mode = run.results.some((r) => r.direct) ? '直连（目标机就是档案本身）' : '堡垒机'
    lines.push(`- 档案：\`${run.task.profileId}\`（${mode}${run.results.some((r) => r.direct) ? '' : `，选用户序号 ${run.task.userChoice}`}）`)
    if (run.task.uploads.length > 0) {
      lines.push(`- 上传：${run.task.uploads.map((p) => `\`${path.basename(p)}\``).join('、')}`)
    }
    lines.push('')

    for (const r of run.results) {
      const mark = r.skipped ? '⏹ 未执行（已停止）' : r.ok ? '✅ 成功' : '❌ 失败'
      lines.push(`### ${r.host} · ${mark} · ${(r.ms / 1000).toFixed(1)}s`)
      lines.push('')
      if (r.error) {
        lines.push(`**失败原因**：${r.error.replace(/\r?\n/g, ' ')}`)
        lines.push('')
      }
      if (r.skipped) continue

      const steps = r.steps ?? []
      if (steps.length === 0) {
        lines.push('_（没有要执行的命令）_')
        lines.push('')
        continue
      }
      for (const s of steps) {
        lines.push(`**${s.label}** \`${s.command}\` · ${(s.ms / 1000).toFixed(1)}s`)
        lines.push('')
        if (!s.captured) {
          lines.push('> 交互式 / 后台命令，输出无法可靠捕获 —— 需要看现场请把 `bastion.deployTerminalPolicy` 设为 `keep` 或 `ask`。')
        } else {
          if (s.pending) {
            lines.push(
              '> ⚠️ **没等到这条命令的结束标记** —— 它很可能**没有真正执行**（终端还被 rz 或交互式程序占着），也可能仍在运行。'
            )
            lines.push('>')
            lines.push('> 常见原因：上一步刚做完文件上传，远端的 `rz` 还没退出，我们发过去的命令被它当成协议数据吃掉了。')
          }
          if (s.output.trim()) {
            const truncated = s.output.length > MAX_OUTPUT_CHARS
            lines.push(fence(truncated ? s.output.slice(0, MAX_OUTPUT_CHARS) : s.output))
            if (truncated) lines.push(`\n_（输出过长，已截断到 ${MAX_OUTPUT_CHARS} 字符）_`)
          } else {
            lines.push('_（无输出）_')
          }
        }
        lines.push('')
      }
    }
  }
  return { markdown: lines.join('\n'), okCount, total: all.length }
}

