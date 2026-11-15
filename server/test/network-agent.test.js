// Agent source (docs/network.md): neighbors seen by an agent
// (freshness only), macvlan containers (identity, name, association, card parent),
// attachment by container identity, IP handover fallback, mixed v5/v6 fleet, no wave of alerts.
// Anonymized "prod" fixture (RFC 7042 MACs, RFC 5737 IPs), modeled on read-only
// captures: 13 agents, 29 containers on 5 Docker hosts;
// docker-a (g1): 10 networks (bridge ×6, host, null ×2, macvlan "local"), 19 containers
// including speedtest-tracker, the only one on macvlan at .193, 31 neighbors (19 outside the LAN).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast } from '../lib/agents.js'
import { agentSightings } from '../lib/network/sources/agent.js'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { r3Bench, FIXTURE_HOSTS, GUESTS, APPLIANCES, prodConfig, freezePihole, MIN, DAY } from './network-fixture.js'
import { tmpDir } from './tmpdir.js'

const T = Date.parse('2026-10-23T09:00:00Z') // daytime: outside quiet hours
const P = '192.0.2.193'
const SP_MAC = '62:00:00:00:53:e2' // current MAC of the container (speedtest record of the fixture)
const DOCKER_HOST = 'g1' // docker host "docker-a" of the fixture
const AGENTS = GUESTS.slice(0, 13).map(g => g.id)
const hex = n => n.toString(16).padStart(2, '0')

// raw fast report of an agent (as dash-report writes it), passed through cleanFast as in production
function rawReport(host, { ts, version = 6, sp = { mac: SP_MAC, name: 'speedtest-tracker', network: 'local', ip: P }, neigh = null, extraContainers = [] } = {}) {
  const g = GUESTS.find(x => x.id === host)
  const base = { schema: 1, version, mode: 'fast', ts: Math.floor(ts / 1000), hostname: host, os: 'Debian', kernel: '6.12', uptimeSec: 1, load: [0, 0, 0], mem: {}, swap: {}, fs: [], systemd: { failed: [], watched: [] }, reboot: { required: false } }
  const net = { ifaces: [{ name: 'ens18', mac: g.mac, ipv4: [`${g.ip}/24`] }], neigh: neigh ?? [] }
  let docker = null
  const counts = { g1: 19, g2: 4, g3: 3, g4: 2, g5: 1 }
  if (counts[host]) {
    const networks = host === DOCKER_HOST
      ? [['bridge', 'bridge'], ['bridge-2', 'bridge'], ['dl_default', 'bridge'], ['host', 'host'], ['lw_default', 'bridge'], ['local', 'macvlan'], ['mac', 'null'], ['n8n_default', 'bridge'], ['none', 'null'], ['wt_default', 'bridge']]
      : [['bridge', 'bridge'], ['host', 'host'], ['none', 'null']]
    const containers = Array.from({ length: counts[host] - (host === DOCKER_HOST && sp ? 1 : 0) }, (_, i) => ({
      name: `/${host}-app-${i + 1}`, image: 'img:1', state: 'running',
      networks: [{ network: host === DOCKER_HOST ? 'bridge-2' : 'bridge', ip: `172.18.${hex(i)}.${i + 2}`.replace(/\.0(\d)\./, '.$1.'), mac: `02:42:ac:12:${hex(i)}:02` }, null],
    }))
    if (host === DOCKER_HOST && sp) {
      containers.unshift({ name: `/${sp.name}`, image: 'speedtest:1', state: 'running',
        networks: [{ network: 'bridge-2', ip: '172.18.0.4', mac: '02:42:ac:12:ff:04' }, { network: sp.network, ip: sp.ip, mac: sp.mac }, null] })
    }
    docker = { version: '29.9.1', networks: networks.map(([name, driver]) => ({ name, driver })), containers: [...containers, ...extraContainers] }
  }
  return { ...base, ...(version >= 6 ? { net } : {}), docker: docker && version < 6 ? { version: docker.version, containers: docker.containers.map(({ networks, ...c }) => c) } : docker }
}
// 31 neighbors of docker-a: 19 outside the LAN (bridges), 12 on the LAN (fixture hosts)
function prodNeigh() {
  const inside = new Set([...GUESTS.map(g => g.mac), ...APPLIANCES.map(a => a.mac)]) // already hypervisor (pve, config)
  const lan = FIXTURE_HOSTS.filter(h => h.ip !== P && !inside.has(h.mac)).slice(0, 12).map((h, i) => ({ ip: h.ip, mac: h.mac, dev: 'ens18', state: i % 3 ? 'REACHABLE' : 'STALE' }))
  const bridges = Array.from({ length: 19 }, (_, i) => ({ ip: `172.18.0.${i + 2}`, mac: `02:42:ac:12:00:${hex(i + 2)}`, dev: 'br-0123456789ab', state: 'REACHABLE' }))
  return [...lan, ...bridges]
}
// the fleet: 13 agents; version and settings per host can be changed during the test
function fleet(clock) {
  const f = { version: 6, versions: {}, sp: { mac: SP_MAC, name: 'speedtest-tracker', network: 'local', ip: P }, neigh: { g1: prodNeigh() }, extra: {}, lag: 0, host: {} }
  f.reports = () => AGENTS.map(h => {
    const ts = clock.t - f.lag
    const raw = rawReport(h, { ts, version: f.versions[h] ?? f.version, sp: h === DOCKER_HOST ? f.sp : null, neigh: f.neigh[h] ?? [], extraContainers: f.extra[h] ?? [] })
    return { host: h, at: ts, fast: cleanFast(raw) }
  })
  return f
}
async function bench({ version = 6 } = {}) {
  const holder = {}
  const clock = { t: T }
  const f = fleet(clock)
  f.version = version
  const b = r3Bench({ T, agentReports: () => (holder.on ? f.reports() : []) })
  holder.b = b
  b.clock.t = T
  clock.t = T
  Object.defineProperty(clock, 't', { get: () => b.clock.t })
  // as in production: Pi-hole has not seen the container MACs since the day before
  freezePihole(b, { '02:42:00:00:53:e1': T - DAY, [SP_MAC]: T - DAY })
  b.fleet = f
  b.agentsOn = () => { holder.on = true }
  b.devices = () => b.store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n
  b.attr = (id, attr, source) => b.store.db.prepare('SELECT value FROM net_attrs WHERE device_id = ? AND attr = ? AND source = ?').get(id, attr, source)?.value ?? null
  b.mac = mac => b.store.db.prepare('SELECT * FROM net_macs WHERE mac = ?').get(mac)
  b.sp = () => b.devByMac(SP_MAC)
  b.alert = key => b.engine.active().find(a => a.key === key)
  b.cfg.services.push({ id: 'speedtest', name: 'speedtest', host: DOCKER_HOST, url: `http://${P}/`, checks: [] })
  // like record 43 in production: 3 MACs attached by merge (an old one, the 02:42 derived from
  // the IP, the current LAA one), attach 'merge'
  const sp = b.devByMac(SP_MAC)
  b.store.db.prepare("INSERT INTO net_macs (mac, device_id, grade, random, first_seen, last_seen, last_ip, attach) VALUES (?, ?, 'weak', 1, ?, ?, ?, 'merge')").run('0a:00:00:00:53:e0', sp.id, T - 9 * DAY, T - 3 * DAY, P)
  b.store.db.prepare("UPDATE net_macs SET attach = 'merge' WHERE device_id = ?").run(sp.id)
  return b
}
const HOSTS = (spMac = SP_MAC) => [...FIXTURE_HOSTS.filter(h => h.ip !== P), { mac: spMac, ip: P }]

