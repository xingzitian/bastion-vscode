// SFTP 走 pushPath/pullPath 时的**接线**断言（0.3.18 真机问题的回归锁）。
//
// 2026-11-20 真机事故：
//   1. pushPath 仍先跑 `cd && pwd` 探测 → 那次 exec 返回空 → 目录当成空 → 悄悄回退 home
//      （`remoteDir: /tmp` 传成 `/root/config.json`，报告还写成功）
//   2. 仍跑能力探测（which rz/sz/base64/tar）→ 多等几秒
//   3. 调用方仍包着 withTransferLock → sftp 明明不占 pty，却把会话锁住了
//
// 这组测试直接断言：**sftp 路径下 exec 一次都不许被调用**，且目录原样透传。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pullPath, pushPath, type TransferSession } from '../core/transferPath'

function localFile(name: string, bytes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sftp-wire-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(bytes, 'x'))
  return p
}

function makeSession(over: Partial<TransferSession> = {}): { session: TransferSession; execCalls: string[] } {
  const execCalls: string[] = []
  const session: TransferSession = {
    name: 'wire-test',
    // 任何 shell 调用都记下来（测试要求：sftp 路径下这个数组必须为空）
    exec: async (cmd: string) => {
      execCalls.push(cmd)
      return ''
    },
    exitCode: () => 0,
    sftpAllowed: () => true,
    sftpPut: async (local, remoteDir) => ({
      ok: true,
      remotePath: `${remoteDir ?? '?'}/${path.basename(local)}`,
      message: 'ok',
      bytes: fs.statSync(local).size
    }),
    sftpGet: async (remotePath, localDir) => ({ ok: true, localPath: path.join(localDir, path.basename(remotePath)), message: 'ok', bytes: 1 }),
    overwriteMode: () => 'skip',
    log: () => undefined,
    ...over
  }
  return { session, execCalls }
}

test('★ pushPath：sftp 可用时**不调用任何 shell 命令**（不探测 cwd、不探测能力）', async () => {
  const { session, execCalls } = makeSession()
  const p = localFile('config.json', 760)
  const out = await pushPath({ localPath: p, remoteDir: '/tmp', session })
  assert.equal(out.ok, true)
  assert.equal(out.method, 'sftp')
  assert.deepEqual(execCalls, [], `sftp 路径不该跑 shell，实际跑了：${execCalls.join(' | ')}`)
})

test('★ pushPath：remoteDir 原样透传（不能被替换成空/home）', async () => {
  const seen: Array<string | undefined> = []
  const { session } = makeSession({
    sftpPut: async (local, remoteDir) => {
      seen.push(remoteDir)
      return { ok: true, remotePath: `${remoteDir}/${path.basename(local)}`, message: 'ok', bytes: 1 }
    }
  })
  await pushPath({ localPath: localFile('a.txt', 10), remoteDir: '/opt/relay-panel', session })
  assert.deepEqual(seen, ['/opt/relay-panel'])
})

test('pushPath：没给 remoteDir 时传 undefined（由宿主用 sftp 当前目录解析，不由 shell 猜）', async () => {
  const seen: Array<string | undefined> = []
  const { session } = makeSession({
    sftpPut: async (local, remoteDir) => {
      seen.push(remoteDir)
      return { ok: true, remotePath: `/x/${path.basename(local)}`, message: 'ok', bytes: 1 }
    }
  })
  await pushPath({ localPath: localFile('b.txt', 10), session })
  assert.deepEqual(seen, [undefined])
})

test('★ sftp 不可用时才回退：这时才允许跑 shell（能力探测）', async () => {
  const { session, execCalls } = makeSession({
    sftpAllowed: () => false,
    rzUpload: async () => ({ skipped: [], mode: 'skip' }),
    szDownload: async () => ({ ok: true })
  })
  const out = await pushPath({ localPath: localFile('c.txt', 10), session })
  assert.ok(execCalls.length > 0, '回退路径应当跑能力探测（证明两条路径是分开的）')
  assert.notEqual(out.method, 'sftp')
})

test('★ pullPath：sftp 可用时同样不调用 shell', async () => {
  const { session, execCalls } = makeSession()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pull-'))
  const out = await pullPath({ remotePath: '/tmp/x.bin', localDir: dir, session })
  assert.equal(out.ok, true)
  assert.equal(out.method, 'sftp')
  assert.deepEqual(execCalls, [])
})

test('★ 通道打不开（unsupported）→ 回退 rz；不是报错', async () => {
  const execCalls: string[] = []
  const session: TransferSession = {
    name: `fallback-${Date.now()}`,
    exec: async (cmd) => {
      execCalls.push(cmd)
      return 'rz=1\nsz=1\nbase64=1\ntar=1\nmd5sum=1\n'
    },
    exitCode: () => 0,
    sftpAllowed: () => true,
    sftpPut: async () => ({ ok: false, message: '打不开 SFTP 子系统：超时', unsupported: true }),
    rzUpload: async () => ({ skipped: [], mode: 'skip' }),
    overwriteMode: () => 'skip',
    log: () => undefined
  }
  const out = await pushPath({ localPath: localFile('fb.txt', 10), remoteDir: '/tmp', session })
  assert.notEqual(out.method, 'sftp', '应当回退到 rz，而不是直接失败')
  assert.ok(execCalls.length > 0, '回退路径会跑能力探测')
})

test('★ 真实业务错误（目录不存在）→ 直接报错，**不许**偷偷换通道', async () => {
  const session: TransferSession = {
    name: `realerr-${Date.now()}`,
    exec: async () => '',
    exitCode: () => 0,
    sftpAllowed: () => true,
    sftpPut: async () => ({ ok: false, message: '远端目录不存在：/opt/x' }),
    rzUpload: async () => ({ skipped: [], mode: 'skip' }),
    overwriteMode: () => 'skip',
    log: () => undefined
  }
  const out = await pushPath({ localPath: localFile('re.txt', 10), remoteDir: '/opt/x', session })
  assert.equal(out.ok, false)
  assert.match(out.message, /远端目录不存在/, '真实错误要原样报出来，换 rz 也没用')
})