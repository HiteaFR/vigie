// Safe defaults: new defaults (session required to read the API, listening on 127.0.0.1,
// admin login over HTTP refused outside the loopback, admin networks limited to the loopback),
// options that restore the old behavior (security.*, listenHost), priority "non-empty env >
// config > default", startup log line, read contract of an external tool without a session, and sentinel
// secrets: no API response contains a config or env secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuth, createAudit, hashPassword, isLoopback, localSocket } from '../lib/auth.js'
import { resolveSecurity, resolveAdminCidrs, securityLogLine, SECURITY_DEFAULTS } from '../lib/security.js'
import { loadConfig } from '../lib/config.js'
import { tmpDir, tmpStore } from './tmpdir.js'
import { bootServer, bootConfig, request, until } from './server-boot.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(SERVER, '..')
const read = p => fs.readFileSync(path.join(SERVER, p), 'utf8')
const PASSWORD = 'mot de passe factice du banc P2'
const HASH = await hashPassword(PASSWORD)
const ANON = { security: { anonymousRead: true } }

// --- resolution of the effective values ------------------------------------------------------

test('safe defaults without config or env: 127.0.0.1, read with a session, HTTP refused, loopback only; source "défaut"', () => {
  const r = resolveSecurity({}, {})
  assert.deepEqual(
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.value, v.source]])),
    { listenHost: ['127.0.0.1', 'default'], anonymousRead: [false, 'default'], httpLogin: [false, 'default'], adminCidrs: [['127.0.0.1/32'], 'default'] })
  assert.deepEqual(SECURITY_DEFAULTS.adminCidrs, ['127.0.0.1/32'])
})

test('config options (instance that keeps the old behavior): "::", anonymous read, HTTP, LAN and 100.64/10; source "config"', () => {
  const cfg = { listenHost: '::', security: { anonymousRead: true, httpLogin: true, adminCidrs: ['192.0.2.0/24', '100.64.0.0/10', '127.0.0.1/32'] } }
  const r = resolveSecurity(cfg, {})
  assert.deepEqual([r.listenHost.value, r.listenHost.source], ['::', 'config'])
  assert.deepEqual([r.anonymousRead.value, r.anonymousRead.source], [true, 'config'])
  assert.deepEqual([r.httpLogin.value, r.httpLogin.source], [true, 'config'])
  assert.deepEqual([r.adminCidrs.value, r.adminCidrs.source], [['192.0.2.0/24', '100.64.0.0/10', '127.0.0.1/32'], 'config'])
  // explicit false: config source, value false
  const off = resolveSecurity({ security: { anonymousRead: false, httpLogin: false } }, {})
  assert.deepEqual([off.anonymousRead.value, off.anonymousRead.source, off.httpLogin.value, off.httpLogin.source], [false, 'config', false, 'config'])
})

test('priority: NON-EMPTY variable > config > default; an empty or blank variable (X=) is ignored, the config applies', () => {
  const cfg = { listenHost: '::', security: { adminCidrs: ['192.0.2.0/24'] } }
  // non-empty: it wins (as before safe defaults)
  const e = resolveSecurity(cfg, { LISTEN_HOST: '127.0.0.1', ADMIN_ALLOWED_CIDRS: '198.51.100.0/24, 127.0.0.1/32' })
  assert.deepEqual([e.listenHost.value, e.listenHost.source], ['127.0.0.1', 'env'])
  assert.deepEqual([e.adminCidrs.value, e.adminCidrs.source], [['198.51.100.0/24', '127.0.0.1/32'], 'env'])
  // empty or blank: the config (an Environment= of the unit would have been overwritten by this empty value)
  for (const v of ['', '   ']) {
    const r = resolveSecurity(cfg, { LISTEN_HOST: v, ADMIN_ALLOWED_CIDRS: v })
    assert.deepEqual([r.listenHost.value, r.listenHost.source, r.adminCidrs.value, r.adminCidrs.source], ['::', 'config', ['192.0.2.0/24'], 'config'], JSON.stringify(v))
    const d = resolveSecurity({}, { LISTEN_HOST: v, ADMIN_ALLOWED_CIDRS: v })
    assert.deepEqual([d.listenHost.source, d.adminCidrs.source], ['default', 'default'])
  }
  // anonymous read and HTTP: config only, no variable read
  const n = resolveSecurity({}, { ANONYMOUS_READ: '1', ADMIN_ANONYMOUS_READ: 'true', HTTP_LOGIN: '1', ADMIN_HTTP_LOGIN: '1' })
  assert.deepEqual([n.anonymousRead.value, n.httpLogin.value], [false, false])
  assert.deepEqual(resolveAdminCidrs({}, undefined), { value: ['127.0.0.1/32'], source: 'default' })
})

