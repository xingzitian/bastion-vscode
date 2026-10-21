/**
 * exec 的幂等键（P2-b）。
 *
 * 为什么需要它：`MCP_INSTRUCTIONS` 里教 AI「调用失败先**原样重试一次**」。这条建议本身是对的
 * （扩展刚重载完确实会有一次瞬时失败），但如果失败发生在**回包**上 —— 命令已经在远端跑完了、
 * 只是结果没送回来 —— 重试就会**真的再执行一遍**：`rm` 再删一次、`systemctl restart` 重启两次、
 * `kill -9 $(pgrep x)` 甚至可能因为 PID 复用杀掉不相干的进程。
 *
 * 解法：让"同一件事"的重试带上同一个 `idempotencyKey`。这个模块负责
 *   - 完成的 → 直接返回上次结果（标记 cached）；
 *   - 仍在执行中的（客户端超时了但第一次还没结束）→ 等同一个 Promise，**不并发再跑一遍**；
 *   - 失败/超时（TTL 过期）→ 允许重跑。
 *
 * 刻意做成不依赖 vscode 的纯模块：好测，也好让桌面版照抄同一套语义。
 */

export interface ExecMemoResult {
  text: string
  /** true = 这次没有真的执行，返回的是上一次的结果 */
  cached: boolean
  /** true = 撞上了"还在执行中"的那一次 */
  joined: boolean
}

type Entry = { kind: 'done'; text: string; at: number } | { kind: 'running'; promise: Promise<string> }

export interface ExecMemo {
  run(key: string | undefined, fn: () => Promise<string>): Promise<ExecMemoResult>
  /** 当前记了多少条（测试/诊断用） */
  size(): number
}

export function createExecMemo(opts: { ttlMs?: number; now?: () => number } = {}): ExecMemo {
  const ttl = opts.ttlMs ?? 10 * 60 * 1000
  const now = opts.now ?? ((): number => Date.now())
  const mem = new Map<string, Entry>()

  const prune = (): void => {
    const t = now()
    for (const [k, v] of mem) {
      if (v.kind === 'done' && t - v.at > ttl) mem.delete(k)
    }
  }

  return {
    async run(key, fn) {
      const k = (key ?? '').trim()
      // 没带 key 就退化成普通执行：服务端**无法**保证不重复执行（工具说明里写明了）
      if (!k) return { text: await fn(), cached: false, joined: false }

      prune()
      const hit = mem.get(k)
      if (hit) {
        if (hit.kind === 'done') return { text: hit.text, cached: true, joined: false }
        // 还在执行中：等它，而不是再发一遍
        return { text: await hit.promise, cached: true, joined: true }
      }

      const promise = fn()
      mem.set(k, { kind: 'running', promise })
      try {
        const text = await promise
        mem.set(k, { kind: 'done', text, at: now() })
        return { text, cached: false, joined: false }
      } catch (e) {
        // 失败不缓存：否则"第一次真的失败了"会变成"以后永远返回失败"，反而挡住重试
        mem.delete(k)
        throw e
      }
    },
    size: () => mem.size
  }
}

/** 追加给模型看的一句说明（cached 时必须有，否则它不知道自己拿到的是旧结果） */
export function cachedNote(key: string, joined: boolean): string {
  return joined
    ? `\n\n（注：同一件事的上一次调用还没结束，这里等的是**同一个**执行结果 —— 没有重复执行。key=${key}）`
    : `\n\n（注：这是同一件事上一次调用的结果，**没有重复执行**。key=${key}；10 分钟内带同一个 key 都会返回这份结果。）`
}
