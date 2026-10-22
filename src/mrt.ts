/**
 * MRTR（多轮往返）用到的**纯逻辑**：requestState 编解码、凭据类提示判定、取值。
 *
 * 单独放一个不依赖 vscode 的模块：协议层（mcpServer）要用它，而协议层必须能在普通 Node 里被测试。
 * 真正的"把输入写回会话"在 `aiBridge.resumeExecJob`（那需要终端对象）。
 */

export function encodeRequestState(state: { jobId: string }): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
}

export function decodeRequestState(raw: unknown): { jobId?: string } {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as { jobId?: unknown }
    return typeof v.jobId === 'string' ? { jobId: v.jobId } : {}
  } catch {
    return {}
  }
}

/** 密码 / 口令 / 动态码这类提示：**永远不代填**（不能把凭据交给 AI） */
const SECRET_PROMPT_RE = /password|passwd|密码|passphrase|verification code|动态码|验证码|\botp\b/i

export function isSecretPrompt(text: string): boolean {
  return SECRET_PROMPT_RE.test(text ?? '')
}

/** 从 inputResponses 里取第一个可用的字符串值（兼容 elicitation 的 content 形状） */
export function firstInputValue(responses: unknown): string | undefined {
  if (!responses || typeof responses !== 'object') return undefined
  for (const v of Object.values(responses as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim() !== '') return v
    if (v && typeof v === 'object') {
      const content = (v as { content?: unknown }).content
      if (typeof content === 'string' && content.trim() !== '') return content
      if (content && typeof content === 'object') {
        for (const cv of Object.values(content as Record<string, unknown>)) {
          if (typeof cv === 'string' && cv.trim() !== '') return cv
        }
      }
    }
  }
  return undefined
}

/** input_required 时给客户端的 inputRequests（elicitation 形状，客户端可展示给人） */
export function inputRequestsFor(prompt: string | undefined, hint: string | undefined): Record<string, unknown> {
  return {
    prompt: {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: [prompt ?? '需要人工输入', hint ?? ''].filter(Boolean).join('\n'),
        requestedSchema: { type: 'object', properties: {} }
      }
    }
  }
}