test('log line: values and sources of the four settings, nothing else', () => {
  const line = securityLogLine(resolveSecurity(
    { listenHost: '::', security: { anonymousRead: true, httpLogin: true, adminCidrs: ['192.0.2.0/24', '127.0.0.1/32'] } },
    { ADMIN_PASSWORD_HASH: HASH, TELEGRAM_BOT_TOKEN: 'SENTINELLE-telegram', LISTEN_HOST: '' }))
  assert.equal(line, 'security: listenHost=:: (config) ; anonymousRead=true (config) ; httpLogin=true (config) ; adminCidrs=192.0.2.0/24,127.0.0.1/32 (config)')
})

test('schema: listenHost and security accepted; unknown key, invalid network, empty list and wrong type refused; config.example.json without anonymous read or HTTP', () => {
  const dir = tmpDir('dash-p2-schema-')
  const check = cfg => {
    const f = path.join(dir, `c${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(f, JSON.stringify(cfg))
    return loadConfig(f)
  }
  assert.equal(check(bootConfig({ listenHost: '::', security: { anonymousRead: true, httpLogin: true, adminCidrs: ['192.0.2.0/24', '127.0.0.1'] } })).errors, undefined)
  for (const bad of [
    { security: { anonymousRead: true, autre: 1 } },
    { security: { adminCidrs: ['192.0.2.0/33'] } },
    { security: { adminCidrs: ['192.0.2.0/24,127.0.0.1/32'] } },
    { security: { adminCidrs: [] } },
    { security: { httpLogin: 'oui' } },
    { listenHost: '' },
  ]) assert.ok(check(bootConfig(bad)).errors, JSON.stringify(bad))
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))
  assert.notEqual(example.security?.anonymousRead, true)
  assert.notEqual(example.security?.httpLogin, true)
  // local example, explicit listening on the loopback (safe default, written out in full)
  assert.ok(example.listenHost === undefined || example.listenHost === '127.0.0.1', example.listenHost)
  // local example without the network module; otherwise probe and mDNS turned off
  assert.notEqual(example.network?.probe?.enabled, true)
  assert.notEqual(example.network?.mdns?.enabled, true)
})

test('code: no hard-coded network of the original LAN left in auth.js (DEFAULT_CIDRS)', () => {
  const code = read('lib/auth.js').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  assert.doesNotMatch(code, /DEFAULT_CIDRS|192\.168\.|100\.64\./)
  assert.match(read('lib/auth.js'), /resolveAdminCidrs\(env, adminCidrs\)/)
})

// --- login: networks and HTTP -----------------------------------------------------------------

function bench({ httpLogin, adminCidrs, env = {}, trustedProxies = [] } = {}) {
  const store = tmpStore('dash-p2-auth-')
  const audit = createAudit(store, { tickMs: 0 })
  const spy = { calls: 0 }
  const verify = async p => {
    spy.calls++
    return p === PASSWORD
  }
  const auth = createAuth({ store, audit, verify, log: { error() {} }, httpLogin, adminCidrs, trustedProxies, env: { ADMIN_PASSWORD_HASH: HASH, ...env } })
  const req = (ip, { encrypted = false, headers = {} } = {}) => ({ socket: { remoteAddress: ip, encrypted }, get: k => headers[k.toLowerCase()] ?? null })
  const login = (ip, opts) => auth.login(req(ip, opts), { setHeader() {} }, PASSWORD)
  return { auth, audit, spy, req, login }
}

test('default admin networks: loopback only (127.0.0.0/32 and ::1); LAN and 100.64/10 refused; config then non-empty env', async () => {
  const b = bench({ httpLogin: true })
  assert.equal((await b.login('127.0.0.1')).ok, true)
  assert.equal((await b.login('::1')).ok, true)
  assert.equal((await b.login('::ffff:127.0.0.1')).ok, true)
  for (const ip of ['10.0.0.10', '172.16.0.5', '100.64.0.1', '192.0.2.10', '127.0.0.2']) assert.equal((await b.login(ip)).status, 403, ip)
  const c = bench({ httpLogin: true, adminCidrs: ['192.0.2.0/24', '127.0.0.1/32'] })
  assert.equal((await c.login('192.0.2.10')).ok, true)
  assert.equal((await c.login('198.51.100.7')).status, 403)
  const e = bench({ httpLogin: true, adminCidrs: ['192.0.2.0/24'], env: { ADMIN_ALLOWED_CIDRS: '198.51.100.0/24' } })
  assert.equal((await e.login('198.51.100.7')).ok, true)
  assert.equal((await e.login('192.0.2.10')).status, 403)
  const blank = bench({ httpLogin: true, adminCidrs: ['192.0.2.0/24'], env: { ADMIN_ALLOWED_CIDRS: '' } })
  assert.equal((await blank.login('192.0.2.10')).ok, true, 'empty variable: the config applies')
})

test('login over HTTP outside the loopback: 403 without checking the password, aggregated refusal; loopback, direct TLS or https proxy → 200; httpLogin → 200', async () => {
  const cidrs = ['192.0.2.0/24', '127.0.0.0/8']
  const b = bench({ adminCidrs: cidrs, trustedProxies: ['127.0.0.9'] })
  const r = await b.login('192.0.2.10')
  assert.deepEqual([r.ok, r.status, r.error], [false, 403, 'connexion admin en HTTP refusée : passer par HTTPS'])
  assert.equal(b.spy.calls, 0, 'password never checked')
  assert.ok(b.audit.list().some(x => x.action === 'login' && !x.ok && /HTTP hors boucle locale/.test(x.detail)))
  assert.equal(b.auth.status(b.req('192.0.2.10')).httpRefused, true)
  assert.equal((await b.login('127.0.0.1')).ok, true, 'loopback over HTTP')
  assert.equal(b.auth.status(b.req('127.0.0.1')).httpRefused, false)
  assert.equal((await b.login('192.0.2.11', { encrypted: true })).ok, true, 'TLS on the socket')
  const viaProxy = { headers: { 'x-forwarded-for': '192.0.2.12', 'x-forwarded-proto': 'https' } }
  assert.equal((await b.login('127.0.0.9', viaProxy)).ok, true, 'trusted proxy, XFP https')
  assert.equal(b.auth.status(b.req('127.0.0.9', viaProxy)).httpRefused, false)
  const httpProxy = { headers: { 'x-forwarded-for': '192.0.2.13', 'x-forwarded-proto': 'http' } }
  assert.equal((await b.login('127.0.0.9', httpProxy)).status, 403, 'trusted proxy over HTTP')
  // loopback exception through the SOCKET only: a trusted proxy that copies an XFF
  // "127.0.0.1" over HTTP does not benefit from it (LAN proxy or proxy on the same machine)
  const lan = bench({ adminCidrs: cidrs, trustedProxies: ['192.0.2.153', '127.0.0.9'] })
  const forged = { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http' } }
  for (const proxy of ['192.0.2.153', '127.0.0.9']) {
    const r = await lan.login(proxy, forged)
    assert.deepEqual([r.status, r.error], [403, 'connexion admin en HTTP refusée : passer par HTTPS'], proxy)
    assert.equal(lan.auth.status(lan.req(proxy, forged)).httpRefused, true, proxy)
  }
  assert.equal(lan.spy.calls, 0)
  assert.equal(localSocket(lan.req('127.0.0.1'), ['192.0.2.153']), true)
  assert.equal(localSocket(lan.req('127.0.0.9'), ['127.0.0.9']), false, 'local trusted proxy')
  assert.equal(localSocket(lan.req('192.0.2.153', forged), ['192.0.2.153']), false)
  assert.equal(localSocket(lan.req('::ffff:127.0.0.1')), true)
  const o = bench({ adminCidrs: cidrs, httpLogin: true })
  assert.equal((await o.login('192.0.2.10')).ok, true, 'httpLogin opt-in (instance that accepts HTTP on its LAN)')
  assert.equal(o.auth.status(o.req('192.0.2.10')).httpRefused, false)
  assert.deepEqual(['127.0.0.1', '127.255.0.1', '::1', '::ffff:127.0.0.1'].map(isLoopback), [true, true, true, true])
  assert.deepEqual(['192.0.2.1', '::ffff:192.0.2.1', 'fe80::1', '', null].map(isLoopback), [false, false, false, false, false])
})

// --- real server: read guard, public routes, external tool ---------------------------------------

// every GET route of the API, read from the code (index.js and the network module); parameters
// replaced by sample values
const GET_ROUTES = (() => {
  // plus the plugin routes (gitea plugin router)
  const src = read('index.js') + read('lib/network/routes.js') + read('plugins/gitea/index.js')
  const out = new Set()
  for (const m of src.matchAll(/(?:app|router)\.get\('(\/api\/[^']+)'/g)) {
    out.add(m[1].replace(':cluster', 'pve').replace(':node', 'n').replace(':vmid', '100').replace(':id', 'web'))
  }
  return [...out].sort()
})()
const PUBLIC = ['/api/config', '/api/healthz', '/api/session']

test('inventory of GET routes: at least the known ones, and the three public ones are among them', () => {
  for (const p of ['/api/alerts', '/api/services', '/api/summary', '/api/network', '/api/audit', '/api/health', ...PUBLIC]) assert.ok(GET_ROUTES.includes(p), p)
  assert.ok(GET_ROUTES.length >= 25, GET_ROUTES.join(' '))
})

test('default (without anonymous read), without a session: 401 on every GET route of the API, including unknown ones or case variants; 200 on healthz, session, config', { timeout: 60_000 }, async t => {
  const s = await bootServer(t, { env: { ADMIN_PASSWORD_HASH: HASH } })
  for (const p of GET_ROUTES) {
    const r = await request(s.port, p)
    if (PUBLIC.includes(p)) assert.equal(r.status, 200, p)
    else assert.deepEqual([r.status, r.json], [401, { error: 'connexion admin requise' }], p)
  }
  for (const p of ['/api/nope', '/api/ALERTS', '/api/alerts/', '/api/Healthz']) assert.equal((await request(s.port, p)).status, 401, p)
  assert.equal((await request(s.port, '/api/alerts', { method: 'HEAD' })).status, 401)
  // /api/config: exactly the titles
  // plus the instance locale
  assert.deepEqual(Object.keys((await request(s.port, '/api/config')).json), ['title', 'locale'])
  const full = await bootServer(t, { config: bootConfig({ subtitle: 'sous-titre', footer: 'pied' }) })
  assert.deepEqual((await request(full.port, '/api/config')).json, { title: 'Banc de test (données factices)', subtitle: 'sous-titre', footer: 'pied', locale: 'fr' })
  // /api/session: neither bot nor refresh without a session
  const sess = (await request(s.port, '/api/session')).json
  assert.deepEqual(Object.keys(sess).sort(), ['admin', 'anonymousRead', 'configured', 'expiresAt', 'httpRefused', 'networkAllowed'])
  assert.deepEqual([sess.admin, sess.anonymousRead, sess.configured, sess.networkAllowed, sess.httpRefused], [false, false, true, true, false])
  // with a session (login on the loopback, without HTTP opt-in): reads respond
  const origin = { origin: `http://127.0.0.1:${s.port}` }
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: origin })
  assert.equal(login.status, 200)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  for (const p of ['/api/alerts', '/api/services', '/api/summary', '/api/audit']) assert.equal((await request(s.port, p, { headers: { cookie } })).status, 200, p)
  const withSession = (await request(s.port, '/api/session', { headers: { cookie } })).json
  assert.equal(withSession.admin, true)
  assert.ok(withSession.bot && withSession.refresh)
})

