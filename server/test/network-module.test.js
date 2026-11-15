// Network module, light integration: createNetwork on a temporary database, with
// simulated sources (Pi-hole, `ip neigh` through an injected exec, Proxmox) and a
// driven clock: bootstrap, new device, Pi-hole in error, flood, restart.
// Plus the routes: read-only, no write route at this stage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { createNetwork } from '../lib/network/index.js'
import { mountNetwork } from '../lib/network/routes.js'
import { summary } from '../lib/status.js'
import { createAudit } from '../lib/auth.js'
import { prodLikeStore, prodConfig, netServer, r3Bench, FIXTURE_HOSTS, DAY, freezePihole, quiet } from './network-fixture.js'
import { tmpStore } from './tmpdir.js'

const MIN = 60_000
const T0 = Date.parse('2026-10-20T12:00:30Z')
const S = t => Math.floor(t / 1000)

const configOf = (network = {}) => {
  const { config, errors } = parseConfig({
    version: 2, title: 't',
    proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod' },
      { id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 102, ip: '192.0.2.157', parent: 'pve', env: 'prod' },
    ],
    groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { pihole: { url: 'http://192.0.2.158', secretEnv: 'PH' }, neigh: {} }, ...network },
  })
  if (errors) throw new Error(errors.join('\n'))
  return config
}

function setup(networkCfg) {
  const cfg = configOf(networkCfg)
  const store = tmpStore('dash-netmod-')
  let clock = T0
  // what Pi-hole sees: MAC → { ip, lastSeen (ms) }; down: Pi-hole unreachable
  const lan = new Map()
  const ph = { down: false, leases: [] }
  const pihole = {
    async get(p) {
      if (ph.down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      if (p.startsWith('/api/network/devices')) {
        return { devices: [...lan].map(([mac, d], i) => ({ id: i, hwaddr: mac, interface: 'eth0', firstSeen: S(T0 - 86400_000), lastQuery: 0, numQueries: 0, macVendor: d.vendor ?? '', ips: [{ ip: d.ip, name: d.name ?? null, lastSeen: S(d.lastSeen), nameUpdated: 0 }] })), took: 0 }
      }
      if (p === '/api/dhcp/leases') return { leases: ph.leases, took: 0 }
      throw new Error('route')
    },
  }
  // ip -j -4 neigh: the web guest is reachable; also checks that the command is called without a shell
  const calls = []
  const exec = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args])
    cb(null, JSON.stringify([{ dst: '192.0.2.157', dev: 'eth0', lladdr: '00:00:5e:00:53:47', state: ['REACHABLE'] }]))
  }
  // Proxmox: the netX card of the guest; a Docker interface of the agent creates nothing
  const sources = {
    guestNics: async () => [{ id: 'prod', guests: [{ vmid: 102, name: 'web', type: 'lxc', node: 'pve', status: 'running', nics: [{ key: 'net0', mac: '00:00:5e:00:53:47', ip: '192.0.2.157', bridge: 'vmbr0', ips: ['192.0.2.157'] }] }] }],
  }
  const logs = []
  const log = { warn: m => logs.push(m), error: m => logs.push(m), log: () => {} }
  const network = createNetwork({ cfg, store, sources, pihole, exec, audit: createAudit(store), now: () => clock, log })
  return {
    cfg, store, network, lan, ph, logs, calls,
    tick: async (ms = MIN) => {
      clock += ms
      return network.runAll()
    },
    get clock() { return clock },
  }
}

