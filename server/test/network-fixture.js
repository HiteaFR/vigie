// Shared fixture for the network tests (not a test file): a database that reproduces the
// production state at a past deployment, based on COUNTS gathered during an audit
// (no real data: RFC 7042 documentation MACs, RFC 5737 IPs):
//   42 "known" records: 20 linked to a host (16 pve, 4 config, 5 of them acknowledged,
//   review = 0) and 22 unlinked, "to review" (20 origin scan, 2 import:netalertx,
//   including 5 rotating MACs "Tab-Exemple");
//   43 MACs (20 hypervisor including 4 locally administered, 12 strong, 11 weak),
//   all attach = NULL; network.baseline set, network.alertsSince missing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { createNetStore } from '../lib/network/store.js'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { createNetwork } from '../lib/network/index.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { buildDigest } from '../lib/notify/digest.js'
import { createClock } from '../lib/clock.js'
import { createAudit, createAuth, hashPassword } from '../lib/auth.js'
import express from 'express'
import { mountNetwork } from '../lib/network/routes.js'
import { errorHandler, wrap } from '../lib/http-errors.js'
import { tmpDir, tmpStore, trackStore } from './tmpdir.js'

export const MIN = 60_000
export const DAY = 86400_000

// Silent logger for the tests (single definition)
export const quiet = Object.freeze({ warn() {}, error() {}, log() {} })

// "Pure merge + real store" bench, like a module scan: state and flood carry over
// from one scan to the next (as in createNetwork). Temporary database (prefix), closed by tmpdir.
export function mergeBench(cfg, prefix = 'dash-net-') {
  const store = tmpStore(prefix)
  const ns = createNetStore(store)
  let state = ns.load()
  let flood = emptyFlood()
  return {
    cfg, ns, store,
    cycle(sightings, now, opts = {}) {
      const m = mergeSightings({ ...state, flood }, sightings, { cfg, now, ...opts })
      ns.applyOps(m.ops)
      state = ns.load()
      flood = m.flood
      return m
    },
    // direct write (simulated user input), then reload as after a scan
    apply(ops) {
      ns.applyOps(ops)
      state = ns.load()
    },
    get state() { return state },
    get flood() { return flood },
  }
}
const hex = n => n.toString(16).padStart(2, '0')

// 16 Proxmox guests (4 with a local MAC set in the guest config) and 4 non-guest
// hosts carrying hosts[].mac
export const GUESTS = Array.from({ length: 16 }, (_, i) => ({
  id: `g${i + 1}`, vmid: 100 + i, ip: `192.0.2.${10 + i}`, mac: i < 4 ? `02:00:00:00:5a:${hex(i)}` : `00:00:5e:00:53:${hex(0x10 + i)}`,
}))
export const APPLIANCES = Array.from({ length: 4 }, (_, i) => ({
  id: `a${i + 1}`, ip: `192.0.2.${40 + i}`, mac: `00:00:5e:00:53:${hex(0x40 + i)}`,
}))

export function prodConfig(network = {}) {
  const { config, errors } = parseConfig({
    version: 2, title: 't',
    proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }],
    hosts: [
      ...APPLIANCES.map(a => ({ id: a.id, name: `Appareil-${a.id}`, kind: 'appliance', ip: a.ip, mac: a.mac, env: 'prod' })),
      ...GUESTS.map(g => ({ id: g.id, name: `invite-${g.id}`, kind: 'lxc', pve: 'prod', vmid: g.vmid, ip: g.ip, env: 'prod' })),
    ],
    groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: {
      // gateway: the first device of the config (consistency anchor of the ARP probe)
      subnets: [{ cidr: '192.0.2.0/24', name: 'LAN', gateway: '192.0.2.40' }],
      sources: { pihole: { url: 'http://192.0.2.158', secretEnv: 'PH' }, neigh: {}, pve: true },
      ipIdentity: ['192.0.2.192/27'],
      ...network,
    },
  })
  if (errors) throw new Error(errors.join('\n'))
  return config
}

