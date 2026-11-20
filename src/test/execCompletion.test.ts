// exec 完成判定的回归测试（2026-11-20 真机：`sleep 10` 被 3 秒静默判成"完成"）。
//
// 判定规则（正确版）：
//   - 命令**能挂哨兵**（单行、非交互）→ 只认哨兵（或会话关闭 / maxMs），
//     **静默不算完成** —— 否则 `sleep 10`、长时间无输出的构建都会被提前判死，
//     下一条命令还会被塞进还在运行的进程里。
//   - 命令**挂不了哨兵**（`sudo -i`、交互式）→ 只能靠静默兜底，这是唯一可用的信号。

import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BastionTerminal } from '../terminal'
import type { SharedConnection } from '../connection'
import type { ConnectionProfile } from '../profiles'

const profile: ConnectionProfile = {
  name: '测试机',
  host: '10.0.0.1',
  port: 22,
  username: 'tester',
  authMethod: 'password'
}

interface FakeTerm {
  stream: EventEmitter & { write(d: string): void }
  lastDataAt: number
  closed: boolean
  screenCursor: number
  execDetailed(cmd: string, opts?: Record<string, unknown>): Promise<{ text: string; markerSeen: boolean; exitCode?: number; timedOut: boolean }>
}

function makeTerm(): { t: FakeTerm; written: string[]; feed: (s: string) => void } {
  const t = new BastionTerminal({} as SharedConnection, profile) as unknown as FakeTerm
  const written: string[] = []
  const stream = new EventEmitter() as FakeTerm['stream']
  stream.write = (d: string) => {
    written.push(d)
  }
  t.stream = stream
  t.lastDataAt = Date.now() // 跳过"冷启动等第一屏"
  t.closed = false
  t.screenCursor = 0
  // 让 execDetailed 通过 wait this.shellReady（测试里没人会去触发真实提示符）
  ;(t as unknown as { shellReadyResolve?: () => void }).shellReadyResolve?.()
  return { t, written, feed: (s: string) => stream.emit('data', Buffer.from(s, 'utf8')) }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('★ 能挂哨兵的命令：静默不算完成（sleep 10 不再被 3 秒判死）', async () => {
  const { t, written, feed } = makeTerm()
  let done = false
  const p = t.execDetailed('sleep 10; echo waited-10s', { quietMs: 60, maxMs: 5000 }).then((r) => {
    done = true
    return r
  })

  // 等 quietMs 的两倍：旧逻辑会在这里就返回（markerSeen=false）
  await tick(200)
  assert.equal(done, false, '静默不该判完成 —— 哨兵还没到')
  assert.ok(written.join('').includes('sleep 10'), '命令应已写进终端')
  assert.ok(written.join('').includes('__BASTION_DONE_'), '哨兵应该挂在命令后面')

  // 把哨兵"回显"出来（真实终端最后会打这一行）
  const marker = /__BASTION_DONE_[0-9a-z_]+__/.exec(written.join(''))?.[0] ?? ''
  assert.ok(marker, '找不到哨兵')
  feed(`${marker}:0\r\n`)
  const r = await p
  assert.equal(r.markerSeen, true)
  assert.equal(r.exitCode, 0)
  assert.equal(r.timedOut, false)
})

test('★ 挂不了哨兵的命令（sudo -i 这类）：静默兜底仍然生效', async () => {
  const { t } = makeTerm()
  const t0 = Date.now()
  const r = await t.execDetailed('sudo -i', { quietMs: 50, maxMs: 5000, allowPlainSudo: false })
  assert.ok(Date.now() - t0 < 3000, '不该等到 maxMs')
  assert.equal(r.markerSeen, true, 'unsafe 命令 markerSeen 恒为 true（本来就没有标记）')
})

test('哨兵带非零退出码时如实返回（部署报告靠它判断失败）', async () => {
  const { t, written, feed } = makeTerm()
  const p = t.execDetailed('false', { quietMs: 60, maxMs: 5000 })
  await tick(80)
  const marker = /__BASTION_DONE_[0-9a-z_]+__/.exec(written.join(''))?.[0] ?? ''
  feed(`${marker}:2\r\n`)
  const r = await p
  assert.equal(r.markerSeen, true)
  assert.equal(r.exitCode, 2)
})
