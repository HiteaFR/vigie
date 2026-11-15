// Delete: single and batch, reason, all-or-nothing refusal (record linked to a
// host, identity MAC), cascade, events kept without a record, tombstones, no id
// reused, and open alerts closed WITHOUT a message (net_down included, real engine).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetworkWrites, validateRule } from '../lib/network/writes.js'
import { createAudit } from '../lib/auth.js'
import { mergeSightings, emptyFlood, liveIdentity, IDENTITY_WINDOW_MS } from '../lib/network/merge.js'
import { createNetwork } from '../lib/network/index.js'
import { createNetStore } from '../lib/network/store.js'
import { prodLikeStore, prodConfig, prodSources, r3Bench, FIXTURE_HOSTS, GUESTS, APPLIANCES, MIN, DAY } from './network-fixture.js'
import { clientBundle } from './client-render.js'

const T = Date.parse('2026-10-21T08:00:00Z')
const who = { by: 'admin (test)', source: 'ui' }
const bench = () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T })
  const byName = n => [...ns.load().devices.values()].find(d => d.disp_name === n)
  const count = (t, where = '1') => store.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get().n
  return { cfg, store, ns, W, byName, count }
}

test('batch, reason, all-or-nothing refusal: record linked to a host or identity MAC → 409, nothing deleted', () => {
  const b = bench()
  const p = [b.byName('poste-1'), b.byName('poste-2')]
  const guest = [...b.ns.load().devices.values()].find(d => d.host_id)
  assert.throws(() => b.W.delete({ ids: [p[0].id] }, who), e => e.status === 400 && /motif obligatoire/.test(e.message))
  assert.throws(() => b.W.delete({ ids: [p[0].id], reason: 'ab' }, who), e => e.status === 400)
  assert.throws(() => b.W.delete({ ids: Array.from({ length: 201 }, (_, i) => i + 1), reason: 'trop' }, who), e => e.status === 400)
  assert.throws(() => b.W.delete({ ids: [p[0].id, 9999], reason: 'test test' }, who), e => e.status === 404)
  assert.throws(() => b.W.delete({ ids: [p[0].id, guest.id, p[1].id], reason: 'test test' }, who),
    e => e.status === 409 && /lié à l'hôte .* il serait recréé au relevé suivant/.test(e.message) && e.ids.join() === String(guest.id))
  assert.ok(b.ns.device(p[0].id) && b.ns.device(p[1].id)) // all or nothing
  // identity MAC (pve/config) on an unlinked record: refused too
  b.store.db.prepare("UPDATE net_macs SET attach = 'pve' WHERE mac = ?").run(p[1].primary_mac)
  assert.throws(() => b.W.delete({ ids: [p[1].id], reason: 'test test' }, who), e => e.status === 409 && /identité/.test(e.message))
  const r = b.W.delete({ ids: [p[0].id], reason: 'appareil donné' }, who)
  assert.deepEqual(r.deleted, [p[0].id])
  assert.equal(b.ns.device(p[0].id), null)
})

test('full cascade, events kept without a record + deleted, summarized audit, tombstones', () => {
  const b = bench()
  const d = b.byName('poste-3')
  const mac = d.primary_mac
  b.ns.applyOps([
    { op: 'upsertAddress', mac, ip: d.last_ip, ts: T, source: 'pihole' },
    { op: 'openSession', device: d.id, start: T - 60 * MIN, ip: d.last_ip },
    { op: 'rollup', device: d.id, hour: T - 3600_000, seen: 1 },
    { op: 'insertLink', device: d.id, parent: 'internet', kind: 'uplink', by: 'test', ts: T },
    { op: 'insertEvent', device: d.id, type: 'edited', ts: T, detail: 'avant', actor: 'admin' },
  ])
  b.store.db.prepare("INSERT INTO net_ports (device_id, proto, port, first_seen, last_seen) VALUES (?, 'tcp', 22, ?, ?)").run(d.id, T, T)
  b.ns.insertRule({ prefix: mac.slice(0, 8), action: 'attach', device_id: d.id, name: 'poste-3', reason: 'famille' }, { actor: 'test', ts: T })
  const events = b.count('net_events', `device_id = ${d.id}`)
  b.W.delete({ ids: [d.id], reason: 'parti pour de bon' }, who)
  for (const [t, where] of [['net_devices', `id = ${d.id}`], ['net_macs', `device_id = ${d.id}`], ['net_seen', `mac = '${mac}'`], ['net_addresses', `mac = '${mac}'`],
    ['net_attrs', `device_id = ${d.id}`], ['net_sessions', `device_id = ${d.id}`], ['net_presence_1h', `device_id = ${d.id}`], ['net_ports', `device_id = ${d.id}`],
    ['net_links', `child = 'dev:${d.id}' OR parent = 'dev:${d.id}'`], ['net_mac_rules', `device_id = ${d.id}`], ['net_events', `device_id = ${d.id}`]]) {
    assert.equal(b.count(t, where), 0, t)
  }
  assert.ok(b.count('net_events', 'device_id IS NULL') >= events + 1) // kept, without a record
  const del = b.store.db.prepare("SELECT * FROM net_events WHERE type = 'deleted'").get()
  assert.match(del.detail, new RegExp(`dev:${d.id} · poste-3 · ${mac} .* parti pour de bon`))
  const audit = b.store.db.prepare("SELECT * FROM audit WHERE action = 'network: delete'").all()
  assert.deepEqual(audit.map(a => [a.target, a.ok]), [[`dev:${d.id}`, 1]])
  assert.match(audit[0].detail, /poste-3/)
  const tomb = b.store.db.prepare('SELECT * FROM net_tombstones WHERE mac = ?').get(mac)
  assert.deepEqual([tomb.device_id, tomb.reason, tomb.deleted_by, tomb.deleted_at], [d.id, 'parti pour de bon', who.by, T])
})

test('a 2nd deletion of the same MAC: a single tombstone, at the latest date; no id reused', () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  let now = T
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => now })
  const max = Number(store.db.prepare('SELECT MAX(id) m FROM net_devices').get().m)
  const last = ns.device(max)
  const mac = last.primary_mac
  W.delete({ ids: [max], reason: 'premier départ' }, who)
  // comes back (later observation, passive mode), recreated with a NEW id
  now = T + 10 * MIN
  const m = mergeSightings({ ...ns.load(), flood: emptyFlood() }, [{ mac, ip: '192.0.2.150', source: 'pihole', ts: now, presence: true }], { cfg, now })
  ns.applyOps(m.ops)
  const back = [...ns.load().macs.values()].find(x => x.mac === mac)
  assert.equal(back.device_id, max + 1)
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM alert_state WHERE key LIKE ?").get(`%:${max + 1}`).n, 0)
  now = T + 20 * MIN
  W.delete({ ids: [max + 1], reason: 'second départ' }, who)
  assert.deepEqual(store.db.prepare('SELECT mac, deleted_at, reason, device_id FROM net_tombstones WHERE mac = ?').all(mac).map(r => ({ ...r })),
    [{ mac, deleted_at: T + 20 * MIN, reason: 'second départ', device_id: max + 1 }])
  // next creation: max + 2, never an id already used
  const id = ns.applyOps([{ op: 'insertDevice', ref: 'new:1', fields: { state: 'new', created_at: now, updated_at: now } }]).get('new:1')
  assert.equal(id, max + 2)
  assert.equal(store.kv.get('network.lastDeviceId'), String(max + 2))
})

