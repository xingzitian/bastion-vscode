// 传输追踪：进度、速率、历史持久化、失败重试字段
import '../testkit/vscode-stub'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { useTempHome, cleanupTempHome, cfgPath, fakeClock } from '../testkit/env'
import { slotItem } from '../testkit/vscode-stub'

const home = useTempHome()
const clock = fakeClock()
after(() => {
  clock.restore()
  cleanupTempHome(home)
})

import {
  trackTransfer,
  beginUpload,
  getTransferHistory,
  clearTransferHistory,
  TransferItem,
  TRANSFER_FILE
} from '../transfer'
import { disposeSlots } from '../status'

/** 造一个 zmodem 事件（和 zmodem.ts 的 ZmodemEventPayload 对齐） */
function ev(p: Partial<Parameters<typeof trackTransfer>[0]> & { type: string }, id = 'z1') {
  return { sessionId: 's', transferId: id, direction: 'send' as const, ...p } as Parameters<typeof trackTransfer>[0]
}

test('上传全过程：进度进状态栏、结束进历史', () => {
  const file = path.join(home, 'myapp.yaml')
  fs.writeFileSync(file, 'x')
  beginUpload([file])

  trackTransfer(ev({ type: 'start', name: 'myapp.yaml', bytesTotal: 1_000_000, localPath: file }))
  assert.equal(getTransferHistory().length, 0, '进行中不该进历史')

  clock.advance(500)
  trackTransfer(ev({ type: 'progress', name: 'myapp.yaml', bytesSent: 500_000, bytesTotal: 1_000_000 }))
  const slot = slotItem('transfer')
  assert.ok(slot, '传输槽位应已创建')
  assert.equal(slot.shown, true, '进度槽位应显示')
  assert.match(slot.text, /50%/, '要有百分比')
  assert.match(slot.text, /\/s/, '要有速率')
  assert.match(slot.text, /剩/, '要有剩余时间')

  clock.advance(500)
  trackTransfer(ev({ type: 'end', name: 'myapp.yaml', bytesSent: 1_000_000, bytesTotal: 1_000_000, localPath: file }))

  const h = getTransferHistory()
  assert.equal(h.length, 1)
  assert.equal(h[0].ok, true)
  assert.equal(h[0].direction, 'send')
  assert.equal(h[0].bytesSent, 1_000_000)
  assert.equal(h[0].speed, 1_000_000, '1MB / 1s = 1000000 B/s')
  assert.equal(h[0].endedAt! - h[0].startedAt, 1000)
  assert.equal(h[0].localPath, file)
  assert.deepEqual(h[0].retryPaths, [file], '上传要留重试路径')
  assert.equal(h[0].error, undefined)
})

test('速率样本太短时不显示（避免数字乱跳）', () => {
  beginUpload([path.join(home, 'tiny.bin')])
  trackTransfer(ev({ type: 'start', name: 'tiny.bin', bytesTotal: 100 }, 'z-tiny'))
  // 只过了 50ms，低于 MIN_SAMPLE_MS，不应显示速率
  clock.advance(50)
  trackTransfer(ev({ type: 'progress', name: 'tiny.bin', bytesSent: 50, bytesTotal: 100 }, 'z-tiny'))
  const slot = slotItem('transfer')
  assert.ok(slot)
  assert.match(slot.text, /50%/, '百分比仍要显示')
  assert.doesNotMatch(slot.text, /\/s/, '样本太短不显示速率')
})

test('失败：记 ok=false + 原因，并保留重试路径', () => {
  clock.advance(600)
  trackTransfer(ev({ type: 'start', name: 'fail.txt', bytesTotal: 10, localPath: path.join(home, 'fail.txt') }, 'z2'))
  clock.advance(600)
  trackTransfer(ev({ type: 'error', name: 'fail.txt', message: '远端磁盘满', localPath: path.join(home, 'fail.txt') }, 'z2'))

  const h = getTransferHistory()
  assert.equal(h[0].ok, false)
  assert.equal(h[0].error, '远端磁盘满')
  assert.deepEqual(h[0].retryPaths, [path.join(home, 'fail.txt')], '失败也要能重试')
})

test('zmodem 只给文件名时，用 basename 反查本地路径', () => {
  const p = path.join(home, 'basename-only.txt')
  beginUpload([p])
  trackTransfer(ev({ type: 'start', name: 'basename-only.txt', bytesTotal: 5 }, 'z3'))
  clock.advance(600)
  trackTransfer(ev({ type: 'error', name: 'basename-only.txt', message: '断了' }, 'z3'))
  assert.deepEqual(getTransferHistory()[0].retryPaths, [p])
})

