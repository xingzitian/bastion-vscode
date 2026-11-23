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
import {
  appendKnownHost,
  defaultKnownHostsFile,
  sha256Fingerprint,
  verifyHostKey,
  type HostKeyPolicy
} from './knownHosts'
import type { EngineProfile } from './profiles'
import type { ShellChannel } from './session'

export interface ConnectOptions {
  /** 密码：只在内存里用（CLI 交互输入）；密钥认证时不需要 */
  password?: string
  /** 主机指纹策略（默认 known_hosts：首次记录，之后必须一致） */
  hostKey?: HostKeyPolicy
  /** known_hosts 文件路径（默认 ~/.ssh/known_hosts） */
  knownHostsFile?: string
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
    hostVerifier: (key: Buffer) => {
      const policy = opts.hostKey ?? 'known_hosts'
      const file = opts.knownHostsFile ?? defaultKnownHostsFile()
      if (policy === 'off') {
        log(`主机指纹（sha256）：${sha256Fingerprint(key)} —— --host-key=off，不校验`)
        return true
      }
      let text = ''
      try {
        text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      } catch (e) {
        log(`读 known_hosts 失败（${file}）：${(e as Error).message}`)
      }
      const r = verifyHostKey(text, profile.host, profile.port, key)
      if (r.status === 'match') {
        log(`主机指纹匹配 known_hosts（sha256:${r.fingerprint}）`)
        return true
      }
      if (r.status === 'unknown') {
        if (policy === 'strict') {
          log(`主机不在 known_hosts 里（sha256:${r.fingerprint}）—— --host-key=strict 拒绝连接`)
          return false
        }
        log(
          `首次见到这台主机（sha256:${r.fingerprint}）。已按 TOFU 记录到 ${file}；` +
            `如果你没核对过指纹，请先人工确认`
        )
        const w = appendKnownHost(file, profile.host, profile.port, keyTypeOf(key), key)
        if (!w.ok) log(`记录 known_hosts 失败（不影响本次连接）：${w.error}`)
        return true
      }
      // mismatch / unsupported
      log(
        `⚠️ 主机指纹**不一致**！文件里记的是 ${(r.expectedTypes ?? []).join('/')}，` +
          `现在给的是 sha256:${r.fingerprint}。可能是中间人，也可能是对方换过 key —— 已拒绝连接。` +
          `确认无误后请手工删除 ${file} 里那台机器的记录再连。`
      )
      return false
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

/** 从公钥 blob 猜算法名（known_hosts 的第二列） */
function keyTypeOf(key: Buffer): string {
  const len = key.length >= 4 ? key.readUInt32BE(0) : 0
  const name = len > 0 && len < 64 ? key.subarray(4, 4 + len).toString('ascii') : ''
  return name || 'ssh-ed25519'
}