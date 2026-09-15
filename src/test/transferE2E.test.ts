// 传输标准工具的端到端测试（真 SSH + 真远端文件系统）。
//
// 为什么必须真机：这套逻辑的重点是**通道选择和降级** ——
//   · 目标机有 rz → 走 rz（那套已经被用户在真机上验证过了）
//   · 目标机**没有 rz** → 自动降级 base64 分块塞进 shell
//   · 目录 → 本地 tar 打包 → 传 → 远端解开
// 而我们的测试台（WSL sshd）**恰好没装 lrzsz**，所以它天然就是"没有 rz"那个现场，
// 降级路径可以在这里被真真切切地跑一遍（含哈希校验）。
//
// 没有测试台时自动跳过（环境变量见 tools/rsync-e2e/setup-wsl.sh）。
import '../testkit/vscode-stub'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { KEY, REMOTE_BASE, SSH, connectRig, q, type Rig } from './rsyncE2Ekit'
import { clearCapabilities, probeCapabilities, pullPath, pushPath, type TransferSession } from '../transferPath'

const CAN_RUN = Boolean(SSH && KEY && fs.existsSync(KEY as string))
const SKIP = CAN_RUN ? false : '没搭测试台（见 tools/rsync-e2e/setup-wsl.sh）'

/**
 * **整套共用一个连接**：每项测试各连一次会把测试台的 sshd 并发连接吃满
 * （实测和 rsync 那 19 项一起跑会卡住）—— 传输工具本身也不需要每次重连。
 */
let rig: Rig | undefined
before(async () => {
  if (CAN_RUN) rig = await connectRig()
})
after(() => {
  rig?.close()
})

/** 把测试台的 rig 适配成传输工具要的会话接口（只有 exec，没有 zmodem —— 正好测降级） */
function sessionOf(r: Rig, name: string): TransferSession {
  return {
    name,
    exec: (cmd) => r.exec(cmd),
    exitCode: () => 0,
    overwriteMode: () => 'overwrite',
    log: () => {}
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('探测：测试台没装 lrzsz → rz/sz 为否、base64 为是（降级的前提）', { skip: SKIP }, async () => {
  const r = rig!
  clearCapabilities()
  const caps = await probeCapabilities(sessionOf(r, `probe-${Date.now()}`), true)
  assert.equal(caps.rz, false, '测试台没装 lrzsz —— 这正是要测的场景')
  assert.equal(caps.sz, false)
  assert.equal(caps.base64, true, 'base64 是通用退路，必须有')
  assert.equal(caps.tar, true)
})

test('上传后远端文件必须**可读**、权限不能是 0（真机惨案：以前传上去是 0000）', { skip: SKIP }, async () => {
  const r = rig!
  const dir = tmp('bastion-mode-')
  try {
    const local = path.join(dir, 'mode-probe.txt')
    fs.writeFileSync(local, 'hello')
    const name = `mode-${Date.now()}`
    clearCapabilities(name)
    const out = await pushPath({ localPath: local, remoteDir: REMOTE_BASE, session: sessionOf(r, name) })
    assert.equal(out.ok, true, out.message)

    const remote = `${REMOTE_BASE}/mode-probe.txt`
    const mode = (await r.exec(`stat -c %a ${q(remote)}`)).trim()
    assert.notEqual(mode, '0', `远端文件权限不能是 0（实测 ${mode}）`)
    const readable = (await r.exec(`[ -r ${q(remote)} ] && echo yes || echo no`)).trim()
    assert.equal(readable, 'yes', '传上去的文件必须可读：否则校验拿不到哈希，服务也读不了')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('上传降级：没有 rz 时用 base64 分块，远端内容逐字节一致', { skip: SKIP }, async () => {
  const r = rig!
  const dir = tmp('bastion-xfer-')
  try {
    const buf = crypto.randomBytes(40 * 1024)
    const local = path.join(dir, 'base64-fallback.bin')
    fs.writeFileSync(local, buf)

    const name = `xfer-${Date.now()}`
    clearCapabilities(name)
    const out = await pushPath({ localPath: local, remoteDir: REMOTE_BASE, session: sessionOf(r, name) })
    assert.equal(out.ok, true, `上传应当成功：${out.message}`)
    assert.equal(out.method, 'base64', '没有 rz 就该走 base64 降级')
    assert.match(out.message, /base64/)

    const remoteMd5 = (await r.exec(`md5sum ${q(`${REMOTE_BASE}/base64-fallback.bin`)}`)).trim().split(/\s+/)[0]
    const localMd5 = crypto.createHash('md5').update(buf).digest('hex')
    assert.equal(remoteMd5, localMd5, '远端内容必须逐字节一致（40KB 分块拼起来不能错）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('上传降级：中文/空格文件名也要能传（远端 shell 引用不能出错）', { skip: SKIP }, async () => {
  const r = rig!
  const dir = tmp('bastion-xfer-')
  try {
    const local = path.join(dir, '配置 备份.txt')
    fs.writeFileSync(local, 'hello 你好\n', 'utf8')
    const name = `xfer-cn-${Date.now()}`
    clearCapabilities(name)
    const out = await pushPath({ localPath: local, remoteDir: REMOTE_BASE, session: sessionOf(r, name) })
    assert.equal(out.ok, true, out.message)
    const back = await r.exec(`cat ${q(`${REMOTE_BASE}/配置 备份.txt`)}`)
    assert.match(back, /hello 你好/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('上传目录：本地 tar 打包 → 传 → 远端解开（没有 rz 时走 tar+base64）', { skip: SKIP }, async () => {
  const r = rig!
  const dir = tmp('bastion-xfer-')
  try {
    const src = path.join(dir, 'cfgdir')
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'A', 'utf8')
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B', 'utf8')

    const name = `xfer-dir-${Date.now()}`
    clearCapabilities(name)
    const out = await pushPath({ localPath: src, remoteDir: REMOTE_BASE, session: sessionOf(r, name) })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.method, 'tar+base64')

    const listing = await r.exec(`ls -R ${q(`${REMOTE_BASE}/cfgdir`)} 2>&1 | head -20`)
    assert.match(listing, /a\.txt/)
    assert.match(listing, /b\.txt/)
    const leftovers = await r.exec(`ls ${q(REMOTE_BASE)} | grep -c 'bastion-' || true`)
    assert.equal(leftovers.trim(), '0', '临时 tar 包不该留在远端')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('下载降级：没有 sz 时用 base64 拉回来，内容一致', { skip: SKIP }, async () => {
  const r = rig!
  const dir = tmp('bastion-xfer-')
  try {
    const payload = crypto.randomBytes(20 * 1024)
    const remoteFile = `${REMOTE_BASE}/pull-me-${Date.now()}.bin`
    await r.execWithInput(`cat > ${q(remoteFile)}`, payload)

    const name = `xfer-pull-${Date.now()}`
    clearCapabilities(name)
    const out = await pullPath({ remotePath: remoteFile, localDir: dir, session: sessionOf(r, name) })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.method, 'base64')
    const got = fs.readFileSync(out.localPath as string)
    assert.equal(sha256(got), sha256(payload), '拉回来的内容必须一致（base64 整段输出不能被回显污染）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
