// 识别「粘/拖进来的本地文件路径」
//
// VS Code 的终端拿到拖拽只会把路径当文本插入，扩展拦不住那一刻；
// 所以我们在**回车时**判断：整行是不是一个存在的本地文件绝对路径。
// 这组测试重点守两类错误：
//   1. 该认的没认出来（拖进来还是要手打命令）
//   2. **不该认的认了**（把远端相对路径当本地文件 → 误拦截，比不做更糟）
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectLocalFilePath,
  isAbsoluteLocalPath,
  InputLineTracker,
  looksLikeLocalPathPrefix,
  shouldHoldLocalPathInput,
  resolveUploadPromptChoice,
  UPLOAD_PROMPT_RUN,
  UPLOAD_PROMPT_UPLOAD
} from '../localPath'

/** 造一个假的文件系统：只认给定的几个文件 */
const fsStub = (files: string[], dirs: string[] = []) => (p: string): 'file' | 'dir' | 'none' => {
  if (files.includes(p)) return 'file'
  if (dirs.includes(p)) return 'dir'
  return 'none'
}

test('Windows 绝对路径 + 文件存在 → 认出来', () => {
  const p = 'D:\\work\\config.yaml'
  assert.equal(detectLocalFilePath(p, fsStub([p])), p)
})

test('带引号的路径（拖拽/复制常见）→ 去掉引号再判断', () => {
  const p = 'D:\\work\\my file.txt'
  assert.equal(detectLocalFilePath(`"${p}"`, fsStub([p])), p)
  assert.equal(detectLocalFilePath(`'${p}'`, fsStub([p])), p)
})

test('正斜杠写法也认（C:/Users/...）', () => {
  const p = 'C:/Users/me/a.sh'
  assert.equal(detectLocalFilePath(p, fsStub([p])), p)
})

test('UNC 路径与 WSL 的 /mnt/c 路径都认', () => {
  const unc = '\\\\srv\\share\\a.txt'
  const wsl = '/mnt/c/work/a.txt'
  assert.equal(isAbsoluteLocalPath(unc), true)
  assert.equal(isAbsoluteLocalPath(wsl), true)
  assert.equal(detectLocalFilePath(unc, fsStub([unc])), unc)
  assert.equal(detectLocalFilePath(wsl, fsStub([wsl])), wsl)
})

test('文件不存在 → 不认（可能就是远端上要执行的一条命令）', () => {
  assert.equal(detectLocalFilePath('D:\\nothing\\here.txt', fsStub([])), undefined)
})

test('目录 → 不认（上传目录没有明确语义，别自作主张）', () => {
  const d = 'D:\\work'
  assert.equal(detectLocalFilePath(d, fsStub([], [d])), undefined)
})

test('⚠️ 远端相对路径绝不误认（这是这个功能最容易犯的错）', () => {
  const exists = fsStub(['Makefile', './deploy.sh', 'README.md'])
  for (const cmd of ['Makefile', './deploy.sh', 'README.md']) {
    assert.equal(isAbsoluteLocalPath(cmd), false, `${cmd} 不该被当成绝对路径`)
    assert.equal(detectLocalFilePath(cmd, exists), undefined, `${cmd} 是远端命令写法，不该被拦`)
  }
})

test('⚠️ 裸 /tmp/x 不认（远端同样常见）', () => {
  assert.equal(isAbsoluteLocalPath('/tmp/x'), false)
  assert.equal(detectLocalFilePath('/tmp/x', fsStub(['/tmp/x'])), undefined)
})

test('普通命令 / 空行 / 只有空白 → 不认', () => {
  const exists = fsStub(['D:\\a.txt'])
  assert.equal(detectLocalFilePath('systemctl restart nginx', exists), undefined)
  assert.equal(detectLocalFilePath('', exists), undefined)
  assert.equal(detectLocalFilePath('    ', exists), undefined)
  assert.equal(detectLocalFilePath('cat D:\\a.txt | grep x', exists), undefined, '管道命令整体不该被当成路径')
})

