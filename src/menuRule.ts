/**
 * 从「屏幕上那句提示」生成菜单识别规则。
 *
 * 背景：菜单认不出来时，现在的路径是「看日志里的屏幕原文 → 自己写正则 → 填进设置」。
 * 对不会写正则的人这就是死路。这一模块负责把用户**选中的那行原文**变成一条可用的正则，
 * 并猜它属于哪一类提示（主菜单 / 选用户 / 目标机 shell 提示符）。
 *
 * 为什么生成时要做「泛化」而不是照抄原文：菜单里的编号、IP、账号名每次都不一样，
 * 照抄只能匹配那一次。所以把**数字**换成 `\d+`、连续空格换成 `\s+`，
 * 其余字符一律转义 —— 宁可保守（匹配不上就退回固定等待），也不要写得过宽导致误判。
 *
 * 纯函数，不碰 vscode —— 见 test/menuRule.test.ts。
 */

import type { MenuHintKey } from './menu'
import { DEFAULT_MENU_HINTS } from './menu'

/** 正则元字符转义（生成规则用：用户那行原文里的括号、点号都不是正则意图） */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把一行屏幕原文泛化成一条识别正则。
 *
 * - 数字串 → `\d+`（菜单编号、IP、端口都会变）
 * - 连续空白 → `\s+`（对齐用的空格数量会变）
 * - 其余字符转义
 * - 前面加 `^\s*`：这行是从屏幕开头读到的，锚在行首能显著减少误判
 *
 * 不做的事：不加行尾 `$`（有的堡垒机会在同一行后面接着打印提示符，锚死会匹配不上 ——
 * 这个坑在 `Opt> Opt>` 上踩过）。
 */
export function generalizeMenuLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''
  const escaped = escapeRegex(trimmed)
  const generalized = escaped
    .replace(/\d+/g, '\\d+') // 编号 / IP / 端口
    .replace(/[ \t]+/g, '\\s+') // 空白：对齐宽窄会变，单个空格也放宽（屏幕上重排过就匹配不上）
  return `^\\s*${generalized}`
}

/**
 * 猜这行提示属于哪一类。
 *
 * 顺序有讲究：先认 shell 提示符（特征最强），再认选用户，最后才是主菜单 —— 
 * 主菜单是"兜底类别"，拿不准时放这里最安全（它同时也是"IP 被拒绝"的判据，
 * 所以宽松的裸提示符要单独放 hostPromptLoose）。
 */
export function suggestHintKey(line: string): MenuHintKey {
  const s = line.trim()
  if (!s) return 'hostPrompt'

  // 1) 目标机 shell 提示符：user@host:~$ / [root@x tmp]# / bash-4.2$
  if (/^[^\s@]{1,64}@[^\s]{1,64}[:~][^\n]*[$#]$/.test(s)) return 'shellPrompt'
  if (/^\[[^\]]{1,64}\]\s*[$#]$/.test(s)) return 'shellPrompt'
  if (/^[A-Za-z0-9._-]{1,40}[$#]$/.test(s)) return 'shellPrompt'

  // 2) 选用户/账号菜单：提到用户、账号、user、account，或者裸 ID> 提示符
  if (/(用户|账号|账户|登录用户|user|account|username)/i.test(s)) return 'userPrompt'
  if (/^\s*id>\s*$/i.test(s)) return 'userPrompt'

  // 3) 裸提示符（只有个 xxx>，没有别的内容）：弱特征单独一类
  if (s.length <= 20 && /^[\[\]\w.-]{0,16}>\s*$/.test(s)) return 'hostPromptLoose'

  // 4) 其余（菜单正文、公告等）
  return 'hostPrompt'
}

export interface MenuRuleSuggestion {
  /** 猜它属于哪一类 */
  key: MenuHintKey
  /** 原文（展示给用户选） */
  line: string
  /** 生成的规则源码（会写进设置） */
  pattern: string
}

/** 这一类的可读名（菜单里显示用） */
export const HINT_KEY_LABEL: Record<MenuHintKey, string> = {
  hostPrompt: '主菜单（输目标机）· 强特征',
  hostPromptLoose: '主菜单 · 弱特征（只有提示符）',
  userPrompt: '二级菜单（选用户）',
  shellPrompt: '已落到目标机（shell 提示符）'
}

/**
 * 把整段屏幕原文拆成可选的候选行。
 *
 * 过滤掉：空行、纯分隔线（`----`、`====`）、纯数字编号行（没有信息量）、
 * 以及已经在别处出现过太多次的重复行。
 */
export function buildMenuRuleSuggestions(screen: string, limit = 40): MenuRuleSuggestion[] {  const seen = new Set<string>()
  const out: MenuRuleSuggestion[] = []
  for (const raw of screen.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^[-=_*#~+]{3,}$/.test(line)) continue // 分隔线
    if (/^\d+$/.test(line)) continue // 光秃秃的编号
    if (line.length > 200) continue // 太长的多半是整段帮助文本
    if (seen.has(line)) continue
    seen.add(line)
    const pattern = generalizeMenuLine(line)
    if (!pattern) continue
    out.push({ key: suggestHintKey(line), line, pattern })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 把一条规则追加到「这一类的设置项」里，返回应该写进设置的新数组。
 *
 * ⚠️ 关键陷阱：本项目的设置语义是**填了就整组替换内置默认**（见 menu.ts 的 resolveMenuHints）。
 * 所以「加一条」不能只写新加的那条 —— 那会把内置规则全丢掉，
 * 结果用户加完一条反而比原来认得还少。设置里为空时，要先把内置默认抄进来。
 *
 * @returns 要写入的设置数组；返回 null 表示「不用改」（已经在里面了 / 规则为空）
 */
export function appendMenuRule(
  existing: string[] | undefined,
  key: MenuHintKey,
  pattern: string
): string[] | null {
  const rule = pattern.trim()
  if (!rule) return null
  const base = Array.isArray(existing) && existing.length > 0 ? existing : DEFAULT_MENU_HINTS[key]
  if (base.includes(rule)) return null
  return [...base, rule]
}
