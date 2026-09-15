// 共享菜单规则文件（~/.bastionshell/menuHints.jsonc）：
// 「两个实现读同一份」这件事必须被钉住 —— 桌面版（Go）读的是同一个文件、同一套语义。
//
// 语义和 dangerRules.jsonc 刻意保持一致：
//   useBuiltin=false 只用 extra；disabled 按「组名 + 内置规则原文」精确关掉；extra 追加。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DEFAULT_MENU_HINTS, detectPrompt, resolveMenuHints } from '../menu'
import { mergeMenuHints, readMenuHintsOverride, resetMenuHintsCache, MENU_HINTS_FILE } from '../menuHintsFile'

/** 用户真机原文（和 menu.test.ts 里那份一致） */
const REAL_HOST_MENU = [
  '\t1) 输入 部分IP，主机名，备注 进行搜索登录(如果唯一).',
  '\t8) 输入 r 进行刷新最新的机器和节点信息.',
  '公告：示例生产堡垒机使用注意事项',
  'Opt> Opt>'
].join('\n')

function withSharedDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-menuhints-'))
  const old = process.env.BASTIONSHELL_SHARED_DIR
  process.env.BASTIONSHELL_SHARED_DIR = dir
  resetMenuHintsCache()
  try {
    fn(dir)
  } finally {
    resetMenuHintsCache()
    if (old === undefined) delete process.env.BASTIONSHELL_SHARED_DIR
    else process.env.BASTIONSHELL_SHARED_DIR = old
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeHints(dir: string, text: string): void {
  fs.writeFileSync(path.join(dir, MENU_HINTS_FILE), text)
  resetMenuHintsCache()
}

const noSettings = (): unknown => undefined

test('没有共享文件时行为不变：内置默认照旧（真机菜单仍认得出来）', () => {
  withSharedDir(() => {
    assert.deepEqual(readMenuHintsOverride(), {})
    assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt', resolveMenuHints(noSettings)), true)
  })
})

test('共享文件能追加自己那家堡垒机的提示语', () => {
  withSharedDir((dir) => {
    writeHints(dir, `{
      // 我们那家写法不一样
      "useBuiltin": true,
      "extra": [{"key": "hostPrompt", "pattern": "请选择要登录的主机"}]
    }`)
    const hints = resolveMenuHints(noSettings)
    assert.equal(detectPrompt('请选择要登录的主机', 'hostPrompt', hints), true, 'extra 规则应该生效')
    assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt', hints), true, '内置规则要留着')
  })
})

test('共享文件能按原文关掉某条内置规则', () => {
  withSharedDir((dir) => {
    writeHints(dir, `{
      "disabled": [{"key": "hostPrompt", "pattern": "进行搜索"}]
    }`)
    const hints = resolveMenuHints(noSettings)
    assert.equal(hints.hostPrompt.includes('进行搜索'), false, '被关掉的那条应该不在生效列表里')
    // ⚠️ 关掉一条 ≠ 这一屏认不出来了：真机主菜单那行同时命中多条内置规则
    assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt', hints), true)
  })
})

test('useBuiltin=false：只用 extra', () => {
  withSharedDir((dir) => {
    writeHints(dir, `{"useBuiltin": false, "extra": [{"key": "shellPrompt", "pattern": "^>>>"}]}`)
    const hints = resolveMenuHints(noSettings)
    assert.deepEqual(hints.shellPrompt, ['^>>>'])
    assert.equal(detectPrompt('deploy@web:~$', 'shellPrompt', hints), false, '内置规则不该生效')
    assert.equal(detectPrompt('>>>', 'shellPrompt', hints), true)
  })
})

test('VS Code 设置优先于共享文件（设置整组替换）', () => {
  withSharedDir((dir) => {
    writeHints(dir, `{"extra": [{"key": "hostPrompt", "pattern": "共享文件里的"}]}`)
    const hints = resolveMenuHints((k) => (k === 'hostPrompt' ? ['只有设置里的这一条'] : undefined))
    assert.deepEqual(hints.hostPrompt, ['只有设置里的这一条', '共享文件里的'], '设置基线 + 共享文件的追加')
  })
})

test('坏正则只跳过它自己，不连累其它规则', () => {
  withSharedDir((dir) => {
    writeHints(dir, `{"extra":[{"key":"hostPrompt","pattern":"([未闭合"},{"key":"hostPrompt","pattern":"我家堡垒机"}]}`)
    const hints = resolveMenuHints(noSettings)
    assert.equal(detectPrompt('我家堡垒机', 'hostPrompt', hints), true)
    assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt', hints), true, '内置规则不受影响')
  })
})

test('文件坏了要备份 .bak 并回退到内置默认（不静默吞掉，也不崩）', () => {
  withSharedDir((dir) => {
    writeHints(dir, '{ 这不是 JSON')
    const hints = resolveMenuHints(noSettings)
    assert.equal(detectPrompt(REAL_HOST_MENU, 'hostPrompt', hints), true, '坏文件时应该用内置默认')
    assert.equal(fs.existsSync(path.join(dir, MENU_HINTS_FILE + '.bak')), true, '坏文件应该被备份成 .bak')
  })
})

test('改完文件保存即生效（mtime 缓存要失效）', () => {
  withSharedDir((dir) => {
    assert.equal(detectPrompt('我家堡垒机', 'hostPrompt', resolveMenuHints(noSettings)), false)
    writeHints(dir, `{"extra":[{"key":"hostPrompt","pattern":"我家堡垒机"}]}`)
    assert.equal(detectPrompt('我家堡垒机', 'hostPrompt', resolveMenuHints(noSettings)), true, '用户改了文件不该要求重启')
  })
})

test('mergeMenuHints 是纯函数：不改动传入的默认表', () => {
  const before = JSON.stringify(DEFAULT_MENU_HINTS)
  const out = mergeMenuHints({}, {}, DEFAULT_MENU_HINTS)
  assert.equal(JSON.stringify(DEFAULT_MENU_HINTS), before, '内置默认不该被就地修改')
  assert.deepEqual(out.hostPrompt, DEFAULT_MENU_HINTS.hostPrompt)
})
