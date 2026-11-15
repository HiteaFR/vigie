// Creation follows the probe state. In service: only a fresh presence from
// ARP_PRESENCE_SOURCES (arp, neigh REACHABLE, self), for creation, persistence during a
// flood, absence before an attach and the double view of net_new; silent after being put
// in service: no creation; without a probe: the passive rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { networkSignals } from '../lib/network/rules.js'
import { r3Bench, r4ProdStore, prodConfig, FIXTURE_HOSTS, TAB_MACS, MIN } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const cfg = prodConfig()
const empty = () => ({ devices: new Map(), macs: new Map(), seen: new Map(), attrs: new Map(), addresses: new Map(), rules: [], flood: emptyFlood('sel') })
const ph = (mac, ip, ts) => ({ mac, ip, source: 'pihole', ts, presence: true })
const dhcp = (mac, ip, ts) => ({ mac, ip, source: 'dhcp', ts, presence: false, leaseExpires: ts + 3600_000 })
const arp = (mac, ip, ts) => ({ mac, ip, source: 'arp', ts, presence: true })
const neigh = (mac, ip, ts, reachable) => ({ mac, ip, source: 'neigh', ts, presence: reachable })
const created = (m, mac) => m.ops.some(o => o.op === 'upsertMac' && o.mac === mac)

test('probe in service: Pi-hole, a lease or neigh STALE create nothing; arp, neigh REACHABLE or self create', () => {
  for (const [s, expected] of [[ph('00:00:5e:00:53:a1', '192.0.2.161', T), false], [dhcp('00:00:5e:00:53:a2', '192.0.2.162', T), false],
    [neigh('00:00:5e:00:53:a3', '192.0.2.163', T, false), false], [arp('00:00:5e:00:53:a4', '192.0.2.164', T), true],
    [neigh('00:00:5e:00:53:a5', '192.0.2.165', T, true), true], [{ ...arp('00:00:5e:00:53:a6', '192.0.2.166', T), source: 'self' }, true]]) {
    assert.equal(created(mergeSightings(empty(), [s], { cfg, now: T, probe: 'on' }), s.mac), expected, `${s.source} ${s.presence}`)
  }
  // probe silent after being put in service: NO creation, not even from residual ARP or Pi-hole
  for (const s of [ph('00:00:5e:00:53:b1', '192.0.2.171', T), arp('00:00:5e:00:53:b2', '192.0.2.172', T)]) {
    assert.equal(created(mergeSightings(empty(), [s], { cfg, now: T, probe: 'down' }), s.mac), false, s.source)
  }
  // Proxmox identity: created whatever the probe state
  const pve = { mac: '02:00:00:00:5a:00', ip: '192.0.2.10', source: 'pve', ts: T, presence: false, hostId: 'g1' }
  for (const probe of ['on', 'down', 'off']) assert.equal(created(mergeSightings(empty(), [pve], { cfg, now: T, probe }), pve.mac), true, probe)
  // without a probe (passive mode): passive rules (Pi-hole within the window, lease)
  assert.equal(created(mergeSightings(empty(), [ph('00:00:5e:00:53:c1', '192.0.2.181', T)], { cfg, now: T, probe: 'off' }), '00:00:5e:00:53:c1'), true)
  assert.equal(created(mergeSightings(empty(), [dhcp('00:00:5e:00:53:c2', '192.0.2.182', T)], { cfg, now: T, probe: 'off' }), '00:00:5e:00:53:c2'), true)
})

