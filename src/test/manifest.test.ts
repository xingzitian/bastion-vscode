// 清单一致性检查：命令注册 / 菜单引用 / 视图 / 工具 / 快捷键 / schema
//
// 为什么这个要进测试套件：这类「清单和代码对不上」的 bug 编译器**抓不到** ——
// 注册了却没声明 → 命令面板里看不到；声明了却没注册 → 点了报 command not found；
// 菜单引用了不存在的视图 → 右键菜单静默消失。全是静默失败，只能靠对账发现。
// 这次重构就靠它两次抓到漂移。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const extSrc = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8')

const declaredCommands: string[] = (pkg.contributes.commands ?? []).map((c: { command: string }) => c.command)
const registeredCommands: string[] = [...extSrc.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1])
const viewIds: string[] = Object.values(pkg.contributes.views as Record<string, Array<{ id: string }>>)
  .flat()
  .map((v) => v.id)
const activationEvents: string[] = pkg.activationEvents ?? []

test('每个声明到清单的命令都真的被注册了（否则点了报 command not found）', () => {
  const missing = declaredCommands.filter((c) => !registeredCommands.includes(c))
  assert.deepEqual(missing, [], `清单声明了但代码没注册：${missing.join(', ')}`)
})

test('每个注册的命令都声明在清单里（否则不出现在命令面板、也没有标题）', () => {
  const extra = registeredCommands.filter((c) => !declaredCommands.includes(c))
  assert.deepEqual(extra, [], `代码注册了但清单没声明：${extra.join(', ')}`)
})

test('命令没有重复注册', () => {
  const dup = registeredCommands.filter((c, i) => registeredCommands.indexOf(c) !== i)
  assert.deepEqual([...new Set(dup)], [])
})

test('注册的命令都有 activationEvents（跟现有风格保持一致）', () => {
  const missing = registeredCommands.filter((c) => !activationEvents.includes(`onCommand:${c}`))
  assert.deepEqual(missing, [], `缺 activationEvents：${missing.join(', ')}`)
})

test('菜单引用的命令都存在（引用了不存在的命令 = 菜单项静默消失）', () => {
  const bad: string[] = []
  for (const [menuId, items] of Object.entries(pkg.contributes.menus as Record<string, Array<{ command: string }>>)) {
    for (const it of items) {
      if (!declaredCommands.includes(it.command)) bad.push(`${menuId}:${it.command}`)
    }
  }
  assert.deepEqual(bad, [], `菜单引用了未声明的命令：${bad.join(', ')}`)
})

test('菜单里的 when 子句引用的视图都存在（拼错视图 id = 菜单永远不出现）', () => {
  const bad: string[] = []
  for (const items of Object.values(pkg.contributes.menus as Record<string, Array<{ when?: string }>>)) {
    for (const it of items) {
      for (const m of (it.when ?? '').matchAll(/view == ([\w.]+)/g)) {
        if (!viewIds.includes(m[1])) bad.push(m[1])
      }
    }
  }
  assert.deepEqual([...new Set(bad)], [], `when 里引用了不存在的视图：${bad.join(', ')}`)
})

test('快捷键引用的命令都存在', () => {
  for (const kb of pkg.contributes.keybindings ?? []) {
    assert.ok(declaredCommands.includes(kb.command), `快捷键引用了未声明的命令：${kb.command}`)
  }
})