test('no wave: 13 agents v5 then v6, real engine → 0 record, 0 message; the .193 record is speedtest-tracker (agent)', async () => {
  const b = await bench({ version: 5 })
  await b.run(10, HOSTS())
  const n0 = b.devices()
  const out0 = b.outbox()
  b.agentsOn()
  await b.run(10, HOSTS()) // v5: no net field and no networks
  assert.equal(b.attr(b.sp().id, 'container', 'agent'), null)
  b.fleet.version = 6
  await b.run(20, HOSTS())
  assert.deepEqual([b.devices(), b.outbox()], [n0, out0])
  const sp = b.sp()
  assert.equal(b.attr(sp.id, 'name', 'agent'), 'speedtest-tracker')
  assert.equal(b.attr(sp.id, 'container', 'agent'), `${DOCKER_HOST}/speedtest-tracker/local`)
  assert.equal(b.mac(SP_MAC).grade, 'hypervisor')
  assert.equal(b.firing('net_new').length + b.firing('net_mac_added').length, 0)
  // card: the record moves from service origin to agent, same parent
  const node = b.network.topology().nodes.find(n => n.id === `dev:${sp.id}`)
  assert.deepEqual([node.parent, node.origin, node.originContainer], [`host:${DOCKER_HOST}`, 'agent', 'speedtest-tracker'])
  // no neighbor MAC becomes hypervisor; Docker bridges: no 02:42:ac:12 MAC in the database
  for (const x of prodNeigh().filter(n => n.ip.startsWith('192.0.2.'))) assert.notEqual(b.mac(x.mac)?.grade, 'hypervisor', x.mac)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_macs WHERE mac LIKE '02:42:ac:12:%'").get().n, 0)
})

