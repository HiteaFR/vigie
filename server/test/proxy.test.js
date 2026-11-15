// Dashboard behind the proxy.
// clientIp and viaHttps as pure functions, auth.login with fake requests (checked with a
// spy), and a local HTTP bench: the test server declares 127.0.0.2 trusted, the fake proxy
// connects FROM 127.0.0.2 (localAddress) and sets X-Forwarded-For and X-Forwarded-Proto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { clientIp, viaHttps, PROXY_NO_XFF, hostGuard, allowedHostsOf, sameOrigin, createAuth, createAudit, hashPassword, ipAllowed, parseCidrs } from '../lib/auth.js'
import { parseConfig } from '../lib/config.js'
import { tmpStore } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const T = Date.parse('2026-10-27T18:00:00Z')
const DAY = 86400_000
const PROXY = '192.0.2.153'
const GOOD = 'mot de passe de test'
const HASH = await hashPassword(GOOD)
// allowed network (LAN of the example), plus the loopback of the HTTP bench (the fake proxy 127.0.0.2
// is in it, as .243 is in the LAN: a fallback to the proxy socket would be ALLOWED)
const CIDRS = '192.0.2.0/24,100.64.0.0/10,127.0.0.0/8'

// fake request: socket, headers (lowercase names), TLS
const req = (remoteAddress, headers = {}, encrypted = false) => ({
  socket: { remoteAddress, encrypted },
  get: k => headers[k.toLowerCase()],
  is: () => true,
  headers,
})

// --- clientIp and viaHttps, pure functions -----------------------------------------------------------

test('DIRECT client (socket outside trustedProxies) with forged X-Forwarded-For → the socket', () => {
  for (const xff of ['192.0.2.77', '192.0.2.77, 1.2.3.4', '']) {
    assert.equal(clientIp(req('192.0.2.30', { 'x-forwarded-for': xff }), [PROXY]), '192.0.2.30', xff)
  }
  assert.equal(clientIp(req('::ffff:192.0.2.30', { 'x-forwarded-for': '192.0.2.77' }), [PROXY]), '192.0.2.30')
})

test('proxy + X-Forwarded-For: 1.2.3.4 → 1.2.3.4', () => {
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '1.2.3.4' }), [PROXY]), '1.2.3.4')
  assert.equal(clientIp(req(`::ffff:${PROXY}`, { 'x-forwarded-for': ' 1.2.3.4 ' }), [PROXY]), '1.2.3.4')
})

test('read right to left: value injected on the left ignored, trusted proxies on the right skipped', () => {
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '192.0.2.50, 1.2.3.4' }), [PROXY]), '1.2.3.4')
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '192.0.2.50,1.2.3.4' }), [PROXY]), '1.2.3.4')
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': `1.2.3.4, ${PROXY}` }), [PROXY]), '1.2.3.4')
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '192.0.2.50, 1.2.3.4, 192.0.2.154' }), [PROXY, '192.0.2.154']), '1.2.3.4')
  // several lines (Express joins the lines in order, see also the HTTP bench)
  assert.equal(clientIp({ socket: { remoteAddress: PROXY }, headers: { 'x-forwarded-for': ['192.0.2.50', '1.2.3.4'] } }, [PROXY]), '1.2.3.4')
})

test('fail closed (function): without XFF, empty, unknown, IP:port, invalid, all trusted → null', () => {
  const none = req(PROXY)
  assert.equal(clientIp(none, [PROXY]), null)
  for (const xff of ['', '   ', 'unknown', '1.2.3.4:5678', '999.1.1.1', 'proxy.invalid', '1.2.3.4, unknown', '1.2.3.4, ', PROXY, `${PROXY}, ${PROXY}`]) {
    assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': xff }), [PROXY]), null, xff)
  }
  // an unreadable entry to the LEFT of the client IP is never reached
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': 'unknown, 1.2.3.4' }), [PROXY]), '1.2.3.4')
})

