/**
 * 命令摘要：把 AI 爱写的那种"一长串 && 串起来"的命令，压成一行能看懂的步骤列表。
 *
 * 存在的理由：AI 习惯一次写
 *   `cd /data/app && git pull && npm ci && systemctl restart app`
 * 人类看不出这一串在干什么，面板上也放不下。但**不能只看第一段**（那会丢掉真正的动作），
 * 也不能把原文整段塞进卡片（太长）。所以拆段取"动词 + 目标"，原文留给展开。
 *
 * 两条硬约束：
 *  1. **纯函数**（不 import vscode、不读配置）——面板/账本/日志/测试都调它，语义只能有一处
 *  2. **脱敏先于落盘**：`--password=xxx` 这类必须变成 `***`，审计面板泄露密码是最糟的失败模式
 */

export interface DangerHit {
  /** 命中规则的人话原因（例如"删根"） */
  why: string
  /** 命中的原文片段 */
  text: string
}

export interface CommandSummary {
  /** 拆出来的步骤数（`&&` / `||` / `;` / `|` / 换行 各算一段） */
  steps: number
  /** 一行摘要，例如 `4 步：cd · git pull · npm ci · systemctl restart` */
  brief: string
  /** 脱敏后的原文（面板"展开"才显示） */
  raw: string
  /** 原文是否被脱敏过 */
  redacted: boolean
  /** 命中高危规则的片段（由调用方注入匹配器，纯函数不自己读配置） */
  danger: DangerHit[]
  /** 步骤太多时 brief 会被截断 */
  truncated: boolean
}

/** 每段最多保留几个词（动词 + 目标，够看懂就行） */
const MAX_WORDS_PER_STEP = 3
/** brief 最多多少字符（面板一行） */
const MAX_BRIEF = 120
/** 最多列几步（再多的折叠成 `+N`） */
const MAX_STEPS_SHOWN = 6

/** 这些命令只看第一个词看不出在干嘛，要多带一个子命令 */
const NEEDS_SUBCOMMAND = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'docker',
  'docker-compose',
  'kubectl',
  'systemctl',
  'service',
  'brew',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pip',
  'pip3',
  'python',
  'python3',
  'node',
  'go',
  'cargo',
  'java',
  'tar',
  'unzip',
  'chmod',
  'chown',
  'psql',
  'mysql',
  'redis-cli',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync'
])

/** 前缀词：跳过它们取真正的命令 */
const PREFIX_WORDS = new Set(['sudo', 'nohup', 'time', 'env', 'command', 'nice', 'stdbuf', 'exec'])

/**
 * 按 shell 分隔符拆段，**尊重引号**（`echo "a && b"` 是一段而不是三段）。
 * 只处理最常见的 `'...'` 与 `"..."`；反引号/`$()` 里的内容不深究（够用即可）。
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      cur += ch
      if (ch === quote && cmd[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    // && || ; 换行 |（单竖线）
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    if (ch === ';' || ch === '\n' || (ch === '|' && cmd[i + 1] !== '|')) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 去掉引号（摘要里不用带引号，反而更难读） */
function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '')
}

/**
 * 一步命令 → 摘要里要显示的词。
 *
 * 规则（都是被真实命令*教*出来的）：
 *  - 跳过 `FOO=bar` 赋值、跳过 `sudo/nohup/env` 这类前缀
 *  - 头一个词之外，**只有** `git/docker/systemctl/tar…` 这类"看第一个词猜不出在干嘛"的命令才带第二个词
 *  - 第二个词不能是 `-p` 这种旗标；旗标后面跟的纯数字（端口）也跳过 —— 否则 `ssh -p 2222 host` 会显示成 `ssh 2222`
 *  - 带引号的词跳过（通常是参数值，不是动作）
 */
function stepWords(step: string): string[] {
  // 不要先对整段 unquote：末尾的引号会被吃掉，`-e "select 1"` 会漏出一个孤零零的 `1`
  const tokens = step
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
  let i = 0
  while (i < tokens.length && PREFIX_WORDS.has(tokens[i])) i++
  if (i >= tokens.length) return []
  const head = tokens[i]
  const picked = [head]
  if (NEEDS_SUBCOMMAND.has(head)) {
    for (let k = i + 1; k < tokens.length; k++) {
      const tok = tokens[k]
      if (tok.includes('"') || tok.includes("'")) continue // 引号里多半是参数值
      if (tok.startsWith('-')) continue // 旗标
      if (/^\d+$/.test(tok) && tokens[k - 1]?.startsWith('-')) continue // 旗标的值（端口等）
      picked.push(tok)
      break
    }
  }
  return picked.map((w) => unquote(w)).map((w) => (w.length > 24 ? w.slice(0, 23) + '…' : w))
}
export function redactSecrets(cmd: string): { text: string; redacted: boolean } {
  let redacted = false
  const out = (cmd ?? '')
    .replace(
      /(--?(?:password|passwd|pass|token|secret|api-?key|access-?key|private-?key|auth|credential))(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      (_m, flag: string, sep: string) => {
        redacted = true
        return `${flag}${sep}***`
      }
    )
    .replace(/(^|\s)-p([^\s-]\S*)/g, (m, lead: string, value: string) => {
      if (/^\d+$/.test(value)) return m // -p22 = 端口
      redacted = true
      return `${lead}-p***`
    })
    .replace(/(^|\s)-u\s*([^\s:]+):(\S+)/g, (_m, lead: string, user: string) => {
      redacted = true
      return `${lead}-u ${user}:***`
    })
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:PWD|PASS|TOKEN|SECRET|KEY)[A-Za-z0-9_]*)=(\S+)/gi, (_m, name: string) => {
      redacted = true
      return `${name}=***`
    })
  return { text: out, redacted }
}

/**
 * 生成命令摘要。
 *
 * @param command 原始命令
 * @param matchDanger 可选：高危匹配器（由调用方注入，例如 danger 模块 + 用户规则）
 */
export function summarizeCommand(
  command: string,
  matchDanger?: (cmd: string) => DangerHit[]
): CommandSummary {
  const raw0 = command ?? ''
  const { text: raw, redacted } = redactSecrets(raw0)
  const steps = splitCommand(raw)
  const words = steps.map(stepWords).filter((w) => w.length > 0)
  const shown = words.slice(0, MAX_STEPS_SHOWN).map((w) => w.join(' '))
  const more = words.length > MAX_STEPS_SHOWN ? ` +${words.length - MAX_STEPS_SHOWN}` : ''
  let brief = words.length <= 1 ? (shown[0] ?? '') : `${words.length} 步：${shown.join(' · ')}${more}`
  let truncated = false
  if (brief.length > MAX_BRIEF) {
    brief = brief.slice(0, MAX_BRIEF - 1) + '…'
    truncated = true
  }
  if (words.length > MAX_STEPS_SHOWN) truncated = true
  return {
    steps: words.length,
    brief,
    raw,
    redacted,
    danger: matchDanger ? matchDanger(raw) : [],
    truncated
  }
}

/** AI 写的"这句命令为了什么"：裁到一行，去掉换行（防止污染面板/上下文） */
export function normalizeWhy(why: string | undefined, max = 60): string {
  const s = (why ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
