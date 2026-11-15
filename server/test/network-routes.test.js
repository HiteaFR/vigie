// Network module: write routes behind the network guard. Each POST: 401 without a
// session, 403 outside the allowed network or foreign Origin, 413 beyond 8 KB, 400 without
// a reason where one is required; one audit line on success AND on refusal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createNetwork } from '../lib/network/index.js'
import { mountNetwork } from '../lib/network/routes.js'
import { createAuth, createAudit, hashPassword } from '../lib/auth.js'
import { prodConfig, prodLikeStore } from './network-fixture.js'
import { errorHandler, wrap } from '../lib/http-errors.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const ROUTES = {
  '/api/network/devices/edit': { reason: false },
  '/api/network/devices/ack': { reason: true },
  '/api/network/devices/delete': { reason: true },
  '/api/network/links': { reason: true },
  '/api/network/links/remove': { reason: true },
  '/api/network/devices/merge': { reason: true },
  '/api/network/macs/confirm': { reason: true },
  '/api/network/macs/detach': { reason: true },
  '/api/network/mac-rules': { reason: true },
  '/api/network/mac-rules/remove': { reason: true },
  '/api/network/suggestions/dismiss': { reason: true },
}

async function server({ store, env }) {
  const audit = createAudit(store)
  const auth = createAuth({ store, audit, env })
  const network = createNetwork({ cfg: prodConfig(), store, audit, now: () => T, log: { warn() {}, error() {} } })
  const app = express()
  app.use('/api', express.json({ limit: '8kb' }))
  app.post('/api/login', async (req, res) => {
    const r = await auth.login(req, res, req.body?.password)
    res.status(r.ok ? 200 : r.status).json(r)
  })
  const admin = (req, res, next) => auth.require(req, res, next)
  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) })
  mountNetwork(app, { network, admin, fail, wrap, isAdmin: req => auth.status(req).admin })
  app.all('/api/*', (req, res) => res.status(404).json({ error: 'route inconnue' }))
  // server's final handler, silent log (no stack in the output)
  app.use(errorHandler({ error() {} }))
  const srv = app.listen(0)
  await new Promise(r => srv.once('listening', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { srv, base, post, audit, network }
}

test('network writes: session, network, Origin, size, reason, audit', async () => {
  const env = { ADMIN_PASSWORD_HASH: await hashPassword('mot de passe solide'), ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }
  const { store } = prodLikeStore({ T })
  const s = await server({ store, env })
  // same database, different allowed network: the session exists but the address is refused
  const other = await server({ store, env: { ...env, ADMIN_ALLOWED_CIDRS: '10.0.0.0/8' } })
  try {
    const sid = (await s.post('/api/login', { password: 'mot de passe solide' })).headers.get('set-cookie').split(';')[0]
    const auditCount = () => store.db.prepare('SELECT COUNT(*) n FROM audit').get().n
    for (const [p, { reason }] of Object.entries(ROUTES)) {
      let before = auditCount()
      assert.equal((await s.post(p, {})).status, 401, `${p} without a session`)
      assert.equal(auditCount(), before + 1, `${p}: refusal logged`)
      assert.equal((await s.post(p, {}, { cookie: sid, origin: 'http://evil.example' })).status, 403, `${p} Origin`)
      assert.equal((await other.post(p, {}, { cookie: sid })).status, 403, `${p} outside the network`)
      assert.equal((await s.post(p, JSON.stringify({ notes: 'x'.repeat(9000) }), { cookie: sid })).status, 413, `${p} > 8 KB`)
      before = auditCount()
      const r = await s.post(p, { id: 1, ids: [1], into: 1, from: [2], mac: '00:00:5e:00:53:80', prefix: 'fe:00:00', action: 'attach', key: 'merge:x', child: 'dev:21', parent: 'internet', kind: 'uplink' }, { cookie: sid })
      if (reason) {
        assert.equal(r.status, 400, `${p} without a reason`)
        assert.match((await r.json()).error, /motif obligatoire/)
      }
      assert.equal(auditCount(), before + 1, `${p}: one audit line`)
    }
    // success: "Connu" on a record to review, with a reason; audit line ok
    const ack = await s.post('/api/network/devices/ack', { ids: [21], reason: 'vérifié sur place' }, { cookie: sid })
    assert.equal(ack.status, 200)
    assert.deepEqual((await ack.json()).done, [21])
    const last = s.audit.list(1)[0]
    assert.deepEqual([last.action, last.target, last.ok, last.source], ['network: known', 'dev:21', true, 'ui'])
    assert.match(last.actor, /^admin \(/)
    // edit without a reason (descriptive input)
    const edit = await s.post('/api/network/devices/edit', { id: 21, name: 'Poste <b>salon</b>' }, { cookie: sid })
    assert.equal(edit.status, 200)
    assert.equal(s.network.view().devices.find(d => d.id === 21).name, 'Poste <b>salon</b>') // text, escaped on display
    // read open to the LAN: neither reason nor author (rules, write events)
    await s.post('/api/network/mac-rules', { prefix: 'fe:00:00', action: 'attach', deviceId: 21, name: 'Tab-Exemple', reason: 'motif secret' }, { cookie: sid })
    const list = await (await fetch(`${s.base}/api/network`)).json()
    assert.deepEqual(Object.keys(list.rules[0]).sort(), ['action', 'createdAt', 'deviceId', 'id', 'name', 'prefix'])
    const fiche = await (await fetch(`${s.base}/api/network/devices/21`)).json()
    for (const e of fiche.events.filter(e => e.actor)) assert.deepEqual([e.actor, e.detail], ['admin', null])
    assert.doesNotMatch(JSON.stringify(list) + JSON.stringify(fiche), /motif secret|vérifié sur place|127\.0\.0\.1/)
    // cookie present but invalid: nothing more than without a session
    const forged = await (await fetch(`${s.base}/api/network`, { headers: { cookie: 'dash_sid=forge' } })).json()
    assert.equal(forged.rules[0].reason, undefined)
    const forgedSid = await (await fetch(`${s.base}/api/network`, { headers: { cookie: `${sid}x` } })).json()
    assert.equal(forgedSid.rules[0].createdBy, undefined)
    // with the admin session: reasons and authors shown
    const adminList = await (await fetch(`${s.base}/api/network`, { headers: { cookie: sid } })).json()
    assert.equal(adminList.rules[0].reason, 'motif secret')
    assert.match(adminList.rules[0].createdBy, /^admin \(/)
    const adminFiche = await (await fetch(`${s.base}/api/network/devices/21`, { headers: { cookie: sid } })).json()
    assert.ok(adminFiche.events.some(e => e.type === 'acked' && e.detail === 'vérifié sur place' && /^admin \(/.test(e.actor)))
    // ignore, archive and restore removed (404); Delete: unknown id → 404, linked record → 409
    for (const p of ['ignore', 'archive', 'restore']) assert.equal((await s.post(`/api/network/devices/${p}`, { id: 21, reason: 'test test' }, { cookie: sid })).status, 404, p)
    assert.equal((await s.post('/api/network/devices/delete', { ids: [9999], reason: 'test test' }, { cookie: sid })).status, 404)
    const linked = await s.post('/api/network/devices/delete', { ids: [1, 21], reason: 'test test' }, { cookie: sid })
    assert.equal(linked.status, 409)
    assert.deepEqual((await linked.json()).ids, [1])
  } finally {
    s.srv.close()
    other.srv.close()
  }
})
