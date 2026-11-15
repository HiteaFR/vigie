// Origin of the last probe run of a record, read by
// GET /api/network/devices/:id (lastProbe.origin, isAdminProbe in lib/network/index.js) from the
// detail of its last "probed" event. Details written by earlier versions in the former (French)
// format stay in the database as they are and are rewritten in memory before reading: an old
// "admin · … ouverts …" detail is still an admin run, an old "planned · …" one a planned run, like
// the new format. Real route (mountNetwork), real store, events inserted as earlier versions wrote them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prodConfig, prodLikeStore, netServer } from './network-fixture.js'

const T = Date.parse('2026-11-12T08:00:00Z')

test('lastProbe.origin of GET /api/network/devices/:id: old (French) and new probed details, admin and planned', async () => {
  const { store, ns } = prodLikeStore({ T })
  const ids = store.db.prepare('SELECT id FROM net_devices ORDER BY id LIMIT 5').all().map(r => r.id)
  const cases = [
    // [detail of the last probed event, expected origin]
    ['admin · 2 ports ouverts · HTTP : 3 requêtes, 1 en 4xx · 12 ms', 'admin'], // former format, admin run
    ['admin · 1 port ouvert · HTTP : 1 requête, 0 en 4xx · 5 ms', 'admin'], // former format, singular
    ['planned · 3 ports ouverts · HTTP : 2 requêtes, 0 en 4xx · 9 ms', 'planned'], // former format, planned run
    ['admin · 2 open ports · HTTP: 3 requests, 1 4xx · 12 ms', 'admin'], // new format
    ['planned · 1 open port · HTTP: 1 request, 0 4xx · 5 ms', 'planned'], // new format
  ]
  // an older planned run first, then the case: only the last event counts
  ns.applyOps(cases.flatMap(([detail], i) => [
    { op: 'insertEvent', device: ids[i], type: 'probed', ts: T - 7 * 86400_000, detail: 'planned · 0 ports ouverts · HTTP : 0 requête, 0 en 4xx · 1 ms' },
    { op: 'insertEvent', device: ids[i], type: 'probed', ts: T - 60_000, detail },
  ]))
  // the database keeps the former text as it was written (rewritten in memory only)
  assert.equal(store.db.prepare("SELECT detail FROM net_events WHERE device_id = ? AND type = 'probed' ORDER BY ts DESC LIMIT 1").get(ids[0]).detail, cases[0][0])
  const s = await netServer({ store, cfg: prodConfig(), T })
  try {
    for (const [i, [detail, origin]] of cases.entries()) {
      const r = await fetch(`${s.base}/api/network/devices/${ids[i]}`)
      assert.equal(r.status, 200, detail)
      const v = await r.json()
      assert.deepEqual(v.lastProbe, { at: new Date(T - 60_000).toISOString(), origin }, detail)
    }
  } finally {
    s.close()
  }
})