test('agentSightings: bridges, host, none and IPs outside the LAN → nothing; REACHABLE neighbors in the agent subnet only; report older than 5 min ignored', () => {
  const cfg = prodConfig()
  const now = T
  const mk = raw => [{ host: DOCKER_HOST, at: now, fast: cleanFast(raw) }]
  const raw = rawReport(DOCKER_HOST, { ts: now, neigh: [...prodNeigh(), { ip: '198.51.100.7', mac: '00:00:5e:00:53:77', dev: 'ens18', state: 'REACHABLE' }],
    extraContainers: [{ name: '/hors-lan', networks: [{ network: 'local', ip: '203.0.113.5', mac: '0a:00:00:00:53:a1' }] }, { name: '/hote', networks: [{ network: 'host', ip: '192.0.2.10', mac: '0a:00:00:00:53:a2' }] }] })
  const s = agentSightings(mk(raw), cfg, now)
  const ctr = s.filter(x => x.source === 'agent')
  assert.deepEqual(ctr.map(x => [x.mac, x.ip, x.name, x.container]), [[SP_MAC, P, 'speedtest-tracker', { host: DOCKER_HOST, name: 'speedtest-tracker', network: 'local' }]])
  const ng = s.filter(x => x.source === 'agent-neigh')
  assert.equal(ng.length, 8) // 12 LAN neighbors including 4 STALE; bridges (172.x) and IPs outside the agent subnet dropped
  assert.ok(ng.every(x => x.presence === true && x.ts === Math.floor(now / 1000) * 1000))
  assert.deepEqual(agentSightings([{ host: DOCKER_HOST, at: now - 6 * MIN, fast: cleanFast(rawReport(DOCKER_HOST, { ts: now - 6 * MIN })) }], cfg, now), [])
  // neighbor in network.subnets but OUTSIDE the subnet of the agent interfaces → nothing
  const narrow = cleanFast(rawReport(DOCKER_HOST, { ts: now, neigh: [{ ip: '192.0.2.150', mac: '00:00:5e:00:53:96', dev: 'ens18', state: 'REACHABLE' }, { ip: '192.0.2.20', mac: '00:00:5e:00:53:97', dev: 'ens18', state: 'REACHABLE' }] }))
  narrow.net.ifaces = [{ name: 'ens18', mac: null, ipv4: ['192.0.2.10/27'] }]
  assert.deepEqual(agentSightings([{ host: DOCKER_HOST, at: now, fast: narrow }], cfg, now).filter(x => x.source === 'agent-neigh').map(x => x.ip), ['192.0.2.20'])
  assert.deepEqual(agentSightings([{ host: 'inconnu', at: now, fast: cleanFast(raw) }], cfg, now), [])
})

test('agent-neigh: freshness only — last_seen moves forward, neither last_present nor online; net_down NOT suppressed; unknown MAC counted, never created (probe off included)', async () => {
  const b = await bench()
  b.agentsOn()
  const watched = FIXTURE_HOSTS.find(h => /^00:00:5e:00:53:8/.test(h.mac)) // poste-1
  b.fleet.neigh.g1 = [{ ip: watched.ip, mac: watched.mac, dev: 'ens18', state: 'REACHABLE' }, { ip: '192.0.2.177', mac: '00:00:5e:00:53:a7', dev: 'ens18', state: 'REACHABLE' }]
  // Pi-hole no longer sees it: only the agent view can move last_seen forward
  freezePihole(b, { [watched.mac]: T - DAY })
  await b.run(10, HOSTS())
  const id = b.devByMac(watched.mac).id
  b.store.db.prepare('UPDATE net_devices SET alert_down = 1 WHERE id = ?').run(id)
  const lp = b.dev(id).last_present
  // the device no longer answers the probe, but the agent sees it REACHABLE: it goes offline
  await b.run(30, HOSTS().filter(h => h.mac !== watched.mac))
  const d = b.dev(id)
  assert.equal(d.last_present, lp)
  assert.equal(d.online, 0)
  assert.ok(b.firing('net_down').some(a => a.key === `net_down:${id}`))
  assert.ok(b.mac(watched.mac).last_seen > lp)
  const v = b.store.db.prepare("SELECT last_seen FROM net_seen WHERE mac = ? AND source = 'agent-neigh'").get(watched.mac)
  assert.equal(b.mac(watched.mac).last_seen, v.last_seen)
  assert.equal(b.mac('00:00:5e:00:53:a7'), undefined)
  // probe off (passive mode): an unknown MAC seen by an agent still creates nothing
  const cfg = prodConfig()
  const state = { devices: new Map(), macs: new Map(), seen: new Map(), attrs: new Map(), addresses: new Map(), rules: [], flood: emptyFlood('s') }
  const m = mergeSightings(state, [{ mac: '00:00:5e:00:53:a8', ip: '192.0.2.178', source: 'agent-neigh', ts: T, presence: true }, { mac: '0a:00:00:00:53:a9', ip: P, source: 'agent', ts: T, presence: false, name: 'x', container: { host: 'g1', name: 'x', network: 'local' } }], { cfg, now: T, probe: 'off' })
  assert.equal(m.ops.filter(o => o.op === 'insertDevice').length, 0)
  assert.equal(m.stats.agentNeighUnknown, 1)
})

test('recreation under v6 (report already there) → attached by identity (agent, confirmed), info in the digest, 0 net_new, online', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(14, HOSTS())
  const F = b.sp().id
  b.store.db.prepare('UPDATE net_devices SET alert_down = 1 WHERE id = ?').run(F)
  const sent = b.telegram.sent.length
  const NEW = '0a:00:00:00:53:f1'
  b.fleet.sp = { ...b.fleet.sp, mac: NEW } // container recreated by an auto-updater: the agent already reports the new MAC
  await b.run(2, HOSTS(NEW))
  const m = b.mac(NEW)
  assert.deepEqual([m.device_id, m.attach, m.confirmed_by, m.confirmed_at != null], [F, 'agent', `agent:${DOCKER_HOST}`, true])
  const ev = b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'mac_added' AND device_id = ?").all(F).map(e => e.detail)
  assert.deepEqual(ev, [`${NEW}: agent: container speedtest-tracker on ${DOCKER_HOST} (network local)`])
  assert.equal(b.alert(`net_mac_added:${NEW}`).severity, 'info')
  await b.run(10, HOSTS(NEW))
  assert.equal(b.firing('net_new').length, 0)
  assert.equal(b.firing('net_down').length, 0)
  assert.equal(b.sp().online, 1)
  assert.equal(b.dev(F).online, 1)
  assert.equal(b.telegram.sent.length, sent)
  // 24 h later: net_mac_added resolved without a message
  b.clock.t += DAY
  await b.run(4, HOSTS(NEW))
  assert.equal(b.alert(`net_mac_added:${NEW}`), undefined)
  assert.equal(b.telegram.sent.length, sent)
})

