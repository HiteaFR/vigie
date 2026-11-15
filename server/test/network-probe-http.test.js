// HTTP probe requests against FAKE servers on 127.0.0.1 (test subnet 127.0.0.0/8, with no special
// case for 127.x in the code). Real net.connect and fetch; no other address is touched. Hostile
// remote content: never stored or returned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../lib/config.js'
import { createNetStore } from '../lib/network/store.js'
import { createNetwork } from '../lib/network/index.js'
import { createAudit } from '../lib/auth.js'
import { parseDefs, httpGet, observeHost, createLimiter, recognise, HTTP_TIMEOUT_MS } from '../lib/network/probe.js'
import { tmpStore, tmpDir } from './tmpdir.js'
import { USER_AGENT } from '../lib/user-agent.js'
import { quiet } from './network-fixture.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCAL = '127.0.0.1'

// fake server: routes path → (req, res); log of received requests
async function fakeServer(routes) {
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers })
    const h = routes[req.url] ?? routes['*']
    if (h) return h(req, res)
    res.writeHead(404).end('introuvable')
  })
  srv.maxHeadersCount = 0
  await new Promise(r => srv.listen(0, LOCAL, r))
  const close = () => new Promise(r => {
    srv.closeAllConnections?.()
    srv.close(() => r())
  })
  return { srv, port: srv.address().port, seen, close }
}
const defsFor = (port, list) => parseDefs(JSON.stringify({ attribution: 'test', defs: list.map(([id, match]) => ({ id, name: id, category: 't', match })) }))

test('GET only, fixed headers, no cookie and no Authorization; real connect and fetch on the test subnet', async () => {
  const s = await fakeServer({ '/admin/': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Pi-hole</title>') })
  try {
    const defs = defsFor(s.port, [['ph', { allOf: [{ port: s.port }, { http: { port: s.port, path: '/admin/', contains: 'pi-hole' } }] }]])
    const obs = await observeHost(LOCAL, { defs, limiter: createLimiter() })
    assert.deepEqual([...obs.open], [s.port])
    assert.deepEqual([...recognise(defs, { open: obs.open, resp: obs.resp, portOwners: defs.portOwners })], [[s.port, { service: 'ph', confidence: 'high' }]])
    assert.equal(s.seen.length, 1)
    const r = s.seen[0]
    assert.equal(r.method, 'GET')
    assert.equal(r.url, '/admin/')
    assert.equal(r.headers['user-agent'], USER_AGENT)
    assert.equal(r.headers['accept-encoding'], 'identity')
    assert.equal(r.headers.cookie, undefined)
    assert.equal(r.headers.authorization, undefined)
  } finally {
    await s.close()
  }
})

// request timeout raised to 60 s: only canceling the read can close the connection before the
// test timeout (15 s)
test('10 MB body: cut at 64 KB, read canceled', { timeout: 15_000 }, async () => {
  let sent = 0
  // wait for the server-side "close" event, not a fixed delay
  let onClose
  const closed = new Promise(r => { onClose = r })
  const chunk = Buffer.alloc(64 * 1024, 'a')
  const s = await fakeServer({
    '/': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.on('close', onClose)
      const pump = () => {
        while (sent < 10 * 1024 * 1024) {
          sent += chunk.length
          if (!res.write(chunk)) return res.once('drain', pump)
        }
        res.end()
      }
      pump()
    },
  })
  try {
    const r = await httpGet(fetch, LOCAL, s.port, '/', new Set(), { timeoutMs: 60_000 })
    assert.equal(r.body.length, 64 * 1024)
    await closed // connection closed by the probe (otherwise: test timeout reached)
    assert.ok(sent < 10 * 1024 * 1024, `sent ${sent}`)
  } finally {
    await s.close()
  }
})

// injected timeout (150 ms) instead of a 1.9 to 3.5 s window; the error is indeed the abort on
// timeout (TimeoutError), never before the timeout; the probe keeps 2 s by default
test('trickled headers, then trickled body: aborted at the timeout (2 s by default)', async () => {
  assert.equal(HTTP_TIMEOUT_MS, 2000)
  const timers = []
  const s = await fakeServer({
    '/lent': (req, res) => {
      // headers never finished: one byte every 100 ms
      req.socket.write('HTTP/1.1 200 OK\r\n')
      timers.push(setInterval(() => req.socket.write('X'), 100))
    },
    '/corps': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      timers.push(setInterval(() => res.write('.'), 100))
    },
  })
  try {
    for (const p of ['/lent', '/corps']) {
      const t0 = Date.now()
      await assert.rejects(httpGet(fetch, LOCAL, s.port, p, new Set(), { timeoutMs: 150 }), e => e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError')
      const dt = Date.now() - t0
      // never before the timeout; upper bound at 10 times the timeout (load), far from the 2 s default
      assert.ok(dt >= 140 && dt < 1500, `${p}: ${dt} ms`)
    }
  } finally {
    timers.forEach(clearInterval)
    await s.close()
  }
})

test('gzip never decompressed: body ignored, substring not found', async () => {
  const s = await fakeServer({ '/': (req, res) => res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('bienvenue sur pi-hole')) })
  try {
    const r = await httpGet(fetch, LOCAL, s.port, '/')
    assert.equal(r.status, 200)
    assert.equal(r.body, '')
  } finally {
    await s.close()
  }
})

