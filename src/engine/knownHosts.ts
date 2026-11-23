/**
 * 主机指纹校验（known_hosts）。
 *
 * 背景：v1 只把指纹打进日志、**接受任何 host key** —— 这在不可信网络里等于没有中间人防护。
 * 这里补上 OpenSSH 的 known_hosts 语义（TOFU：第一次记录，之后必须一致；不一致就拒绝）。
 *
 * 支持两种写法（Windows 自带 OpenSSH 默认是第一种）：
 *   host.example.com ssh-ed25519 AAAAC3Nza...
 *   |1|base64salt|base64hash ssh-ed25519 AAAAC3Nza...      （HashKnownHosts yes）
 * 带端口的写法：`[host]:2222 keytype base64`
 *
 * 不做的事：证书（@cert-authority）、通配符（*.example.com）。
 * 遇到不认识的条目**跳过**并列出来，而不是静默当作"没记录" —— 静默会让校验形同虚设。
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface KnownHostEntry {
  /** 一行的原文（写回时用） */
  line: string
  /** 主机模式：plain host / [host]:port / |1|salt|hash */
  hostPattern: string
  keyType: string
  /** base64 的整段公钥 blob（known_hosts 第二列） */
  keyBase64: string
}

export function defaultKnownHostsFile(): string {
  return path.join(os.homedir(), '.ssh', 'known_hosts')
}

/** 解析 known_hosts（忽略注释、空行、@cert-authority、通配符条目会被标成 unsupported） */
export function parseKnownHosts(text: string): { entries: KnownHostEntry[]; skipped: string[] } {
  const entries: KnownHostEntry[] = []
  const skipped: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^[@]/.test(line)) {
      skipped.push(line)
      continue
    }
    const parts = line.split(/\s+/)
    if (parts.length < 3) {
      skipped.push(line)
      continue
    }
    entries.push({ line, hostPattern: parts[0], keyType: parts[1], keyBase64: parts[2] })
  }
  return { entries, skipped }
}

/** 主机在 known_hosts 里的写法：默认端口直接写主机名，非默认端口用 [host]:port */
export function hostPatternFor(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** 判断某个已知模式是否匹配这台主机（支持 |1| 哈希） */
function patternMatches(pattern: string, host: string, port: number): boolean {
  const want = hostPatternFor(host.toLowerCase(), port)
  if (pattern.startsWith('|1|')) {
    const [, , saltB64, hashB64] = pattern.split('|')
    if (!saltB64 || !hashB64) return false
    const salt = Buffer.from(saltB64, 'base64')
    const mac = crypto.createHmac('sha1', salt).update(want).digest()
    return timingSafeEqual(mac, Buffer.from(hashB64, 'base64'))
  }
  // 逗号分隔的多主机
  return pattern
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .some((p) => p === want || p === host.toLowerCase())
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export type VerifyStatus = 'match' | 'mismatch' | 'unknown' | 'unsupported'

export interface VerifyResult {
  status: VerifyStatus
  /** 这台主机在文件里出现过的 key types（诊断用） */
  seenTypes?: string[]
  /** 我们算出来的指纹（sha256 base64，OpenSSH 风格） */
  fingerprint: string
  /** 文件里记录的候选 key types（不匹配时告诉人"原来是什么类型"） */
  expectedTypes?: string[]
}

/** SHA256 指纹（与 `ssh-keygen -lf` 的输出同格式，去掉了前缀） */
export function sha256Fingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/**
 * 校验 host key。
 *
 * @param text known_hosts 内容
 * @param host 目标主机
 * @param port 端口
 * @param key  ssh2 hostVerifier 给的那段公钥 blob（正好是 known_hosts 的 base64 解码值）
 */
export function verifyHostKey(text: string, host: string, port: number, key: Buffer): VerifyResult {
  const { entries } = parseKnownHosts(text)
  const mine = key.toString('base64')
  const related = entries.filter((e) => patternMatches(e.hostPattern, host, port))
  const fingerprint = sha256Fingerprint(key)
  if (related.length === 0) return { status: 'unknown', fingerprint }
  const same = related.find((e) => e.keyBase64 === mine)
  if (same) return { status: 'match', fingerprint, seenTypes: related.map((e) => e.keyType) }
  return {
    status: 'mismatch',
    fingerprint,
    expectedTypes: [...new Set(related.map((e) => e.keyType))]
  }
}

/** 追加一条记录（TOFU 写入；失败只报告，不影响连接本身） */
export function appendKnownHost(file: string, host: string, port: number, keyType: string, key: Buffer): { ok: boolean; error?: string } {
  const line = `${hostPatternFor(host, port)} ${keyType} ${key.toString('base64')}\n`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const exists = fs.existsSync(file)
    fs.appendFileSync(file, line, 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export type HostKeyPolicy = 'known_hosts' | 'strict' | 'off'

/** 人类可读的策略说明（报错时带上） */
export function policyHint(policy: HostKeyPolicy, file: string): string {
  if (policy === 'off') return '当前 --host-key=off：不校验（危险，只在完全可信的网络里用）'
  return `当前 --host-key=${policy}，文件：${file}`
}