test('race: the probe sees the MAC before the agent → IP handover pending, then confirmed by the agent; escalated IP handover → never confirmed', async () => {
  const setup = async () => {
    const b = await bench()
    b.agentsOn()
    await b.run(14, HOSTS())
    return { b, NEW: '0a:00:00:00:53:f1' }
  }
  const { b, NEW } = await setup()
  const F = b.sp().id
  // the agent still reports the old MAC (60 s report); the probe sees only the new one
  b.clock.t += 2 * MIN - 30_000
  b.probe.write(b.clock.t, HOSTS(NEW))
  b.network.runArp()
  b.engine.evaluate({}, b.clock.t)
  let m = b.mac(NEW)
  assert.deepEqual([m.device_id, m.attach, m.confirmed_at], [F, 'ip', null]) // IP handover, pending
  // the agent reports the new MAC: confirmed, net_mac_added resolves without a message
  const sent = b.telegram.sent.length
  b.fleet.sp = { ...b.fleet.sp, mac: NEW }
  await b.run(4, HOSTS(NEW))
  m = b.mac(NEW)
  assert.deepEqual([m.attach, m.confirmed_by], ['ip', `agent:${DOCKER_HOST}`])
  assert.equal(b.alert(`net_mac_added:${NEW}`), undefined)
  assert.equal(b.telegram.sent.length, sent)
  // escalated IP handover (the old MAC came back on the IP): never confirmed by the agent
  const c = (await setup()).b
  c.clock.t += 2 * MIN - 30_000
  c.probe.write(c.clock.t, HOSTS(NEW))
  c.network.runArp()
  c.clock.t += 2 * MIN
  c.probe.write(c.clock.t, HOSTS())
  c.network.runArp()
  assert.ok(JSON.parse(c.store.kv.get('network.ipHandover')).find(e => e.mac === NEW).escalated)
  c.fleet.sp = { ...c.fleet.sp, mac: NEW }
  await c.run(4, HOSTS(NEW))
  assert.equal(c.mac(NEW).confirmed_at, null)
})

test('fallback: silent agent (report older than 5 min) → IP handover; other host, different name → normal path; tombstone → tombstone rule', async () => {
  const recreate = async ({ edit = () => {} } = {}) => {
    const b = await bench()
    b.agentsOn()
    await b.run(14, HOSTS())
    const NEW = '0a:00:00:00:53:f1'
    edit(b, NEW)
    await b.run(2, HOSTS(NEW))
    return { b, m: b.mac(NEW), F: b.sp().id }
  }
  // silent agent: its last report is more than 5 min old
  const mute = await recreate({ edit: (b, NEW) => { b.fleet.sp = { ...b.fleet.sp, mac: NEW }; b.fleet.lag = 6 * MIN } })
  assert.deepEqual([mute.m.device_id, mute.m.attach, mute.m.confirmed_at], [mute.F, 'ip', null])
  // the same name announced by the agent of ANOTHER host (g2): identity g2/…, no association → IP handover
  const other = await recreate({ edit: (b, NEW) => { b.fleet.extra.g2 = [{ name: '/speedtest-tracker', networks: [{ network: 'local', ip: P, mac: NEW }] }] } })
  assert.notEqual(other.m.attach, 'agent')
  // different name on docker-a: no common identity → IP handover
  const renamed = await recreate({ edit: (b, NEW) => { b.fleet.sp = { ...b.fleet.sp, mac: NEW, name: 'speedtest-2' } } })
  assert.notEqual(renamed.m.attach, 'agent')
  // tombstone on the new MAC: returned, "new" record
  const tomb = await recreate({ edit: (b, NEW) => {
    b.store.db.prepare('INSERT INTO net_tombstones (mac, deleted_at, device_id, reason, deleted_by) VALUES (?, ?, ?, ?, ?)').run(NEW, b.clock.t - DAY, 99, 'test', 'admin')
    b.fleet.sp = { ...b.fleet.sp, mac: NEW }
  } })
  assert.equal(tomb.b.devByMac('0a:00:00:00:53:f1').state, 'new')
  assert.notEqual(tomb.m.attach, 'agent')
})