test('network module: bootstrap, new device, Pi-hole in error, restart', async () => {
  const x = setup()
  const { network, lan, store } = x
  // first start: 29 bootstrap scans already done, this one is the last
  store.kv.set('network.baselineRuns', 29)
  lan.set('00:00:5e:00:53:10', { ip: '192.0.2.10', lastSeen: T0, vendor: 'Exemple SA', name: 'nas.lan' })
  lan.set('00:00:5e:00:53:11', { ip: '192.0.2.11', lastSeen: T0 - 3 * 3600_000, name: 'poste.lan' })
  x.ph.leases = [{ expires: S(T0 + 3600_000), hwaddr: '00:00:5e:00:53:12', ip: '192.0.2.12', name: 'camera', clientid: '*' }]
  await x.tick(0)
  assert.deepEqual(x.calls[0], ['ip', '-j', '-4', 'neigh', 'show', 'dev', 'eth0'])
  let v = network.view()
  assert.equal(v.presence, 'passive')
  assert.equal(v.baseline, false)
  assert.deepEqual(v.devices.map(d => [d.ip, d.state, d.review, d.freshness]), [
    ['192.0.2.10', 'known', true, 'active'],
    ['192.0.2.11', 'known', true, 'idle'],
    ['192.0.2.12', 'known', true, 'dhcp'], // only a lease: "seen by DHCP"
    ['192.0.2.157', 'known', false, 'active'], // Proxmox guest seen by the neighbors, linked to its host
  ])
  const web = v.devices[3]
  assert.deepEqual([web.hostId, web.name, web.type], ['web', 'web', 'server'])
  assert.deepEqual(v.counts, { total: 4, active: 2, idle: 1, dhcp: 1, stale: 0, new: 0, review: 3, pending: 0, online: 0, offline: 0, unknown: 4 })
  assert.equal(v.sources.pihole.ok, true)
  assert.equal(v.sources.pve.n, 1)
  // never "online" without the probe
  assert.equal(web.online, null) // without ARP probe: presence unknown, never "online"

  // a phone arrives after bootstrap: "new"
  lan.set('02:00:00:00:53:20', { ip: '192.0.2.20', lastSeen: x.clock + MIN, name: 'Galaxy-Exemple' })
  await x.tick()
  v = network.view()
  const phone = v.devices.find(d => d.ip === '192.0.2.20')
  assert.deepEqual([phone.state, phone.random, phone.name, phone.freshness, phone.type], ['new', true, 'Galaxy-Exemple', 'active', 'phone'])
  assert.equal(v.counts.new, 1)

  // Pi-hole unreachable: inventory kept, source in error then stale, nothing deleted
  x.ph.down = true
  for (let i = 0; i < 4; i++) await x.tick()
  v = network.view()
  assert.equal(v.devices.length, 5)
  assert.deepEqual([v.sources.pihole.ok, v.sources.pihole.stale, v.sources.pihole.error], [false, true, 'ECONNREFUSED'])
  assert.equal(v.sources.neigh.ok, true)
  assert.ok(x.logs.some(l => /pihole: ECONNREFUSED/.test(l)))
  const sum = network.summary()
  assert.deepEqual([sum.presence, sum.total, sum.new, sum.sourcesOk, sum.sourcesDown], ['passive', 5, 1, false, ['pihole', 'dhcp']])

  // record: MAC, sightings per source, origin, services; 404 for an unknown one
  const nas = v.devices.find(d => d.ip === '192.0.2.10')
  const d = network.device(nas.id, { servicesOf: ip => [{ id: 's', name: `svc ${ip}` }] })
  assert.equal(d.macs[0].mac, '00:00:5e:00:53:10')
  assert.deepEqual(d.seen.map(s => s.source), ['pihole'])
  assert.ok(d.attrs.some(a => a.attr === 'vendor' && a.value === 'Exemple SA' && a.chosen))
  assert.deepEqual(d.events.map(e => e.type), ['new'])
  assert.deepEqual(d.services, [{ id: 's', name: 'svc 192.0.2.10' }])
  assert.equal(network.device(99999), null)

  // restart: inventory and source state restored from SQLite
  const again = createNetwork({ cfg: x.cfg, store, pihole: { get: async () => { throw new Error('x') } }, now: () => x.clock, log: quiet })
  assert.deepEqual(again.view().counts, network.view().counts)
  assert.equal(again.view().sources.pihole.ok, false)
})

test('network module: MAC flood → creations suspended, visible in sources', async () => {
  const x = setup({ maxNewPerCycle: 2 })
  x.store.kv.set('network.baseline', 'posé')
  // the 5 devices answer every scan (lastSeen at the scan time)
  const seeAll = t => { for (let i = 1; i <= 5; i++) x.lan.set(`00:00:5e:00:53:3${i}`, { ip: `192.0.2.3${i}`, lastSeen: t }) }
  seeAll(x.clock)
  await x.tick(0)
  let v = x.network.view()
  assert.equal(v.counts.new, 0) // 5 > 2: the whole scan is refused
  assert.match(v.sources.merge.error, /créations suspendues/)
  for (let i = 0; i < 2; i++) {
    seeAll(x.clock + 5 * MIN)
    await x.tick(5 * MIN)
  }
  // present in 3 scans over 10 min: persistent, created (5 per hour at most)
  v = x.network.view()
  assert.equal(v.counts.new, 5)
})

