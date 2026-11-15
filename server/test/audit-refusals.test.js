// Unauthenticated refusals
// aggregated in the audit log (one row, then a summary per 10 min window).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAudit, createAuth, hashPassword } from '../lib/auth.js'
import { createBot } from '../lib/notify/bot.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createRules } from '../lib/alerts/rules.js'
import { createClock } from '../lib/clock.js'
import { createSilences } from '../lib/alerts/silences.js'
import { createNetwork } from '../lib/network/index.js'
import { prodConfig, prodLikeStore, fakeTelegram } from './network-fixture.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-27T10:00:00Z')
const MIN = 60_000

function bench({ tickMs = 0, setTimer } = {}) {
  const store = tmpStore('dash-audit-')
  const clock = { t: T }
  const audit = createAudit(store, { now: () => clock.t, tickMs, ...(setTimer ? { setTimer } : {}) })
  const rows = () => store.db.prepare('SELECT action, detail, ok FROM audit ORDER BY id').all().map(r => ({ ...r }))
  return { store, clock, audit, rows }
}
// write request refused by auth.require (allowed network, foreign origin)
const reqFrom = ({ ip = '127.0.0.1', origin = 'http://evil.example', json = true } = {}) => ({
  socket: { remoteAddress: ip }, method: 'POST', path: '/api/network/devices/edit',
  get: k => ({ host: '127.0.0.1:8088', origin })[k] ?? null, is: () => json,
})
const resSink = () => ({ status: () => ({ json() {} }) })

test('50 refused POSTs (same IP, same reason) within 1 min → 1 row; after 10 min and one more refusal → summary of 49 more refusals and 1 new row', () => {
  const b = bench()
  const auth = createAuth({ store: b.store, audit: b.audit, env: { ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }, now: () => b.clock.t })
  for (let i = 0; i < 50; i++) {
    b.clock.t = T + i * 1000
    auth.require(reqFrom(), resSink(), () => assert.fail('accepted'))
  }
  assert.deepEqual(b.rows(), [{ action: 'POST /api/network/devices/edit', detail: 'origine refusée', ok: 0 }])
  b.clock.t = T + 10 * MIN + 1000
  auth.require(reqFrom(), resSink(), () => assert.fail('accepted'))
  const r = b.rows()
  assert.equal(r.length, 3)
  assert.equal(r[1].detail, '49 refus de plus en 10 min (origine refusée)')
  assert.equal(r[2].detail, 'origine refusée')
})

test('two different reasons → 2 rows', () => {
  const b = bench()
  const auth = createAuth({ store: b.store, audit: b.audit, env: { ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }, now: () => b.clock.t })
  for (let i = 0; i < 5; i++) {
    auth.require(reqFrom(), resSink(), () => {})
    auth.require(reqFrom({ origin: 'http://127.0.0.1:8088', json: false }), resSink(), () => {})
  }
  assert.deepEqual(b.rows().map(r => r.detail), ['origine refusée', 'corps JSON attendu'])
})

test('1,001 keys → 1,000 in memory, the oldest one summarized then forgotten', () => {
  const b = bench()
  const entry = i => ({ actor: `192.0.2.${i % 250}-${i}`, source: 'ui', action: 'connexion', detail: 'mot de passe incorrect' })
  b.audit.refused(entry(0))
  b.audit.refused(entry(0)) // the oldest one has a pending refusal
  for (let i = 1; i <= 1000; i++) b.audit.refused(entry(i))
  assert.equal(b.audit.pendingCount(), 1000)
  const synth = b.rows().filter(r => /refus de plus/.test(r.detail))
  assert.deepEqual(synth.map(r => r.detail), ['1 refus de plus en 10 min (mot de passe incorrect)'])
})

test('successful login and successful write → one row each, no aggregation', async () => {
  const b = bench()
  const hash = await hashPassword('mot de passe solide')
  const auth = createAuth({ store: b.store, audit: b.audit, env: { ADMIN_PASSWORD_HASH: hash, ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }, now: () => b.clock.t })
  const req = { socket: { remoteAddress: '127.0.0.1' }, get: () => null, secure: false }
  for (let i = 0; i < 2; i++) assert.equal((await auth.login(req, { setHeader() {} }, 'mot de passe solide')).ok, true)
  for (let i = 0; i < 2; i++) b.audit.log({ actor: 'admin (127.0.0.1)', source: 'ui', action: 'ack', target: 'service_down:x', detail: 'motif' })
  assert.deepEqual(b.rows().map(r => [r.action, r.ok]), [['login', 1], ['login', 1], ['ack', 1], ['ack', 1]])
})

test('bot: 20 messages from an unknown account → 1 row, then the summary', async () => {
  const T0 = Date.parse('2026-10-21T08:00:00Z')
  const cfg = prodConfig()
  const { store } = prodLikeStore({ T: T0 })
  const clock = { t: T0 }
  const audit = createAudit(store, { now: () => clock.t, tickMs: 0 })
  const network = createNetwork({ cfg, store, audit, now: () => clock.t, log: { warn() {}, error() {} } })
  const tz = createClock('Europe/Paris')
  const monitor = { checks: [], result: () => null }
  const engine = createEngine({ cfg, store, rules: createRules(cfg, monitor, null, null, network), notifier: { enqueue: () => 'now' }, clock: tz, startedAt: T0 })
  const bot = createBot({ telegram: fakeTelegram(), store, cfg, engine, silences: createSilences({ store }), refresher: null, audit, clock: tz,
    texts: {}, allowedIds: new Set(['42']), network, log: { warn() {}, error() {}, log() {} }, now: () => clock.t })
  const intrus = { id: 666, username: 'intrus' }
  for (let i = 0; i < 20; i++) await bot.handle({ message: { text: `/appareil ${i}`, from: intrus, chat: { id: 666 } } })
  const rows = () => store.db.prepare("SELECT detail FROM audit WHERE source = 'telegram' ORDER BY id").all().map(r => r.detail)
  assert.deepEqual(rows(), ['account or chat not authorized'])
  clock.t += 10 * MIN
  audit.tick()
  assert.deepEqual(rows(), ['account or chat not authorized', '19 refus de plus en 10 min (account or chat not authorized)'])
})

