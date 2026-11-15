// Service probe, without network. Fake connect, fake fetch, simulated clock and limiter;
// fixture of 21 hosts (RFC 5737 IPs, RFC 7042 MACs). No real connection, except
// net.connect to a NAME with a lookup that throws (no packet leaves).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../lib/config.js'
import { createNetStore } from '../lib/network/store.js'
import { createNetwork } from '../lib/network/index.js'
import { deviceLabel } from '../lib/network/merge.js'
import { createAudit } from '../lib/auth.js'
import { createClock } from '../lib/clock.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import {
  parseDefs, loadDefs, evalMotif, recognise, portOnly, stripEcho, httpPlan, tcpProbe, observeHost, createLimiter,
  probeable, plannedTargets, cfgServiceIndex, needsForce, excluded, DEFS_FILE as DEFAULT_DEFS, PROBED_KEY,
  MAX_HTTP_PER_HOST, MAX_HTTP_4XX, expectedStatuses, planCouples,
} from '../lib/network/probe.js'
import { PROD_HOSTS, PROD_SERVICES, netServer, fakeTelegram, MIN, DAY, quiet } from './network-fixture.js'
import { tmpStore, tmpDir } from './tmpdir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFS_FILE = path.join(HERE, '../lib/network/service-defs.json')
const REAL = loadDefs(DEFS_FILE)
const who = { by: 'admin (test)', source: 'ui' }
const hex = n => n.toString(16).padStart(2, '0')
// Sunday 2026-10-25, 04:30 in Paris (switch to winter time that same night: UTC+1)
const SUN = Date.parse('2026-10-25T03:30:00Z')

// --- tools -------------------------------------------------------------------------------------

// simulated world: ip → { open: [ports], unknown: [ports], http: { 'port path': { status, body, headers } } }
function fakeWorld(world = {}) {
  const calls = []
  const fetches = []
  let inflight = 0
  let peak = 0
  const hosts = new Map()
  let peakHosts = 0
  const vt = { t: 0 }
  const stamps = []
  const connect = opts => {
    const s = new EventEmitter()
    calls.push({ ip: opts.host, port: opts.port, lookup: opts.lookup })
    stamps.push(vt.t)
    inflight++
    peak = Math.max(peak, inflight)
    hosts.set(opts.host, (hosts.get(opts.host) ?? 0) + 1)
    peakHosts = Math.max(peakHosts, hosts.size)
    let done = false
    s.destroy = () => {
      if (done) return
      done = true
      inflight--
      const n = hosts.get(opts.host) - 1
      if (n) hosts.set(opts.host, n)
      else hosts.delete(opts.host)
    }
    setImmediate(() => {
      const w = world[opts.host] ?? {}
      if (w.open?.includes(opts.port)) s.emit('connect')
      else if (w.unknown?.includes(opts.port)) s.emit('error', Object.assign(new Error('injoignable'), { code: 'EHOSTUNREACH' }))
      else s.emit('error', Object.assign(new Error('refusé'), { code: 'ECONNREFUSED' }))
    })
    return s
  }
  const fetchImpl = async (url, opts) => {
    const u = new URL(url)
    fetches.push({ url, opts })
    stamps.push(vt.t)
    const h = world[u.hostname]?.http ?? {}
    const r = h[`${u.port || 80} ${u.pathname}`] ?? h['*']
    if (!r) return new Response('introuvable', { status: 404 })
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} })
  }
  // limiter on a simulated clock: waiting advances time
  const limiter = createLimiter({ now: () => vt.t, sleep: async ms => { vt.t += ms } })
  return { connect, fetchImpl, limiter, calls, fetches, stamps, vt, get peak() { return peak }, get peakHosts() { return peakHosts }, world }
}

// responses of a real Watchtower without a token (401 with no body, 404 from Go's ServeMux)
const WATCHTOWER_HTTP = { '8080 /v1/metrics': { status: 401, body: '' }, '8080 /': { status: 404, body: '404 page not found' } }

// fixture of 21 hosts (the 20 internal ones have a "Known" record, online)
function probeCfg({ probe = {}, hosts = PROD_HOSTS, services = PROD_SERVICES, subnets = [{ cidr: '192.0.2.0/24', name: 'LAN' }] } = {}) {
  const { config, errors } = parseConfig({
    version: 2, title: 't',
    proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }, { id: 'dev', label: 'PVE dev', host: 'https://192.0.2.168:8006', env: 'PVE_DEV', ca: 'pki/pve-b.pem' }],
    hosts, groups: [{ id: 'g', name: 'G' }], gitea: { owner: 'o' },
    // services without url: node-exporter keeps a tcp probe (attached by check), the others are omitted
    services: services.map(s => (s.url ? s : s.id === 'node-exporter' ? { ...s, checks: [{ type: 'tcp', target: '192.0.2.156:9100' }] } : null))
      .filter(Boolean).map(s => ({ name: s.id, group: 'g', ...s })),
    network: { subnets, sources: { pve: false }, probe: { enabled: true, exclude: ['192.0.2.157', '192.0.2.233'], ...probe } },
  })
  if (errors) throw new Error(errors.join('\n'))
  return config
}
function bench({ T = SUN, cfg = probeCfg(), world = {}, extra = [], defsFile, gate = null } = {}) {
  const store = tmpStore('dash-probe-')
  const ns = createNetStore(store)
  const ops = []
  cfg.hosts.filter(h => h.kind !== 'external').forEach((h, i) => {
    const ref = `new:${i}`
    const mac = `00:00:5e:00:53:${hex(i + 1)}`
    ops.push({ op: 'insertDevice', ref, fields: { state: 'known', review: 0, origin: 'config', host_id: h.id, host_src: 'config', disp_name: h.name, primary_mac: mac, last_ip: h.ip, online: 1, created_at: T - DAY, updated_at: T - DAY, first_seen: T - DAY, last_seen: T - MIN } })
    ops.push({ op: 'upsertMac', mac, device: ref, grade: 'hypervisor', random: 0, first_seen: T - DAY, last_seen: T - MIN, last_ip: h.ip, attach: 'config' })
  })
  extra.forEach((f, i) => {
    const ref = `x:${i}`
    const mac = `00:00:5e:00:53:${hex(0x80 + i)}`
    ops.push({ op: 'insertDevice', ref, fields: { state: 'known', review: 0, origin: 'scan', primary_mac: mac, online: 1, created_at: T - DAY, updated_at: T - DAY, first_seen: T - DAY, last_seen: T - MIN, ...f } })
    ops.push({ op: 'upsertMac', mac, device: ref, grade: 'strong', random: 0, first_seen: T - DAY, last_seen: T - MIN, last_ip: f.last_ip, attach: null })
  })
  ns.applyOps(ops)
  const w = fakeWorld(world)
  const clock = { t: T }
  const network = createNetwork({ cfg, store, audit: createAudit(store), now: () => clock.t, log: quiet,
    // gate: promise that holds back each connection (a busy queue, for run tests)
    probeOptions: { connect: w.connect, fetchImpl: w.fetchImpl, limiter: gate ? { run: async fn => { await gate; return w.limiter.run(fn) } } : w.limiter, ...(defsFile ? { defsFile } : {}) } })
  const dev = name => [...ns.load().devices.values()].find(d => d.disp_name === name)
  const ports = id => store.db.prepare('SELECT * FROM net_ports WHERE device_id = ? ORDER BY port').all(id)
  const events = (type, id) => store.db.prepare(`SELECT * FROM net_events WHERE type = ?${id ? ' AND device_id = ?' : ''} ORDER BY id`).all(...[type, id].filter(x => x != null))
  return { store, ns, network, w, clock, cfg, dev, ports, events, probe: network.probe }
}
const planned = async b => {
  b.probe.queue.push({ kind: 'planned' })
  await b.probe.pump()
}
const defsOf = defs => parseDefs(JSON.stringify({ attribution: 'test', defs }))
const one = (id, match) => ({ id, name: id, category: 'test', match })

// --- definitions ---------------------------------------------------------------------------------

test('definitions: real file valid, attribution, 32 definitions, 26 ports (default ports of each software; Watchtower on 8080), no host named', () => {
  assert.equal(REAL.ok, true, REAL.error)
  assert.match(REAL.attribution, /Scanopy \(AGPL-3\.0\)\. No code was copied\./)
  assert.equal(REAL.defs.length, 32)
  assert.deepEqual(REAL.ports, [22, 53, 80, 443, 1025, 3000, 5001, 5055, 5678, 7878, 8000, 8006, 8025, 8080, 8086, 8123, 8191, 8989, 9090, 9100, 9113, 9115, 9116, 9443, 9696, 32400])
  const text = fs.readFileSync(DEFS_FILE, 'utf8').toLowerCase()
  for (const w of ['site-a', 'site-b', 'vps-ext']) assert.ok(!text.includes(w), w)
  assert.equal(new Set(REAL.defs.map(d => d.id)).size, 32)
  // the four generic ones
  assert.deepEqual(REAL.defs.filter(d => d.category === 'generic').map(d => d.id), ['ssh', 'dns', 'http', 'https'])
})

test('the loader only reads server/lib/network/service-defs.json, with no fallback to server/data', () => {
  assert.equal(fileURLToPath(DEFAULT_DEFS), path.resolve(HERE, '../lib/network/service-defs.json'))
  const src = fs.readFileSync(path.join(HERE, '../lib/network/probe.js'), 'utf8')
  assert.doesNotMatch(src, /data\/service-defs|\.\.\/\.\.\/data/)
  assert.equal(fs.existsSync(path.join(HERE, '../data/service-defs.json')), false)
  // missing file → disabled with a message, no other location tried
  const r = loadDefs(path.join(tmpDir('dash-defs-'), 'absent.json'))
  assert.deepEqual(r, { ok: false, error: 'definitions: unreadable file' })
})

