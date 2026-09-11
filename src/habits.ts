import * as fs from 'fs'
import { parse as parseJsonc, modify, applyEdits, ParseError, FormattingOptions } from 'jsonc-parser'
import { configFilePath, ensureJsonFile, readJsonFile, writeTextAtomic } from './config'
import { log } from './log'

/**
 * 个人习惯（habits.jsonc）
 *
 * 解决的问题：以前 AI 要提权就只能按写死的剧本走「先问要不要 sudo -i」，
 * 于是每台机器、每次会话都重复问同一件事，而且 sudo -i 会进交互式 shell、
 * 让「命令执行完」的哨兵判定失效。
 *
 * 现在把「你在这台机器上实际怎么干活」记成文件：提权方式、常用目录、口头习惯。
 * AI 连接后先读它，按记录执行；没记录时才问一次，问完立刻记下来，下次不再问。
 *
 * 写入走 jsonc-parser 的 modify/applyEdits，只改目标节点，手写的中文注释不会被覆盖。
 */

/** 提权方式 */
export type PrivilegeMode = 'none' | 'sudo' | 'sudo-i' | 'ask'

export interface ProfileHabit {
  /** 覆盖全局的提权方式 */
  privilege?: PrivilegeMode
  /** 覆盖全局的常用工作目录 */
  workdir?: string
  /** 这个档案专属的习惯条目 */
  notes?: string[]
}

export interface Habits {
  privilege?: PrivilegeMode
  workdir?: string
  notes?: string[]
  /** 键 = profiles.jsonc 里的档案名 */
  profiles?: Record<string, ProfileHabit>
}

export const HABITS_FILE = 'habits.jsonc'

/** 新建文件时写入的模板 */
export const HABITS_TEMPLATE: Habits = {
  privilege: 'ask',
  workdir: '',
  notes: [],
  profiles: {}
}

export const HABITS_HEADER = [
  '// ============================================================',
  '// BastionShell 个人习惯',
  '// ------------------------------------------------------------',
  '// 这里记录「你自己怎么干活」，好让 AI 不用每次都问同样的问题。',
  '// 文件可以直接手改（保存即生效）；AI 在你确认后也会往里追加，',
  '// 追加只改目标字段，本文件里手写的中文注释不会被冲掉。',
  '// ------------------------------------------------------------',
  '// 字段说明：',
  '//   privilege  提权方式，四选一：',
  '//                "none"    这台机器不用提权，直接跑普通命令',
  '//                "sudo"    账号 sudo 免密，直接写 sudo <命令> 即可（不用 sudo -i）',
  '//                "sudo-i"  必须先 sudo -i 进交互式 root（要人工输密码）',
  '//                "ask"     每次都先问你（默认）',
  '//   workdir    常用工作目录（绝对路径，AI 会先 cd 过去）',
  '//   notes      习惯条目，一句话一条，AI 会读它来迁就你的用法',
  '//',
  '//   profiles   上面三项按「档案名」分别覆盖全局设置；',
  '//               键 = profiles.jsonc 里的 name（例如 "生产"）',
  '// ------------------------------------------------------------',
  '// 例子：sudo 免密的机器，就在 profiles 里记成 "privilege": "sudo"，',
  '//       以后 AI 直接跑 sudo <命令>，不再问你要不要 sudo -i。',
  '// ============================================================'
].join('\n')

const PRIVILEGE_MODES: PrivilegeMode[] = ['none', 'sudo', 'sudo-i', 'ask']

export function isPrivilegeMode(v: unknown): v is PrivilegeMode {
  return typeof v === 'string' && (PRIVILEGE_MODES as string[]).includes(v)
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
}

/** 只要求「是个对象」——手写文件里字段写错不该整份被当成损坏丢进 .bak */
function isHabitsObject(v: unknown): v is Habits {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 把读到的东西收敛成干净的 Habits：坏字段直接忽略，好字段照用 */
function normalize(raw: Habits): Habits {
  const out: Habits = { notes: [], profiles: {} }
  if (isPrivilegeMode(raw.privilege)) out.privilege = raw.privilege
  if (typeof raw.workdir === 'string' && raw.workdir.trim()) out.workdir = raw.workdir.trim()
  out.notes = toStrArray(raw.notes)
  const ps = raw.profiles
  if (ps && typeof ps === 'object' && !Array.isArray(ps)) {
    for (const [name, value] of Object.entries(ps)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const src = value as ProfileHabit
      const p: ProfileHabit = {}
      if (isPrivilegeMode(src.privilege)) p.privilege = src.privilege
      if (typeof src.workdir === 'string' && src.workdir.trim()) p.workdir = src.workdir.trim()
      const notes = toStrArray(src.notes)
      if (notes.length) p.notes = notes
      out.profiles![name] = p
    }
  }
  return out
}

/** 读个人习惯（文件不存在会自动按模板建一份，方便直接编辑） */
export function getHabits(): Habits {
  try {
    ensureJsonFile(HABITS_FILE, HABITS_HEADER, HABITS_TEMPLATE)
    return normalize(readJsonFile<Habits>(HABITS_FILE, HABITS_TEMPLATE, isHabitsObject))
  } catch (e) {
    log(`读取个人习惯失败: ${(e as Error).message}`)
    return { notes: [], profiles: {} }
  }
}

const FMT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' }

/**
 * 就地改 habits.jsonc 的文本（保留注释）；改完先解析校验，坏了就放弃本次写入。
 *
 * 写入走 `writeTextAtomic`（带 rename 重试）—— 以前这里自己写 tmp+rename，
 * 没走那个重试：Windows 上目标文件被瞬时占用时 rename 抛 EPERM，写入静默失败，
 * 表现为「记了习惯却没生效」以及测试偶发变红（2026-09-10 修）。
 */
function editHabitsFile(apply: (text: string) => string): boolean {
  ensureJsonFile(HABITS_FILE, HABITS_HEADER, HABITS_TEMPLATE)
  const fp = configFilePath(HABITS_FILE)
  try {
    const text = fs.readFileSync(fp, 'utf8')
    const next = apply(text)
    if (next === text) return false
    const errors: ParseError[] = []
    parseJsonc(next, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      log('习惯文件改完后解析不过，已放弃本次写入（原文件未动）')
      return false
    }
    writeTextAtomic(fp, next)
    return true
  } catch (e) {
    log(`写入习惯文件失败: ${(e as Error).message}`)
    return false
  }
}

function setPath(text: string, jsonPath: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, jsonPath, value, { formattingOptions: FMT }))
}