test('aggregator own tick: 5 refusals, then 10 min without refusal → 1 summary row; flush on shutdown', () => {
  let tickFn = null
  let every = null
  const b = bench({ tickMs: 10 * MIN, setTimer: (fn, ms) => { tickFn = fn; every = ms } })
  assert.equal(every, 10 * MIN)
  for (let i = 0; i < 5; i++) b.audit.refused({ actor: '127.0.0.1', source: 'ui', action: 'connexion', detail: 'mot de passe incorrect' })
  assert.equal(b.rows().length, 1)
  b.clock.t = T + 9 * MIN
  tickFn() // window not finished yet: nothing
  assert.equal(b.rows().length, 1)
  b.clock.t = T + 10 * MIN
  tickFn()
  assert.deepEqual(b.rows().map(r => r.detail), ['mot de passe incorrect', '4 refus de plus en 10 min (mot de passe incorrect)'])
  assert.equal(b.audit.pendingCount(), 0)
  // service shutdown: pending summaries are written (index.js calls audit.flush())
  b.audit.refused({ actor: '127.0.0.2', source: 'ui', action: 'connexion', detail: 'réseau non autorisé' })
  b.audit.refused({ actor: '127.0.0.2', source: 'ui', action: 'connexion', detail: 'réseau non autorisé' })
  b.audit.flush()
  assert.equal(b.rows().at(-1).detail, '1 refus de plus en 10 min (réseau non autorisé)')
})

// --- login refusals, refusals with a session, single refusal, flush on SIGTERM ---
test('5 refused logins (same IP, same reason) → 1 row', async () => {
  const b = bench()
  const hash = await hashPassword('mot de passe solide')
  const auth = createAuth({ store: b.store, audit: b.audit, env: { ADMIN_PASSWORD_HASH: hash, ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }, now: () => b.clock.t })
  const req = { socket: { remoteAddress: '127.0.0.1' }, get: () => null, secure: false }
  for (let i = 0; i < 5; i++) assert.equal((await auth.login(req, { setHeader() {} }, 'faux')).status, 401)
  assert.deepEqual(b.rows(), [{ action: 'login', detail: 'mot de passe incorrect', ok: 0 }])
})

test('3 refusals WITH a valid session (415) → 3 rows, no aggregation', async () => {
  const b = bench()
  const hash = await hashPassword('mot de passe solide')
  const auth = createAuth({ store: b.store, audit: b.audit, env: { ADMIN_PASSWORD_HASH: hash, ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }, now: () => b.clock.t })
  let cookie = null
  await auth.login({ socket: { remoteAddress: '127.0.0.1' }, get: () => null, secure: false }, { setHeader: (k, v) => { cookie = String(v).split(';')[0] } }, 'mot de passe solide')
  assert.ok(cookie)
  const req = { ...reqFrom({ origin: 'http://127.0.0.1:8088', json: false }) }
  const get = req.get
  req.get = k => (k === 'cookie' ? cookie : get(k))
  for (let i = 0; i < 3; i++) {
    let status = null
    auth.require(req, { status: s => { status = s; return { json() {} } } }, () => assert.fail('accepted'))
    assert.equal(status, 415)
  }
  assert.deepEqual(b.rows().filter(r => r.action !== 'login').map(r => r.detail), ['corps JSON attendu', 'corps JSON attendu', 'corps JSON attendu'])
})

test('a key with ONE single refusal → no summary row, neither on tick nor on flush', () => {
  const b = bench()
  b.audit.refused({ actor: '127.0.0.1', source: 'ui', action: 'connexion', detail: 'mot de passe incorrect' })
  b.audit.refused({ actor: '127.0.0.3', source: 'ui', action: 'connexion', detail: 'mot de passe incorrect' })
  b.clock.t = T + 10 * MIN
  b.audit.tick()
  assert.equal(b.rows().length, 2)
  assert.equal(b.audit.pendingCount(), 0)
  b.audit.refused({ actor: '127.0.0.4', source: 'ui', action: 'connexion', detail: 'mot de passe incorrect' })
  b.audit.flush()
  assert.deepEqual(b.rows().map(r => r.detail), ['mot de passe incorrect', 'mot de passe incorrect', 'mot de passe incorrect'])
})

test('static: audit.flush() in the SIGTERM handler, before store.db.close()', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const i = src.indexOf("for (const sig of ['SIGTERM', 'SIGINT'])")
  assert.ok(i > 0, 'SIGTERM handler')
  const handler = src.slice(i)
  const f = handler.indexOf('audit.flush()'), c = handler.indexOf('store.db.close()')
  assert.ok(f > 0 && f < c, 'audit.flush() before store.db.close()')
})
