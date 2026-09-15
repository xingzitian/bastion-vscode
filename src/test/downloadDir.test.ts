// 「下载存到哪儿」的规则（downloadDir.ts）。
//
// 这一组守的是维护者提的那个体验问题：**想自己下载却没法选存哪里**。
// 选目录的动作被挪到传输之外（设置 + 命令），所以这里盯的是解析优先级：
//   设置（支持写 ~） > 工作区 .bastion-downloads/ > ~/.bastionshell/downloads/
// 并且必须**同步、不弹窗** —— 弹窗会把握手拖死（见 zmodemIo 的 resolveDownloadDir 注释）。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { configValues, setWorkspaceFolder } from '../testkit/vscode-stub'
import { defaultDownloadDir, expandHome, resolveDownloadDir, setDownloadDir } from '../downloadDir'
import { NodeFsZmodemIo } from '../zmodemIo'

function withConfig(value: unknown, fn: () => void): void {
  const had = configValues.has('bastion.downloadDir')
  const old = configValues.get('bastion.downloadDir')
  configValues.set('bastion.downloadDir', value)
  try {
    fn()
  } finally {
    if (had) configValues.set('bastion.downloadDir', old)
    else configValues.delete('bastion.downloadDir')
  }
}

test('expandHome：~ 要展开，其余原样（用户很自然会写 ~/down）', () => {
  assert.equal(expandHome('~/down'), path.join(os.homedir(), 'down'))
  assert.equal(expandHome('~'), os.homedir())
  assert.equal(expandHome('  /opt/dl  '), '/opt/dl')
  assert.equal(expandHome(''), '')
})

test('没设 downloadDir → 落到工作区的 .bastion-downloads/', () => {
  setWorkspaceFolder('C:/work/proj')
  try {
    withConfig('', () => {
      assert.equal(resolveDownloadDir(), path.join('C:/work/proj', '.bastion-downloads'))
      assert.equal(resolveDownloadDir(), defaultDownloadDir())
    })
  } finally {
    setWorkspaceFolder(undefined)
  }
})

test('没有工作区 → 落到 ~/.bastionshell/downloads/', () => {
  setWorkspaceFolder(undefined)
  withConfig('', () => {
    const dir = resolveDownloadDir()
    assert.match(dir.replace(/\\/g, '/'), /\.bastionshell\/downloads$/, `实际：${dir}`)
  })
})

test('设了 downloadDir → 以它为准（工作区让位），并且支持 ~', () => {
  setWorkspaceFolder('C:/work/proj')
  try {
    withConfig('/opt/dl', () => {
      assert.equal(resolveDownloadDir(), '/opt/dl')
    })
    withConfig('~/mydl', () => {
      assert.equal(resolveDownloadDir(), path.join(os.homedir(), 'mydl'))
    })
    // 全是空白 = 等于没设（用户清空输入框的常见结果）
    withConfig('   ', () => {
      assert.equal(resolveDownloadDir(), path.join('C:/work/proj', '.bastion-downloads'))
    })
  } finally {
    setWorkspaceFolder(undefined)
  }
})

test('设置下载目录的命令要把选择写进设置（而不是只影响这一次）', async () => {
  const stub = await import('../testkit/vscode-stub')
  setWorkspaceFolder(undefined)
  configValues.delete('bastion.downloadDir')
  stub.setOpenDialogResult([{ fsPath: '/picked/dir' }])
  await setDownloadDir()
  assert.equal(configValues.get('bastion.downloadDir'), '/picked/dir', '选完要写进设置，下次直接用它')
  assert.ok(
    stub.infoMessages.some((m) => m.includes('/picked/dir')),
    `要告诉用户以后存到哪儿（实际：${JSON.stringify(stub.infoMessages)}）`
  )
})

test('下载目录还不存在时，openWrite 要自己把它建出来（真机 ENOENT 那一条）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-dl-'))
  const dir = path.join(base, 'not-created-yet', '.bastion-downloads')
  try {
    const io = new NodeFsZmodemIo(() => null, () => dir)
    assert.equal(io.resolveDownloadDir(), dir)
    const dest = io.openWrite(io.resolveDownloadDir(), 'a.txt')
    try {
      io.write(dest.fd, Buffer.from('hello'))
    } finally {
      io.close(dest.fd)
    }
    assert.equal(fs.readFileSync(dest.path, 'utf8'), 'hello', '文件应该真的写进去了')
    assert.equal(fs.existsSync(dir), true, '目录该被创建出来')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
