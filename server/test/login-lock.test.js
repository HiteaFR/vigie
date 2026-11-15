// Login lock. Per-IP cap
// (5) for all; global cap (20) for unknown IPs only; known IP = successful login
// in the audit within 30 days (socket IP, never a header); attempt reserved BEFORE
// the password check. auth.login called with fake requests; checks
// counted by a spy (fast, instead of scrypt).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAuth, createAudit, hashPassword } from '../lib/auth.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-27T10:00:00Z')
const DAY = 86400_000
const GOOD = 'mot de passe de test'
const HASH = await hashPassword(GOOD)
// slow check simulated by one event loop turn (setImmediate), not a delay
const nextTurn = () => new Promise(r => setImmediate(r))

function bench() {
  const store = tmpStore('dash-login-lock-')
  const audit = createAudit(store, { tickMs: 0, now: () => T })
  const spy = { calls: 0 }
  const verify = async password => {
    spy.calls++
    await nextTurn()
    return password === GOOD
  }
  // httpLogin: attempts come from LAN IPs over HTTP (the lock is the subject, not the transport)
  const auth = createAuth({ store, audit, now: () => T, verify, log: { error() {} }, httpLogin: true,
    env: { ADMIN_PASSWORD_HASH: HASH, ADMIN_ALLOWED_CIDRS: '192.0.2.0/24,198.51.100.0/24' } })
  const req = (ip, xff = null) => ({ socket: { remoteAddress: ip }, secure: false, get: k => (k.toLowerCase() === 'x-forwarded-for' ? xff : null) })
  const login = (ip, password = 'faux', xff = null) => auth.login(req(ip, xff), { setHeader() {} }, password)
  // past successful login, as the audit writes it (actor = IP, ok = 1)
  const pastSuccess = (ip, agoMs) => audit.log({ actor: ip, source: 'ui', action: 'connexion', ok: true, at: T - agoMs })
  const twentyUnknown = async () => {
    for (let i = 1; i <= 20; i++) assert.equal((await login(`198.51.100.${i}`)).status, 401)
  }
  const auditOk = () => store.db.prepare("SELECT actor FROM audit WHERE action = 'login' AND ok = 1 AND at = ?").all(T).map(r => r.actor)
  const auditCount = ip => store.db.prepare('SELECT COUNT(*) n FROM audit WHERE actor = ?').get(ip).n
  return { auth, audit, spy, login, pastSuccess, twentyUnknown, auditOk, auditCount }
}

test('one IP: 5 failures, the 6th attempt → 429 without check', async () => {
  const b = bench()
  for (let i = 0; i < 5; i++) assert.equal((await b.login('192.0.2.10')).status, 401)
  assert.equal(b.spy.calls, 5)
  const r = await b.login('192.0.2.10', GOOD)
  assert.equal(r.status, 429)
  assert.equal(b.spy.calls, 5)
})

test('20 failures from 20 unknown IPs → a 21st unknown IP gets 429', async () => {
  const b = bench()
  await b.twentyUnknown()
  const r = await b.login('198.51.100.21', GOOD)
  assert.equal(r.status, 429)
  assert.equal(b.spy.calls, 20)
})

test('after 20 unknown failures, a known IP (success 3 days ago) logs in → 200', async () => {
  const b = bench()
  b.pastSuccess('192.0.2.200', 3 * DAY)
  await b.twentyUnknown()
  const r = await b.login('192.0.2.200', GOOD)
  assert.equal(r.ok, true)
})

test('failures of a known IP do not count toward the global cap: 4 known failures + 16 unknown → the 17th unknown IP gets 401, not 429', async () => {
  const b = bench()
  b.pastSuccess('192.0.2.200', 3 * DAY)
  for (let i = 0; i < 4; i++) assert.equal((await b.login('192.0.2.200')).status, 401)
  for (let i = 1; i <= 16; i++) assert.equal((await b.login(`198.51.100.${i}`)).status, 401)
  assert.equal((await b.login('198.51.100.17')).status, 401)
})