test('definitions: loading refused (regex, depth 5, 33 nodes, port 0, HTTP over TLS, unknown key, duplicate id), probe disabled', async () => {
  const nest = (n, leaf) => (n ? { allOf: [nest(n - 1, leaf)] } : leaf)
  const bad = {
    regex: [one('a', { regex: 'pi-?hole' })],
    'regex dans contains (majuscules, motif)': [one('a', { http: { port: 80, path: '/', contains: 'Pi-?Hole' } })],
    'profondeur 5': [one('a', nest(5, { port: 22 }))],
    '33 nœuds': [one('a', { allOf: Array.from({ length: 32 }, (_, i) => ({ port: i + 1 })) })],
    'port 0': [one('a', { port: 0 })],
    'HTTP sur un port TLS': [one('a', { http: { port: 443, path: '/', status: 200 } })],
    'en-tête sur un port TLS': [one('a', { header: { port: 8006, path: '/', name: 'server', contains: 'pve' } })],
    'clé inconnue': [{ ...one('a', { port: 22 }), extra: 1 }],
    'id en double': [one('a', { port: 22 }), one('a', { port: 23 })],
    'chemin invalide': [one('a', { http: { port: 80, path: 'admin', status: 200 } })],
    'status hors bornes': [one('a', { http: { port: 80, path: '/', status: 99 } })],
  }
  for (const [what, defs] of Object.entries(bad)) {
    const r = defsOf(defs)
    assert.equal(r.ok, false, what)
    assert.match(r.error, /^definitions: /, what)
  }
  assert.equal(parseDefs(JSON.stringify({ defs: [one('a', { port: 22 })] })).ok, false, 'attribution missing')
  // limits reached but not exceeded: accepted
  assert.equal(defsOf([one('a', nest(4, { port: 22 }))]).ok, true)
  assert.equal(defsOf([one('a', { allOf: Array.from({ length: 31 }, (_, i) => ({ port: i + 1 })) })]).ok, true)
  // invalid file → probe disabled, message in sources.probe, no probe possible
  const dir = tmpDir('dash-defs-')
  const file = path.join(dir, 'defs.json')
  fs.writeFileSync(file, JSON.stringify({ attribution: 't', defs: [one('a', { port: 0 })] }))
  const b = bench({ defsFile: file })
  const src = b.network.view().sources.probe
  assert.equal(src.defsOk, false)
  assert.equal(src.ok, false)
  assert.match(src.error, /definitions: /)
  assert.equal(b.probe.tick(), false)
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    const r = await s.post('/api/network/devices/probe', { id: b.dev('docker-a').id }, { cookie })
    assert.equal(r.status, 503)
  } finally {
    s.close()
  }
  await b.probe.idle()
  assert.equal(b.w.calls.length, 0)
})

// --- evaluator ---------------------------------------------------------------------------------

const ctxOf = (defs, { open = [], http = {}, vendor = null } = {}) => ({
  open: new Set(open), resp: (p, pa) => http[`${p} ${pa}`] ?? null, vendor, portOwners: defs.portOwners,
})

test('evaluator: each pattern, mdns always false, confidence, allOf, anyOf, not', () => {
  const D = defsOf([
    one('seul', { port: 7000 }), // unique port → medium
    one('pa', { port: 7001 }), one('pb', { port: 7001 }), // shared port → low
    one('web', { http: { port: 7002, path: '/x', contains: 'ok', status: 200 } }),
    one('hdr', { header: { port: 7003, path: '/', name: 'server', contains: 'caddy' } }),
    one('mac', { allOf: [{ port: 7004 }, { macVendor: 'synology' }] }),
    one('m', { mdns: '_http._tcp' }),
    one('trois', { allOf: [{ port: 7001 }, { port: 7005 }, { port: 7006 }] }),
    one('ou', { anyOf: [{ port: 7001 }, { http: { port: 7007, path: '/', status: 200 } }] }),
    one('non', { allOf: [{ port: 7008 }, { not: { port: 7009 } }] }),
  ])
  assert.equal(D.ok, true, D.error)
  const ev = (id, o) => evalMotif(D.defs.find(d => d.id === id).match, ctxOf(D, o))
  assert.deepEqual([ev('seul', { open: [7000] }).ok, ev('seul', { open: [7000] }).rank], [true, 1])
  assert.equal(ev('seul', {}).ok, false)
  assert.equal(ev('pa', { open: [7001] }).rank, 0)
  // http: status AND substring
  assert.equal(ev('web', { open: [7002], http: { '7002 /x': { status: 200, body: 'tout est ok' } } }).rank, 2)
  assert.equal(ev('web', { open: [7002], http: { '7002 /x': { status: 500, body: 'ok' } } }).ok, false)
  assert.equal(ev('web', { open: [7002], http: { '7002 /x': { status: 200, body: 'ko' } } }).ok, false)
  assert.equal(ev('web', { open: [], http: { '7002 /x': { status: 200, body: 'ok' } } }).ok, false, 'closed port: no HTTP evidence')
  assert.equal(ev('hdr', { open: [7003], http: { '7003 /': { status: 200, body: '', headers: { server: 'caddy/2' } } } }).rank, 2)
  assert.equal(ev('hdr', { open: [7003], http: { '7003 /': { status: 200, body: 'caddy', headers: {} } } }).ok, false)
  // macVendor: separate evidence, with no confidence of its own
  assert.deepEqual([ev('mac', { open: [7004], vendor: 'Synology Inc.' }).ok, ev('mac', { open: [7004], vendor: 'Synology Inc.' }).rank], [true, 2])
  assert.equal(ev('mac', { open: [7004], vendor: 'Acme' }).ok, false)
  assert.equal(ev('m', { open: [7000] }).ok, false) // mdns: reserved, always false
  // allOf: low + 2 more pieces of evidence → high; anyOf: the best one; not: nothing more
  assert.equal(ev('trois', { open: [7001, 7005, 7006] }).rank, 2)
  assert.equal(ev('trois', { open: [7001, 7005] }).ok, false)
  assert.equal(ev('ou', { open: [7001] }).rank, 0)
  assert.equal(ev('ou', { open: [7001, 7007], http: { '7007 /': { status: 200, body: '' } } }).rank, 2)
  assert.equal(ev('non', { open: [7008] }).rank, 1)
  assert.equal(ev('non', { open: [7008, 7009] }).ok, false)
  // real definitions: prometheus, grafana, n8n, sonarr, radarr, prowlarr at high
  const http = {
    '9090 /-/healthy': { status: 200, body: 'Prometheus Server is Healthy.' }, '3000 /api/health': { status: 200, body: '{"database":"ok"}' },
    '5678 /healthz': { status: 200, body: '{"status":"ok"}' }, '8989 /ping': { status: 200, body: '{}' }, '7878 /ping': { status: 200, body: '{}' }, '9696 /ping': { status: 200, body: '{}' },
  }
  const found = recognise(REAL, ctxOf(REAL, { open: [9090, 3000, 5678, 8989, 7878, 9696, 22, 9100], http }))
  for (const [p, id] of [[9090, 'prometheus'], [3000, 'grafana'], [5678, 'n8n'], [8989, 'sonarr'], [7878, 'radarr'], [9696, 'prowlarr']]) {
    assert.deepEqual(found.get(p), { service: id, confidence: 'high' }, id)
  }
  assert.deepEqual(found.get(9100), { service: 'node-exporter', confidence: 'low' })
  // ssh alone → low (category generic); node-exporter, recognized by its port alone → low
  assert.deepEqual(found.get(22), { service: 'ssh', confidence: 'low' })
  for (const [p, id] of [[22, 'ssh'], [53, 'dns'], [80, 'http'], [443, 'https']]) assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [p] })).get(p), { service: id, confidence: 'low' })
  assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [9100] })).get(9100), { service: 'node-exporter', confidence: 'low' })
  // macVendor alone has no effect (no port attributed), nor without port 5001; p, port alone → low
  const mv = defsOf([one('m', { macVendor: 'synology' }), one('p', { port: 7100 })])
  assert.deepEqual([...recognise(mv, ctxOf(mv, { open: [7100], vendor: 'Synology' }))], [[7100, { service: 'p', confidence: 'low' }]])
  assert.equal(recognise(REAL, ctxOf(REAL, { open: [22], vendor: 'Synology' })).get(5001), undefined)
  assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [5001], vendor: 'Acme' })).get(5001), undefined)
})

test('evaluator: arbitration of port 3000 (gitea, homepage, grafana), synology, bunkerweb', () => {
  const at = http => recognise(REAL, ctxOf(REAL, { open: [3000], http })).get(3000)
  assert.equal(at({ '3000 /': { status: 200, body: '<title>Homepage</title>' } }).service, 'homepage')
  assert.equal(at({ '3000 /api/health': { status: 200, body: '{"database":"ok"}' } }).service, 'grafana')
  assert.equal(at({ '3000 /api/healthz': { status: 200, body: '{"status":"pass"}' } }).service, 'gitea')
  // two pieces of evidence: same confidence → the first in file order (gitea)
  assert.equal(at({ '3000 /api/healthz': { status: 200, body: 'pass' }, '3000 /': { status: 200, body: 'homepage' } }).service, 'gitea')
  // open port without HTTP evidence: not attributed
  assert.equal(at({}), undefined)
  const syn = recognise(REAL, ctxOf(REAL, { open: [5001], vendor: 'Synology Incorporated' })).get(5001)
  assert.deepEqual(syn, { service: 'synology-dsm', confidence: 'high' })
  const bw = recognise(REAL, ctxOf(REAL, { open: [80, 443, 9113] }))
  assert.deepEqual([bw.get(80), bw.get(443), bw.get(9113)], Array(3).fill({ service: 'bunkerweb', confidence: 'high' }))
  assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [9113] })).get(9113), { service: 'bunkerweb-metrics', confidence: 'low' })
  assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [443] })).get(443), { service: 'https', confidence: 'low' })
  // speedtest-tracker: the 200 of a catch-all page (Synology DSM on port 80) is not enough
  const st = body => recognise(REAL, ctxOf(REAL, { open: [80], http: { '80 /api/healthcheck': { status: 200, body } } })).get(80)?.service
  assert.equal(st('{"message":"speedtest tracker is running!"}'), 'speedtest-tracker')
  assert.notEqual(st('<!doctype html><html><body><input type="hidden" id="http" value="5000"></body></html>'), 'speedtest-tracker')
})

test('path echo: a body that copies /admin/ does not validate pi-hole; no removal for / or the empty path', () => {
  const D = defsOf([one('ph', { http: { port: 80, path: '/pi-hole/', contains: 'pi-hole' } })])
  const ev = body => evalMotif(D.defs[0].match, ctxOf(D, { open: [80], http: { '80 /pi-hole/': { status: 404, body } } })).ok
  assert.equal(ev('Cannot GET /Pi-hole/'), false, 'the substring is only in the echo')
  assert.equal(ev('not found: /pi-hole/ (pi-hole absent ?)'), true)
  const ph = REAL.defs.find(d => d.id === 'pihole')
  const ok = body => evalMotif(ph.match, ctxOf(REAL, { open: [53, 80], http: { '80 /admin/': { status: 404, body } } })).ok
  assert.equal(ok('404 : /admin/ introuvable'), false)
  assert.equal(ok('<title>Pi-hole</title>'), true)
  assert.equal(stripEcho('A / B', '/'), 'a / b')
  assert.equal(stripEcho('A / B', ''), 'a / b')
  assert.equal(stripEcho('x /Admin/ y /admin/', '/admin/'), 'x   y  ')
})