test('IPv6 and ::ffff:: ::ffff:192.0.2.60 → 192.0.2.60; a valid IPv6 is read', () => {
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '::ffff:192.0.2.60' }), [PROXY]), '192.0.2.60')
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '2001:DB8::1' }), [PROXY]), '2001:db8::1')
  assert.equal(clientIp(req(PROXY, { 'x-forwarded-for': '[2001:db8::1]' }), [PROXY]), null) // non-bare form: unreadable
})

test('viaHttps: proxy + X-Forwarded-Proto: https → true; direct + XFP https → false; TLS on the socket → true', () => {
  assert.equal(viaHttps(req(PROXY, { 'x-forwarded-proto': 'https' }), [PROXY]), true)
  assert.equal(viaHttps(req(PROXY, { 'x-forwarded-proto': 'http' }), [PROXY]), false)
  assert.equal(viaHttps(req(PROXY), [PROXY]), false)
  assert.equal(viaHttps(req('192.0.2.30', { 'x-forwarded-proto': 'https' }), [PROXY]), false)
  assert.equal(viaHttps(req('192.0.2.30'), [PROXY]), false)
  assert.equal(viaHttps(req('192.0.2.30', {}, true), [PROXY]), true)
  assert.equal(viaHttps(req(PROXY, { 'x-forwarded-proto': 'https' }), []), false)
  // whole value, spaces trimmed, case-insensitive; a list is not https
  assert.equal(viaHttps(req(PROXY, { 'x-forwarded-proto': ' HTTPS ' }), [PROXY]), true)
  for (const v of ['http,https', 'https, http', 'https,https', 'httpss', '']) assert.equal(viaHttps(req(PROXY, { 'x-forwarded-proto': v }), [PROXY]), false, v)
})

test('ipAllowed: null, empty or the proxy-no-xff key → false, without throwing; null is never treated as \'\'', () => {
  const cidrs = parseCidrs(CIDRS)
  for (const v of [null, undefined, '', PROXY_NO_XFF, 'unknown']) assert.equal(ipAllowed(v, cidrs), false, String(v))
  assert.equal(ipAllowed('192.0.2.61', cidrs), true)
  assert.equal(ipAllowed(null, parseCidrs('0.0.0.0/0')), false)
})

// --- auth.login with fake requests ---------------------------------------------------------------

function lockBench({ trusted = [PROXY] } = {}) {
  const store = tmpStore('dash-proxy-')
  const audit = createAudit(store, { tickMs: 0, now: () => T })
  const spy = { calls: 0 }
  const verify = async password => {
    spy.calls++
    return password === GOOD
  }
  // httpLogin: direct HTTP clients as through the proxy (real IP and lock are the subject)
  const auth = createAuth({ store, audit, now: () => T, verify, log: { error() {} }, trustedProxies: trusted, httpLogin: true, env: { ADMIN_PASSWORD_HASH: HASH, ADMIN_ALLOWED_CIDRS: CIDRS } })
  const viaProxy = xff => req(PROXY, xff == null ? {} : { 'x-forwarded-for': xff })
  const cookies = []
  const res = { setHeader: (k, v) => cookies.push(v) }
  const login = (r, password = 'faux') => auth.login(r, res, password)
  const pastSuccess = (ip, agoMs) => audit.log({ actor: ip, source: 'ui', action: 'connexion', ok: true, at: T - agoMs })
  const actors = () => store.db.prepare('SELECT actor, ok FROM audit ORDER BY id').all().map(r => ({ ...r }))
  return { store, auth, audit, spy, viaProxy, login, pastSuccess, actors, cookies }
}

test('(lock) XFF of a direct client carrying a KNOWN IP: ignored, no exemption from the global cap', async () => {
  const b = lockBench()
  b.pastSuccess('192.0.2.77', 3 * DAY)
  for (let i = 1; i <= 20; i++) assert.equal((await b.login(b.viaProxy(`192.0.2.${100 + i}`))).status, 401)
  const r = await b.login(req('192.0.2.30', { 'x-forwarded-for': '192.0.2.77' }), GOOD)
  assert.equal(r.status, 429)
  // control: the real known IP passes, through the proxy
  assert.equal((await b.login(b.viaProxy('192.0.2.77'), GOOD)).ok, true)
})

