// Routes of the REAL server/index.js, started by test/server-boot.js (fake config, ENV_FILE=none,
// temporary database, port 0). A fake local HTTP service (127.0.0.1:0) is the target of the only
// probe. Complements host-guard, proxy and security-headers (reduced applications): here, the
// full chain of index.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { hashPassword } from '../lib/auth.js'
import { bootServer, bootConfig, request, until } from './server-boot.js'

const PASSWORD = 'mot de passe factice du banc'
const HASH = await hashPassword(PASSWORD)

// fake service: / → 200 "pong-factice"
async function fakeService(t) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('pong-factice')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return srv.address().port
}
// anonymous read: these tests read the API without a session (response shapes, 404); the default
// (session required) is covered by safe-defaults.test.js
const ANON = { security: { anonymousRead: true } }
const withService = port => bootConfig({
  ...ANON,
  services: [{ id: 'web', name: 'Web factice', group: 'g', host: 'web', checks: [{ type: 'http', url: `http://127.0.0.1:${port}/`, expect: { body: 'pong-factice' }, label: 'accueil' }] }],
})

test('public routes of index.js: response shapes, real probe to a fake local service', { timeout: 30_000 }, async t => {
  const port = await fakeService(t)
  const s = await bootServer(t, { config: withService(port) })
  assert.ok(await until(async () => (await request(s.port, '/api/healthz')).json?.completed >= 1), 'first probe finished')
  const svc = (await request(s.port, '/api/services')).json
  assert.deepEqual(svc.groups, [{ id: 'g', name: 'Groupe', icon: null }])
  assert.equal(svc.services.length, 1)
  const w = svc.services[0]
  assert.deepEqual([w.id, w.state, w.host.id, w.host.ip, w.checks.length], ['web', 'ok', 'web', '127.0.0.1', 1])
  assert.deepEqual([w.checks[0].type, w.checks[0].state, w.checks[0].code, w.checks[0].target], ['http', 'ok', 200, `http://127.0.0.1:${port}/`])
  assert.deepEqual(svc.summary, { total: 1, ok: 1, warn: 0, crit: 0, unknown: 0, none: 0 })
  assert.deepEqual((await request(s.port, '/api/config')).json, { title: 'Banc de test (données factices)', locale: 'fr' })
  const sum = (await request(s.port, '/api/summary?env=prod')).json
  assert.equal(sum.services.total, 1)
  assert.equal(sum.weather, null)
  const al = (await request(s.port, '/api/alerts')).json
  assert.ok(Array.isArray(al.active) && Array.isArray(al.incidents))
  assert.equal(al.notifier.heartbeat, null)
  assert.deepEqual(Object.keys((await request(s.port, '/api/silences')).json).sort(), ['active', 'recent'])
  const sess = (await request(s.port, '/api/session')).json
  assert.deepEqual([sess.admin, sess.configured, sess.networkAllowed, sess.bot.enabled], [false, false, true, false])
  const hist = await request(s.port, '/api/history/service/web?range=7d')
  assert.equal(hist.status, 200)
  assert.deepEqual([hist.json.id, hist.json.range, hist.json.checks.length], ['web', '7d', 1])
  const health = (await request(s.port, '/api/health')).json
  assert.deepEqual(health.map(h => [h.name, h.status, h.code]), [['Web factice · accueil', 'up', 200]])
  for (const p of ['/api/agents', '/api/updates', '/api/history/bands?range=24h', '/api/refresh']) {
    const r = await request(s.port, p)
    assert.equal(r.status, 200, p)
    assert.match(r.headers['content-type'], /^application\/json/, p)
  }
})

test('404: unknown API route as JSON (GET and POST), unknown service, missing asset as no-store; CSP on each', { timeout: 30_000 }, async t => {
  const s = await bootServer(t, { config: bootConfig(ANON) })
  for (const [p, method] of [['/api/nope', 'GET'], ['/api/nope', 'POST']]) {
    const r = await request(s.port, p, { method, body: method === 'POST' ? {} : null })
    assert.equal(r.status, 404, `${method} ${p}`)
    assert.deepEqual(r.json, { error: 'route inconnue' })
  }
  const h = await request(s.port, '/api/history/service/inconnu')
  assert.deepEqual([h.status, h.json], [404, { error: 'service inconnu' }])
  const a = await request(s.port, '/assets/Ci-ancien.js')
  assert.deepEqual([a.status, a.headers['cache-control'], a.body], [404, 'no-store', 'fichier introuvable'])
  for (const r of [h, a]) {
    assert.ok(r.headers['content-security-policy'])
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.equal(r.headers['x-powered-by'], undefined)
  }
  const bad = await request(s.port, '/api/login', { method: 'POST', body: '{pas du json', headers: { origin: `http://127.0.0.1:${s.port}` } })
  assert.deepEqual([bad.status, typeof bad.json?.error], [400, 'string'])
  assert.doesNotMatch(bad.body, /at |index\.js|node_modules/)
})