test('anonymous read: every GET route responds without a session (except /api/audit); full public session; writes still guarded', { timeout: 60_000 }, async t => {
  const s = await bootServer(t, { config: bootConfig(ANON) })
  for (const p of GET_ROUTES) {
    const r = await request(s.port, p)
    if (p === '/api/audit') assert.equal(r.status, 401, p)
    else assert.notEqual(r.status, 401, p)
  }
  const sess = (await request(s.port, '/api/session')).json
  assert.equal(sess.anonymousRead, true)
  assert.ok(sess.bot && sess.refresh)
  const w = await request(s.port, '/api/silences', { method: 'POST', body: { matcher: { service: 'x' }, reason: 'r' }, headers: { origin: `http://127.0.0.1:${s.port}` } })
  assert.equal(w.status, 401)
})

test('read contract of an external tool (alerts and services): with anonymous reading, GET /api/alerts and /api/services return 200 without a session from an IP outside the admin networks; without it, 401', { timeout: 60_000 }, async t => {
  // ADMIN_ALLOWED_CIDRS without the loopback: the test client (127.0.0.1) is outside the admin network
  const env = { ADMIN_ALLOWED_CIDRS: '192.0.2.0/24' }
  const anon = await bootServer(t, { config: bootConfig(ANON), env })
  const al = await request(anon.port, '/api/alerts')
  assert.equal(al.status, 200)
  assert.ok(Array.isArray(al.json.active), 'fields read by an external tool: .active[].hostId, severity, ack, suppressed')
  const sv = await request(anon.port, '/api/services')
  assert.equal(sv.status, 200)
  assert.ok(Array.isArray(sv.json.services), 'fields read by an external tool: .services[].id and .url')
  const closed = await bootServer(t, { env })
  for (const p of ['/api/alerts', '/api/services']) assert.equal((await request(closed.port, p)).status, 401, p)
})

