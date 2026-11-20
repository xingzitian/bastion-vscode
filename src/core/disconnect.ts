/**
 * 断线原因分类（纯函数，可单测）。
 *
 * 为什么要它：日志里以前只有一句 `SSH 错误: read ECONNRESET` / `连接已断开`，
 * 看起来像"莫名断了"，实际是三种完全不同的事：
 *
 *   1. **对端重置（RST）** —— 中间设备（NAT/防火墙）把空闲映射删了，
 *      或者服务端/堡垒机主动踢人。重连即可，不是我们的 bug。
 *   2. **keepalive 超时** —— 我们发的保活没回应，ssh2 判定链路死了。
 *      说明链路其实已经不通（比 RST 更早发现问题）。
 *   3. **shell 通道关闭** —— 连接还在，只是这条 shell channel 被对端关了
 *      （空闲回收、或服务端 MaxSessions）。同一连接上的其它会话可能还活着。
 *
 * 分类只影响**日志措辞**，不改变任何行为。
 */

export type DisconnectKind =
  | 'rst'
  | 'keepalive'
  | 'timeout'
  | 'refused'
  | 'eof'
  | 'channel'
  | 'shell-closed'
  | 'auth'
  | 'unknown'

export interface DisconnectVerdict {
  kind: DisconnectKind
  /** 中文短语，直接拼进日志 */
  label: string
  /** 一句话解释“接下来该怎么办”，给排障的人看 */
  hint: string
}

function textOf(err: unknown): string {
  if (!err) return ''
  if (typeof err === 'string') return err
  const e = err as { message?: string; code?: string }
  return `${e.code ?? ''} ${e.message ?? ''}`.trim()
}

/**
 * @param err 连接/通道的错误（没有错误、只是关闭时传 undefined）
 * @param when `connection` = 整条 SSH 连接；`shell` = 单条 shell 通道
 */
export function classifyDisconnect(err: unknown, when: 'connection' | 'shell' = 'connection'): DisconnectVerdict {
  const s = textOf(err).toLowerCase()

  if (/auth|authentication|all configured authentication/.test(s)) {
    return { kind: 'auth', label: '认证失败', hint: '凭据/MFA 问题，与网络无关' }
  }
  if (/keepalive/.test(s)) {
    return { kind: 'keepalive', label: 'keepalive 超时', hint: '保活没回应 —— 链路其实已断（比 RST 更早发现）' }
  }
  if (/econnreset|reset by peer|socket hang up/.test(s)) {
    return {
      kind: 'rst',
      label: '对端重置（RST）',
      hint: '中间设备删了空闲映射或服务端踢人；重连即可，不是本扩展的判断错误'
    }
  }
  if (/etimedout|timed?\s?out|timeout/.test(s)) {
    return { kind: 'timeout', label: '网络超时', hint: '链路不通或极慢；先看网络，再看服务端负载' }
  }
  if (/econnrefused/.test(s)) {
    return { kind: 'refused', label: '连接被拒绝', hint: '端口没开 / 服务没起 / 防火墙拦了' }
  }
  if (/econnaborted|epipe|broken pipe/.test(s)) {
    return { kind: 'rst', label: '连接被中断（EPIPE/ABORTED）', hint: '写的时候发现链路已断' }
  }
  if (/channel open failure|open failed|resource shortage/.test(s)) {
    return {
      kind: 'channel',
      label: '通道打不开（Channel open failure）',
      hint: '服务端拒绝新通道：多半是 MaxSessions 限制或连接已坏；换会话或重连'
    }
  }
  if (/eof|connection lost|closed/.test(s)) {
    return { kind: 'eof', label: '对端关闭（EOF）', hint: '正常关闭或服务端超时踢人' }
  }
  if (when === 'shell') {
    return { kind: 'shell-closed', label: 'shell 通道关闭', hint: '单条会话被关；连接可能还在，其它会话不受影响' }
  }
  return { kind: 'unknown', label: '原因未知', hint: '原始错误详见同一行' }
}

/** 日志用的完整一句：`对端重置（RST）—— 中间设备删了空闲映射…` */
export function describeDisconnect(err: unknown, when: 'connection' | 'shell' = 'connection'): string {
  const v = classifyDisconnect(err, when)
  return `${v.label} —— ${v.hint}`
}