test('一行里多个路径（拖多个文件）：取第一个，且第一个是存在的文件才认', () => {
  const a = 'D:\\a.txt'
  const b = 'D:\\b.txt'
  assert.equal(detectLocalFilePath(`${a} ${b}`, fsStub([a, b])), a)
  assert.equal(detectLocalFilePath(`D:\\none.txt ${b}`, fsStub([b])), undefined)
})

// ---------------------------------------------------------------------------
// 攒行器：识别能不能触发，全看它。
//
// 这一组来自一个真实缺陷：原来只在「这一块输入里有回车」时才喂缓冲区，
// 于是**手打一行、或粘一行（不带换行）、再单独按回车**时缓冲区是空的，
// 识别永远不触发 —— 功能写了，实际只在「路径和回车恰好同一块」时才生效。
// ---------------------------------------------------------------------------
const p = 'D:\\work\\a.txt'
const exists = fsStub([p])

/** 模拟「按字符到达」的键盘流（手打） */
function typeLine(t: InputLineTracker, text: string): void {
  for (const ch of text) t.feed(ch)
}

test('攒行器：手打一行再回车 → 回车那块要能报出整行（这是原来坏掉的场景）', () => {
  const t = new InputLineTracker()
  typeLine(t, p)
  const fed = t.feed('\r')
  assert.equal(fed.line, p, '字符分块到达也必须攒起来')
  assert.equal(fed.multiLine, false)
  assert.equal(detectLocalFilePath(fed.line!, exists), p, '于是识别能正常触发')
})

test('攒行器：粘贴一行（不带换行）+ 单独回车 → 也要认出来', () => {
  const t = new InputLineTracker()
  assert.equal(t.feed(p).line, undefined, '这一块没有回车，不该报"完成了一行"')
  assert.equal(t.feed('\r').line, p)
})

test('攒行器：路径和回车同一块（复制整行，含 \\r\\n）→ 认出来，且不算多行', () => {
  for (const chunk of [`${p}\r`, `${p}\n`, `${p}\r\n`]) {
    const t = new InputLineTracker()
    const fed = t.feed(chunk)
    assert.equal(fed.line, p, `${JSON.stringify(chunk)} 应当报出一行`)
    assert.equal(fed.multiLine, false, '\\r\\n 是一次回车，不是两行')
  }
})

test('⚠️ 多行粘贴：第一行是本地路径时**必须报 multiLine**（否则后面几行会被整段丢掉）', () => {
  const t = new InputLineTracker()
  const fed = t.feed(`${p}\rcd /opt\r./run.sh\r`)
  assert.equal(fed.line, p, '第一行还是要报出来（调用方靠 multiLine 决定不用它）')
  assert.equal(fed.multiLine, true, '后面还有内容 —— 调用方必须放弃上传判断，把整块原样发出去')
})

test('多行粘贴后，缓冲区回到最后一段（下一次回车判断的是新那行）', () => {
  const t = new InputLineTracker()
  t.feed(`${p}\rcd /opt`)
  const fed = t.feed('\r')
  assert.equal(fed.line, 'cd /opt', '不该把上一行的路径又报一遍')
})

test('攒行器：退格去掉一个字符', () => {
  const t = new InputLineTracker()
  typeLine(t, `${p}x`)
  t.feed('\x7f')
  assert.equal(t.feed('\r').line, p)
})

test('攒行器：方向键等控制序列之后放弃这一行（内容已不可信）', () => {
  const t = new InputLineTracker()
  typeLine(t, 'D:\\wrong')
  t.feed('\x1b[A')
  const fed = t.feed('\r')
  assert.equal(fed.line, '', '控制序列之后不该还认为整行是刚才那串')
  assert.equal(detectLocalFilePath(fed.line!, exists), undefined)
})

test('攒行器：Ctrl-C 之后这一行作废（远端已经把这一行丢掉了，我们不能还留着）', () => {
  const t = new InputLineTracker()
  typeLine(t, p)
  t.feed('\x03')
  assert.equal(t.current, '', 'Ctrl-C 之后不该还攒着刚才那行')
  assert.equal(t.feed('\r').line, '', '于是紧跟的回车不该再翻出旧路径来问「要不要上传」')
})

test('攒行器：空回车报空行（不崩、也不认成路径）', () => {
  const t = new InputLineTracker()
  const fed = t.feed('\r')
  assert.equal(fed.line, '')
  assert.equal(fed.multiLine, false)
  assert.equal(detectLocalFilePath(fed.line!, exists), undefined)
})