test('requests: (port, path) requested once per host and per run, 24 at most', async () => {
  const plan = httpPlan(REAL, new Set([80, 3000]))
  assert.deepEqual(plan.map(r => `${r.port} ${r.path}`).sort(), ['3000 /', '3000 /api/health', '3000 /api/healthz', '80 /', '80 /admin/', '80 /api/healthcheck'])
  const many = defsOf(Array.from({ length: 30 }, (_, i) => one(`d${i}`, { allOf: [{ port: 80 }, { http: { port: 80, path: `/p${i}`, status: 200 } }] })))
  assert.equal(httpPlan(many, new Set([80])).length, 24)
  // two definitions on the same (port, path): a single GET
  const twice = defsOf([one('a', { http: { port: 80, path: '/', contains: 'aaa' } }), one('b', { http: { port: 80, path: '/', contains: 'bbb' } })])
  const w = fakeWorld({ '192.0.2.9': { open: [80], http: { '80 /': { body: 'aaa bbb' } } } })
  const obs = await observeHost('192.0.2.9', { defs: twice, connect: w.connect, fetchImpl: w.fetchImpl, limiter: w.limiter })
  assert.equal(w.fetches.length, 1)
  assert.deepEqual([...recognise(twice, { open: obs.open, resp: obs.resp, portOwners: twice.portOwners })], [[80, { service: 'a', confidence: 'high' }]])
  // server answering 200 → as many requests as distinct paths, never more than 24
  const w2 = fakeWorld({ '192.0.2.9': { open: [80], http: { '*': { status: 200, body: '' } } } })
  const o2 = await observeHost('192.0.2.9', { defs: many, connect: w2.connect, fetchImpl: w2.fetchImpl, limiter: w2.limiter })
  assert.equal(w2.fetches.length, 24)
  assert.equal(o2.requests, 24)
  const all = Object.fromEntries(REAL.ports.map(p => [p, p]))
  const w3 = fakeWorld({ '192.0.2.9': { open: REAL.ports, http: { '*': { status: 200, body: '' } } } })
  await observeHost('192.0.2.9', { defs: REAL, connect: w3.connect, fetchImpl: w3.fetchImpl, limiter: w3.limiter })
  const distinct = httpPlan(REAL, new Set(Object.values(all))).length
  // 22 paths + the 2 of Watchtower = 24; a local definition removed from the catalog (8000 /health)
  // → 23; Watchtower on 8080 shares "8080 /" with qBittorrent → 22, under MAX_HTTP_PER_HOST (margin 2)
  assert.equal(distinct, 22)
  assert.ok(distinct <= MAX_HTTP_PER_HOST)
  assert.ok(['8080 /v1/metrics', '8080 /'].every(k => httpPlan(REAL, new Set(REAL.ports)).some(r => `${r.port} ${r.path}` === k)))
  // NON-truncated count of the pairs of the real file; margin = 2 today (22 of 24)
  assert.ok(planCouples(REAL).length <= MAX_HTTP_PER_HOST, `cap of HTTP requests per host reached (${planCouples(REAL).length} pairs > ${MAX_HTTP_PER_HOST}): raise MAX_HTTP_PER_HOST or merge evidence`)
  assert.equal(planCouples(REAL).length, 22)
  assert.deepEqual(httpPlan(REAL, new Set(REAL.ports)), planCouples(REAL, new Set(REAL.ports)).slice(0, MAX_HTTP_PER_HOST))
  assert.equal(planCouples(many).length, 30) // the synthetic plan of 30 pairs is not truncated here

  assert.equal(w3.fetches.length, distinct)
  assert.equal(new Set(w3.fetches.map(f => f.url)).size, distinct)
  // 404 everywhere → EXACTLY 3 requests, the ports are all still tested over TCP
  const w4 = fakeWorld({ '192.0.2.9': { open: REAL.ports } })
  const o4 = await observeHost('192.0.2.9', { defs: REAL, connect: w4.connect, fetchImpl: w4.fetchImpl, limiter: w4.limiter })
  assert.equal(w4.fetches.length, 3)
  assert.deepEqual([o4.requests, o4.c4xx], [3, 3])
  assert.equal(w4.calls.length, 26) // the 26 ports of the definitions
  // only a 4xx counts: 3xx, 5xx and errors stop nothing
  const w5 = fakeWorld({ '192.0.2.9': { open: REAL.ports, http: { '*': { status: 503 } } } })
  await observeHost('192.0.2.9', { defs: REAL, connect: w5.connect, fetchImpl: w5.fetchImpl, limiter: w5.limiter })
  assert.equal(w5.fetches.length, distinct)
  // order: the paths that must answer 200 first
  const order = httpPlan(REAL, new Set(REAL.ports))
  const wants200 = new Set()
  const walk = m => {
    const [k] = Object.keys(m)
    if (k === 'http' && m.http.status === 200) wants200.add(`${m.http.port} ${m.http.path}`)
    else if (k === 'anyOf' || k === 'allOf') m[k].forEach(walk)
    else if (k === 'not') walk(m.not)
  }
  REAL.defs.forEach(d => walk(d.match))
  const firstContains = order.findIndex(r => !wants200.has(`${r.port} ${r.path}`))
  assert.ok(firstContains > 0)
  assert.ok(order.slice(firstContains).every(r => !wants200.has(`${r.port} ${r.path}`)))
  // probed records the counters, without content
  const b = bench({ world: { '192.0.2.156': { open: [80, 3000, 5678] } } })
  await b.probe.probeDevice(b.dev('docker-a'), 'admin')
  assert.match(b.events('probed', b.dev('docker-a').id)[0].detail, /^admin · 3 open ports · HTTP: 3 requests, 3 4xx · \d+ ms$/)
})

// --- prober ----------------------------------------------------------------------------------------

test('prober: open, refused, unknown; nothing is sent; lookup that throws (no DNS)', async () => {
  const w = fakeWorld({ '192.0.2.9': { open: [22], unknown: [80] } })
  assert.equal(await tcpProbe(w.connect, '192.0.2.9', 22), 'open')
  assert.equal(await tcpProbe(w.connect, '192.0.2.9', 23), 'refused')
  assert.equal(await tcpProbe(w.connect, '192.0.2.9', 80), 'unknown')
  // timeout exceeded → unknown
  const silent = () => Object.assign(new EventEmitter(), { destroy() {} })
  assert.equal(await tcpProbe(silent, '192.0.2.9', 22, 30), 'unknown')
  // forced lookup: it throws, whatever the name
  const { lookup } = w.calls[0]
  await new Promise(r => lookup('exemple.invalid', {}, e => {
    assert.match(e.message, /DNS interdit/)
    r()
  }))
  // real net.connect to a NAME: our lookup is called and throws, no resolution
  assert.equal(await tcpProbe(net.connect, 'exemple.invalid', 80), 'unknown')
})

test('closed after TWO consecutive refusals only; unknown closes nothing; offline: skipped', async () => {
  const b = bench({ world: { '192.0.2.156': { open: [22, 8080] } } })
  const id = b.dev('docker-a').id
  await planned(b)
  assert.deepEqual(b.ports(id).map(p => [p.port, p.closed_at]), [[22, null], [8080, null]])
  // 1st refusal: nothing closed
  b.w.world['192.0.2.156'] = { open: [8080] }
  b.clock.t += DAY
  await planned(b)
  assert.equal(b.ports(id)[0].closed_at, null)
  // open again: the streak is broken
  b.w.world['192.0.2.156'] = { open: [22, 8080] }
  await planned(b)
  b.w.world['192.0.2.156'] = { open: [8080] }
  await planned(b)
  assert.equal(b.ports(id)[0].closed_at, null)
  // unknown between two refusals: breaks it too
  b.w.world['192.0.2.156'] = { open: [8080], unknown: [22] }
  await planned(b)
  b.w.world['192.0.2.156'] = { open: [8080] }
  await planned(b)
  assert.equal(b.ports(id)[0].closed_at, null)
  // second consecutive refusal: closed
  await planned(b)
  assert.equal(b.ports(id)[0].closed_at, b.clock.t)
  assert.deepEqual(b.events('port_closed', id).map(e => e.detail), ['tcp/22 (ssh)'])
  // offline: skipped, nothing closed, no run
  b.store.db.prepare('UPDATE net_devices SET online = 0 WHERE id = ?').run(id)
  b.w.world['192.0.2.156'] = {}
  const n = b.events('probed', id).length
  const before = b.w.calls.length
  await planned(b)
  await planned(b)
  assert.equal(b.ports(id)[1].closed_at, null)
  assert.equal(b.events('probed', id).length, n)
  assert.equal(b.w.calls.filter((c, i) => i >= before && c.ip === '192.0.2.156').length, 0)
})

test('addresses: network, broadcast, multicast, outside subnet and names refused', () => {
  const cfg = probeCfg()
  assert.equal(probeable('192.0.2.10', cfg), true)
  for (const ip of ['192.0.2.0', '192.0.2.255', '224.0.0.251', '239.255.255.250', '198.51.100.5', 'nas.local', '', null, '192.0.2.300']) assert.equal(probeable(ip, cfg), false, String(ip))
  // multicast refused even within a declared subnet
  assert.equal(probeable('224.0.0.5', { network: { subnets: [{ cidr: '224.0.0.0/24' }] } }), false)
  assert.equal(probeable('198.51.100.1', { network: { subnets: [{ cidr: '198.51.100.0/31' }] } }), true, '/31: no broadcast')
})

// --- rate ----------------------------------------------------------------------------------------

