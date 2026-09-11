/**
 * 命令：从屏幕原文生成菜单规则。
 *
 * 为什么需要它：菜单认不出来时，原来的路径是「去日志里翻屏幕原文 → 自己写正则 → 填进设置」。
 * 不会写正则的人到第一步就断了。这个命令把整件事变成三步点选：
 *   选屏幕 → 选那句提示 → 选它属于哪一类
 * 正则由 menuRule.ts 生成（数字泛化成 \d+、空白泛化成 \s+、其余转义）。
 */

import * as vscode from 'vscode'
import { log } from './log'
import { getLastUnrecognizedScreen, activeSession } from './state'
import {
  buildMenuRuleSuggestions,
  appendMenuRule,
  HINT_KEY_LABEL,
  type MenuRuleSuggestion
} from './menuRule'
import type { MenuHintKey } from './menu'

const ALL_KEYS: MenuHintKey[] = ['hostPrompt', 'hostPromptLoose', 'userPrompt', 'shellPrompt']

interface LinePick extends vscode.QuickPickItem {
  suggestion: MenuRuleSuggestion
}

export async function generateMenuRule(): Promise<void> {
  // 1) 屏幕原文：优先用「最近一次没认出来」的那段；没有就用当前会话现在屏幕上的内容
  let screen = getLastUnrecognizedScreen()
  let source = '最近一次没认出来的屏幕原文'
  if (!screen.trim()) {
    const s = activeSession()
    screen = s?.term.getTail(30) ?? ''
    source = '当前会话屏幕上的内容'
  }
  if (!screen.trim()) {
    void vscode.window.showWarningMessage(
      '没有可用的屏幕原文。先连一次目标机（认不出来时日志会自动留下原文），或者打开一个会话再执行这个命令。'
    )
    return
  }

  // 2) 选一句提示
  const suggestions = buildMenuRuleSuggestions(screen)
  if (suggestions.length === 0) {
    void vscode.window.showWarningMessage(`${source}里没有可用的文本行。`)
    return
  }
  const picks = await vscode.window.showQuickPick<LinePick>(
    suggestions.map((s) => ({
      label: s.line,
      description: `→ ${HINT_KEY_LABEL[s.key]}`,
      detail: `生成的规则：${s.pattern}`,
      suggestion: s
    })),
    {
      placeHolder: `从${source}里选「那句提示」（会生成正则；数字与空格会自动放宽）`,
      matchOnDescription: true,
      matchOnDetail: true
    }
  )
  if (!picks) return

  // 3) 选它属于哪一类（默认停在猜出来的那类）
  const keyPick = await vscode.window.showQuickPick(
    ALL_KEYS.map((k) => ({
      label: HINT_KEY_LABEL[k],
      description: k === picks.suggestion.key ? '（推荐）' : '',
      key: k
    })),
    { placeHolder: '这条规则加到哪一类？' }
  )
  if (!keyPick) return
  const key = (keyPick as { key: MenuHintKey }).key

  // 4) 写进设置。
  //    注意：设置是「填了就整组替换内置默认」，所以这里用 appendMenuRule 把内置的一起带上，
  //    否则用户加一条反而会把默认规则全丢掉、认得比原来还少。
  const cfg = vscode.workspace.getConfiguration('bastion')
  const settingKey = `menuHints.${key}`
  const current = cfg.get<string[]>(settingKey)
  const next = appendMenuRule(current, key, picks.suggestion.pattern)
  if (!next) {
    void vscode.window.showInformationMessage(`这条规则已经在 ${settingKey} 里了，没动设置。`)
    return
  }
  await cfg.update(settingKey, next, vscode.ConfigurationTarget.Global)
  log(`菜单规则已加入 ${settingKey}：${picks.suggestion.pattern}（共 ${next.length} 条）`)

  const act = await vscode.window.showInformationMessage(
    `已把这条规则加进 ${settingKey}：${picks.suggestion.pattern}`,
    '重连试试',
    '看看设置'
  )
  if (act === '重连试试') {
    await vscode.commands.executeCommand('bastion.reconnect')
  } else if (act === '看看设置') {
    await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${settingKey}`)
  }
}