// --- listening ---------------------------------------------------------------------------------

const connectTo = (host, port) => new Promise(resolve => {
  const c = net.connect({ host, port })
  c.once('connect', () => { c.destroy(); resolve('connecté') })
  c.once('error', e => resolve(e.code))
})

test('listening: listenHost "::" in the config = all interfaces in dual stack; empty LISTEN_HOST ignored; non-empty LISTEN_HOST wins', { timeout: 60_000 }, async t => {
  for (const LISTEN_HOST of [undefined, '']) {
    const s = await bootServer(t, { config: bootConfig({ listenHost: '::' }), env: { LISTEN_HOST } })
    assert.equal(await connectTo('127.0.0.2', s.port), 'connecté', `IPv4 through the dual stack (${JSON.stringify(LISTEN_HOST)})`)
    assert.equal(await connectTo('::1', s.port), 'connecté', 'IPv6')
    assert.match(s.logs(), /security: listenHost=:: \(config\)/)
    await s.stop()
  }
  const e = await bootServer(t, { config: bootConfig({ listenHost: '::' }), env: { LISTEN_HOST: '127.0.0.1' } })
  assert.equal(await connectTo('127.0.0.2', e.port), 'ECONNREFUSED')
  assert.equal(await connectTo('127.0.0.1', e.port), 'connecté')
  assert.match(e.logs(), /security: listenHost=127\.0\.0\.1 \(env\)/)
})

