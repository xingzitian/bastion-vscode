import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { parse as parseJsonc, ParseError } from 'jsonc-parser'
import { log } from './log'

/** 配置文件目录：~/.bastionshell/ */
export function configDir(): string {
  return path.join(os.homedir(), '.bastionshell')
}

function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true })
}

function filePath(name: string): string {
  return path.join(configDir(), name)
}

/** 坏文件备份成 .bak，并写日志，绝不静默吞掉 */
function backupCorrupt(fp: string): void {
  try {
    fs.copyFileSync(fp, fp + '.bak')
    log(`配置文件损坏，已备份为 ${path.basename(fp)}.bak`)
  } catch (e) {
    log(`配置文件损坏且备份失败: ${(e as Error).message}`)
  }
}

/**
 * 读一个 JSONC 配置文件（支持中文注释、尾逗号）。
 * - 文件不存在 → 返回 fallback
 * - 解析失败 / 校验不过 → 备份 .bak 后返回 fallback（带日志，不静默崩）
 */
export function readJsonFile<T>(name: string, fallback: T, validate: (v: unknown) => v is T): T {
  const fp = filePath(name)
  try {
    if (!fs.existsSync(fp)) return fallback
    const errors: ParseError[] = []
    const parsed: unknown = parseJsonc(fs.readFileSync(fp, 'utf8'), errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      backupCorrupt(fp)
      return fallback
    }
    if (!validate(parsed)) {
      backupCorrupt(fp)
      return fallback
    }
    return parsed
  } catch (e) {
    log(`读取配置 ${name} 失败: ${(e as Error).message}`)
    backupCorrupt(fp)
    return fallback
  }
}

/**
 * 原子写：先写 .tmp 再 rename，避免写一半断电损坏。headerComment 会作为中文说明写在文件顶部。
 *
 * rename 为什么要退避重试：Windows 的 MoveFileEx 在目标文件被别的进程**短暂**占用时
 * （杀毒扫描、搜索索引、编辑器还握着句柄）会抛 EPERM/EBUSY。这是「改了配置却没生效」
 * 的一个真实来源，而且它发生时你完全看不出来 —— 所以这里重试三次再放弃。
 */
export function writeJsonFile(name: string, data: unknown, headerComment?: string): void {
  ensureDir()
  const fp = filePath(name)
  const tmp = fp + '.tmp'
  try {
    const json = JSON.stringify(data, null, 2)
    const text = headerComment ? `${headerComment}\n${json}\n` : `${json}\n`
    fs.writeFileSync(tmp, text, 'utf8')
    renameWithRetry(tmp, fp)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    log(`写入配置 ${name} 失败: ${(e as Error).message}`)
    throw e
  }
}

/** rename 失败时退避重试（Windows 上被短暂占用是常事）；仍失败则把最后一次错误抛出去 */
function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      lastErr = e
      sleepSync(20 * (attempt + 1))
    }
  }
  throw lastErr
}

/** 同步小睡。重试循环里没有别的办法等（这个模块整体是同步 API） */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持就算了 —— 直接连续重试，不因为「等不了」而放弃 */
  }
}

/** 配置文件的绝对路径（需要就地改写、保留注释时用） */
export function configFilePath(name: string): string {
  return filePath(name)
}

/** 文件不存在时，用带中文说明的模板创建（initial 默认空数组）。用于「打开配置文件」命令。 */
export function ensureJsonFile(name: string, headerComment: string, initial: unknown = []): void {
  if (fs.existsSync(filePath(name))) return
  writeJsonFile(name, initial, headerComment)
}

/** 旧扩展名 .json → .jsonc 的一次性迁移（数据保留，并补上中文说明头） */
export function migrateJsonExtension(newName: string, oldName: string, header: string): void {
  const newFp = filePath(newName)
  const oldFp = filePath(oldName)
  if (fs.existsSync(newFp) || !fs.existsSync(oldFp)) return
  try {
    const errors: ParseError[] = []
    const data = parseJsonc(fs.readFileSync(oldFp, 'utf8'), errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      log(`旧配置 ${oldName} 解析失败，无法自动迁移，请手动处理（已保留原文件）`)
      return
    }
    writeJsonFile(newName, data, header)
    try {
      fs.unlinkSync(oldFp)
    } catch {
      /* ignore */
    }
    log(`已把配置 ${oldName} 迁移为 ${newName}`)
  } catch (e) {
    log(`迁移 ${oldName} → ${newName} 失败: ${(e as Error).message}`)
  }
}
