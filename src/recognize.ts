/**
 * 「这段文字是不是在问我要密码」的识别。
 *
 * 为什么单列一个模块：这是**纯厂商相关**的判断，各国各家的文案都不一样 ——
 * password / passphrase / 密码 / 密碼 / 口令 / パスワード / 암호…
 * 写死三种的后果很具体：在别人的堡垒机上会把「密码提示」当成 MFA 验证码来弹输入框
 * （于是拿动态码当密码去认证），或者反过来把 MFA 提示当成密码直接填进去。
 *
 * 所以：默认给一份常见文案，同时允许用设置整套覆盖。纯函数 + 由调用方传入规则，
 * 这样它不依赖 VS Code、能被单测直接覆盖（和 menu.ts 的做法一致）。
 */

/** 常见密码提示关键词。匹配方式是「最后一行的子串包含」，不区分大小写 */
export const DEFAULT_PASSWORD_PROMPTS = [
  'password',
  'passphrase',
  'passwd',
  '密码',
  '密碼',
  '口令',
  'パスワード',
  '암호'
]

/**
 * 从设置里解析生效的密码提示关键词。
 * 设置留空 / 非法 → 用默认；填了 → 整套替换（和 bastion.menuHints.* 的语义一致）。
 */
export function resolvePasswordPrompts(get: (key: string) => unknown): string[] {
  const v = get('passwordPromptPatterns')
  if (Array.isArray(v) && v.length > 0) {
    const ok = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    if (ok.length > 0) return ok
  }
  return DEFAULT_PASSWORD_PROMPTS
}

/** 这段文字里有没有出现密码提示关键词 */
export function isPasswordPrompt(text: string, patterns: string[] = DEFAULT_PASSWORD_PROMPTS): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  return patterns.some((p) => p && t.includes(p.toLowerCase()))
}

/**
 * 从一段输出里判断「是不是停在等密码」。
 *
 * 只看**最后一个非空行** —— 提示符就在那。整段扫会误判：
 * 命令输出里出现 `password` 一词（比如 `grep password /etc/x` 的结果）不该算在等密码。
 */
export function isWaitingForPassword(output: string, patterns: string[] = DEFAULT_PASSWORD_PROMPTS): boolean {
  const lines = (output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return false
  return isPasswordPrompt(lines[lines.length - 1], patterns)
}
