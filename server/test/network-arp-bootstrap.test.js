// ARP probe bootstrap: during the first 3 valid sweeps (gateway present), a MAC revealed
// only by the probe is "known, to review", without net_new; fixed cap of 50 in total;
// beyond that, or after the 3rd sweep, normal path (net_new, flood); counters in kv,
// kept across restarts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { r3Bench, arpProbe, FIXTURE_HOSTS } from './network-fixture.js'

const T = Date.parse('2026-10-21T08:00:00Z')
const hex = v => v.toString(16).padStart(2, '0')
const quiet = n => Array.from({ length: n }, (_, i) => ({ mac: `00:00:5e:00:53:${hex(0xc0 + i)}`, ip: `192.0.2.${171 + i}` }))
const reviewNew = b => b.store.db.prepare('SELECT COUNT(*) n FROM net_devices WHERE review = 1 AND created_at >= ?').get(T).n

test('first 3 sweeps: MACs revealed only by the probe → known, to review, no net_new; one digest line; 4th sweep → net_new', async () => {
  const b = r3Bench({ T })
  const q = quiet(4)
  await b.run(2, [...FIXTURE_HOSTS, q[0]]) // 1st sweep
  await b.run(2, [...FIXTURE_HOSTS, q[0], q[1]]) // 2nd
  await b.run(2, [...FIXTURE_HOSTS, q[0], q[1], q[2]]) // 3rd
  for (const h of q.slice(0, 3)) assert.deepEqual([b.devByMac(h.mac).state, b.devByMac(h.mac).review], ['known', 1])
  assert.deepEqual([b.outbox(), b.telegram.sent.length, b.firing('net_new').length], [0, 0, 0])
  assert.equal(b.store.kv.get('network.arpBootstrapScans'), '3')
  assert.match(b.digest(true), /3 appareils vus par la sonde ARP, 3 à revoir \(/)
  assert.doesNotMatch(b.digest(true), /vus par la sonde ARP/) // only once
  // 4th sweep: an unknown MAC is a new device (known limitation, made visible)
  await b.run(6, [...FIXTURE_HOSTS, ...q])
  assert.equal(b.devByMac(q[3].mac).state, 'new')
  assert.deepEqual(b.firing('net_new').map(a => a.key), [`net_new:${b.devByMac(q[3].mac).id}`])
  assert.equal(b.telegram.sent.length, 1)
})

test('300 MACs at the 1st sweep → 50 to review, the rest through the normal path: flood, 1 message; digest "300 seen, 50 to review"', async () => {
  const b = r3Bench({ T })
  // 300 local (disposable) MACs on 100 free IPs, 3 per IP (under the cap of 4 MACs per IP)
  const ips = Array.from({ length: 101 }, (_, i) => `192.0.2.${150 + i}`).filter(ip => ip !== '192.0.2.193').slice(0, 100)
  const swarm = Array.from({ length: 300 }, (_, i) => ({ mac: `0a:ee:00:00:${hex(i >> 8)}:${hex(i & 255)}`, ip: ips[i % 100] }))
  await b.run(2, [...FIXTURE_HOSTS, ...swarm]) // a single sweep: flood right away
  assert.equal(reviewNew(b), 50)
  assert.ok(b.network.view().sources.merge?.error, 'flood visible from the 1st sweep')
  await b.run(4, [...FIXTURE_HOSTS, ...swarm]) // less than 10 min: no persistent MAC
  assert.equal(reviewNew(b), 50)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_devices WHERE state = 'new'").get().n, 0)
  assert.deepEqual(b.firing('net_new_flood').map(a => a.key), ['net_new_flood:lan'])
  assert.equal(b.firing('net_new:').length, 0)
  assert.equal(b.telegram.sent.length, 1)
  assert.match(b.telegram.sent[0].text, /Afflux d'appareils/)
  assert.match(b.digest(false), /300 appareils vus par la sonde ARP, 50 à revoir/)
})

test('sweep without gateway: not counted among the 3; restart between two sweeps: counters kept', async () => {
  const probe = arpProbe()
  const b = r3Bench({ T, probe })
  const q = quiet(4)
  const noGw = FIXTURE_HOSTS.filter(h => h.ip !== '192.0.2.40')
  await b.run(4, [...noGw, q[0]]) // 2 files without gateway: nothing counts
  assert.equal(b.store.kv.get('network.arpBootstrapScans'), null)
  assert.equal(b.devByMac(q[0].mac), undefined)
  await b.run(4, [...FIXTURE_HOSTS, q[0]]) // 2 valid sweeps
  assert.equal(b.store.kv.get('network.arpBootstrapScans'), '2')
  // restart: the counter resumes at 2 (one bootstrap sweep left)
  const b2 = r3Bench({ T: b.clock.t, store: b.store, probe })
  await b2.run(2, [...FIXTURE_HOSTS, q[0], q[1]])
  assert.equal(b2.store.kv.get('network.arpBootstrapScans'), '3')
  assert.equal(b2.devByMac(q[1].mac).review, 1)
  await b2.run(6, [...FIXTURE_HOSTS, q[0], q[1], q[2]])
  assert.equal(b2.devByMac(q[2].mac).state, 'new')
  assert.equal(b2.store.kv.get('network.arpDiscoveredCount'), '2')
})
