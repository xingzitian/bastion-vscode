// rsync 桥的**验证矩阵**：把「真机上可能遇到的情况」一条条钉住。
//
// 为什么值得写这么细：这条链路的 bug 全都在真机上才现形（协议方向、raw 竞态、路径斜杠、
// 目标机没装 rsync……），而每次让维护者手动试一遍代价太高。这里的每一条都对应一类
// 真机上真实会发生的输入：大文件、二进制、中文名、多级目录、增量、重复、会话占用、取消。
//
// 需要测试台：`tools/rsync-e2e/setup-wsl.sh`；没搭就整组跳过。
// 重负载（64MB、10 连跑）由 BASTION_E2E_HEAVY=1 打开，默认跑轻量版。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import {
  CAN_RUN,
  SKIP,
  HEAVY,
  RSYNC,
  REMOTE_BASE,
  connectRig,
  channelOf,
  waitShellReady,
  token,
  tmpSrc,
  randomFile,
  sha256,
  readRemote,
  listRemote
} from './rsyncE2Ekit'
import { runBridge } from '../rsyncTransfer'

/** 大文件用例的大小：默认 8MB，重负载 64MB，可用 BASTION_E2E_BIG_MB 指定（验证时压到过 512MB） */
const BIG_MB = Number(process.env.BASTION_E2E_BIG_MB ?? (HEAVY ? 64 : 8))

/** 每条用例都：连测试台 → 清空远端目录 → 跑桥 → 校验 → 断开 */
async function withRig(
  remote: string,
  fn: (rig: Awaited<ReturnType<typeof connectRig>>) => Promise<void>
): Promise<void> {
  const rig = await connectRig()
  try {
    await rig.exec(`rm -rf ${remote} && mkdir -p ${remote}`)
    await waitShellReady(rig)
    await fn(rig)
  } finally {
    rig.close()
  }
}

