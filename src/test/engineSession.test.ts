// 无头会话引擎的执行判定测试（与扩展 0.3.21 的语义必须一致）。
//
// 用假 ShellChannel：write 记录、测试自己 emit data/close。
// 覆盖三条真机教训：
//   1. 能挂哨兵 → 静默**不**算完成（sleep 10 不会被 3 秒判死）
//   2. 挂不了哨兵（sudo -i）→ 静默兜底仍然生效，且从写出去就开始计时
//   3. 哨兵带退出码要如实透出

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EngineSession, type ShellChannel } from '../engine/session'

function makeChannel(): { chan: ShellChannel; written: string[]; emit: (s: string) => void; close: () => void } {
  const dataCbs: Array<(d: Buffer) => void> = []
  const closeCbs: Array<() => void> = []
  const written: string[] = []
  const chan: ShellChannel = {
    write: (d) => {
      written.push(typeof d === 'string' ? d : d.toString('utf8'))
    },
    on: (ev: string, cb: never) => {
      if (ev === 'data') dataCbs.push(cb)
      else if (ev === 'close') closeCbs.push(cb)
      return undefined
    },
    setWindow: () => undefined
  }
  return {
    chan,
    written,
    emit: (s) => {
      for (const cb of dataCbs) cb(Buffer.from(s, 'utf8'))
    },
    close: () => {
      for (const cb of closeCbs) cb()
    }
  }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('★ 能挂哨兵：静默不判完成（sleep 10 不再被 3 秒判死）', async () => {
  const { chan, written, emit } = makeChannel()
  const s = new EngineSession('t', chan, { makeMarker: () => '__M1__' })
  let done = false
  const p = s.exec('sleep 10; echo waited-10s', { quietMs: 60, maxMs: 5000 }).then((r) => {
    done = true
    return r
  })

  await tick(200)
  assert.equal(done, false, '静默不该判完成')
  assert.ok(written.join('').includes('__M1__'), '哨兵应挂在命令后面')

  emit('waited-10s\r\n__M1__:0\r\n')
  const r = await p
  assert.equal(r.markerSeen, true)
  assert.equal(r.exitCode, 0)
  assert.equal(r.timedOut, false)
  assert.match(r.text, /waited-10s/)
  assert.ok(!r.text.includes('__M1__'), '哨兵行不该出现在给 AI 的文本里')
})

test('★ 挂不了哨兵（sudo -i）：静默兜底生效，且从写出去那一刻计时', async () => {
  const { chan } = makeChannel()
  const s = new EngineSession('t', chan)
  const t0 = Date.now()
  const r = await s.exec('sudo -i', { quietMs: 50, maxMs: 5000 })
  assert.ok(Date.now() - t0 < 2000, '不该等到 maxMs')
  assert.equal(r.markerSeen, true, 'unsafe 命令本来就没有哨兵 → markerSeen 恒 true')
})

test('哨兵带非零退出码：如实返回（脚本失败要能被看见）', async () => {
  const { chan, emit } = makeChannel()
  const s = new EngineSession('t', chan, { makeMarker: () => '__M2__' })
  const p = s.exec('false', { quietMs: 60, maxMs: 5000 })
  await tick(80)
  emit('__M2__:2\r\n')
  const r = await p
  assert.equal(r.markerSeen, true)
  assert.equal(r.exitCode, 2)
})

test('tail：去掉 ANSI 与 \\r 覆盖（给 bastion_tail / AI 看的就是这个）', () => {
  const { chan } = makeChannel()
  const s = new EngineSession('t', chan)
  // 直接喂原始输出（模拟远端屏幕）
  const anyS = s as unknown as { buf: string }
  anyS.buf = '\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 90%\rprogress 100%\r\n'
  const tail = s.tail(5)
  assert.match(tail, /^ok$/m)
  assert.match(tail, /progress 100%/)
  assert.ok(!tail.includes('progress 10%'), '\\r 覆盖应只留最后一段')
})
