#!/usr/bin/env node
/**
 * BastionShell CLI（A1：终端 + 单条执行；MCP 在 A2 接）。
 *
 * 用法：
 *   bastionshell list                       列出档案
 *   bastionshell run <档案> --exec "命令"    连一次、跑一条、打印输出与退出码（给测试/脚本用）
 *   bastionshell connect <档案>             交互式：裸模式直通本地终端
 *
 * 退出：`Ctrl-]`（telnet 习惯）。日志一律写 stderr —— stdout 是终端字节流，不能混。
 */

import { connectProfile } from '../engine/connect'
import { EngineSession } from '../engine/session'
import { findProfile, loadProfiles, profilesFilePath } from '../engine/profiles'

const log = (msg: string): void => {
  process.stderr.write(`[bastion] ${msg}\n`)
}

function usage(): void {
  process.stderr.write(
    [
      '用法：',
      '  bastionshell list',
      '  bastionshell run <档案> --exec "命令"   （非交互，打印输出与退出码）',
      '  bastionshell connect <档案>            （交互式终端；Ctrl-] 退出）',
      ''
    ].join('\n')
  )
}

/** 交互式读一次密码（不回显）：只在内存里用，不落盘 */
function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    const wasRaw = stdin.isTTY ? stdin.isRaw : false
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const onData = (d: Buffer): void => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stderr.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003') {
          cleanup()
          process.stderr.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        buf += ch
      }
    }
    const cleanup = (): void => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}

async function ensurePassword(profileName: string, needPassword: boolean): Promise<string | undefined> {
  if (!needPassword) return undefined
  return readPassword(`档案「${profileName}」的密码（只留在内存）：`)
}

async function cmdList(): Promise<number> {
  const list = loadProfiles()
  if (list.length === 0) {
    process.stderr.write(`没有档案：${profilesFilePath()}\n`)
    return 1
  }
  for (const p of list) {
    process.stdout.write(
      `${p.name}\t${p.username}@${p.host}:${p.port}\t${p.mode}\t${p.authMethod === 'key' ? '密钥' : '密码'}\n`
    )
  }
  return 0
}

async function cmdRun(name: string, command: string): Promise<number> {
  const profile = findProfile(name)
  if (!profile) {
    process.stderr.write(`找不到档案「${name}」（文件：${profilesFilePath()}）\n`)
    return 2
  }
  const password = await ensurePassword(profile.name, profile.authMethod !== 'key')
  const conn = await connectProfile(profile, { password, log })
  const session = new EngineSession(profile.name, conn.channel, { log })
  try {
    // 先等 shell 就绪：否则登录 banner 会被算进这次命令的输出
    await session.waitShellReady()
    const r = await session.exec(command, { maxMs: 5 * 60_000 })
    process.stdout.write(r.text + (r.text.endsWith('\n') ? '' : '\n'))
    if (!r.markerSeen) log('没等到结束哨兵（命令可能仍在跑）')
    log(`退出码=${r.exitCode ?? '未知'}｜耗时 ${Math.round(r.elapsedMs / 1000)}s`)
    return r.exitCode ?? (r.markerSeen ? 0 : 1)
  } finally {
    session.close()
    conn.client.end()
  }
}

async function cmdConnect(name: string): Promise<number> {
  const profile = findProfile(name)
  if (!profile) {
    process.stderr.write(`找不到档案「${name}」（文件：${profilesFilePath()}）\n`)
    return 2
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('connect 需要交互式终端（stdin 不是 TTY）。脚本里请用 run。\n')
    return 2
  }
  const password = await ensurePassword(profile.name, profile.authMethod !== 'key')
  log(`连接 ${profile.username}@${profile.host}:${profile.port} …`)
  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 30
  const conn = await connectProfile(profile, { password, log, cols, rows })
  const session = new EngineSession(profile.name, conn.channel, { log })
  // 先把登录 banner 收完再进交互（否则它会刷在用户第一屏的最上面，还会被当成输出）
  await session.waitShellReady()
  log(`已连上（${conn.readyMs}ms）。Ctrl-] 退出。`)

  const stdout = process.stdout
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()

  // 远端 → 本地（原始字节，不加工）
  session.onData((d) => stdout.write(d))

  // 本地 → 远端；Ctrl-] 退出
  const onStdin = (d: Buffer): void => {
    if (d.length === 1 && d[0] === 0x1d) {
      session.close()
      conn.client.end()
      restore()
      log('已退出')
      process.exit(0)
    }
    session.write(d)
  }
  stdin.on('data', onStdin)

  const onResize = (): void => session.resize(stdout.columns || 120, stdout.rows || 30)
  process.on('SIGWINCH', onResize)
  onResize()

  const restore = (): void => {
    process.removeListener('SIGWINCH', onResize)
    stdin.removeListener('data', onStdin)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }

  session.onClose(() => {
    restore()
    log('远端会话已关闭')
    conn.client.end()
    process.exit(0)
  })

  return await new Promise<number>(() => {
    /* 直到 Ctrl-] / 远端关闭 */
  })
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage()
    return cmd ? 0 : 1
  }
  if (cmd === 'list') return cmdList()
  if (cmd === 'run') {
    const name = rest[0]
    const i = rest.indexOf('--exec')
    const command = i >= 0 ? rest[i + 1] : ''
    if (!name || !command) {
      usage()
      return 2
    }
    return cmdRun(name, command)
  }
  if (cmd === 'connect') {
    const name = rest[0]
    if (!name) {
      usage()
      return 2
    }
    return cmdConnect(name)
  }
  usage()
  return 2
}

// 入口守卫：只有**直接运行**这个文件时才执行 main()。
// 否则任何 require 它的检查（scripts/check-load.mjs 会把 out/ 里每个模块都加载一遍）
// 都会把 CLI 真跑起来 → 打印用法 → process.exit(1)，把检查本身弄挂。
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`[bastion] 失败：${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
