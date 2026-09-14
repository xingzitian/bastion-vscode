// rsync 端到端测试的工具箱（不是测试文件本身：`npm test` 只认 *.test.js）。
//
// 连的是本地测试台（`tools/rsync-e2e/setup-wsl.sh`）：WSL 里一个只听 127.0.0.1:2222 的 sshd，
// 带 pty 的 shell —— 也就是堡垒机会话的形状。客户端用本机的 rsync.exe。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client, type ClientChannel } from 'ssh2'
import type { RsyncBridgeChannel } from '../rsyncTransfer'
import { rsyncCandidates } from '../rsyncBridge'

export const SSH = process.env.BASTION_E2E_SSH
export const USER = process.env.BASTION_E2E_USER ?? 'bastiontest'
export const KEY = process.env.BASTION_E2E_KEY
export const REMOTE_BASE = process.env.BASTION_E2E_REMOTE_DIR ?? '/tmp/bastion-e2e/dst'
/** 重负载用例（大文件、多次重复）由这个开关控制，默认开着轻量版 */
export const HEAVY = process.env.BASTION_E2E_HEAVY === '1'

export function localRsync(): string | undefined {
  for (const c of rsyncCandidates(process.platform, process.env)) {
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c
    } else {
      return c // 交给 PATH
    }
  }
  return undefined
}

export const RSYNC = localRsync()

export const CAN_RUN = Boolean(SSH && KEY && fs.existsSync(KEY as string) && RSYNC)
export const SKIP = CAN_RUN ? false : '没搭测试台（见 tools/rsync-e2e/setup-wsl.sh），或本机没有 rsync'

export interface Rig {
  client: Client
  stream: ClientChannel
  /** 把 shell 的输出接到这里（同步结束后用它验证"会话还能用"） */
  setSink(fn: ((d: Buffer) => void) | null): void
  exec(cmd: string): Promise<string>
  /** 带 stdin 的 exec（用来把一段数据写进远端，比如造一个"已传了一半"的文件） */
  execWithInput(cmd: string, input: Buffer): Promise<string>
  sftpRead(p: string): Promise<Buffer>
  sftpList(p: string): Promise<string[]>
  close(): void
}

/** 连上测试台，开一个带 pty 的 shell */
export function connectRig(): Promise<Rig> {
  const [host, portStr] = (SSH ?? '').split(':')
  const client = new Client()
  return new Promise<Rig>((resolve, reject) => {
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let sink: ((d: Buffer) => void) | null = null
        stream.on('data', (d: Buffer) => {
          if (sink) sink(d)
        })
        const rig: Rig = {
          client,
          stream,
          setSink(fn) {
            sink = fn
          },
          execWithInput(cmd: string, input: Buffer) {
            return new Promise<string>((res, rej) => {
              client.exec(cmd, (e, s) => {
                if (e) {
                  rej(e)
                  return
                }
                let out = ''
                s.on('data', (d: Buffer) => (out += d.toString('utf8')))
                s.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
                s.on('close', () => res(out))
                s.end(input)
              })
            })
          },
          exec(cmd: string) {
            return new Promise<string>((res, rej) => {
              client.exec(cmd, (e, s) => {
                if (e) {
                  rej(e)
                  return
                }
                let out = ''
                s.on('data', (d: Buffer) => (out += d.toString('utf8')))
                s.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
                s.on('close', () => res(out))
              })
            })
          },
          sftpRead(p: string) {
            return new Promise<Buffer>((res, rej) => {
              client.sftp((e, sftp) => {
                if (e) {
                  rej(e)
                  return
                }
                sftp.readFile(p, (e2, data) => {
                  sftp.end()
                  if (e2) rej(e2)
                  else res(data)
                })
              })
            })
          },
          sftpList(p: string) {
            return new Promise<string[]>((res, rej) => {
              client.sftp((e, sftp) => {
                if (e) {
                  rej(e)
                  return
                }
                sftp.readdir(p, (e2, list) => {
                  sftp.end()
                  if (e2) rej(e2)
                  else res(list.map((x) => x.filename))
                })
              })
            })
          },
          close() {
            try {
              stream.close()
            } catch {
              /* ignore */
            }
            client.end()
          }
        }
        resolve(rig)
      })
    })
    client.on('error', reject)
    client.connect({
      host,
      port: Number(portStr || 22),
      username: USER,
      privateKey: fs.readFileSync(KEY as string),
      readyTimeout: 10000
    })
  })
}

