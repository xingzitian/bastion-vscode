// 命令摘要与叙事（why）：面板/账本的"人能看懂"这一层，必须先钉死语义
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWhy, redactSecrets, splitCommand, summarizeCommand } from '../commandSummary'

test('拆段：尊重引号，不把 echo "a && b" 拆成两段', () => {
  assert.deepEqual(splitCommand('echo "a && b"'), ['echo "a && b"'])
  assert.deepEqual(splitCommand('cd /x && git pull'), ['cd /x', 'git pull'])
  assert.deepEqual(splitCommand('a; b | c || d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(splitCommand('ls\npwd'), ['ls', 'pwd'])
  assert.deepEqual(splitCommand('   '), [])
})

test('★ 长命令串：拆成步骤、每步只留"动词 + 目标"', () => {
  const s = summarizeCommand('cd /data/app && git pull && npm ci && systemctl restart app')
  assert.equal(s.steps, 4)
  assert.equal(s.brief, '4 步：cd · git pull · npm ci · systemctl restart')
  assert.equal(s.raw, 'cd /data/app && git pull && npm ci && systemctl restart app', '原文要保留（面板展开用）')
})

test('★ ssh -p 2222 host 不能显示成 "ssh 2222"（旗标的值要跳过）', () => {
  assert.equal(summarizeCommand('ssh -p 2222 root@10.0.0.9').brief, 'ssh root@10.0.0.9')
})

test('sudo / env 前缀被跳过，摘要从真正的命令开始', () => {
  assert.equal(summarizeCommand('sudo systemctl restart nginx').brief, 'systemctl restart')
  assert.equal(summarizeCommand('FOO=1 BAR=2 docker ps -a').brief, 'docker ps')
})

test('管道链：每段一个动作', () => {
  assert.equal(summarizeCommand('cat /var/log/app.log | grep -i error | tail -n 20').brief, '3 步：cat · grep · tail')
})

test('★ 凭据脱敏：长参数名 / -pXXX / -u user:pass / NAME=xxx', () => {
  const cases: Array<[string, RegExp]> = [
    ['mysql --password=S3cret -uroot', /--password=\*\*\*/],
    ['mysql -pS3cret -uroot', /-p\*\*\*/],
    ['curl -u admin:S3cret https://x', /-u admin:\*\*\*/],
    ['export API_TOKEN=abcd1234 && echo ok', /API_TOKEN=\*\*\*/],
    ['MYSQL_PWD=hunter2 mysqldump db', /MYSQL_PWD=\*\*\*/]
  ]
  for (const [cmd, re] of cases) {
    const r = redactSecrets(cmd)
    assert.equal(r.redacted, true, `${cmd} 应该被脱敏`)
    assert.match(r.text, re)
  }
})

test('★ 端口不能被误伤：ssh -p 22 / -p22', () => {
  assert.equal(redactSecrets('ssh -p 22 root@h').redacted, false)
  assert.equal(redactSecrets('ssh -p22 root@h').redacted, false)
  // 证据：摘要里端口还在
  assert.match(summarizeCommand('ssh -p 22 root@h').brief, /22|root@h/)
})

test('摘要里的 raw 是脱敏后的文本（落盘/上屏都安全）', () => {
  const s = summarizeCommand('mysql -pS3cret -e "select 1"')
  assert.equal(s.redacted, true)
  assert.ok(!s.raw.includes('S3cret'), 'raw 里不能有明文密码')
  assert.match(s.raw, /-p\*\*\*/)
})

test('高危片段由调用方注入（纯函数不自己读配置）', () => {
  const hits = summarizeCommand('rm -rf /', () => [{ why: '删根', text: 'rm -rf /' }])
  assert.equal(hits.danger.length, 1)
  assert.equal(hits.danger[0].why, '删根')
  assert.equal(summarizeCommand('ls').danger.length, 0)
})

test('步骤太多：brief 截断并标记 truncated', () => {
  const cmd = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join(' && ')
  const s = summarizeCommand(cmd)
  assert.equal(s.steps, 8)
  assert.equal(s.truncated, true)
  assert.match(s.brief, /\+2$/, '超出部分显示 +N')
})

test('超长单步：单词被裁到 24 字，brief 不会超过 120 字', () => {
  // 注意：`echo <300 字>` 的摘要本来就只是 `echo`（目标太长没有信息量），所以这里用单 token 验证裁剪
  const s = summarizeCommand('x'.repeat(300))
  assert.ok(s.brief.length <= 120, `brief 太长：${s.brief.length}`)
  assert.match(s.brief, /…$/, '被裁的词要有省略号')
  assert.equal(summarizeCommand('echo ' + 'y'.repeat(300)).brief, 'echo', 'echo 的长参数不进摘要')
})

test('空命令不炸', () => {
  const s = summarizeCommand('')
  assert.equal(s.steps, 0)
  assert.equal(s.brief, '')
})

test('★ why 归一化：压空白、裁 60 字、空串保持空（面板据此显示"未说明"）', () => {
  assert.equal(normalizeWhy(undefined), '')
  assert.equal(normalizeWhy('   '), '')
  assert.equal(normalizeWhy('部署\n新版本   到两台'), '部署 新版本 到两台')
  const long = normalizeWhy('很'.repeat(200))
  assert.equal(long.length, 60)
  assert.match(long, /…$/)
})