test('fail closed (login): proxy without valid XFF → 403, no verification, audit under proxy-no-xff, never the proxy IP', async () => {
  const b = lockBench()
  for (const r of [b.viaProxy(null), b.viaProxy(''), b.viaProxy('unknown'), b.viaProxy('1.2.3.4:5678'), b.viaProxy(PROXY)]) {
    const x = await b.login(r, GOOD)
    assert.deepEqual([x.status, x.error], [403, 'réseau non autorisé'])
  }
  assert.equal(b.spy.calls, 0)
  const actors = b.actors().map(a => a.actor)
  assert.ok(actors.length >= 1 && actors.every(a => a === PROXY_NO_XFF), JSON.stringify(actors))
  assert.equal(b.auth.realIp(b.viaProxy(null)), PROXY_NO_XFF)
  assert.equal(b.auth.status(b.viaProxy(null)).networkAllowed, false)
})

test('lock by the real IP: 5 failures of client A through the proxy → A gets 429; B, same proxy → 401', async () => {
  const b = lockBench()
  for (let i = 0; i < 5; i++) assert.equal((await b.login(b.viaProxy('192.0.2.61'))).status, 401)
  assert.equal((await b.login(b.viaProxy('192.0.2.61'), GOOD)).status, 429)
  assert.equal((await b.login(b.viaProxy('192.0.2.62'))).status, 401)
  assert.equal((await b.login(b.viaProxy('192.0.2.62'), GOOD)).ok, true)
  assert.ok(b.actors().every(a => a.actor !== PROXY))
})

test('network check on the real IP: through the proxy, X-Forwarded-For: 8.8.8.8 → 403 (network not allowed)', async () => {
  const b = lockBench()
  const r = await b.login(b.viaProxy('8.8.8.8'), GOOD)
  assert.deepEqual([r.status, r.error], [403, 'réseau non autorisé'])
  assert.equal(b.spy.calls, 0)
  assert.equal(b.auth.status(b.viaProxy('8.8.8.8')).networkAllowed, false)
  assert.equal(b.auth.status(b.viaProxy('192.0.2.61')).networkAllowed, true)
})

test('known IP: successful login of A through the proxy → A known; the proxy never, even with an old audit row at its address', async () => {
  const b = lockBench()
  b.pastSuccess(PROXY, 2 * DAY) // old row (before this change) at the proxy address
  assert.equal(b.auth.isKnown(PROXY), false)
  assert.equal((await b.login(b.viaProxy('192.0.2.70'), GOOD)).ok, true)
  assert.equal(b.auth.isKnown('192.0.2.70'), true)
  assert.equal(b.auth.isKnown(PROXY), false)
  assert.equal(b.auth.isKnown(PROXY_NO_XFF), false)
  // A is exempt from the global cap on unknown IPs
  for (let i = 1; i <= 20; i++) assert.equal((await b.login(b.viaProxy(`192.0.2.${100 + i}`))).status, 401)
  assert.equal((await b.login(b.viaProxy('192.0.2.71'), GOOD)).status, 429)
  assert.equal((await b.login(b.viaProxy('192.0.2.70'), GOOD)).ok, true)
  // without a trusted proxy, the same row makes the address known (former behavior)
  const d = lockBench({ trusted: [] })
  d.pastSuccess(PROXY, 2 * DAY)
  assert.equal(d.auth.isKnown(PROXY), true)
})