test('startup log: one line, effective values and sources (config of an instance that keeps the old behavior), no secret', { timeout: 60_000 }, async t => {
  const cfg = bootConfig({ security: { anonymousRead: true, httpLogin: true, adminCidrs: ['192.0.2.0/24', '100.64.0.0/10', '127.0.0.1/32'] } })
  const s = await bootServer(t, { config: cfg, env: { ADMIN_PASSWORD_HASH: HASH, TELEGRAM_BOT_TOKEN: 'SENTINELLE-telegram-journal' } })
  const lines = s.logs().split('\n').filter(l => l.startsWith('security: '))
  assert.deepEqual(lines, ['security: listenHost=127.0.0.1 (env) ; anonymousRead=true (config) ; httpLogin=true (config) ; adminCidrs=192.0.2.0/24,100.64.0.0/10,127.0.0.1/32 (config)'])
  assert.doesNotMatch(s.logs(), /SENTINELLE|scrypt\$/)
  const d = await bootServer(t)
  assert.match(d.logs(), /^security: listenHost=127\.0\.0\.1 \(env\) ; anonymousRead=false \(default\) ; httpLogin=false \(default\) ; adminCidrs=127\.0\.0\.1\/32 \(default\)$/m)
})

// --- sentinel secrets --------------------------------------------------------------------------

