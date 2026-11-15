// Shared HTTP client (lib/http.js) and "vigie/<version>" User-Agent on ALL outgoing
// requests of the server (item of the pre-publication list).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHttp, boundTimeout, withUserAgent, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../lib/http.js'
import { USER_AGENT } from '../lib/user-agent.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('ctx.http: User-Agent enforced (never replaced), bounded delay, server TLS agent (secret, CA)', async () => {
  const calls = []
  const agents = []
  const http = createHttp({ fetch: async (url, o) => (calls.push({ url, o }), new Response('{}')), agentFor: (url, o) => (agents.push({ url, ...o }), 'agent') })
  await http('https://api.example.net/x', { headers: { 'User-Agent': 'autre', Accept: 'application/json' }, secret: true, ca: 'PEM', method: 'POST', body: 'b' })
  assert.equal(calls[0].o.headers.get('user-agent'), USER_AGENT)
  assert.equal(calls[0].o.headers.get('accept'), 'application/json')
  assert.equal(calls[0].o.method, 'POST')
  assert.equal(calls[0].o.dispatcher, 'agent')
  assert.ok(calls[0].o.signal instanceof AbortSignal)
  assert.deepEqual(agents[0], { url: 'https://api.example.net/x', secret: true, ca: 'PEM' })
  // no letter case replaces the User-Agent, and a Headers object is kept
  await http('https://api.example.net/z', { headers: { 'user-agent': 'autre/1', 'USER-AGENT': 'autre/2', 'x-a': '1' } })
  assert.deepEqual([...calls.at(-1).o.headers], [['user-agent', USER_AGENT], ['x-a', '1']])
  await http('https://api.example.net/z', { headers: new Headers({ 'X-Jeton-Public': 'p', 'User-Agent': 'autre/3' }) })
  assert.deepEqual([...calls.at(-1).o.headers], [['user-agent', USER_AGENT], ['x-jeton-public', 'p']])
  // secret: false by default here, true by default for plugins, and forced by Authorization or Cookie
  await http('https://api.example.net/s')
  assert.equal(agents.at(-1).secret, false)
  await http('https://api.example.net/s', { headers: { authorization: 'token x' }, secret: false })
  assert.equal(agents.at(-1).secret, true, 'Authorization: secret forced')
  await http('https://api.example.net/s', { headers: new Headers({ Cookie: 'sid=1' }) })
  assert.equal(agents.at(-1).secret, true, 'Cookie: secret forced')
  const agents2 = []
  const pluginHttp = createHttp({ fetch: async () => new Response(''), agentFor: (u, o) => (agents2.push(o), 'a'), defaultSecret: true })
  await pluginHttp('https://api.example.net/p')
  assert.equal(agents2[0].secret, true, 'plugins: secret by default')
  // dispatcher and signal provided by the caller ignored: only the server's
  await http('https://api.example.net/y', { dispatcher: 'pirate', signal: AbortSignal.timeout(999_999) })
  assert.equal(calls[1].o.dispatcher, 'agent')
  assert.equal(boundTimeout(undefined), DEFAULT_TIMEOUT_MS)
  assert.equal(boundTimeout(10 ** 9), MAX_TIMEOUT_MS)
  assert.equal(boundTimeout(-5), 100)
  assert.equal(boundTimeout('abc'), DEFAULT_TIMEOUT_MS)
  assert.deepEqual(withUserAgent({ 'User-Agent': 'x', A: '1' }), { A: '1', 'User-Agent': USER_AGENT })
  assert.match(USER_AGENT, /^vigie\/\d+\.\d+\.\d+$/)
})

test('User-Agent: every fetch call of the server carries vigie/<version> (code reading)', () => {
  const files = ['index.js', ...fs.readdirSync(path.join(SERVER, 'lib'), { recursive: true }).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)]
  const missing = []
  let calls = 0
  for (const f of files) {
    if (f === 'lib/http.js') continue
    const src = fs.readFileSync(path.join(SERVER, f), 'utf8')
    for (const m of src.matchAll(/\b(?:fetch|uFetch|doFetch)\(/g)) {
      // real call (not a definition nor a comment line)
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index))
      if (/^\s*\/\/|function |import /.test(line)) continue
      calls++
      // headers built right before the call (checks.js) or in its options
      const window = src.slice(Math.max(0, m.index - 200), m.index + 500)
      if (!/withUserAgent|USER_AGENT|'User-Agent': UA|\bUA\b/.test(window)) missing.push(`${f}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  assert.ok(calls >= 12, `${calls} calls found`)
  assert.deepEqual(missing, [], 'outgoing calls without User-Agent')
})
