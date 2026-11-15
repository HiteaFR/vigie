// Tombstones and re-creation, production fixture: the 5 purged Tab-A1 stay in Pi-hole's
// table (lastSeen and lastQuery frozen). Nothing recreates them but their REAL ARP reply,
// with the probe in service; a tombstone is never an "ignore".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { r3Bench, r4ProdStore, freezePihole, TAB_MACS, FIXTURE_HOSTS, MIN, DAY } from './network-fixture.js'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { createNetStore } from '../lib/network/store.js'
import { prodConfig } from './network-fixture.js'

const T = Date.parse('2026-10-21T15:30:00Z')
const FROZEN = Object.fromEntries(TAB_MACS.map((m, i) => [m, i === 4 ? Date.parse('2026-10-11T21:05:00Z') : Date.parse('2026-09-27T16:41:00Z')]))
const live = FIXTURE_HOSTS.filter(h => !TAB_MACS.includes(h.mac) && h.mac !== '00:00:5e:00:53:8b')
const tab = mac => FIXTURE_HOSTS.find(h => h.mac === mac)
const count = (b, sql, ...a) => b.store.db.prepare(sql).get(...a).n
const newCount = b => count(b, "SELECT COUNT(*) n FROM net_devices WHERE state = 'new'")

function deployed({ frozen = FROZEN } = {}) {
  const { store } = r4ProdStore({ T })
  const b = r3Bench({ T, store })
  freezePihole(b, frozen)
  return b
}

test('purge then 10 readings and 10 sweeps, Pi-hole frozen, neither ARP nor neigh → 0 records, 0 net_new', async () => {
  const b = deployed()
  await b.run(20, live)
  for (const mac of TAB_MACS) assert.equal(b.devByMac(mac), undefined)
  assert.deepEqual([newCount(b), b.telegram.sent.length], [0, 0])
})

test('Pi-hole lastSeen MOVING FORWARD (.194 case), stale probe, DHCP lease → still 0', async () => {
  // lastSeen moving forward: the probe is in service, Pi-hole creates nothing
  const b = deployed({ frozen: {} })
  await b.run(20, live)
  assert.deepEqual([TAB_MACS.filter(m => b.devByMac(m)).length, b.telegram.sent.length], [0, 0])
  // probe silent after being put in service: no creation, no fallback to Pi-hole
  const c = deployed({ frozen: {} })
  await c.run(20, null)
  assert.equal(TAB_MACS.filter(m => c.devByMac(m)).length, 0)
  // active DHCP lease for a TAB: creates nothing
  const d = deployed()
  const base = d.src.pihole.get
  d.src.pihole.get = async p => (p === '/api/dhcp/leases'
    ? { leases: [{ expires: Math.floor((d.clock.t + 3600_000) / 1000), hwaddr: TAB_MACS[0], ip: '192.0.2.120', name: 'Tab-Exemple', clientid: '*' }] }
    : base(p))
  await d.run(20, live)
  assert.equal(d.devByMac(TAB_MACS[0]), undefined)
})

test('one of them answers ARP → 1 new record + 1 net_new, tombstone removed, returned; no loop', async () => {
  const b = deployed()
  await b.run(10, live)
  await b.run(10, [...live, tab(TAB_MACS[2])])
  const d = b.devByMac(TAB_MACS[2])
  assert.deepEqual([d.state, d.origin], ['new', 'scan'])
  assert.equal(TAB_MACS.filter(m => b.devByMac(m)).length, 1) // no other one
  assert.equal(count(b, 'SELECT COUNT(*) n FROM net_tombstones WHERE mac = ?', TAB_MACS[2]), 0)
  assert.equal(count(b, 'SELECT COUNT(*) n FROM net_tombstones'), 5)
  assert.match(b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'returned' AND device_id = ?").get(d.id).detail, /returned after deletion on .* legacy states purge/)
  assert.deepEqual(b.firing('net_new').map(a => a.key), [`net_new:${d.id}`])
  assert.equal(b.telegram.sent.filter(m => /Nouvel appareil/.test(m.text)).length, 1)
  assert.match(b.digest(false), /revenus après suppression \(24 h\)/)
  await b.run(20, [...live, tab(TAB_MACS[2])]) // 10 more sweeps: still one record, one message
  assert.equal(TAB_MACS.filter(m => b.devByMac(m)).length, 1)
  assert.equal(b.telegram.sent.filter(m => /Nouvel appareil/.test(m.text)).length, 1)
})

test('observation with a timestamp EQUAL to deleted_at → nothing; passive mode → passive rules, only after the deletion', () => {
  const cfg = prodConfig()
  const { store } = r4ProdStore({ T, probeOn: false })
  const ns = createNetStore(store)
  // purge by the module (passive mode: no probe put in service)
  r3Bench({ T, store })
  const mac = TAB_MACS[0]
  const deleted = store.db.prepare('SELECT deleted_at FROM net_tombstones WHERE mac = ?').get(mac).deleted_at
  const ph = ts => ({ mac, ip: '192.0.2.120', source: 'pihole', ts, presence: true })
  const step = ts => ns.applyOps(mergeSightings({ ...ns.load(), flood: emptyFlood() }, [ph(ts)], { cfg, now: ts + MIN, probe: 'off' }).ops)
  step(deleted - DAY) // old entry: never
  step(deleted) // equal: never
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_macs WHERE mac = ?').get(mac).n, 0)
  step(deleted + 1) // later: recreated (passive mode rules)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_macs WHERE mac = ?').get(mac).n, 1)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_tombstones WHERE mac = ?').get(mac).n, 0)
})

test('deleted guest phone answering ARP 3 weeks later → 1 new record + 1 net_new', async () => {
  const b = deployed()
  const phone = FIXTURE_HOSTS.find(h => h.mac === '06:00:00:00:53:d0') // Telephone-1
  const id = b.devByMac(phone.mac).id
  b.network.writes.delete({ ids: [id], reason: 'téléphone d\'un invité reparti' }, { by: 'admin (test)', source: 'ui' })
  const without = live.filter(h => h !== phone)
  await b.run(10, without)
  b.clock.t += 21 * DAY
  await b.run(4, [...without, phone])
  const back = b.devByMac(phone.mac)
  assert.ok(back && back.id !== id && back.state === 'new')
  assert.deepEqual(b.firing('net_new').map(a => a.key), [`net_new:${back.id}`])
})

test('present device deleted → recreated once at the next sweep, 1 net_new over 10 sweeps', async () => {
  const b = deployed()
  await b.run(10, live)
  const target = live[30]
  b.network.writes.delete({ ids: [b.devByMac(target.mac).id], reason: 'test de suppression' }, { by: 'admin (test)', source: 'ui' })
  await b.run(20, live)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_macs WHERE mac = ?').get(target.mac).n, 1)
  assert.equal(b.telegram.sent.filter(m => /Nouvel appareil/.test(m.text)).length, 1)
})
