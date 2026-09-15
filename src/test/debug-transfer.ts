// 调试：把 base64 降级上传过程中**每条远端命令和输出**都打出来
import '../testkit/vscode-stub'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { connectRig, REMOTE_BASE, q } from './rsyncE2Ekit'
import { clearCapabilities, pushPath, type TransferSession } from '../transferPath'

async function main(): Promise<void> {
  const rig = await connectRig()
  const name = `dbg-${Date.now()}`
  const session: TransferSession = {
    name,
    exec: async (cmd) => {
      const out = await rig.exec(cmd)
      console.log(`  $ ${cmd.length > 120 ? cmd.slice(0, 60) + `…(${cmd.length} 字符)…` + cmd.slice(-20) : cmd}`)
      console.log(`    → ${JSON.stringify(out.slice(0, 200))}`)
      return out
    },
    exitCode: () => 0,
    overwriteMode: () => 'overwrite',
    log: (m) => console.log(`  [log] ${m}`)
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-dbg-'))
  const local = path.join(dir, 'small.txt')
  fs.writeFileSync(local, 'hello 你好\n', 'utf8')
  console.log('本地文件:', local, fs.statSync(local).size, 'B')

  clearCapabilities(name)
  console.log('=== 开始 pushPath ===')
  const out = await pushPath({ localPath: local, remoteDir: REMOTE_BASE, session })
  console.log('=== 结果 ===')
  console.log(out.message)

  console.log('=== 远端目录实际内容 ===')
  console.log(await rig.exec(`ls -la ${q(REMOTE_BASE)}`))
  console.log('=== 试着读回来 ===')
  console.log(await rig.exec(`cat ${q(`${REMOTE_BASE}/small.txt`)} 2>&1 || echo '读不到'`))
  console.log('=== 带 bastion-part 的残留 ===')
  console.log(await rig.exec(`ls ${q(REMOTE_BASE)} | grep bastion || echo '(无)'`))

  fs.rmSync(dir, { recursive: true, force: true })
  rig.close()
}

void main()
