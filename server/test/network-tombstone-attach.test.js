// Tombstone and attach: a deleted MAC that comes back by ATTACHING to an existing record
// (same DHCP name; IP from the macvlan range) also removes its tombstone, with returned on
// top of net_mac_added; accepted limitation of the passive mode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetworkWrites } from '../lib/network/writes.js'
import { createAudit } from '../lib/auth.js'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { prodLikeStore, prodConfig, MIN } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const who = { by: 'admin (test)', source: 'ui' }

function bench() {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T })
  let flood = emptyFlood()
  const cycle = (sightings, t, probe = 'on') => {
    const m = mergeSightings({ ...ns.load(), flood }, sightings, { cfg, now: t, probe })
    flood = m.flood
    ns.applyOps(m.ops)
    return m
  }
  const macRow = mac => store.db.prepare('SELECT * FROM net_macs WHERE mac = ?').get(mac)
  const events = type => store.db.prepare('SELECT * FROM net_events WHERE type = ? ORDER BY id').all(type)
  return { cfg, store, ns, W, cycle, macRow, events }
}

test('deleted MAC coming back with the same DHCP name: tombstone removed, returned AND mac_added', () => {
  const b = bench()
  // Tablet record (weak MAC), then a 2nd weak MAC with the same name, deleted separately
  const t0 = T + MIN
  b.cycle([{ mac: '06:00:00:00:5c:01', ip: '192.0.2.140', source: 'arp', ts: t0, presence: true },
    { mac: '06:00:00:00:5c:01', ip: '192.0.2.140', source: 'dhcp', ts: t0, presence: false, name: 'Tablette-Salon', leaseExpires: t0 + 3600_000 }], t0)
  const tablet = b.macRow('06:00:00:00:5c:01').device_id
  b.cycle([{ mac: '0a:00:00:00:5c:02', ip: '192.0.2.141', source: 'arp', ts: t0 + MIN, presence: true }], t0 + MIN)
  const other = b.macRow('0a:00:00:00:5c:02').device_id
  b.W.delete({ ids: [other], reason: 'doublon à supprimer' }, who)
  // the MAC comes back 30 min later, with the DHCP name of the absent tablet: attach by name
  const t1 = T + 40 * MIN
  b.cycle([{ mac: '0a:00:00:00:5c:02', ip: '192.0.2.141', source: 'arp', ts: t1, presence: true },
    { mac: '0a:00:00:00:5c:02', ip: '192.0.2.141', source: 'dhcp', ts: t1, presence: false, name: 'Tablette-Salon', leaseExpires: t1 + 3600_000 }], t1)
  const m = b.macRow('0a:00:00:00:5c:02')
  assert.deepEqual([m.device_id, m.attach], [tablet, 'name'])
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_tombstones WHERE mac = ?').get('0a:00:00:00:5c:02').n, 0)
  assert.equal(b.events('returned').filter(e => e.device_id === tablet).length, 1)
  assert.ok(b.events('mac_added').some(e => e.device_id === tablet && /0a:00:00:00:5c:02/.test(e.detail)))
})

test('deleted MAC coming back through the macvlan range (same IP): tombstone removed, returned', () => {
  const b = bench()
  const t0 = T + MIN
  b.cycle([{ mac: '02:42:00:00:5d:01', ip: '192.0.2.196', source: 'arp', ts: t0, presence: true }], t0)
  const keep = b.macRow('02:42:00:00:5d:01').device_id
  b.cycle([{ mac: '62:00:00:00:5d:02', ip: '192.0.2.197', source: 'arp', ts: t0 + MIN, presence: true }], t0 + MIN)
  b.W.delete({ ids: [b.macRow('62:00:00:00:5d:02').device_id], reason: 'conteneur recréé' }, who)
  const t1 = T + 40 * MIN // the old MAC is absent: the new one takes its IP
  b.cycle([{ mac: '62:00:00:00:5d:02', ip: '192.0.2.196', source: 'arp', ts: t1, presence: true }], t1)
  assert.deepEqual([b.macRow('62:00:00:00:5d:02').device_id, b.macRow('62:00:00:00:5d:02').attach], [keep, 'ip'])
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_tombstones').get().n, 0)
  assert.equal(b.events('returned').length, 1)
})

test('accepted limitation: passive mode + deleted STALE ghost whose Pi-hole lastSeen moves forward → comes back', () => {
  const b = bench()
  const t0 = T + MIN
  b.cycle([{ mac: '00:00:5e:00:53:94', ip: '192.0.2.194', source: 'pihole', ts: t0, presence: true }], t0, 'off')
  b.W.delete({ ids: [b.macRow('00:00:5e:00:53:94').device_id], reason: 'fantôme NetAlertX' }, who)
  b.cycle([{ mac: '00:00:5e:00:53:94', ip: '192.0.2.194', source: 'pihole', ts: T + 10 * MIN, presence: true }], T + 10 * MIN, 'off')
  assert.ok(b.macRow('00:00:5e:00:53:94'))
  // probe in service: the same observation recreates nothing
  const c = bench()
  c.cycle([{ mac: '00:00:5e:00:53:94', ip: '192.0.2.194', source: 'arp', ts: t0, presence: true }], t0)
  c.W.delete({ ids: [c.macRow('00:00:5e:00:53:94').device_id], reason: 'fantôme NetAlertX' }, who)
  c.cycle([{ mac: '00:00:5e:00:53:94', ip: '192.0.2.194', source: 'pihole', ts: T + 10 * MIN, presence: true }], T + 10 * MIN, 'on')
  assert.equal(c.macRow('00:00:5e:00:53:94'), undefined)
})
