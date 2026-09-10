// 部署执行里唯一不依赖终端的那块：命令按行拆分。
// 逐行执行是「把每条命令的输出对应起来写进报告」的前提 ——
// 整段 write 只能得到一坨混在一起的输出，事后没法复盘。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitCommandLines } from '../deployRun'

test('按行拆分，去掉空行', () => {
  assert.deepEqual(splitCommandLines('a\nb\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitCommandLines('a\n\n\nb'), ['a', 'b'])
})

test('兼容 CRLF 与 CR（任务文件可能是 Windows 上写的）', () => {
  assert.deepEqual(splitCommandLines('sudo -i\r\ncd /etc'), ['sudo -i', 'cd /etc'])
  assert.deepEqual(splitCommandLines('a\rb'), ['a', 'b'])
})

test('去掉每行首尾空白（缩进写的脚本也能跑）', () => {
  assert.deepEqual(splitCommandLines('  cd /etc  \n\tls -l\t'), ['cd /etc', 'ls -l'])
})

test('只有空白的行被丢掉', () => {
  assert.deepEqual(splitCommandLines('   \n\t\n'), [])
  assert.deepEqual(splitCommandLines(''), [])
})

test('常见的 sudo -i + cd 写法拆成两行（第一行走兜底、第二行能精确捕获输出）', () => {
  assert.deepEqual(splitCommandLines('sudo -i\ncd /etc'), ['sudo -i', 'cd /etc'])
})

test('命令内部的分号/管道不会被拆开（一行仍是一条命令）', () => {
  assert.deepEqual(splitCommandLines('cd /etc && ls -l | head -5; echo done'), ['cd /etc && ls -l | head -5; echo done'])
})

test('多行脚本保持原顺序（顺序错了部署就错了）', () => {
  const script = ['set -e', 'systemctl stop nginx', 'cp -f /tmp/a.conf /etc/a.conf', 'systemctl start nginx'].join('\n')
  assert.deepEqual(splitCommandLines(script), [
    'set -e',
    'systemctl stop nginx',
    'cp -f /tmp/a.conf /etc/a.conf',
    'systemctl start nginx'
  ])
})