// unlinked records: 12 with a strong MAC, 10 with a weak MAC (including 5 rotating MACs and a macvlan with 2 MACs)
export const LOOSE = [
  ...Array.from({ length: 12 }, (_, i) => ({ macs: [`00:00:5e:00:53:${hex(0x80 + i)}`], ip: `192.0.2.${100 + i}`, name: `poste-${i + 1}` })),
  ...Array.from({ length: 5 }, (_, i) => ({ macs: [`fe:00:00:00:53:${hex(0xc0 + i)}`], ip: `192.0.2.${120 + i}`, name: 'Tab-Exemple' })),
  ...Array.from({ length: 4 }, (_, i) => ({ macs: [`06:00:00:00:53:${hex(0xd0 + i)}`], ip: `192.0.2.${130 + i}`, name: `Telephone-${i + 1}` })),
  { macs: ['02:42:00:00:53:e1', '62:00:00:00:53:e2'], ip: '192.0.2.193', name: 'speedtest' },
]

// temporary database in production state; k "new" records created earlier (before alertsSince)
export function prodLikeStore({ T, k = 0, dir } = {}) {
  const store = dir ? trackStore(openDb(dir), dir) : tmpStore('dash-prod-')
  const ns = createNetStore(store)
  const created = T - 2 * DAY
  const ops = []
  let n = 0
  const device = (fields, macs, name) => {
    const ref = `new:${++n}`
    ops.push({ op: 'insertDevice', ref, fields: { created_at: created, updated_at: created, first_seen: created - 30 * DAY, last_seen: T - MIN, disp_name: name, primary_mac: macs[0].mac, last_ip: macs[0].ip, ...fields } })
    for (const m of macs) {
      ops.push({ op: 'upsertMac', mac: m.mac, device: ref, grade: m.grade, random: parseInt(m.mac.slice(0, 2), 16) & 2 ? 1 : 0, first_seen: created - 30 * DAY, last_seen: T - MIN, last_ip: m.ip, attach: null })
      ops.push({ op: 'upsertSeen', mac: m.mac, source: 'pihole', last_seen: T - MIN, last_ip: m.ip })
    }
    ops.push({ op: 'upsertAttr', device: ref, attr: 'name', source: 'pihole', value: name, rank: 4, seen_at: T - MIN })
  }
  GUESTS.forEach((g, i) => device({ state: 'known', review: 0, origin: 'pve', host_id: g.id, host_src: 'pve', ...(i < 5 ? { acked_by: 'netalertx', acked_at: created } : {}) },
    [{ mac: g.mac, ip: g.ip, grade: 'hypervisor' }], `invite-${g.id}`))
  APPLIANCES.forEach(a => device({ state: 'known', review: 0, origin: 'config', host_id: a.id, host_src: 'config' }, [{ mac: a.mac, ip: a.ip, grade: 'hypervisor' }], `Appareil-${a.id}`))
  LOOSE.forEach((l, i) => device({ state: 'known', review: 1, origin: i < 2 ? 'import:netalertx' : 'scan' },
    l.macs.map(mac => ({ mac, ip: l.ip, grade: parseInt(mac.slice(0, 2), 16) & 2 ? 'weak' : 'strong' })), l.name))
  // k devices that appeared earlier and stayed "new" (created before alertsSince)
  for (let i = 0; i < k; i++) device({ state: 'new', review: 0, origin: 'scan' }, [{ mac: `00:00:5e:00:53:${hex(0xf0 + i)}`, ip: `192.0.2.${150 + i}`, grade: 'strong' }], `Invite-R1-${i + 1}`)
  ns.applyOps(ops)
  store.kv.set('network.baseline', new Date(created).toISOString())
  return { store, ns }
}

// simulated sources that see every MAC of the record again at each scan
export function prodSources(cfg, { extraPihole = () => [] } = {}) {
  const S = t => Math.floor(t / 1000)
  let clock = 0
  const devices = () => [
    ...APPLIANCES.map(a => ({ mac: a.mac, ip: a.ip, name: `Appareil-${a.id}` })),
    ...GUESTS.map(g => ({ mac: g.mac, ip: g.ip, name: `invite-${g.id}` })),
    ...LOOSE.flatMap(l => l.macs.map(mac => ({ mac, ip: l.ip, name: l.name }))),
    ...extraPihole(clock),
  ]
  return {
    setClock: t => { clock = t },
    pihole: {
      async get(p) {
        if (p === '/api/dhcp/leases') return { leases: [], took: 0 }
        return { devices: devices().map((d, i) => ({ id: i, hwaddr: d.mac, interface: 'eth0', firstSeen: S(clock - 40 * DAY), lastQuery: S(clock), numQueries: 1, macVendor: '', ips: [{ ip: d.ip, name: d.name, lastSeen: S(clock), nameUpdated: 0 }] })), took: 0 }
      },
    },
    exec: (cmd, args, opts, cb) => cb(null, '[]'),
    sources: {
      guestNics: async () => [{ id: 'prod', guests: GUESTS.map(g => ({ vmid: g.vmid, name: g.id, type: 'lxc', node: 'pve', status: 'running', nics: [{ key: 'net0', mac: g.mac, ip: g.ip, bridge: 'vmbr0' }] })) }],
    },
  }
}

