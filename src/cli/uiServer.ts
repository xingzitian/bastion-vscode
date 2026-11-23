/**
 * 「界面后端」：把桌面版 React 界面要的 HTTP + WebSocket 协议，实现在 CLI 进程里。
 *
 * 为什么需要它：桌面界面（React，跑在 WebView2 里）不是直接调用 `core`，而是通过
 * `ws://127.0.0.1:18090/ws` + `/api/*` 跟 Go 后端说话。要做到「界面不动、引擎换掉」，
 * 就必须由这个进程说同一套协议。
 *
 * 协议（与 Go `server.go` / `shim.js` 对齐，2026-11-23 抄自源码）：
 *   ① 建连接：{type:'control', connId, host, port, user, password, key, passphrase}
 *   ② 开会话：{type:'connect', connId, cols, rows}  → 服务端回 {type:'ready'} 然后 {type:'data', data}
 *   ③ 输入/尺寸：{type:'input', data} / {type:'resize', cols, rows}
 *
 * 还没做的（Go 那边有）：文件上传、端口转发、MFA 交互、DPAPI 存密码 —— 这些先明确拒绝，
 * 不假装成功。
 */

import * as http from 'node:http'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { connectProfile } from '../engine/connect'
import { EngineSession } from '../engine/session'
import { loadProfiles } from '../engine/profiles'
import { openSftp } from '../engine/sftp'
import { ZmodemSessionController } from '../core/zmodem'
import { NodeFsZmodemIo } from '../core/zmodemIo'
import { buildDesktopAiAccessView } from '../core/aiAccessView'
import { BINDINGS_FILE, loadBindings, saveBindings, unbind } from '../core/sessionBindings'
import { configFilePath } from '../core/config'
import { pushPath, type TransferSession } from '../core/transferPath'
import { putFile, getFile, resolveRemoteDir } from '../core/sftpTransfer'
import type { EngineProfile } from '../engine/profiles'
import type { Client } from 'ssh2'

export interface UiServerOptions {
  port?: number
  /** MCP 端点信息（/api/mcp-info 用） */
  mcp?: { url: string; token: string; port: number; portFallback: boolean; file: string }
  log?: (msg: string) => void
  /** 未迁移的接口反向代理到这里（Go 的 18091；保证界面功能不断） */
  proxyBase?: string
  /** 界面开的会话注册进宿主（MCP 才能 listSessions/exec 到它）；返回会话 id */
  onSession?: (s: { profile: EngineProfile; session: EngineSession; client: Client }) => string
  /** 指纹策略 */
  hostKey?: 'known_hosts' | 'strict' | 'off'
  knownHostsFile?: string
  /** 当前会话表（/api/ai-access 的会话行；界面开的会话也在里面） */
  hostSessions?: () => { id: string; name: string }[]
}

export interface UiServer {
  port: number
  close(): Promise<void>
}

interface UiConn {
  client: Client
  connId: string
  sessions: Set<EngineSession>
}

/**
 * 问一次这条会话的 shell「现在在哪个目录」。
 *
 * 为什么非得问：SFTP 没有 cwd 的概念（`realpath('.')` 给的是登录用户的 home）。
 * 旧版上传是 rz 在 shell 里跑，文件天然落在用户 `cd` 到的目录；换成 SFTP 之后
 * 不问就等于把文件扔到 home —— `cd /opt/app` 再拖文件会传错地方（真机回归）。
 *
 * 代价：这条命令会在这条会话的终端里留下一行可见的 `pwd`。用户点了"上传"，
 * 看到一行 pwd 比"文件传到别处去了"要好得多。
 */
async function shellCwd(session: EngineSession): Promise<string> {
  try {
    const r = await session.exec('pwd', { maxMs: 8000, quietMs: 1500 })
    const line = r.text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.startsWith('/'))
      .pop()
    return line ?? ''
  } catch {
    return ''
  }
}