/**
 * 把 ssh2 的 shell 通道包成桥要的接口。
 * 这里**模拟扩展里 BastionTerminal 的独占语义**：已被占用时 acquire 返回 false
 * （这样"会话正忙"那条用例才有意义），release 之后可以把输出接到别处。
 */
export function channelOf(rig: Rig): RsyncBridgeChannel {
  let acquired = false
  return {
    acquire(handlers) {
      if (acquired) return false
      acquired = true
      rig.setSink(handlers.onData)
      return true
    },
    release() {
      acquired = false
      rig.setSink(null)
    },
    write(d: Buffer) {
      rig.stream.write(d)
    },
    signal(name: string) {
      // 实测 OpenSSH 不认客户端发的 signal 请求 —— 这里照样转发，只为保证代码路径被走到
      // （真正让远端收场的是客户端侧 --timeout）
      rig.stream.signal(name)
    }
  }
}

/** 等远端 shell 的提示符出来（桥的过滤器容忍前导噪声，这里只是别抢跑） */
export function waitShellReady(_rig: Rig, ms = 900): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface FakeToken {
  onCancellationRequested(cb: () => void): void
  cancel(): void
}

export function token(): FakeToken {
  let cb: (() => void) | null = null
  return {
    onCancellationRequested(f) {
      cb = f
    },
    cancel() {
      if (cb) cb()
    }
  }
}

/** 造一个本地源目录（默认：a.txt + sub/b.txt） */
export function tmpSrc(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-e2e-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello from windows\n')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'nested file\n')
  return dir
}

/** 造一个指定大小的随机二进制文件，返回 [路径, sha256] */
export function randomFile(dir: string, name: string, bytes: number): { file: string; sha256: string } {
  const crypto = require('crypto') as typeof import('crypto')
  const buf = crypto.randomBytes(bytes)
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  return { file, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
}

export function sha256(buf: Buffer): string {
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 单引号包住，供远端 shell 用（文件名里可能有空格/引号） */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 把远端文件读回来校验。
 *
 * 优先 sftp，但**不依赖它**：sftp-server 的位置各发行版不同（RHEL 系在 /usr/libexec/…），
 * 精简 sshd 配置里没配对就整条 sftp 都不可用 —— 实测在 AlmaLinux 上就是这么踩到的
 * （报 127，看起来像"传输失败"，其实是校验手段不可用）。退回 `base64` over exec 更稳。
 */
export async function readRemote(rig: Rig, p: string): Promise<Buffer> {
  try {
    return await rig.sftpRead(p)
  } catch {
    const out = await rig.exec(`base64 -w0 ${q(p)} 2>/dev/null || base64 ${q(p)}`)
    const b64 = out.replace(/\s+/g, '')
    if (b64) return Buffer.from(b64, 'base64')
    // ⚠️ 0 字节文件的 base64 输出本来就是空的 —— 不能当成"读不到"（踩过）。
    // 用大小确认它确实存在：
    const size = (await rig.exec(`wc -c < ${q(p)} 2>/dev/null`)).trim()
    if (size === '0') return Buffer.alloc(0)
    throw new Error(`读不到远端文件：${p}（sftp 与 base64 都失败，大小=${JSON.stringify(size)}）`)
  }
}

/** 列远端目录（同样不依赖 sftp） */
export async function listRemote(rig: Rig, p: string): Promise<string[]> {
  try {
    return await rig.sftpList(p)
  } catch {
    const out = await rig.exec(`ls -1 ${q(p)}`)
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  }
}
