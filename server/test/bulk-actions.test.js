// Bulk actions, server side. Modules (real engine, real agent memory, real database
// in a temporary folder) then routes of the REAL server/index.js (test/server-boot.js: fake
// config, ENV_FILE=none, temporary database, no Telegram); fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../lib/config.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { cleanSlow } from '../lib/agents.js'
import { createAgentMemory } from '../lib/agentmemory.js'
import { ackMany, knownMany, ackMessage, BULK_MAX } from '../lib/alerts/bulk.js'
import { hashPassword } from '../lib/auth.js'
import { openDb } from '../lib/db.js'
import { tmpStore } from './tmpdir.js'
import { bootServer, bootConfig, request, until } from './server-boot.js'

const T = Date.parse('2026-11-03T10:00:00Z')
const H = 3600_000
const CFG = parseConfig({
  version: 2, title: 't', locale: 'fr', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [{ id: 'dp', name: 'docker-a', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.231', env: 'prod', agent: 'ssh' }],
}).config

// real engine on fixed signals: a, b, c firing; p pending (forSec)
function engineBench(t) {
  const store = tmpStore('dash-l17-bulk-', t)
  const sig = (key, over = {}) => ({ key, rule: 'port_new', entity: 'dp', hostId: 'dp', title: `Titre ${key}`, env: 'prod', cond: true, severity: 'info', parents: [], ...over })
  const rules = { evaluate: () => [sig('a'), sig('b'), sig('c'), sig('p', { forSec: 3600 })], impacted: () => ({}) }
  const notifier = { enqueue: () => 'digest' }
  const engine = createEngine({ cfg: CFG, store, rules, notifier, clock: createClock('Europe/Paris'), startedAt: T - H })
  engine.evaluate({}, T)
  return { engine, store }
}

test('ackMany: result per key (unknown, not firing, already acknowledged), not all-or-nothing; duplicates counted once', t => {
  const { engine } = engineBench(t)
  engine.ack('c', { by: 'admin', reason: 'déjà vu', t: T })
  const r = ackMany(engine, { keys: ['a', 'zz', 'p', 'c', 'b', 'a'], reason: '  ports NFS fixés  ', by: 'admin (lan)', t: T + 1000 })
  assert.deepEqual(r, [
    { key: 'a', ok: true, title: 'Titre a' },
    { key: 'zz', ok: false, error: 'alerte inconnue' },
    { key: 'p', ok: false, error: 'alerte non déclenchée' },
    { key: 'c', ok: false, error: 'déjà acquittée' },
    { key: 'b', ok: true, title: 'Titre b' },
  ])
  assert.deepEqual(engine.get('a').ack, { by: 'admin (lan)', reason: 'ports NFS fixés', at: T + 1000, until: null })
  assert.equal(engine.get('c').ack.reason, 'déjà vu', 'existing ack unchanged')
  assert.equal(engine.get('p').ack, null)
})

test(`ackMany: whole batch refused (400) without a reason, empty, over ${BULK_MAX}, invalid key or expiry; nothing is acknowledged`, t => {
  t.mock.method(Date, 'now', () => T) // engine.get hides an expired ack based on the real clock
  const { engine } = engineBench(t)
  const bad = (args, re) => assert.throws(() => ackMany(engine, { by: 'admin', t: T, reason: 'motif valable', ...args }), e => e.status === 400 && re.test(e.message), re.source)
  bad({ keys: ['a'], reason: '' }, /motif obligatoire/)
  bad({ keys: ['a'], reason: 'ab' }, /motif obligatoire/)
  bad({ keys: ['a'], reason: 'x'.repeat(201) }, /motif obligatoire/)
  bad({ keys: [] }, /liste vide/)
  bad({ keys: 'a' }, /liste vide/)
  bad({ keys: Array.from({ length: BULK_MAX + 1 }, (_, i) => `k${i}`) }, /200 au plus/)
  bad({ keys: ['a', 3] }, /clé d'alerte invalide/)
  bad({ keys: ['a', 'x'.repeat(301)] }, /clé d'alerte invalide/)
  bad({ keys: ['a'], until: T - 1 }, /échéance invalide/)
  bad({ keys: ['a'], until: T + 91 * 24 * H }, /échéance invalide/)
  assert.equal(engine.get('a').ack, null)
  // exactly BULK_MAX: accepted (unknown keys fail, a acknowledged)
  const r = ackMany(engine, { keys: ['a', ...Array.from({ length: BULK_MAX - 1 }, (_, i) => `k${i}`)], reason: 'motif valable', until: T + H, by: 'admin', t: T })
  assert.equal(r.length, BULK_MAX)
  assert.deepEqual(r.filter(x => x.ok).map(x => x.key), ['a'])
  assert.equal(engine.get('a').ack.until, T + H)
})

test('ackMessage: one notification for the batch, titles listed up to 5 then "… and N others", HTML escaped; a single alert: single-ack message', () => {
  assert.equal(ackMessage(['Port tcp/1 · docker-a'], 'motif <b>'), '✅ <b>Port tcp/1 · docker-a</b> acquittée depuis le dashboard : motif &lt;b&gt;')
  const titles = Array.from({ length: 12 }, (_, i) => `Port tcp/${i} · docker-a`)
  const m = ackMessage(titles, 'ports NFS fixés')
  assert.equal(m.split('\n')[0], '✅ <b>12 alertes acquittées</b> depuis le dashboard : ports NFS fixés')
  assert.deepEqual(m.split('\n').slice(1), ['• Port tcp/0 · docker-a', '• Port tcp/1 · docker-a', '• Port tcp/2 · docker-a', '• Port tcp/3 · docker-a', '• Port tcp/4 · docker-a', '… et 7 autres'])
  assert.equal(ackMessage(titles.slice(0, 6), 'x y z').split('\n').at(-1), '… et 1 autre')
  assert.equal(ackMessage(titles.slice(0, 5), 'x y z').split('\n').length, 6)
  assert.match(ackMessage(['a'.repeat(200), 'b'], 'x y z'), /• a{79}…\n/)
  // batch of several alerts, reason and titles escaped (Telegram HTML), IP masked
  assert.equal(ackMessage(['Service <script> & co', 'Disque · 192.0.2.10'], 'motif <b>gras</b> & "x"'), [
    '✅ <b>2 alertes acquittées</b> depuis le dashboard : motif &lt;b&gt;gras&lt;/b&gt; &amp; "x"',
    '• Service &lt;script&gt; &amp; co',
    '• Disque · ‹ip›',
  ].join('\n'))
})

test('knownMany: result per port (known, already known, unknown, invalid), duplicates once; reason and cap refuse the batch', t => {
  const store = tmpStore('dash-l17-known-', t)
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: ['dp'] })
  const L = (...ports) => ports.map(p => ({ proto: 'tcp', addr: '0.0.0.0', port: p, process: 'x' }))
  const report = (at, listening) => ({ hosts: [{ id: 'dp' }], get: () => ({ slow: cleanSlow({ version: 8, ts: Math.floor(at / 1000), listening }), slowAt: at }) })
  mem.observe(report(T, L(22)), T)
  mem.observe(report(T + H, L(22, 32765, 32768)), T + H)
  const r = knownMany(mem, { items: [
    { host: 'dp', proto: 'tcp', port: 32765 }, { host: 'dp', proto: 'tcp', port: 22 }, { host: 'dp', proto: 'tcp', port: 9 },
    { host: 'zz', proto: 'tcp', port: 1 }, { host: 'dp', proto: 'sctp', port: 1 }, 'x', { host: 'dp', proto: 'tcp', port: '32768' }, { host: 'dp', proto: 'tcp', port: 32765 },
  ], reason: 'ports NFS fixes', by: 'admin', now: T + 2 * H })
  assert.deepEqual(r.map(x => [x.host, x.proto, x.port, x.ok, x.error ?? null]), [
    ['dp', 'tcp', 32765, true, null],
    ['dp', 'tcp', 22, false, 'port déjà connu'],
    ['dp', 'tcp', 9, false, 'port inconnu ou fermé'],
    ['zz', 'tcp', 1, false, 'hôte inconnu'],
    ['dp', 'sctp', 1, false, 'protocole invalide'],
    [null, null, null, false, 'élément invalide'],
    ['dp', 'tcp', 32768, true, null],
  ])
  assert.equal(mem.portRow('dp', 'tcp', 32765).known_reason, 'ports NFS fixes')
  const bad = (args, re) => assert.throws(() => knownMany(mem, { by: 'admin', reason: 'motif valable', ...args }), e => e.status === 400 && re.test(e.message))
  bad({ items: [{ host: 'dp', proto: 'tcp', port: 22 }], reason: ' ' }, /motif/)
  bad({ items: [] }, /liste vide/)
  bad({ items: Array.from({ length: BULK_MAX + 1 }, (_, i) => ({ host: 'dp', proto: 'tcp', port: i + 1 })) }, /200 au plus/)
})

const PASSWORD = 'mot de passe factice du banc'
const HASH = await hashPassword(PASSWORD)
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// closed local port (listened on then released): probes fail on it right away
async function closedPort() {
  const srv = http.createServer()
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise(r => srv.close(r))
  return port
}

test('bulk routes: without a session 401; with a session: 400 (reason, cap, 200-key body read despite the 8 kB limit), partial result, one audit entry per alert, ONE notification', { timeout: 60_000 }, async t => {
  const dead = await closedPort()
  const svc = id => ({ id, name: `Service ${id}`, group: 'g', host: 'web', checks: [{ type: 'http', url: `http://127.0.0.1:${dead}/${id}`, label: id, interval: '5s' }] })
  // anonymous read: alerts are polled by GET without a session; writes stay guarded
  const config = bootConfig({ security: { anonymousRead: true }, services: [svc('s1'), svc('s2'), svc('s3')], alerts: { startupGraceSec: 0, failAfter: 1 } })
  const s = await bootServer(t, { config, env: { ADMIN_PASSWORD_HASH: HASH } })
  const origin = { origin: `http://127.0.0.1:${s.port}` }
  for (const p of ['/api/alerts/ack/bulk', '/api/agents/ports/known/bulk']) {
    const r = await request(s.port, p, { method: 'POST', body: { keys: ['x'], items: [], reason: 'test lot' }, headers: origin })
    assert.deepEqual([r.status, r.json], [401, { error: 'connexion admin requise' }], p)
  }
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: origin })
  assert.equal(login.status, 200)
  const auth = { ...origin, cookie: login.headers['set-cookie'][0].split(';')[0] }
  const post = (p, body) => request(s.port, p, { method: 'POST', body, headers: auth })
  const firing = async () => ((await request(s.port, '/api/alerts')).json?.active ?? []).filter(a => a.state === 'firing').map(a => a.key).sort()
  assert.ok(await until(async () => (await firing()).length === 3, 40_000, 250), 'three service_down firing')
  // whole batch refused
  const noReason = await post('/api/alerts/ack/bulk', { keys: ['service_down:s1'], reason: '' })
  assert.deepEqual([noReason.status, noReason.json.error], [400, 'motif obligatoire (3 à 200 caractères)'])
  const big = Array.from({ length: BULK_MAX + 1 }, (_, i) => `service_down:service-inconnu-numero-${i}`)
  assert.ok(JSON.stringify({ keys: big }).length > 8192, 'body over the general limit')
  const tooMany = await post('/api/alerts/ack/bulk', { keys: big, reason: 'motif valable' })
  assert.deepEqual([tooMany.status, tooMany.json.error], [400, `alertes : ${BULK_MAX} au plus par lot (${BULK_MAX + 1} reçus)`])
  const okSize = await post('/api/alerts/ack/bulk', { keys: big.slice(0, BULK_MAX), reason: 'motif valable' })
  assert.deepEqual([okSize.status, okSize.json.ok, okSize.json.failed], [200, 0, BULK_MAX], 'batch of 200 keys read (32 kB): all failed, nothing acknowledged')
  const noItems = await post('/api/agents/ports/known/bulk', { items: [], reason: 'motif valable' })
  assert.equal(noItems.status, 400)
  // partial batch: two acknowledged, one unknown; then the same one: already acknowledged
  const r = await post('/api/alerts/ack/bulk', { keys: ['service_down:s1', 'service_down:s2', 'service_down:zz'], reason: 'panne factice du banc' })
  assert.equal(r.status, 200, r.body)
  assert.deepEqual(r.json, { results: [
    { key: 'service_down:s1', ok: true, title: 'Service s1' },
    { key: 'service_down:s2', ok: true, title: 'Service s2' },
    { key: 'service_down:zz', ok: false, error: 'alerte inconnue' },
  ], ok: 2, failed: 1 })
  const again = await post('/api/alerts/ack/bulk', { keys: ['service_down:s1'], reason: 'panne factice du banc' })
  assert.deepEqual(again.json.results, [{ key: 'service_down:s1', ok: false, error: 'déjà acquittée' }])
  const active = (await request(s.port, '/api/alerts')).json.active
  assert.deepEqual(active.filter(a => a.ack).map(a => [a.key, a.ack.reason]).sort(), [['service_down:s1', 'panne factice du banc'], ['service_down:s2', 'panne factice du banc']])
  // bulk "Known": host without an agent → per-item failure, 200
  const kn = await post('/api/agents/ports/known/bulk', { items: [{ host: 'web', proto: 'tcp', port: 22 }], reason: 'motif valable' })
  assert.deepEqual([kn.status, kn.json.ok, kn.json.results[0].error], [200, 0, 'hôte inconnu'])
  // audit: one row per acknowledged alert, nothing for failures
  const audit = (await request(s.port, '/api/audit', { headers: { cookie: auth.cookie } })).json
  assert.deepEqual(audit.filter(a => a.action === 'ack').map(a => [a.target, a.detail, a.actor]).sort(), [
    ['service_down:s1', 'panne factice du banc', 'admin (127.0.0.1)'],
    ['service_down:s2', 'panne factice du banc', 'admin (127.0.0.1)'],
  ])
  assert.equal(audit.filter(a => a.action === 'port known').length, 0)
  // a single notification for the batch (outbox, read after the service stops)
  await s.stop()
  const store = openDb(s.stateDir)
  const rows = store.db.prepare("SELECT text FROM outbox WHERE kind = 'ack'").all()
  store.db.close()
  assert.deepEqual(rows.map(x => x.text), ['✅ <b>2 alertes acquittées</b> depuis le dashboard : panne factice du banc\n• Service s1\n• Service s2'])
})

test('wiring (static): bulk routes behind admin, 32 kB body for them only, one evaluation per bulk "Known"', () => {
  const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8')
  assert.match(src, /app\.post\('\/api\/alerts\/ack\/bulk', admin, /)
  assert.match(src, /app\.post\('\/api\/agents\/ports\/known\/bulk', admin, /)
  assert.match(src, /app\.use\(\['\/api\/alerts\/ack\/bulk', '\/api\/agents\/ports\/known\/bulk'\], express\.json\(\{ limit: '32kb' \}\)\)\napp\.use\('\/api', express\.json\(\{ limit: '8kb' \}\)\)/)
  const known = src.slice(src.indexOf("app.post('/api/agents/ports/known/bulk'"), src.indexOf("app.post('/api/alerts/unack'"))
  assert.equal(known.match(/engine\.evaluate\(/g).length, 1)
  assert.doesNotMatch(known, /for \([^)]*\) [^\n]*engine\.evaluate/)
})
