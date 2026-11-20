// SFTP 传输的纯逻辑测试：路径映射、续传偏移、项目符号（同大小跳过）、大小校验、进度节流。
//
// 用一个内存版 fake sftp：createWriteStream 写进 Map，createReadStream 从 Map 读流。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { getFile, putFile, remoteDirOf, remoteJoin, canResumeBySize, resolveRemoteDir, shouldUseSftp, type SftpLike } from '../core/sftpTransfer'

interface Written {
  /** 每次写入的起点（0 = 新建） */
  startAt: number
  /** 追加写入时保留了原有内容 */
  keptPrefix: number
}

function makeSftp(files = new Map<string, Buffer>()): { sftp: SftpLike; files: Map<string, Buffer>; opened: Written[] } {
  const opened: Written[] = []
  const sftp: SftpLike = {
    async stat(p) {
      const buf = files.get(p)
      if (!buf) {
        const e = new Error('SSH_FX_NO_SUCH_FILE') as Error & { code?: string }
        e.code = 'SSH_FX_NO_SUCH_FILE'
        throw e
      }
      return { size: buf.length }
    },
    createReadStream(p, opts) {
      const buf = files.get(p)
      if (!buf) throw new Error(`no such file: ${p}`)
      const start = opts?.start ?? 0
      return Readable.from([buf.subarray(start)])
    },
    createWriteStream(p, opts) {
      const start = opts?.start ?? 0
      const flags = opts?.flags ?? 'w'
      const keep = flags === 'r+' || flags === 'a' ? (files.get(p)?.length ?? 0) : 0
      if (start > keep && flags !== 'w') throw new Error('续传起点超过文件长度')
      opened.push({ startAt: start, keptPrefix: Math.min(start, keep) })
      const sink = new PassThrough()
      const chunks: Buffer[] = []
      sink.on('data', (c: Buffer) => chunks.push(c))
      sink.on('finish', () => {
        const prefix = flags === 'w' ? Buffer.alloc(0) : (files.get(p) ?? Buffer.alloc(0)).subarray(0, start)
        files.set(p, Buffer.concat([prefix, ...chunks]))
      })
      return sink
    },
    async mkdir() {
      /* 不需要 */
    },
    async realpath(p) {
      return p
    },
    async unlink(p) {
      files.delete(p)
    },
    async rename(from, to) {
      const b = files.get(from)
      if (!b) throw new Error('no such file')
      files.set(to, b)
      files.delete(from)
    }
  }
  return { sftp, files, opened }
}

function tmpFile(content: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sftp-'))
  const p = path.join(dir, 'payload.bin')
  fs.writeFileSync(p, content)
  return p
}

test('远端路径拼接永远用 /（Windows 反斜杠也要被吃成 /）', () => {
  assert.equal(remoteJoin('/data/app', 'a.txt'), '/data/app/a.txt')
  assert.equal(remoteJoin('/data/app/', 'a.txt'), '/data/app/a.txt')
  assert.equal(remoteJoin('.', 'a.txt'), './a.txt')
  assert.equal(remoteJoin('\\data\\app', 'a.txt'), '/data/app/a.txt')
  assert.equal(remoteDirOf('/data/app/a.txt'), '/data/app')
  assert.equal(remoteDirOf('/a.txt'), '/')
  assert.equal(remoteDirOf('a.txt'), '.')
})

test('★ 全新上传：远端没有同名文件 → flags=w，写完大小一致', async () => {
  const { sftp, files, opened } = makeSftp()
  const local = tmpFile(Buffer.from('hello world'))
  const r = await putFile(sftp, local, '/data')
  assert.equal(r.ok, true)
  assert.equal(r.skipped, false)
  assert.equal(r.resumed, false)
  assert.equal(files.get('/data/payload.bin')?.toString(), 'hello world')
  assert.equal(opened[0].startAt, 0)
})

test('★ 断点续传：远端有前 6 字节 → 从 6 开始接着写，且保留前缀', async () => {
  const { sftp, files, opened } = makeSftp(new Map([['/data/payload.bin', Buffer.from('hello ')]]))
  const local = tmpFile(Buffer.from('hello world'))
  const r = await putFile(sftp, local, '/data')
  assert.equal(r.ok, true)
  assert.equal(r.resumed, true)
  assert.equal(opened[0].startAt, 6, '必须从远端已有长度开始，不能重传整份')
  assert.equal(files.get('/data/payload.bin')?.toString(), 'hello world')
})

test('★ 远端已同大小 → 跳过（部署重复执行不重复传）', async () => {
  const { sftp, files, opened } = makeSftp(new Map([['/data/payload.bin', Buffer.from('hello world')]]))
  const local = tmpFile(Buffer.from('hello world'))
  const r = await putFile(sftp, local, '/data')
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
  assert.equal(opened.length, 0, '跳过时不应打开任何写入流')
  assert.equal(files.get('/data/payload.bin')?.toString(), 'hello world')
})

test('★ 远端比本地大（上次写坏了）→ 覆盖重传，不续传', async () => {
  const { sftp, files, opened } = makeSftp(new Map([['/data/payload.bin', Buffer.from('hello world and garbage')]]))
  const local = tmpFile(Buffer.from('hello world'))
  const r = await putFile(sftp, local, '/data')
  assert.equal(r.ok, true)
  assert.equal(r.resumed, false, '远端更大时不能续传（会把错误内容留在中间）')
  assert.equal(opened[0].startAt, 0)
  assert.equal(files.get('/data/payload.bin')?.toString(), 'hello world')
})

