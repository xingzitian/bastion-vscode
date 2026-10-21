// tee 封装（纯函数）：拼出来的命令必须是 POSIX sh 能跑的，且**退出码来自命令本身**而不是 tee。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeeCommand, shQuote, tailLogCommand, teePaths } from '../execTee'

const P = teePaths('j-0001')

test('tee 落点固定在 /tmp/bastion，日志和 rc 同名同目录', () => {
  assert.equal(P.logPath, '/tmp/bastion/job-j-0001.log')
  assert.equal(P.rcPath, '/tmp/bastion/job-j-0001.log.rc')
  assert.equal(P.dir, '/tmp/bastion')
})

test('shQuote：单引号被正确转义（命令里带空格/引号也不会被拆开）', () => {
  assert.equal(shQuote("a b"), "'a b'")
  assert.equal(shQuote("it's"), `'it'\\''s'`)
})

test('★ 有哨兵时：退出码取自 .rc 文件，而不是管道里的 tee', () => {
  const cmd = buildTeeCommand({
    command: 'docker build -t x .',
    logPath: P.logPath,
    rcPath: P.rcPath,
    dir: P.dir,
    marker: '__BASTION_DONE_abc'
  })
  assert.match(cmd, /mkdir -p '\/tmp\/bastion'/)
  assert.match(cmd, /docker build -t x \.; echo \$\? > '\/tmp\/bastion\/job-j-0001\.log\.rc';/)
  assert.match(cmd, /\| tee -a '\/tmp\/bastion\/job-j-0001\.log'/)
  assert.match(cmd, /eb=\$\(cat '\/tmp\/bastion\/job-j-0001\.log\.rc' 2>\/dev\/null \|\| echo 1\)/)
  assert.match(cmd, /echo __BASTION_DONE_abc:\$eb$/)
})

test('不安全命令（可能弹密码）不加哨兵：只 tee，靠输出静止判完成', () => {
  const cmd = buildTeeCommand({ command: 'sudo systemctl restart nginx', logPath: P.logPath, rcPath: P.rcPath, dir: P.dir })
  assert.doesNotMatch(cmd, /__BASTION_DONE_/)
  assert.match(cmd, /tee -a/)
})

test('命令末尾的换行被去掉（否则 braces 里会多一条空命令，$? 变 0）', () => {
  const cmd = buildTeeCommand({ command: 'false\n\n', logPath: P.logPath, rcPath: P.rcPath, dir: P.dir, marker: 'M' })
  assert.match(cmd, /\{ false; echo \$\? > /)
  assert.doesNotMatch(cmd, /false\n/)
})

test('cat 日志的命令带偏移（扩展重启后按 offset 续读）', () => {
  assert.equal(tailLogCommand('/tmp/bastion/job-j-0001.log', 0, 1024), `tail -c +1 '/tmp/bastion/job-j-0001.log' | head -c 1024`)
  assert.match(tailLogCommand('/tmp/bastion/job-j-0001.log', 4096, 65536), /tail -c \+4097/)
  // 上限夹住，避免一次读爆
  assert.match(tailLogCommand('/tmp/bastion/job-j-0001.log', 0, 10 * 1024 * 1024), /head -c 262144/)
})