test('rate: ≤ 8 in flight, ≤ 50 connections per second (HTTP included), one host at a time, own limiter', async () => {
  const world = {}
  for (const h of PROD_HOSTS) world[h.ip] = { open: [22, 80, 3000], http: { '80 /': { body: 'bbox' }, '3000 /': { body: 'homepage' } } }
  const b = bench({ world })
  await planned(b)
  const targets = 18 // 20 internal records − 2 excluded
  assert.equal(new Set(b.w.calls.map(c => c.ip)).size, targets)
  assert.equal(b.w.calls.length, targets * 26)
  assert.ok(b.w.fetches.length >= targets * 3)
  assert.ok(b.w.peak <= 8 && b.w.peak >= 2, `peak ${b.w.peak}`)
  assert.equal(b.w.peakHosts, 1)
  const st = b.w.stamps
  for (let i = 0; i < st.length; i++) {
    const inWin = st.filter(x => x >= st[i] && x < st[i] + 1000).length
    assert.ok(inWin <= 50, `window ${st[i]}: ${inWin}`)
  }
  // the run took time (simulated clock): ≥ 600 connections at 50/s
  assert.ok(b.w.vt.t >= 10_000)
  // limiter separate from the one in monitor.js: no import, independent instances
  const src = fs.readFileSync(path.join(HERE, '../lib/network/probe.js'), 'utf8')
  assert.doesNotMatch(src, /monitor\.js|limited\(/)
  const l1 = createLimiter()
  const l2 = createLimiter()
  let release
  const hold = Array.from({ length: 8 }, () => l1.run(() => new Promise(r => { release ??= []; release.push(r) })))
  await new Promise(r => setImmediate(r))
  assert.equal(await l2.run(async () => 'libre'), 'libre')
  release.forEach(r => r())
  await Promise.all(hold)
})

// --- targets, exclusion, scheduling ----------------------------------------------------------------

test('targets: from cfg.hosts at each run; exclusions; host added or removed without error', async () => {
  const b = bench({ extra: [{ last_ip: '192.0.2.120', disp_name: 'libre' }] })
  const st = () => b.ns.load()
  const ids = () => plannedTargets(st().devices, b.cfg, { attrs: st().attrs }).map(d => d.host_id).sort()
  const all = PROD_HOSTS.filter(h => h.kind !== 'external' && !['waf', 'vps-ext'].includes(h.id)).map(h => h.id).sort()
  assert.deepEqual(ids(), all) // record without host and external host: never
  const set = (id, sql) => b.store.db.prepare(`UPDATE net_devices SET ${sql} WHERE host_id = ?`).run(id)
  set('nas', "profile = 'sleepy'")
  set('router', "type = 'iot'") // type entered
  set('pve', "type = 'camera'")
  set('gitea', 'online = 0')
  set('devbox', "last_ip = '198.51.100.9'")
  set('mailpit', "state = 'new'")
  const cut = ['nas', 'router', 'pve', 'gitea', 'devbox', 'mailpit']
  // displayed (inferred) type iot or camera, inferred standby profile: also out of the targets
  assert.equal(needsForce({ disp_type: 'camera' }), true)
  assert.equal(needsForce({ disp_type: 'iot', type: null }), true)
  assert.equal(needsForce({}, [{ attr: 'profile', value: 'sleepy', rank: 1, seen_at: 0 }]), true)
  assert.equal(needsForce({ host_id: 'x' }, [{ attr: 'profile', value: 'sleepy', rank: 1, seen_at: 0 }]), false, 'config host: fixed')
  assert.deepEqual(ids(), all.filter(x => !cut.includes(x)))
  // exclusion by host id, and by IP
  b.cfg.network.probe.exclude.push('docker-lab', '192.0.2.144')
  assert.ok(!ids().includes('docker-lab') && !ids().includes('docker-b'))
  // host removed from the config: no longer a target; host added without a record: no error
  b.cfg.hosts = b.cfg.hosts.filter(h => h.id !== 'docs-site').concat([{ id: 'neuf', name: 'neuf', kind: 'vm', ip: '192.0.2.99', env: 'prod' }])
  assert.ok(!ids().includes('docs-site'))
  await b.network.runAll() // refresh: the module state is reloaded
  await planned(b)
  const probed = new Set(b.w.calls.map(c => c.ip))
  for (const h of ['192.0.2.159', '192.0.2.254', '192.0.2.155', '192.0.2.143', '192.0.2.147', '198.51.100.9', '192.0.2.146', '192.0.2.231', '192.0.2.144', '192.0.2.149', '192.0.2.99', '192.0.2.120', '198.51.100.2']) {
    assert.ok(!probed.has(h), h)
  }
})

// config.example.json: probe off, no exclusion (production enables its own in config.json)
test('config.example.json: probe off, no exclusion; unknown exclusion → warning; unknown key refused', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/config.reference.json'), 'utf8'))
  const { config, errors } = parseConfig(raw)
  assert.ok(!errors, errors?.join('\n'))
  assert.deepEqual(raw.network.probe, { enabled: false, exclude: [] })
  assert.equal(config.network.probe.enabled, false)
  // an exclusion that is neither an IPv4 nor a host: warning, the config stays valid
  const bad = structuredClone(raw)
  bad.network.probe.exclude.push('inconnu')
  const warned = parseConfig(bad)
  assert.ok(!warned.errors)
  assert.match(warned.warnings.join('\n'), /network\.probe\.exclude: "inconnu"/)
  bad.network.probe = { enabled: false, exclude: [], force: true }
  assert.ok(parseConfig(bad).errors)
})

test('absolute exclusion: never probed, neither scheduled nor on demand with or without force (409, no connection)', async () => {
  const world = Object.fromEntries(PROD_HOSTS.map(h => [h.ip, { open: [22, 443, 80] }]))
  const b = bench({ world })
  await planned(b)
  assert.ok(b.w.calls.length > 0)
  assert.ok(!b.w.calls.some(c => ['192.0.2.157', '192.0.2.233'].includes(c.ip)))
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    const n = b.w.calls.length
    for (const name of ['waf', 'vps-ext']) {
      for (const body of [{}, { force: true, reason: 'je force' }]) {
        const r = await s.post('/api/network/devices/probe', { id: b.dev(name).id, ...body }, { cookie })
        assert.equal(r.status, 409, name)
        assert.match((await r.json()).error, /exclue \(network\.probe\.exclude\)/)
      }
    }
    await b.probe.idle()
    // several event loop turns, not a fixed delay
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
    assert.equal(b.w.calls.length, n)
    // exclusion by host id: same refusal
    b.cfg.network.probe.exclude.push('pihole')
    const r = await s.post('/api/network/devices/probe', { id: b.dev('pihole').id, force: true, reason: 'je force' }, { cookie })
    assert.equal(r.status, 409)
    // and the scheduled probe no longer touches it
    b.clock.t += 7 * DAY
    await planned(b)
    assert.ok(!b.w.calls.slice(n).some(c => ['192.0.2.157', '192.0.2.233', '192.0.2.158'].includes(c.ip)))
  } finally {
    s.close()
  }
})

test('"Probe all" (admin): full run outside Sunday, same targets, exclusions honored; 401, 409, 429', async () => {
  const world = Object.fromEntries(PROD_HOSTS.map(h => [h.ip, { open: [22] }]))
  const b = bench({ world })
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    assert.equal((await s.post('/api/network/probe/all', {})).status, 401)
    const cookie = await s.login()
    const A = body => s.post('/api/network/probe/all', body, { cookie })
    assert.equal((await A({ ip: '192.0.2.1' })).status, 400, 'neither IP nor target')
    const st = b.ns.load()
    const want = plannedTargets(st.devices, b.cfg, { attrs: st.attrs }).map(d => d.last_ip).sort()
    const r = await A({ reason: 'après mise en service' })
    assert.equal(r.status, 202)
    assert.deepEqual(await r.json(), { queued: true, targets: want.length })
    assert.equal((await A({})).status, 409, 'already running')
    await b.probe.idle()
    assert.deepEqual([...new Set(b.w.calls.map(c => c.ip))].sort(), want)
    assert.ok(!b.w.calls.some(c => ['192.0.2.157', '192.0.2.233'].includes(c.ip)), 'exclusions')
    assert.match(b.events('probed', b.dev('gitea').id)[0].detail, /^admin · /)
    // once per hour
    const again = await A({})
    assert.equal(again.status, 429)
    assert.ok(Number(again.headers.get('retry-after')) > 0 && Number(again.headers.get('retry-after')) <= 3600)
    b.clock.t += 60 * 60_000
    assert.equal((await A({})).status, 202)
    await b.probe.idle()
    // probe disabled: 409
    b.cfg.network.probe.enabled = false
    b.clock.t += 60 * 60_000
    assert.equal((await A({})).status, 409)
  } finally {
    s.close()
  }
})

test('scheduling: Sunday 04:00 in Paris, once a week, DST changes included; enabled false → nothing', async () => {
  const b = bench()
  const at = iso => {
    b.clock.t = Date.parse(iso)
    return b.probe.tick()
  }
  // 2026-10-25: winter time since 03:00 (04:00 Paris = 03:00 UTC)
  assert.equal(at('2026-10-25T02:59:00Z'), false) // 03:59 Paris
  assert.equal(at('2026-10-25T03:00:00Z'), true) // 04:00 Paris
  await b.probe.idle()
  assert.equal(at('2026-10-25T03:30:00Z'), false, 'only once')
  assert.equal(at('2026-10-31T03:00:00Z'), false, 'Saturday')
  assert.equal(b.probe.nextRun(Date.parse('2026-10-26T12:00:00Z')), Date.parse('2026-11-01T03:00:00Z'))
  assert.equal(at('2026-11-01T03:00:00Z'), true)
  await b.probe.idle()
  assert.equal(at('2026-11-01T04:00:00Z'), false, '05:00 Paris: outside the window')
  // 2026-03-29: summer time (04:00 Paris = 02:00 UTC)
  const c = bench({ T: Date.parse('2026-03-28T12:00:00Z') })
  assert.equal(c.probe.nextRun(), Date.parse('2026-03-29T02:00:00Z'))
  c.clock.t = Date.parse('2026-03-29T01:59:00Z')
  assert.equal(c.probe.tick(), false)
  c.clock.t = Date.parse('2026-03-29T02:00:00Z')
  assert.equal(c.probe.tick(), true)
  await c.probe.idle()
  // no catch-up: a missed Sunday is not replayed on Monday
  const d = bench({ T: Date.parse('2026-11-02T03:00:00Z') })
  assert.equal(d.probe.tick(), false)
  // enabled: false → no scheduled run, nextRun null
  const e = bench({ cfg: probeCfg({ probe: { enabled: false } }) })
  assert.equal(e.probe.tick(), false)
  assert.equal(e.probe.nextRun(), null)
  await e.probe.idle()
  assert.equal(e.w.calls.length, 0)
  assert.equal(e.network.view().sources.probe.enabled, false)
})

// --- on demand ---------------------------------------------------------------------------------