test('open alerts then Delete: net_down, net_new and net_ip_changed resolved WITHOUT a message (real engine)', async () => {
  const b = r3Bench({ T })
  const watched = FIXTURE_HOSTS.find(h => /^00:00:5e:00:53:8/.test(h.mac)) // poste-1: normal
  const id = b.devByMac(watched.mac).id
  b.store.db.prepare('UPDATE net_devices SET alert_down = 1, expected_ip = ? WHERE id = ?').run('192.0.2.99', id)
  const intruder = { mac: '00:00:5e:00:53:e9', ip: '192.0.2.179' }
  await b.run(10) // active presence, bootstrap over
  await b.run(12, [...FIXTURE_HOSTS, intruder]) // new device → net_new; net_ip_changed (10 min)
  await b.run(14, FIXTURE_HOSTS.filter(h => h !== watched)) // absent → net_down
  const firing = b.engine.active().filter(a => a.state === 'firing').map(a => a.key).sort()
  const newId = b.devByMac(intruder.mac).id
  assert.deepEqual(firing, [`net_down:${id}`, `net_ip_changed:${id}`, `net_new:${newId}`].sort())
  const sent = b.telegram.sent.length
  const outbox = b.outbox()
  b.network.writes.delete({ ids: [id, newId], reason: 'appareils retirés' }, who)
  await b.run(30, FIXTURE_HOSTS.filter(h => h !== watched)) // 30 min of evaluations
  assert.equal(b.engine.active().filter(a => a.key.endsWith(`:${id}`) || a.key.endsWith(`:${newId}`)).length, 0)
  assert.deepEqual([b.telegram.sent.length, b.outbox()], [sent, outbox]) // no "recovered"
  assert.ok(b.store.db.prepare("SELECT COUNT(*) n FROM incidents WHERE key IN (?, ?, ?) AND resolved_at IS NOT NULL").get(`net_down:${id}`, `net_ip_changed:${id}`, `net_new:${newId}`).n === 3)
})

