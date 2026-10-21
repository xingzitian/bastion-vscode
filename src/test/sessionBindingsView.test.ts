// 管理面板：状态栏那格「AI 绑定」必须真的显示/清空（用户要求"能看到哪个 AI 绑了哪条会话"）。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as vscode from 'vscode'
import { terminals } from '../state'
import { resetStatusBarItems, slotItem } from '../testkit/vscode-stub'
import { bindSession, loadBindings, saveBindings, type SessionRef } from '../sessionBindings'
import { updateAiBindingSlot } from '../sessionBindingsView'

function putTerminal(name: string, id: string): vscode.Terminal {
  const vt = { name } as unknown as vscode.Terminal
  terminals.set(vt, { sessionId: id, sessionNo: 1, isReadOnly: false } as unknown as import('../terminal').BastionTerminal)
  return vt
}

test('有绑定时状态栏显示「AI N」，没绑定就清掉（不占底栏）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-panel-'))
  const old = process.env.BASTIONSHELL_SHARED_DIR
  process.env.BASTIONSHELL_SHARED_DIR = dir
  resetStatusBarItems()
  const vt = putTerminal('#3 deploy@10.0.0.1', 's-7f3a')
  try {
    // 没绑定 → 不显示
    updateAiBindingSlot()
    assert.notEqual(slotItem('ai')?.shown, true, '没有绑定时不该显示（底栏稀缺）')

    // 绑一条 → 显示计数 + 点击命令 + tooltip 写出是谁绑的
    const f = loadBindings()
    bindSession(f, 'claude', { id: 's-7f3a', name: '#3 deploy@10.0.0.1', no: 3, state: 'shell' } as SessionRef)
    saveBindings(f)
    updateAiBindingSlot()
    const item = slotItem('ai')
    assert.ok(item, '应该出现 AI 绑定格')
    assert.match(item!.text, /AI 1/, `要显示绑定条数：${item!.text}`)
    assert.equal(item!.command?.command, 'bastion.showAiBindings', '点一下要能打开面板')
    const tip = String((item!.tooltip as { value?: string })?.value ?? '')
    assert.match(tip, /claude/, 'tooltip 里要写清是哪个客户端绑的')

    // 会话没了 → 不显示（绑定不该虚报）
    terminals.delete(vt)
    updateAiBindingSlot()
    assert.notEqual(slotItem('ai')?.shown, true, '会话没了就不该还显示旧绑定')
  } finally {
    terminals.delete(vt)
    if (old === undefined) delete process.env.BASTIONSHELL_SHARED_DIR
    else process.env.BASTIONSHELL_SHARED_DIR = old
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