test('persistence during a flood and absence before attach: on ARP_PRESENCE_SOURCES when the probe is in service', () => {
  const ccfg = prodConfig({ maxNewPerCycle: 2 })
  // flood open; a refused MAC, present only through Pi-hole over 3 readings and 10 min: never persistent
  let state = { ...empty(), flood: { ...emptyFlood('sel'), episode: { since: T, lastOver: T } } }
  let m
  for (const dt of [0, 5, 10]) {
    m = mergeSightings(state, [ph('00:00:5e:00:53:d1', '192.0.2.191', T + dt * MIN), arp('00:00:5e:00:53:d2', '192.0.2.192', T + dt * MIN)], { cfg: ccfg, now: T + dt * MIN, probe: 'on' })
    state = { ...state, flood: m.flood }
  }
  assert.equal(created(m, '00:00:5e:00:53:d1'), false)
  assert.equal(created(m, '00:00:5e:00:53:d2'), true) // present through ARP: persistent
  // absence: a record "seen" only by Pi-hole (ghost) is absent for the probe
  const devices = new Map([[1, { id: 1, state: 'known', disp_name: 'Tablette-Salon', primary_mac: '06:00:00:00:5c:01' }]])
  const macs = new Map([['06:00:00:00:5c:01', { mac: '06:00:00:00:5c:01', device_id: 1, grade: 'weak', random: 1, first_seen: T - 9000_000, last_seen: T - MIN, attach: null }]])
  const seen = new Map([['06:00:00:00:5c:01|pihole', { mac: '06:00:00:00:5c:01', source: 'pihole', last_seen: T - MIN }]])
  const attrs = new Map([[1, [{ device_id: 1, attr: 'name', source: 'dhcp', value: 'Tablette-Salon', rank: 6, seen_at: T - MIN }]]])
  const st = { ...empty(), devices, macs, seen, attrs }
  const come = [arp('0a:00:00:00:5c:02', '192.0.2.141', T), { ...dhcp('0a:00:00:00:5c:02', '192.0.2.141', T), name: 'Tablette-Salon' }]
  const on = mergeSightings(st, come, { cfg, now: T, probe: 'on' })
  assert.ok(on.ops.some(o => o.op === 'upsertMac' && o.mac === '0a:00:00:00:5c:02' && o.device === 1 && o.attach === 'name'))
  const off = mergeSightings(st, come, { cfg, now: T, probe: 'off' })
  assert.ok(!off.ops.some(o => o.op === 'upsertMac' && o.mac === '0a:00:00:00:5c:02' && o.device === 1)) // Pi-hole says it is present
})

test('double view of net_new: through the probe only when it is in service', () => {
  const dev = { id: 7, state: 'new', origin: 'scan', created_at: T - 10 * MIN, primary_mac: '00:00:5e:00:53:e1', disp_name: 'x' }
  const devices = new Map([[7, dev]])
  const macs = new Map([['00:00:5e:00:53:e1', { mac: '00:00:5e:00:53:e1', device_id: 7, grade: 'strong', attach: null, confirmed_at: null }]])
  const seenPh = new Map([['00:00:5e:00:53:e1|pihole', { mac: '00:00:5e:00:53:e1', source: 'pihole', last_seen: T }]])
  const seenArp = new Map([['00:00:5e:00:53:e1|arp', { mac: '00:00:5e:00:53:e1', source: 'arp', last_seen: T }]])
  const sources = { pihole: { ok: true, stale: false }, arp: { ok: true, stale: false } }
  const sig = (seen, probe) => networkSignals({ devices, macs, seen, sources, presence: { since: T - 3600_000, parentsOf: () => [], probe } }, { now: T, alertsSince: T - 3600_000 }).find(s => s.key === 'net_new:7').cond
  assert.deepEqual([sig(seenPh, 'on'), sig(seenArp, 'on'), sig(seenPh, 'off')], [false, true, true])
})

test('300 unknown MACs, probe in service: 1 flood, ≤ 3 messages; Pi-hole alone creates none', async () => {
  const { store } = r4ProdStore({ T })
  const b = r3Bench({ T, store })
  const hex = v => v.toString(16).padStart(2, '0')
  const ips = Array.from({ length: 101 }, (_, i) => `192.0.2.${150 + i}`).filter(ip => ip !== '192.0.2.193').slice(0, 100)
  const swarm = Array.from({ length: 300 }, (_, i) => ({ mac: `0a:ee:00:00:${hex(i >> 8)}:${hex(i & 255)}`, ip: ips[i % 100] }))
  const live = FIXTURE_HOSTS.filter(h => !TAB_MACS.includes(h.mac) && h.mac !== '00:00:5e:00:53:8b')
  await b.run(6, [...live, ...swarm])
  assert.deepEqual(b.firing('net_new_flood').map(a => a.key), ['net_new_flood:lan'])
  assert.ok(b.telegram.sent.length <= 3, `${b.telegram.sent.length} messages`)
  // the same 300 MACs seen only by Pi-hole (DNS, lastSeen moving forward): no record
  const c = r3Bench({ T, store: r4ProdStore({ T }).store })
  const base = c.src.pihole.get
  c.src.pihole.get = async p => {
    const r = await base(p)
    if (p.startsWith('/api/network')) swarm.slice(0, 50).forEach((s, i) => r.devices.push({ id: 1000 + i, hwaddr: s.mac, interface: 'eth0', firstSeen: 0, lastQuery: Math.floor(c.clock.t / 1000), numQueries: 1, macVendor: '', ips: [{ ip: s.ip, name: null, lastSeen: Math.floor(c.clock.t / 1000), nameUpdated: 0 }] }))
    return r
  }
  await c.run(10, live)
  assert.equal(c.store.db.prepare("SELECT COUNT(*) n FROM net_macs WHERE mac LIKE '0a:ee:%'").get().n, 0)
})