test('read routes: list, record, 404, 400; history limited to 7, 30 or 90 days', async () => {
  const x = setup()
  await x.tick(0)
  const app = express()
  app.use('/api', express.json())
  mountNetwork(app, { network: x.network })
  app.all('/api/*', (req, res) => res.status(404).json({ error: 'route inconnue' }))
  const srv = app.listen(0)
  await new Promise(r => srv.once('listening', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const list = await (await fetch(`${base}/api/network`)).json()
    assert.equal(list.enabled, true)
    const id = list.devices[0].id
    assert.equal((await fetch(`${base}/api/network/devices/${id}`)).status, 200)
    assert.equal((await fetch(`${base}/api/network/devices/9999`)).status, 404)
    assert.equal((await fetch(`${base}/api/network/devices/abc`)).status, 400)
    // without a configured ARP probe: empty history, never an error; days outside the list → 400
    assert.deepEqual(await (await fetch(`${base}/api/network/history?days=30`)).json(), { enabled: false, days: 30, points: [] })
    assert.equal((await fetch(`${base}/api/network/history?days=12`)).status, 400)
  } finally {
    srv.close()
  }
})

test('network module: stop() waits for the running scan, no scan afterwards', async () => {
  const x = setup()
  const pending = []
  let calls = 0
  const slow = { get: p => { calls++; return new Promise(r => pending.push(() => r(p.includes('leases') ? { leases: [] } : { devices: [] }))) } }
  const release = () => pending.splice(0).forEach(f => f())
  const net = createNetwork({ cfg: x.cfg, store: x.store, pihole: slow, now: () => x.clock, log: quiet })
  const run = net.runAll()
  let done = false
  const stopping = net.stop().then(() => { done = true })
  // several event loop turns, not a fixed delay
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
  assert.equal(done, false) // scan running: stop() waits
  release()
  await run
  await stopping
  assert.equal(done, true)
  const before = calls
  assert.equal(await net.runAll(), null)
  assert.equal(calls, before)
})

test('nothing is ignored: no more counter nor "ignored MACs" line; family in the digest', async () => {
  const x = setup()
  x.store.kv.set('network.baseline', 'posé')
  x.lan.set('0e:00:00:00:53:41', { ip: '192.0.2.41', lastSeen: x.clock })
  x.lan.set('0e:00:00:00:53:42', { ip: '192.0.2.42', lastSeen: x.clock })
  await x.tick(0)
  assert.equal('ignoredMacs' in x.network.view().counts, false)
  assert.equal(x.network.view().devices.filter(d => d.mac.startsWith('0e:00:00')).length, 2) // inventoried
  assert.ok(!x.network.digestLines({ mark: true }).some(l => /MAC ignorées/.test(l)))
  // validated family: an attachment by rule is listed in the digest
  x.lan.set('fe:00:00:00:53:51', { ip: '192.0.2.51', lastSeen: x.clock, name: 'Tab-Exemple' })
  await x.tick()
  const target = x.network.view().devices.find(d => d.mac === 'fe:00:00:00:53:51')
  x.network.writes.addRule({ prefix: 'fe:00:00', action: 'attach', deviceId: target.id, name: 'Tab-Exemple', reason: 'TAB qui tourne' }, { by: 'admin (test)', source: 'ui' })
  x.lan.set('fe:00:00:00:53:52', { ip: '192.0.2.52', lastSeen: x.clock + MIN, name: 'Tab-Exemple' })
  await x.tick()
  assert.ok(x.network.digestLines().some(l => /MAC ajoutée par règle \(24 h\) : fe:00:00:00:53:52 à Tab-Exemple/.test(l)))
  // same digest through the English catalog
  const { setLocale } = await import('../lib/i18n.js')
  const fr = x.network.digestLines()
  setLocale('en')
  let en
  try {
    en = x.network.digestLines()
  } finally {
    setLocale('fr')
  }
  assert.equal(en.length, fr.length)
  assert.match(fr[0], /^🌐 Réseau : \d+ appareils, \d+ actifs · /)
  assert.match(en[0], /^🌐 Network: \d+ devices, \d+ active · .*sources OK$/)
  assert.ok(en.includes('   MAC added by rule (24 h): fe:00:00:00:53:52 to Tab-Exemple'), en.join('\n'))
})

test('network module inert without a network block', async () => {
  const { config: cfg } = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], gitea: { owner: 'o' } })
  const store = tmpStore('dash-netoff-')
  const network = createNetwork({ cfg, store })
  assert.equal(network.enabled, false)
  assert.equal(network.view().enabled, false)
  assert.equal(await network.runAll(), null)
  assert.equal(network.summary(), null)
  // no table created as long as the module is not configured
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'net_%'").get().n, 0)
  const s = summary({ cfg, snap: {}, monitor: { checks: [] }, engine: { active: () => [], incidents: () => [] }, servicesView: () => [], network })
  assert.equal(s.network, null)
})