test('on demand: 202, 404, 409, 400, 429 with Retry-After, reason with force, neither IP nor port, audit; enabled plays no part', async () => {
  const b = bench({
    cfg: probeCfg({ probe: { enabled: false } }),
    world: { '192.0.2.156': { open: [22] } },
    extra: [{ last_ip: '192.0.2.120', disp_name: 'cam', type: 'camera', disp_type: 'camera' }, { last_ip: '198.51.100.7', disp_name: 'dehors' }, { last_ip: '192.0.2.121', disp_name: 'neuve', state: 'new' }],
  })
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    const P = body => s.post('/api/network/devices/probe', body, { cookie })
    assert.equal((await s.post('/api/network/devices/probe', { id: b.dev('docker-a').id })).status, 401)
    const ok = await P({ id: b.dev('docker-a').id })
    assert.equal(ok.status, 202)
    assert.deepEqual(await ok.json(), { queued: true })
    await b.probe.idle()
    assert.equal(b.w.calls.length, 26)
    assert.deepEqual(b.ports(b.dev('docker-a').id).map(p => p.port), [22])
    assert.match(b.events('probed', b.dev('docker-a').id)[0].detail, /^admin/)
    // 10 min: 429 and Retry-After
    const again = await P({ id: b.dev('docker-a').id })
    assert.equal(again.status, 429)
    assert.ok(Number(again.headers.get('retry-after')) > 0 && Number(again.headers.get('retry-after')) <= 600)
    assert.equal((await P({ id: 999999 })).status, 404)
    assert.equal((await P({ id: b.dev('neuve').id })).status, 409)
    assert.equal((await P({ id: b.dev('dehors').id })).status, 400)
    assert.equal((await P({ id: b.dev('cam').id })).status, 409, 'camera without force')
    assert.equal((await P({ id: b.dev('cam').id, force: true })).status, 400, 'force without a reason')
    assert.equal((await P({ id: b.dev('cam').id, force: true, reason: 'ab' })).status, 400)
    assert.equal((await P({ id: b.dev('cam').id, force: true, reason: 'contrôle après MAJ' })).status, 202)
    // neither IP nor port in the body
    for (const extra of [{ ip: '192.0.2.1' }, { port: 22 }, { ports: [22] }, { target: '192.0.2.1:22' }]) {
      assert.equal((await P({ id: b.dev('gitea').id, ...extra })).status, 400, JSON.stringify(extra))
    }
    // queue full: 429
    b.probe.queue.push({ kind: 'admin', id: -1 }, { kind: 'admin', id: -1 }, { kind: 'admin', id: -1 }, { kind: 'admin', id: -1 }, { kind: 'admin', id: -1 })
    const full = await P({ id: b.dev('gitea').id })
    assert.equal(full.status, 429)
    assert.ok(full.headers.get('retry-after'))
    b.probe.queue.length = 0
    await b.probe.idle()
    const rows = b.store.db.prepare("SELECT * FROM audit WHERE action = 'network: probe' ORDER BY id").all()
    assert.ok(rows.length >= 10)
    const forced = rows.find(r => r.ok !== 0 && /force/.test(r.detail ?? ''))
    assert.equal(forced.target, `dev:${b.dev('cam').id}`)
    assert.match(forced.detail, /^force · contrôle après MAJ$/)
  } finally {
    s.close()
  }
})

test('never through a GET: spy on the prober during all GETs and a refresh → 0 calls', async () => {
  const b = bench({ world: { '192.0.2.156': { open: [22, 80] } } })
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    for (const h of [{}, { cookie }]) {
      for (const p of ['/api/network', '/api/network/history?days=7', '/api/network/topology', '/api/network/topology.mmd',
        ...[...b.ns.load().devices.keys()].map(id => `/api/network/devices/${id}`)]) {
        const r = await fetch(s.base + p, { headers: h })
        assert.ok(r.status < 500, p)
        await r.arrayBuffer()
      }
    }
    await b.network.runAll()
    b.network.view()
    b.network.digestLines()
    await b.probe.idle()
    assert.equal(b.w.calls.length, 0)
    assert.equal(b.w.fetches.length, 0)
    assert.equal(b.events('probed').length, 0)
  } finally {
    s.close()
  }
})

// --- net_ports ------------------------------------------------------------------------------------

test('net_ports: upsert, merge (common port min/max, own port), deleted then back → silent seeding, purge', async () => {
  const b = bench({ world: { '192.0.2.156': { open: [22, 8080], http: WATCHTOWER_HTTP } }, extra: [{ last_ip: '192.0.2.120', disp_name: 'libre' }] })
  const id = b.dev('docker-a').id
  await planned(b)
  const first = b.ports(id)
  // Watchtower proven by two HTTP responses on top of the port → high (rule unchanged)
  assert.deepEqual(first.map(p => [p.port, p.service, p.confidence, p.first_seen, p.last_seen]), [[22, 'ssh', 'low', SUN, SUN], [8080, 'watchtower', 'high', SUN, SUN]])
  b.clock.t += DAY
  await planned(b)
  assert.deepEqual(b.ports(id).map(p => [p.first_seen, p.last_seen]), [[SUN, SUN + DAY], [SUN, SUN + DAY]])
  // merge: free record with 22 (older, closed later) and 5678 (own)
  const other = b.dev('libre').id
  const ins = b.store.db.prepare('INSERT INTO net_ports (device_id, proto, port, first_seen, last_seen, closed_at, service, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  ins.run(other, 'tcp', 22, SUN - 10 * DAY, SUN + 2 * DAY, SUN + 2 * DAY, 'ssh', 'medium')
  ins.run(other, 'tcp', 5678, SUN - 5 * DAY, SUN - DAY, null, 'n8n', 'high')
  b.ns.mergeDevice(id, other, { actor: 'test', ts: b.clock.t })
  const merged = b.ports(id)
  assert.deepEqual(merged.map(p => [p.port, p.first_seen, p.last_seen, p.closed_at]),
    [[22, SUN - 10 * DAY, SUN + 2 * DAY, SUN + 2 * DAY], [5678, SUN - 5 * DAY, SUN - DAY, null], [8080, SUN, SUN + DAY, null]])
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_ports WHERE device_id = ?').get(other).n, 0)
  // purge: closed for more than 90 days → removed; open ones kept
  b.store.db.prepare('UPDATE net_ports SET closed_at = ? WHERE device_id = ? AND port = 22').run(b.clock.t - 91 * DAY, id)
  b.ns.purge(b.clock.t)
  assert.deepEqual(b.ports(id).map(p => p.port), [5678, 8080])
  // deleted (record without host) then back: old ports gone, new silent seeding
  const free = b.ns.load().devices.get(id)
  b.store.db.prepare('UPDATE net_devices SET host_id = NULL, host_src = NULL WHERE id = ?').run(id)
  b.store.db.prepare("UPDATE net_macs SET attach = NULL, grade = 'strong' WHERE device_id = ?").run(id)
  b.network.writes.delete({ ids: [id], reason: 'test de retour' }, who)
  assert.equal(b.ports(id).length, 0)
  b.ns.applyOps([{ op: 'insertDevice', ref: 'new:r', fields: { state: 'known', review: 0, origin: 'config', host_id: 'docker-a', host_src: 'config', disp_name: 'docker-a', primary_mac: '00:00:5e:00:53:fe', last_ip: free.last_ip, online: 1, created_at: b.clock.t, updated_at: b.clock.t } },
    { op: 'upsertMac', mac: '00:00:5e:00:53:fe', device: 'new:r', grade: 'hypervisor', random: 0, first_seen: b.clock.t, last_seen: b.clock.t, last_ip: free.last_ip, attach: 'config' }])
  const back = b.dev('docker-a').id
  assert.notEqual(back, id)
  await b.probe.probeDevice(b.ns.load().devices.get(back), 'planned')
  assert.deepEqual(b.ports(back).map(p => p.port), [22, 8080])
  assert.equal(b.events('port_opened', back).length, 0)
})

// --- no wave ----------------------------------------------------------------------------------

test('no wave (21 hosts): first run → 0 messages, 0 lines; a new port → 1 digest line, 0 alerts', async () => {
  const world = {}
  for (const h of PROD_HOSTS) world[h.ip] = { open: [22, 80, 443] }
  world['192.0.2.156'] = { open: [22, 5678, 9443, 3000], http: { '5678 /healthz': { status: 200 }, '3000 /api/health': { body: 'database ok' } } }
  const b = bench({ world })
  const tz = createClock('Europe/Paris')
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg: b.cfg, store: b.store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const engine = createEngine({ cfg: b.cfg, store: b.store, rules: createRules(b.cfg, { checks: [], result: () => null }, null, null, b.network), notifier, clock: tz, startedAt: b.clock.t })
  const outbox = () => b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n
  const portLines = () => b.network.digestLines().filter(l => /Ports/.test(l))
  engine.evaluate({}, b.clock.t)
  const firing0 = engine.active().length
  // enabling and first run: silent seeding
  await planned(b)
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.ok(b.store.db.prepare('SELECT COUNT(*) n FROM net_ports').get().n >= 18 * 3)
  assert.equal(b.events('port_opened').length, 0)
  assert.deepEqual(portLines(), [])
  assert.equal(outbox(), 0)
  assert.equal(telegram.sent.length, 0)
  // second run: 1 new port on docker-a
  b.clock.t += 7 * DAY
  world['192.0.2.156'].open.push(8080)
  world['192.0.2.156'].http = { ...world['192.0.2.156'].http, ...WATCHTOWER_HTTP }
  await planned(b)
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.equal(b.events('port_opened').length, 1)
  assert.deepEqual(portLines(), ['   Ports (24 h) : docker-a : +tcp/8080 (watchtower)'])
  assert.equal(engine.active().length, firing0)
  assert.equal(outbox(), 0)
  assert.equal(telegram.sent.length, 0)
  // label: deviceLabel, never a bare MAC
  b.store.db.prepare("UPDATE net_devices SET disp_name = NULL, vendor = 'Acme' WHERE host_id = 'docker-a'").run()
  const d = [...b.ns.load().devices.values()].find(x => x.host_id === 'docker-a')
  assert.equal(deviceLabel(d), `Acme (fiche ${d.id})`)
  // a run reloads the state: the line is recomputed with the new label
  await b.probe.probeDevice(d, 'planned')
  const line = portLines()[0]
  assert.match(line, new RegExp(`Acme \\(fiche ${d.id}\\) : \\+tcp/8080`))
  assert.doesNotMatch(line, /00:00:5e/)
})

// --- exposure, attachment ---------------------------------------------------------------------

test('exposure: without a session probeServices without port and lastProbe; admin: ports; never a reason or an author', async () => {
  const b = bench({ world: { '192.0.2.156': { open: [22, 5678], http: { '5678 /healthz': { status: 200 } } } }, extra: [{ last_ip: '192.0.2.120', disp_name: 'cam', type: 'camera', disp_type: 'camera' }] })
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    const cam = b.dev('cam').id
    assert.equal((await s.post('/api/network/devices/probe', { id: cam, force: true, reason: 'motif secret xyz' }, { cookie })).status, 202)
    await b.probe.idle()
    await planned(b)
    const id = b.dev('docker-a').id
    const anon = await (await fetch(`${s.base}/api/network/devices/${id}`)).json()
    assert.deepEqual(anon.probeServices, [{ id: 'ssh', name: 'SSH', confidence: 'low', cfgService: null }, { id: 'n8n', name: 'n8n', confidence: 'high', cfgService: 'n8n' }])
    assert.ok(anon.probeServices.every(x => !('port' in x)), 'no port without a session')
    assert.equal(anon.lastProbe.origin, 'planned')
    assert.equal(anon.ports, undefined)
    assert.equal(anon.probe, undefined)
    assert.ok(Array.isArray(anon.services), 'hosted services unchanged')
    const adm = await (await fetch(`${s.base}/api/network/devices/${id}`, { headers: { cookie } })).json()
    assert.deepEqual(adm.ports.map(p => [p.proto, p.port, p.open, p.service]), [['tcp', 22, true, 'ssh'], ['tcp', 5678, true, 'n8n']])
    assert.deepEqual(adm.probeServices.map(x => x.port), [22, 5678], 'port with an admin session')
    assert.deepEqual(adm.probe, { available: true, excluded: false, needsForce: false })
    for (const u of [`/api/network/devices/${cam}`, '/api/network']) {
      for (const h of [{}, { cookie }]) {
        const text = await (await fetch(s.base + u, { headers: h })).text()
        assert.doesNotMatch(text, /motif secret xyz|admin \(test\)/, u)
      }
    }
    const camView = await (await fetch(`${s.base}/api/network/devices/${cam}`)).json()
    assert.equal(camView.lastProbe.origin, 'admin')
    const v = await (await fetch(`${s.base}/api/network`)).json()
    assert.deepEqual(Object.keys(v.sources.probe).sort(), ['at', 'defsOk', 'enabled', 'error', 'lastRun', 'nextRun', 'ok', 'queued', 'running'])
  } finally {
    s.close()
  }
})

