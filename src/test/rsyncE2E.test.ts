// rsync 桥的基础端到端用例：真 SSH 连接 + 真 pty 会话 + 真注入/过滤/收尾 + 真 Windows rsync 客户端。
//
// 详细的验证矩阵在 `rsyncE2EMatrix.test.ts`；这里保留三条最关键的"冒烟"：
//   - 单个文件（**文件不能带末尾斜杠** —— 用户真机就是这么炸的）
//   - 整个目录（目录带斜杠 = 把目录里的内容同步过去）
//   - 本机 rsync 不存在（远端缺失的对应场景见矩阵）：要给得出说法，不能静默卡住
//
// 需要本地测试台（`tools/rsync-e2e/setup-wsl.sh`）；没搭就跳过，不影响 `npm test` / CI。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import {
  SKIP,
  RSYNC,
  REMOTE_BASE,
  connectRig,
  channelOf,
  waitShellReady,
  token,
  tmpSrc,
  readRemote
} from './rsyncE2Ekit'
import { runBridge } from '../rsyncTransfer'

test(
  'E2E：真 SSH + 真 pty，单个文件（文件不能带末尾斜杠 —— 实测就是这么炸的）',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const src = tmpSrc()
    const remote = `${REMOTE_BASE}/file`
    const rig = await connectRig()
    try {
      await rig.exec(`rm -rf ${remote} && mkdir -p ${remote}`)
      await waitShellReady(rig)
      const r = await runBridge(
        channelOf(rig),
        [{ path: path.join(src, 'a.txt'), isDir: false }],
        remote,
        RSYNC as string,
        token()
      )
      assert.equal(r.message, undefined, `桥不该报错：${r.message ?? ''}`)
      assert.equal(r.ok, true, '桥应当成功')
      assert.equal(r.remoteRc, 0, '远端 rsync 退出码必须是 0')
      assert.equal((await readRemote(rig, `${remote}/a.txt`)).toString(), 'hello from windows\n')
      assert.equal(r.files, 1, '--stats 应当报告传了 1 个文件')
    } finally {
      rig.close()
      fs.rmSync(src, { recursive: true, force: true })
    }
  }
)

test('E2E：真 SSH + 真 pty，整个目录（目录带斜杠 = 把目录里的内容同步过去）', { skip: SKIP, timeout: 90000 }, async () => {
  const src = tmpSrc()
  const remote = `${REMOTE_BASE}/dir`
  const rig = await connectRig()
  try {
    await rig.exec(`rm -rf ${remote} && mkdir -p ${remote}`)
    await waitShellReady(rig)
    const r = await runBridge(channelOf(rig), [{ path: src, isDir: true }], remote, RSYNC as string, token())
    assert.equal(r.ok, true, `桥应当成功：${r.message ?? ''}`)
    assert.equal(r.remoteRc, 0)
    assert.equal((await readRemote(rig, `${remote}/a.txt`)).toString(), 'hello from windows\n')
    assert.equal((await readRemote(rig, `${remote}/sub/b.txt`)).toString(), 'nested file\n', '子目录也要跟着过去')
  } finally {
    rig.close()
    fs.rmSync(src, { recursive: true, force: true })
  }
})

test('E2E：本机 rsync 不存在时要有说法（真机上对应的场景是远端缺失，见矩阵）', { skip: SKIP, timeout: 90000 }, async () => {
  const src = tmpSrc()
  const rig = await connectRig()
  try {
    await rig.exec(`mkdir -p ${REMOTE_BASE}/none`)
    await waitShellReady(rig)
    const r = await runBridge(
      channelOf(rig),
      [{ path: path.join(src, 'a.txt'), isDir: false }],
      `${REMOTE_BASE}/none`,
      'this-rsync-does-not-exist-xyz',
      token()
    )
    assert.equal(r.ok, false, '本机 rsync 不存在时应当失败')
    assert.ok(r.message && r.message.length > 0, '必须给用户一个说法，而不是静默卡住')
  } finally {
    rig.close()
    fs.rmSync(src, { recursive: true, force: true })
  }
})