// simulated Telegram: records everything, sends nothing
export function fakeTelegram() {
  const sent = []
  return {
    sent, configured: true, chatId: '1',
    send: async (text, opts = {}) => {
      sent.push({ text, opts })
      return { message_id: sent.length }
    },
    answerCallback: async () => {}, clearButtons: async () => {}, getUpdates: async () => [], setCommands: async () => {},
  }
}

// simulated ARP probe: temporary 0755 directory and 0644 file written
// atomically, like net-scan; write(ts, hosts) → new sweep. The dashboard rejects a
// file owned by its own uid: the tests pass arpUid (another uid) to createNetwork.
export function arpProbe() {
  const dir = tmpDir('dash-arp-')
  fs.chmodSync(dir, 0o755)
  const file = path.join(dir, 'arp.json')
  return {
    dir, file,
    write(ts, hosts = [], extra = {}) {
      // actual net-scan format: hdrmac null and dup 0 for a normal reply
      const body = { v: 1, ts, iface: 'eth0', cidr: '192.0.2.0/24', ms: 2100, ok: true, hosts: hosts.map(h => ({ hdrmac: null, dup: 0, ...h })), ...extra }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(body), { mode: 0o644 })
      fs.renameSync(`${file}.tmp`, file)
    },
    raw(text) {
      fs.writeFileSync(`${file}.tmp`, text, { mode: 0o644 })
      fs.renameSync(`${file}.tmp`, file)
    },
    remove: () => fs.rmSync(file, { force: true }),
  }
}
// uid "other than the dashboard": the test file's uid passes the origin check
export const OTHER_UID = (process.getuid?.() ?? 1000) + 1

// network.sources.arp block on an already validated config: the schema only accepts
// /run/net-scan/*.json, the test path is set afterwards
export function withArp(cfg, file, intervalSec = 120) {
  cfg.network.sources.arp = { file, intervalSec }
  cfg.network.presence = { fixedMin: 5, normalMin: 10, sleepyMin: 45, minMissedScans: 3, ...(cfg.network.presence ?? {}) }
  return cfg
}

// MAC and IP of each fixture record (demo ARP replies)
export const FIXTURE_HOSTS = [
  ...GUESTS.map(g => ({ mac: g.mac, ip: g.ip })),
  ...APPLIANCES.map(a => ({ mac: a.mac, ip: a.ip })),
  ...LOOSE.flatMap(l => l.macs.map(mac => ({ mac, ip: l.ip }))),
]

// production state at a given date: 5 records to review. There are no archived records
// anymore (the purge deletes them at startup); archived: true still sets them, through
// raw SQL (the store rejects this state), for the purge tests
function r3ProdState(store, { archived = false } = {}) {
  const db = store.db
  db.exec('UPDATE net_devices SET review = 0')
  const loose = db.prepare("SELECT id FROM net_devices WHERE host_id IS NULL ORDER BY id").all().map(r => r.id)
  if (archived) for (const id of loose.slice(0, 6)) db.prepare("UPDATE net_devices SET state = 'archived' WHERE id = ?").run(id)
  for (const id of loose.slice(6, 11)) db.prepare('UPDATE net_devices SET review = 1 WHERE id = ?').run(id)
  return { archived: archived ? loose.slice(0, 6) : [] }
}