test('redirects: 301, 302, 303, 307, 308, to another IP, a name, https, another port, in a loop → never followed, status kept', async () => {
  const other = await fakeServer({ '*': (req, res) => res.writeHead(200).end('pi-hole') })
  const routes = { '/cible': (req, res) => res.writeHead(200).end('pi-hole') }
  for (const code of [301, 302, 303, 307, 308]) routes[`/r${code}`] = (req, res) => res.writeHead(code, { location: '/cible' }).end('pi-hole ici aussi ?')
  const targets = {
    '/ip': 'http://192.0.2.1/', '/nom': 'http://pi-hole.example.net/', '/https': `https://${LOCAL}/`,
    '/port': `http://${LOCAL}:${other.port}/`, '/boucle': '/boucle',
  }
  for (const [p, loc] of Object.entries(targets)) routes[p] = (req, res) => res.writeHead(302, { location: loc }).end()
  const s = await fakeServer(routes)
  try {
    for (const code of [301, 302, 303, 307, 308]) assert.equal((await httpGet(fetch, LOCAL, s.port, `/r${code}`)).status, code)
    for (const p of Object.keys(targets)) assert.equal((await httpGet(fetch, LOCAL, s.port, p)).status, 302, p)
    assert.ok(!s.seen.some(x => x.url === '/cible'))
    assert.equal(s.seen.filter(x => x.url === '/boucle').length, 1)
    assert.equal(other.seen.length, 0, 'other port never contacted')
  } finally {
    await s.close()
    await other.close()
  }
})

test('20 KB header, invalid UTF-8: no crash; named headers only, ≤ 1024 characters', async () => {
  const s = await fakeServer({
    '/gros': (req, res) => res.writeHead(200, { server: 'Caddy'.padEnd(20 * 1024, 'x'), 'x-autre': 'secret' }).end('ok'),
    '/moyen': (req, res) => res.writeHead(200, { server: 'Caddy'.padEnd(4000, 'y') }).end('ok'),
    '/utf8': (req, res) => res.writeHead(200).end(Buffer.concat([Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(' Pi-hole ')])),
  })
  try {
    // 20 KB: rejected by fetch or read truncated, never an uncaught exception
    const defs = defsFor(s.port, [['h', { header: { port: s.port, path: '/gros', name: 'server', contains: 'caddy' } }]])
    const obs = await observeHost(LOCAL, { defs, limiter: createLimiter() })
    const r = obs.resp(s.port, '/gros')
    assert.ok(r === null || r.headers.server.length <= 1024)
    const m = await httpGet(fetch, LOCAL, s.port, '/moyen', new Set(['server']))
    assert.equal(m.headers.server.length, 1024)
    assert.ok(m.headers.server.startsWith('caddy'))
    assert.deepEqual(Object.keys(m.headers), ['server'])
    const u = await httpGet(fetch, LOCAL, s.port, '/utf8')
    assert.ok(u.body.includes('�'))
    assert.ok(u.body.includes('pi-hole'))
  } finally {
    await s.close()
  }
})

