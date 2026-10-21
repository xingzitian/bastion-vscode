// 真起一个 HTTP 端点，验证 dual-era 的 wire 行为（含 2026-07-28 的状态码要求）。
const { startMcpHttpServer } = require('../out/mcpServer.js')

const api = {
  listSessions: async () => '会话列表',
  listProfiles: async () => '档案列表',
  use: async () => '已绑定',
  exec: async () => ({ text: '命令输出', structured: { status: 'completed', exitCode: 0 } }),
  wait: async () => ({ text: '等作业' }),
  job: async () => ({ text: '日志' }),
  cancel: async () => ({ text: '已取消' }),
  connect: async () => '已连接',
  habits: async () => '习惯',
  health: async () => '自检正常',
  tail: async () => '屏幕',
  push: async () => '已上传',
  pull: async () => '已下载'
}

async function post(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test-token-0123456789', ...headers },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

const modernMeta = (caps = {}, version = '2026-07-28') => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': caps
  }
})

const rows = []
const add = (...cells) => rows.push(cells.join(' | '))

;(async () => {
  const h = await startMcpHttpServer({
    api,
    token: 'test-token-0123456789',
    clients: [],
    port: 0,
    serverName: 'bastionshell',
    serverVersion: '0.3.10'
  })
  const p = h.port
  try {
    const a = await post(p, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } })
    add('legacy initialize', a.status, a.json.result?.protocolVersion, a.json.result?.resultType === undefined ? 'ok(no resultType)' : 'BAD')

    const b = await post(p, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    add('legacy tools/list', b.status, `tools=${b.json.result?.tools?.length}`, b.json.result?.resultType === undefined ? 'ok(no resultType)' : 'BAD')

    const c = await post(p, { jsonrpc: '2.0', id: 3, method: 'server/discover', params: modernMeta() }, { 'MCP-Protocol-Version': '2026-07-28' })
    add('modern server/discover', c.status, `resultType=${c.json.result?.resultType}`, `versions=${(c.json.result?.supportedVersions || []).join(',')}`, `tasks=${!!c.json.result?.capabilities?.extensions?.['io.modelcontextprotocol/tasks']}`, `ttlMs=${c.json.result?.ttlMs}`, `cacheScope=${c.json.result?.cacheScope}`)

    const d = await post(p, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: modernMeta() }, { 'MCP-Protocol-Version': '2026-07-28' })
    add('modern tools/list', d.status, `resultType=${d.json.result?.resultType}`, `tools=${d.json.result?.tools?.length}`, `ttlMs=${d.json.result?.ttlMs}`)

    const e = await post(p, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: modernMeta({}, '1900-01-01') }, { 'MCP-Protocol-Version': '1900-01-01' })
    add('unsupported version', e.status + ' (want 400)', `code=${e.json.error?.code} (want -32022)`, `supported=${(e.json.error?.data?.supported || []).length}`)

    const f = await post(p, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bastion_listSessions', arguments: {}, ...modernMeta() } }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'bastion_listSessions' })
    add('modern tools/call', f.status, `resultType=${f.json.result?.resultType}`, `isError=${f.json.result?.isError ?? false}`)

    const g = await post(p, { jsonrpc: '2.0', id: 7, method: 'nope/nothing', params: modernMeta() }, { 'MCP-Protocol-Version': '2026-07-28' })
    add('unknown method modern', g.status + ' (want 404)', `code=${g.json.error?.code} (want -32601)`)

    const gl = await post(p, { jsonrpc: '2.0', id: 8, method: 'nope/nothing' })
    add('unknown method legacy', gl.status + ' (want 200)', `code=${gl.json.error?.code}`)

    const hm = await post(p, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: modernMeta() }, { 'MCP-Protocol-Version': '2025-06-18' })
    add('header mismatch', hm.status + ' (want 400)', `code=${hm.json.error?.code} (want -32020)`)

    const ro = await post(p, { jsonrpc: '2.0', id: 10, method: 'tools/list' }, { 'MCP-Protocol-Version': '2026-07-28' })
    add('header only (no _meta)', ro.status, `resultType=${ro.json.result?.resultType} (want complete)`, 'modern via header')

    const noAuth = await fetch(`http://127.0.0.1:${p}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    add('no token', noAuth.status + ' (want 401)')
  } finally {
    h.close?.()
  }
  for (const r of rows) console.log(r)
  setTimeout(() => process.exit(0), 150)
})()