test('攒行器：长命令不会无限攒（512 上限）', () => {
  const t = new InputLineTracker()
  typeLine(t, 'x'.repeat(900))
  assert.equal(t.feed('\r').line!.length, InputLineTracker.MAX)
})

test('攒行器：报出 hadBuffer —— 用来决定要不要给远端发 Ctrl-U 擦掉已发的字符', () => {
  const t = new InputLineTracker()
  assert.equal(t.feed(`${p}\r`).hadBuffer, false, '整行和回车在同一块 → 我们还什么都没发出去')
  const t2 = new InputLineTracker()
  typeLine(t2, p)
  assert.equal(t2.feed('\r').hadBuffer, true, '分块到达 → 前面那些字符已经发给远端了，得擦')
})

// ---------------------------------------------------------------------------
// 扣住不发：粘过来的路径不该先被远端当命令执行
//
// 这是用户实测撞到的：粘一个带空格的本机路径进去，远端先报
//   -bash: c:/Users/Administrator/Desktop/DeepSeek: No such file or directory
// 然后才问「要不要上传」—— 因为路径的字符在我们判断之前就已经发出去了，
// 后面的 `rz -y` 又被接在同一行上执行。所以判断之前先扣住。
// ---------------------------------------------------------------------------
test('看起来正在输入本机路径 → 先扣住不发', () => {
  for (const line of ['c:/Users/me/a.txt', 'C:\\tmp\\a.txt', '\\\\srv\\share\\a', '/mnt/d/work/a']) {
    assert.equal(looksLikeLocalPathPrefix(line), true, `${line} 应当被扣住`)
    assert.equal(shouldHoldLocalPathInput(line, line), true)
  }
  // 最常见的来源：从资源管理器「复制文件地址」，粘进来是一整块
  const pasted = 'c:/Users/Administrator/Desktop/DeepSeek Harness/release/bundle.tar.gz'
  assert.equal(shouldHoldLocalPathInput(pasted, pasted), true, '带空格的粘贴块也要扣住')
})

test('不像本机路径的正常命令 → 绝不扣住（不能因为新逻辑让输入卡住）', () => {
  for (const line of ['ls -l', 'systemctl restart nginx', './deploy.sh', 'cd /tmp', 'sudo -i', 'cat /etc/hosts']) {
    assert.equal(looksLikeLocalPathPrefix(line), false, `${line} 不该被扣`)
    assert.equal(shouldHoldLocalPathInput(line, line), false)
  }
})

test('带回车 / Ctrl-C / 方向键 → 不扣（交给回车那套判断，也别拦用户的打断）', () => {
  assert.equal(shouldHoldLocalPathInput(`${p}\r`, p), false, '带回车要立刻走「上传还是执行」的判断')
  assert.equal(shouldHoldLocalPathInput('\x03', p), false, 'Ctrl-C 必须能打断')
  assert.equal(shouldHoldLocalPathInput('\x1b[A', p), false, '方向键必须能过去')
})

// ---------------------------------------------------------------------------
// 询问框的结果：**关掉绝不能等于丢掉**
// ---------------------------------------------------------------------------
test('询问框：点「上传」→ 上传', () => {
  assert.equal(resolveUploadPromptChoice(UPLOAD_PROMPT_UPLOAD), 'upload')
})

test('询问框：点「当命令执行」→ 执行整行', () => {
  assert.equal(resolveUploadPromptChoice(UPLOAD_PROMPT_RUN), 'run')
})

test('⚠️ 询问框被关掉（Esc / 关闭按钮）→ 把这一行**放回命令行**，不能吞掉', () => {
  for (const dismissed of [undefined, '', '取消']) {
    assert.equal(
      resolveUploadPromptChoice(dismissed),
      'restore',
      '用户自己取消了询问，唯一不能做的就是把他敲的那一行吃掉（他会以为终端吃了输入）'
    )
  }
})

test('询问框：关掉不等于「执行」—— 关一个弹窗不该变成一次写操作', () => {
  assert.notEqual(resolveUploadPromptChoice(undefined), 'run')
})