test('macvlan unknown to the agent answering ARP → "new" and net_new, then named and associated at the next report', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(14, HOSTS())
  const X = { mac: '0a:00:00:00:53:c7', ip: '192.0.2.199' }
  await b.run(14, [...HOSTS(), X])
  const d = b.devByMac(X.mac)
  assert.equal(d.state, 'new')
  assert.ok(b.firing('net_new').some(a => a.key === `net_new:${d.id}`))
  b.fleet.extra.g1 = [{ name: '/nouveau-ctr', networks: [{ network: 'local', ip: X.ip, mac: X.mac }] }]
  await b.run(2, [...HOSTS(), X])
  // late association: done, but the name waits for a human confirmation ("Known")
  assert.equal(b.attr(d.id, 'container', 'agent'), `${DOCKER_HOST}/nouveau-ctr/local`)
  assert.equal(b.attr(d.id, 'name', 'agent'), null)
  b.network.writes.ack({ ids: [d.id], reason: 'conteneur vérifié' }, { by: 'admin (test)', source: 'ui' })
  b.clock.t += 1000
  await b.run(2, [...HOSTS(), X])
  assert.equal(b.attr(d.id, 'name', 'agent'), 'nouveau-ctr')
})

test('mixed v5/v6 fleet, then back from v6 to v5 on docker-a → no alert; the record keeps name, association and agent parent', async () => {
  const b = await bench()
  for (const h of AGENTS.slice(6)) b.fleet.versions[h] = 5
  b.agentsOn()
  await b.run(14, HOSTS())
  const F = b.sp().id
  const out = b.outbox()
  b.fleet.versions[DOCKER_HOST] = 5
  await b.run(20, HOSTS())
  assert.equal(b.outbox(), out)
  assert.equal(b.attr(F, 'name', 'agent'), 'speedtest-tracker')
  assert.equal(b.attr(F, 'container', 'agent'), `${DOCKER_HOST}/speedtest-tracker/local`)
  const node = b.network.topology().nodes.find(n => n.id === `dev:${F}`)
  assert.deepEqual([node.parent, node.origin], [`host:${DOCKER_HOST}`, 'agent'])
  assert.equal(b.firing('net_').length, 0)
})

// --- edge cases: identity, conflicts, passive mode, deletion ---------------------------
const who = { by: 'admin (test)', source: 'ui' }
const NEWM = '0a:00:00:00:53:f1'

test('known MAC missing from the probe, announced ONLY by agent-neigh → offline after its profile delay, net_down is sent', async () => {
  const b = await bench()
  b.agentsOn()
  const watched = FIXTURE_HOSTS.find(h => /^00:00:5e:00:53:8/.test(h.mac))
  freezePihole(b, { [watched.mac]: T - DAY })
  b.fleet.neigh.g1 = [{ ip: watched.ip, mac: watched.mac, dev: 'ens18', state: 'REACHABLE' }]
  await b.run(10, HOSTS())
  const id = b.devByMac(watched.mac).id
  b.store.db.prepare("UPDATE net_devices SET alert_down = 1, profile = 'normal' WHERE id = ?").run(id)
  await b.run(4, HOSTS().filter(h => h.mac !== watched.mac))
  assert.equal(b.dev(id).online, 1) // before the profile delay (normal: 10 min)
  await b.run(14, HOSTS().filter(h => h.mac !== watched.mac))
  assert.equal(b.dev(id).online, 0)
  assert.ok(b.firing('net_down').some(a => a.key === `net_down:${id}`))
})

test('identity confirmed automatically only within ipIdentity AND seen by the probe; probe off or IP out of range → PENDING (ip), info, no IP handover', () => {
  const cfg = prodConfig()
  const F = 43
  const OLD = '0a:00:00:00:53:e0'
  const base = (ip, oldIp = ip) => ({
    devices: new Map([[F, { id: F, state: 'known', primary_mac: OLD, disp_name: 'speedtest-tracker', last_ip: oldIp }]]),
    macs: new Map([[OLD, { mac: OLD, device_id: F, grade: 'hypervisor', random: 1, first_seen: T - DAY, last_seen: T - 5 * MIN, last_ip: oldIp, attach: null, confirmed_at: null }]]),
    seen: new Map([[`${OLD}|agent`, { mac: OLD, source: 'agent', last_seen: T - 5 * MIN, last_ip: oldIp }]]),
    attrs: new Map([[F, [{ device_id: F, attr: 'container', source: 'agent', value: `${DOCKER_HOST}/speedtest-tracker/local`, rank: 7, seen_at: T - 5 * MIN }]]]),
    addresses: new Map(), rules: [], flood: emptyFlood('s'),
  })
  const idx = ip => new Map([[NEWM, { host: DOCKER_HOST, name: 'speedtest-tracker', network: 'local', ip, ts: T - 30_000 }]])
  const scan = ip => ({ ts: T, byIp: new Map([[ip, [NEWM]]]), macs: new Set([NEWM]), conflicts: new Set() })
  const opsOf = m => m.ops.find(o => o.op === 'upsertMac' && o.mac === NEWM)
  // probe running, ipIdentity range, seen in the sweep: confirmed automatically (agent)
  const on = mergeSightings(base(P), [{ mac: NEWM, ip: P, source: 'arp', ts: T, presence: true }], { cfg, now: T, probe: 'on', arpScan: scan(P), agentIndex: idx(P) })
  assert.deepEqual([opsOf(on).attach, opsOf(on).confirmed_by], ['agent', `agent:${DOCKER_HOST}`])
  // probe off (Pi-hole): pending, attach ip, no IP handover
  const off = mergeSightings(base(P), [{ mac: NEWM, ip: P, source: 'pihole', ts: T, presence: true }], { cfg, now: T, probe: 'off', agentIndex: idx(P) })
  assert.deepEqual([opsOf(off).attach, opsOf(off).confirmed_at ?? null, off.l1.length], ['ip', null, 0])
  assert.match(off.ops.find(o => o.op === 'insertEvent' && o.type === 'mac_added').detail, /agent: container speedtest-tracker on g1 \(network local\), pending/)
  // IP outside the ipIdentity range, probe running and MAC in the sweep: pending as well
  const OUT = '192.0.2.150'
  const out = mergeSightings(base(OUT), [{ mac: NEWM, ip: OUT, source: 'arp', ts: T, presence: true }], { cfg, now: T, probe: 'on', arpScan: scan(OUT), agentIndex: idx(OUT) })
  assert.deepEqual([opsOf(out).attach, opsOf(out).confirmed_at ?? null, out.l1.length], ['ip', null, 0])
})