/** 档案名归一：空串/纯空格视为「全局」 */
function normProfile(profileName?: string): string | undefined {
  const n = profileName?.trim()
  return n ? n : undefined
}

/** 解析某个档案最终生效的提权方式（档案 > 全局 > ask） */
export function resolvePrivilege(h: Habits, profileName?: string): PrivilegeMode {
  const key = normProfile(profileName)
  const p = key ? h.profiles?.[key] : undefined
  return p?.privilege ?? h.privilege ?? 'ask'
}

/** 解析某个档案最终生效的工作目录 */
export function resolveWorkdir(h: Habits, profileName?: string): string {
  const key = normProfile(profileName)
  const p = key ? h.profiles?.[key] : undefined
  return p?.workdir ?? h.workdir ?? ''
}

/** 提权方式对应的可执行说明（给 AI 看的，不要写给用户看） */
export function privilegeText(mode: PrivilegeMode): string {
  switch (mode) {
    case 'none':
      return 'none（这台机器不需要提权，直接跑普通命令，不要加 sudo）'
    case 'sudo':
      return 'sudo（账号 sudo 免密，直接写 `sudo <命令>`，不要用 sudo -i）'
    case 'sudo-i':
      return 'sudo-i（必须先 `sudo -i` 进交互式 root，且需要人工输密码）'
    default:
      return 'ask（还没记录，特权命令前先问用户一次，问完立刻记下来）'
  }
}

/** 拼成一段紧凑文本，给 AI 读 */
export function habitsForAI(profileName?: string): string {
  const h = getHabits()
  const key = normProfile(profileName)
  const mode = resolvePrivilege(h, key)
  const lines: string[] = [`提权习惯：${privilegeText(mode)}`]
  const wd = resolveWorkdir(h, key)
  if (wd) lines.push(`常用工作目录：${wd}`)
  const notes = [...(h.notes ?? []), ...(key ? h.profiles?.[key]?.notes ?? [] : [])]
  if (notes.length) {
    lines.push('个人习惯：\n' + notes.map((n) => `  - ${n}`).join('\n'))
  }
  if (mode === 'ask' && notes.length === 0) {
    lines.push('（这个档案还没有任何记录。按用户实际做法执行过一次后，用 bastion_habits 记下来，下次就不用再问了。）')
  }
  return lines.join('\n')
}

/** 追加一条习惯（自动去重）。profileName 省略 = 写全局。返回是否真的写入了 */
export function appendHabit(profileName: string | undefined, text: string): boolean {
  const note = text.trim()
  if (!note) return false
  const key = normProfile(profileName)
  const h = getHabits()
  const existing = key ? h.profiles?.[key]?.notes ?? [] : h.notes ?? []
  if (existing.includes(note)) {
    log(`习惯已存在，跳过：${note}`)
    return false
  }
  const jsonPath: (string | number)[] = key
    ? ['profiles', key, 'notes', existing.length]
    : ['notes', existing.length]
  const ok = editHabitsFile((t) => setPath(t, jsonPath, note))
  if (ok) log(`已记录习惯${key ? `（${key}）` : '（全局）'}：${note}`)
  return ok
}

/** 设置提权方式（profileName 省略 = 写全局） */
export function setPrivilege(profileName: string | undefined, mode: PrivilegeMode): boolean {
  const key = normProfile(profileName)
  const jsonPath: (string | number)[] = key ? ['profiles', key, 'privilege'] : ['privilege']
  const ok = editHabitsFile((t) => setPath(t, jsonPath, mode))
  if (ok) log(`已设置提权习惯${key ? `（${key}）` : '（全局）'}：${mode}`)
  return ok
}

/** 设置常用工作目录（profileName 省略 = 写全局） */
export function setWorkdir(profileName: string | undefined, dir: string): boolean {
  const key = normProfile(profileName)
  const jsonPath: (string | number)[] = key ? ['profiles', key, 'workdir'] : ['workdir']
  const ok = editHabitsFile((t) => setPath(t, jsonPath, dir.trim()))
  if (ok) log(`已设置工作目录${key ? `（${key}）` : '（全局）'}：${dir}`)
  return ok
}