test('(cookie) Secure via viaHttps: proxy + XFP https → Secure; direct + XFP https → without; direct http → without', async () => {
  const b = lockBench()
  await b.login(req(PROXY, { 'x-forwarded-for': '192.0.2.80', 'x-forwarded-proto': 'https' }), GOOD)
  await b.login(req('192.0.2.81', { 'x-forwarded-proto': 'https' }), GOOD)
  await b.login(req('192.0.2.82'), GOOD)
  assert.equal(b.cookies.length, 3)
  assert.match(b.cookies[0], /; Secure$/)
  for (const c of b.cookies.slice(1)) assert.doesNotMatch(c, /Secure/)
  for (const c of b.cookies) assert.match(c, /^dash_admin=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/)
})

test('empty trustedProxies: former behavior (socket, XFF and XFP ignored, proxy address readable)', async () => {
  const b = lockBench({ trusted: [] })
  const r = req(PROXY, { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' })
  assert.equal(b.auth.realIp(r), PROXY)
  assert.equal(b.auth.realIp(req('::ffff:192.0.2.30')), '192.0.2.30')
  assert.equal((await b.login(r, GOOD)).ok, true)
  assert.doesNotMatch(b.cookies[0], /Secure/)
  assert.deepEqual(b.actors().map(a => a.actor), [PROXY])
})

test('schema: trustedProxies as exact IPv4 or IPv6, or CIDR; prefix too wide (< /8, < /32 in IPv6), name, port → refused; missing → []; the repository config.example.json is valid', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/fixtures/config.reference.json'), 'utf8'))
  assert.deepEqual(raw.trustedProxies, [PROXY])
  assert.ok(raw.allowedHosts.includes('vigie.example.net'))
  assert.deepEqual(parseConfig({ ...raw, trustedProxies: [PROXY] }).config.trustedProxies, [PROXY])
  for (const bad of [['0.0.0.0/0'], ['::/0'], ['10.0.0.0/7'], ['fd00::/31'], ['::/32'], ['::ffff:0.0.0.0/96'], ['proxy.invalid'], ['192.0.2.153:80'], ['[::1]:80'], ['192.0.2.0/33'], ['fd00::/129'], ['256.1.1.1'], [''], [1]]) {
    assert.ok(parseConfig({ ...raw, trustedProxies: bad }).errors, JSON.stringify(bad))
  }
  // CIDR ranges and IPv6 accepted (proxy in a container)
  for (const good of [['10.0.0.0/8'], ['172.18.0.0/16', '192.0.2.153'], ['::1'], ['fd00::/32', '2001:db8::1']]) {
    assert.deepEqual(parseConfig({ ...raw, trustedProxies: good }).errors, undefined, JSON.stringify(good))
  }
  const { trustedProxies, ...without } = raw
  assert.ok(trustedProxies)
  assert.deepEqual(parseConfig(without).config.trustedProxies, [])
  assert.ok(!parseConfig(raw).errors)
})

// --- static ----------------------------------------------------------------------------------------

test('static: no trust proxy, no req.ip/ips/hostname/protocol/secure; socket and X-Forwarded-* read only by clientIp and viaHttps (and the socket alone by localSocket)', () => {
  const files = []
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name)) }
  walk(path.join(ROOT, 'server/lib'))
  files.push(path.join(ROOT, 'server/index.js'))
  const src = Object.fromEntries(files.map(f => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')]))
  for (const [f, s] of Object.entries(src)) {
    assert.doesNotMatch(s, /trust proxy/i, f)
    assert.doesNotMatch(s, /\breq\.(ip|ips|hostname|protocol|secure)\b/, f)
    assert.doesNotMatch(s, /\bipOf\b/, f)
    assert.doesNotMatch(s, /\.connection\.remoteAddress/, f)
  }
  // reads of the socket and of the proxy headers: allow list, each one justified
  const where = re => Object.entries(src).filter(([, s]) => re.test(s)).map(([f]) => f)
  // allow list: auth.js only (in clientIp, viaHttps and, for the socket alone, localSocket;
  // checked below)
  assert.deepEqual(where(/remoteAddress/), ['server/lib/auth.js'])
  assert.deepEqual(where(/x-forwarded-for/i), ['server/lib/auth.js'])
  assert.deepEqual(where(/x-forwarded-proto/i), ['server/lib/auth.js'])
  assert.deepEqual(where(/x-forwarded-host/i), [])
  const auth = src['server/lib/auth.js']
  const body = name => {
    const i = auth.indexOf(`export function ${name}(`)
    return auth.slice(i, auth.indexOf('\n}\n', i) + 2)
  }
  const inFns = body('clientIp') + body('viaHttps') + body('localSocket')
  const outside = auth.replace(body('clientIp'), '').replace(body('viaHttps'), '').replace(body('localSocket'), '')
  assert.equal((inFns.match(/remoteAddress/g) || []).length, 3)
  // the loopback exception of the HTTP login reads the socket, never X-Forwarded-*
  assert.doesNotMatch(body('localSocket'), /x-forwarded|headerOf|clientIp/i)
  assert.doesNotMatch(outside, /remoteAddress|x-forwarded-for|x-forwarded-proto/i)
  assert.match(body('clientIp'), /'x-forwarded-for'/)
  assert.match(body('viaHttps'), /'x-forwarded-proto'/)
  // the cookie follows viaHttps; createAuth receives trustedProxies from the config
  assert.match(auth, /\$\{viaHttps\(req, trusted\) \? '; Secure' : ''\}/)
  assert.match(src['server/index.js'], /createAuth\(\{[^}]*\btrustedProxies: cfg\.trustedProxies\b[^}]*\}\)/)
})

