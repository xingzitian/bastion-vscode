// 高危命令识别：该报的要报，不该报的绝不能报（误报会让人无脑点确认）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDangerous, isDangerous, describeDanger, findDangerousIn, BUILTIN_DANGER_RULES } from '../danger'

test('必须拦下的：真正会毁机器的写法', () => {
  const mustBlock = [
    'rm -rf /',
    'rm -rf /*',
    'rm -fr /',
    'sudo rm -rf /',
    'rm -rf ~',
    'rm -rf ~/*',
    'rm -rf $HOME',
    'rm -rf ${HOME}',
    'reboot',
    'sudo shutdown -h now',
    'poweroff',
    'halt',
    'init 0',
    'mkfs.ext4 /dev/sdb1',
    'wipefs -a /dev/sdb',
    'dd if=/dev/zero of=/dev/sda',
    'dd if=x of=/dev/nvme0n1 bs=1M',
    'echo x > /dev/sda',
    'chmod -R 777 /',
    'chown -R nobody /',
    'mv /etc /tmp/x',
    ':(){ :|:& };:',
    'truncate -s 0 /dev/sda',
    'shred -n 3 /dev/sda',
    'killall5'
  ]
  for (const cmd of mustBlock) {
    assert.equal(isDangerous(cmd), true, `应该判定为高危：${cmd}`)
  }
})

test('绝不能误报的：正常运维命令（旧版在这里翻过车）', () => {
  const mustPass = [
    'rm -rf /tmp/build',       // 旧版规则会把这个误判成删根目录
    'rm -rf ./node_modules',
    'rm -f /var/log/app.log',
    'rm -rf /data/old',
    'chmod 755 /opt/app',
    'chmod -R 755 /var/www',
    'chown -R app:app /srv/app',
    'df -h /',
    'du -sh /*',
    'ls -l /etc/nginx',
    'mv /tmp/a /tmp/b',
    'mv /var/log/app.log /var/log/app.log.bak',
    'systemctl restart nginx',
    'systemctl isolate multi-user.target', // 合法的目标切换，不该报
    'docker compose down',
    'killall nginx',          // 只杀同名进程，不是 killall5
    'dd if=/dev/sda of=/backup.img', // 备份方向，是安全的
    'truncate -s 100M /data/big.img',
    'echo hello > /tmp/x',
    'git clean -fd'
  ]
  for (const cmd of mustPass) {
    const hits = findDangerous(cmd)
    assert.equal(hits.length, 0, `不该判定为高危：${cmd}（命中 ${hits.map((h) => h.id).join(',')}）`)
  }
})

test('空 / 空白命令不报', () => {
  assert.equal(isDangerous(''), false)
  assert.equal(isDangerous('   '), false)
  assert.equal(findDangerous('').length, 0)
})

test('命中项带 id、原因、命中的原文，供用户自己判断', () => {
  const hits = findDangerous('sudo rm -rf /')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'rm-root')
  assert.match(hits[0].why, /删除根目录/)
  assert.match(hits[0].matched, /rm -rf \//)
})

test('一条命令能同时命中多条规则', () => {
  const hits = findDangerous('reboot && mkfs.ext4 /dev/sdb')
  const ids = hits.map((h) => h.id).sort()
  assert.deepEqual(ids, ['mkfs', 'reboot'])
})

test('describeDanger 生成可读原因', () => {
  const text = describeDanger(findDangerous('rm -rf /'))
  assert.match(text, /·/)
  assert.match(text, /删除根目录/)
  assert.match(text, /rm -rf \//)
  assert.equal(describeDanger([]), '')
})

test('重复命中会被去重（同一规则同一片段只报一次）', () => {
  const hits = findDangerous('rm -rf /; rm -rf /')
  // 规则只报第一条命中，所以这里只有一条；关键是 describe 不重复刷屏
  const text = describeDanger([...hits, ...hits])
  assert.equal(text.split('\n').length, hits.length)
})

test('findDangerousIn：按字段汇总（部署任务的 preCommand + script）', () => {
  const got = findDangerousIn([
    { label: '前置命令', text: 'cd /etc && ls' },
    { label: '执行脚本', text: 'rm -rf /' }
  ])
  assert.equal(got.length, 1, '只有命中的那段会被列出')
  assert.equal(got[0].label, '执行脚本')
  assert.equal(got[0].hits[0].id, 'rm-root')
})

test('多行脚本里能查出隐患', () => {
  const script = ['set -e', 'systemctl stop nginx', 'dd if=/dev/zero of=/dev/sda bs=1M', 'echo done'].join('\n')
  const got = findDangerousIn([{ label: '执行脚本', text: script }])
  assert.equal(got.length, 1)
  assert.equal(got[0].hits[0].id, 'dd-dev')
})

test('规则表本身健康：都有 id / 原因 / 非全局正则', () => {
  assert.ok(BUILTIN_DANGER_RULES.length > 0)
  const ids = new Set<string>()
  for (const r of BUILTIN_DANGER_RULES) {
    assert.ok(r.id, '每条规则要有 id')
    assert.ok(r.why, `${r.id} 要有 why`)
    assert.equal(r.re.global, false, `${r.id} 不能带 /g（lastIndex 有状态会漏报）`)
    assert.equal(ids.has(r.id), false, `id 重复：${r.id}`)
    ids.add(r.id)
  }
})
