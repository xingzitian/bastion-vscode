import * as vscode from 'vscode'
import { readJsonFile, ensureJsonFile, configFilePath } from './config'
import { buildDangerRules, type DangerRule, type DangerRulesOverride } from './danger'
import { log } from './log'

/**
 * 高危命令规则的**用户配置层**。
 *
 * 为什么做成文件而不是设置项：一条规则需要三个字段（id / 原因 / 正则），
 * 设置里的字符串数组表达不了「原因」，而「原因」正是确认框里给人看的东西 ——
 * 只说「命中了一条规则」等于没说。文件还能写中文注释，和本扩展其它配置一致。
 *
 * 纯逻辑在 danger.ts（buildDangerRules），这里只负责读写文件。
 */

export const DANGER_RULES_FILE = 'dangerRules.jsonc'

export const DANGER_RULES_TEMPLATE: DangerRulesOverride = {
  useBuiltin: true,
  disabled: [],
  extra: [
    {
      id: 'example-db-drop',
      why: '删除数据库或表（示例，不需要就删掉）',
      pattern: '\\bdrop\\s+(database|table)\\b'
    }
  ]
}

export const DANGER_RULES_HEADER = [
  '// ============================================================',
  '// BastionShell 高危命令规则',
  '// ------------------------------------------------------------',
  '// 命中这些规则时：AI 的 bastion_exec 会被**直接拒绝**；',
  '// 快捷命令和部署任务会**弹确认框**（列出生效的规则和命中的原文）。',
  '// ------------------------------------------------------------',
  '// 内置规则只覆盖最常见的那批，而且允许你关掉或补充 —— 各家的禁忌命令不一样。',
  '//',
  '// 字段说明：',
  '//   useBuiltin  是否使用内置规则，默认 true。',
  '//               想让内置一条都不生效、完全用自己写的，就填 false。',
  '//   disabled    要关掉的内置规则 id（内置误报时用）。可用 id 见下方注释。',
  '//   extra       追加自定义规则，每条三个字段：',
  '//                 id      自己起的唯一标识（可省略，会自动编号）',
  '//                 why     一句话原因，会显示在确认框里（强烈建议写）',
  '//                 pattern 正则源码，编译时不区分大小写（i）',
  '// ------------------------------------------------------------',
  '// 内置规则 id 一览（要关掉哪条就写进 disabled）：',
  '//   rm-root        删除根目录或家目录（rm -rf /、rm -rf ~）',
  '//   reboot         重启或关机',
  '//   mkfs           格式化文件系统（mkfs / wipefs）',
  '//   dd-dev         向块设备直接写数据（dd of=/dev/sda）',
  '//   redirect-dev   覆写磁盘设备（> /dev/sda）',
  '//   chmod-root     修改根目录权限',
  '//   chown-root     修改根目录属主',
  '//   fork-bomb      fork 炸弹',
  '//   mv-sysdir      移动系统关键目录（mv /etc ...）',
  '//   truncate-dev   截断设备文件',
  '//   shred-dev      擦除设备数据',
  '//   kill-all       终止所有进程（killall5）',
  '// ------------------------------------------------------------',
  '// 例子：公司禁止直接改生产库，就加一条：',
  '//   { "id": "prod-db", "why": "禁止直接改生产库", "pattern": "\\\\b(UPDATE|DELETE|DROP)\\\\b" }',
  '// ============================================================'
].join('\n')

function isOverride(v: unknown): v is DangerRulesOverride {
  // 只要求是个对象；字段写错在 buildDangerRules 里逐条忽略，不整份作废
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 读用户配置（文件不存在会自动按模板建一份，方便直接编辑） */
export function getDangerOverride(): DangerRulesOverride {
  try {
    ensureJsonFile(DANGER_RULES_FILE, DANGER_RULES_HEADER, DANGER_RULES_TEMPLATE)
    return readJsonFile<DangerRulesOverride>(DANGER_RULES_FILE, {}, isOverride)
  } catch (e) {
    log(`读取高危命令规则失败: ${(e as Error).message}`)
    return {}
  }
}

/**
 * 最终生效的规则表（内置 + 用户覆盖）。
 * 出错一律退回内置 —— 检查高危命令这件事不能因为配置读失败就失效。
 */
export function getDangerRules(): DangerRule[] {
  try {
    return buildDangerRules(getDangerOverride())
  } catch (e) {
    log(`构建高危规则失败，退回内置：${(e as Error).message}`)
    return buildDangerRules()
  }
}

/** 打开配置文件（不存在则按模板创建） */
export async function openDangerRulesFile(): Promise<void> {
  ensureJsonFile(DANGER_RULES_FILE, DANGER_RULES_HEADER, DANGER_RULES_TEMPLATE)
  await vscode.window.showTextDocument(vscode.Uri.file(configFilePath(DANGER_RULES_FILE)))
}
