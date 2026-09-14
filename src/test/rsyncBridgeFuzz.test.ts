// 握手过滤器的**属性测试**（随机化）：把「一次实测两三个样本」升级成「上千组随机输入」。
//
// 为什么值得：过滤器的规则是"扫描到 0x1c..0x22 + 00 00 00 才算协议起点"，
// 而它两侧都有坑（踩过两个：CSI 的 `[` 被当成结束字节、协议号 0x20 被当空格丢掉）。
// 这类 bug 用几个手写样本很容易漏，只有随机化 + 不变量断言才压得住。
//
// 不变量（无论噪声长什么样都必须成立）：
//   I1 找到握手之后，**协议字节一个都不能改**（逐字节相等）
//   I2 协议起点必须正好落在握手那个字节上（不能多丢一个字节，也不能少丢）
//   I3 干净的流（没有噪声）必须原样通过，dropped=0
//   I4 分块到达（pty 经常一块一块给）与整块到达，结果必须一致
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RsyncGreetingFilter } from '../rsyncBridge'

/** 可复现的伪随机（不用 Math.random，失败时能重放） */
function mkRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const PROTOCOLS = [29, 30, 31, 32, 33, 34]

/** 造一段"像真机那样的"前导噪声：终端转义序列 + 命令回显 + CR/LF + 偶发的 0x20/0x1b 干扰 */
function noise(rng: () => number): Buffer {
  const parts: Buffer[] = []
  const kinds = Math.floor(rng() * 6)
  for (let i = 0; i < kinds; i++) {
    const r = rng()
    if (r < 0.25) parts.push(Buffer.from('\x1b[?2004l\r\n', 'latin1'))
    else if (r < 0.45) parts.push(Buffer.from('\x1b[A\x1b[2~', 'latin1'))
    else if (r < 0.7) parts.push(Buffer.from('stty raw -echo -iexten 2>/dev/null; PS1=; ', 'latin1'))
    else if (r < 0.85) parts.push(Buffer.from('__BASTION_RSYNC_RAW__\r\n', 'latin1'))
    else parts.push(Buffer.from([0x20, 0x0d, 0x0a, 0x1c, 0x22, 0x07].slice(0, 1 + Math.floor(rng() * 6))))
  }
  return Buffer.concat(parts)
}

/** 造一段随机的"协议负载"（含各种控制字节，包括 0x1b/0x0d/0x20 这些易被误处理的值） */
function payload(rng: () => number, len: number): Buffer {
  const b = Buffer.alloc(len)
  for (let i = 0; i < len; i++) {
    const r = rng()
    if (r < 0.3) b[i] = [0x1b, 0x0d, 0x0a, 0x20, 0x00, 0xff][Math.floor(rng() * 6)]
    else b[i] = Math.floor(rng() * 256)
  }
  return b
}

test('属性测试：随机噪声 + 随机协议号 + 随机负载 —— 必须精确切在握手处且负载逐字节不变', () => {
  const rng = mkRng(20260911)
  const rounds = 1500
  for (let i = 0; i < rounds; i++) {
    const noiseBuf = noise(rng)
    const proto = PROTOCOLS[Math.floor(rng() * PROTOCOLS.length)]
    const greeting = Buffer.from([proto, 0, 0, 0])
    const body = payload(rng, Math.floor(rng() * 200))
    const wire = Buffer.concat([noiseBuf, greeting, body])

    const f = new RsyncGreetingFilter()
    const out = f.feed(wire)

    // I2：正好丢掉噪声（噪声里可能含 0x1b 序列，所以用"从协议起点切"来判定）
    assert.deepEqual(
      [...out],
      [...Buffer.concat([greeting, body])],
      `第 ${i} 轮：输出必须从握手开始（噪声长度=${noiseBuf.length}，协议=${proto}，dropped=${f.dropped}）`
    )
    // I1：协议字节逐字节不变
    assert.equal(out.length, 4 + body.length, `第 ${i} 轮：长度必须等于握手 + 负载`)
  }
})

test('属性测试：干净的流必须原样通过（dropped=0）', () => {
  const rng = mkRng(7)
  for (let i = 0; i < 300; i++) {
    const proto = PROTOCOLS[Math.floor(rng() * PROTOCOLS.length)]
    const wire = Buffer.concat([Buffer.from([proto, 0, 0, 0]), payload(rng, Math.floor(rng() * 120))])
    const f = new RsyncGreetingFilter()
    const out = f.feed(wire)
    assert.deepEqual([...out], [...wire], `第 ${i} 轮：干净流不该被改动`)
    assert.equal(f.dropped, 0, `第 ${i} 轮：干净流不该丢字节`)
  }
})

test('属性测试：分块到达与整块到达结果必须一致（pty 就是一块一块给的）', () => {
  const rng = mkRng(424242)
  for (let i = 0; i < 400; i++) {
    const noiseBuf = noise(rng)
    const proto = PROTOCOLS[Math.floor(rng() * PROTOCOLS.length)]
    const body = payload(rng, Math.floor(rng() * 80))
    const wire = Buffer.concat([Buffer.from(noiseBuf), Buffer.from([proto, 0, 0, 0]), body])

    const whole = new RsyncGreetingFilter().feed(wire)

    const f = new RsyncGreetingFilter()
    const chunks: Buffer[] = []
    let at = 0
    while (at < wire.length) {
      const n = 1 + Math.floor(rng() * 5) // 1..5 字节一块
      chunks.push(f.feed(wire.subarray(at, Math.min(at + n, wire.length))))
      at += n
    }
    assert.deepEqual(
      [...Buffer.concat(chunks)],
      [...whole],
      `第 ${i} 轮：分块与整块的结果必须一致（这轮噪声=${noiseBuf.length} 协议=${proto}）`
    )
  }
})

test('属性测试：握手之前出现"像握手但不是"的片段，不能被骗（必须等真正的握手）', () => {
  const rng = mkRng(99)
  for (let i = 0; i < 500; i++) {
    // 伪握手：范围对了但后面不是三个 0
    const fake = Buffer.from([0x1c + Math.floor(rng() * 7), 1, 0, 0])
    const proto = PROTOCOLS[Math.floor(rng() * PROTOCOLS.length)]
    const body = payload(rng, 16)
    const wire = Buffer.concat([fake, Buffer.from([proto, 0, 0, 0]), body])
    const out = new RsyncGreetingFilter().feed(wire)
    assert.deepEqual(
      [...out.subarray(0, 4)],
      [proto, 0, 0, 0],
      `第 ${i} 轮：伪握手（${[...fake].join(',')}）不该被当成起点`
    )
  }
})
