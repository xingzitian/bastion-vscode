// P0b 的令牌管理（只测状态层，不真起服务）：签发 / 吊销 / 唯一性 / 主令牌不动。
import '../testkit/vscode-stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadOrCreateState, mcpClientTokens, removeClientToken, writeClientToken, writeState } from '../mcpRegister'
import { readJsonFile } from '../config'

function withTempShared(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-tokens-'))
  const old = process.env.BASTIONSHELL_SHARED_DIR
  process.env.BASTIONSHELL_SHARED_DIR = dir
  try {
    fn(dir)
  } finally {
    if (old === undefined) delete process.env.BASTIONSHELL_SHARED_DIR
    else process.env.BASTIONSHELL_SHARED_DIR = old
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('签发令牌：落进 mcp.json，主令牌保持不变', () => {
  withTempShared((dir) => {
    mcpClientTokens() // 先让状态文件建出来
    // 注意：mcp.json 是 JSONC（带注释头），必须用扩展自己的解析器，不能用 JSON.parse
    const read = (): { token: string; clients?: { label: string }[] } =>
      readJsonFile('mcp.json', { token: '' }, (v): v is { token: string } => !!v && typeof (v as { token?: unknown }).token === 'string') as { token: string; clients?: { label: string }[] }
    const before = read()
    const c = writeClientToken('claude', 'observer')
    assert.ok(!('error' in c))
    if (!('error' in c)) {
      assert.equal(c.label, 'claude')
      assert.equal(c.scope, 'observer')
      assert.ok(c.token.length >= 16, '令牌要够长')
    }
    const after = read()
    assert.equal(after.token, before.token, '签发新令牌不能动主令牌（否则老配置全失效）')
    assert.deepEqual((after.clients ?? []).map((x: { label: string }) => x.label), ['claude'])
    assert.equal(mcpClientTokens().length, 1)
  })
})

test('同一个标签不能签两次；不同标签的令牌互不相同', () => {
  withTempShared(() => {
    writeClientToken('trae', 'operator')
    const dup = writeClientToken('trae', 'full')
    assert.ok('error' in dup)
    if ('error' in dup) assert.match(dup.error, /已经有标签/)
    writeClientToken('another', 'observer')
    const ts = mcpClientTokens().map((c) => c.token)
    assert.equal(new Set(ts).size, ts.length, '每把令牌都要唯一')
  })
})

test('吊销：存在的返回 true 并真的消失；不存在的返回 false', () => {
  withTempShared(() => {
    writeClientToken('gone', 'observer')
    assert.equal(removeClientToken('gone'), true)
    assert.equal(mcpClientTokens().length, 0)
    assert.equal(removeClientToken('gone'), false)
  })
})

test('标签会归一化：带空格/大写的标签也能吊销（用同样的归一化规则）', () => {
  withTempShared(() => {
    writeClientToken('My AI', 'observer') // 内部会归一化成 my_AI
    assert.equal(mcpClientTokens().length, 1)
    assert.equal(removeClientToken('my_ai'), true, '归一化后应该对得上')
  })
})

test('★ 回归：写回状态时不能把已签发的令牌丢掉（真机上"签发后看不见"就是这条）', () => {
  withTempShared(() => {
    writeClientToken('claude', 'observer')
    assert.equal(mcpClientTokens().length, 1, '签发之后应该能看到')
    // 模拟 ensureMcpServer 启动成功后那次写回：只带 token/port/actualPort/url，**不带 clients**
    const st = loadOrCreateState()
    writeState({ token: st.token, port: st.port })
    assert.equal(mcpClientTokens().length, 1, '写完状态之后令牌必须还在')
    assert.equal(mcpClientTokens()[0].label, 'claude')
  })
})
