/**
 * 运行中的部署任务登记表。
 *
 * 单独一个模块，是为了让**树视图**能读「哪个任务在跑」而不必 import 整个执行链路
 * （deployRun 会拉进终端 / SSH / 会话）。顺带也让这块状态能被单测覆盖。
 *
 * 生命周期：runDeployTaskCore 开始时 register，结束时（finally）unregister。
 */

export interface RunningInfo {
  taskId: string
  taskName: string
  startedAt: number
  /** 已完成台数（用于显示 3/8） */
  done: number
  total: number
  /** 置 true 后任务会在**下一台开始前**停下 */
  abort: boolean
}

const running = new Map<string, RunningInfo>()

export function registerDeploy(taskId: string, taskName: string, total: number): RunningInfo {
  const info: RunningInfo = { taskId, taskName, startedAt: Date.now(), done: 0, total, abort: false }
  running.set(taskId, info)
  return info
}

export function unregisterDeploy(taskId: string): void {
  running.delete(taskId)
}

export function getRunningDeploy(taskId: string): RunningInfo | undefined {
  return running.get(taskId)
}

export function isDeployRunning(taskId: string): boolean {
  return running.has(taskId)
}

export function listRunningDeploys(): RunningInfo[] {
  return [...running.values()]
}

/** 请求停止；返回 false 表示这个任务没在跑 */
export function abortDeploy(taskId: string): boolean {
  const r = running.get(taskId)
  if (!r) return false
  r.abort = true
  return true
}

/** 仅供测试：清空登记表 */
export function __clearRunningForTest(): void {
  running.clear()
}