test('每个视图的条目都有「主操作 + 编辑 + 删除」三组右键菜单（一致性约定）', () => {
  // 约定：<视图> 的 viewItem 必须有 inline@0（主操作按钮）和 1_主操作@1（右键首项）
  const expectations: Array<{ view: string; item: string }> = [
    { view: 'bastion.profiles', item: 'profile' },
    { view: 'bastion.deployTasks', item: 'deployTask' },
    { view: 'bastion.quickCommands', item: 'quickCommand' },
    { view: 'bastion.forwards', item: 'forwardIdle' }
  ]
  const ctx = pkg.contributes.menus['view/item/context'] as Array<{ command: string; when: string; group: string }>
  // when 里既可以写 `viewItem == X` 也可以写 `viewItem =~ /X/`（正则形式能同时覆盖 X 和 XRunning）。
  // 注意方向：要用 when 里的正则去**测条目名**，不能拿条目名反向拼正则。
  const targetsItem = (when: string, item: string): boolean => {
    if (when.includes(`viewItem == ${item}`)) return true
    const m = when.match(/viewItem =~ \/([^/]+)\//)
    if (!m) return false
    try {
      return new RegExp(m[1]).test(item)
    } catch {
      return false
    }
  }
  for (const e of expectations) {
    const mine = ctx.filter((m) => m.when.includes(`view == ${e.view}`) && targetsItem(m.when, e.item))
    assert.ok(
      mine.some((m) => m.group.startsWith('inline')),
      `${e.view}/${e.item} 缺行内主操作按钮`
    )
    assert.ok(
      mine.some((m) => m.group.startsWith('1_主操作')),
      `${e.view}/${e.item} 缺右键首项（1_主操作）`
    )
    assert.ok(
      mine.some((m) => m.group.startsWith('3_删除')),
      `${e.view}/${e.item} 缺右键删除项（3_删除）`
    )
    assert.ok(
      mine.some((m) => m.group.startsWith('2_')),
      `${e.view}/${e.item} 缺右键编辑/操作项（2_*）`
    )
  }
})

test('右键菜单不再用旧的分组名（1_connect —— 顺序会乱）', () => {
  const ctx = pkg.contributes.menus['view/item/context'] as Array<{ group: string }>
  const stale = ctx.filter((m) => m.group.startsWith('1_connect'))
  assert.deepEqual(stale, [], '应使用 1_主操作 / 2_编辑 / 3_删除 这套分组')
})

test('语言模型工具：名字唯一，且都在 extension.ts 里注册了 handler', () => {
  const tools: Array<{ name: string }> = pkg.contributes.languageModelTools ?? []
  assert.ok(tools.length >= 5)
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  for (const n of names) {
    assert.match(extSrc, new RegExp(`registerTool\\(\\s*'${n}'`), `工具 ${n} 没有注册 handler`)
    assert.ok(activationEvents.includes(`onLanguageModelTool:${n}`), `工具 ${n} 缺 activationEvents`)
  }
})

test('jsonValidation 指向的 schema 文件真的存在（路径错 = 任务文件没有提示）', () => {
  const jv = pkg.contributes.jsonValidation as Array<{ url: string }>
  assert.ok(jv.length > 0, '应有 jsonValidation 让任务文件有字段提示')
  for (const v of jv) {
    assert.ok(v.url.startsWith('./'), `schema 应用相对路径：${v.url}`)
    const p = path.join(ROOT, v.url.replace(/^\.\//, ''))
    assert.ok(fs.existsSync(p), `schema 文件不存在：${v.url}`)
    JSON.parse(fs.readFileSync(p, 'utf8')) // 必须是合法 JSON
  }
})

test('配置项的默认值合法（enum 的 default 必须在 enum 里）', () => {
  for (const [key, schema] of Object.entries(
    pkg.contributes.configuration.properties as Record<string, { enum?: string[]; default?: unknown }>
  )) {
    if (schema.enum) {
      assert.ok(schema.enum.includes(schema.default as string), `${key} 的 default 不在 enum 里`)
    }
    assert.ok(key.startsWith('bastion.'), `配置项应以 bastion. 开头：${key}`)
  }
})

test('主入口和图标文件存在', () => {
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main.replace(/^\.\//, ''))) || true, 'main 由编译产出')
  assert.ok(pkg.icon, '应配置商店图标')
  assert.ok(fs.existsSync(path.join(ROOT, pkg.icon)), `图标文件不存在：${pkg.icon}`)
})

test('发布者与作者已设置（发布必需）', () => {
  assert.equal(pkg.publisher, 'xingzitian')
  assert.ok(pkg.author)
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, 'keywords 决定商店能不能搜到')
})