// --- HTTP bench: fake proxy 127.0.0.2 ------------------------------------------------------------------

async function bench() {
  const { config, errors } = parseConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/fixtures/config.reference.json'), 'utf8')))
  assert.ok(!errors)
  const hosts = allowedHostsOf(config)
  const store = tmpStore('dash-proxy-http-')
  const audit = createAudit(store, { tickMs: 0 })
  const auth = createAuth({ store, audit, allowedHosts: hosts, trustedProxies: ['127.0.0.2'], log: { error() {} }, httpLogin: true,
    env: { ADMIN_PASSWORD_HASH: HASH, ADMIN_ALLOWED_CIDRS: CIDRS } })
  const app = express()
  app.use(hostGuard(hosts))
  app.use('/api', express.json({ limit: '8kb' }))
  app.get('/api/healthz', (q, r) => r.json({ ok: true }))
  app.get('/api/whoami', (q, r) => r.json({ ip: auth.realIp(q) }))
  app.post('/api/login', async (q, r) => {
    if (!sameOrigin(q, hosts) || !q.is('application/json')) return r.status(403).json({ error: 'origine refusée' })
    const x = await auth.login(q, r, q.body?.password)
    r.status(x.ok ? 200 : x.status).json(x.ok ? { ok: true } : { error: x.error })
  })
  app.post('/api/logout', (q, r) => {
    auth.logout(q, r)
    r.json({ ok: true })
  })
  app.post('/api/ecriture', auth.require, (q, r) => r.json({ ok: true, actor: q.actor }))
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const port = srv.address().port
  // from: source address (127.0.0.2 = the trusted proxy, 127.0.0.1 = direct client)
  const send = ({ method = 'GET', p, from = '127.0.0.2', headers = {}, body }) => new Promise((res, rej) => {
    const data = body == null ? null : JSON.stringify(body)
    const h = { host: 'vigie.example.net', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, localAddress: from, headers: h }, x => {
      let d = ''
      x.on('data', c => { d += c })
      x.on('end', () => res({ status: x.statusCode, body: d ? JSON.parse(d) : null, cookie: x.headers['set-cookie']?.[0] ?? null }))
    })
    r.on('error', rej)
    if (data) r.write(data)
    r.end()
  })
  const viaProxy = (o, ip = '192.0.2.90') => send({ ...o, headers: { 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', origin: 'https://vigie.example.net', ...o.headers } })
  const rows = sql => store.db.prepare(sql).all().map(x => ({ ...x }))
  return { send, viaProxy, rows, close: () => srv.close() }
}

test('HTTP bench: fake proxy 127.0.0.2, Host and Origin of vigie.example.net', async () => {
  const b = await bench()
  try {
    // allowed Host → 200; another Host through the proxy, even with X-Forwarded-Host → 421
    assert.equal((await b.viaProxy({ p: '/api/healthz' })).status, 200)
    const bad = await b.viaProxy({ p: '/api/healthz', headers: { host: 'evil.example', 'x-forwarded-host': 'vigie.example.net' } })
    assert.deepEqual([bad.status, bad.body.error, bad.body.host], [421, 'hôte non autorisé', 'evil.example'])
    // two X-Forwarded-For lines, joined in order; the left (injected) value ignored
    assert.deepEqual((await b.send({ p: '/api/whoami', headers: { 'x-forwarded-for': ['192.0.2.50', '1.2.3.4'] } })).body, { ip: '1.2.3.4' })
    // direct client (127.0.0.1): XFF ignored
    assert.deepEqual((await b.send({ p: '/api/whoami', from: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.77' } })).body, { ip: '127.0.0.1' })
    // proxy without XFF → login and write refused (403), audit under the dedicated key
    const noXff = await b.send({ method: 'POST', p: '/api/login', headers: { origin: 'https://vigie.example.net' }, body: { password: GOOD } })
    assert.deepEqual([noXff.status, noXff.body], [403, { error: 'réseau non autorisé' }])
    const w0 = await b.send({ method: 'POST', p: '/api/ecriture', headers: { origin: 'https://vigie.example.net' }, body: {} })
    assert.deepEqual([w0.status, w0.body], [403, { error: 'réseau non autorisé' }])
    // end-to-end login through the proxy → success, Secure cookie; write with the session
    const ok = await b.viaProxy({ method: 'POST', p: '/api/login', body: { password: GOOD } })
    assert.equal(ok.status, 200)
    assert.match(ok.cookie, /; Secure$/)
    const sid = ok.cookie.split(';')[0]
    const w = await b.viaProxy({ method: 'POST', p: '/api/ecriture', headers: { cookie: sid }, body: {} })
    assert.deepEqual([w.status, w.body], [200, { ok: true, actor: 'admin (192.0.2.90)' }])
    // Host rewritten to the backend IP by the proxy → 403 (origin refused)
    const rewritten = await b.viaProxy({ method: 'POST', p: '/api/login', headers: { host: '192.0.2.148' }, body: { password: GOOD } })
    assert.deepEqual([rewritten.status, rewritten.body], [403, { error: 'origine refusée' }])
    // session, login and logout at the workstation IP, never 127.0.0.2
    assert.deepEqual(b.rows('SELECT ip FROM sessions'), [{ ip: '192.0.2.90' }])
    await b.viaProxy({ method: 'POST', p: '/api/logout', headers: { cookie: sid }, body: {} })
    assert.deepEqual(b.rows('SELECT ip FROM sessions'), [])
    const audit = b.rows('SELECT actor, action, ok FROM audit ORDER BY id')
    assert.deepEqual(audit.filter(a => a.action === 'login' && a.ok === 1).map(a => a.actor), ['192.0.2.90'])
    assert.deepEqual(audit.filter(a => a.action === 'logout').map(a => a.actor), ['192.0.2.90'])
    assert.ok(audit.every(a => a.actor !== '127.0.0.2'), JSON.stringify(audit))
    assert.ok(audit.some(a => a.actor === PROXY_NO_XFF))
    // direct access: cookie without Secure, even with X-Forwarded-Proto
    const direct = await b.send({ method: 'POST', p: '/api/login', from: '127.0.0.1', headers: { host: '192.0.2.148', origin: 'http://192.0.2.148', 'x-forwarded-proto': 'https' }, body: { password: GOOD } })
    assert.equal(direct.status, 200)
    assert.doesNotMatch(direct.cookie, /Secure/)
  } finally {
    b.close()
  }
})
