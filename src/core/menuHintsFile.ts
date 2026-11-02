import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parse as parseJsonc, ParseError } from 'jsonc-parser'
// 只 import 类型（编译后会被抹掉）→ 和 menu.ts 之间**没有运行时循环依赖**
import type { MenuHintKey, MenuHints } from './menu'

/**
 * 共享的菜单识别规则（`~/.bastionshell/menuHints.jsonc`）。
 *
 * 为什么要有这个文件：菜单提示是**可配置的正则/数据**，而这些规则是实测出来的 ——
 * 内置的那批两边（VS Code 扩展 / 桌面版）各存一份**代码常量**，改了一边不会同步到另一边，
 * 早晚会出现「A 版认得出来、B 版认不出来」。所以把「新增/关掉规则」这件事
 * 收进一个**两个实现读同一份**的文件，内置默认继续留在代码里。
 *
 * 语义（和 dangerRules.jsonc 一致，刻意统一）：
 *   - `useBuiltin: false` → 完全不用内置规则，只用 `extra`
 *   - `disabled` → 按「组名 + 规则原文」精确关掉某条内置规则（误报时用）
 *   - `extra`    → 追加自己的规则
 *
 * **不做「填了就整组替换内置」**：那样以后内置规则改进了这边也用不上。
 * （VS Code 设置里的 `bastion.menuHints.*` 仍然是「整组替换」语义，优先级更高：
 *  设置 > 共享文件 > 内置默认。）
 */

export const MENU_HINTS_FILE = 'menuHints.jsonc'

export interface MenuHintRuleEntry {
  key?: string
  pattern?: string
}

export interface MenuHintsOverride {
  useBuiltin?: boolean
  disabled?: MenuHintRuleEntry[]
  extra?: MenuHintRuleEntry[]
}

const HINT_KEYS: MenuHintKey[] = ['hostPrompt', 'hostPromptLoose', 'userPrompt', 'assetPrompt', 'shellPrompt']

function isOverride(v: unknown): v is MenuHintsOverride {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 共享规则目录：`~/.bastionshell/`（与 config.ts 同一个约定、同一个环境变量覆盖）。
 *
 * ⚠️ 这里**故意不走 config.ts**：那个模块会 import log.ts，而 log.ts import 了 vscode ——
 * menu.ts 这套识别逻辑的价值之一就是「纯函数、不碰 vscode、能直接在 node 里测」，
 * 拉进 vscode 依赖会把这条性质毁掉（测试得先塞 stub 才能加载）。
 * 所以这里只用 fs/path/os/jsonc-parser，出错时再**惰性**去 require log。
 */
function sharedDir(): string {
  const override = (process.env.BASTIONSHELL_SHARED_DIR ?? '').trim()
  if (override) return override
  return path.join(os.homedir(), '.bastionshell')
}

/** 惰性日志：正常路径不加载 log.ts（它依赖 vscode），出错时才试着写一条 */
function logQuiet(msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { log } = require('./log') as { log: (m: string) => void }
    log(msg)
  } catch {
    /* 没有 log 通道（例如单元测试里）就算了，不要因为日志把识别搞坏 */
  }
}

/**
 * 读共享文件，**按 mtime 缓存**：用户在编辑器里改了规则保存即生效，
 * 但屏幕识别的热路径上不做每次读盘。
 */
let cache: { key: string; value: MenuHintsOverride } | null = null

export function menuHintsFilePath(): string {
  return path.join(sharedDir(), MENU_HINTS_FILE)
}

export function readMenuHintsOverride(): MenuHintsOverride {
  const fp = menuHintsFilePath()
  let stamp = 'missing'
  try {
    const st = fs.statSync(fp)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    /* 文件不存在：只用内置默认 */
  }
  if (cache && cache.key === stamp) return cache.value

  let value: MenuHintsOverride = {}
  if (stamp !== 'missing') {
    try {
      const errors: ParseError[] = []
      const parsed: unknown = parseJsonc(fs.readFileSync(fp, 'utf8'), errors, { allowTrailingComma: true })
      if (errors.length > 0) {
        // 坏文件备份成 .bak 并写日志，**绝不静默吞掉**（和 config.ts 一个规矩）
        try {
          fs.copyFileSync(fp, fp + '.bak')
        } catch {
          /* 备份失败也不影响回退 */
        }
        logQuiet(`menuHints.jsonc 解析失败，已备份为 .bak 并改用内置默认`)
      } else if (!isOverride(parsed)) {
        logQuiet('menuHints.jsonc 结构不对（应该是个对象），已改用内置默认')
      } else {
        value = parsed
      }
    } catch (e) {
      logQuiet(`读 menuHints.jsonc 失败：${(e as Error).message}`)
    }
  }
  cache = { key: stamp, value }
  return value
}

/** 测试用：清缓存（同一个 mtime 内改文件不会被发现） */
export function resetMenuHintsCache(): void {
  cache = null
}

/**
 * 算出最终生效的规则：设置（整组替换）> 共享文件 > 内置默认。
 * `disabled` 只作用于内置默认那一层（设置里既然整组替换了，关内置就没有意义）。
 */
export function mergeMenuHints(
  fromSettings: Partial<Record<MenuHintKey, string[]>>,
  o: MenuHintsOverride,
  defaults: MenuHints
): MenuHints {
  const disabled = (o.disabled ?? []).filter((d): d is MenuHintRuleEntry => !!d && typeof d === 'object')
  const out = {} as MenuHints
  for (const key of HINT_KEYS) {
    const own = fromSettings[key]
    let list: string[]
    if (own && own.length > 0) {
      list = [...own]
    } else if (o.useBuiltin === false) {
      list = []
    } else {
      list = defaults[key].filter(
        (p) => !disabled.some((d) => (d.key ?? '').trim() === key && (d.pattern ?? '').trim() === p)
      )
    }
    for (const e of o.extra ?? []) {
      if (!e || typeof e !== 'object') continue
      if ((e.key ?? '').trim() !== key) continue
      const pattern = (e.pattern ?? '').trim()
      if (!pattern) continue
      try {
        new RegExp(pattern, 'im') // 坏正则跳过，别连累其它规则
      } catch {
        logQuiet(`menuHints.jsonc 里的正则写错了，已跳过：${pattern}`)
        continue
      }
      list.push(pattern)
    }
    out[key] = list
  }
  return out
}