test('restart within 15 min after Delete: the list of removed records is reloaded (kv), alerts resolved at once, 0 message', async () => {
  const b = r3Bench({ T })
  const watched = FIXTURE_HOSTS.find(h => /^00:00:5e:00:53:8/.test(h.mac))
  const id = b.devByMac(watched.mac).id
  b.store.db.prepare('UPDATE net_devices SET alert_down = 1, expected_ip = ? WHERE id = ?').run('192.0.2.99', id)
  await b.run(10)
  await b.run(14, FIXTURE_HOSTS.filter(h => h !== watched))
  assert.deepEqual(b.engine.active().filter(a => a.state === 'firing').map(a => a.key).sort(), [`net_down:${id}`, `net_ip_changed:${id}`])
  const [sent, outbox] = [b.telegram.sent.length, b.outbox()]
  b.engine.evaluate = () => {} // process stops right after the write, before the evaluation
  b.network.writes.delete({ ids: [id], reason: 'appareil retiré' }, who)
  const kept = JSON.parse(b.store.kv.get('network.retired')).map(([k]) => k)
  assert.ok(kept.includes(`net_down:${id}`) && kept.includes(`net_ip_changed:${id}`))
  // restart 5 min later: new module, new engine, same database
  const c = r3Bench({ T: b.clock.t + 5 * MIN, store: b.store })
  assert.ok(c.network.signals(c.clock.t).some(s => s.key === `net_down:${id}` && s.cond === false && s.quietResolve === true))
  await c.run(2, FIXTURE_HOSTS.filter(h => h !== watched))
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM incidents WHERE key IN (?, ?) AND resolved_at IS NULL').get(`net_down:${id}`, `net_ip_changed:${id}`).n, 0)
  await c.run(30, FIXTURE_HOSTS.filter(h => h !== watched))
  assert.deepEqual([b.telegram.sent.length + c.telegram.sent.length, c.outbox()], [sent, outbox])
  // after 15 min, the list is cleared
  assert.deepEqual(JSON.parse(b.store.kv.get('network.retired')), [])
})