test('forged report with the universal MAC of a known record → no association, no renaming', async () => {
  const b = await bench()
  b.agentsOn()
  const poste = FIXTURE_HOSTS.find(h => /^00:00:5e:00:53:8/.test(h.mac)) // universal MAC (OUI)
  b.fleet.extra.g1 = [{ name: '/faux', networks: [{ network: 'local', ip: poste.ip, mac: poste.mac }] }]
  await b.run(10, HOSTS())
  const id = b.devByMac(poste.mac).id
  assert.equal(b.attr(id, 'container', 'agent'), null)
  assert.equal(b.attr(id, 'name', 'agent'), null)
  assert.notEqual(b.dev(id).disp_name, 'faux')
  const node = b.network.topology().nodes.find(n => n.id === `dev:${id}`)
  assert.notEqual(node.origin, 'agent')
  // grade and primary MAC unchanged (the grade is only raised for an accepted association)
  assert.equal(b.mac(poste.mac).grade, 'strong')
  assert.equal(b.dev(id).primary_mac, poste.mac)
})

test('identity already associated claimed by another record → refused, conflict as warning (immediate message), rule C suspended', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(10, HOSTS())
  const F = b.sp().id
  const phone = FIXTURE_HOSTS.find(h => h.mac.startsWith('06:00:00:00:53:d')) // Telephone-1, LAA MAC
  const victim = b.devByMac(phone.mac).id
  const sent = b.telegram.sent.length
  // a report announces speedtest-tracker with the phone MAC
  b.fleet.extra.g1 = [{ name: '/speedtest-tracker', networks: [{ network: 'local', ip: phone.ip, mac: phone.mac }] }]
  await b.run(4, HOSTS())
  assert.equal(b.attr(F, 'container', 'agent'), `${DOCKER_HOST}/speedtest-tracker/local`) // not moved
  assert.notEqual(b.attr(victim, 'container', 'agent'), `${DOCKER_HOST}/speedtest-tracker/local`)
  const a = b.alert(`net_agent_conflict:${victim}`)
  assert.equal(a.severity, 'warning')
  assert.ok(b.telegram.sent.length > sent)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE type = 'agent_conflict' AND device_id = ?").get(victim).n, 1)
  // rule C suspended: a recreation of speedtest is not attached by identity (IP handover, pending)
  b.fleet.extra.g1 = []
  b.fleet.sp = { ...b.fleet.sp, mac: NEWM }
  await b.run(2, HOSTS(NEWM))
  assert.notEqual(b.mac(NEWM)?.attach, 'agent')
})

test('LAA phone "Pixel-7" claimed after the first v6 report → digest, to review, name unchanged', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(10, HOSTS())
  const phone = FIXTURE_HOSTS.find(h => h.mac.startsWith('06:00:00:00:53:d'))
  const id = b.devByMac(phone.mac).id
  // the LAA phone of the fixture (DHCP name "Telephone-1", playing the role of a "Pixel-7")
  const before = b.dev(id).disp_name
  b.store.db.prepare('UPDATE net_devices SET review = 0 WHERE id = ?').run(id)
  await b.run(2, HOSTS())
  assert.equal(b.dev(id).review, 0)
  b.fleet.extra.g1 = [{ name: '/vpn', networks: [{ network: 'local', ip: phone.ip, mac: phone.mac }] }]
  await b.run(4, HOSTS())
  assert.equal(b.attr(id, 'container', 'agent'), `${DOCKER_HOST}/vpn/local`)
  assert.equal(b.attr(id, 'name', 'agent'), null)
  assert.equal(b.dev(id).disp_name, before)
  assert.notEqual(b.dev(id).disp_name, 'vpn')
  assert.equal(b.dev(id).review, 1)
  assert.ok(b.network.digestLines({ now: b.clock.t }).some(l => l.includes('associée à un conteneur après coup') && l.includes(`${before} → g1/vpn/local`)))
  // late and unconfirmed → the card (and the record) do not place it under the host
  const node = b.network.topology().nodes.find(n => n.id === `dev:${id}`)
  assert.notEqual(node.origin, 'agent')
  assert.notEqual(b.network.device(id).mapParent.origin, 'agent')
  // record 43, however, was associated and named at the first v6 report (no digest)
  assert.equal(b.attr(b.sp().id, 'name', 'agent'), 'speedtest-tracker')
})