test('hostile content: never stored or returned (database, record, view, audit)', async () => {
  const EVIL = 'PWNED-7f3a<script>alert(1)</script>\u0007\u001b[31m'
  const HDR = 'PWNED-7f3a<script>alert(1)</script>' // a header cannot carry a control character
  const s = await fakeServer({ '*': (req, res) => res.writeHead(200, { server: HDR, 'set-cookie': `c=${HDR}` }).end(`${EVIL} pi-hole ${EVIL}`) })
  try {
    const dir = tmpDir('dash-defs-')
    const defsFile = path.join(dir, 'defs.json')
    fs.writeFileSync(defsFile, JSON.stringify({ attribution: 'test', defs: [
      { id: 'web', name: 'Web', category: 't', match: { allOf: [{ port: s.port }, { http: { port: s.port, path: '/', contains: 'pi-hole' } }] } },
      { id: 'hdr', name: 'Hdr', category: 't', match: { header: { port: s.port, path: '/x', name: 'server', contains: 'pwned' } } },
    ] }))
    const { config: cfg, errors } = parseConfig({
      version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' }, proxmox: [],
      hosts: [{ id: 'loc', name: 'loc', kind: 'appliance', ip: LOCAL, env: 'prod' }],
      network: { subnets: [{ cidr: '127.0.0.0/8', name: 'test' }], sources: { pve: false }, probe: { enabled: true } },
    })
    assert.ok(!errors, errors?.join('\n'))
    const store = tmpStore('dash-probe-http-')
    const ns = createNetStore(store)
    const T = Date.now()
    ns.applyOps([
      { op: 'insertDevice', ref: 'n', fields: { state: 'known', review: 0, origin: 'config', host_id: 'loc', host_src: 'config', disp_name: 'loc', primary_mac: '00:00:5e:00:53:01', last_ip: LOCAL, online: 1, created_at: T, updated_at: T } },
      { op: 'upsertMac', mac: '00:00:5e:00:53:01', device: 'n', grade: 'hypervisor', random: 0, first_seen: T, last_seen: T, last_ip: LOCAL, attach: 'config' },
    ])
    const network = createNetwork({ cfg, store, audit: createAudit(store), log: quiet, probeOptions: { defsFile } })
    const d = [...ns.load().devices.values()][0]
    await network.probe.probeDevice(d, 'admin')
    assert.deepEqual(store.db.prepare('SELECT port, service, confidence FROM net_ports').all().map(r => ({ ...r })), [{ port: s.port, service: 'web', confidence: 'high' }])
    assert.equal(s.seen.length, 2)
    const dump = []
    for (const { name } of store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      dump.push(JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all()))
    }
    const out = [dump.join('\n'), JSON.stringify(network.device(d.id, { admin: true })), JSON.stringify(network.view({ admin: true })), network.digestLines().join('\n')].join('\n').toLowerCase()
    assert.ok(!out.includes('pwned'))
    assert.ok(!out.includes('<script>'))
    assert.ok(!out.includes('\u001b') && !out.includes('\u0007'))
  } finally {
    await s.close()
  }
})

test('static checks: no node:https, node:dns, child_process, undici, rejectUnauthorized or require(; no added dependency', () => {
  const src = fs.readFileSync(path.join(HERE, '../lib/network/probe.js'), 'utf8')
  for (const bad of ['node:https', "'https'", 'node:dns', "'dns'", 'child_process', 'undici', 'rejectUnauthorized', 'require(', 'eval(', 'new Function']) {
    assert.ok(!src.includes(bad), bad)
  }
  assert.match(src, /lookup: noDns/)
  assert.match(src, /redirect: 'manual'/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '../package.json'), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'undici', 'zod'])
  assert.equal(pkg.devDependencies, undefined)
  // definitions: no regular expression, no reference between definitions
  const defs = fs.readFileSync(path.join(HERE, '../lib/network/service-defs.json'), 'utf8')
  assert.doesNotMatch(defs, /"(regex|pattern|ref|\$ref)"/)
})