test('下载方向：记 localPath，但不提供重试', () => {
  trackTransfer(ev({ type: 'start', direction: 'receive', name: 'app.log', bytesTotal: 2000, localPath: 'D:/dl/app.log' }, 'z4'))
  clock.advance(600)
  trackTransfer(
    ev({ type: 'end', direction: 'receive', name: 'app.log', bytesSent: 2000, bytesTotal: 2000, localPath: 'D:/dl/app.log' }, 'z4')
  )
  const r = getTransferHistory()[0]
  assert.equal(r.direction, 'receive')
  assert.equal(r.localPath, 'D:/dl/app.log')
  assert.equal(r.retryPaths, undefined, '下载重试需要远端原始命令，不做')
})

test('info 事件不进历史（只是会话级提示）', () => {
  const before = getTransferHistory().length
  trackTransfer(ev({ type: 'info', message: 'ZMODEM 接收会话结束' } as never, 'z9'))
  assert.equal(getTransferHistory().length, before)
})

test('没有 start 的乱序 end 也不会炸', () => {
  assert.doesNotThrow(() => {
    trackTransfer(ev({ type: 'end', name: 'orphan.txt', bytesSent: 3, bytesTotal: 3 }, 'z-orphan'))
  })
})

test('小文件秒传：不写没意义的 0 B/s', () => {
  // 真实数据里出现过 209 字节的 Makefile 记成 "0 B/s"，这里固化成「干脆不写这个字段」
  trackTransfer(ev({ type: 'start', name: 'Makefile', bytesTotal: 209, localPath: path.join(home, 'Makefile') }, 'z-fast'))
  clock.advance(30) // 远小于 MIN_SAMPLE_MS
  trackTransfer(
    ev({ type: 'end', name: 'Makefile', bytesSent: 209, bytesTotal: 209, localPath: path.join(home, 'Makefile') }, 'z-fast')
  )
  const r = getTransferHistory()[0]
  assert.equal(r.ok, true)
  assert.equal(r.speed, undefined, '样本太短就不该给出速率')
  // 落盘文件里也不该出现 speed: 0
  const raw = fs.readFileSync(cfgPath(home, TRANSFER_FILE), 'utf8')
  assert.doesNotMatch(raw, /"speed": 0/)
})

test('树上也不显示速率（0 值不渲染）', () => {
  const it = new TransferItem({
    id: 'x',
    direction: 'send',
    name: 'Makefile',
    bytesSent: 209,
    bytesTotal: 209,
    ok: true,
    startedAt: 0,
    endedAt: 30
  })
  assert.doesNotMatch(String(it.description), /\/s/)
})

test('历史带中文说明头，文件顺序与内存一致（最新在最前）', () => {
  const fp = cfgPath(home, TRANSFER_FILE)
  assert.equal(fs.existsSync(fp), true)
  const raw = fs.readFileSync(fp, 'utf8')
  assert.match(raw, /BastionShell 传输历史/)
  const parsed = JSON.parse(raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  const mem = getTransferHistory()
  assert.ok(mem.length > 1, '此时应已积累多条记录')
  assert.equal(parsed.length, mem.length)
  // 不写死具体文件名（那会依赖用例执行顺序），只断言「两边顺序一致且最新在前」
  assert.deepEqual(
    parsed.map((r: { name: string }) => r.name),
    mem.map((r) => r.name)
  )
})

test('历史上限 200 条（内存和文件都截断）', () => {
  clearTransferHistory()
  for (let i = 0; i < 260; i++) {
    trackTransfer(ev({ type: 'start', name: `f${i}`, bytesTotal: 1 }, `b${i}`))
    trackTransfer(ev({ type: 'end', name: `f${i}`, bytesSent: 1, bytesTotal: 1 }, `b${i}`))
  }
  assert.equal(getTransferHistory().length, 200)
  const fp = cfgPath(home, TRANSFER_FILE)
  const parsed = JSON.parse(fs.readFileSync(fp, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  assert.equal(parsed.length, 200, '文件里也要截断，不能无限增长')
})

test('清空：内存和文件同时归零', () => {
  clearTransferHistory()
  assert.equal(getTransferHistory().length, 0)
  const fp = cfgPath(home, TRANSFER_FILE)
  const parsed = JSON.parse(fs.readFileSync(fp, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  assert.equal(parsed.length, 0)
})

test('树节点 contextValue：只有「失败 + 有本地路径」才给重试菜单', () => {
  const mk = (o: Partial<ConstructorParameters<typeof TransferItem>[0]>) =>
    new TransferItem({
      id: 'x',
      direction: 'send',
      name: 'a',
      bytesSent: 1,
      bytesTotal: 1,
      ok: true,
      startedAt: 0,
      endedAt: 1,
      ...o
    })
  assert.equal(mk({ ok: false, retryPaths: ['p'] }).contextValue, 'transferFailed')
  assert.equal(mk({ ok: false, direction: 'receive' }).contextValue, 'transfer', '下载失败不给重试')
  assert.equal(mk({ ok: true, retryPaths: ['p'] }).contextValue, 'transfer', '成功不给重试')
  assert.equal(mk({ ok: null }).contextValue, 'transfer', '进行中不给重试')
})

after(() => disposeSlots())