test('fast report over 512 KiB refused BEFORE reading (stat locally, maxBuffer over SSH)', async t => {
  const fsp = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { readLocalReport, readLimit } = await import('../lib/agents.js')
  const dir = tmpDir('dash-local-', t)
  const file = path.join(dir, 'fast.json')
  await fsp.writeFile(file, 'x'.repeat(600 * 1024))
  await fsp.chmod(file, 0o000) // unreadable: only a decision based on stat can answer "too big"
  await assert.rejects(readLocalReport(dir, 'fast'), e => e.info?.msg === 'rapport trop gros')
  await fsp.chmod(file, 0o600)
  assert.equal(readLimit('fast'), 512 * 1024)
  assert.ok(readLimit('slow') > readLimit('fast'))
})

test('agent-neigh has no effect on absence (passive mode): attachment by name after 10 min still applies', () => {
  const cfg = prodConfig()
  const OLDP = '06:00:00:00:5c:01'
  const NEWP = '0a:00:00:00:5c:02'
  const st = {
    devices: new Map([[1, { id: 1, state: 'known', disp_name: 'Tablette-Salon', primary_mac: OLDP }]]),
    macs: new Map([[OLDP, { mac: OLDP, device_id: 1, grade: 'weak', random: 1, first_seen: T - 9 * DAY, last_seen: T - 20 * MIN, attach: null, confirmed_at: null }]]),
    seen: new Map([[`${OLDP}|pihole`, { mac: OLDP, source: 'pihole', last_seen: T - 20 * MIN }], [`${OLDP}|agent-neigh`, { mac: OLDP, source: 'agent-neigh', last_seen: T - MIN }]]),
    attrs: new Map([[1, [{ device_id: 1, attr: 'name', source: 'dhcp', value: 'Tablette-Salon', rank: 6, seen_at: T - 20 * MIN }]]]),
    addresses: new Map(), rules: [], flood: emptyFlood('s'),
  }
  const m = mergeSightings(st, [{ mac: OLDP, ip: '192.0.2.141', source: 'agent-neigh', ts: T, presence: true },
    { mac: NEWP, ip: '192.0.2.142', source: 'pihole', ts: T, presence: true }, { mac: NEWP, ip: '192.0.2.142', source: 'dhcp', ts: T, presence: false, name: 'Tablette-Salon', leaseExpires: T + DAY }], { cfg, now: T, probe: 'off' })
  assert.ok(m.ops.some(o => o.op === 'upsertMac' && o.mac === NEWP && o.device === 1 && o.attach === 'name'))
  // and the agent-neigh view of the known MAC did not change its IP (freshness only)
  assert.ok(!m.ops.some(o => o.op === 'upsertMac' && o.mac === OLDP && o.last_ip === '192.0.2.141'))
})

test('identity: an IP different from the one announced by the agent → no attachment by identity', () => {
  const cfg = prodConfig()
  const F = 43
  const OLD = '0a:00:00:00:53:e0'
  const st = {
    devices: new Map([[F, { id: F, state: 'known', primary_mac: OLD, disp_name: 'speedtest-tracker', last_ip: P }]]),
    macs: new Map([[OLD, { mac: OLD, device_id: F, grade: 'hypervisor', random: 1, first_seen: T - DAY, last_seen: T - 5 * MIN, last_ip: P, attach: null, confirmed_at: null }]]),
    seen: new Map([[`${OLD}|agent`, { mac: OLD, source: 'agent', last_seen: T - 5 * MIN, last_ip: P }]]),
    attrs: new Map([[F, [{ device_id: F, attr: 'container', source: 'agent', value: `${DOCKER_HOST}/speedtest-tracker/local`, rank: 7, seen_at: T - 5 * MIN }]]]),
    addresses: new Map(), rules: [], flood: emptyFlood('s'),
  }
  const m = mergeSightings(st, [{ mac: NEWM, ip: P, source: 'arp', ts: T, presence: true }], { cfg, now: T, probe: 'on',
    arpScan: { ts: T, byIp: new Map([[P, [NEWM]]]), macs: new Set([NEWM]), conflicts: new Set() },
    agentIndex: new Map([[NEWM, { host: DOCKER_HOST, name: 'speedtest-tracker', network: 'local', ip: '192.0.2.194', ts: T - 30_000 }]]) })
  assert.ok(!m.ops.some(o => o.op === 'upsertMac' && o.mac === NEWM && o.attach === 'agent'))
})

