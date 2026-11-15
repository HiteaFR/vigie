// THE decisive criterion: the NetAlertX ghost (".194", deleted container) whose
// ips[].lastSeen Pi-hole moves forward at every reread of its ARP cache, whose lastQuery
// has been frozen for 36 h and whose neigh entry stays STALE, goes OFFLINE. Neither
// Pi-hole, nor neigh STALE, nor DNS (lastQuery) count as presence; only arp, neigh
// REACHABLE and self. Documentation addresses (RFC 5737 / 7042).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { r3Bench, arpProbe, prodLikeStore, FIXTURE_HOSTS, LOOSE, MIN, DAY } from './network-fixture.js'
import { createNetStore } from '../lib/network/store.js'

const T = Date.parse('2026-10-21T08:00:00Z')
const GHOST = { mac: '00:00:5e:00:53:94', ip: '192.0.2.194' }
const S = t => Math.floor(t / 1000)

// production database + the ghost's record (known, imported by the first version)
function ghostStore() {
  const { store } = prodLikeStore({ T })
  const ns = createNetStore(store)
  ns.applyOps([
    { op: 'insertDevice', ref: 'new:1', fields: { state: 'known', review: 0, origin: 'import:netalertx', created_at: T - 2 * DAY, updated_at: T - 2 * DAY, first_seen: T - 90 * DAY, last_seen: T - MIN, disp_name: 'NetAlertX', primary_mac: GHOST.mac, last_ip: GHOST.ip } },
    { op: 'upsertMac', mac: GHOST.mac, device: 'new:1', grade: 'strong', random: 0, first_seen: T - 90 * DAY, last_seen: T - MIN, last_ip: GHOST.ip, attach: null },
    { op: 'upsertSeen', mac: GHOST.mac, source: 'pihole', last_seen: T - MIN, last_ip: GHOST.ip },
  ])
  return store
}

// Pi-hole: the ghost (and others) with a lastSeen moving forward; lastQuery as chosen
function piholeWith(b, extra) {
  const base = b.src.pihole.get
  b.src.pihole.get = async p => {
    const r = await base(p)
    if (p.startsWith('/api/network')) {
      for (const x of extra(b.clock.t)) {
        r.devices.push({ id: 900 + r.devices.length, hwaddr: x.mac, interface: 'eth0', firstSeen: S(T - 90 * DAY), lastQuery: S(x.lastQuery), numQueries: 1, macVendor: '', ips: [{ ip: x.ip, name: x.name ?? null, lastSeen: S(b.clock.t), nameUpdated: 0 }] })
      }
    }
    return r
  }
}
const ghostOf = b => b.devByMac(GHOST.mac)
const STALE = t => [{ dst: GHOST.ip, dev: 'eth0', lladdr: GHOST.mac, state: ['STALE'] }]

test('ghost .194: null during its delay (normal, 10 min) counted from the 1st sweep, then 0; no session, no message; comes back on ARP or neigh REACHABLE only', async () => {
  let neigh = STALE
  const b = r3Bench({ T, store: ghostStore(), neigh: t => neigh(t) })
  piholeWith(b, () => [{ ...GHOST, name: 'NetAlertX', lastQuery: T - 36 * 3600_000 }])
  await b.run(2) // first sweep: presenceSince
  const since = Number(b.store.kv.get('network.presenceSince'))
  assert.equal(b.network.view().presence, 'arp') // no observation window
  await b.run(8) // 8 min after the first sweep
  // Pi-hole sees it "active" (freshness), the probe leaves it unknown during its delay
  assert.equal(b.network.view().devices.find(d => d.mac === GHOST.mac).freshness, 'active')
  assert.equal(ghostOf(b).online, null)
  await b.run(4) // 12 min: normal delay (10 min) and 3 sweeps elapsed
  assert.equal(ghostOf(b).online, 0)
  assert.ok(ghostOf(b).online_since == null && b.clock.t - since <= 12 * MIN)
  assert.equal(ghostOf(b).last_present, null)
  assert.deepEqual(b.sessions(ghostOf(b).id), [])
  // the cockpit counts "online", never the Pi-hole freshness again
  const s = b.network.summary()
  assert.equal(s.presence, 'arp')
  assert.equal(s.online, FIXTURE_HOSTS.length - 1) // 43 MACs, 2 of them for speedtest; the ghost excluded
  assert.deepEqual([b.outbox(), b.telegram.sent.length], [0, 0])
  // a neigh REACHABLE (reply less than 30 s old) brings it back online
  neigh = () => [{ dst: GHOST.ip, dev: 'eth0', lladdr: GHOST.mac, state: ['REACHABLE'] }]
  await b.run(4) // seen in the reading, taken into account at the next sweep (≤ 2 min)
  assert.equal(ghostOf(b).online, 1)
  neigh = STALE
  await b.run(20)
  assert.equal(ghostOf(b).online, 0)
  // an ARP reply too
  await b.run(2, [...FIXTURE_HOSTS, GHOST])
  assert.equal(ghostOf(b).online, 1)
})

test('spoofed DNS: the ghost\'s lastQuery MOVING FORWARD, no ARP reply → stays offline', async () => {
  const b = r3Bench({ T, store: ghostStore(), neigh: STALE })
  piholeWith(b, t => [{ ...GHOST, lastQuery: t }]) // UDP/53 query with a forged source IP, at every reading
  await b.run(80)
  assert.equal(ghostOf(b).online, 0)
  assert.deepEqual(b.sessions(ghostOf(b).id), [])
})

test('reassigned IP: the new MAC queries DNS from the old one\'s IP → the old one goes offline', async () => {
  const probe = arpProbe()
  const b = r3Bench({ T, store: ghostStore(), probe })
  await b.run(60, [...FIXTURE_HOSTS, GHOST]) // the old device was answering
  assert.equal(ghostOf(b).online, 1)
  // it leaves; a new device takes its IP and talks to DNS, without answering ARP
  piholeWith(b, t => [{ mac: '00:00:5e:00:53:95', ip: GHOST.ip, name: 'Nouveau', lastQuery: t }])
  await b.run(20)
  assert.equal(ghostOf(b).online, 0)
  assert.equal(b.sessions(ghostOf(b).id).at(-1).end != null, true)
})

test('sleepy phone seen in ARP 3 h ago, lastQuery moving forward → offline', async () => {
  const b = r3Bench({ T })
  const phone = { mac: LOOSE.find(l => /Telephone-1/.test(l.name)).macs[0] }
  b.store.db.prepare("UPDATE net_devices SET profile = 'sleepy' WHERE id = ?").run(b.devByMac(phone.mac).id)
  piholeWith(b, t => [{ mac: phone.mac, ip: '192.0.2.130', name: 'Telephone-1', lastQuery: t }])
  await b.run(60)
  assert.equal(b.devByMac(phone.mac).online, 1)
  const without = FIXTURE_HOSTS.filter(h => h.mac !== phone.mac)
  await b.run(40, without)
  assert.equal(b.devByMac(phone.mac).online, 1) // < 45 min: sleepy profile
  await b.run(140, without) // 3 h without an ARP reply, DNS active all along
  assert.equal(b.devByMac(phone.mac).online, 0)
})

test('neigh REACHABLE without an ARP reply: stays online', async () => {
  const subject = FIXTURE_HOSTS[25]
  const b = r3Bench({ T, neigh: () => [{ dst: subject.ip, dev: 'eth0', lladdr: subject.mac, state: ['REACHABLE'] }] })
  await b.run(60)
  await b.run(40, FIXTURE_HOSTS.filter(h => h !== subject))
  assert.equal(b.devByMac(subject.mac).online, 1)
})