// mapParent of GET devices/:id = parent of the node in GET topology; no
// reason nor author, with or without a session; link = { id, kind, port, note } only
test('mapParent of the record = parent on the map; no reason nor author', async () => {
  const T = Date.parse('2026-10-21T10:00:00Z')
  const { store } = prodLikeStore({ T })
  const cfg = prodConfig()
  cfg.services.push({ id: 'speedtest', name: 'speedtest', host: 'g1', url: 'http://192.0.2.193/', checks: [] })
  const s = await netServer({ store, cfg, T })
  try {
    const sp = store.db.prepare("SELECT id FROM net_devices WHERE disp_name = 'speedtest'").get()
    const get = async (p, cookie) => (await fetch(s.base + p, { headers: cookie ? { cookie } : {} })).json()
    const parentOnMap = async () => (await get('/api/network/topology')).nodes.find(n => n.id === `dev:${sp.id}`)
    const d = await get(`/api/network/devices/${sp.id}`)
    const n = await parentOnMap()
    assert.deepEqual(d.mapParent, { ref: n.parent, label: 'invite-g1', ip: '192.0.2.10', origin: 'service', originService: 'speedtest' })
    assert.equal(n.origin, 'service')
    const sid = await s.login()
    const r = await s.post('/api/network/links', { child: `dev:${sp.id}`, parent: 'host:a1', kind: 'ethernet', port: '3', note: 'baie', reason: 'motif secret de test' }, { cookie: sid })
    assert.equal(r.status, 200)
    for (const cookie of [null, sid]) {
      const d2 = await get(`/api/network/devices/${sp.id}`, cookie)
      const n2 = await parentOnMap()
      assert.equal(d2.mapParent.ref, n2.parent)
      assert.deepEqual(Object.keys(d2.mapParent.link).sort(), ['id', 'kind', 'note', 'port'])
      assert.deepEqual([d2.mapParent.origin, d2.mapParent.link.kind, d2.mapParent.link.port, d2.mapParent.link.note], ['manual', 'ethernet', '3', 'baie'])
      assert.doesNotMatch(JSON.stringify(d2.mapParent), /motif secret|admin|created_by|reason/)
    }
  } finally {
    s.close()
  }
})

// --- IP handover: full sequence with the probe (real module, real engine, notifier) ------
// fixture: the speedtest record (known, 2 weak MACs, attach null, confirmed_at null) on .193;
// the old MAC answers, the original Docker MAC is silent; real-world sequence
// (sweep k, passive at +48 s where neigh sees the new one, sweep k+1 at +2 min 05), shifted
// to daytime (outside quiet hours)
const L1P = '192.0.2.193'
const SP_OLD = '62:00:00:00:53:e2'
const SP_NEW = '0a:00:00:00:53:f1'
const L1BASE = FIXTURE_HOSTS.filter(h => h.ip !== L1P)
async function l1Sequence({ T, store = null } = {}) {
  let neighNow = []
  const b = r3Bench({ T, store, neigh: () => neighNow })
  // as in production: Pi-hole no longer sees the container MACs since the day before
  freezePihole(b, { '02:42:00:00:53:e1': T - DAY, [SP_OLD]: T - DAY })
  b.cfg.services.push({ id: 'speedtest', name: 'speedtest', host: 'g1', url: `http://${L1P}/`, checks: [] })
  b.setNeigh = l => { neighNow = l }
  b.passive = async t => {
    b.clock.t = t
    b.src.setClock(t)
    await b.network.runAll()
    b.engine.evaluate({}, t)
    await b.notifier.flush(t + 60_000)
  }
  b.scanAt = async (t, hosts) => {
    b.clock.t = t
    b.probe.write(t, hosts)
    b.network.runArp()
    b.engine.evaluate({}, t)
    await b.notifier.flush(t + 60_000)
  }
  b.sp = () => b.devByMac(SP_OLD)
  b.mac = mac => b.store.db.prepare('SELECT * FROM net_macs WHERE mac = ?').get(mac)
  b.alert = key => b.engine.active().find(a => a.key === key)
  return b
}
const L1T = Date.parse('2026-10-22T09:00:00Z')