// ARP bench: database in production state, simulated ARP probe, real engine, notifier and fake
// Telegram; scan(hosts): one sweep (file written at the bench time); step(ms, hosts):
// the clock moves forward, optional sweep, passive scan, evaluation, sending
// gateway: 'config' (overrides subnets[].gateway, 192.0.2.40) or 'route' (default route
// read from a simulated /proc/net/route: route.text, can be changed during the test)
export const routeFile = (gw = '280200C0', { iface = 'eth0', metric = 0, flags = '0003' } = {}) =>
  `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n${iface}\t00000000\t${gw}\t${flags}\t0\t0\t${metric}\t00000000\t0\t0\t0\n`
export function r3Bench({ T, store: given = null, probe = arpProbe(), neigh = () => [], prodState = true, gateway = 'config', route = { text: routeFile() }, agentReports = null } = {}) {
  const cfg = withArp(prodConfig(), probe.file)
  if (gateway === 'route') delete cfg.network.subnets[0].gateway
  const store = given ?? prodLikeStore({ T }).store
  const info = !given && prodState ? r3ProdState(store) : { archived: [] }
  if (!store.kv.get('network.alertsSince')) store.kv.set('network.alertsSince', String(T - DAY))
  const clock = { t: T }
  const src = prodSources(cfg)
  src.exec = (cmd, args, opts, cb) => cb(null, JSON.stringify(neigh(clock.t)))
  const telegram = fakeTelegram()
  const tz = createClock('Europe/Paris')
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg, store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const routeText = () => {
    if (route.text instanceof Error) throw route.text
    return route.text
  }
  const network = createNetwork({ cfg, store, ...src, audit: createAudit(store), now: () => clock.t, log: quiet, arpUid: OTHER_UID, ifaces: () => ({}), oui: null, routeText, agentReports })
  const monitor = { checks: [], result: () => null }
  const engine = createEngine({ cfg, store, rules: createRules(cfg, monitor, null, null, network), notifier, clock: tz, startedAt: T - 3600_000 })
  network.onWrite(() => engine.evaluate({}, clock.t))
  network.firing(key => engine.active().some(a => a.key === key && a.state === 'firing'))
  const outbox = () => store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n
  const b = {
    cfg, store, probe, clock, src, telegram, notifier, network, engine, info, outbox, route,
    scan: (hosts = FIXTURE_HOSTS) => {
      probe.write(clock.t, hosts)
      return network.runArp()
    },
    // passive scan 30 s before the sweep (in reality: independent timers)
    async step(ms = 2 * MIN, hosts = FIXTURE_HOSTS) {
      clock.t += ms - 30_000
      src.setClock(clock.t)
      await network.runAll()
      clock.t += 30_000
      if (hosts) probe.write(clock.t, hosts)
      network.runArp() // re-read every 30 s in reality; here once per step
      engine.evaluate({}, clock.t)
      await notifier.flush(clock.t + 60_000)
    },
    async run(minutes, hosts = FIXTURE_HOSTS) {
      for (let m = 0; m < minutes; m += 2) await b.step(2 * MIN, typeof hosts === 'function' ? hosts(clock.t) : hosts)
    },
    dev: id => store.db.prepare('SELECT * FROM net_devices WHERE id = ?').get(id),
    devByMac: mac => store.db.prepare('SELECT d.* FROM net_devices d JOIN net_macs m ON m.device_id = d.id WHERE m.mac = ?').get(mac),
    sessions: id => store.db.prepare('SELECT * FROM net_sessions WHERE device_id = ? ORDER BY start').all(id),
    firing: prefix => engine.active().filter(a => a.key.startsWith(prefix)),
    digest: mark => buildDigest({ cfg, engine, snap: {}, monitor, formatter, clock: tz, network, mark, now: clock.t }),
  }
  return b
}