// local fake upstream: answers 500 to everything, keeps the requests (proof that the secrets were used)
async function upstream(t) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d })
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)} ${body}`)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('erreur factice')
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return { port: srv.address().port, seen }
}

const S = {
  pveId: 'SENTINELLE-pve-id', pveSecret: 'SENTINELLE-pve-secret', widgetQuery: 'SENTINELLE-widget-query',
  widgetHeader: 'SENTINELLE-widget-header', pihole: 'SENTINELLE-pihole', version: 'SENTINELLE-version',
  ha: 'SENTINELLE-ha', github: 'SENTINELLE-github', telegram: 'SENTINELLE-telegram', hc: 'SENTINELLE-healthchecks',
  ssh: 'SENTINELLE-ssh', gitea: 'SENTINELLE-gitea', bearer: 'SENTINELLE-bearer',
  qbitUser: 'SENTINELLE-qbit-user', qbitPass: 'SENTINELLE-qbit-pass',
}
function sentinelSetup(port, over = {}) {
  const base = `http://127.0.0.1:${port}`
  const config = bootConfig({
    ...over,
    proxmox: [{ id: 'pve', label: 'PVE factice', host: base, env: 'PVETEST' }],
    services: [
      { id: 'wq', name: 'Widget requête', group: 'g', host: 'web', url: `${base}/`, widget: { url: base, auth: { type: 'query', name: 'apikey', secretEnv: 'WIDGET_QUERY_KEY' }, fields: [{ label: 'x', path: '/stats', json: 'x' }] } },
      { id: 'wh', name: 'Widget en-tête', group: 'g', host: 'web', url: `${base}/`, widget: { url: base, auth: { type: 'header', name: 'X-API-Key', secretEnv: 'WIDGET_HEADER_KEY' }, fields: [{ label: 'y', path: '/stats', json: 'y' }] } },
      { id: 'ph', name: 'Pi-hole factice', group: 'g', host: 'web', url: `${base}/admin/`, widget: { url: base, auth: { type: 'pihole', secretEnv: 'PIHOLE_PW' }, fields: [{ label: 'z', path: '/api/stats/summary', json: 'z' }] } },
      { id: 'ver', name: 'Version factice', group: 'g', host: 'web', url: `${base}/`, version: { current: { from: 'http-json', url: `${base}/version`, path: 'v', auth: { type: 'header', name: 'Authorization', secretEnv: 'VERSION_KEY' } }, latest: { from: 'http-json', url: `${base}/latest`, path: 'v' } } },
      { id: 'ha', name: 'HA factice', group: 'g', host: 'web', url: `${base}/`, version: { from: 'ha', url: base, secretEnv: 'HA_TOKEN' } },
      { id: 'wb', name: 'Widget bearer', group: 'g', host: 'web', url: `${base}/`, widget: { url: base, auth: { type: 'bearer', secretEnv: 'WIDGET_BEARER' }, fields: [{ label: 'b', path: '/stats', json: 'b' }] } },
      { id: 'qb', name: 'qBittorrent factice', group: 'g', host: 'web', url: `${base}/`, widget: { url: base, auth: { type: 'qbittorrent', userEnv: 'QBIT_USER', secretEnv: 'QBIT_PASSWORD' }, fields: [{ label: 'q', path: '/api/v2/transfer/info', json: 'dl_info_speed' }] } },
    ],
    gitea: { owner: 'factice', repos: ['depot'] },
  })
  const env = {
    ADMIN_PASSWORD_HASH: HASH, PVETEST_TOKEN_ID: S.pveId, PVETEST_TOKEN_SECRET: S.pveSecret,
    WIDGET_QUERY_KEY: S.widgetQuery, WIDGET_HEADER_KEY: S.widgetHeader, PIHOLE_PW: S.pihole, VERSION_KEY: S.version,
    HA_TOKEN: S.ha, GITHUB_TOKEN: S.github, TELEGRAM_BOT_TOKEN: S.telegram, HEALTHCHECKS_PING_URL: `${base}/ping/${S.hc}`,
    DASHREPORT_SSH_KEY: `/chemin/factice/${S.ssh}`, GITEA_URL: base, GITEA_TOKEN: S.gitea,
    WIDGET_BEARER: S.bearer, QBIT_USER: S.qbitUser, QBIT_PASSWORD: S.qbitPass,
  }
  return { config, env }
}
// every form of a secret that a response could carry
const needles = () => [...Object.values(S), HASH, HASH.split('$')[4], HASH.split('$')[5], encodeURIComponent(S.widgetQuery)]
const leaks = body => needles().filter(n => body.includes(n))