test('attachment to cfg.services: literal IP and port (url, tcp check, http check); URL with a name → none', () => {
  const idx = cfgServiceIndex({ services: [
    { id: 'n8n', url: 'http://192.0.2.156:5678/' },
    { id: 'web', url: 'https://192.0.2.10/' },
    { id: 'plain', url: 'http://192.0.2.11' },
    { id: 'node', checks: [{ type: 'tcp', target: '192.0.2.156:9100' }] },
    { id: 'graf', checks: [{ type: 'http', url: 'http://192.0.2.156:3000/api/health' }] },
    { id: 'nom', url: 'https://waf.example.net/', checks: [{ type: 'tcp', target: 'nas.local:22' }] },
  ] })
  assert.deepEqual([...idx].sort(), [['192.0.2.10:443', 'web'], ['192.0.2.11:80', 'plain'], ['192.0.2.156:3000', 'graf'], ['192.0.2.156:5678', 'n8n'], ['192.0.2.156:9100', 'node']].sort())
})

// --- persistent "already probed" marker ---------------------------------------------------

test('kv marker "already probed": events purged → no new seeding; record without port then open port → one line', async () => {
  const b = bench({ world: { '192.0.2.156': { open: [22] }, '192.0.2.231': {} } })
  const prod = b.dev('docker-a').id
  const d1 = b.dev('docker-lab').id
  await planned(b)
  assert.ok(JSON.parse(b.store.kv.get(PROBED_KEY)).includes(prod))
  assert.ok(JSON.parse(b.store.kv.get(PROBED_KEY)).includes(d1), 'record without a port: marked too')
  assert.equal(b.ports(d1).length, 0)
  // purge of ALL events: the marker stays, no new seeding
  b.store.db.prepare('DELETE FROM net_events').run()
  b.clock.t += 7 * DAY
  b.w.world['192.0.2.156'] = { open: [22, 8080], http: WATCHTOWER_HTTP }
  b.w.world['192.0.2.231'] = { open: [9100] }
  await planned(b)
  assert.deepEqual(b.events('port_opened').map(e => [e.device_id, e.detail]).sort(), [[d1, 'tcp/9100 (node-exporter)'], [prod, 'tcp/8080 (watchtower)']].sort())
  const lines = b.network.digestLines().filter(l => /Ports/.test(l))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /docker-a : \+tcp\/8080 \(watchtower\)/)
  assert.match(lines[0], /docker-lab : \+tcp\/9100 \(node-exporter\)/)
})

test('marker limited to deletion and merge (with no other write)', async () => {
  const b = bench({ world: { '192.0.2.120': { open: [22] }, '192.0.2.121': { open: [80] } }, extra: [{ last_ip: '192.0.2.120', disp_name: 'a' }, { last_ip: '192.0.2.121', disp_name: 'b' }] })
  const [a, c] = [b.dev('a').id, b.dev('b').id]
  for (const id of [a, c]) await b.probe.probeDevice(b.ns.load().devices.get(id), 'admin')
  const marked = () => JSON.parse(b.store.kv.get(PROBED_KEY))
  assert.deepEqual(marked().sort(), [a, c].sort())
  b.ns.transaction(() => b.ns.mergeDevice(a, c, { actor: 'test', ts: b.clock.t }))
  assert.deepEqual(marked(), [a])
  b.network.writes.delete({ ids: [a], reason: 'test du marqueur' }, who)
  assert.deepEqual(marked(), [])
})

// --- exclusion by id AND by IP -----------------------------------------------------------

test('an excluded id excludes the configured IP of its host; unlinked record on the IP of waf → 409 even with force, 0 connections', async () => {
  const cfg = probeCfg({ probe: { exclude: ['waf'] } })
  const world = Object.fromEntries(PROD_HOSTS.map(h => [h.ip, { open: [22] }]))
  const b = bench({ cfg, world, extra: [{ last_ip: '192.0.2.157', disp_name: 'intrus' }] })
  const intrus = b.ns.load().devices.get(b.dev('intrus').id)
  assert.equal(excluded(intrus, cfg), true)
  // record linked to another host, whose current IP has become that of waf
  b.store.db.prepare("UPDATE net_devices SET last_ip = '192.0.2.157' WHERE host_id = 'homepage'").run()
  b.store.db.prepare("UPDATE net_devices SET last_ip = '192.0.2.99' WHERE host_id = 'waf'").run()
  await b.network.runAll()
  const st = b.ns.load()
  assert.equal(excluded([...st.devices.values()].find(d => d.host_id === 'homepage'), cfg), true)
  assert.equal(excluded([...st.devices.values()].find(d => d.host_id === 'waf'), cfg), true, 'linked to an excluded host, IP changed')
  const s = await netServer({ store: b.store, cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    for (const body of [{}, { force: true, reason: 'je force' }]) {
      const r = await s.post('/api/network/devices/probe', { id: intrus.id, ...body }, { cookie })
      assert.equal(r.status, 409)
      assert.match((await r.json()).error, /exclue \(network\.probe\.exclude\)/)
    }
    await b.probe.idle()
    assert.equal(b.w.calls.length, 0)
    await planned(b)
    assert.ok(b.w.calls.length > 0)
    assert.ok(!b.w.calls.some(c => ['192.0.2.157', '192.0.2.99'].includes(c.ip)))
  } finally {
    s.close()
  }
  // an excluded IP excludes any record whose current IP equals that IP, linked or not
  const byIp = probeCfg({ probe: { exclude: ['192.0.2.157'] } })
  assert.equal(excluded({ last_ip: '192.0.2.157' }, byIp), true)
  assert.equal(excluded({ last_ip: '192.0.2.157', host_id: 'homepage' }, byIp), true)
  assert.equal(excluded({ last_ip: '192.0.2.10', host_id: 'homepage' }, byIp), false)
})

test('an unknown id in exclude → warning, config returned; the probe is disabled with its message', async () => {
  const r = parseConfig({
    version: 2, title: 't', proxmox: [], hosts: [{ id: 'h', name: 'h', kind: 'appliance', ip: '192.0.2.5', env: 'prod' }], groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { pve: false }, probe: { exclude: ['fantome'] } },
  })
  assert.equal(r.errors, undefined)
  assert.ok(r.config)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /network\.probe\.exclude: "fantome" is neither an IPv4 address nor a host/)
  // config passed as is to the probe: disabled, with the message, no connection
  const cfg = probeCfg({ probe: { exclude: ['fantome'] } })
  const b = bench({ cfg })
  assert.equal(b.probe.usable, false)
  const src = b.network.view().sources.probe
  assert.equal(src.ok, false)
  assert.match(src.error, /"fantome"/)
  assert.equal(b.probe.tick(), false)
  assert.equal(b.probe.request(b.dev('docker-a').id).status, 503)
  await b.probe.idle()
  assert.equal(b.w.calls.length, 0)
})

test('a real error (service on an unknown host) stays an error', () => {
  const r = parseConfig({
    version: 2, title: 't', proxmox: [], hosts: [{ id: 'h', name: 'h', kind: 'appliance', ip: '192.0.2.5', env: 'prod' }], groups: [{ id: 'g', name: 'G' }],
    services: [{ id: 's', name: 'S', group: 'g', host: 'inconnu', url: 'http://192.0.2.5/' }], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { pve: false }, probe: { exclude: ['fantome'] } },
  })
  assert.equal(r.config, undefined)
  assert.match(r.errors.join('\n'), /service s: unknown host "inconnu"/)
  assert.equal(r.warnings.length, 1) // the warning is returned too
})

test('static: index.js logs config warnings', () => {
  const src = fs.readFileSync(path.join(HERE, '../index.js'), 'utf8')
  assert.match(src, /^for \(const w of loaded\.warnings \?\? \[\]\) console\.warn\(`config\.json: \$\{w\}`\)$/m)
  assert.ok(src.indexOf('loaded.warnings') < src.indexOf('createMonitor(cfg)'), 'at load time, before the start')
})

test('check-config.js prints "⚠" and exits 0 on a warning, exits 1 on an error', () => {
  const base = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/config.reference.json'), 'utf8'))
  const dir = tmpDir('dash-check-config-')
  const warn = path.join(dir, 'avertissement.json')
  const bad = path.join(dir, 'erreur.json')
  fs.writeFileSync(warn, JSON.stringify({ ...base, network: { ...base.network, probe: { enabled: false, exclude: ['fantome'] } } }))
  fs.writeFileSync(bad, JSON.stringify({ ...base, services: [...base.services, { id: 'zz-inconnu', name: 'Z', group: base.groups[0].id, host: 'hote-inexistant', url: 'http://192.0.2.5/' }] }))
  const script = path.join(HERE, '../scripts/check-config.js')
  const run = f => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, f], { encoding: 'utf8' })
  const w = run(warn)
  assert.equal(w.status, 0, w.stderr)
  assert.match(w.stderr + w.stdout, /⚠ network\.probe\.exclude: "fantome"/)
  assert.match(w.stdout, /^✓ /m)
  const e = run(bad)
  assert.equal(e.status, 1)
  assert.match(e.stderr, /unknown host "hote-inexistant"/)
})