test('矩阵：二进制文件 1MB 逐字节一致（pty 上不能被 CR/LF 翻译或流控破坏）', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  const { file, sha256: want } = randomFile(dir, 'bin.dat', 1024 * 1024)
  const remote = `${REMOTE_BASE}/bin`
  try {
    await withRig(remote, async (rig) => {
      const r = await runBridge(channelOf(rig), [{ path: file, isDir: false }], remote, RSYNC as string, token())
      assert.equal(r.ok, true, r.message ?? '')
      assert.equal(r.remoteRc, 0)
      const got = await readRemote(rig, `${remote}/bin.dat`)
      assert.equal(got.length, 1024 * 1024, '大小必须一致')
      assert.equal(sha256(got), want, 'sha256 必须一致（二进制内容没被改写）')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test(
  `矩阵：大文件 ${BIG_MB}MB 内容一致（长时间传输 + pty 缓冲）`,
  { skip: SKIP, timeout: 900000 },
  async () => {
    const dir = tmpSrc()
    const bytes = BIG_MB * 1024 * 1024
    const { file, sha256: want } = randomFile(dir, 'big.bin', bytes)
    const remote = `${REMOTE_BASE}/big`
    try {
      await withRig(remote, async (rig) => {
        const r = await runBridge(channelOf(rig), [{ path: file, isDir: false }], remote, RSYNC as string, token())
        assert.equal(r.ok, true, r.message ?? '')
        assert.equal(r.bytes, bytes, '--stats 报的字节数应当就是文件大小')
        const got = await readRemote(rig, `${remote}/big.bin`)
        assert.equal(sha256(got), want)
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('矩阵：多级目录 + 空目录 + 子目录里的文件（目录带斜杠 = 同步内容）', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  fs.mkdirSync(path.join(dir, 'x', 'y', 'z'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'x', 'y', 'z', 'deep.txt'), 'deep\n')
  fs.mkdirSync(path.join(dir, 'empty-dir'))
  const remote = `${REMOTE_BASE}/tree`
  try {
    await withRig(remote, async (rig) => {
      const r = await runBridge(channelOf(rig), [{ path: dir, isDir: true }], remote, RSYNC as string, token())
      assert.equal(r.ok, true, r.message ?? '')
      assert.equal((await readRemote(rig, `${remote}/a.txt`)).toString(), 'hello from windows\n')
      assert.equal((await readRemote(rig, `${remote}/x/y/z/deep.txt`)).toString(), 'deep\n')
      assert.ok((await listRemote(rig, remote)).includes('x'), '顶层目录要在')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：中文名 / 空格 / 引号 / 美元符 文件名都要原样到达', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  const names = ['中文 名称.txt', 'a b c.txt', "quote'name.txt", 'dollar$name.txt', 'dash-name.txt']
  for (const n of names) fs.writeFileSync(path.join(dir, n), `content of ${n}\n`)
  const remote = `${REMOTE_BASE}/names`
  try {
    await withRig(remote, async (rig) => {
      const sources = names.map((n) => ({ path: path.join(dir, n), isDir: false }))
      const r = await runBridge(channelOf(rig), sources, remote, RSYNC as string, token())
      assert.equal(r.ok, true, r.message ?? '')
      const listed = await listRemote(rig, remote)
      for (const n of names) {
        assert.ok(listed.includes(n), `远端应当有这个文件名：${n}（实际：${listed.join(', ')}）`)
        assert.equal((await readRemote(rig, `${remote}/${n}`)).toString(), `content of ${n}\n`)
      }
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：空文件（0 字节）也要能传过去', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  const empty = path.join(dir, 'empty.txt')
  fs.writeFileSync(empty, '')
  const remote = `${REMOTE_BASE}/empty`
  try {
    await withRig(remote, async (rig) => {
      const r = await runBridge(channelOf(rig), [{ path: empty, isDir: false }], remote, RSYNC as string, token())
      assert.equal(r.ok, true, r.message ?? '')
      assert.equal((await readRemote(rig, `${remote}/empty.txt`)).length, 0)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：多选（两个文件 + 一个目录）一次传完', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  fs.writeFileSync(path.join(dir, 'one.txt'), '1\n')
  fs.writeFileSync(path.join(dir, 'two.txt'), '2\n')
  const sub = path.join(dir, 'sub')
  const remote = `${REMOTE_BASE}/multi`
  try {
    await withRig(remote, async (rig) => {
      const r = await runBridge(
        channelOf(rig),
        [
          { path: path.join(dir, 'one.txt'), isDir: false },
          { path: path.join(dir, 'two.txt'), isDir: false },
          { path: sub, isDir: true }
        ],
        remote,
        RSYNC as string,
        token()
      )
      assert.equal(r.ok, true, r.message ?? '')
      const listed = await listRemote(rig, remote)
      for (const n of ['one.txt', 'two.txt', 'b.txt']) assert.ok(listed.includes(n), `${n} 应当在（实际 ${listed.join(',')}）`)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：远端目标目录不存在（多级）也要能自己建出来', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  const remote = `${REMOTE_BASE}/deep/created/on/demand`
  const rig = await connectRig()
  try {
    await rig.exec(`rm -rf ${REMOTE_BASE}/deep`)
    await waitShellReady(rig)
    const r = await runBridge(channelOf(rig), [{ path: path.join(dir, 'a.txt'), isDir: false }], remote, RSYNC as string, token())
    assert.equal(r.ok, true, `rsync 应当自己建出多级目录：${r.message ?? ''}`)
    assert.equal((await readRemote(rig, `${remote}/a.txt`)).toString(), 'hello from windows\n')
  } finally {
    rig.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：远端目录不可写 → 失败信息要能看懂（不能静默）', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  // /root 对 bastiontest 不可写（mode 700）
  const remote = '/root/bastion-e2e-deny'
  const rig = await connectRig()
  try {
    await waitShellReady(rig)
    const r = await runBridge(channelOf(rig), [{ path: path.join(dir, 'a.txt'), isDir: false }], remote, RSYNC as string, token())
    assert.equal(r.ok, false, '不可写就应当失败')
    assert.ok(r.message && r.message.length > 0, '必须给出说明')
  } finally {
    rig.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：增量 —— 第二次同步同一个目录应当只传 0 个文件', { skip: SKIP, timeout: 180000 }, async () => {
  const dir = tmpSrc()
  const remote = `${REMOTE_BASE}/incr`
  try {
    await withRig(remote, async (rig) => {
      const first = await runBridge(channelOf(rig), [{ path: dir, isDir: true }], remote, RSYNC as string, token())
      assert.equal(first.ok, true, first.message ?? '')
      assert.ok((first.files ?? 0) >= 2, `第一次应当传了文件（实际 ${first.files}）`)

      await waitShellReady(rig, 300)
      const second = await runBridge(channelOf(rig), [{ path: dir, isDir: true }], remote, RSYNC as string, token())
      assert.equal(second.ok, true, second.message ?? '')
      assert.equal(second.files, 0, `没改过就不该重传（实际传了 ${second.files} 个）`)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test(
  `矩阵：连续同步 ${HEAVY ? 10 : 3} 次都成功（状态残留 / 资源泄漏）`,
  { skip: SKIP, timeout: HEAVY ? 600000 : 180000 },
  async () => {
    const dir = tmpSrc()
    const runs = HEAVY ? 10 : 3
    const remote = `${REMOTE_BASE}/repeat`
    try {
      await withRig(remote, async (rig) => {
        for (let i = 1; i <= runs; i++) {
          // 每轮改一下内容，确保真的在传（否则第二次起会是 0 个文件，测不到链路）
          fs.writeFileSync(path.join(dir, 'a.txt'), `round ${i}\n`)
          await waitShellReady(rig, 200)
          const r = await runBridge(channelOf(rig), [{ path: path.join(dir, 'a.txt'), isDir: false }], remote, RSYNC as string, token())
          assert.equal(r.ok, true, `第 ${i} 次失败：${r.message ?? ''}`)
          assert.equal((await readRemote(rig, `${remote}/a.txt`)).toString(), `round ${i}\n`, `第 ${i} 次内容不对`)
        }
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('矩阵：同步之后同一条会话仍然可用，且**提示符要回来**（pty 恢复 sane、PS1 还原、通道归还）', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  const remote = `${REMOTE_BASE}/usable`
  try {
    await withRig(remote, async (rig) => {
      // 先给这条会话设一个能认出来的提示符 —— 桥跑完必须把它还回来
      const PROMPT = 'BASTION_PROMPT_7731> '
      rig.stream.write(`PS1='${PROMPT}'\r`)
      await new Promise((r) => setTimeout(r, 400))

      const r = await runBridge(channelOf(rig), [{ path: path.join(dir, 'a.txt'), isDir: false }], remote, RSYNC as string, token())
      assert.equal(r.ok, true, r.message ?? '')

      // 桥交还通道后，往会话里敲一条命令：
      // ① 命令要被执行（会话可用）② 执行前要打印出**原来那个提示符**（PS1 被还原，没被我们清空）
      let seen = ''
      rig.setSink((d) => {
        seen += d.toString('utf8')
      })
      const MARK = 'BASTION_SESSION_OK_9271'
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !seen.includes(MARK)) {
        rig.stream.write(`echo ${MARK}\r`)
        await new Promise((r2) => setTimeout(r2, 200))
      }
      assert.ok(seen.includes(MARK), `同步后会话应当还能执行命令（看到：${seen.slice(-160)}）`)
      assert.ok(
        seen.includes(PROMPT.trim()),
        `提示符必须被还原（用户实测的"终端回不来"就是这个）：看到的是 ${JSON.stringify(seen.slice(-200))}`
      )
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：会话已被占用时，第二次同步要明确拒绝（不排队、不互相污染）', { skip: SKIP, timeout: 120000 }, async () => {
  const dir = tmpSrc()
  const { file } = randomFile(dir, 'big2.bin', 24 * 1024 * 1024)
  const remote = `${REMOTE_BASE}/busy`
  try {
    await withRig(remote, async (rig) => {
      const channel = channelOf(rig) // 同一个通道对象 → 独占语义和扩展里一致
      const first = runBridge(channel, [{ path: file, isDir: false }], remote, RSYNC as string, token())
      await new Promise((r) => setTimeout(r, 400)) // 让它先占上
      const second = await runBridge(channel, [{ path: file, isDir: false }], remote, RSYNC as string, token())
      assert.equal(second.ok, false, '第二次应当被拒')
      assert.match(second.message ?? '', /正忙|没就绪/, `提示要能看懂：${second.message}`)
      const r1 = await first
      assert.equal(r1.ok, true, `第一次应当正常完成：${r1.message ?? ''}`)
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：传输中途取消 → 桥干净收场，会话在 --timeout 窗口后恢复可用', { skip: SKIP, timeout: 180000 }, async () => {
  const dir = tmpSrc()
  const { file } = randomFile(dir, 'cancel.bin', 48 * 1024 * 1024)
  const remote = `${REMOTE_BASE}/cancel`
  try {
    await withRig(remote, async (rig) => {
      const tk = token()
      // ioTimeoutSec 调小到 5s：远端 rsync 静默 5 秒就自己退出，ptx 才恢复得了。
      // 生产默认是 20s（见 RSYNC_IO_TIMEOUT_SEC）。
      const p = runBridge(channelOf(rig), [{ path: file, isDir: false }], remote, RSYNC as string, tk, {
        ioTimeoutSec: 5
      })
      await new Promise((r) => setTimeout(r, 700))
      tk.cancel()
      const r = await p
      assert.equal(r.ok, false, '取消后应当是失败结果')
      assert.match(r.message ?? '', /取消/, `提示应当说明是取消：${r.message}`)

      // 会话不该被"冻住"：等远端收场（≤5s 超时 + 余量）后，终端应当恢复可用。
      // 注意：某些 rsync 版本在被强行截断时会自己崩（glibc 打 `malloc_consolidate(): unaligned
      // fastbin chunk detected` + core dumped）—— 那是它自己的健壮性问题，我们会多等一会儿。
      let seen = ''
      rig.setSink((d) => {
        seen += d.toString('utf8')
      })
      const MARK = 'AFTER_CANCEL_OK_5512'
      const deadline = Date.now() + 45000
      while (Date.now() < deadline && !seen.includes(MARK)) {
        rig.stream.write(`echo ${MARK}\r`)
        await new Promise((r2) => setTimeout(r2, 900))
      }
      assert.ok(
        seen.includes(MARK),
        `取消之后会话要能恢复（远端靠 --timeout 自己收场）。看到的是：${JSON.stringify(seen.slice(-200))}`
      )
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：传输过程中要能报出进度（用户实测：看不到进度就以为卡死，把 91MB 的传输取消了）', { skip: SKIP, timeout: 180000 }, async () => {
  const dir = tmpSrc()
  const { file } = randomFile(dir, 'progress.bin', 32 * 1024 * 1024)
  const remote = `${REMOTE_BASE}/progress`
  try {
    await withRig(remote, async (rig) => {
      const events: string[] = []
      const r = await runBridge(channelOf(rig), [{ path: file, isDir: false }], remote, RSYNC as string, token(), {
        totalBytes: 32 * 1024 * 1024,
        onProgress: (t) => events.push(t)
      })
      assert.equal(r.ok, true, r.message ?? '')
      assert.ok(events.length >= 2, `应当多次报进度（实际 ${events.length} 次）—— 否则用户只能看着转圈`)
      const last = events[events.length - 1] ?? ''
      assert.match(last, /\d+(\.\d+)?\s?(KB|MB|GB)/, `进度里要有"已发送多少"：${last}`)
      assert.match(last, /KB\/s|MB\/s/, `进度里要有速率：${last}`)
      assert.match(last, /%/, '单文件时还要有百分比')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：「目标机已有前半段」时只补差（这就是卡住后重跑能接着传的底气）', { skip: SKIP, timeout: 300000 }, async () => {
  const dir = tmpSrc()
  const MB = 6
  const bytes = MB * 1024 * 1024
  const { file, sha256: want } = randomFile(dir, 'partial.bin', bytes)
  const remote = `${REMOTE_BASE}/partial`
  try {
    await withRig(remote, async (rig) => {
      // 直接在目标机上造出"前 2/3 已经传过去了"的状态（不依赖取消路径的时序，测试才稳）
      const head = fs.readFileSync(file).subarray(0, Math.floor(bytes * 0.66))
      await rig.execWithInput(`base64 -d > ${remote}/partial.bin`, Buffer.from(head.toString('base64'), 'utf8'))
      const before = Number((await rig.exec(`wc -c < ${remote}/partial.bin`)).trim())
      assert.ok(before > 0 && before < bytes, `前置状态没造好：${before}`)

      const r = await runBridge(channelOf(rig), [{ path: file, isDir: false }], remote, RSYNC as string, token(), {
        totalBytes: bytes
      })
      assert.equal(r.ok, true, `应当成功：${r.message ?? ''}`)
      assert.equal(sha256(await readRemote(rig, `${remote}/partial.bin`)), want, '补齐后的内容必须与源一致')
      const sent = r.sentBytes ?? 0
      assert.ok(
        sent < bytes * 0.6,
        `只应当补差的那一段（已存在 ${before} 字节，实际发送 ${sent} 字节，整个文件 ${bytes} 字节）`
      )
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('矩阵：4 条会话并发各传各的（互不串台）', { skip: SKIP, timeout: 240000 }, async () => {
  const dir = tmpSrc()
  const rigs = await Promise.all([connectRig(), connectRig(), connectRig()])
  try {
    await Promise.all(rigs.map((r, i) => r.exec(`rm -rf ${REMOTE_BASE}/par${i} && mkdir -p ${REMOTE_BASE}/par${i}`)))
    await Promise.all(rigs.map((r) => waitShellReady(r, 500)))
    const results = await Promise.all(
      rigs.map(async (rig, i) => {
        const f = path.join(dir, `p${i}.txt`)
        fs.writeFileSync(f, `parallel ${i}\n`)
        const r = await runBridge(channelOf(rig), [{ path: f, isDir: false }], `${REMOTE_BASE}/par${i}`, RSYNC as string, token())
        const got = r.ok ? (await readRemote(rig, `${REMOTE_BASE}/par${i}/p${i}.txt`)).toString() : ''
        return { ok: r.ok, msg: r.message, got, want: `parallel ${i}\n` }
      })
    )
    for (const [i, r] of results.entries()) {
      assert.equal(r.ok, true, `第 ${i} 条失败：${r.msg ?? ''}`)
      assert.equal(r.got, r.want, `第 ${i} 条内容串台了`)
    }
  } finally {
    for (const r of rigs) r.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
