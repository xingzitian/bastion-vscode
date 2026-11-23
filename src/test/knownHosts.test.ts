// known_hosts 校验：解析、匹配（含 |1| 哈希）、不匹配拒绝、TOFU 追加。
//
// 这是 v1 的安全债（只打指纹不校验）的补丁，必须能被单测覆盖 ——
// 否则"校验了"和"没校验"在代码里看着差不多。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {
  appendKnownHost,
  hostPatternFor,
  parseKnownHosts,
  sha256Fingerprint,
  verifyHostKey
} from '../engine/knownHosts'

/** 造一段合法的 ssh-ed25519 公钥 blob：uint32 len + "ssh-ed25519" + 随机 32 字节 */
function fakeKey(seed = 'a'): Buffer {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(name.length, 0)
  const body = crypto.createHash('sha256').update(seed).digest()
  return Buffer.concat([len, name, body])
}

test('解析：普通行 / 带端口 / 注释 / @cert-authority 跳过', () => {
  const text = [
    '# comment',
    'example.com ssh-ed25519 AAAAB3NzaC1lZDI1NTE5AAAAIAAA',
    '[example.com]:2222 ssh-rsa AAAAB3NzaC1yc2EAAA',
    '@cert-authority *.internal ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCC',
    'bad line'
  ].join('\n')
  const { entries, skipped } = parseKnownHosts(text)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].hostPattern, 'example.com')
  assert.equal(entries[1].hostPattern, '[example.com]:2222')
  assert.equal(skipped.length, 2, '证书行与坏行都要列出来，不能静默吞掉')
})

test('hostPatternFor：22 端口不写端口，其它端口带 []', () => {
  assert.equal(hostPatternFor('h.example', 22), 'h.example')
  assert.equal(hostPatternFor('h.example', 2222), '[h.example]:2222')
})

test('匹配：同一把 key → match', () => {
  const k = fakeKey('x')
  const text = `host1 ${'ssh-ed25519'} ${k.toString('base64')}\n`
  const r = verifyHostKey(text, 'host1', 22, k)
  assert.equal(r.status, 'match')
  assert.equal(r.fingerprint, sha256Fingerprint(k))
})

test('★ 不匹配：机器换 key / 中间人 → mismatch（调用方据此拒绝连接）', () => {
  const oldKey = fakeKey('old')
  const newKey = fakeKey('new')
  const text = `host1 ssh-ed25519 ${oldKey.toString('base64')}\n`
  const r = verifyHostKey(text, 'host1', 22, newKey)
  assert.equal(r.status, 'mismatch')
  assert.deepEqual(r.expectedTypes, ['ssh-ed25519'])
})

test('未知主机 → unknown（TOFU 才允许继续）', () => {
  const r = verifyHostKey('other ssh-ed25519 AAAA\n', 'host1', 22, fakeKey())
  assert.equal(r.status, 'unknown')
})

test('带端口的主机只匹配带端口的条目', () => {
  const k = fakeKey('p')
  const text = `[h1]:2222 ssh-ed25519 ${k.toString('base64')}\n`
  assert.equal(verifyHostKey(text, 'h1', 2222, k).status, 'match')
  assert.equal(verifyHostKey(text, 'h1', 22, k).status, 'unknown', '22 端口不该命中 [h1]:2222')
})

test('哈希主机名（HashKnownHosts yes）也能匹配', () => {
  const k = fakeKey('h')
  const salt = crypto.randomBytes(20)
  const host = 'h.example'
  const mac = crypto.createHmac('sha1', salt).update(host).digest()
  const pattern = `|1|${salt.toString('base64')}|${mac.toString('base64')}`
  const text = `${pattern} ssh-ed25519 ${k.toString('base64')}\n`
  assert.equal(verifyHostKey(text, host, 22, k).status, 'match')
  assert.equal(verifyHostKey(text, 'other.example', 22, k).status, 'unknown')
})

test('appendKnownHost 写出来的行能被自己解析（TOFU 闭环）', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-kh-'))
  const file = path.join(dir, 'known_hosts')
  try {
    const k = fakeKey('t')
    const r = appendKnownHost(file, 'h2', 2222, 'ssh-ed25519', k)
    assert.equal(r.ok, true, r.error)
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /^\[h2\]:2222 ssh-ed25519 /)
    assert.equal(verifyHostKey(text, 'h2', 2222, k).status, 'match')
    assert.equal(verifyHostKey(text, 'h2', 22, k).status, 'unknown')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
