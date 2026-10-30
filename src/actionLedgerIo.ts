/**
 * 账本落盘：`~/.bastionshell/action-ledger.jsonl`（每行一条记录，同 actionId 后来者覆盖）。
 *
 * 为什么是 JSONL 而不是 JSON 数组：
 *  - 追加写不用读全量、不怕写到一半被中断（坏行跳过）
 *  - 出问题能直接用 grep/tail 看，不用写工具
 *
 * 裁剪策略：文件超过 ~2MB 时，读全量 → 留最近 500 条 → 原子重写。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { configDir } from './config'
import { log } from './log'
import { parseLedger, pruneRecords, toJsonl, type ActionRecord } from './actionLedger'

const FILE = 'action-ledger.jsonl'
const MAX_BYTES = 2 * 1024 * 1024
const KEEP = 500

export function ledgerPath(): string {
  return path.join(configDir(), FILE)
}

/** 追加一条（同 actionId 的多次状态各写一行，读取时 Later wins） */
export async function appendActionRecord(rec: ActionRecord): Promise<void> {
  const p = ledgerPath()
  try {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.appendFile(p, toJsonl(rec) + '\n', 'utf8')
  } catch (e) {
    log(`账本写入失败（不影响执行）：${(e as Error).message}`)
    return
  }
  void pruneIfBig(p)
}

async function pruneIfBig(p: string): Promise<void> {
  try {
    const st = await fs.stat(p)
    if (st.size <= MAX_BYTES) return
    const text = await fs.readFile(p, 'utf8')
    const kept = pruneRecords(parseLedger(text), KEEP)
    const tmp = `${p}.tmp`
    await fs.writeFile(tmp, kept.map((r) => toJsonl(r)).join('\n') + '\n', 'utf8')
    await fs.rename(tmp, p) // 原子替换：不会留下半截文件
    log(`账本已裁剪：${kept.length} 条（原 ${Math.round(st.size / 1024)}KB）`)
  } catch (e) {
    log(`账本裁剪失败（不影响使用）：${(e as Error).message}`)
  }
}

/** 读最近 max 条（倒序无关；调用方自己排） */
export async function loadActionRecords(max = 300): Promise<ActionRecord[]> {
  const p = ledgerPath()
  try {
    const text = await fs.readFile(p, 'utf8')
    const all = parseLedger(text)
    return all.slice(Math.max(0, all.length - max))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log(`账本读取失败：${(e as Error).message}`)
    return []
  }
}
