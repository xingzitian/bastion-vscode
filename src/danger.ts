/**
 * 高危命令识别。
 *
 * 两条设计原则：
 *
 * 1. **不要把这条黑名单当安全边界。** 它挡不住有心人（`rm -rf $HOME` 换个写法就绕过了），
 *    它挡的是手滑和 AI 幻觉。真正的边界是「人看一眼再点确认」。
 *
 * 2. **宁缺毋滥。** 误报会让人很快学会无脑点「仍然执行」，那这条防线就废了。
 *    所以规则要锚定到「几乎不可能是本意」的写法上 ——
 *    例如 `rm -rf /tmp/x` 不该报（正常的清理），`rm -rf /` 才报。
 *
 * 旧版实现在第一条上没问题，但第二条翻过车：
 * 它的 rm 规则是 `/rm\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|\.{1,2}\s*\/)/`，
 * `rm -rf /tmp/x` 也会命中 —— 这种误报多了，确认框就没人看了。
 */

export interface DangerRule {
  id: string
  re: RegExp
  /** 给用户看的一句话原因 */
  why: string
}

export interface DangerHit {
  id: string
  why: string
  /** 实际命中的那段文本，让用户能自己判断 */
  matched: string
}

/** 用户自定义/覆盖（来自 dangerRules.jsonc） */
export interface DangerRulesOverride {
  /** false = 不要内置规则，完全用自己写的 */
  useBuiltin?: boolean
  /** 要关掉的内置规则 id（内置误报时用） */
  disabled?: string[]
  /** 追加自定义规则。pattern 是正则源码，编译时带 i（不区分大小写） */
  extra?: Array<{ id?: string; why?: string; pattern: string }>
}

/**
 * 内置规则表。每条都用 (?=\s|$|[/;|&]) 之类的边界收尾，避免命中正常路径。
 * 注意：不要加 /g 标志（带 g 的正则 lastIndex 有状态，重复 test 会漏）。
 *
 * 这里是**默认值**，不是最终值：用户可以在 ~/.bastionshell/dangerRules.jsonc 里
 * 关掉误报的、或加上自己那套（比如公司内部禁忌命令）。见 buildDangerRules。
 */
export const BUILTIN_DANGER_RULES: DangerRule[] = [
  {
    id: 'rm-root',
    // 只报「目标是根/家目录本身」：/ 、/* 、~ 、~/* 、$HOME
    // `rm -rf /tmp/x` 不会命中（`/` 后面跟的是 t，不是边界）
    re: /\brm\s+(?:-[a-zA-Z-]+\s+)*(?:\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\})(?=\s|$|;|\|)/,
    why: '删除根目录或家目录'
  },
  {
    id: 'reboot',
    re: /\b(?:reboot|shutdown|poweroff|halt|init\s+0|telinit\s+0)\b/,
    why: '重启或关机'
  },
  {
    id: 'mkfs',
    re: /\bmkfs(?:\.[a-z0-9]+)?\b|\bwipefs\b/,
    why: '格式化文件系统'
  },
  {
    id: 'dd-dev',
    re: /\bdd\b[^\n|;]*?\bof=\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk)/,
    why: '向块设备直接写数据'
  },
  {
    id: 'redirect-dev',
    re: />{1,2}\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk)/,
    why: '覆写磁盘设备'
  },
  {
    id: 'chmod-root',
    re: /\bchmod\s+(?:-[a-zA-Z-]+\s+)*(?:[0-7]{3,4}|[ugoa]*[+-][rwxXst]+)\s+\/(?=\s|$|;)/,
    why: '修改根目录权限'
  },
  {
    id: 'chown-root',
    re: /\bchown\s+(?:-[a-zA-Z-]+\s+)*\S+\s+\/(?=\s|$|;)/,
    why: '修改根目录属主'
  },
  {
    id: 'fork-bomb',
    re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;?\s*:/,
    why: 'fork 炸弹（瞬间耗尽进程数）'
  },
  {
    id: 'mv-sysdir',
    re: /\bmv\s+(?:-[a-zA-Z-]+\s+)*\/(?:etc|boot|usr|var|lib|lib64|bin|sbin|opt)(?=\s|$|;)/,
    why: '移动系统关键目录'
  },
  {
    id: 'truncate-dev',
    re: /\btruncate\s+[^\n|;]*\/dev\//,
    why: '截断设备文件'
  },
  {
    id: 'shred-dev',
    re: /\bshred\b[^\n|;]*\/dev\//,
    why: '擦除设备数据'
  },
  {
    id: 'kill-all',
    re: /\bkillall5\b/,
    why: '终止所有进程'
  }
]

/**
 * 按用户的覆盖配置算出最终生效的规则表。
 *
 * 「面向世界」的关键：内置规则只覆盖最常见的那批，而且**允许关掉**（误报时），
 * 也允许追加自己的（比如公司内部的禁忌命令、某个业务库的删库语句）。
 * 纯函数，坏正则只跳过它自己，不让整张表失效。
 */
export function buildDangerRules(override?: DangerRulesOverride): DangerRule[] {
  const useBuiltin = override?.useBuiltin !== false
  const disabled = new Set((override?.disabled ?? []).filter((x): x is string => typeof x === 'string'))
  const rules: DangerRule[] = useBuiltin ? BUILTIN_DANGER_RULES.filter((r) => !disabled.has(r.id)) : []
  const extra = Array.isArray(override?.extra) ? override!.extra! : []
  for (let i = 0; i < extra.length; i++) {
    const e = extra[i]
    if (!e || typeof e.pattern !== 'string' || !e.pattern.trim()) continue
    try {
      rules.push({
        id: e.id?.trim() || `custom-${i + 1}`,
        re: new RegExp(e.pattern, 'i'), // 统一不区分大小写，省得每人都记得写 flag
        why: e.why?.trim() || '自定义高危规则'
      })
    } catch {
      // 用户写错正则是常事，跳过这一条即可，别连累其它规则
    }
  }
  return rules
}

/** 找出命令里命中的高危规则（可能多条）。rules 不传就用内置默认 */
export function findDangerous(command: string, rules: DangerRule[] = BUILTIN_DANGER_RULES): DangerHit[] {
  if (!command || !command.trim()) return []
  const hits: DangerHit[] = []
  for (const rule of rules) {
    const m = rule.re.exec(command)
    if (m) {
      hits.push({ id: rule.id, why: rule.why, matched: m[0].trim() })
    }
  }
  return hits
}

/** 命中了任何一条 */
export function isDangerous(command: string, rules: DangerRule[] = BUILTIN_DANGER_RULES): boolean {
  return findDangerous(command, rules).length > 0
}

/** 拼成人能看的原因列表（弹窗 / 回给 AI 用） */
export function describeDanger(hits: DangerHit[]): string {
  if (hits.length === 0) return ''
  const seen = new Set<string>()
  const lines: string[] = []
  for (const h of hits) {
    const key = `${h.id}|${h.matched}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`· ${h.why} —— 命中 \`${h.matched}\``)
  }
  return lines.join('\n')
}

/** 从多段文本（如部署任务的 preCommand + script）里汇总命中项 */
export function findDangerousIn(
  parts: Array<{ label: string; text: string }>,
  rules: DangerRule[] = BUILTIN_DANGER_RULES
): Array<{ label: string; hits: DangerHit[] }> {
  const out: Array<{ label: string; hits: DangerHit[] }> = []
  for (const p of parts) {
    const hits = findDangerous(p.text, rules)
    if (hits.length > 0) out.push({ label: p.label, hits })
  }
  return out
}