test('end to end: a REAL successful login from X, then 20 failures from unknown IPs → X logs in (200)', async () => {
  const b = bench()
  assert.equal((await b.login('192.0.2.50', GOOD)).ok, true)
  await b.twentyUnknown()
  assert.equal((await b.login('198.51.100.21', GOOD)).status, 429) // control: an unknown one is blocked
  assert.equal((await b.login('192.0.2.50', GOOD)).ok, true)
})

test('login refusal (ok = 0) and success of ANOTHER action in the audit: the IP stays unknown → 429 after 20 unknown failures', async () => {
  const b = bench()
  const ip = '192.0.2.60'
  // 3 refusals through the real refused() path (different reasons: 3 rows, no aggregation)
  for (const detail of ['mot de passe incorrect', 'réseau non autorisé', 'trop d\'essais, réessayer dans 15 min']) {
    b.audit.refused({ actor: ip, source: 'ui', action: 'connexion', detail, at: T - DAY })
  }
  b.audit.log({ actor: ip, source: 'ui', action: 'POST /api/network/devices/edit', ok: true, at: T - DAY })
  assert.equal(b.auditCount(ip), 4)
  await b.twentyUnknown()
  assert.equal((await b.login(ip, GOOD)).status, 429)
})

test('known IP, 5 own failures → 429 (per-IP cap kept)', async () => {
  const b = bench()
  b.pastSuccess('192.0.2.200', 3 * DAY)
  for (let i = 0; i < 5; i++) assert.equal((await b.login('192.0.2.200')).status, 401)
  assert.equal((await b.login('192.0.2.200', GOOD)).status, 429)
})

test('IP known 31 days ago → treated as unknown (429 after 20 unknown failures)', async () => {
  const b = bench()
  b.pastSuccess('192.0.2.201', 31 * DAY)
  b.pastSuccess('192.0.2.202', 29 * DAY)
  await b.twentyUnknown()
  assert.equal((await b.login('192.0.2.201', GOOD)).status, 429)
  assert.equal((await b.login('192.0.2.202', GOOD)).ok, true) // control: within the window
})

test('unknown socket with X-Forwarded-For = a known IP → not exempt (429 after 20 unknown failures)', async () => {
  const b = bench()
  b.pastSuccess('192.0.2.200', 3 * DAY)
  await b.twentyUnknown()
  assert.equal((await b.login('192.0.2.77', GOOD, '192.0.2.200')).status, 429)
})

test('10 simultaneous attempts from one IP → at most 5 checks, the others 429', async () => {
  const b = bench()
  const rs = await Promise.all(Array.from({ length: 10 }, () => b.login('192.0.2.30')))
  assert.equal(b.spy.calls, 5)
  assert.deepEqual(rs.map(r => r.status).sort(), [401, 401, 401, 401, 401, 429, 429, 429, 429, 429])
})

test('a successful login removes its reservation and writes an audit row; failures of another IP stay counted', async () => {
  const b = bench()
  for (let i = 0; i < 3; i++) assert.equal((await b.login('192.0.2.40')).status, 401)
  for (let i = 0; i < 2; i++) assert.equal((await b.login('192.0.2.41')).status, 401)
  assert.equal((await b.login('192.0.2.41', GOOD)).ok, true)
  assert.deepEqual(b.auditOk(), ['192.0.2.41'])
  // 192.0.2.41: 2 failures + the success removed → 3 more attempts before the cap
  for (let i = 0; i < 3; i++) assert.equal((await b.login('192.0.2.41')).status, 401)
  assert.equal((await b.login('192.0.2.41')).status, 429)
  // 192.0.2.40: its 3 failures still count → 2 attempts, then 429
  for (let i = 0; i < 2; i++) assert.equal((await b.login('192.0.2.40')).status, 401)
  assert.equal((await b.login('192.0.2.40', GOOD)).status, 429)
})