/**
 * 桌面终端里 `sz` 下来的文件存哪儿。
 *
 * 用 `~/Downloads/BastionShell`（与扩展侧人工下载同一处），而不是 `process.cwd()/downloads`：
 * 桌面进程的 cwd 可能是 exe 所在目录（Program Files 下根本不可写）。
 * 环境变量可以改；**同步返回**，绝不弹窗 —— ZMODEM 握手等不起对话框。
 */
function desktopDownloadDir(): string {
  const base = process.env.BASTIONSHELL_DOWNLOAD_DIR?.trim() || path.join(os.homedir(), 'Downloads', 'BastionShell')
  try {
    fs.mkdirSync(base, { recursive: true })
  } catch {
    /* 建不了就在打开文件时再报错 */
  }
  return base
}

/** 把「界面会话 + 已认证连接」适配成 core 传输层要的会话（上传/下载复用同一套） */
function transferSession(session: EngineSession, client: Client): TransferSession {
  return {
    name: 'ui',
    exec: async (cmd) => (await session.exec(cmd, { maxMs: 5 * 60_000 })).text,
    exitCode: () => undefined,
    sftpAllowed: () => true,
    sftpPut: async (localPath, remoteDir) => {
      const h = await openSftp(client)
      try {
        const dir = await resolveRemoteDir(h.sftp, remoteDir)
        const r = await putFile(h.sftp, localPath, dir, {})
        return r.ok
          ? { ok: true, remotePath: r.remotePath, message: 'ok', bytes: r.bytes, skipped: r.skipped, resumed: r.resumed }
          : { ok: false, message: r.error ?? '未知原因' }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      } finally {
        h.close()
      }
    },
    sftpGet: async (remotePath, localDir) => {
      const h = await openSftp(client)
      try {
        const r = await getFile(h.sftp, remotePath, localDir, {})
        return r.ok
          ? { ok: true, localPath: r.localPath, message: 'ok', bytes: r.bytes, resumed: r.resumed }
          : { ok: false, message: r.error ?? '未知原因' }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      } finally {
        h.close()
      }
    },
    overwriteMode: () => 'skip',
    log: () => undefined
  }
}

