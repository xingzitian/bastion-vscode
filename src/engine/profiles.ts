/**
 * 无头档案读取（CLI 用）。
 *
 * 和扩展的 `profiles.ts` 读**同一份文件**（`~/.bastionshell/profiles.jsonc`），
 * 但只取连接需要的字段，不碰 SecretStorage。
 *
 * ⚠️ 凭据策略（暂定，见 docs/cli-host.md §6）：
 *   - `authMethod: key` → 用档案里的 privateKeyPath；
 *   - 否则由 CLI 交互式问一次密码（只在内存，不落盘）。
 *   桌面版的 `secrets.json` 与 VS Code SecretStorage **都不读**。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

export interface EngineProfile {
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  privateKeyPath?: string
  mode: 'direct' | 'bastion'
  userChoice?: string
  assetPolicy?: string
}

export function profilesFilePath(): string {
  const override = (process.env.BASTIONSHELL_SHARED_DIR ?? '').trim()
  const dir = override || path.join(os.homedir(), '.bastionshell')
  return path.join(dir, 'profiles.jsonc')
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 读全部档案；文件不存在 / 解析失败返回空数组（CLI 会给出可读提示） */
export function loadProfiles(file = profilesFilePath()): EngineProfile[] {
  if (!fs.existsSync(file)) return []
  let raw: unknown
  try {
    raw = parseJsonc(fs.readFileSync(file, 'utf8'), [], { allowTrailingComma: true })
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: EngineProfile[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    const name = str(o.name)
    const host = str(o.host)
    if (!name || !host) continue
    const port = Number(o.port)
    out.push({
      name,
      host,
      port: Number.isFinite(port) && port > 0 ? port : 22,
      username: str(o.username) || 'root',
      authMethod: o.authMethod === 'key' ? 'key' : 'password',
      privateKeyPath: str(o.privateKeyPath) || undefined,
      mode: o.mode === 'direct' ? 'direct' : 'bastion',
      userChoice: str(o.userChoice) || undefined,
      assetPolicy: str(o.assetPolicy) || undefined
    })
  }
  return out
}

/** 按名字（或别名）找档案：先精确 name，再忽略大小写 */
export function findProfile(name: string, file = profilesFilePath()): EngineProfile | undefined {
  const want = name.trim().toLowerCase()
  if (!want) return undefined
  const list = loadProfiles(file)
  return list.find((p) => p.name.toLowerCase() === want) ?? list.find((p) => p.host.toLowerCase() === want)
}
