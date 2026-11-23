/**
 * 无头 SSH 连接（CLI 用）。
 *
 * 只做三件事：连上、开一条 shell 通道、把 ssh2 的通道包成 `ShellChannel`。
 * 不做堡垒机菜单自动化（那是下一步）、不做凭据持久化。
 *
 * ⚠️ 已知缺口（见 docs/cli-host.md §10）：**host key 不校验** ——
 * 目前只打印指纹并接受。这是安全债，正式发布前必须换成 known_hosts 校验。
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { describeDisconnect } from '../core/disconnect'
import type { EngineProfile } from './profiles'
import type { ShellChannel } from './session'

export interface ConnectOptions {
  /** 密码：只在内存里用（CLI 交互输入）；密钥认证时不需要 */
  password?: string
  /** 日志（写 stderr，不能污染 stdout 的终端流） */
  log?: (msg: string) => void
  cols?: number
  rows?: number
}

export interface ConnectedSession {
  client: Client
  channel: ShellChannel
  /** 握手耗时（给人看） */
  readyMs: number
}

/** ssh2 的 ClientChannel → ShellChannel（只暴露我们需要的部分） */
function wrapChannel(chan: ClientChannel): ShellChannel {
  return {
    write: (d) => chan.write(d),
    on: (ev: 'data' | 'close', cb: (...args: never[]) => void) => chan.on(ev, cb as never),
    setWindow: (rows, cols) => {
      try {
        chan.setWindow(rows, cols, 0, 0)
      } catch {
        /* 通道可能已关 */
      }
    }
  }
}

export function connectProfile(profile: EngineProfile, opts: ConnectOptions = {}): Promise<ConnectedSession> {
  const log = opts.log ?? (() => undefined)
  const cfg: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 60_000,
    keepaliveInterval: 30_000,
    // ⚠️ 不校验 host key（见文件头）：只把指纹打到日志里，方便人工核对
    hostVerifier: (key: Buffer) => {
      const fp = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      log(`主机指纹（sha256）：${fp}  —— 目前**不校验**，请自行核对`)
      return true
    }
  }
  if (profile.authMethod === 'key') {
    if (!profile.privateKeyPath) throw new Error(`档案「${profile.name}」是密钥认证，但没写 privateKeyPath`)
    cfg.privateKey = fs.readFileSync(profile.privateKeyPath)
    if (opts.password) cfg.passphrase = opts.password
  } else {
    if (!opts.password) throw new Error('这个档案是密码认证：CLI 需要一次密码（不会落盘）')
    cfg.password = opts.password
  }

  return new Promise<ConnectedSession>((resolve, reject) => {
    const t0 = Date.now()
    const client = new Client()
    let settled = false
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        /* ignore */
      }
      reject(new Error(`${describeDisconnect(e)}｜${e.message}`))
    }

    client.on('error', fail)
    client.on('close', () => {
      if (!settled) fail(new Error('连接在建立过程中被关闭'))
    })
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: opts.cols ?? 120, rows: opts.rows ?? 30 }, (err, chan) => {
        if (err || !chan) {
          fail(err ?? new Error('开了 shell 通道失败'))
          return
        }
        settled = true
        resolve({ client, channel: wrapChannel(chan), readyMs: Date.now() - t0 })
      })
    })
    client.connect(cfg)
  })
}