// --- powered-off identity can be deleted ------------------
// record "13": hypervisor MAC of a VM deleted from Proxmox, host removed from the config
const G16 = GUESTS[15]
const A1 = APPLIANCES[0]
const HEALTHY = { pve: { ok: true, stale: false, partial: null, lastOkAt: T } }
function idBench({ retire = ['g16'] } = {}) {
  const cfg = prodConfig()
  cfg.hosts = cfg.hosts.filter(h => !retire.includes(h.id))
  const { store, ns } = prodLikeStore({ T })
  const h = { current: HEALTHY }
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T, health: () => h.current })
  const devOf = mac => ns.load().devices.get(ns.load().macs.get(mac).device_id)
  const pveView = (mac, t) => ns.applyOps([{ op: 'upsertSeen', mac, source: 'pve', last_seen: t, last_ip: null }])
  const unlink = id => store.db.prepare('UPDATE net_devices SET host_id = NULL, host_src = NULL WHERE id = ?').run(id)
  const del = id => W.delete({ ids: [id], reason: 'VM supprimée' }, who)
  const tomb = mac => store.db.prepare('SELECT * FROM net_tombstones WHERE mac = ?').get(mac)
  return { cfg, store, ns, W, h, devOf, pveView, unlink, del, tomb }
}
const refused = (fn, re, status = 409) => assert.throws(fn, e => e.status === status && re.test(e.message))
const live = (b, mac) => liveIdentity(b.ns.load().macs.get(mac), { seen: b.ns.load().seen, cfg: b.cfg, health: b.h.current })

test('hypervisor MAC, healthy pve, seen by pve at lastOkAt − IDENTITY_WINDOW_MS − 1 min → gone, deletion succeeds, tombstone', () => {
  assert.equal(IDENTITY_WINDOW_MS, 30 * MIN)
  const b = idBench()
  const d = b.devOf(G16.mac)
  b.unlink(d.id)
  b.pveView(G16.mac, T - IDENTITY_WINDOW_MS - MIN)
  assert.equal(live(b, G16.mac), 'gone')
  assert.deepEqual(b.del(d.id).deleted, [d.id])
  assert.equal(b.tomb(G16.mac).device_id, d.id)
})