async function getAll(port, headers = {}) {
  const out = []
  for (const p of [...GET_ROUTES, '/api/summary?env=prod', '/api/history/bands?range=7d', '/api/network/history?days=7']) {
    const r = await request(port, p, { headers })
    out.push({ p, status: r.status, body: `${JSON.stringify(r.headers)}\n${r.body}` })
  }
  return out
}

test('sentinel secrets: no GET response contains an env or config secret, with an admin session, with anonymous read and without a session', { timeout: 90_000 }, async t => {
  const up = await upstream(t)
  // admin session (default: no anonymous read)
  const a = sentinelSetup(up.port)
  const s = await bootServer(t, { config: a.config, env: a.env })
  // the secrets were indeed used upstream (otherwise the test would prove nothing)
  // (the monitoring ping goes out at the earliest after 60 s: its URL is still searched for in the responses)
  const used = [S.pveSecret, S.widgetQuery, S.widgetHeader, S.bearer, S.qbitPass]
  assert.ok(await until(() => used.every(x => up.seen.some(l => l.includes(x))), 30_000), `unused secrets: ${used.filter(x => !up.seen.some(l => l.includes(x))).join(', ')}`)
  // and the sources failed (error messages in the responses) before the read
  assert.ok(await until(async () => JSON.stringify((await request(s.port, '/api/healthz')).json).includes('"completed"'), 10_000))
  const origin = { origin: `http://127.0.0.1:${s.port}` }
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: origin })
  assert.equal(login.status, 200)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  // Gitea: read on demand (/api/gitea, /api/runners), hence after a first read
  await request(s.port, '/api/gitea', { headers: { cookie } })
  await request(s.port, '/api/runners', { headers: { cookie } })
  assert.ok(await until(() => up.seen.some(l => l.includes(S.gitea)), 10_000), 'Gitea token sent upstream')
  const admin = await getAll(s.port, { cookie })
  assert.ok(admin.filter(r => r.status === 200).length >= 20, admin.map(r => `${r.p} ${r.status}`).join(' '))
  for (const r of admin) assert.deepEqual(leaks(r.body), [], `admin session, ${r.p}`)
  const closed = await getAll(s.port)
  for (const r of closed) assert.deepEqual(leaks(r.body), [], `without a session, ${r.p}`)
  assert.deepEqual(leaks(s.logs().split('\n').filter(l => l.startsWith('security: ')).join('\n')), [])
  // anonymous read, without a session
  const b = sentinelSetup(up.port, ANON)
  const s2 = await bootServer(t, { config: b.config, env: b.env })
  assert.ok(await until(() => up.seen.filter(l => l.includes(S.widgetQuery)).length >= 2, 30_000))
  const anon = await getAll(s2.port)
  assert.ok(anon.filter(r => r.status === 200).length >= 20, anon.map(r => `${r.p} ${r.status}`).join(' '))
  for (const r of anon) assert.deepEqual(leaks(r.body), [], `anonymous read, ${r.p}`)
})