test('exclusion checked again at run time: POST accepted, then IP moved to an excluded IP before the run → 0 connections', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const b = bench({ gate, world: { '192.0.2.156': { open: [22] }, '192.0.2.143': { open: [22] }, '192.0.2.157': { open: [22] } } })
  const s = await netServer({ store: b.store, cfg: b.cfg, T: SUN, network: b.network })
  try {
    const cookie = await s.login()
    const P = id => s.post('/api/network/devices/probe', { id }, { cookie })
    // 1st request: fills the queue (connections held by gate)
    assert.equal((await P(b.dev('docker-a').id)).status, 202)
    // 2nd request, on an allowed record: accepted, queued
    const gitea = b.dev('gitea').id
    assert.equal((await P(gitea)).status, 202)
    assert.equal(b.probe.queue.length, 1)
    // before its run, its IP becomes that of waf (excluded, 192.0.2.157 in the fixture)
    b.store.db.prepare("UPDATE net_devices SET last_ip = '192.0.2.157' WHERE id = ?").run(gitea)
    await b.network.runAll() // module state reloaded
    release()
    await b.probe.idle()
    assert.ok(b.w.calls.some(c => c.ip === '192.0.2.156'), 'the 1st request did probe')
    assert.ok(!b.w.calls.some(c => ['192.0.2.157', '192.0.2.143'].includes(c.ip)), 'no connection to the record that became excluded')
    assert.equal(b.events('probed', gitea).length, 0)
    assert.equal(b.ports(gitea).length, 0)
  } finally {
    release()
    s.close()
  }
})

// --- Watchtower with three conditions, 4xx budget ------------

const WT = REAL.defs.find(d => d.id === 'watchtower')
const observe = async (defs, world, ip = '192.0.2.9') => {
  const w = fakeWorld({ [ip]: world })
  const obs = await observeHost(ip, { defs, connect: w.connect, fetchImpl: w.fetchImpl, limiter: w.limiter })
  return { obs, w, found: recognise(defs, { open: obs.open, resp: obs.resp, portOwners: defs.portOwners }) }
}

test('Watchtower: 401 WITHOUT body on /v1/metrics and 404 page not found on / → watchtower; otherwise not (body, 200, TLS 400, a single piece of evidence)', async () => {
  assert.deepEqual(WT.match, { allOf: [{ port: 8080 }, { http: { port: 8080, path: '/v1/metrics', status: 401, empty: true } }, { http: { port: 8080, path: '/', status: 404, contains: '404 page not found' } }] })
  const at = async http => (await observe(REAL, { open: [8080], http })).found.get(8080)?.service ?? null
  assert.equal(await at(WATCHTOWER_HTTP), 'watchtower')
  assert.equal(await at({ ...WATCHTOWER_HTTP, '8080 /v1/metrics': { status: 401, body: 'Unauthorized' } }), null)
  assert.equal(await at({ '8080 /v1/metrics': { status: 200, body: '' }, '8080 /': { status: 200, body: '404 page not found' } }), null)
  // Apache over TLS on 8080 (docker-b): a plain-text request → 400
  assert.equal(await at({ '*': { status: 400, body: '<title>400 bad request</title> you\'re speaking plain http to an ssl-enabled server port' } }), null)
  assert.equal(await at({ '8080 /v1/metrics': { status: 401, body: '' }, '8080 /': { status: 200, body: 'accueil' } }), null)
  assert.equal(await at({ '8080 /v1/metrics': { status: 404, body: '404 page not found' }, '8080 /': { status: 404, body: '404 page not found' } }), null)
  assert.equal(await at({}), null) // port alone: never Watchtower anymore
  // Watchtower and qBittorrent share 8080 (their default ports); the HTTP proofs tell them apart
  assert.equal(await at({ '8080 /': { status: 200, body: '<title>qBittorrent Web UI</title>' }, '8080 /v1/metrics': { status: 404, body: 'Not Found' } }), 'qbittorrent')
  assert.equal(await at({ '8080 /': { status: 200, body: 'qBittorrent' }, '8080 /v1/metrics': { status: 401, body: '' } }), 'qbittorrent')
  // both requests are GETs, without a token
  const { w } = await observe(REAL, { open: [8080], http: WATCHTOWER_HTTP })
  assert.deepEqual(w.fetches.map(f => [new URL(f.url).pathname, f.opts.method, f.opts.headers.Authorization ?? null]).sort(), [['/', 'GET', null], ['/v1/metrics', 'GET', null]])
  // empty: the schema accepts it alone; it refuses any value other than true
  assert.equal(defsOf([one('e', { http: { port: 80, path: '/', empty: true } })]).ok, true)
  assert.equal(defsOf([one('e', { http: { port: 80, path: '/', empty: false } })]).ok, false)
})

test('4xx budget: EXPECTED 4xx do not count; three unexpected 4xx stop HTTP as before', async () => {
  assert.equal(MAX_HTTP_4XX, 3)
  const svc = (id, p) => one(id, { allOf: [{ port: p }, { http: { port: p, path: `/${id}`, contains: `je suis ${id}` } }] })
  const x = (id, p) => one(id, { allOf: [{ port: p }, { http: { port: p, path: `/${id}`, contains: 'jamais' } }] })
  // file order: Watchtower, an unexpected 4xx, then three services proven by a 200
  const defs = defsOf([WT, x('x1', 7001), svc('a', 7101), svc('b', 7102), svc('c', 7103)])
  const http = { ...WATCHTOWER_HTTP, '7001 /x1': { status: 404 }, '7101 /a': { body: 'je suis a' }, '7102 /b': { body: 'je suis b' }, '7103 /c': { body: 'je suis c' } }
  const r = await observe(defs, { open: [8080, 7001, 7101, 7102, 7103], http })
  assert.deepEqual([...r.found].map(([p, v]) => [p, v.service]).sort((a, b) => a[0] - b[0]), [[7101, 'a'], [7102, 'b'], [7103, 'c'], [8080, 'watchtower']])
  assert.deepEqual([r.obs.requests, r.obs.c4xx], [6, 1])
  assert.deepEqual([...expectedStatuses(defs).get('8080 /v1/metrics')], [401])
  // three unexpected 4xx: stop after the 3rd, as before (the next service is not requested)
  const stop = defsOf([WT, x('x1', 7001), x('x2', 7002), x('x3', 7003), svc('a', 7101)])
  const s = await observe(stop, { open: [8080, 7001, 7002, 7003, 7101], http: { ...WATCHTOWER_HTTP, '7101 /a': { body: 'je suis a' } } })
  assert.deepEqual([s.obs.requests, s.obs.c4xx], [5, 3])
  assert.equal(s.found.get(7101), undefined)
  assert.equal(s.found.get(8080)?.service, 'watchtower')
  // only the EXACT status expected for THIS (port, path) is exempt. 403 where 401 is
  // expected, or 401 on "/" (which expects 404): counted
  const other = await observe(defsOf([WT]), { open: [8080], http: { '8080 /v1/metrics': { status: 403, body: '' }, '8080 /': { status: 404, body: '404 page not found' } } })
  assert.equal(other.obs.c4xx, 1)
  const swapped = await observe(defsOf([WT]), { open: [8080], http: { '8080 /v1/metrics': { status: 404, body: '' }, '8080 /': { status: 401, body: '' } } })
  assert.equal(swapped.obs.c4xx, 2)
  // three responses of this kind → the host's HTTP stops as today
  const wt2 = (id, p) => one(id, { allOf: [{ port: p }, { http: { port: p, path: '/v1/metrics', status: 401, empty: true } }] })
  const wrong = defsOf([wt2('w1', 7201), wt2('w2', 7202), wt2('w3', 7203), svc('a', 7101)])
  const wr = await observe(wrong, { open: [7201, 7202, 7203, 7101], http: { '7201 /v1/metrics': { status: 403 }, '7202 /v1/metrics': { status: 404 }, '7203 /v1/metrics': { status: 400 }, '7101 /a': { body: 'je suis a' } } })
  assert.deepEqual([wr.obs.requests, wr.obs.c4xx], [3, 3])
  assert.equal(wr.found.get(7101), undefined)
})

test('MAX_HTTP_PER_HOST unchanged: even if ALL responses are expected 4xx, never more than 24 requests per host', async () => {
  assert.equal(MAX_HTTP_PER_HOST, 24)
  const many = defsOf(Array.from({ length: 30 }, (_, i) => one(`w${i}`, { allOf: [{ port: 80 }, { http: { port: 80, path: `/p${i}`, status: 401 } }] })))
  const r = await observe(many, { open: [80], http: { '*': { status: 401, body: '' } } })
  assert.deepEqual([r.obs.requests, r.obs.c4xx, r.w.fetches.length], [MAX_HTTP_PER_HOST, 0, MAX_HTTP_PER_HOST])
  // the real file, all ports open, all 4xx whether expected or not: never more than 24
  const all = await observe(REAL, { open: REAL.ports, http: { '*': { status: 401, body: '' } } })
  assert.ok(all.obs.requests <= MAX_HTTP_PER_HOST)
})

test('empty: body of ZERO length after reading (real local HTTP server); empty chunked → yes, non-empty chunked → no, Content-Length 0 → yes', async () => {
  const http = await import('node:http')
  const modes = {
    '/chunked-vide': res => { res.setHeader('Transfer-Encoding', 'chunked'); res.writeHead(401); res.end() },
    '/chunked-plein': res => { res.setHeader('Transfer-Encoding', 'chunked'); res.writeHead(401); res.write('x'); res.end() },
    '/longueur-0': res => { res.writeHead(401, { 'Content-Length': '0' }); res.end() },
    '/longueur-5': res => { res.writeHead(401, { 'Content-Length': '5' }); res.end('abcde') },
    // lying header: Content-Length missing, body sent → read, so not empty
    '/gzip': res => { res.writeHead(401, { 'Content-Encoding': 'gzip', 'Content-Length': '0' }); res.end() },
  }
  const srv = http.createServer((q, res) => (modes[q.url] ?? (r => { r.writeHead(404); r.end() }))(res))
  srv.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const port = srv.address().port
  try {
    const { httpGet } = await import('../lib/network/probe.js')
    const defs = defsOf([one('e', { http: { port, path: '/x', status: 401, empty: true } })])
    const empty = async p => {
      const r = await httpGet(fetch, '127.0.0.1', port, p)
      return { bytes: r.bytes, ok: evalMotif({ http: { port, path: p, status: 401, empty: true } }, { open: new Set([port]), resp: () => r, portOwners: defs.portOwners }).ok }
    }
    assert.deepEqual(await empty('/chunked-vide'), { bytes: 0, ok: true })
    assert.deepEqual(await empty('/chunked-plein'), { bytes: 1, ok: false })
    assert.deepEqual(await empty('/longueur-0'), { bytes: 0, ok: true })
    assert.deepEqual(await empty('/longueur-5'), { bytes: 5, ok: false })
    // body not read (encoding ≠ identity): unknown length → never "empty"
    assert.deepEqual(await empty('/gzip'), { bytes: null, ok: false })
  } finally {
    srv.close()
  }
})