export async function startUiServer(opts: UiServerOptions = {}): Promise<UiServer> {
  const log = opts.log ?? (() => undefined)
  const conns = new Map<string, UiConn>()
  const forwards = new Map<string, { server: net.Server; sockets: Set<net.Socket> }>()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // CORS：界面与后端不同端口
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const readBody = (r: http.IncomingMessage): Promise<string> =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        r.on('error', reject)
      })
    // 档案：界面直接渲染 name/host/port
    if (url.pathname === '/api/profiles' && req.method === 'GET') {
      json(
        200,
        loadProfiles().map((p) => ({
          id: p.name,
          name: p.name,
          host: p.host,
          port: p.port,
          username: p.username,
          authMethod: p.authMethod,
          mode: p.mode,
          privateKeyPath: p.privateKeyPath
        }))
      )
      return
    }
    if (url.pathname === '/api/mcp-info' && req.method === 'GET') {
      const m = opts.mcp
      json(200, {
        url: m?.url ?? '',
        port: m?.port ?? 0,
        portFallback: m?.portFallback ?? false,
        configPath: m?.file ?? '',
        enabled: !!m,
        hint: 'token 不在这里返回：见 configPath 指向的文件'
      })
      return
    }
    // 「AI 访问」页面：令牌/绑定/会话都由这个进程（= core）出 —— Go 的 MCP 层已经删了。
    if (url.pathname === '/api/ai-access' && req.method === 'GET') {
      json(
        200,
        buildDesktopAiAccessView({
          endpoint: opts.mcp?.url ?? '',
          token: opts.mcp?.token ?? '',
          bindings: loadBindings(),
          sessions: opts.hostSessions?.() ?? [],
          bindingsFile: configFilePath(BINDINGS_FILE)
        })
      )
      return
    }
    if (url.pathname === '/api/ai-access/unbind' && req.method === 'POST') {
      readBody(req)
        .then((body) => {
          let p: { clientId?: unknown; alias?: unknown; sessionId?: unknown } = {}
          try {
            p = JSON.parse(body || '{}') as typeof p
          } catch {
            json(400, { error: 'bad json' })
            return
          }
          const clientId = typeof p.clientId === 'string' && p.clientId.trim() ? p.clientId.trim() : 'default'
          const alias = typeof p.alias === 'string' ? p.alias : undefined
          const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined
          const doc = loadBindings()
          const ok = unbind(doc, clientId, { alias, sessionId })
          if (ok) saveBindings(doc)
          json(200, { ok })
        })
        .catch((e: unknown) => json(400, { error: (e as Error).message }))
      return
    }
    // 还没迁进 core 的接口：有 proxyBase 就原样转发给 Go（DPAPI 存密码、上传、转发、系统对话框），
    // 没有就明确 501 —— 两种都比"假装成功"好。
    //
    // `/api/profiles` 在这里只兜**写**操作：GET 上面已经由 core 直接回了，
    // 但界面的「加机器/改机器/删机器」还是走 Go 的档案存储（同一份 profiles.jsonc），
    // 不放进来就会 404 —— 界面能看不能改。
    const proxied = [
      '/api/upload',
      '/api/forwards',
      '/api/quick-commands',
      '/api/secret',
      '/api/pick-files',
      '/api/shell',
      '/api/profiles'
    ]
    if (proxied.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
      if (!opts.proxyBase) {
        json(501, { error: `CLI 后端暂未实现 ${url.pathname}（没有配置 proxyBase）` })
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const target = new URL(url.pathname + url.search, opts.proxyBase)
        const up = http.request(
          target,
          { method: req.method, headers: { ...req.headers, host: target.host } },
          (res2) => {
            res.writeHead(res2.statusCode ?? 502, res2.headers)
            res2.pipe(res)
          }
        )
        up.on('error', (e) => json(502, { error: `代理到 ${opts.proxyBase} 失败：${e.message}` }))
        if (chunks.length) up.write(Buffer.concat(chunks))
        up.end()
      })
      return
    }
    json(404, { error: `没有这个接口：${url.pathname}` })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => void handleWs(ws))
  })

  async function handleWs(ws: WebSocket): Promise<void> {
    const send = (m: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }
    let conn: UiConn | undefined
    let session: EngineSession | undefined
    let closed = false
    ws.on('close', () => {
      closed = true
      session?.close()
      if (conn) {
        conn.sessions.delete(session as EngineSession)
        if (conn.sessions.size === 0) {
          try {
            conn.client.end()
          } catch {
            /* ignore */
          }
          conns.delete(conn.connId)
        }
      }
    })

    ws.on('message', (raw) => {
      let m: Record<string, unknown>
      try {
        m = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      const type = String(m.type ?? '')
      const str = (k: string): string => (typeof m[k] === 'string' ? (m[k] as string) : '')

      if (type === 'control') {
        const connId = str('connId')
        const host = str('host')
        if (!connId || !host) {
          send({ type: 'error', message: 'control 需要 connId 和 host' })
          return
        }
        const profile: EngineProfile = {
          name: `${str('user')}@${host}`,
          host,
          port: Number(m.port) || 22,
          username: str('user') || 'root',
          authMethod: str('key') ? 'key' : 'password',
          privateKeyPath: str('key') || undefined,
          mode: 'direct'
        }
        connectProfile(profile, {
          password: str('password') || undefined,
          log,
          hostKey: opts.hostKey ?? 'known_hosts',
          knownHostsFile: opts.knownHostsFile
        })
          .then((c) => {
            if (closed) {
              c.client.end()
              return
            }
            conn = { client: c.client, connId, sessions: new Set() }
            conns.set(connId, conn)
            log(`界面连接已建立：${profile.name}（${c.readyMs}ms）`)
            send({ type: 'connected', connId })
          })
          .catch((e: unknown) => send({ type: 'error', message: (e as Error).message }))
        return
      }

      if (type === 'connect') {
        const connId = str('connId')
        const hit = conns.get(connId)
        if (!hit) {
          send({ type: 'error', message: `没有这条连接：${connId}（先发 control）` })
          return
        }
        hit.client.shell(
          { term: 'xterm-256color', cols: Number(m.cols) || 100, rows: Number(m.rows) || 30 },
          (err, chan) => {
            if (err || !chan) {
              send({ type: 'error', message: err?.message ?? '开会话失败' })
              return
            }
            const s = new EngineSession(
              connId,
              {
                write: (d: string | Buffer) => chan.write(d),
                on: (ev: 'data' | 'close', cb: (...a: never[]) => void) => chan.on(ev, cb as never),
                setWindow: (rows: number, cols: number) => {
                  try {
                    chan.setWindow(rows, cols, 0, 0)
                  } catch {
                    /* ignore */
                  }
                }
              },
              { log }
            )
            session = s
            hit.sessions.add(s)
            // 注册进宿主：MCP 的 listSessions/exec 才能看到界面开的这条会话（统一核心）
            let sid = connId
            // ZMODEM 由 core 的控制器接管这条会话的数据流：
            //   远端 `sz 文件名` → 自动收下来（存到 ~/Downloads/BastionShell），其余字节照常给终端。
            // 为什么要在 CLI 里做：桌面终端以前靠 Go 内嵌的 trzsz，⑤ 删传输层时一起没了；
            // 扩展侧一直是这个控制器（`src/terminal.ts`），搬过来就是"同一份语义"。
            const zc = new ZmodemSessionController(
              `ui-${connId}-${Date.now()}`,
              (d) => s.write(d),
              (d) => send({ type: 'data', data: d.toString('utf8') }),
              new NodeFsZmodemIo(
                () => null,
                // 下载目录：同步返回、绝不弹窗（弹窗会把 ZMODEM 握手拖死，见 ZmodemIo 注释）
                () => desktopDownloadDir()
              )
            )
            zc.on('event', (p: unknown) => {
              send({ type: 'zmodem', payload: p })
              // 远端自己敲了 `rz`：桌面这边没有"要发哪些文件"的入口（拖文件走的是 SFTP 上传），
              // 不主动收尾的话这条会话会一直等着，终端看起来像卡住。明确说一句再中止。
              const ev = p as { type?: string; message?: string }
              if (ev.type === 'info' && typeof ev.message === 'string' && ev.message.includes('rz 接收模式')) {
                setTimeout(() => {
                  zc.abortAll()
                  send({
                    type: 'zmodem',
                    payload: { sessionId: sid, transferId: 'rz-manual', direction: 'send', type: 'info', message: '桌面里上传请用「上传」按钮（走 SFTP）；rz 的交互式选文件这里没有入口，已中止本次握手' }
                  })
                }, 1200)
              }
            })
            s.onData((d) => zc.consume(d))
            s.onClose(() => {
              zc.destroy()
              send({ type: 'session:closed' })
            })
            if (opts.onSession) {
              try {
                sid = opts.onSession({
                  profile: {
                    name: `${str('user') || 'ui'}@界面会话`,
                    host: 'ui',
                    port: 22,
                    username: str('user') || 'ui',
                    authMethod: 'password',
                    mode: 'direct'
                  },
                  session: s,
                  client: hit.client
                })
              } catch (e) {
                log(`注册界面会话失败（终端仍可用）：${(e as Error).message}`)
              }
            }
            log(`界面会话已打开：${connId}（注册为 ${sid}）`)
            send({ type: 'ready', connId, sessionId: sid })
          }
        )
        return
      }

      if (type === 'input') {
        session?.write(str('data'))
        return
      }
      if (type === 'resize') {
        session?.resize(Number(m.cols) || 100, Number(m.rows) || 30)
        return
      }
      if (type === 'upload') {
        const paths = Array.isArray(m.paths) ? (m.paths as string[]) : []
        if (!session || !conn) {
          send({ type: 'upload:error', message: '还没有会话' })
          return
        }
        const ts = transferSession(session, conn.client)
        void (async () => {
          try {
            // 落点必须是**用户 cd 到的那个目录**，不是登录用户的 home。
            // 旧版是 rz 在 shell 里跑，天然落在当前目录；换成 SFTP 之后
            // `realpath('.')` 只会给 home，于是 `cd /opt/app` 后拖文件会传错地方（2026-11-23 回归）。
            // 代价：这次 `pwd` 会在这条会话的终端里留下可见的一行 —— 换来的是文件落到对的地方。
            const cwd = await shellCwd(session)
            if (cwd) log(`界面上传落到当前目录：${cwd}`)
            for (const p of paths) {
              const r = await pushPath({ localPath: p, session: ts, remoteDir: cwd || undefined })
              if (!r.ok) throw new Error(`${p}: ${r.message}`)
              log(`界面上传完成：${r.remotePath}`)
            }
            send({ type: 'upload:done' })
          } catch (e) {
            send({ type: 'upload:error', message: (e as Error).message })
          }
        })()
        return
      }
      if (type === 'forward:start') {
        if (!conn) {
          send({ type: 'forward:error', id: str('id'), message: '还没有连接' })
          return
        }
        const id = str('id') || `fw-${Math.random().toString(36).slice(2, 8)}`
        const localPort = Number(m.localPort) || 0
        const localHost = str('localHost') || '127.0.0.1'
        const remoteHost = str('remoteHost')
        const remotePort = Number(m.remotePort) || 0
        const sockets = new Set<net.Socket>()
        const c = conn.client
        const server = net.createServer((sock) => {
          sockets.add(sock)
          sock.on('close', () => sockets.delete(sock))
          sock.on('error', () => sockets.delete(sock))
          c.forwardOut('127.0.0.1', sock.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
            if (err) {
              log(`转发失败 ${id}：${err.message}`)
              sock.destroy()
              return
            }
            sock.pipe(stream).pipe(sock)
            stream.on('close', () => sock.destroy())
            sock.on('close', () => stream.close())
          })
        })
        server.once('error', (e) => send({ type: 'forward:error', id, message: e.message }))
        server.listen(localPort, localHost, () => {
          forwards.set(id, { server, sockets })
          log(`转发已启动 ${id}：${localHost}:${localPort} → ${remoteHost}:${remotePort}`)
          send({ type: 'forward:started', id })
        })
        return
      }
      if (type === 'forward:stop') {
        const id = str('id')
        const fw = forwards.get(id)
        if (fw) {
          for (const s of fw.sockets) s.destroy()
          fw.server.close()
          forwards.delete(id)
        }
        send({ type: 'forward:stopped', id })
        return
      }
    })
  }

  // 端口偶尔还被上一个进程占着（桌面 exe 被强杀后，子进程要靠父进程守卫退出，最多几秒）。
  // 这种情况必须**重试**：界面只认 18090，绑不上就等于界面打不开；
  // 以前这里是直接抛错，桌面于是退回 Go 后端 —— 而 Go 的 /ws 已经删了，退回只会更糊涂。
  const bindPort = opts.port ?? 18090
  let attempt = 0
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onOk)
          reject(e)
        }
        const onOk = (): void => {
          server.removeListener('error', onErr)
          resolve()
        }
        server.once('error', onErr)
        server.once('listening', onOk)
        server.listen(bindPort, '127.0.0.1')
      })
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      attempt += 1
      if (code !== 'EADDRINUSE' || attempt >= 12) throw e
      log(`端口 ${bindPort} 还被占着，等 500ms 再试（第 ${attempt} 次）`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  log(`界面后端已启动：http://127.0.0.1:${port}（/api/* + /ws）`)

  return {
    port,
    async close() {
      for (const c of conns.values()) {
        for (const s of c.sessions) s.close()
        try {
          c.client.end()
        } catch {
          /* ignore */
        }
      }
      conns.clear()
      await new Promise<void>((r) => wss.close(() => r()))
      await new Promise<void>((r) => server.close(() => r()))
    }
  }
}