test('on a container record, delete, detach, family rule and merge go through; MAC seen by pve → 409 unchanged', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(10, HOSTS())
  const F = b.sp().id
  const W = b.network.writes
  // family rule covering the container MAC: accepted (the MAC is no longer an identity)
  W.addRule({ prefix: SP_MAC.slice(0, 8), action: 'attach', deviceId: F, name: 'speedtest', reason: 'famille du conteneur' }, who)
  // detach the old Docker MAC, then the container MAC: accepted; the association is removed
  const det = W.detachMac({ mac: SP_MAC, reason: 'test détacher' }, who)
  assert.equal(b.attr(F, 'container', 'agent'), '-')
  // no silent attachment: the new record gets a late association (to review), without a name
  await b.run(2, HOSTS())
  assert.equal(b.mac(SP_MAC).device_id, det.device)
  assert.equal(b.attr(det.device, 'container', 'agent'), `${DOCKER_HOST}/speedtest-tracker/local`)
  assert.equal(b.attr(det.device, 'name', 'agent'), null)
  assert.equal(b.dev(det.device).state, 'new') // detached record: "new", never glued back
  // merge into the original record: accepted, the association follows
  W.merge({ into: F, from: [det.device], reason: 'même conteneur' }, who)
  assert.equal(b.mac(SP_MAC).device_id, F)
  assert.equal(b.attr(F, 'container', 'agent'), `${DOCKER_HOST}/speedtest-tracker/local`)
  // MAC seen by pve (guest g2): still an identity, deletion refused (409)
  const guest = b.devByMac(GUESTS[1].mac).id
  assert.throws(() => W.delete({ ids: [guest], reason: 'test test' }, who), e => e.status === 409)
  // delete the container record: accepted
  W.delete({ ids: [F], reason: 'conteneur retiré' }, who)
  assert.equal(b.dev(F), undefined)
})

test('deleting a LIVE container → it comes back as "new" at the next sweep, 1 net_new, never glued back by the agent', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(10, HOSTS())
  const F = b.sp().id
  const n0 = b.devices()
  b.network.writes.delete({ ids: [F], reason: 'conteneur supprimé (test)' }, who)
  await b.run(14, HOSTS())
  const d = b.devByMac(SP_MAC)
  assert.notEqual(d.id, F)
  assert.equal(d.state, 'new')
  assert.equal(b.devices(), n0)
  assert.deepEqual(b.firing('net_new').map(a => a.key), [`net_new:${d.id}`])
  assert.notEqual(b.mac(SP_MAC).attach, 'agent')
})

test('merge into a target already associated with another identity → 409', async () => {
  const b = await bench()
  b.agentsOn()
  const phone = FIXTURE_HOSTS.find(h => h.mac.startsWith('06:00:00:00:53:d'))
  b.fleet.extra.g1 = [{ name: '/autre', networks: [{ network: 'local', ip: phone.ip, mac: phone.mac }] }]
  await b.run(10, HOSTS())
  const F = b.sp().id
  const other = b.devByMac(phone.mac).id
  assert.equal(b.attr(other, 'container', 'agent'), `${DOCKER_HOST}/autre/local`)
  assert.throws(() => b.network.writes.merge({ into: F, from: [other], reason: 'test fusion' }, who), e => e.status === 409 && /conflit d'identité/.test(e.message))
})

test('never an association for a record linked to a host (pve MAC, even LAA) or carrying a strong MAC', async () => {
  const b = await bench()
  b.agentsOn()
  const guest = GUESTS[1] // LAA MAC 02:00:00:00:5a:01, seen by pve, record linked to g2
  const poste = FIXTURE_HOSTS.find(h => /^00:00:5e:00:53:8/.test(h.mac))
  await b.run(4, HOSTS())
  // unlinked record carrying a strong MAC, plus an LAA MAC announced by the agent
  const strong = b.devByMac(poste.mac).id
  b.store.db.prepare("INSERT INTO net_macs (mac, device_id, grade, random, first_seen, last_seen, last_ip, attach) VALUES (?, ?, 'weak', 1, ?, ?, ?, 'merge')").run('0a:00:00:00:53:b9', strong, T - DAY, T - MIN, poste.ip)
  b.fleet.extra.g1 = [
    { name: '/faux-invite', networks: [{ network: 'local', ip: guest.ip, mac: guest.mac }] },
    { name: '/faux-poste', networks: [{ network: 'local', ip: poste.ip, mac: '0a:00:00:00:53:b9' }] },
  ]
  await b.run(6, HOSTS())
  const g = b.devByMac(guest.mac).id
  for (const id of [g, strong]) {
    assert.equal(b.attr(id, 'container', 'agent'), null, String(id))
    assert.equal(b.attr(id, 'name', 'agent'), null, String(id))
  }
})

test('an unconfirmed late association is not used for attachment by identity → new record and net_new', async () => {
  const b = await bench()
  b.agentsOn()
  await b.run(10, HOSTS())
  const phone = FIXTURE_HOSTS.find(h => h.mac.startsWith('06:00:00:00:53:d'))
  const id = b.devByMac(phone.mac).id
  b.fleet.extra.g1 = [{ name: '/vpn', networks: [{ network: 'local', ip: phone.ip, mac: phone.mac }] }]
  await b.run(4, HOSTS())
  assert.equal(b.attr(id, 'container', 'agent'), `${DOCKER_HOST}/vpn/local`) // late, unconfirmed
  // a new MAC on the phone IP, assigned to /vpn by the same report
  const NEWV = '0a:00:00:00:53:d9'
  b.fleet.extra.g1 = [{ name: '/vpn', networks: [{ network: 'local', ip: phone.ip, mac: NEWV }] }]
  await b.run(14, [...HOSTS().filter(h => h.mac !== phone.mac), { mac: NEWV, ip: phone.ip }])
  const d = b.devByMac(NEWV)
  assert.notEqual(d.id, id)
  assert.equal(d.state, 'new')
  assert.ok(b.firing('net_new').some(a => a.key === `net_new:${d.id}`))
})