test('canResumeBySize：只有远端更小才续传', () => {
  assert.equal(canResumeBySize(100, 40), true)
  assert.equal(canResumeBySize(100, 100), false)
  assert.equal(canResumeBySize(100, 140), false)
  assert.equal(canResumeBySize(100, 0), false)
})

test('本地文件不存在 → 明确报错，不抛异常', async () => {
  const { sftp } = makeSftp()
  const r = await putFile(sftp, path.join(os.tmpdir(), 'definitely-not-here-xyz.bin'), '/data')
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /本地文件读不到/)
})

test('★ 下载：远端有、本地没有 → 落盘大小一致', async () => {
  const { sftp, files } = makeSftp(new Map([['/data/payload.bin', Buffer.from('remote content')]]))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sftp-dl-'))
  const r = await getFile(sftp, '/data/payload.bin', dir)
  assert.equal(r.ok, true)
  assert.equal(r.bytes, 'remote content'.length)
  assert.equal(fs.readFileSync(path.join(dir, 'payload.bin'), 'utf8'), 'remote content')
  assert.equal(files.size, 1, '下载不该改动远端')
})

test('★ 下载续传：本地已有前 7 字节 → 追加剩余，大小正确', async () => {
  const { sftp } = makeSftp(new Map([['/data/payload.bin', Buffer.from('remote content')]]))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sftp-resume-'))
  fs.writeFileSync(path.join(dir, 'payload.bin'), 'remote ')
  const r = await getFile(sftp, '/data/payload.bin', dir)
  assert.equal(r.ok, true)
  assert.equal(r.resumed, true)
  assert.equal(fs.readFileSync(path.join(dir, 'payload.bin'), 'utf8'), 'remote content')
})

test('下载：本地与远端同大小 → 跳过（不重复下）', async () => {
  const { sftp } = makeSftp(new Map([['/data/payload.bin', Buffer.from('abc')]]))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sftp-skip-'))
  fs.writeFileSync(path.join(dir, 'payload.bin'), 'abc')
  const r = await getFile(sftp, '/data/payload.bin', dir)
  assert.equal(r.ok, true)
  assert.equal(r.resumed, false)
})

test('进度回调：至少报告到 100%，且带 resumed 标记', async () => {
  const seen: Array<{ ratio: number; resumed: boolean }> = []
  const { sftp } = makeSftp(new Map([['/data/payload.bin', Buffer.from('12345')]]))
  const local = tmpFile(Buffer.from('1234567890'))
  await putFile(sftp, local, '/data', { onProgress: (p) => seen.push({ ratio: p.ratio, resumed: p.resumed }) })
  assert.ok(seen.length >= 1, '应至少有一次进度回调')
  assert.equal(seen[seen.length - 1].ratio, 1, '最后一次必须是 100%')
  assert.equal(seen[seen.length - 1].resumed, true, '续传时进度要标出来')
})

test('★ 该不该用 SFTP：直连用、堡垒机不用（auto）；设置可强制', () => {
  assert.equal(shouldUseSftp('direct', 'auto'), true)
  assert.equal(shouldUseSftp('direct', undefined), true)
  assert.equal(shouldUseSftp('bastion', 'auto'), false, '堡垒机默认不用（sftp 可能落在堡垒机自己身上）')
  assert.equal(shouldUseSftp('bastion', 'sftp'), true, '强试才允许')
  assert.equal(shouldUseSftp('direct', 'rz'), false, '明确要 rz 就不试 sftp')
  assert.equal(shouldUseSftp('direct', 'base64'), false)
  assert.equal(shouldUseSftp(undefined, 'auto'), false, 'mode 缺省按堡垒机处理')
})
test('★ 目标目录不存在 → 必须报错，绝不悄悄退回 home（0.3.17 真实事故）', async () => {
  const { sftp } = makeSftp()
  const bad: SftpLike = { ...sftp, realpath: async () => { throw new Error('SSH_FX_NO_SUCH_FILE') } }
  await assert.rejects(() => resolveRemoteDir(bad, '/opt/relay-panel'), /目录不存在|不存在或不可访问/)
})

test('★ 给了目录但不是目录（是文件）→ 报错', async () => {
  const files = new Map([['/data/a.txt', Buffer.from('x')]])
  const { sftp } = makeSftp(files)
  const asFile: SftpLike = {
    ...sftp,
    realpath: async () => '/data/a.txt',
    stat: async () => ({ size: 1, isDirectory: () => false })
  }
  await assert.rejects(() => resolveRemoteDir(asFile, '/data/a.txt'), /不是目录/)
})

test('目录能解析时返回绝对路径（不吞掉用户给的 remoteDir）', async () => {
  const { sftp } = makeSftp()
  const ok: SftpLike = { ...sftp, realpath: async (p) => (p === '/tmp' ? '/tmp' : p), stat: async () => ({ size: 0, isDirectory: () => true }) }
  assert.equal(await resolveRemoteDir(ok, '/tmp'), '/tmp')
})

test('★ 有 fastPut 时新文件走 fastPut（库自带多并发），不走手写流', async () => {
  const { sftp, files } = makeSftp()
  let fastCalls = 0
  const withFast: SftpLike = {
    ...sftp,
    fastPut: async (local, remote) => {
      fastCalls++
      files.set(remote, fs.readFileSync(local))
    }
  }
  const local = tmpFile(Buffer.from('fast put path'))
  const r = await putFile(withFast, local, '/data')
  assert.equal(r.ok, true)
  assert.equal(fastCalls, 1, '新文件应当走 fastPut')
  assert.equal(files.get('/data/payload.bin')?.toString(), 'fast put path')
})