// CLI 宿主：habit 写共享文件必须落在指定目录（不能碰真实 ~/.bastionshell）。
//
// 这条测试的意义：`bastion_habits` 是唯一会**写共享配置文件**的工具，
// 写错地方会污染用户真实习惯（桌面版和扩展都读同一份）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CliHost, type CliSessionEntry } from '../cli/host'
import { EngineSession, type ShellChannel } from '../engine/session'
import type { EngineProfile } from '../engine/profiles'

function fakeChannel(): ShellChannel {
  return {
    write: () => undefined,
    on: () => undefined,
    setWindow: () => undefined
  }
}

function entry(name = 'demo'): CliSessionEntry {
  const profile: EngineProfile = {
    name,
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'key',
    mode: 'direct'
  }
  return { id: `s-${name}`, profile, session: new EngineSession(name, fakeChannel()) }
}

test('habits: 写进 BASTIONSHELL_SHARED_DIR 里的 habits.jsonc（不碰真实目录）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-habits-'))
  process.env.BASTIONSHELL_SHARED_DIR = dir
  try {
    const host = new CliHost({ sessions: [entry('demo')], version: 't' })
    const api = host.api()

    const msg = await api.habits({ action: 'remember', habit: '这台机器的 nginx 在 /opt/nginx' })
    assert.match(msg, /已记下/)

    const priv = await api.habits({ action: 'setPrivilege', privilege: 'sudo' })
    assert.match(priv, /提权习惯=sudo/)

    const f = path.join(dir, 'habits.jsonc')
    assert.ok(fs.existsSync(f), '应该写到临时目录里的 habits.jsonc')
    const text = fs.readFileSync(f, 'utf8')
    assert.match(text, /nginx/)
    assert.match(text, /"demo"/)

    // 读回来（同一个宿主）要能看到刚写的东西
    const read = await api.habits({ action: 'read' })
    assert.match(read, /nginx/)
  } finally {
    delete process.env.BASTIONSHELL_SHARED_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('habits: 非法参数给可读错误，不静默成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-habits2-'))
  process.env.BASTIONSHELL_SHARED_DIR = dir
  try {
    const api = new CliHost({ sessions: [entry()], version: 't' }).api()
    assert.match(await api.habits({ action: 'remember' }), /需要 habit/)
    assert.match(await api.habits({ action: 'setPrivilege', privilege: 'bogus' }), /只能是/)
    assert.match(await api.habits({ action: 'nope' }), /未知 action/)
  } finally {
    delete process.env.BASTIONSHELL_SHARED_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
