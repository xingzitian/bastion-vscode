/**
 * 把「连不上」的原始错误翻译成**人话 + 能不能重试**。
 *
 * 为什么单独抽出来：这条路径（连堡垒机）是全扩展最容易出错的环节，
 * 而 ssh2 抛出来的原文长这样：
 *   All configured authentication methods failed
 * 用户看到这串英文，既分不清是**动态码错了**还是**密码错了**，也不知道该不该再试一次。
 * 实测最扎心的一次是连续失败 6 次、每次都从头再来 —— 所以这里做两件事：
 *   1. 分清「动态码问题」和「密码问题」，给中文说明
 *   2. 明确「值不值得重试」：动态码每 30 秒换一个，值得；密码错了，重试没意义
 *
 * 纯函数，不碰 vscode —— 见 test/authError.test.ts。
 */

export type ConnectErrorKind = 'mfa' | 'password' | 'hostkey' | 'timeout' | 'network' | 'cancelled' | 'unknown'

export interface ConnectErrorInfo {
  kind: ConnectErrorKind
  /** 值不值得原样再试一次 */
  retryable: boolean
  /** 给用户看的中文说明 */
  message: string
}

/** ssh2 在认证失败时给的 level 值 */
const AUTH_LEVEL = 'client-authentication'

/**
 * 认证失败最多自动重试几次。
 * 动态码输错是常事（实测连着错 6 次），但也不能无限弹窗 —— 3 次够了。
 */
export const MAX_AUTH_ATTEMPTS = 3

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err ?? '未知错误')
}

/** 这条错误是不是「认证没通过」？（区别于「用着用着断了」） */
export function isAuthFailure(err: unknown): boolean {
  const level = (err as { level?: string } | undefined)?.level
  if (level === AUTH_LEVEL) return true
  return /all configured authentication methods failed|authentication failure|认证失败/i.test(rawMessage(err))
}

/**
 * @param err      原始错误（ssh2 的 Error 或我们自己抛的）
 * @param usedMfa  这次认证过程中**问过动态码**吗？问过才敢说「动态码可能错了」
 * @param target   目标地址，用在提示里（可选）
 */
export function describeConnectError(
  err: unknown,
  opts: { usedMfa: boolean; target?: string } = { usedMfa: false }
): ConnectErrorInfo {
  const msg = rawMessage(err)
  const level = (err as { level?: string } | undefined)?.level
  const where = opts.target ? `${opts.target} ` : ''

  // 用户自己取消的，不是错误
  if (/用户取消|已取消|cancell?ed by user/i.test(msg)) {
    return { kind: 'cancelled', retryable: false, message: '已取消连接' }
  }

  // 主机密钥校验：不该自动重试，得人去确认（这是中间人攻击的唯一提示）
  if (/host key|hostkey|verification failed|主机密钥/i.test(msg)) {
    return {
      kind: 'hostkey',
      retryable: false,
      message: `主机密钥校验没通过（${where}可能换过密钥，也可能有人在中间）。确认过再清掉已知主机记录重新连。`
    }
  }

  // 认证失败：这是最常见、也最该说清楚的一类
  const authFailed =
    level === AUTH_LEVEL || /all configured authentication methods failed|authentication failure|认证失败/i.test(msg)
  if (authFailed) {
    if (opts.usedMfa) {
      return {
        kind: 'mfa',
        retryable: true,
        // 注意：这句话会出现在**终端黄字、警告弹窗、错误弹窗、日志**四个地方，
        // 全都是纯文本 —— 不许出现 markdown 记号，否则用户看到的是字面的 `**`。
        message: `动态码没通过（${where}动态码 30 秒换一次，可能输错或已过期）。重试只重新问动态码，密码不用再输。`
      }
    }
    return {
      kind: 'password',
      retryable: false,
      message: `认证没通过（${where}用户名或密码不对，也可能是这个账号不允许密码登录）。重试前先确认档案里的用户名和认证方式。`
    }
  }

  // 超时 / 网络
  if (/timed out|timeout|ETIMEDOUT|readyTimeout/i.test(msg)) {
    return {
      kind: 'timeout',
      retryable: true,
      message: `连接超时（${where}网络不通、或堡垒机没响应）。可以重试一次；一直超时就检查网络/端口。`
    }
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|被远端关闭|连接被远端关闭/i.test(msg)) {
    return {
      kind: 'network',
      retryable: true,
      message: `连不上 ${where}（网络不通或被拒绝）。可以重试；一直失败就确认地址和端口。`
    }
  }

  return { kind: 'unknown', retryable: false, message: `连接失败：${msg}` }
}

/**
 * 这次失败要不要**当场自动重试**。两个条件缺一不可：
 *   - 这类错误重试有意义（动态码 / 超时 / 网络）；密码错、指纹变了、取消、未知都不问
 *   - 还没到次数上限（`attempt` 从 1 数起，所以最多试 MAX_AUTH_ATTEMPTS 次）
 *
 * 抽成纯函数是因为「最多几次」这条最容易被后面的改动弄丢 ——
 * 而它一旦变成无限重试，用户就会被一次次问动态码按在椅子上。
 *
 * 注意：重试是**自动**的（只把说明写进终端，不弹「要不要重试」的窗）——
 * 动态码 30 秒就换，为了点一个按钮把码等过期是实打实的难受。
 */
export function shouldOfferRetry(
  info: Pick<ConnectErrorInfo, 'kind' | 'retryable'>,
  attempt: number,
  max = MAX_AUTH_ATTEMPTS
): boolean {
  // 用户自己取消的永远不问：他刚刚已经表达了「不想连」
  if (info.kind === 'cancelled') return false
  return info.retryable && attempt < max
}
