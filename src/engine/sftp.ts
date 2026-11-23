/**
 * CLI 宿主的 SFTP 通道（无头版）。
 *
 * 与扩展的 `terminal.ts#openSftp` 是同一套做法，教训也抄过来：
 *   - **每次传输新开一个 sftp 通道**（复用缓存通道会在断线后永远等不到回调 —— 7.4KB 那个坑）
 *   - 开通道有 15s 超时（ssh2 在死连接上不回调）
 *   - 用完 `end()`（撞 MaxSessions 的问题就是这么消失的）
 *
 * `fastPut` / `fastGet` 优先（ssh2 自带并发分片，真机快很多）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import type { SftpLike } from '../core/sftpTransfer'

export const SFTP_OPEN_TIMEOUT_MS = 15_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} 超时（${Math.round(ms / 1000)}s）`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

export interface SftpHandle {
  sftp: SftpLike
  close: () => void
}

/** 把 ssh2 的 SFTPWrapper 包成 core 要的 Promise 接口 */
function wrapSftp(raw: SFTPWrapper): SftpLike {
  return {
    stat: (p) =>
      new Promise((resolve, reject) =>
        raw.stat(p, (e, s) =>
          e
            ? reject(e)
            : resolve(s as { size: number; mtime?: number; mode?: number; isDirectory?: () => boolean })
        )
      ),
    createReadStream: (p, opts) => raw.createReadStream(p, opts as never) as unknown as NodeJS.ReadableStream,
    createWriteStream: (p, opts) =>
      raw.createWriteStream(p, opts as never) as unknown as NodeJS.WritableStream,
    mkdir: (p) =>
      new Promise<void>((resolve, reject) =>
        raw.mkdir(p, { mode: 0o755 }, (e) => (e ? reject(e) : resolve()))
      ),
    realpath: (p) => new Promise((resolve, reject) => raw.realpath(p, (e, r) => (e ? reject(e) : resolve(r)))),
    unlink: (p) => new Promise<void>((resolve, reject) => raw.unlink(p, (e) => (e ? reject(e) : resolve()))),
    rename: (a, b) =>
      new Promise<void>((resolve, reject) => raw.rename(a, b, (e) => (e ? reject(e) : resolve()))),
    fastPut: (localPath, remotePath, opts) =>
      new Promise<void>((resolve, reject) =>
        raw.fastPut(localPath, remotePath, opts ?? {}, (e) => (e ? reject(e) : resolve()))
      ),
    fastGet: (remotePath, localPath, opts) =>
      new Promise<void>((resolve, reject) =>
        raw.fastGet(remotePath, localPath, opts ?? {}, (e) => (e ? reject(e) : resolve()))
      )
  }
}

/** 开一个 sftp 通道（每次传输都新开；调用方负责 close） */
export function openSftp(client: Client): Promise<SftpHandle> {
  return withTimeout(
    new Promise<SftpHandle>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err || !sftp) {
          reject(err ?? new Error('打开 sftp 通道失败'))
          return
        }
        resolve({
          sftp: wrapSftp(sftp),
          close: () => {
            try {
              sftp.end()
            } catch {
              /* ignore */
            }
          }
        })
      })
    }),
    SFTP_OPEN_TIMEOUT_MS,
    '打开 SFTP 通道'
  )
}

/** 下载落盘目录（CLI：当前目录下的 downloads —— 规则简单可预期） */
export function defaultDownloadDir(): string {
  const dir = path.join(process.cwd(), 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
