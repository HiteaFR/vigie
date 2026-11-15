// Map links entered by hand: POST /api/network/links and /links/remove behind the admin
// session; reason required; refusals (itself, unknown node, deleted record, active link
// already present, cycle); topology read without reason or author.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prodLikeStore, netServer } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')

test('links: session, Origin, reason, refusals, removal → inferred link, audit; topology without reason or author', async () => {
  const { store } = prodLikeStore({ T })
  const s = await netServer({ store, T })
  try {
    const sid = await s.login()
    const link = (body, headers = { cookie: sid }) => s.post('/api/network/links', body, headers)
    const ok = { child: 'dev:22', parent: 'dev:21', kind: 'ethernet', port: 'p3', note: 'câble du bureau', reason: 'branché derrière le poste' }
    assert.equal((await link(ok, {})).status, 401)
    assert.equal((await link(ok, { cookie: sid, origin: 'http://evil.example' })).status, 403)
    const noReason = await link({ ...ok, reason: undefined })
    assert.equal(noReason.status, 400)
    assert.match((await noReason.json()).error, /motif obligatoire/)
    assert.equal((await link({ ...ok, parent: 'dev:22' })).status, 400) // itself
    assert.equal((await link({ ...ok, parent: 'dev:9999' })).status, 404)
    assert.equal((await link({ ...ok, parent: 'host:inconnu' })).status, 404)
    assert.equal((await link({ ...ok, kind: 'laser' })).status, 400)
    // success, then an active link already present for this child → 409
    const r = await link(ok)
    assert.equal(r.status, 200)
    const { id } = await r.json()
    assert.equal((await link({ ...ok, parent: 'dev:23' })).status, 409)
    // cycle: dev:21 → dev:22 while dev:22 → dev:21
    const cyc = await link({ child: 'dev:21', parent: 'dev:22', kind: 'uplink', reason: 'test de cycle' })
    assert.equal(cyc.status, 400)
    assert.match((await cyc.json()).error, /cycle/)
    let topo = await (await fetch(`${s.base}/api/network/topology`)).json()
    assert.deepEqual([topo.nodes.find(n => n.id === 'dev:22').parent, topo.nodes.find(n => n.id === 'dev:22').origin], ['dev:21', 'manual'])
    assert.doesNotMatch(JSON.stringify(topo), /branché derrière|admin \(/) // without a session: neither reason nor author
    // deleted record: 404 as a node, and its links disappear
    await s.post('/api/network/devices/delete', { ids: [23], reason: 'appareil donné' }, { cookie: sid })
    assert.equal((await link({ child: 'dev:24', parent: 'dev:23', kind: 'uplink', reason: 'vers une fiche supprimée' })).status, 404)
    // removal: reason required, then the inferred link comes back
    assert.equal((await s.post('/api/network/links/remove', { id }, { cookie: sid })).status, 400)
    assert.equal((await s.post('/api/network/links/remove', { id, reason: 'câble retiré' }, { cookie: sid })).status, 200)
    assert.equal((await s.post('/api/network/links/remove', { id, reason: 'câble retiré' }, { cookie: sid })).status, 409)
    s.network.runAll() // reading: new snapshot
    topo = await (await fetch(`${s.base}/api/network/topology`)).json()
    assert.notEqual(topo.nodes.find(n => n.id === 'dev:22').origin, 'manual')
    const audits = store.db.prepare("SELECT action, ok FROM audit WHERE action IN ('network: link', 'network: unlink') ORDER BY id").all().map(a => [a.action, a.ok])
    assert.ok(audits.some(([a, o]) => a === 'network: link' && o === 1) && audits.some(([a, o]) => a === 'network: unlink' && o === 1))
    assert.ok(audits.filter(([, o]) => o === 0).length >= 5) // refusals logged
    // Mermaid export: text as an attachment
    const mmd = await fetch(`${s.base}/api/network/topology.mmd`)
    assert.equal(mmd.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.match(mmd.headers.get('content-disposition'), /attachment/)
    assert.match(await mmd.text(), /^graph LR\n/)
  } finally {
    s.close()
  }
})