test('static: MAX_HTTP_PER_HOST = 24 and MAX_HTTP_4XX = 3 unchanged; the probe only sends GETs (never HEAD)', () => {
  const src = fs.readFileSync(path.join(HERE, '../lib/network/probe.js'), 'utf8')
  assert.match(src, /^export const MAX_HTTP_PER_HOST = 24 \/\/ /m)
  assert.match(src, /^export const MAX_HTTP_4XX = 3$/m)
  assert.match(src, /\.slice\(0, MAX_HTTP_PER_HOST\)/)
  assert.equal((src.match(/method: '/g) || []).length, 1)
  assert.match(src, /method: 'GET', redirect: 'manual'/)
  assert.doesNotMatch(src, /['"`]HEAD['"`]/i)
})

// "pattern on the port alone → low": rule carried by the DEFINITION, not by the node
test('port alone → low: the 4 definitions with a single port node (6 before two were removed); allOf, macVendor, HTTP and bunkerweb unchanged', () => {
  const PORT_ONLY = { 'proxmox-ve': 8006, portainer: 9443, 'bunkerweb-metrics': 9113, 'node-exporter': 9100 }
  // the real list of definitions with a single port node: the 4 generic ones and these 4
  assert.deepEqual(REAL.defs.filter(portOnly).map(d => d.id).sort(), ['bunkerweb-metrics', 'dns', 'http', 'https', 'node-exporter', 'portainer', 'proxmox-ve', 'ssh'])
  for (const [id, port] of Object.entries(PORT_ONLY)) {
    assert.equal(REAL.portOwners.get(port).has(id), true, id)
    assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [port] })).get(port), { service: id, confidence: 'low' }, id)
  }
  // the 4 ports open together: all low, no other service
  const all = recognise(REAL, ctxOf(REAL, { open: Object.values(PORT_ONLY) }))
  assert.deepEqual(Object.fromEntries([...all].map(([p, v]) => [p, v])), Object.fromEntries(Object.entries(PORT_ONLY).map(([id, p]) => [p, { service: id, confidence: 'low' }])))
  // the evaluator does not change: a lone port node keeps its own rank (medium if unique)
  assert.equal(evalMotif({ port: 9100 }, ctxOf(REAL, { open: [9100] })).rank, 1)
  // a port INSIDE an allOf keeps its rank: synology-dsm (5001 + macVendor) high, bunkerweb (3 ports) high
  assert.deepEqual(recognise(REAL, ctxOf(REAL, { open: [5001], vendor: 'Synology Incorporated' })).get(5001), { service: 'synology-dsm', confidence: 'high' })
  const bw = recognise(REAL, ctxOf(REAL, { open: [80, 443, 9113] }))
  assert.deepEqual([bw.get(80), bw.get(443), bw.get(9113)], Array(3).fill({ service: 'bunkerweb', confidence: 'high' }))
  // definitions with HTTP evidence: high, even with a neighboring lone port
  const http = { '9090 /-/healthy': { status: 200, body: 'Prometheus Server is Healthy.' }, '8989 /ping': { status: 200, body: '{}' } }
  const mix = recognise(REAL, ctxOf(REAL, { open: [9090, 8989, 9100, 9443], http }))
  assert.deepEqual([mix.get(9090), mix.get(8989), mix.get(9100), mix.get(9443)], [
    { service: 'prometheus', confidence: 'high' }, { service: 'sonarr', confidence: 'high' },
    { service: 'node-exporter', confidence: 'low' }, { service: 'portainer', confidence: 'low' },
  ])
  // synthetic: { port } alone → low; anyOf or allOf of a single port: outside the rule (own rank)
  const S = defsOf([one('solo', { port: 7200 }), one('any', { anyOf: [{ port: 7201 }] }), one('all', { allOf: [{ port: 7202 }] })])
  const r = recognise(S, ctxOf(S, { open: [7200, 7201, 7202] }))
  assert.deepEqual([r.get(7200).confidence, r.get(7201).confidence, r.get(7202).confidence], ['low', 'medium', 'medium'])
  assert.deepEqual([portOnly({ match: { port: 1 } }), portOnly({ match: { anyOf: [{ port: 1 }] } }), portOnly({ match: { http: { port: 1, path: '/' } } })], [true, false, false])
})

// --- stale port ---------------------------------------------------------------

test('observeHost: extraPorts probed over TCP only (once, even if duplicated); no extra HTTP request, cap of 24 held', async () => {
  assert.equal(REAL.ports.includes(8443), false, '8443 is no longer in the definitions')
  const ip = '192.0.2.9'
  const world = { open: [...REAL.ports, 8443, 7000], http: { '*': { status: 200, body: 'ok' } } }
  const base = fakeWorld({ [ip]: world })
  const ref = await observeHost(ip, { defs: REAL, connect: base.connect, fetchImpl: base.fetchImpl, limiter: base.limiter })
  const w = fakeWorld({ [ip]: world })
  const obs = await observeHost(ip, { defs: REAL, extraPorts: [8443, 7000, 22], connect: w.connect, fetchImpl: w.fetchImpl, limiter: w.limiter })
  assert.deepEqual(w.calls.map(c => c.port).sort((a, b) => a - b), [...REAL.ports, 7000, 8443].sort((a, b) => a - b))
  assert.equal(base.calls.length, REAL.ports.length)
  assert.deepEqual([obs.states.get(8443), obs.states.get(7000), obs.open.has(8443)], ['open', 'open', true])
  assert.equal(obs.requests, ref.requests)
  assert.ok(obs.requests <= MAX_HTTP_PER_HOST)
  assert.deepEqual(w.fetches.map(f => f.url), base.fetches.map(f => f.url))
  assert.equal(w.fetches.some(f => /:(8443|7000)\//.test(f.url)), false)
  // recognition unchanged: no service for a port without a definition
  assert.equal(recognise(REAL, { open: obs.open, resp: obs.resp, portOwners: REAL.portOwners }).has(8443), false)
})

test('open port dropped from the definitions (the case of 8443 "old-gateway" on a host): checked again, recomputed (service, confidence and cfg_service to null) while it is open; closed on the SECOND refusal only, then no longer probed', async () => {
  const b = bench({ world: { '192.0.2.156': { open: [22] } } })
  const id = b.dev('docker-a').id
  await planned(b) // seeding
  // row inherited from before: 8443 recognized as old-gateway (medium), attached to the config service
  b.ns.applyOps([{ op: 'upsertPort', device: id, proto: 'tcp', port: 8443, ts: b.clock.t, service: 'old-gateway', confidence: 'medium', cfg_service: 'old-gateway' }])
  const row = () => b.ports(id).find(p => p.port === 8443)
  const probed8443 = from => b.w.calls.slice(from).filter(c => c.ip === '192.0.2.156' && c.port === 8443).length
  // still open: the row stays, recomputed
  b.w.world['192.0.2.156'] = { open: [22, 8443] }
  b.clock.t += DAY
  let from = b.w.calls.length
  await planned(b)
  assert.equal(probed8443(from), 1)
  assert.deepEqual([row().closed_at, row().service, row().confidence, row().cfg_service, row().last_seen], [null, null, null, null, b.clock.t])
  assert.deepEqual(b.events('port_opened', id), [], 'already open: no event')
  // 1st refusal: nothing closed
  b.w.world['192.0.2.156'] = { open: [22] }
  b.clock.t += DAY
  await planned(b)
  assert.equal(row().closed_at, null)
  // 2nd consecutive refusal: closed, event
  b.clock.t += DAY
  from = b.w.calls.length
  await planned(b)
  assert.equal(probed8443(from), 1)
  assert.equal(row().closed_at, b.clock.t)
  assert.deepEqual(b.events('port_closed', id).map(e => e.detail), ['tcp/8443'])
  // closed and outside the definitions: never probed again
  b.clock.t += DAY
  from = b.w.calls.length
  await planned(b)
  assert.equal(probed8443(from), 0)
  assert.ok(b.w.calls.slice(from).some(c => c.ip === '192.0.2.156' && c.port === 22))
})

test('port outside the definitions attached to a config service: cfg_service recomputed (kept), service to null; a single refusal closes nothing', async () => {
  const cfg = probeCfg({ services: [...PROD_SERVICES, { id: 'lab-tls', host: 'docker-a', url: 'https://192.0.2.156:8443/' }] })
  const b = bench({ cfg, world: { '192.0.2.156': { open: [22] } } })
  const id = b.dev('docker-a').id
  await planned(b)
  b.ns.applyOps([{ op: 'upsertPort', device: id, proto: 'tcp', port: 8443, ts: b.clock.t, service: 'old-gateway', confidence: 'medium', cfg_service: 'old-gateway' }])
  b.w.world['192.0.2.156'] = { open: [22, 8443] }
  b.clock.t += DAY
  await planned(b)
  const row = () => b.ports(id).find(p => p.port === 8443)
  assert.deepEqual([row().closed_at, row().service, row().confidence, row().cfg_service], [null, null, null, 'lab-tls'])
  // refusal, then open again, then refusal: the streak is broken, nothing is closed
  for (const open of [[22], [22, 8443], [22]]) {
    b.w.world['192.0.2.156'] = { open }
    b.clock.t += DAY
    await planned(b)
  }
  assert.equal(row().closed_at, null)
})

test('cap: 20 ports still open outside the definitions → 16 checked again at most (the first in record order), no HTTP request to them', async () => {
  const extra = Array.from({ length: 20 }, (_, i) => 7000 + i)
  assert.equal(extra.some(p => REAL.ports.includes(p)), false)
  const b = bench({ world: { '192.0.2.156': { open: [22] } } })
  const id = b.dev('docker-a').id
  await planned(b) // seeding
  b.ns.applyOps(extra.map(port => ({ op: 'upsertPort', device: id, proto: 'tcp', port, ts: b.clock.t, service: null, confidence: null, cfg_service: null })))
  b.w.world['192.0.2.156'] = { open: [22, ...extra] }
  b.clock.t += DAY
  const from = b.w.calls.length
  const fetches = b.w.fetches.length
  await planned(b)
  const seen = b.w.calls.slice(from).filter(c => c.ip === '192.0.2.156' && c.port >= 7000 && c.port < 7020).map(c => c.port).sort((x, y) => x - y)
  assert.deepEqual(seen, extra.slice(0, 16))
  assert.equal(b.w.fetches.slice(fetches).some(f => /:70[0-1]\d\//.test(f.url)), false)
})
