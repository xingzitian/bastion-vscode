/**
 * 跨模块共享的**窄**类型（不 import vscode）。
 *
 * 为什么不是把 `DeployTask` 整个搬过来：它带 `uri: vscode.Uri`（扩展侧用它编辑/运行/删除任务文件），
 * 搬进 core 就等于把 vscode 类型也拖进来。core 只需要"报告要读的那几个字段"，
 * 所以这里声明一个结构子集 —— 宿主侧的 `DeployTask` 天然满足它（结构化类型），零改动。
 */

/** `deployReport` 渲染报告时真正读到的字段 */
export interface DeployReportTask {
  name: string
  profileId: string
  uploads: string[]
  /** 堡垒机选用户序号（报告里会写出来） */
  userChoice: string
}