test('same MAC, seen at lastOkAt − IDENTITY_WINDOW_MS + 1 min → live, 409', () => {
  const b = idBench()
  const d = b.devOf(G16.mac)
  b.unlink(d.id)
  b.pveView(G16.mac, T - IDENTITY_WINDOW_MS + MIN)
  assert.equal(live(b, G16.mac), 'live')
  refused(() => b.del(d.id), /MAC d'identité \(Proxmox ou config\) : il serait recréé au relevé suivant/)
  assert.ok(b.ns.device(d.id))
})

test('pve in error, stale or partial, MAC not in config → unknown, 409 "cannot verify"', () => {
  const b = idBench()
  const d = b.devOf(G16.mac)
  b.unlink(d.id)
  b.pveView(G16.mac, T - 2 * DAY)
  for (const pve of [{ ok: false, stale: false, partial: null, lastOkAt: T - 5 * MIN }, { ok: true, stale: true, partial: null, lastOkAt: T - DAY },
    { ok: true, stale: false, partial: 'dev : injoignable', lastOkAt: T }, { ok: null, stale: true, partial: null, lastOkAt: null }]) {
    b.h.current = { pve }
    assert.equal(live(b, G16.mac), 'unknown', JSON.stringify(pve))
    refused(() => b.del(d.id), /source Proxmox en erreur ou périmée : impossible de vérifier ; réessayer plus tard/)
  }
  assert.ok(b.ns.device(d.id))
  b.h.current = HEALTHY
  assert.deepEqual(b.del(d.id).deleted, [d.id])
})

test('MAC in hosts[].mac of the current config (uppercase, dashes included) → live, 409, even without a pve source or with pve in error; removed, healthy pve → allowed', () => {
  const b = idBench({ retire: [] })
  const d = b.devOf(A1.mac)
  b.unlink(d.id)
  const host = b.cfg.hosts.find(h => h.id === A1.id)
  for (const mac of [A1.mac, A1.mac.toUpperCase(), A1.mac.replaceAll(':', '-'), A1.mac.toUpperCase().replaceAll(':', '-')]) {
    host.mac = mac
    assert.equal(live(b, A1.mac), 'live', mac)
    refused(() => b.del(d.id), /il serait recréé/)
  }
  // reported by the current config: 'live' even WITHOUT a pve source (null), or pve in error,
  // stale or partial (never 'unknown' nor 'gone')
  for (const pve of [null, { ok: false, stale: true, partial: null, lastOkAt: null }, { ok: true, stale: false, partial: 'dev : injoignable', lastOkAt: T }]) {
    b.h.current = { pve }
    assert.equal(live(b, A1.mac), 'live', JSON.stringify(pve))
    refused(() => b.del(d.id), /il serait recréé/)
  }
  b.h.current = HEALTHY
  b.cfg.hosts = b.cfg.hosts.filter(h => h !== host)
  const W = createNetworkWrites({ ns: b.ns, kv: b.store.kv, cfg: b.cfg, audit: createAudit(b.store), now: () => T, health: () => HEALTHY })
  assert.deepEqual(W.delete({ ids: [d.id], reason: 'boîtier retiré' }, who).deleted, [d.id])
})

test('record linked to a host still in config → 409; linked to a removed host, MAC gone → allowed', () => {
  const b = idBench()
  const kept = b.devOf(GUESTS[1].mac)
  b.pveView(GUESTS[1].mac, T - 2 * DAY)
  refused(() => b.del(kept.id), /lié à l'hôte g2 : il serait recréé au relevé suivant/)
  const gone = b.devOf(G16.mac)
  assert.equal(gone.host_id, 'g16') // still linked in the database, host removed from the config
  b.pveView(G16.mac, T - 2 * DAY)
  assert.deepEqual(b.del(gone.id).deleted, [gone.id])
})

// module bench (no probe): simulated Proxmox (ok, error, partial; VMs present or not)
function moduleBench({ cfg = (() => { const c = prodConfig(); c.hosts = c.hosts.filter(h => h.id !== 'g16'); return c })(), store = null, gone = [] } = {}) {
  const st = store ?? prodLikeStore({ T }).store
  st.kv.set('network.alertsSince', String(T - DAY))
  const clock = { t: T }
  const src = prodSources(cfg)
  const pve = { mode: 'ok', gone: new Set(gone) }
  const base = src.sources.guestNics
  src.sources.guestNics = async () => {
    if (pve.mode === 'error') return [{ id: 'prod', error: 'injoignable' }]
    const [c] = await base()
    const c1 = { ...c, guests: c.guests.filter(g => !pve.gone.has(g.vmid)) }
    return pve.mode === 'partial' ? [c1, { id: 'dev', error: 'injoignable' }] : [c1]
  }
  const network = createNetwork({ cfg, store: st, ...src, audit: createAudit(st), now: () => clock.t, log: { warn() {}, error() {}, log() {} } })
  const step = async (ms = 10 * MIN) => {
    clock.t += ms
    src.setClock(clock.t)
    await network.runAll()
  }
  const idOf = mac => st.db.prepare('SELECT device_id FROM net_macs WHERE mac = ?').get(mac)?.device_id
  return { cfg, store: st, clock, src, pve, network, step, idOf }
}
// the view (deletion) says exactly what the deletion will do
function sameAsDelete(m, id) {
  const v = m.network.device(id, { admin: true }).deletion
  let err = null
  let ok = null
  try {
    ok = m.network.writes.delete({ ids: [id], reason: 'test de cohérence' }, who)
  } catch (e) {
    err = e
  }
  assert.equal(v.allowed, !!ok, JSON.stringify(v))
  if (err) assert.ok(err.message.startsWith(v.why), `${err.message} ≠ ${v.why}`)
  else assert.equal(v.why, null)
  return v
}

test('deletion flag of the view equals the deletion result (live, unknown error and partial, host in config, gone)', async () => {
  const m = moduleBench()
  await m.step(0)
  const id = m.idOf(G16.mac)
  assert.equal(m.network.device(id).hostId, null) // link to a removed host not kept
  // still reported by Proxmox
  assert.match(sameAsDelete(m, id).why, /il serait recréé/)
  // the VM disappears from Proxmox: 40 min of healthy scans, then an error → unknown
  m.pve.gone.add(G16.vmid)
  for (let i = 0; i < 4; i++) await m.step()
  m.pve.mode = 'error'
  await m.step(5 * MIN)
  assert.match(sameAsDelete(m, id).why, /impossible de vérifier/)
  m.pve.mode = 'partial'
  await m.step(5 * MIN)
  assert.match(sameAsDelete(m, id).why, /impossible de vérifier/)
  // record linked to a host of the config
  assert.match(sameAsDelete(m, m.idOf(GUESTS[1].mac)).why, /lié à l'hôte g2/)
  // healthy scan: gone → allowed; the (static) "identity" badge stays on the MAC
  m.pve.mode = 'ok'
  await m.step(5 * MIN)
  const v = m.network.device(id, { admin: true })
  assert.deepEqual([v.deletion, v.macs[0].identity], [{ allowed: true, why: null }, true])
  assert.equal(sameAsDelete(m, id).allowed, true)
  assert.equal(m.idOf(G16.mac), undefined)
})

test('static checks unchanged on a "gone" hypervisor MAC: merge, detach (API, bot), rule, identity flag, forbidden()', async () => {
  const m = moduleBench()
  await m.step(0)
  m.pve.gone.add(G16.vmid)
  for (let i = 0; i < 4; i++) await m.step()
  const id = m.idOf(G16.mac)
  assert.equal(m.network.device(id).deletion.allowed, true)
  const st = m.store
  // a second (weak) MAC on the record, so that detaching is possible
  st.db.prepare("INSERT INTO net_macs (mac, device_id, grade, random, first_seen, last_seen, last_ip, attach) VALUES ('0a:00:00:00:13:02', ?, 'weak', 1, ?, ?, '192.0.2.25', NULL)").run(id, T, T)
  await m.step(MIN)
  const W = m.network.writes
  refused(() => W.merge({ into: m.idOf(GUESTS[1].mac), from: [id], reason: 'test test' }, who), /une MAC d'identité changerait d'hôte/, 400)
  refused(() => W.detachMac({ mac: G16.mac, reason: 'test test' }, who), /MAC d'identité \(Proxmox, config\) : jamais détachée/, 400)
  assert.equal(m.network.bot.check('d', G16.mac.replaceAll(':', '')), null)
  assert.throws(() => validateRule({ prefix: G16.mac.slice(0, 8), action: 'attach', name: 'invite-g16', deviceId: id }, createNetStore(st).load()), /couvre une MAC d'identité/)
  assert.equal(m.network.device(id).macs.find(x => x.mac === G16.mac).identity, true)
  // forbidden(): the "gone", absent record is a target neither of an attachment by IP (macvlan
  // range) nor by name
  st.db.prepare("UPDATE net_devices SET last_ip = '192.0.2.200' WHERE id = ?").run(id)
  st.db.prepare("UPDATE net_seen SET last_seen = ? WHERE mac IN (?, '0a:00:00:00:13:02')").run(T - DAY, G16.mac)
  const state = createNetStore(st).load()
  const sight = [
    { mac: '0a:00:00:00:13:03', ip: '192.0.2.200', source: 'pihole', ts: m.clock.t, presence: true },
    { mac: '0a:00:00:00:13:04', ip: '192.0.2.120', source: 'pihole', ts: m.clock.t, presence: true, name: 'invite-g16' },
  ]
  const r = mergeSightings({ ...state, flood: emptyFlood() }, sight, { cfg: m.cfg, now: m.clock.t })
  const target = mac => r.ops.find(o => o.op === 'upsertMac' && o.mac === mac)?.device
  assert.notEqual(target('0a:00:00:00:13:03'), id)
  assert.notEqual(target('0a:00:00:00:13:04'), id)
  assert.equal(r.ops.filter(o => o.op === 'insertDevice').length, 2)
})

test('return with host: deleted, host back in config, pve observation with hostId → NEW linked record, returned, net_new; probe: pve without host → nothing, return by ARP → same', async () => {
  const m = moduleBench()
  await m.step(0)
  m.pve.gone.add(G16.vmid)
  for (let i = 0; i < 4; i++) await m.step()
  const old = m.idOf(G16.mac)
  m.network.writes.delete({ ids: [old], reason: 'VM supprimée' }, who)
  // the host comes back in the config (service restart), the VM back in Proxmox too
  const back = moduleBench({ cfg: prodConfig(), store: m.store })
  back.clock.t = m.clock.t
  await back.step(5 * MIN)
  const id = back.idOf(G16.mac)
  const d = back.store.db.prepare('SELECT * FROM net_devices WHERE id = ?').get(id)
  assert.notEqual(id, old)
  assert.deepEqual([d.state, d.host_id, d.origin], ['new', 'g16', 'pve'])
  assert.equal(back.store.db.prepare('SELECT COUNT(*) n FROM net_tombstones WHERE mac = ?').get(G16.mac).n, 0)
  assert.equal(back.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE device_id = ? AND type = 'returned'").get(id).n, 1)
  // second sighting (2 min after creation): net_new raised, like an ARP return
  await back.step(3 * MIN)
  const sig = back.network.signals(back.clock.t).find(x => x.key === `net_new:${id}`)
  assert.equal(sig?.cond, true)

  // probe mode: host not in config, VM deleted then back in Proxmox (without host) → nothing;
  // ARP sees it again → new record, returned, net_new
  const s = r3Bench({ T })
  await s.run(4)
  s.cfg.hosts.splice(s.cfg.hosts.findIndex(h => h.id === 'g16'), 1)
  const base = s.src.sources.guestNics
  let hide = true
  s.src.sources.guestNics = async () => (await base()).map(c => ({ ...c, guests: c.guests.filter(g => !(hide && g.vmid === G16.vmid)) }))
  const arp = FIXTURE_HOSTS.filter(h => h.mac !== G16.mac)
  await s.run(36, arp)
  const sid = s.devByMac(G16.mac).id
  assert.equal(s.network.device(sid).deletion.allowed, true)
  s.network.writes.delete({ ids: [sid], reason: 'VM supprimée' }, who)
  hide = false
  await s.run(6, arp)
  assert.equal(s.devByMac(G16.mac), undefined)
  await s.run(6, FIXTURE_HOSTS)
  const nd = s.devByMac(G16.mac)
  assert.notEqual(nd.id, sid)
  assert.equal(nd.state, 'new')
  assert.equal(s.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE device_id = ? AND type = 'returned'").get(nd.id).n, 1)
  assert.equal(s.firing(`net_new:${nd.id}`).length, 1)
})

test('drawer (real rendering): deletable record with an "identity" MAC → "powered-off identity" line', async t => {
  const c = await clientBundle(t, 'mac-item', [
    "import { MacItem } from './src/DeviceDrawer.jsx'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement } from 'react'",
    "import { Router } from 'wouter'",
    'export const item = p => renderToStaticMarkup(createElement(Router, { ssrPath: "/" }, createElement("ul", null, createElement(MacItem, p))))',
  ])
  if (!c) return
  const m = { mac: G16.mac, grade: 'hypervisor', attach: null, identity: true, pending: false, lastIp: G16.ip }
  const LINE = 'identité éteinte : plus rapportée par Proxmox ni par la config'
  assert.ok(c.item({ d: { deletion: { allowed: true, why: null }, macs: [m] }, m, isAdmin: false }).includes(LINE))
  assert.ok(!c.item({ d: { deletion: { allowed: false, why: 'x' }, macs: [m] }, m, isAdmin: false }).includes(LINE))
  assert.ok(!c.item({ d: { deletion: { allowed: true, why: null }, macs: [m] }, m: { ...m, identity: false, grade: 'weak' }, isAdmin: false }).includes(LINE))
})

test('a single constant for the pve cadence: guestNics cache, sourceView and IDENTITY_WINDOW_MS', async () => {
  const fs = await import('node:fs')
  const { PVE_PERIOD_MS } = await import('../lib/network/sources/pve.js')
  const { THROTTLE_MS } = await import('../lib/network/merge.js')
  const src = f => fs.readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')
  assert.equal(PVE_PERIOD_MS, 10 * MIN) // value unchanged
  assert.equal(IDENTITY_WINDOW_MS, THROTTLE_MS + 2 * PVE_PERIOD_MS)
  const sources = src('sources.js')
  assert.match(sources, /import \{[^}]*\bPVE_PERIOD_MS\b[^}]*\} from '\.\/network\/sources\/pve\.js'/)
  assert.match(sources, /cached\('guestNics', PVE_PERIOD_MS,/)
  const index = src('network/index.js')
  assert.match(index, /import \{[^}]*\bPVE_PERIOD_MS\b[^}]*\} from '\.\/sources\/pve\.js'/)
  assert.match(index, /n === 'pve' \? PVE_PERIOD_MS : intervalMs/)
  assert.doesNotMatch(index, /'pve' \? 10 \* (MIN|60_000)/)
  const merge = src('network/merge.js')
  assert.match(merge, /^import \{ PVE_PERIOD_MS \} from '\.\/sources\/pve\.js'$/m)
  assert.match(merge, /^export const IDENTITY_WINDOW_MS = THROTTLE_MS \+ 2 \* PVE_PERIOD_MS$/m)
  // a single definition, in the pve source
  const defs = ['sources.js', 'network/index.js', 'network/merge.js', 'network/sources/pve.js'].filter(f => /const PVE_PERIOD_MS\s*=/.test(src(f)))
  assert.deepEqual(defs, ['network/sources/pve.js'])
})

test('a single static identity formula: isIdentityMac (merge.js); writes.js imports it, no copy elsewhere', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const LIB = new URL('../lib/', import.meta.url).pathname
  const files = (d => {
    const out = []
    const walk = x => { for (const e of fs.readdirSync(x, { withFileTypes: true })) e.isDirectory() ? walk(path.join(x, e.name)) : e.name.endsWith('.js') && out.push(path.join(x, e.name)) }
    walk(d)
    return out
  })(LIB)
  const FORMULA = /m\.grade === 'hypervisor' && !agentOnly\(/g
  const found = Object.fromEntries(files.map(f => [path.relative(LIB, f), (fs.readFileSync(f, 'utf8').match(FORMULA) || []).length]).filter(([, n]) => n))
  // merge.js: the definition; index.js: the identity flag of the view, static and out of scope (unchanged)
  assert.deepEqual(found, { 'network/index.js': 1, 'network/merge.js': 1 })
  const merge = fs.readFileSync(path.join(LIB, 'network/merge.js'), 'utf8')
  assert.match(merge, /^export const isIdentityMac = \(m, seen\) => \(m\.grade === 'hypervisor' && !agentOnly\(m, seen\)\) \|\| m\.attach === 'pve' \|\| m\.attach === 'config'$/m)
  const writes = fs.readFileSync(path.join(LIB, 'network/writes.js'), 'utf8')
  assert.match(writes, /^const isIdentity = isIdentityMac$/m)
  assert.match(writes, /^import \{[^}]*\bisIdentityMac\b[^}]*\} from '\.\/merge\.js'$/m)
})

test('without a pve source (health → { pve: null }): hypervisor MAC not in config → gone, deletion ALLOWED', () => {
  // predicate and deletion, source state provided
  const b = idBench()
  const d = b.devOf(G16.mac)
  b.unlink(d.id)
  b.h.current = { pve: null }
  assert.equal(live(b, G16.mac), 'gone')
  assert.deepEqual(b.del(d.id).deleted, [d.id])
  // real module without a pve source: health() → { pve: null }, view and deletion agree
  const cfg = prodConfig()
  cfg.hosts = cfg.hosts.filter(h => h.id !== 'g16')
  const { store } = prodLikeStore({ T })
  const network = createNetwork({ cfg, store, audit: createAudit(store), now: () => T, log: { warn() {}, error() {} } })
  const id = store.db.prepare('SELECT device_id FROM net_macs WHERE mac = ?').get(G16.mac).device_id
  assert.deepEqual(network.device(id, { admin: true }).deletion, { allowed: true, why: null })
  assert.deepEqual(network.writes.delete({ ids: [id], reason: 'VM supprimée' }, who).deleted, [id])
  // a record linked to a host still in config stays refused, even without a pve source
  const kept = store.db.prepare('SELECT device_id FROM net_macs WHERE mac = ?').get(GUESTS[1].mac).device_id
  assert.equal(network.device(kept).deletion.allowed, false)
})