test('writes without a session refused (401, nothing written); foreign Origin 403; login not configured 503', { timeout: 30_000 }, async t => {
  const s = await bootServer(t, { config: bootConfig(ANON) })
  const origin = { origin: `http://127.0.0.1:${s.port}` }
  for (const p of ['/api/silences', '/api/silences/end', '/api/alerts/ack', '/api/alerts/unack', '/api/refresh', '/api/updates/decisions', '/api/updates/decisions/remove',
    '/api/agents/posture/accept', '/api/agents/posture/unaccept', '/api/agents/ports/known']) {
    const r = await request(s.port, p, { method: 'POST', body: { matcher: { key: 'x' }, reason: 'test' }, headers: origin })
    assert.equal(r.status, 401, p)
    assert.deepEqual(r.json, { error: 'connexion admin requise' }, p)
  }
  const foreign = await request(s.port, '/api/silences', { method: 'POST', body: {}, headers: { origin: 'http://evil.example' } })
  assert.equal(foreign.status, 403)
  assert.deepEqual((await request(s.port, '/api/silences')).json.active, [])
  assert.equal((await request(s.port, '/api/audit')).status, 401)
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: origin })
  assert.equal(login.status, 503)
})

test('write with a test session (fake hash): login, silence set, readable audit log; logout', { timeout: 30_000 }, async t => {
  const s = await bootServer(t, { env: { ADMIN_PASSWORD_HASH: HASH } })
  const origin = { origin: `http://127.0.0.1:${s.port}` }
  const wrong = await request(s.port, '/api/login', { method: 'POST', body: { password: 'faux' }, headers: origin })
  assert.equal(wrong.status, 401)
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: origin })
  assert.equal(login.status, 200)
  const cookie = login.headers['set-cookie'][0].split(';')[0]
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/)
  assert.doesNotMatch(login.headers['set-cookie'][0], /Secure/, 'local HTTP: no Secure')
  const auth = { ...origin, cookie }
  assert.equal((await request(s.port, '/api/session', { headers: { cookie } })).json.admin, true)
  const sil = await request(s.port, '/api/silences', { method: 'POST', body: { matcher: { service: 'web' }, reason: 'maintenance factice' }, headers: auth })
  assert.equal(sil.status, 200, sil.body)
  assert.equal(sil.json.reason, 'maintenance factice')
  // read with the session (default: no anonymous read)
  assert.equal((await request(s.port, '/api/silences', { headers: { cookie } })).json.active.length, 1)
  // without Origin, even with the session: refused, and logged one by one (valid session)
  const noOrigin = await request(s.port, '/api/silences/end', { method: 'POST', body: { id: sil.json.id }, headers: { cookie } })
  assert.equal(noOrigin.status, 403)
  const audit = await request(s.port, '/api/audit', { headers: { cookie } })
  assert.equal(audit.status, 200)
  const rows = audit.json.map(r => [r.action, r.actor, r.ok])
  assert.ok(rows.some(([a, who, ok]) => a === 'login' && who === '127.0.0.1' && ok), JSON.stringify(rows))
  assert.ok(rows.some(([a, who]) => a === 'silence' && who === 'admin (127.0.0.1)'), JSON.stringify(rows))
  assert.ok(rows.some(([a, , ok]) => a === 'POST /api/silences/end' && !ok), JSON.stringify(rows))
  // action label via the catalog (French instance: the former French text), unknown action
  // (refusal of a route) as is
  const labels = Object.fromEntries(audit.json.map(r => [r.action, r.label]))
  assert.deepEqual([labels.login, labels.silence, labels['POST /api/silences/end']], ['connexion', 'silence', 'POST /api/silences/end'])
  assert.equal((await request(s.port, '/api/logout', { method: 'POST', body: {}, headers: auth })).status, 200)
  assert.equal((await request(s.port, '/api/session', { headers: { cookie } })).json.admin, false)
})

test('Host header not in the list → 421 on the API, static files and writes; allowed Host (localhost) → 200', { timeout: 30_000 }, async t => {
  const s = await bootServer(t)
  for (const [p, method] of [['/api/healthz', 'GET'], ['/assets/x.js', 'GET'], ['/api/silences', 'POST'], ['/', 'GET']]) {
    const r = await request(s.port, p, { method, host: 'evil.example', body: method === 'POST' ? {} : null })
    assert.equal(r.status, 421, `${method} ${p}`)
    assert.doesNotMatch(r.body, /Banc de test|web-factice/)
  }
  assert.equal((await request(s.port, '/api/healthz', { host: `localhost:${s.port}` })).status, 200)
})