test('IP handover real sequence: passive → 0 record; sweep k+1 → pending MAC on the record, info in the digest, 0 net_new, 0 net_down, online', async () => {
  const b = await l1Sequence({ T: L1T })
  await b.run(10, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  const F = b.sp()
  b.store.db.prepare('UPDATE net_devices SET alert_down = 1 WHERE id = ?').run(F.id)
  await b.run(4, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  assert.equal(b.sp().online, 1)
  const sent = b.telegram.sent.length
  const k = b.clock.t + 2 * MIN
  await b.scanAt(k, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  b.setNeigh([{ dst: L1P, dev: 'eth0', lladdr: SP_NEW, state: ['REACHABLE'] }])
  await b.passive(k + 48_000)
  assert.equal(b.mac(SP_NEW), undefined) // rule 0: nothing on neigh alone
  await b.scanAt(k + 125_000, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  const m = b.mac(SP_NEW)
  assert.deepEqual([m.device_id, m.attach, m.confirmed_at], [F.id, 'ip', null])
  const ev = b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'mac_added' AND device_id = ?").all(F.id).map(e => e.detail)
  assert.deepEqual(ev, [`${SP_NEW}: IP handover: same IP ${L1P} (macvlan range, handover at scan)`])
  assert.equal(b.alert(`net_mac_added:${SP_NEW}`).severity, 'info')
  assert.equal(b.firing('net_new').length, 0)
  // what follows: new MAC alone, 10 min; the record stays online, without net_down nor closed session
  b.setNeigh([])
  await b.run(10, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  const after = b.sp()
  assert.deepEqual([after.online, after.last_ip, after.primary_mac], [1, L1P, F.primary_mac])
  assert.equal(b.firing('net_down').length, 0)
  assert.ok(b.sessions(F.id).at(-1).end == null)
  assert.equal(b.telegram.sent.length, sent) // info: in the digest, no immediate message
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE type = 'new' AND ts >= ?").get(k).n, 0)
  const node = b.network.topology().nodes.find(n => n.id === `dev:${F.id}`)
  assert.deepEqual([node.parent, node.origin], ['host:g1', 'service'])
})

test('IP handover: same sequence outside the ipIdentity range → normal path (record created, net_new)', async () => {
  const b = await l1Sequence({ T: L1T })
  const IP = '192.0.2.130' // Telephone-1, weak MAC, outside 192.0.2.192/27
  const OLDP = '06:00:00:00:53:d0'
  const NEWP = '0a:00:00:00:53:f5'
  const base = FIXTURE_HOSTS.filter(h => h.ip !== IP)
  await b.run(14, [...base, { mac: OLDP, ip: IP }])
  const k = b.clock.t + 2 * MIN
  await b.scanAt(k, [...base, { mac: OLDP, ip: IP }])
  b.setNeigh([{ dst: IP, dev: 'eth0', lladdr: NEWP, state: ['REACHABLE'] }])
  await b.passive(k + 48_000)
  await b.scanAt(k + 125_000, [...base, { mac: NEWP, ip: IP }])
  assert.equal(b.devByMac(NEWP).state, 'new')
  assert.notEqual(b.devByMac(NEWP).id, b.devByMac(OLDP).id)
  await b.run(12, [...base, { mac: NEWP, ip: IP }])
  assert.ok(b.firing('net_new').some(a => a.key === `net_new:${b.devByMac(NEWP).id}`))
})

test('IP handover: service restart between k and k+1 → IP handover anyway (history in kv)', async () => {
  const b = await l1Sequence({ T: L1T })
  await b.run(14, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  const k = b.clock.t + 2 * MIN
  await b.scanAt(k, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  const c = await l1Sequence({ T: k + 60_000, store: b.store }) // new module, same database
  await c.scanAt(k + 125_000, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  assert.deepEqual([c.mac(SP_NEW).device_id, c.mac(SP_NEW).attach], [b.sp().id, 'ip'])
  assert.equal(c.firing('net_new').length, 0)
})

test('IP handover: escalation (the old MAC comes back on the IP) → warning, escalate message, the IP-handover MAC no longer counts; dup → same effect; 3 clean sweeps → nothing', async () => {
  const setup = async () => {
    const b = await l1Sequence({ T: L1T })
    await b.run(14, [...L1BASE, { mac: SP_OLD, ip: L1P }])
    const k = b.clock.t + 2 * MIN
    await b.scanAt(k, [...L1BASE, { mac: SP_OLD, ip: L1P }])
    await b.scanAt(k + 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
    assert.equal(b.alert(`net_mac_added:${SP_NEW}`).severity, 'info')
    return { b, k: k + 2 * MIN }
  }
  // escalation: the old one answers again on .193 at the next sweep
  const { b, k } = await setup()
  const sent = b.telegram.sent.length
  await b.scanAt(k + 2 * MIN, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  assert.equal(b.alert(`net_mac_added:${SP_NEW}`).severity, 'warning')
  assert.equal(b.telegram.sent.length, sent + 1)
  assert.ok(JSON.parse(b.store.kv.get('network.ipHandover')).find(e => e.mac === SP_NEW).escalated)
  // the IP-handover MAC no longer counts: only the new one answers, last_present no longer follows
  await b.scanAt(k + 4 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  assert.equal(b.sp().last_present, k + 2 * MIN)
  // dup on .193 within the 3 sweeps: same effect
  const d = await setup()
  await d.b.scanAt(d.k + 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P, dup: 1 }])
  assert.equal(d.b.alert(`net_mac_added:${SP_NEW}`).severity, 'warning')
  // 3 clean sweeps: no escalation, the IP-handover MAC still counts
  const p = await setup()
  for (const i of [1, 2, 3]) await p.b.scanAt(p.k + i * 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  const e = JSON.parse(p.b.store.kv.get('network.ipHandover')).find(x => x.mac === SP_NEW)
  assert.deepEqual([e.escalated, e.watch], [false, 0])
  assert.equal(p.b.sp().last_present, p.k + 6 * MIN)
  assert.equal(p.b.alert(`net_mac_added:${SP_NEW}`).severity, 'info')
})

test('IP handover: two recreations 7 days apart without confirmation → 2 IP handover, 0 record, 0 net_new, online; 2nd within the hour → normal path', async () => {
  const b = await l1Sequence({ T: L1T })
  await b.run(14, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  const F = b.sp().id
  const devices = () => b.store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n
  const n0 = devices()
  const k = b.clock.t + 2 * MIN
  await b.scanAt(k, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  await b.scanAt(k + 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  // 2nd recreation within the hour: normal path (creation)
  const c = await l1Sequence({ T: L1T })
  await c.run(14, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  const kc = c.clock.t + 2 * MIN
  await c.scanAt(kc, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  await c.scanAt(kc + 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  await c.scanAt(kc + 4 * MIN, [...L1BASE, { mac: '0a:00:00:00:53:f2', ip: L1P }])
  assert.equal(c.devByMac('0a:00:00:00:53:f2').state, 'new')
  // 7 days later (regular sweeps simulated over the last hour): 2nd recreation
  const t7 = k + 7 * DAY
  b.clock.t = t7 - 60 * MIN
  await b.run(56, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  await b.scanAt(b.clock.t + 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
  await b.scanAt(b.clock.t + 2 * MIN, [...L1BASE, { mac: '0a:00:00:00:53:f3', ip: L1P }])
  assert.equal(b.mac('0a:00:00:00:53:f3').device_id, F)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_macs WHERE device_id = ? AND attach = ? AND confirmed_at IS NULL').get(F, 'ip').n, 2)
  assert.equal(devices(), n0)
  assert.equal(b.firing('net_new').length, 0)
  await b.run(6, [...L1BASE, { mac: '0a:00:00:00:53:f3', ip: L1P }])
  assert.equal(b.sp().online, 1)
})

// --- database written by an earlier version: French event detail, kv under its former name -----
// rewrite the IP handover of the current poll as an older version wrote it (test setup only:
// the code never rewrites a row)
function asLegacy(b) {
  const reg = b.store.kv.get('network.ipHandover')
  b.store.db.prepare('DELETE FROM kv WHERE k = ?').run('network.ipHandover')
  b.store.kv.set('network.l1', reg)
  for (const e of b.store.db.prepare("SELECT id, detail FROM net_events WHERE type = 'mac_added'").all()) {
    const m = /^(\S+): IP handover: same IP (\S+) \(macvlan range, handover at scan\)$/.exec(e.detail)
    if (m) b.store.db.prepare('UPDATE net_events SET detail = ? WHERE id = ?').run(`${m[1]} : L1 : même IP ${m[2]} (plage macvlan, passation au balayage)`, e.id)
  }
}

test('IP handover written by an earlier version (registry network.l1, French event): escalation still seen, registry then written under network.ipHandover; a 2nd recreation within the hour still takes the normal path', async () => {
  const setup = async () => {
    const b = await l1Sequence({ T: L1T })
    await b.run(14, [...L1BASE, { mac: SP_OLD, ip: L1P }])
    const k = b.clock.t + 2 * MIN
    await b.scanAt(k, [...L1BASE, { mac: SP_OLD, ip: L1P }])
    await b.scanAt(k + 2 * MIN, [...L1BASE, { mac: SP_NEW, ip: L1P }])
    asLegacy(b)
    assert.equal(b.store.kv.get('network.ipHandover') ?? null, null)
    return { b, k: k + 2 * MIN }
  }
  const { b, k } = await setup()
  const legacy = b.store.kv.get('network.l1')
  await b.scanAt(k + 2 * MIN, [...L1BASE, { mac: SP_OLD, ip: L1P }])
  assert.equal(b.alert(`net_mac_added:${SP_NEW}`).severity, 'warning')
  assert.ok(JSON.parse(b.store.kv.get('network.ipHandover')).find(e => e.mac === SP_NEW).escalated)
  assert.equal(b.store.kv.get('network.l1'), legacy, 'former row left as it is')
  // the French detail of the first handover still counts as an IP handover of the last hour
  const c = await setup()
  await c.b.scanAt(c.k + 2 * MIN, [...L1BASE, { mac: '0a:00:00:00:53:f2', ip: L1P }])
  assert.equal(c.b.devByMac('0a:00:00:00:53:f2').state, 'new')
  // display: the French detail renders like the new one
  const view = c.b.network.device(c.b.sp().id, { admin: true })
  assert.ok(view.events.some(e => e.type === 'mac_added' && e.detail === `${SP_NEW} : L1 : même IP ${L1P} (plage macvlan, passation au balayage)`), JSON.stringify(view.events))
})

// --- name hints from the last passive scan, used at the probe scan -----
// Telephone-1 (weak MAC A) switches to a new private MAC B; Pi-hole keeps the sighting of A and
// pushes it forward at every scan (stale sighting), the probe no longer sees A. DHCP lease of B: "Telephone-1"
async function phoneModule() {
  const T = Date.parse('2026-10-27T08:00:30Z')
  const b = r3Bench({ T })
  const A = '06:00:00:00:53:d0'
  const B = '5a:00:00:00:d0:16'
  const get0 = b.src.pihole.get
  b.leases = []
  b.src.pihole.get = async p => (p === '/api/dhcp/leases' ? { leases: b.leases, took: 0 } : get0(p))
  const without = FIXTURE_HOSTS.filter(h => h.mac !== A)
  await b.run(4) // probe running, A still seen
  await b.run(14, without) // A absent for the probe (> 10 min), Pi-hole still pushes it forward
  const idA = b.devByMac(A).id
  const devices = () => b.store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n
  return { b, A, B, idA, without, devices, lease: { hwaddr: B, ip: '192.0.2.150', name: 'Telephone-1', expires: 0 }, host: { mac: B, ip: '192.0.2.150' } }
}

test('sequence: DHCP lease of B at the passive scan, then B at the sweep → pending attachment to the record of A, net_mac_added warning, 0 net_new', async () => {
  const s = await phoneModule()
  assert.equal(s.b.network.view().presence, 'arp')
  const n0 = s.devices()
  s.b.leases = [s.lease]
  await s.b.step(2 * MIN, [...s.without, s.host])
  assert.equal(s.devices(), n0)
  assert.equal(s.b.devByMac(s.B).id, s.idA)
  assert.equal(s.b.store.db.prepare('SELECT attach FROM net_macs WHERE mac = ?').get(s.B).attach, 'name')
  const added = s.b.firing(`net_mac_added:${s.B}`)
  assert.equal(added.length, 1)
  assert.equal(added[0].severity, 'warning')
  assert.deepEqual(s.b.firing('net_new:'), [])
})

test('age limit: passive scan older than 2 × intervalMs, or MAC missing from the last passive scan → no hint, normal creation at the 2nd sweep', async () => {
  // passive scan with the lease, then 3 min without a passive scan (> 2 × 60 s), then the sweep
  const s = await phoneModule()
  s.b.leases = [s.lease]
  s.b.clock.t += 2 * MIN
  s.b.src.setClock(s.b.clock.t)
  await s.b.network.runAll()
  s.b.clock.t += 3 * MIN
  s.b.scan([...s.without, s.host])
  assert.equal(s.b.devByMac(s.B), undefined, 'without a name, the 1st sweep waits')
  s.b.clock.t += 2 * MIN
  s.b.scan([...s.without, s.host])
  assert.notEqual(s.b.devByMac(s.B).id, s.idA)
  assert.equal(s.b.devByMac(s.B).state, 'new')
  // lease seen at a passive scan, missing from the LAST (fresh) one: no hint
  const r = await phoneModule()
  r.b.leases = [r.lease]
  r.b.clock.t += 2 * MIN
  r.b.src.setClock(r.b.clock.t)
  await r.b.network.runAll()
  r.b.leases = []
  await r.b.step(2 * MIN, [...r.without, r.host])
  assert.equal(r.b.devByMac(r.B), undefined, 'without a name, the 1st sweep waits')
  await r.b.step(2 * MIN, [...r.without, r.host])
  assert.notEqual(r.b.devByMac(r.B).id, r.idA)
  assert.equal(r.b.devByMac(r.B).state, 'new')
})

test('lease EXPIRED at the sweep (valid at the passive scan) that carries the name → no hint, normal creation at the 2nd sweep', async () => {
  const s = await phoneModule()
  // passive scan 30 s before the sweep: lease still valid; expired 10 s before the sweep
  const scanAt = s.b.clock.t + 2 * MIN
  s.b.leases = [{ ...s.lease, expires: Math.floor((scanAt - 10_000) / 1000) }]
  await s.b.step(2 * MIN, [...s.without, s.host])
  assert.equal(s.b.clock.t, scanAt)
  assert.equal(s.b.devByMac(s.B), undefined, 'without a name, the 1st sweep waits')
  await s.b.step(2 * MIN, [...s.without, s.host])
  const d = s.b.devByMac(s.B)
  assert.notEqual(d.id, s.idA)
  assert.equal(d.state, 'new')
  // control: the same lease still active at the sweep gives the hint
})

// rotating MACs (real-world case): the sweep sees the MAC before its lease is read
test('waiting for the name: sweep before the lease → nothing at the 1st sweep, attached to its record at the next one, 0 net_new', async () => {
  const s = await phoneModule()
  const n0 = s.devices()
  await s.b.step(2 * MIN, [...s.without, s.host])
  assert.equal(s.b.devByMac(s.B), undefined)
  assert.equal(s.devices(), n0)
  s.b.leases = [s.lease]
  await s.b.step(2 * MIN, [...s.without, s.host])
  assert.equal(s.b.devByMac(s.B).id, s.idA)
  assert.equal(s.devices(), n0)
  assert.deepEqual(s.b.firing('net_new:'), [])
})

test('waiting for the name: a universal MAC does not wait; a random MAC coming back after an absence waits again', async () => {
  const s = await phoneModule()
  const STRONG = { mac: '00:00:5e:00:53:77', ip: '192.0.2.177' }
  await s.b.step(2 * MIN, [...s.without, STRONG])
  assert.equal(s.b.devByMac(STRONG.mac).state, 'new')
  // seen once, absent at the next sweep, then back: the wait starts over
  await s.b.step(2 * MIN, [...s.without, STRONG, s.host])
  assert.equal(s.b.devByMac(s.B), undefined)
  await s.b.step(2 * MIN, [...s.without, STRONG])
  await s.b.step(2 * MIN, [...s.without, STRONG, s.host])
  assert.equal(s.b.devByMac(s.B), undefined)
})

test('validated family in probe mode: next MAC attached by default, even with the old MAC present, 0 net_new', async () => {
  const T = Date.parse('2026-10-27T08:00:30Z')
  const b = r3Bench({ T })
  const A = '06:00:00:00:53:d0'
  const NEXT = { mac: '06:00:00:00:53:99', ip: '192.0.2.151' }
  const get0 = b.src.pihole.get
  b.leases = []
  b.src.pihole.get = async p => (p === '/api/dhcp/leases' ? { leases: b.leases, took: 0 } : get0(p))
  await b.run(14) // after the probe bootstrap (3 sweeps)
  const idA = b.devByMac(A).id
  b.network.writes.addRule({ prefix: '06:00:00', action: 'attach', deviceId: idA, name: 'Telephone-1', reason: 'MAC tournantes' }, { by: 'admin', source: 'ui' })
  const n0 = b.store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n
  // 1st sweep before the lease: waiting; then the lease, then the sweep: the rule applies
  await b.step(2 * MIN, [...FIXTURE_HOSTS, NEXT])
  assert.equal(b.devByMac(NEXT.mac), undefined)
  b.leases = [{ hwaddr: NEXT.mac, ip: NEXT.ip, name: 'Telephone-1', expires: 0 }]
  await b.step(2 * MIN, [...FIXTURE_HOSTS, NEXT])
  assert.equal(b.devByMac(NEXT.mac).id, idA)
  const m = b.store.db.prepare('SELECT attach, confirmed_at FROM net_macs WHERE mac = ?').get(NEXT.mac)
  assert.equal(m.attach, 'rule')
  assert.ok(m.confirmed_at != null)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n, n0)
  assert.deepEqual(b.firing('net_new:'), [])
})