// test HTTP server (network routes, admin session, Origin) on a given database;
// login() → session cookie
export async function netServer({ store, cfg = prodConfig(), T = Date.now(), network: given = null, servicesOf = () => [] }) {
  const env = { ADMIN_PASSWORD_HASH: await hashPassword('mot de passe solide'), ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }
  const audit = createAudit(store)
  const auth = createAuth({ store, audit, env })
  const network = given ?? createNetwork({ cfg, store, audit, now: () => T, log: { warn() {}, error() {} } })
  const app = express()
  app.use('/api', express.json({ limit: '8kb' }))
  app.post('/api/login', async (req, res) => {
    const r = await auth.login(req, res, req.body?.password)
    res.status(r.ok ? 200 : r.status).json(r)
  })
  const admin = (req, res, next) => auth.require(req, res, next)
  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) })
  mountNetwork(app, { network, admin, fail, servicesOf, wrap, isAdmin: req => auth.status(req).admin })
  app.all('/api/*', (req, res) => res.status(404).json({ error: 'route inconnue' }))
  // same final handler as the server, silent logger
  app.use(errorHandler({ error() {} }))
  const srv = app.listen(0)
  await new Promise(r => srv.once('listening', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const login = async () => (await post('/api/login', { password: 'mot de passe solide' })).headers.get('set-cookie').split(';')[0]
  return { srv, base, post, login, audit, network, close: () => srv.close() }
}

// production database at a past deployment: 42 records, 6 of them ARCHIVED (set by raw
// SQL: the 5 Tab-Exemple with weak MACs fe:00:00:00:53:c*, and poste-12 with a strong MAC), the
// imported link from the appliance record a4 → internet, alertsSince set; probeOn: the
// probe is already running (presenceSince from yesterday, a successful sweep 1 min ago)
export const TAB_MACS = LOOSE.filter(l => l.name === 'Tab-Exemple').flatMap(l => l.macs)
export function r4ProdStore({ T, probeOn = true, dir } = {}) {
  const { store, ns } = prodLikeStore({ T, dir })
  const db = store.db
  r3ProdState(store)
  const idOf = mac => db.prepare('SELECT device_id FROM net_macs WHERE mac = ?').get(mac).device_id
  const archived = [...TAB_MACS.map(idOf), idOf(LOOSE.find(l => l.name === 'poste-12').macs[0])]
  for (const id of archived) db.prepare("UPDATE net_devices SET state = 'archived' WHERE id = ?").run(id)
  const router = idOf(APPLIANCES[3].mac)
  db.prepare("INSERT INTO net_links (child, parent, kind, created_by, created_at) VALUES (?, 'internet', 'uplink', 'import', ?)").run(`dev:${router}`, T - 30 * DAY)
  store.kv.set('network.alertsSince', String(T - 2 * DAY))
  if (probeOn) {
    store.kv.set('network.presenceSince', String(T - DAY))
    store.kv.set('network.arpBootstrapScans', '3')
    db.prepare("INSERT INTO net_runs (ts, source, ok, n) VALUES (?, 'arp', 1, 30)").run(T - MIN)
  }
  return { store, ns, archived, router }
}

// simulated Pi-hole: MACs whose lastSeen and lastQuery are FROZEN (old entries in its table)
export function freezePihole(b, frozen) {
  const base = b.src.pihole.get
  b.src.pihole.get = async p => {
    const r = await base(p)
    if (p.startsWith('/api/network')) {
      for (const d of r.devices) {
        const f = frozen[d.hwaddr]
        if (f) Object.assign(d, { lastQuery: Math.floor(f / 1000) }, { ips: d.ips.map(i => ({ ...i, lastSeen: Math.floor(f / 1000) })) })
      }
    }
    return r
  }
}

// anonymized "prod" fixture: read-only capture of /api/network/topology
// and config.json; LAN IPs → 192.0.2.x, public IP → 198.51.100.2,
// generic device and service names, RFC 7042 MACs. BEFORE: parents served by the previous version.
export const PROD_HOSTS = [{"id": "pve", "name": "pve", "kind": "pve-node", "ip": "192.0.2.155", "env": "prod", "pve": "prod"}, {"id": "pve-b", "name": "pve-b", "kind": "pve-node", "ip": "192.0.2.168", "env": "prod", "pve": "dev"}, {"id": "nas", "name": "nas", "kind": "appliance", "ip": "192.0.2.159", "env": "prod"}, {"id": "router", "name": "router", "kind": "appliance", "ip": "192.0.2.254", "env": "prod"}, {"id": "docker-a", "name": "docker-a", "kind": "vm", "ip": "192.0.2.156", "env": "prod", "pve": "prod", "vmid": 100, "parent": "pve"}, {"id": "home-assistant", "name": "home-assistant", "kind": "vm", "ip": "192.0.2.154", "env": "prod", "pve": "prod", "vmid": 101, "parent": "pve"}, {"id": "waf", "name": "waf", "kind": "lxc", "ip": "192.0.2.157", "env": "prod", "pve": "prod", "vmid": 102, "parent": "pve"}, {"id": "vpn-gw", "name": "vpn-gw", "kind": "lxc", "ip": "192.0.2.167", "env": "prod", "pve": "prod", "vmid": 103, "parent": "pve"}, {"id": "homepage", "name": "homepage", "kind": "lxc", "ip": "192.0.2.253", "env": "prod", "pve": "prod", "vmid": 104, "parent": "pve"}, {"id": "pihole", "name": "pihole", "kind": "lxc", "ip": "192.0.2.158", "env": "prod", "pve": "prod", "vmid": 105, "parent": "pve"}, {"id": "gitea", "name": "gitea", "kind": "lxc", "ip": "192.0.2.143", "env": "prod", "pve": "prod", "vmid": 106, "parent": "pve"}, {"id": "vigie", "name": "vigie", "kind": "lxc", "ip": "192.0.2.148", "env": "prod", "pve": "prod", "vmid": 107, "parent": "pve"}, {"id": "docs-site", "name": "docs-site", "kind": "lxc", "ip": "192.0.2.149", "env": "prod", "pve": "prod", "vmid": 108, "parent": "pve"}, {"id": "compta", "name": "compta", "kind": "lxc", "ip": "192.0.2.152", "env": "prod", "pve": "prod", "vmid": 109, "parent": "pve"}, {"id": "docker-lab", "name": "docker-lab", "kind": "vm", "ip": "192.0.2.231", "env": "prod", "pve": "dev", "vmid": 101, "parent": "pve-b"}, {"id": "docker-b", "name": "docker-b", "kind": "vm", "ip": "192.0.2.144", "env": "prod", "pve": "dev", "vmid": 102, "parent": "pve-b"}, {"id": "vps-ext", "name": "vps-ext", "kind": "vm", "ip": "192.0.2.233", "env": "prod", "pve": "dev", "vmid": 103, "parent": "pve-b"}, {"id": "docker-c", "name": "docker-c", "kind": "vm", "ip": "192.0.2.145", "env": "prod", "pve": "dev", "vmid": 105, "parent": "pve-b"}, {"id": "mailpit", "name": "mailpit", "kind": "lxc", "ip": "192.0.2.146", "env": "prod", "pve": "dev", "vmid": 106, "parent": "pve-b"}, {"id": "devbox", "name": "devbox", "kind": "vm", "ip": "192.0.2.147", "env": "prod", "pve": "dev", "vmid": 107, "parent": "pve-b"}, {"id": "vps-ext-prod", "name": "vps-ext-prod", "kind": "external", "ip": "198.51.100.2", "env": "prod"}]
export const PROD_SERVICES = [{"id": "proxmox-prod", "host": "pve", "url": "https://192.0.2.155:8006/"}, {"id": "proxmox-dev", "host": "pve-b", "url": "https://192.0.2.168:8006/"}, {"id": "gitea", "host": "gitea", "url": "http://192.0.2.143:3000/"}, {"id": "docs-site", "host": "docs-site", "url": "http://192.0.2.149/"}, {"id": "portainer", "host": "docker-a", "url": "https://192.0.2.156:9443/"}, {"id": "nas", "host": "nas", "url": "https://192.0.2.159:5001/"}, {"id": "homepage", "host": "homepage", "url": "http://192.0.2.253:3000/"}, {"id": "pihole", "host": "pihole", "url": "http://192.0.2.158/"}, {"id": "waf", "host": "waf", "url": "https://waf.example.net/"}, {"id": "tailscale", "host": "vpn-gw", "url": "https://tailscale.example.net/"}, {"id": "speedtest", "host": "docker-a", "url": "http://192.0.2.193/"}, {"id": "router", "host": "router", "url": "http://192.0.2.254/"}, {"id": "home-assistant", "host": "home-assistant", "url": "http://192.0.2.154:8123/"}, {"id": "n8n", "host": "docker-a", "url": "http://192.0.2.156:5678/"}, {"id": "linkwarden", "host": "docker-a", "url": "http://192.0.2.156:20214/"}, {"id": "plex", "host": "nas", "url": "http://192.0.2.159:32400/"}, {"id": "seerr", "host": "docker-a", "url": "http://192.0.2.156:4003/"}, {"id": "sonarr", "host": "docker-a", "url": "http://192.0.2.156:4004/"}, {"id": "radarr", "host": "docker-a", "url": "http://192.0.2.156:4005/"}, {"id": "prowlarr", "host": "docker-a", "url": "http://192.0.2.156:4001/"}, {"id": "qbittorrent", "host": "docker-a", "url": "http://192.0.2.156:4000/"}, {"id": "gluetun", "host": "docker-a"}, {"id": "flaresolverr", "host": "docker-a"}, {"id": "grafana", "host": "docker-a", "url": "http://192.0.2.156:3000/"}, {"id": "prometheus", "host": "docker-a", "url": "http://192.0.2.156:3002/"}, {"id": "influxdb", "host": "docker-a", "url": "http://192.0.2.156:3001/"}, {"id": "blackbox", "host": "docker-a"}, {"id": "snmp-exporter", "host": "docker-a"}, {"id": "node-exporter", "host": "docker-a"}, {"id": "waf-metrics", "host": "waf"}, {"id": "watchtower", "host": "docker-a"}, {"id": "site-b-prod", "host": "vps-ext-prod", "url": "https://site-b-prod.example.net/"}, {"id": "site-a-prod", "host": "vps-ext-prod", "url": "https://site-a-prod.example.net/"}, {"id": "site-a-password", "host": "vps-ext-prod", "url": "https://site-a-password.example.net/"}, {"id": "compta", "host": "compta", "url": "http://192.0.2.152/"}, {"id": "site-a-local", "host": "vps-ext", "url": "https://site-a-local.example.net/"}, {"id": "site-b-local", "host": "vps-ext", "url": "https://site-b-local.example.net/"}, {"id": "appli-staging", "host": "docker-c", "url": "http://192.0.2.145:8000/"}, {"id": "web-cp", "host": "docker-lab", "url": "https://web-cp.example.net/"}, {"id": "web-api", "host": "docker-lab", "url": "https://web-api.example.net/"}, {"id": "web-docs", "host": "docker-lab", "url": "https://web-docs.example.net/"}, {"id": "web-gateway", "host": "docker-b", "url": "https://web-gateway.example.net/"}, {"id": "mailpit", "host": "mailpit", "url": "https://mailpit.example.net/"}, {"id": "devbox", "host": "devbox"}]
export const PROD_DEVICES = [[27, "192.0.2.66", "laptop", null], [29, "192.0.2.36", "other", null], [30, "192.0.2.45", "speaker", 1], [31, "192.0.2.80", "speaker", 1], [32, "192.0.2.64", "tv", null], [33, "192.0.2.100", "phone", null], [34, "192.0.2.6", "console", null], [36, "192.0.2.193", "other", 1], [37, "192.0.2.23", "iot", 1], [38, "192.0.2.25", "tv", 1], [39, "192.0.2.98", "switch", 1], [40, "192.0.2.93", "camera", 1], [41, "192.0.2.36", "camera", null]] // [id, ip, type, online]
export const PROD_BEFORE = {"host:pve": "host:router", "host:pve-b": "host:router", "host:nas": "host:router", "host:router": "internet", "host:docker-a": "host:pve", "host:home-assistant": "host:pve", "host:waf": "host:pve", "host:vpn-gw": "host:pve", "host:homepage": "host:pve", "host:pihole": "host:pve", "host:gitea": "host:pve", "host:vigie": "host:pve", "host:docs-site": "host:pve", "host:compta": "host:pve", "host:docker-lab": "host:pve-b", "host:docker-b": "host:pve-b", "host:vps-ext": "host:pve-b", "host:docker-c": "host:pve-b", "host:mailpit": "host:pve-b", "host:devbox": "host:pve-b", "host:vps-ext-prod": "host:router", "dev:27": "host:router", "dev:29": "host:router", "dev:30": "host:router", "dev:31": "host:router", "dev:32": "host:router", "dev:33": "host:router", "dev:34": "host:router", "dev:36": "host:router", "dev:37": "host:router", "dev:38": "host:router", "dev:39": "host:router", "dev:40": "host:router", "dev:41": "host:router"}
