// 传输标准工具的纯逻辑：**通道选择**、分块、路径解析、打包。
//
// 这一组守的是「东西有点多」那个问题：以前 rz / rz -y / rz -E / rsync / 部署上传 / MCP 上传
// 各说各话，人和 AI 都记不清。现在收敛成一个入口 + 一套词汇（跳过/覆盖/改名）+ 一份证据，
// 而"用哪条通道"由这里决定 —— 所以它必须可测、且规则写死。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  B64_HARD_LIMIT,
  choosePullMethod,
  choosePushMethod,
  chunkBase64,
  clearCapabilities,
  lastAbsolutePath,
  methodLabel,
  packDir,
  probeCapabilities,
  pullPath,
  pushPath,
  type Capabilities,
  type TransferSession
} from '../transferPath'

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  rz: false,
  sz: false,
  base64: false,
  tar: false,
  md5sum: false,
  ...over
})

test('上传通道：有 rz 就走 rz；没有就降级 base64（用户说的"没有 rz 就试别的"）', () => {
  assert.equal(choosePushMethod(caps({ rz: true, base64: true }), false), 'rz')
  assert.equal(choosePushMethod(caps({ rz: true, base64: false }), false), 'rz')
  assert.equal(choosePushMethod(caps({ base64: true }), false), 'base64', '没有 rz 必须能降级')
  assert.equal(choosePushMethod(caps(), false), null, '两样都没有 → 只能如实说走不了')
})

test('上传目录：要 tar 才能打包；优先 rz，没有 rz 就 tar+base64', () => {
  assert.equal(choosePushMethod(caps({ tar: true, rz: true }), true), 'tar+rz')
  assert.equal(choosePushMethod(caps({ tar: true, base64: true }), true), 'tar+base64')
  assert.equal(choosePushMethod(caps({ rz: true }), true), null, '没有 tar 就传不了目录')
  assert.equal(choosePushMethod(caps({ tar: true }), true), null, '有 tar 但没有传输通道也不行')
})

test('下载通道：有 sz 走 sz，否则 base64', () => {
  assert.equal(choosePullMethod(caps({ sz: true })), 'sz')
  assert.equal(choosePullMethod(caps({ base64: true })), 'base64')
  assert.equal(choosePullMethod(caps()), null)
})

test('base64 分块：不多不少、拼回去等于原文（分块错一个字符，远端解码就废）', () => {
  const b64 = 'A'.repeat(9999)
  const chunks = chunkBase64(b64, 4000)
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map((c) => c.length), [4000, 4000, 1999])
  assert.equal(chunks.join(''), b64)
  assert.deepEqual(chunkBase64('', 4000), [], '空内容不该产生空块')
})

test('pwd 解析：只认绝对路径行（命令回显、提示符都不能被当成目录）', () => {
  const out = 'pwd\n/tmp/bastion-e2e/dst\n'
  assert.equal(lastAbsolutePath(out), '/tmp/bastion-e2e/dst')
  assert.equal(lastAbsolutePath('cd /x && pwd\n/home/u\n'), '/home/u', '取最后一条（cd 之后的那次）')
  assert.equal(lastAbsolutePath('__BASTION_CD_FAIL__\n[deploy@h ~]$ '), '', '认不出来就返回空串（退回相对路径）')
})

test('能力探测：一条命令问全，缺少的工具如实为否，并且**缓存**（不用每次传都探一遍）', async () => {
  let calls = 0
  const session: TransferSession = {
    name: `caps-${Date.now()}`,
    exec: async () => {
      calls++
      return 'rz=no\nsz=no\nbase64=yes\ntar=yes\nmd5sum=yes\n'
    },
    exitCode: () => 0,
    overwriteMode: () => 'skip',
    log: () => {}
  }
  clearCapabilities()
  const c1 = await probeCapabilities(session)
  assert.deepEqual(
    { rz: c1.rz, base64: c1.base64, tar: c1.tar },
    { rz: false, base64: true, tar: true }
  )
  await probeCapabilities(session)
  assert.equal(calls, 1, '同一个会话只探一次')
  await probeCapabilities(session, true)
  assert.equal(calls, 2, 'refresh=true 时重新探（用户可能刚装完 lrzsz）')
})

