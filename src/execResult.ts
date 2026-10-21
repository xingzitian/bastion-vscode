/**
 * exec 系列工具的统一返回形状。
 *
 * 单独放一个模块（不 import vscode、也不 import aiBridge）：
 * `mcpTools` 刻意保持"只依赖注入的能力"，node 单测才不用为它准备 vscode 桩。
 * `text` 给人（也兼容只读文本的客户端）；`structured` 给机器（MCP 侧可转 structuredContent）。
 */
export interface ExecResponse {
  text: string
  structured?: Record<string, unknown>
}
