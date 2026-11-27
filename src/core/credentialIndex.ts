/**
 * 凭据清单（**只有元数据**）：`~/.bastionshell/credentials.json`
 *
 * 为什么需要它：密码本身在两个地方各自加密保存 ——
 * 扩展在 VS Code SecretStorage（键 `bastion.pass.<档案名>`，**不能枚举**），
 * 桌面在 DPAPI 的 `secrets.json`（能枚举）。两边互不知道对方存了什么，
 * 于是「我到底存了哪些密码」「哪个是垃圾」「改名之后那份还在不在」全靠猜。
 *
 * 这个文件只记「谁在哪个键上存过什么、什么时候存的」，**绝不写明文/密文**：
 *   { "version": 1,
 *     "entries": [ { "key": "中转长期机器", "kind": "password",
 *                    "owner": "vscode", "updatedAt": "2026-11-27T03:20:00.000Z" } ] }
 *
 * 它能干的三件事：
 *   1. 界面把两个产品的凭据**并成一张表**给人看（属主不同，删除也只在属主那边做）；
 *   2. 认出**孤儿**：键已经不对应任何档案了（改名/删除留下的），可以一键清；
 *   3. 回答「这个档案到底存没存过密码」——不用去试探钥匙串。
 *
 * 注意：这个文件是两边共写的小文件，写坏了只影响"看得见"，不影响能不能连 ——
 * 所以读失败一律按空表处理，绝不抛。
 */

import * as fs from 'fs'
import * as path from 'path'
import { configDir } from './config'

export type CredentialKind = 'password' | 'passphrase'
export type CredentialOwner = 'vscode' | 'desktop'

export interface CredentialEntry {
  /** 存储键（目前就是档案名，与 SecretStorage / DPAPI 的键一致） */
  key: string
  kind: CredentialKind
  owner: CredentialOwner
  /** ISO 时间：最后一次写入 */
  updatedAt: string
}

export const CREDENTIAL_INDEX_FILE = 'credentials.json'

export function credentialIndexPath(): string {
  return path.join(configDir(), CREDENTIAL_INDEX_FILE)
}

function isEntry(v: unknown): v is CredentialEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.key === 'string' &&
    o.key.trim() !== '' &&
    (o.kind === 'password' || o.kind === 'passphrase') &&
    (o.owner === 'vscode' || o.owner === 'desktop') &&
    typeof o.updatedAt === 'string'
  )
}

/** 读清单；文件不存在/坏掉/字段不对 → 空表（只影响显示，不抛） */
export function readIndex(): CredentialEntry[] {
  let text: string
  try {
    text = fs.readFileSync(credentialIndexPath(), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const entries = (parsed as { entries?: unknown })?.entries
  if (!Array.isArray(entries)) return []
  return entries.filter(isEntry).map((e) => ({ ...e, key: e.key.trim() }))
}

/** 同 (key, kind, owner) 只留最新一条；其它保持原顺序 */
function dedupe(entries: CredentialEntry[]): CredentialEntry[] {
  const best = new Map<string, CredentialEntry>()
  const order: string[] = []
  for (const e of entries) {
    const id = `${e.owner}\u0000${e.kind}\u0000${e.key}`
    const prev = best.get(id)
    if (!prev) {
      best.set(id, e)
      order.push(id)
      continue
    }
    if (e.updatedAt > prev.updatedAt) best.set(id, e)
  }
  return order.map((id) => best.get(id)!)
}

/** 写清单（先写临时文件再改名：中途崩了也不会留半个文件） */
function writeIndex(entries: CredentialEntry[]): void {
  const file = credentialIndexPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: dedupe(entries) }, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 清单写不进去不该影响存密码本身：靠读的时候容错 */
  }
}

/** 记一条（同一键同一种类同属主 → 刷新时间） */
export function recordEntry(
  e: { key: string; kind: CredentialKind; owner: CredentialOwner },
  now: () => string = () => new Date().toISOString()
): void {
  const key = (e.key ?? '').trim()
  if (!key) return
  const next: CredentialEntry = { key, kind: e.kind, owner: e.owner, updatedAt: now() }
  writeIndex([...readIndex().filter((x) => !(x.key === key && x.kind === e.kind && x.owner === e.owner)), next])
}

/** 去掉一条（删凭据时用） */
export function dropEntry(key: string, kind: CredentialKind, owner: CredentialOwner): void {
  const k = (key ?? '').trim()
  if (!k) return
  const before = readIndex()
  const after = before.filter((x) => !(x.key === k && x.kind === kind && x.owner === owner))
  if (after.length !== before.length) writeIndex(after)
}

/** 去掉某个键下的全部条目（不管种类/属主）：清孤儿时用 */
export function dropKey(key: string): void {
  const k = (key ?? '').trim()
  if (!k) return
  const before = readIndex()
  const after = before.filter((x) => x.key !== k)
  if (after.length !== before.length) writeIndex(after)
}

/**
 * 孤儿：清单里存在、但当前档案表里已经没有这个键了。
 *
 * 为什么按 `key` 对档案名：现在存储键就是档案名（改名的迁移在各自产品保存档案时做）。
 * 这里只做"看得见"，不替人做决定。
 */
export function orphansOf(entries: CredentialEntry[], profileNames: readonly string[]): CredentialEntry[] {
  const alive = new Set(profileNames.map((n) => (n ?? '').trim()).filter(Boolean))
  return entries.filter((e) => !alive.has(e.key))
}