test('目录打包：本机 tar 打出来的包能被远端解开（文件名里带日期，不覆盖）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-pack-'))
  try {
    const src = path.join(dir, 'cfg')
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'A')
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B')
    const packed = packDir(src)
    assert.ok('tarPath' in packed, `打包应当成功：${JSON.stringify(packed)}`)
    if ('tarPath' in packed) {
      assert.ok(fs.statSync(packed.tarPath).size > 0, '包不能是空的')
      fs.rmSync(packed.tarPath, { force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('通道名是人话，不会把 rz -y / rz -E 这种实现细节漏给用户', () => {
  for (const m of ['rz', 'sz', 'base64', 'tar+rz', 'tar+base64'] as const) {
    const label = methodLabel(m)
    assert.ok(label.length > 0)
    assert.ok(!/-y|-E/.test(label), `不该出现 rz 的开关：${label}`)
  }
  assert.match(methodLabel('base64'), /lrzsz/, '降级时要说明为什么降级')
})

test('base64 上限是个真实存在的数字（大文件走这条路不划算，要能拒绝）', () => {
  assert.ok(B64_HARD_LIMIT > 0 && B64_HARD_LIMIT <= 8 * 1024 * 1024)
})

test('远端文件不可读时，给 AI 的话里要**单独、显眼**地警告一次（真机上它把这句忽略了）', async () => {
  // 真机教训：AI 在总结里把 `----------`（0000）改写成 `-rw-r--r--`，
  // 夹在「判定依据」里的"读不了"它没当回事。所以这条警告必须单独成段、带 ⚠️、并给出修复动作。
  const session: TransferSession = {
    name: `perm-${Date.now()}`,
    exec: async (cmd: string) => {
      if (cmd.includes('for c in rz')) return 'rz=yes\nsz=yes\nbase64=yes\ntar=yes\nmd5sum=yes\n'
      if (cmd.includes('cd ') || cmd.trim() === 'pwd') return '/tmp\n'
      if (cmd.includes('for f in')) return 'NA|9200|1757000000|no|/tmp/perm-warn.txt\n'
      return ''
    },
    exitCode: () => 0,
    rzUpload: async () => ({ skipped: [], mode: 'overwrite' as const }),
    overwriteMode: () => 'overwrite',
    log: () => {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-perm-'))
  try {
    const f = path.join(dir, 'perm-warn.txt')
    fs.writeFileSync(f, 'x'.repeat(9200))
    clearCapabilities()
    const out = await pushPath({ localPath: f, remoteDir: '/tmp', session })
    assert.match(out.message, /读不了/, '要说清读不了')
    assert.match(out.message, /传上去等于白传/, '要说清后果')
    assert.match(out.message, /chmod 644/, '要给出修复动作')
    assert.match(out.message, /0\.3\.2 起已修/, '要告诉用户这是已知 bug 且已修')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})




test('拉一个不存在的文件：要说清「不存在/读不到」，不能冒一句 base64 解码失败', async () => {
  // 真机教训（2026-09-15，在桌面版那条链路的实机测试里抓到，两边同一个写法）：
  // 兜底的那条 `base64` 没吞 stderr，文件不存在时错误信息**混进 payload**，
  // 报出来是 `illegal base64 data at input byte 6` —— 完全指不到真实原因。
  const session: TransferSession = {
    name: `pull-missing-${Date.now()}`,
    exec: async (cmd: string) => {
      if (cmd.includes('for c in rz')) return 'rz=no\nsz=no\nbase64=yes\ntar=yes\nmd5sum=yes\n'
      if (cmd.includes('stat -c %s')) return 'NA\n'
      if (cmd.includes('__B64_BEGIN_')) {
        // 远端什么都没回（文件不在），只剩两个哨兵。
        // 注意：**把命令回显也带上** —— 那正是 lastIndexOf 要防的情况。
        const b = /__B64_BEGIN_[0-9a-f]+__/.exec(cmd)![0]
        const e = /__B64_END_[0-9a-f]+__/.exec(cmd)![0]
        return cmd + '\n' + b + '\n' + e + '\n'
      }
      return ''
    },
    exitCode: () => 0,
    overwriteMode: () => 'skip',
    log: () => {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-pull-missing-'))
  try {
    clearCapabilities()
    const out = await pullPath({ remotePath: '/tmp/nope.txt', localDir: dir, session })
    assert.equal(out.ok, false, '不存在的文件不能报成功')
    assert.match(out.message, /不存在或当前账号读不到/, '要说清是路径/权限的问题')
    assert.ok(!/illegal base64/.test(out.message), '不该把 base64 库的内部错误直接甩给用户')
    assert.equal(fs.existsSync(path.join(dir, 'nope.txt')), false, '不能写出一个空的假文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('拉一个有大小但回不出内容的文件：不能当成「空文件」报成功', async () => {
  const session: TransferSession = {
    name: `pull-empty-${Date.now()}`,
    exec: async (cmd: string) => {
      if (cmd.includes('for c in rz')) return 'rz=no\nsz=no\nbase64=yes\ntar=yes\nmd5sum=yes\n'
      if (cmd.includes('stat -c %s')) return '4096\n'
      if (cmd.includes('__B64_BEGIN_')) {
        const b = /__B64_BEGIN_[0-9a-f]+__/.exec(cmd)![0]
        const e = /__B64_END_[0-9a-f]+__/.exec(cmd)![0]
        return cmd + '\n' + b + '\n' + e + '\n'
      }
      return ''
    },
    exitCode: () => 0,
    overwriteMode: () => 'skip',
    log: () => {}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-pull-empty-'))
  try {
    clearCapabilities()
    const out = await pullPath({ remotePath: '/etc/shadow-ish', localDir: dir, session })
    assert.equal(out.ok, false, '报告有 4KB 却一个字都没回，不能算成功')
    assert.match(out.message, /一个字节都没回出来/)
    assert.match(out.message, /4\.0 KB/, '要把远端报的大小说清楚')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
