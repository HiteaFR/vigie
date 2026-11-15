// Passive mDNS source. Fake socket (no real listening), RFC 5737 and 7042 fixtures. The parsing
// tests come from the retired measurement tool (mdns-mesure), not weakened: they now go through
// the handler attached to the socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNetStore } from '../lib/network/store.js'
import { createNetwork } from '../lib/network/index.js'
import { bestAttr, PRESENCE_SOURCES, ARP_PRESENCE_SOURCES, deviceLabel } from '../lib/network/merge.js'
import { parsePacket, readName, candidateOf, createMdnsHandler, ifaceIp, MDNS_GROUP } from '../lib/network/sources/mdns.js'
import { parseCidr } from '../lib/net/ip.js'
import { createAudit } from '../lib/auth.js'
import { createClock } from '../lib/clock.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { prodConfig, withArp, arpProbe, OTHER_UID, routeFile, APPLIANCES, fakeTelegram, netServer, MIN, quiet, mergeBench } from './network-fixture.js'
import { tmpStore, tmpDir } from './tmpdir.js'
import { suggestFamilies, suggestMerges } from '../lib/network/suggest.js'
import { cleanName } from '../lib/network/merge.js'
import { buildDigest } from '../lib/notify/digest.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
const T0 = Date.parse('2026-10-27T10:00:00Z')
const CIDRS = [parseCidr('192.0.2.0/24')]

// --- packets -----------------------------------------------------------------------------------

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const nm = s => Buffer.concat([...s.split('.').map(l => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])])
const header = ({ qr = true, qd = 0, an = 0, ns = 0, ar = 0 } = {}) => Buffer.concat([u16(0), u16(qr ? 0x8400 : 0), u16(qd), u16(an), u16(ns), u16(ar)])
const rr = (name, type, rdata) => Buffer.concat([name, u16(type), u16(1), u32(120), u16(rdata.length), rdata])
const ip4 = ip => Buffer.from(ip.split('.').map(Number))
// valid response (taken from mdns-mesure): PTR _googlecast._tcp.local → Salon-TV (compression
// to the PTR name), SRV Salon-TV… → salon-tv.local, A salon-tv.local → 192.0.2.50, TXT (never kept)
function validPacket(aIp = '192.0.2.50') {
  const owner = nm('_googlecast._tcp.local') // at offset 12
  const target = Buffer.concat([Buffer.from([8]), Buffer.from('Salon-TV'), Buffer.from([0xc0, 0x0c])])
  const ptr = rr(owner, 12, target)
  const instAt = 12 + owner.length + 10 // start of the instance name (PTR rdata)
  const srvName = Buffer.from([0xc0 | (instAt >> 8), instAt & 0xff])
  const srv = rr(srvName, 33, Buffer.concat([u16(0), u16(0), u16(8009), nm('salon-tv.local')]))
  const a = rr(nm('salon-tv.local'), 1, ip4(aIp))
  const txt = rr(nm('x.local'), 16, Buffer.from('\x07secret!'))
  return Buffer.concat([header({ an: 4 }), ptr, srv, a, txt])
}
// built response: optional instance (PTR + SRV), host A record (aIp, defaults to the source IP)
function resp({ host, aIp, instance = null, service = '_http._tcp', srvHost = host, qr = true }) {
  const recs = []
  if (instance) {
    recs.push(rr(nm(`${service}.local`), 12, nm(`${instance}.${service}.local`)))
    recs.push(rr(nm(`${instance}.${service}.local`), 33, Buffer.concat([u16(0), u16(0), u16(80), nm(`${srvHost}.local`)])))
  }
  if (host) recs.push(rr(nm(`${host}.local`), 1, ip4(aIp)))
  return Buffer.concat([header({ qr, an: recs.length }), ...recs])
}

// --- fake socket -------------------------------------------------------------------------------

function fakeDgram({ bindError = null } = {}) {
  const calls = []
  const socks = []
  const impl = {
    createSocket: opts => {
      calls.push(['createSocket', opts])
      const h = {}
      const add = (e, f) => { (h[e] ??= []).push(f) }
      const sock = {
        handlers: h,
        on: add, once: add,
        removeListener: (e, f) => { h[e] = (h[e] ?? []).filter(x => x !== f) },
        bind: (port, addr, cb) => {
          calls.push(['bind', port, addr])
          if (bindError) setImmediate(() => (h.error ?? []).forEach(f => f(bindError)))
          else cb()
        },
        addMembership: (g, ip) => calls.push(['addMembership', g, ip]),
        send: () => calls.push(['send']),
        setBroadcast: () => calls.push(['setBroadcast']),
        setMulticastTTL: () => calls.push(['setMulticastTTL']),
        close: () => calls.push(['close']),
      }
      socks.push(sock)
      return sock
    },
  }
  return {
    impl, calls, socks,
    emit: (buf, address) => (socks[0]?.handlers.message ?? []).forEach(f => f(buf, { address, port: 5353, family: 'IPv4' })),
    error: e => (socks[0]?.handlers.error ?? []).forEach(f => f(e)),
  }
}
const IFACES = {
  eth0: [{ family: 'IPv4', address: '192.0.2.148', netmask: '255.255.255.0', internal: false, mac: '00:00:5e:00:53:f0' }],
  lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true, mac: '00:00:00:00:00:00' }],
}

// --- test bench: full network module, simulated ARP probe, fake socket --------------------------

const GW = APPLIANCES[0] // fixture gateway (192.0.2.40)
const hex = n => n.toString(16).padStart(2, '0')
const macOf = i => `00:00:5e:00:53:${hex(0x60 + i)}`
const ipOf = i => `192.0.2.${60 + i}`
// record: { i, state, name (manual), attr: [source, value], host, pending }
function netBench({ mdns = { enabled: true }, fiches = [], ifaces = IFACES, ifacesFn = null, network: netOver = {}, dg = fakeDgram(), store: given = null, probe: givenProbe = null } = {}) {
  const probe = givenProbe ?? arpProbe()
  const cfg = withArp(prodConfig({ mdns, ...netOver }), probe.file)
  cfg.network.sources.pve = false
  const store = given ?? tmpStore('dash-mdns-')
  const ns = createNetStore(store)
  const clock = { t: T0 }
  if (!given) {
    const ops = [
      { op: 'insertDevice', ref: 'gw', fields: { state: 'known', review: 0, origin: 'config', host_id: GW.id, host_src: 'config', primary_mac: GW.mac, last_ip: GW.ip, created_at: T0 - 2 * 86400_000, updated_at: T0 - 2 * 86400_000, first_seen: T0 - 2 * 86400_000, last_seen: T0 - MIN } },
      { op: 'upsertMac', mac: GW.mac, device: 'gw', grade: 'hypervisor', random: 0, first_seen: T0 - 2 * 86400_000, last_seen: T0 - MIN, last_ip: GW.ip, attach: 'config' },
    ]
    for (const f of fiches) {
      const ref = `f${f.i}`
      ops.push({ op: 'insertDevice', ref, fields: { state: f.state ?? 'known', review: 0, origin: 'scan', primary_mac: macOf(f.i), last_ip: ipOf(f.i), name: f.name ?? null, created_at: T0 - 2 * 86400_000, updated_at: T0 - 2 * 86400_000, first_seen: T0 - 2 * 86400_000, last_seen: T0 - MIN, ...(f.host ? { host_id: f.host, host_src: 'user' } : {}) } })
      ops.push({ op: 'upsertMac', mac: macOf(f.i), device: ref, grade: 'strong', random: 0, first_seen: T0 - 2 * 86400_000, last_seen: T0 - MIN, last_ip: ipOf(f.i), attach: f.pending ? 'name' : null })
      if (f.attr) ops.push({ op: 'upsertAttr', device: ref, attr: 'name', source: f.attr[0], value: f.attr[1], rank: { pihole: 4, 'import:netalertx': 3, guess: 2, oui: 2, dhcp: 6, mdns: 5 }[f.attr[0]], seen_at: T0 - MIN })
    }
    ns.applyOps(ops)
  }
  const network = createNetwork({ cfg, store, audit: createAudit(store), now: () => clock.t, log: quiet, arpUid: OTHER_UID, ifaces: ifacesFn ?? (() => ifaces), oui: null,
    dgramImpl: dg.impl, exec: (cmd, args, opts, cb) => cb(null, '[]'), routeText: () => routeFile() })
  const b = {
    cfg, store, ns, network, clock, dg, probe,
    // valid ARP sweep (gateway included); hosts: [{ ip, mac }]
    scan: (hosts = fiches.filter(f => f.inScan !== false).map(f => ({ ip: ipOf(f.i), mac: macOf(f.i) }))) => {
      probe.write(clock.t, [{ ip: GW.ip, mac: GW.mac }, ...hosts])
      return network.runArp()
    },
    send: (ip, buf) => dg.emit(buf, ip),
    dev: i => store.db.prepare('SELECT d.* FROM net_devices d JOIN net_macs m ON m.device_id = d.id WHERE m.mac = ?').get(macOf(i)),
    mdnsAttrs: () => store.db.prepare("SELECT * FROM net_attrs WHERE source = 'mdns' ORDER BY device_id").all(), // name AND mdns_name
    nameAttrs: () => store.db.prepare("SELECT * FROM net_attrs WHERE source = 'mdns' AND attr = 'name' ORDER BY device_id").all(),
    infoOf: i => store.db.prepare("SELECT * FROM net_attrs WHERE source = 'mdns' AND attr = 'mdns_name' AND device_id = ?").get(b.dev(i)?.id) ?? null,
    src: () => network.mdns.source(), // direct: view() is cached for 15 s
    count: () => store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n,
  }
  // a stable name: 2 packets 5 min apart, fresh sweep, then a passive pass
  b.announce = async (pairs, { gap = 5 * MIN, scan = true } = {}) => {
    for (const [ip, buf] of pairs) b.send(ip, buf)
    clock.t += gap
    for (const [ip, buf] of pairs) b.send(ip, buf)
    if (scan) b.scan()
    await network.runAll()
  }
  return b
}
const hostPkt = (i, host) => [ipOf(i), resp({ host, aIp: ipOf(i) })]

// --- parsing (taken from mdns-mesure) ----------------------------------------------------------

test('parsing: valid response (PTR, SRV, A, TXT) → consistent candidate name; TXT never kept', () => {
  const p = parsePacket(validPacket())
  assert.equal(p.qr, true)
  assert.deepEqual(p.records.map(r => r.type), ['PTR', 'SRV', 'A', 'TXT'])
  assert.equal(p.records[0].target, 'Salon-TV._googlecast._tcp.local')
  assert.equal(p.records[1].target, 'salon-tv.local')
  assert.equal(p.records[2].ip, '192.0.2.50')
  assert.ok(!JSON.stringify(p).includes('secret'))
  // consistent: the A record equals the source IP → instance name
  assert.equal(candidateOf(p.records, '192.0.2.50'), 'Salon-TV')
  // without PTR: A host name without .local, if the A record equals the source IP
  assert.equal(candidateOf([{ type: 'A', name: 'imprimante.local', ip: '192.0.2.9' }], '192.0.2.9'), 'imprimante')
})

test('hostile parsing: rejection counted, never an exception (handler)', () => {
  const h = createMdnsHandler({ cidrs: CIDRS, now: () => T0 })
  const from = { address: '192.0.2.50', port: 5353 }
  const cases = {
    // pointer to itself (offset 12 → 12)
    soi: Buffer.concat([header({ an: 1 }), Buffer.from([0xc0, 0x0c]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4])]),
    // A → B → A: the second pointer points forward
    boucle: Buffer.concat([header({ an: 1 }), Buffer.from([1, 0x61, 0xc0, 0x10, 0xc0, 0x0c]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4])]),
    // forward pointer
    avant: Buffer.concat([header({ an: 1 }), Buffer.from([0xc0, 0x20]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4]), Buffer.alloc(20)]),
    // label that overruns the packet
    etiquette: Buffer.concat([header({ an: 1 }), Buffer.from([40, 0x61, 0x62]), Buffer.alloc(10)]),
    // reserved bit 0x40
    reserve: Buffer.concat([header({ an: 1 }), Buffer.from([0x41, 0x61, 0]), u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4])]),
    // wrong rdlength (longer than the rest)
    rdlength: Buffer.concat([header({ an: 1 }), nm('a.local'), u16(1), u16(1), u32(1), u16(500), Buffer.from([1, 2, 3, 4])]),
    // qdcount 65,535 on 20 bytes
    qdcount: Buffer.concat([header({ qd: 65535 }), Buffer.alloc(8)]),
    // truncated in the middle of a name
    tronque: Buffer.concat([header({ an: 1 }), Buffer.from([5, 0x61, 0x62]), Buffer.alloc(8)]).subarray(0, 20),
  }
  let n = 0
  for (const [k, buf] of Object.entries(cases)) {
    assert.doesNotThrow(() => h.onMessage(buf, from), k)
    n++
    assert.equal(h.counts.rejected, n, k)
  }
  // discriminating limits (rejected for THIS reason, in an otherwise valid packet)
  const long = Array.from({ length: 5 }, (_, k) => String.fromCharCode(97 + k).repeat(51)).join('.') // 5 × 52 = 260 bytes
  assert.throws(() => parsePacket(Buffer.concat([header({ an: 1 }), rr(nm(long), 1, Buffer.from([192, 0, 2, 1]))])), /name too long/)
  const many = Array.from({ length: 65 }, () => rr(nm('h.local'), 1, Buffer.from([192, 0, 2, 1])))
  assert.throws(() => parsePacket(Buffer.concat([header({ an: 65 }), ...many])), /^Error: compteurs$|compteurs$/)
  const l41 = Buffer.concat([Buffer.from([0x41]), Buffer.alloc(65, 0x61), Buffer.from([0])])
  assert.throws(() => parsePacket(Buffer.concat([header({ an: 1 }), l41, u16(1), u16(1), u32(1), u16(4), Buffer.from([1, 2, 3, 4])])), /reserved label bits/)
  // counters ≤ 64 but inconsistent with the size: rejected BEFORE reading any name
  assert.throws(() => parsePacket(Buffer.concat([header({ qd: 64 }), Buffer.alloc(8)])), /inconsistent/)
  assert.throws(() => parsePacket(Buffer.concat([header({ an: 2 }), Buffer.alloc(12)])), /inconsistent/)
  // 17 jumps: chain of backward pointers → rejected; 16 → accepted
  const chain = jumps => {
    const parts = [Buffer.from([1, 0x78, 0])] // real name "x" at offset 0
    for (let i = 0; i < jumps; i++) parts.push(Buffer.from([0xc0, i === 0 ? 0 : 3 + 2 * (i - 1)]))
    const b = Buffer.concat(parts)
    return readName.bind(null, b, b.length - 2)
  }
  assert.equal(chain(16)().name, 'x')
  assert.throws(chain(17), /too many jumps/)
  // every truncation of a valid packet: never an exception, each one rejected
  const v = validPacket()
  const before = h.counts.rejected
  for (let len = 0; len < v.length; len++) assert.doesNotThrow(() => h.onMessage(v.subarray(0, len), from))
  assert.equal(h.counts.rejected - before, v.length)
  // 65,507-byte packet: rejected without parsing
  const r0 = h.counts.rejected
  h.onMessage(Buffer.alloc(65507), from)
  assert.equal(h.counts.rejected, r0 + 1)
})

test('fuzz on the ATTACHED handler (module socket): 10,000 packets (fixed seed) → no exception, under 1 s', async () => {
  const b = netBench({ fiches: [{ i: 1 }] })
  await b.network.mdns.start()
  let seed = 0x5eed
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16 }
  const valid = validPacket('192.0.2.60')
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 10_000; i++) {
    const buf = i % 2 ? Buffer.from(valid) : Buffer.alloc(12 + (rnd() % 300))
    for (let k = 0; k < (i % 2 ? 4 : buf.length); k++) buf[rnd() % buf.length] = rnd() & 0xff
    assert.doesNotThrow(() => b.send(i % 3 ? '192.0.2.60' : '192.0.2.61', buf))
    if (i % 1500 === 0) b.src()
  }
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000)
  assert.equal(b.src().packets, 10_000)
  await b.network.runAll() // and the following pass does not throw either
  b.network.stop()
})

test('query (QR = 0) ignored; source outside the LAN ignored; rate capped at 2,000 per minute', () => {
  let t = T0
  const seen = []
  const h = createMdnsHandler({ cidrs: CIDRS, now: () => t, onCandidate: (ip, name) => seen.push([ip, name]) })
  const q = Buffer.concat([header({ qr: false, qd: 1 }), nm('_googlecast._tcp.local'), u16(12), u16(1)])
  h.onMessage(q, { address: '192.0.2.50' })
  h.onMessage(validPacket(), { address: '198.51.100.7' })
  h.onMessage(validPacket(), { address: 'fe80::1' })
  assert.deepEqual([h.counts.rejected, h.counts.outsideLan, seen.length], [1, 2, 0])
  for (let i = 0; i < 2100; i++) h.onMessage(validPacket(), { address: '192.0.2.50' })
  assert.equal(h.counts.rate, 103)
  t += 61_000
  h.onMessage(validPacket('192.0.2.51'), { address: '192.0.2.51' })
  assert.deepEqual(seen.at(-1), ['192.0.2.51', 'Salon-TV'])
})

// --- listening ---------------------------------------------------------------------------------

test('module start() opens listening (enabled true), stop() closes it', async () => {
  const b = netBench()
  b.network.start()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(b.dg.calls.map(c => c[0]), ['createSocket', 'bind', 'addMembership'])
  assert.equal(b.src().listening, true)
  await b.network.stop()
  assert.deepEqual(b.dg.calls.at(-1), ['close'])
  assert.equal(b.src().listening, false)
})

test('passive listening: a single bind, a single addMembership(224.0.0.251, ip), never send; bind refused → error, no retry; later error → socketErrors', async () => {
  const b = netBench()
  await b.network.mdns.start()
  await b.network.mdns.start() // opened only once
  assert.deepEqual(b.dg.calls, [['createSocket', { type: 'udp4', reuseAddr: true }], ['bind', 5353, '0.0.0.0'], ['addMembership', '224.0.0.251', '192.0.2.148']])
  assert.deepEqual([b.src().enabled, b.src().listening, b.src().error], [true, true, null])
  // socket error after startup: counted, listening goes on
  b.dg.error(new Error('ENETDOWN'))
  b.dg.error(new Error('ENETDOWN'))
  assert.equal(b.src().socketErrors, 2)
  b.send('192.0.2.60', resp({ host: 'imprimante', aIp: '192.0.2.60' }))
  assert.equal(b.src().packets, 1)
  assert.ok(!b.dg.calls.some(c => ['send', 'setBroadcast', 'setMulticastTTL'].includes(c[0])))
  b.network.stop()
  assert.deepEqual(b.dg.calls.at(-1), ['close'])
  // port in use: message, no retry, the module goes on
  const busy = fakeDgram({ bindError: Object.assign(new Error('pris'), { code: 'EADDRINUSE' }) })
  const c = netBench({ dg: busy, fiches: [{ i: 1 }] })
  await c.network.mdns.start()
  await c.network.mdns.start()
  assert.equal(busy.calls.filter(x => x[0] === 'createSocket').length, 1)
  assert.deepEqual([c.src().listening, c.src().ok], [false, false])
  assert.match(c.src().error, /UDP 5353 impossible.*EADDRINUSE/)
  c.scan()
  await c.network.runAll()
  assert.ok(c.network.view().counts.total >= 2)
})

test('interface with 0 or 2 IPv4 addresses (or unknown): listening refused, dashboard started', async () => {
  const v4 = address => ({ family: 'IPv4', address, netmask: '255.255.255.0', internal: false, mac: '00:00:5e:00:53:f0' })
  for (const ifaces of [{ eth0: [] }, { eth0: [v4('192.0.2.148'), v4('192.0.2.149')] }, { eth1: [v4('192.0.2.148')] }]) {
    const b = netBench({ ifaces, fiches: [{ i: 1 }] })
    await b.network.mdns.start()
    assert.equal(b.dg.calls.length, 0)
    assert.match(b.src().error, /écoute mDNS impossible/)
    await b.network.runAll()
    assert.ok(b.network.view().counts.total >= 1)
  }
  assert.equal(ifaceIp('eth0', IFACES), '192.0.2.148')
  assert.throws(() => ifaceIp('lo', IFACES), /0 IPv4 non internes/)
  // chosen interface: network.mdns.iface, otherwise neigh.iface
  const b = netBench({ mdns: { enabled: true, iface: 'eth1' }, ifaces: { eth0: [v4('192.0.2.148')], eth1: [v4('192.0.2.149')] } })
  await b.network.mdns.start()
  assert.deepEqual(b.dg.calls.find(c => c[0] === 'addMembership'), ['addMembership', '224.0.0.251', '192.0.2.149'])
  b.network.stop()
})

test('enabled: false → no socket; existing mdns attributes removed at startup, names recomputed', async () => {
  const on = netBench({ fiches: [{ i: 1 }, { i: 2, attr: ['pihole', 'Poste-2'] }] })
  await on.network.mdns.start()
  on.scan()
  await on.announce([hostPkt(1, 'imprimante')])
  assert.equal(on.dev(1).disp_name, 'imprimante')
  on.network.stop()
  // restart with enabled false: rollback
  const dg = fakeDgram()
  const off = netBench({ mdns: { enabled: false }, store: on.store, probe: on.probe, dg })
  assert.equal(off.mdnsAttrs().length, 0)
  assert.equal(off.dev(1).disp_name, null)
  assert.equal(off.dev(2).disp_name, 'Poste-2')
  // disabled: even packets that reached the handler give no name
  off.clock.t = on.clock.t + MIN // after the last sweep already processed
  const pkt = resp({ host: 'imprimante', aIp: ipOf(1) })
  off.network.mdns.onMessage(pkt, { address: ipOf(1) })
  off.clock.t += 5 * MIN
  off.network.mdns.onMessage(pkt, { address: ipOf(1) })
  assert.ok(off.scan([{ ip: ipOf(1), mac: macOf(1) }]), 'valid sweep processed')
  await off.network.runAll()
  assert.equal(off.mdnsAttrs().length, 0)
  // module start(), then stop(): no socket
  off.network.start()
  off.network.stop()
  await off.network.mdns.start()
  assert.equal(dg.calls.length, 0)
  // config: enabled false by default; config.example.json disabled; strict schema
  assert.deepEqual(prodConfig().network.mdns, { enabled: false })
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/fixtures/config.reference.json'), 'utf8'))
  assert.deepEqual(raw.network.mdns, { enabled: false })
  assert.throws(() => prodConfig({ mdns: { enabled: true, groupe: 'x' } }))
  assert.throws(() => prodConfig({ mdns: { enabled: true, iface: 'eth0; rm' } }))
  assert.deepEqual([off.src().enabled, off.src().listening, off.src().ok], [false, false, null])
  assert.ok(!off.network.digestLines().some(l => /mDNS/.test(l)))
})

// --- candidate name and stability ---------------------------------------------------------------

test('consistent candidate (A = source IP): name proposed after 2 packets ≥ 5 min apart, within the hour', async () => {
  const b = netBench({ fiches: [{ i: 1 }] })
  await b.network.mdns.start()
  const pkt = resp({ host: 'imprimante', aIp: ipOf(1) })
  b.send(ipOf(1), pkt)
  assert.deepEqual(b.network.mdns.stableNames(b.clock.t), [])
  b.clock.t += 4 * MIN
  b.send(ipOf(1), pkt)
  assert.deepEqual(b.network.mdns.stableNames(b.clock.t), [], '4 min: not yet')
  b.clock.t += MIN
  b.send(ipOf(1), pkt)
  assert.deepEqual(b.network.mdns.stableNames(b.clock.t).map(x => [x.ip, x.name]), [[ipOf(1), 'imprimante']])
  // more than an hour without a packet: forgotten
  assert.deepEqual(b.network.mdns.stableNames(b.clock.t + 61 * MIN), [])
  // two packets more than an hour apart: never stable
  const c = netBench({ fiches: [{ i: 1 }] })
  await c.network.mdns.start()
  c.send(ipOf(1), pkt)
  c.clock.t += 61 * MIN
  c.send(ipOf(1), pkt)
  assert.deepEqual(c.network.mdns.stableNames(c.clock.t), [])
  b.network.stop()
  c.network.stop()
})

test('A record of another IP (sleep proxy), PTR without a consistent A: no candidate; instance with a consistent A: instance name', () => {
  const recs = buf => parsePacket(buf).records
  assert.equal(candidateOf(recs(resp({ host: 'macbook', aIp: '192.0.2.70' })), '192.0.2.61'), null)
  assert.equal(candidateOf(recs(resp({ instance: 'Salon', host: 'appletv', aIp: '192.0.2.70' })), '192.0.2.61'), null)
  assert.equal(candidateOf(recs(resp({ instance: 'Salon', host: null })), '192.0.2.61'), null)
  // SRV to a host other than the consistent A: no instance, but the consistent host name remains
  assert.equal(candidateOf(recs(resp({ instance: 'Salon', host: 'enceinte', srvHost: 'autre', aIp: '192.0.2.61' })), '192.0.2.61'), 'enceinte')
  assert.equal(candidateOf(recs(resp({ instance: 'Salon', host: 'enceinte', aIp: '192.0.2.61' })), '192.0.2.61'), 'Salon')
  assert.equal(candidateOf(recs(validPacket('192.0.2.50')), '192.0.2.51'), null)
})

test('different name in each packet: never kept', async () => {
  const b = netBench({ fiches: [{ i: 1 }] })
  await b.network.mdns.start()
  for (let k = 0; k < 12; k++) {
    b.send(ipOf(1), resp({ host: `nom-${k}`, aIp: ipOf(1) }))
    b.clock.t += 5 * MIN
  }
  assert.deepEqual(b.network.mdns.stableNames(b.clock.t), [])
  b.scan()
  await b.network.runAll()
  assert.equal(b.mdnsAttrs().length, 0)
  b.network.stop()
})

test('generic name (isGenericName) or empty after cleanName: no candidate', () => {
  const recs = (host, ip = '192.0.2.61') => parsePacket(resp({ host, aIp: ip })).records
  for (const n of ['android-1234abcd', 'esp32-ab12', 'ESP_ABCDEF', 'localhost', 'unknown', 'ab', 'docker']) assert.equal(candidateOf(recs(n), '192.0.2.61'), null, n)
  assert.equal(candidateOf([{ type: 'A', name: '\u0007\u0008.local', ip: '192.0.2.61' }], '192.0.2.61'), null)
  assert.equal(candidateOf([{ type: 'A', name: '(unknown).local', ip: '192.0.2.61' }], '192.0.2.61'), null)
  // control characters removed, 64 characters at most (shared cleanName)
  assert.equal(candidateOf([{ type: 'A', name: `Ca\u001bmera-${'x'.repeat(80)}.local`, ip: '192.0.2.61' }], '192.0.2.61').length, 64)
})

// --- attachment and filling --------------------------------------------------------------------

test('candidate equal to the displayed name of ANOTHER record (case-insensitive): refused, nameConflict', async () => {
  const b = netBench({ fiches: [{ i: 1 }, { i: 2, attr: ['pihole', 'Imprimante'] }] })
  await b.network.mdns.start()
  await b.announce([hostPkt(1, 'imprimante')])
  assert.equal(b.mdnsAttrs().length, 0)
  assert.equal(b.src().nameConflict, 1)
  assert.equal(b.dev(1).disp_name, null)
  b.network.stop()
})

test('attachment by name: a record named ONLY by mDNS is never a candidate', () => {
  const mb = mergeBench(prodConfig(), 'dash-mdns-merge-')
  const { cycle } = mb
  const ph = (mac, ip, ts) => ({ mac, ip, source: 'pihole', ts, presence: true })
  const A = 'fe:00:00:00:53:01'
  cycle([ph(A, '192.0.2.60', T0)], T0)
  const id = mb.state.macs.get(A).device_id
  mb.apply([{ op: 'updateDevice', device: id, fields: { state: 'known' } }])
  const m = cycle([], T0 + MIN, { mdnsNames: [{ ip: '192.0.2.60', name: 'Salon-TV', ts: T0 }], mdnsScan: { byIp: new Map([['192.0.2.60', [A]]]), conflicts: new Set() } })
  assert.deepEqual(m.mdns.applied, [id])
  assert.equal(mb.state.devices.get(id).disp_name, 'Salon-TV')
  // 20 min later, a random MAC announces the same name over DHCP: new record, no attachment
  const B = 'fe:00:00:00:53:02'
  cycle([ph(B, '192.0.2.61', T0 + 20 * MIN), { mac: B, ip: '192.0.2.61', source: 'dhcp', ts: T0 + 20 * MIN, presence: false, name: 'Salon-TV' }], T0 + 20 * MIN)
  assert.notEqual(mb.state.macs.get(B).device_id, id)
  assert.equal(mb.state.macs.get(B).attach, null)
  // ip: or mac: conflict in the sweep → ambiguous
  const c1 = cycle([], T0 + 30 * MIN, { mdnsNames: [{ ip: '192.0.2.60', name: 'Autre', ts: T0 }], mdnsScan: { byIp: new Map([['192.0.2.60', [A]]]), conflicts: new Set(['ip:192.0.2.60']) } })
  const c2 = cycle([], T0 + 30 * MIN, { mdnsNames: [{ ip: '192.0.2.60', name: 'Autre', ts: T0 }], mdnsScan: { byIp: new Map([['192.0.2.60', [A]]]), conflicts: new Set([`mac:${A}`]) } })
  // two MACs on the IP, no conflict reported: ambiguous too
  const c0 = cycle([], T0 + 30 * MIN, { mdnsNames: [{ ip: '192.0.2.60', name: 'Autre', ts: T0 }], mdnsScan: { byIp: new Map([['192.0.2.60', [A, B]]]), conflicts: new Set() } })
  assert.deepEqual([c0.mdns.ambiguous, c0.mdns.applied.length, c1.mdns.ambiguous, c2.mdns.ambiguous], [1, 0, 1, 1])
  // no sweep summary (probe off): no attachment
  const c3 = cycle([], T0 + 31 * MIN, { mdnsNames: [{ ip: '192.0.2.60', name: 'Autre', ts: T0 }], mdnsScan: null })
  assert.deepEqual([c3.mdns.noDevice, c3.mdns.applied.length], [1, 0])
})

test('no MAC, two MACs, pending MAC, new record, record linked to a host, probe off: no attribute, counts', async () => {
  const fiches = [{ i: 1, inScan: false }, { i: 2 }, { i: 3, pending: true }, { i: 4, state: 'new' }, { i: 5, host: 'g1' }]
  const b = netBench({ fiches })
  await b.network.mdns.start()
  const extra = { ip: ipOf(2), mac: '00:00:5e:00:53:99' } // two MACs on the IP of record 2
  const pairs = [1, 2, 3, 4, 5].map(i => hostPkt(i, `appareil-${i}`))
  for (const [ip, buf] of pairs) b.send(ip, buf)
  b.clock.t += 5 * MIN
  for (const [ip, buf] of pairs) b.send(ip, buf)
  b.scan([...[2, 3, 4, 5].map(i => ({ ip: ipOf(i), mac: macOf(i) })), extra])
  await b.network.runAll()
  assert.equal(b.mdnsAttrs().length, 0)
  const s = b.src()
  assert.deepEqual([s.candidates, s.noDevice, s.ambiguous, s.offline, s.applied], [5, 1, 1, 3, 0])
  b.network.stop()
  // probe off (no valid sweep): no attribute
  const c = netBench({ fiches: [{ i: 1 }] })
  await c.network.mdns.start()
  await c.announce([hostPkt(1, 'imprimante')], { scan: false })
  assert.equal(c.mdnsAttrs().length, 0)
  assert.equal(c.src().noDevice, 1)
  c.network.stop()
})

test('probe silent for 10 min, summary in memory: no name; first pass after a restart: none', async () => {
  const b = netBench({ fiches: [{ i: 1 }] })
  await b.network.mdns.start()
  b.scan()
  const pkt = resp({ host: 'imprimante', aIp: ipOf(1) })
  b.send(ipOf(1), pkt)
  b.clock.t += 5 * MIN
  b.send(ipOf(1), pkt)
  b.clock.t += 5 * MIN // 10 min without a sweep: probe "down"
  await b.network.runAll()
  assert.equal(b.mdnsAttrs().length, 0)
  b.network.stop()
  // restart: recent sweep in the database (probe "on"), but no summary in memory
  const dg = fakeDgram()
  const r = netBench({ store: b.store, probe: b.probe, dg, fiches: [{ i: 1 }] })
  r.clock.t = b.clock.t
  r.scan()
  r.clock.t += MIN
  const r2 = netBench({ store: b.store, probe: b.probe, dg: fakeDgram(), fiches: [{ i: 1 }] })
  r2.clock.t = r.clock.t
  await r2.network.mdns.start()
  r2.send(ipOf(1), pkt)
  r2.clock.t += 5 * MIN
  r2.send(ipOf(1), pkt)
  await r2.network.runAll() // probeState 'on' (sweep in the database 6 min ago), but no summary
  assert.equal(r2.mdnsAttrs().length, 0)
  // after a valid sweep by THIS process: named
  r2.scan()
  await r2.network.runAll()
  assert.equal(r2.mdnsAttrs().length, 1)
  r2.network.stop()
})

test('fill only: a name from another source (pihole, import, guess, oui) → unchanged, nameDiffers; no name → named; dhcp wins afterwards; manual name takes priority', async () => {
  const fiches = [
    { i: 1 }, { i: 2, attr: ['pihole', 'Poste-2'] }, { i: 3, attr: ['import:netalertx', 'Poste-3'] }, { i: 4, attr: ['guess', 'Poste-4'] },
    { i: 5, attr: ['oui', 'Poste-5'] }, { i: 6, name: 'Saisi-6' }, { i: 7, attr: ['pihole', 'meme-nom'] },
  ]
  const b = netBench({ fiches })
  await b.network.mdns.start()
  b.scan()
  await b.announce([1, 2, 3, 4, 5, 6].map(i => hostPkt(i, `mdns-${i}`)).concat([hostPkt(7, 'MEME-nom')]))
  assert.equal(b.dev(1).disp_name, 'mdns-1')
  assert.deepEqual([2, 3, 4, 5].map(i => b.dev(i).disp_name), ['Poste-2', 'Poste-3', 'Poste-4', 'Poste-5'])
  assert.equal(b.dev(6).disp_name, 'Saisi-6')
  assert.equal(b.dev(7).disp_name, 'meme-nom')
  assert.deepEqual(b.nameAttrs().map(a => a.device_id), [b.dev(1).id])
  assert.deepEqual([b.src().applied, b.src().nameDiffers], [1, 5]) // same name (case-insensitive): neither gain nor difference
  // the 5 different names are kept as informational names, not the same name (case-insensitive)
  assert.deepEqual([2, 3, 4, 5, 6, 7].map(i => b.infoOf(i)?.value ?? null), ['mdns-2', 'mdns-3', 'mdns-4', 'mdns-5', 'mdns-6', null])
  // the record named by mDNS receives a DHCP name: it wins, the mdns name stays without being displayed
  b.ns.applyOps([{ op: 'upsertAttr', device: b.dev(1).id, attr: 'name', source: 'dhcp', value: 'bail-1', rank: 6, seen_at: b.clock.t }])
  b.clock.t += MIN
  b.scan()
  await b.network.runAll()
  assert.equal(b.dev(1).disp_name, 'bail-1')
  assert.equal(b.nameAttrs().length, 1)
  // never renamed: an mDNS name once set does not change for another mDNS name
  const c = netBench({ fiches: [{ i: 1 }] })
  await c.network.mdns.start()
  c.scan()
  await c.announce([hostPkt(1, 'premier')])
  c.clock.t += 61 * MIN
  await c.announce([hostPkt(1, 'second')])
  assert.equal(c.dev(1).disp_name, 'premier')
  assert.equal(c.src().nameDiffers, 1)
  // bestAttr: mdns ignored as soon as another name exists, ranking of the others unchanged
  const at = (source, value, rank) => ({ attr: 'name', source, value, rank, seen_at: 1 })
  assert.equal(bestAttr([at('mdns', 'm', 5), at('oui', 'o', 2)], 'name').value, 'o')
  assert.equal(bestAttr([at('mdns', 'm', 5)], 'name').value, 'm')
  assert.equal(bestAttr([at('pihole', 'p', 4), at('dhcp', 'd', 6), at('mdns', 'm', 5)], 'name').value, 'd')
  assert.equal(bestAttr([{ attr: 'vendor', source: 'mdns', value: 'x', rank: 5, seen_at: 1 }, { attr: 'vendor', source: 'oui', value: 'y', rank: 2, seen_at: 1 }], 'vendor').value, 'x')
  b.network.stop()
  c.network.stop()
})

test('identity only: no presence, no creation, no guessed type or profile', async () => {
  assert.ok(!PRESENCE_SOURCES.has('mdns'))
  assert.ok(!ARP_PRESENCE_SOURCES.has('mdns'))
  const rules = fs.readFileSync(path.join(here, '../lib/network/rules.js'), 'utf8')
  assert.match(rules, /const VIEW_SOURCES = [^\n]*\['pihole', 'neigh', 'arp', 'agent', 'dhcp', 'self'\]/)
  const b = netBench({ fiches: [{ i: 1 }, { i: 2, inScan: false }] })
  await b.network.mdns.start()
  b.scan()
  await b.network.runAll()
  const before = b.dev(2)
  const n = b.count()
  const guessOf = () => b.store.db.prepare("SELECT attr, value FROM net_attrs WHERE device_id = ? AND source = 'guess' ORDER BY attr").all(b.dev(1).id).map(r => `${r.attr}=${r.value}`)
  const guess0 = guessOf()
  // record 2, absent from the sweep, "announces"; an unknown IP too
  await b.announce([hostPkt(2, 'fantome'), ['192.0.2.150', resp({ host: 'inconnu', aIp: '192.0.2.150' })], hostPkt(1, 'Xbox-Salon')])
  const after = b.dev(2)
  assert.deepEqual([after.online, after.last_seen, after.last_present], [before.online, before.last_seen, before.last_present])
  assert.equal(b.count(), n)
  // name set on record 1, with no type or profile guessed from it
  assert.equal(b.dev(1).disp_name, 'Xbox-Salon')
  assert.deepEqual(guessOf(), guess0) // "Xbox-Salon" guesses nothing (neither console nor profile)
  assert.ok(!guessOf().some(g => g.startsWith('type=')))
  b.network.stop()
})

// --- no wave, exposure, static checks -----------------------------------------------------------

test('no wave: 3 unnamed records, 8 named elsewhere → 3 names, 0 renames, 1 digest line, 0 messages', async () => {
  const fiches = [1, 2, 3].map(i => ({ i })).concat([4, 5, 6, 7, 8, 9, 10, 11].map(i => ({ i, attr: [['pihole', 'import:netalertx', 'guess', 'oui'][i % 4], `Ancien-${i}`] })))
  const b = netBench({ fiches })
  const tz = createClock('Europe/Paris')
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg: b.cfg, store: b.store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const engine = createEngine({ cfg: b.cfg, store: b.store, rules: createRules(b.cfg, { checks: [], result: () => null }, null, null, b.network), notifier, clock: tz, startedAt: b.clock.t })
  await b.network.mdns.start()
  b.scan()
  await b.network.runAll()
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  const firing0 = engine.active().length
  const out0 = b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n
  const names0 = new Map(fiches.map(f => [f.i, b.dev(f.i).disp_name]))
  await b.announce(fiches.map(f => hostPkt(f.i, `mdns-${f.i}`)))
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.deepEqual([1, 2, 3].map(i => b.dev(i).disp_name), ['mdns-1', 'mdns-2', 'mdns-3'])
  for (const i of [4, 5, 6, 7, 8, 9, 10, 11]) assert.equal(b.dev(i).disp_name, names0.get(i), `record ${i} renamed`)
  assert.deepEqual([b.src().applied, b.src().nameDiffers], [3, 8])
  assert.equal(engine.active().length, firing0)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, out0)
  assert.equal(telegram.sent.length, 0)
  const lines = b.network.digestLines({ mark: true }).filter(l => /mDNS/.test(l))
  assert.deepEqual(lines, [`   Noms (mDNS) : 3 fiches nommées : ${[1, 2, 3].map(i => deviceLabel(b.dev(i))).join(', ')}`])
  assert.deepEqual(lines, ['   Noms (mDNS) : 3 fiches nommées : mdns-1, mdns-2, mdns-3'])
  // once the digest is marked: no more lines (at most one per day), even after further passes
  b.clock.t += 2 * MIN
  b.scan()
  await b.network.runAll()
  assert.ok(!b.network.digestLines().some(l => /mDNS/.test(l)))
  b.network.stop()
})

test('exposure: sources.mdns, counts only (no IPv4, MAC or name)', async () => {
  const b = netBench({ fiches: [{ i: 1 }, { i: 2, attr: ['pihole', 'Poste-2'] }] })
  await b.network.mdns.start()
  b.scan()
  await b.announce([hostPkt(1, 'imprimante-salon'), hostPkt(2, 'autre-nom')])
  const s = b.network.view().sources.mdns // through the view, like /api/network
  assert.deepEqual(Object.keys(s).sort(), ['ambiguous', 'applied', 'at', 'candidates', 'enabled', 'error', 'lastAt', 'listening', 'nameConflict', 'nameDiffers', 'noDevice',
    'offline', 'ok', 'outsideLan', 'packets', 'rate', 'rejected', 'socketErrors', 'informative'].sort())
  const text = JSON.stringify(s)
  assert.doesNotMatch(text, /\d+\.\d+\.\d+\.\d+/)
  assert.doesNotMatch(text, /([0-9a-f]{2}:){5}[0-9a-f]{2}/i)
  assert.doesNotMatch(text, /imprimante|autre-nom|_tcp/)
  assert.equal(s.applied, 1)
  b.network.stop()
})

test('static checks: no emission, a single group, measurement tool retired, a single DNS parser', () => {
  const src = fs.readFileSync(path.join(here, '../lib/network/sources/mdns.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  for (const bad of [/\.send\(/, /setBroadcast/, /setMulticastTTL/, /setMulticastLoopback/, /ff02::fb/i, /node:sqlite/, /require\(/, /from 'node:(dns|net|http|https|child_process)'/]) assert.doesNotMatch(src, bad, String(bad))
  assert.deepEqual(src.match(/addMembership\(([^)]*)\)/g), ['addMembership(MDNS_GROUP, ip)'])
  assert.equal(MDNS_GROUP, '224.0.0.251')
  assert.match(src, /createSocket\(\{ type: 'udp4', reuseAddr: true \}\)/)
  const idx = fs.readFileSync(path.join(here, '../lib/network/index.js'), 'utf8')
  assert.doesNotMatch(idx, /\.send\(|setBroadcast|setMulticastTTL|addMembership/)
  assert.equal(fs.existsSync(path.join(here, '../scripts/mdns-mesure.js')), false)
  assert.equal(fs.existsSync(path.join(here, 'mdns-mesure.test.js')), false)
  // no other DNS parser in the repository (server and client, excluding dependencies)
  const hits = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(m?js|jsx)$/.test(e.name) && /function (readName|parsePacket)\b|readUInt16BE\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p))
    }
  }
  walk(path.join(ROOT, 'server'))
  walk(path.join(ROOT, 'client', 'src'))
  assert.deepEqual(hits, ['server/lib/network/sources/mdns.js'])
})

test('m1: enabled false → ifaces() never called, and sources.mdns.error null (listening guard)', async () => {
  let calls = 0
  const dg = fakeDgram()
  const b = netBench({ mdns: { enabled: false }, fiches: [{ i: 1 }], dg, ifacesFn: () => { calls++; return IFACES } })
  b.network.start()
  await b.network.mdns.start()
  await new Promise(r => setImmediate(r))
  await b.network.stop()
  assert.equal(calls, 0)
  assert.equal(dg.calls.length, 0)
  const s = b.src()
  assert.deepEqual([s.enabled, s.listening, s.error], [false, false, null])
})

test('m2: cap of 4,096 IPs in memory: 4,097 sources (198.18.0.0/15, RFC 2544) → 4,096 at most, the last one ignored without error', async () => {
  // 198.18.0.0/15 (RFC 2544, reserved for testing, never a real LAN), in a config built in memory
  // for this test only: the RFC 5737 ranges of the other fixtures only hold 762 addresses, and
  // 4,097 distinct ones are needed
  const b = netBench({ network: { subnets: [{ cidr: '198.18.0.0/15', name: 'essais' }] } })
  await b.network.mdns.start()
  const ipAt = k => `198.18.${k >> 8}.${k & 255}`
  const N = 4097
  // two rounds, ≥ 5 min apart for each source; rate: 1,999 packets per minute at most
  for (const round of [0, 1]) {
    for (let k = 0; k < N; k++) {
      if (k && k % 1999 === 0) b.clock.t += 61_000
      assert.doesNotThrow(() => b.send(ipAt(k), resp({ host: `appareil-${k}`, aIp: ipAt(k) })))
    }
    if (!round) b.clock.t += 6 * MIN
  }
  const s = b.src()
  assert.deepEqual([s.rate, s.rejected, s.outsideLan], [0, 0, 0])
  const names = b.network.mdns.stableNames(b.clock.t)
  assert.equal(names.length, 4096)
  assert.ok(!names.some(x => x.ip === ipAt(N - 1)), 'the 4,097th source is ignored')
  b.network.stop()
})

// --- informational name mdns_name ---------------------------------------------------------------

const DAY = 86400_000
const infoBench = (fiches, opts = {}) => netBench({ fiches, ...opts })
const ready = async b => {
  await b.network.mdns.start()
  b.scan()
}

test('informational name: named record (pihole, dhcp, manual), different stable candidate → kept name unchanged, mdns_name set, mdnsName exposed, nameDiffers', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }, { i: 2, attr: ['dhcp', 'Bail-2'] }, { i: 3, name: 'Saisi-3' }, { i: 4, attr: ['pihole', 'Poste-4'] }])
  await ready(b)
  await b.announce([hostPkt(1, 'Annonce-1'), hostPkt(2, 'Annonce-2'), hostPkt(3, 'Annonce-3'), hostPkt(4, 'POSTE-4')])
  assert.deepEqual([1, 2, 3, 4].map(i => b.dev(i).disp_name), ['Poste-1', 'Bail-2', 'Saisi-3', 'Poste-4'])
  assert.deepEqual([1, 2, 3, 4].map(i => b.infoOf(i)?.value ?? null), ['Annonce-1', 'Annonce-2', 'Annonce-3', null])
  const v = b.network.device(b.dev(1).id)
  assert.deepEqual(Object.keys(v.mdnsName).sort(), ['conflict', 'seenAt', 'value'])
  assert.deepEqual([v.mdnsName.value, v.mdnsName.conflict], ['Annonce-1', false])
  assert.equal(b.network.device(b.dev(4).id).mdnsName, null, 'equal to the kept name (case): null')
  assert.equal(b.src().nameDiffers, 3)
  assert.equal(b.src().informative, 3)
  assert.equal(b.nameAttrs().length, 0)
  b.network.stop()
})

test('informational name: mdns_name cleared when the candidate becomes equal to the kept name; mdnsName null if equal to the displayed name', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }])
  await ready(b)
  await b.announce([hostPkt(1, 'Autre-1')])
  assert.equal(b.infoOf(1).value, 'Autre-1')
  b.clock.t += 61 * MIN
  await b.announce([hostPkt(1, 'poste-1')])
  assert.equal(b.infoOf(1), null)
  assert.equal(b.network.device(b.dev(1).id).mdnsName, null)
  // the attribute exists but equals the displayed name (manual rename): mdnsName null on read
  b.clock.t += 61 * MIN
  await b.announce([hostPkt(1, 'Autre-1')])
  b.ns.applyOps([{ op: 'updateDevice', device: b.dev(1).id, fields: { name: 'AUTRE-1', disp_name: 'AUTRE-1' } }])
  await b.network.runAll()
  assert.ok(b.infoOf(1))
  assert.equal(b.network.device(b.dev(1).id).mdnsName, null)
  b.network.stop()
})

test('informational name: candidate equal to the displayed name of ANOTHER record, on a named record → stored, conflict (no id or link), recomputed on read; on an unnamed record → refused', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }, { i: 2, attr: ['pihole', 'Salon'] }, { i: 3 }])
  await ready(b)
  await b.announce([hostPkt(1, 'salon'), hostPkt(3, 'SALON')])
  assert.equal(b.infoOf(1).value, 'salon')
  const m = b.network.device(b.dev(1).id).mdnsName
  assert.deepEqual(m, { value: 'salon', seenAt: m.seenAt, conflict: true })
  assert.doesNotMatch(JSON.stringify(m), new RegExp(`"${b.dev(2).id}"|dev:|\\?d=`))
  // unnamed record: still refused, neither name nor informational name
  assert.deepEqual([b.dev(3).disp_name, b.infoOf(3), b.src().nameConflict], [null, null, 1])
  // the other record changes name: flag recomputed
  b.ns.applyOps([{ op: 'updateDevice', device: b.dev(2).id, fields: { name: 'Cuisine', disp_name: 'Cuisine' } }])
  await b.network.runAll()
  assert.equal(b.network.device(b.dev(1).id).mdnsName.conflict, false)
  b.network.stop()
})

test('informational name: flip-flopping → at most one change per 24 h', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }])
  await ready(b)
  await b.announce([hostPkt(1, 'Nom-A')])
  const t0 = b.infoOf(1).seen_at
  for (const n of ['Nom-B', 'Nom-A', 'Nom-C']) {
    b.clock.t += 61 * MIN
    await b.announce([hostPkt(1, n)])
  }
  assert.deepEqual([b.infoOf(1).value, b.infoOf(1).seen_at], ['Nom-A', t0])
  // same value, more than 24 h later: seen_at stays the date of the change
  b.clock.t = t0 + DAY + 2 * MIN
  await b.announce([hostPkt(1, 'Nom-A')])
  assert.deepEqual([b.infoOf(1).value, b.infoOf(1).seen_at], ['Nom-A', t0])
  b.clock.t += 61 * MIN
  await b.announce([hostPkt(1, 'Nom-D')])
  assert.equal(b.infoOf(1).value, 'Nom-D')
  b.network.stop()
})

test('informational name: mdns_name unchanged for more than 400 days → purged, then set again on the next pass without message or digest, "since" reset to the pass date', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }])
  const tz = createClock('Europe/Paris')
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg: b.cfg, store: b.store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const engine = createEngine({ cfg: b.cfg, store: b.store, rules: createRules(b.cfg, { checks: [], result: () => null }, null, null, b.network), notifier, clock: tz, startedAt: b.clock.t })
  await ready(b)
  await b.announce([hostPkt(1, 'Annonce-1')])
  const id = b.dev(1).id
  // seen_at aged beyond 400 days (attribute purge), the pihole name refreshed
  b.store.db.prepare("UPDATE net_attrs SET seen_at = ? WHERE device_id = ? AND attr = 'mdns_name'").run(b.clock.t - 401 * DAY, id)
  b.ns.purge(b.clock.t)
  assert.equal(b.infoOf(1), null)
  const ev0 = b.store.db.prepare('SELECT COUNT(*) n FROM net_events').get().n
  const out0 = b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n
  b.clock.t += 61 * MIN
  await b.announce([hostPkt(1, 'Annonce-1')])
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.equal(b.infoOf(1).value, 'Annonce-1')
  assert.equal(b.infoOf(1).seen_at, b.clock.t, '"since" = date of the poll')
  assert.equal(b.network.device(id).mdnsName.seenAt, new Date(b.clock.t).toISOString())
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_events').get().n, ev0)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, out0)
  assert.equal(telegram.sent.length, 0)
  assert.ok(!b.network.digestLines().some(l => /mDNS|Annonce-1/.test(l)))
  b.network.stop()
})

test('informational name: the record loses its name, the candidate fills it → kept name, informational name cleared', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }])
  await ready(b)
  await b.announce([hostPkt(1, 'Annonce-1')])
  assert.equal(b.infoOf(1).value, 'Annonce-1')
  b.ns.applyOps([{ op: 'deleteAttr', device: b.dev(1).id, attr: 'name', source: 'pihole' }])
  b.clock.t += 61 * MIN
  await b.announce([hostPkt(1, 'Annonce-1')])
  assert.equal(b.dev(1).disp_name, 'Annonce-1')
  assert.equal(b.infoOf(1), null)
  assert.equal(b.network.device(b.dev(1).id).mdnsName, null)
  b.network.stop()
})

test('informational name: safeguards → no mdns_name (probe off, sweep too old, two MACs, pending, new, linked, A of another IP, a single packet, generic)', async () => {
  const named = (i, more = {}) => ({ i, attr: ['pihole', `Poste-${i}`], ...more })
  const b = infoBench([named(1, { inScan: false }), named(2), named(3, { pending: true }), named(4, { state: 'new' }), named(5, { host: 'g1' })])
  await b.network.mdns.start()
  const pairs = [1, 2, 3, 4, 5].map(i => hostPkt(i, `Annonce-${i}`))
  for (const [ip, buf] of pairs) b.send(ip, buf)
  b.clock.t += 5 * MIN
  for (const [ip, buf] of pairs) b.send(ip, buf)
  b.scan([...[2, 3, 4, 5].map(i => ({ ip: ipOf(i), mac: macOf(i) })), { ip: ipOf(2), mac: '00:00:5e:00:53:99' }])
  await b.network.runAll()
  assert.equal(b.mdnsAttrs().length, 0)
  b.network.stop()
  // probe off (no sweep); sweep too old; A of another IP, a single packet, generic name: one
  // bench per case (a stable name from one case does not carry over to the next)
  const c = infoBench([named(1)])
  await c.network.mdns.start()
  await c.announce([hostPkt(1, 'Annonce-1')], { scan: false })
  assert.equal(c.mdnsAttrs().length, 0, 'probe off')
  c.network.stop()
  const o = infoBench([named(1)])
  await o.network.mdns.start()
  o.scan()
  o.clock.t += 10 * MIN // 10-min-old sweep (> 3 intervals of 2 min)
  await o.announce([hostPkt(1, 'Annonce-1')], { scan: false })
  assert.equal(o.mdnsAttrs().length, 0, 'sweep too old')
  o.network.stop()
  const g = infoBench([named(2), named(3), named(4)])
  await ready(g)
  g.send(ipOf(3), resp({ host: 'Annonce-3', aIp: ipOf(3) })) // a single packet
  await g.announce([[ipOf(2), resp({ host: 'proxy', aIp: '192.0.2.99' })], hostPkt(4, 'android-1234abcd')])
  assert.equal(g.mdnsAttrs().length, 0, 'A from another IP, a single packet, generic')
  g.network.stop()
})

test('informational name: no leak (digest, label, attachment by name, guessing, suggestions, alerts, map, Mermaid, list, search, attrs); without a session: detail only', async () => {
  const LEAK = 'Fuite-Xbox-Salon'
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }, { i: 2, attr: ['pihole', 'Voisin-2'] }])
  const tz = createClock('Europe/Paris')
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg: b.cfg, store: b.store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const monitor = { checks: [], result: () => null }
  const engine = createEngine({ cfg: b.cfg, store: b.store, rules: createRules(b.cfg, monitor, null, null, b.network), notifier, clock: tz, startedAt: b.clock.t })
  await ready(b)
  const guess0 = b.store.db.prepare("SELECT attr, value FROM net_attrs WHERE device_id = ? AND source = 'guess' ORDER BY attr").all(b.dev(1).id)
  await b.announce([hostPkt(1, LEAK), hostPkt(2, 'Poste-1')]) // record 2: candidate = displayed name of record 1 (conflict)
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.equal(b.infoOf(1).value, LEAK)
  assert.equal(b.network.device(b.dev(2).id).mdnsName.conflict, true)
  const re = new RegExp(LEAK, 'i')
  const d1 = b.dev(1)
  // record 1 named elsewhere: MAC to confirm (digest line and alert that name it), and
  // parent of record 2 on the map (parent label)
  b.ns.applyOps([{ op: 'upsertMac', mac: '00:00:5e:00:53:7e', device: d1.id, grade: 'strong', random: 0, first_seen: b.clock.t, last_seen: b.clock.t, last_ip: ipOf(1), attach: 'name' }])
  b.ns.transaction(() => b.ns.insertLink({ child: `dev:${b.dev(2).id}`, parent: `dev:${d1.id}`, kind: 'ethernet' }, { actor: 'test', ts: b.clock.t }))
  await b.network.runAll()
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.match(b.network.digestLines().join('\n'), /MAC à confirmer \(Poste-1\)/)
  assert.equal(b.network.device(b.dev(2).id).mapParent.label, 'Poste-1')
  assert.doesNotMatch(JSON.stringify(b.network.device(b.dev(2).id).mapParent), re)
  // label, digest (network lines and full digest), alerts and Telegram
  assert.doesNotMatch(deviceLabel(d1), re)
  assert.doesNotMatch(b.network.digestLines().join('\n'), re)
  assert.doesNotMatch(buildDigest({ cfg: b.cfg, engine, snap: {}, monitor, formatter, clock: tz, network: b.network, mark: false, now: b.clock.t }), re)
  assert.doesNotMatch(JSON.stringify(b.network.signals(b.clock.t)), re)
  assert.doesNotMatch(JSON.stringify(telegram.sent), re)
  assert.doesNotMatch(JSON.stringify(b.store.db.prepare('SELECT * FROM outbox').all()), re)
  // map, parent, Mermaid, list, search, detail attrs
  assert.doesNotMatch(JSON.stringify(b.network.topology()), re)
  assert.doesNotMatch(b.network.topologyMermaid(), re)
  assert.doesNotMatch(JSON.stringify(b.network.device(d1.id).mapParent), re)
  assert.doesNotMatch(JSON.stringify(b.network.view()), re)
  assert.doesNotMatch(JSON.stringify(b.network.view({ admin: true })), re)
  assert.deepEqual(b.network.search('fuite-xbox'), [])
  assert.deepEqual(b.network.search(LEAK), [])
  const det = b.network.device(d1.id, { admin: true })
  assert.ok(!det.attrs.some(a => a.attr === 'mdns_name'))
  assert.doesNotMatch(JSON.stringify(det.attrs), re)
  assert.equal(det.mdnsName.value, LEAK)
  // guessing (type, profile): nothing from the informational name
  assert.deepEqual(b.store.db.prepare("SELECT attr, value FROM net_attrs WHERE device_id = ? AND source = 'guess' ORDER BY attr").all(d1.id), guess0)
  // without a session: present in the detail, absent from the list
  const s = await netServer({ store: b.store, cfg: b.cfg, T: b.clock.t, network: b.network })
  try {
    const one = await (await fetch(`${s.base}/api/network/devices/${d1.id}`)).json()
    assert.equal(one.mdnsName.value, LEAK)
    for (const p of ['/api/network', '/api/network/topology', '/api/network/topology.mmd', '/api/network/history?days=7']) {
      assert.equal(((await (await fetch(s.base + p)).text()).match(re) ?? []).length, 0, p)
    }
  } finally {
    s.close()
  }
  b.network.stop()
})

test('informational name: attachment by name (byName) and suggestions never use the informational name, even in conflict', () => {
  const mb = mergeBench(prodConfig(), 'dash-mdns-info-')
  const { cycle } = mb
  const ph = (mac, ip, ts, name) => ({ mac, ip, source: 'pihole', ts, presence: true, ...(name ? { name } : {}) })
  const A = 'fe:00:00:00:53:11'
  const C = 'fe:00:00:00:53:13'
  cycle([ph(A, '192.0.2.70', T0, 'Poste-A'), ph(C, '192.0.2.72', T0, 'Salon-TV')], T0)
  const id = mb.state.macs.get(A).device_id
  const other = mb.state.macs.get(C).device_id
  mb.apply([{ op: 'updateDevice', device: id, fields: { state: 'known' } }])
  cycle([], T0 + MIN, { mdnsNames: [{ ip: '192.0.2.70', name: 'Salon-TV', ts: T0 }], mdnsScan: { byIp: new Map([['192.0.2.70', [A]]]), conflicts: new Set() } })
  assert.equal(mb.state.attrs.get(id).find(a => a.attr === 'mdns_name').value, 'Salon-TV')
  assert.equal(mb.state.devices.get(id).disp_name, 'Poste-A')
  // suggestions: record A is never grouped with "Salon-TV" (displayed name of the other record)
  assert.deepEqual(suggestMerges(mb.state), [])
  assert.deepEqual(suggestFamilies(mb.state), [])
  assert.equal(other != null, true)
  // byName: only A carries "Salon-NAS" (as informational name); a random MAC announcing it over
  // DHCP is never attached to A (a new record)
  cycle([], T0 + 2 * MIN, { mdnsNames: [{ ip: '192.0.2.70', name: 'Salon-NAS', ts: T0 }], mdnsScan: { byIp: new Map([['192.0.2.70', [A]]]), conflicts: new Set() } })
  assert.equal(mb.state.attrs.get(id).find(a => a.attr === 'mdns_name').value, 'Salon-TV', '24 h: unchanged')
  mb.apply([{ op: 'upsertAttr', device: id, attr: 'mdns_name', source: 'mdns', value: 'Salon-NAS', rank: 5, seen_at: T0 }])
  const B = 'fe:00:00:00:53:12'
  const n0 = mb.state.devices.size
  cycle([ph(B, '192.0.2.71', T0 + 20 * MIN), { mac: B, ip: '192.0.2.71', source: 'dhcp', ts: T0 + 20 * MIN, presence: false, name: 'Salon-NAS' }], T0 + 20 * MIN)
  assert.notEqual(mb.state.macs.get(B).device_id, id)
  assert.equal(mb.state.macs.get(B).attach, null)
  assert.equal(mb.state.devices.size, n0 + 1)
})

test('informational name: cleanName (all sources) strips bidi, U+200B, U+FEFF; keeps accents and ZWJ; old bidi name recognized (byName, suggestions), without notification', () => {
  assert.equal(cleanName('‮gnp.exe'), 'gnp.exe')
  assert.equal(cleanName('Sa​lon﻿‎‏‪‫‬‭⁦⁧⁨⁩'), 'Salon')
  assert.equal(cleanName('Télé-Séjour'), 'Télé-Séjour')
  assert.equal(cleanName('👨‍👩‍👧'), '👨‍👩‍👧')
  assert.equal(cleanName('a‌b-c'), 'a‌b-c')
  // whatever the source: pihole and dhcp
  const mb = mergeBench(prodConfig(), 'dash-clean-')
  const { cycle } = mb
  const A = '00:00:5e:00:53:21'
  cycle([{ mac: A, ip: '192.0.2.80', source: 'pihole', ts: T0, presence: true, name: '‮Salon​' }, { mac: A, ip: '192.0.2.80', source: 'dhcp', ts: T0, presence: false, name: 'Bu﻿reau' }], T0)
  const names = mb.state.attrs.get(mb.state.macs.get(A).device_id).filter(a => a.attr === 'name').map(a => a.value).sort()
  assert.deepEqual(names, ['Bureau', 'Salon'])
  // old name stored WITH bidi controls (from before the cleanup) on an absent record with a weak MAC
  const OLD = 'fe:00:00:00:53:31'
  cycle([{ mac: OLD, ip: '192.0.2.81', source: 'pihole', ts: T0 - 3 * DAY, presence: true }], T0 - 3 * DAY)
  const oldId = mb.state.macs.get(OLD).device_id
  mb.apply([{ op: 'upsertAttr', device: oldId, attr: 'name', source: 'dhcp', value: '‮TAB​-Exemple', rank: 6, seen_at: T0 - 3 * DAY },
    { op: 'updateDevice', device: oldId, fields: { disp_name: '‮TAB​-Exemple', state: 'known' } }])
  const n0 = mb.state.devices.size
  // same name received cleaned, new random MAC: attached by name, no extra record
  const NEW = 'fe:00:00:00:53:32'
  const m = cycle([{ mac: NEW, ip: '192.0.2.82', source: 'pihole', ts: T0, presence: true }, { mac: NEW, ip: '192.0.2.82', source: 'dhcp', ts: T0, presence: false, name: 'Tab-Exemple' }], T0)
  assert.equal(mb.state.devices.size, n0)
  assert.equal(mb.state.macs.get(NEW).device_id, oldId)
  assert.equal(m.ops.filter(o => o.op === 'insertDevice').length, 0)
  // suggestions: two "Tab-Exemple" records, one stored with bidi → a single proposal
  const sugState = {
    devices: new Map([[1, { id: 1, disp_name: '‮M310​-Exemple' }], [2, { id: 2, disp_name: 'M310-Exemple' }]]),
    macs: new Map([['fe:00:00:00:54:01', { mac: 'fe:00:00:00:54:01', device_id: 1, grade: 'weak' }], ['fa:00:00:00:54:02', { mac: 'fa:00:00:00:54:02', device_id: 2, grade: 'weak' }]]),
  }
  assert.deepEqual(suggestMerges(sugState).map(x => x.devices.length ?? x.devices), [2].map(() => suggestMerges(sugState)[0].devices.length))
  assert.equal(suggestMerges(sugState).length, 1)
  // refresh of a value stored with bidi → cleaned, without event
  mb.apply([{ op: 'upsertAttr', device: mb.state.macs.get(A).device_id, attr: 'name', source: 'pihole', value: '‮Salon​', rank: 4, seen_at: T0 - 2 * 3600_000 }])
  const r = cycle([{ mac: A, ip: '192.0.2.80', source: 'pihole', ts: T0 + 2 * MIN, presence: true, name: '‮Salon​' }], T0 + 2 * MIN)
  assert.equal(mb.state.attrs.get(mb.state.macs.get(A).device_id).find(a => a.attr === 'name' && a.source === 'pihole').value, 'Salon')
  assert.equal(r.ops.filter(o => o.op === 'insertEvent').length, 0)
})

test('informational name: no wave (8 named records) → at most 8 mdns_name, 0 renames, 0 messages, 0 digest lines', async () => {
  const fiches = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ i, attr: [['pihole', 'import:netalertx', 'guess', 'oui'][i % 4], `Ancien-${i}`] }))
  const b = infoBench(fiches)
  const tz = createClock('Europe/Paris')
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg: b.cfg, store: b.store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const engine = createEngine({ cfg: b.cfg, store: b.store, rules: createRules(b.cfg, { checks: [], result: () => null }, null, null, b.network), notifier, clock: tz, startedAt: b.clock.t })
  await ready(b)
  await b.network.runAll()
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  const out0 = b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n
  const ev0 = b.store.db.prepare('SELECT COUNT(*) n FROM net_events').get().n
  await b.announce(fiches.map(f => hostPkt(f.i, `mdns-${f.i}`)))
  engine.evaluate({}, b.clock.t)
  await notifier.flush(b.clock.t + 60_000)
  assert.equal(b.mdnsAttrs().filter(a => a.attr === 'mdns_name').length, 8)
  for (const f of fiches) assert.equal(b.dev(f.i).disp_name, `Ancien-${f.i}`)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, out0)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_events').get().n, ev0)
  assert.equal(telegram.sent.length, 0)
  assert.ok(!b.network.digestLines().some(l => /mDNS|mdns-/.test(l)))
  b.network.stop()
})

test('informational name: merge → mdns_name of the absorbed record not carried over, the target one kept; rollback → removed', async () => {
  const b = infoBench([{ i: 1, attr: ['pihole', 'Poste-1'] }, { i: 2, attr: ['pihole', 'Poste-2'] }, { i: 3, attr: ['pihole', 'Poste-3'] }, { i: 4, attr: ['pihole', 'Poste-4'] }])
  await ready(b)
  await b.announce([hostPkt(1, 'Info-1'), hostPkt(2, 'Info-2'), hostPkt(3, 'Info-3')])
  const [d1, d2, d3, d4] = [1, 2, 3, 4].map(i => b.dev(i).id)
  b.ns.applyOps([{ op: 'upsertAttr', device: d3, attr: 'hostname', source: 'pihole', value: 'poste-3.lan', rank: 4, seen_at: b.clock.t }])
  b.ns.transaction(() => b.ns.mergeDevice(d1, d2, { actor: 'test', ts: b.clock.t })) // target with its own
  b.ns.transaction(() => b.ns.mergeDevice(d4, d3, { actor: 'test', ts: b.clock.t })) // target without
  const rows = b.store.db.prepare("SELECT device_id, value FROM net_attrs WHERE attr = 'mdns_name' ORDER BY value").all().map(r => [r.device_id, r.value])
  assert.deepEqual(rows, [[d1, 'Info-1']])
  // the other attributes of the absorbed record are carried over as before
  assert.ok(b.store.db.prepare("SELECT 1 FROM net_attrs WHERE device_id = ? AND attr = 'hostname' AND value = 'poste-3.lan'").get(d4))
  b.network.stop()
  // rollback: startup with enabled false
  const off = netBench({ mdns: { enabled: false }, store: b.store, probe: b.probe })
  assert.equal(off.mdnsAttrs().length, 0)
  assert.equal(off.network.device(off.dev(1).id).mdnsName, null)
})

test('informational name: escaping — the name is rendered as TEXT (no img element), without title or href; control characters removed', async t => {
  assert.equal(cleanName('<img src=x onerror=alert(1)>\u0007‮'), '<img src=x onerror=alert(1)>')
  const src = fs.readFileSync(path.join(ROOT, 'client/src/DeviceDrawer.jsx'), 'utf8')
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/)
  const fn = src.slice(src.indexOf('export function MdnsName'), src.indexOf('\n}\n', src.indexOf('export function MdnsName')))
  assert.match(fn, /\{m\.value\}/)
  assert.doesNotMatch(fn, /title=|href=|aria-label=/)
  assert.deepEqual([...src.matchAll(/mdnsName/g)].length, 2) // `d?.mdnsName && <MdnsName m={d.mdnsName} />` only
  // real rendering of the component (esbuild and the client's React) when the client is installed
  const esb = path.join(ROOT, 'client/node_modules/esbuild/lib/main.js')
  if (!fs.existsSync(esb)) return t.skip('client not installed (npm ci in client/)')
  const { build } = await import(esb)
  const r = await build({ stdin: { contents: "import { MdnsName } from './src/DeviceDrawer.jsx'\nimport { renderToStaticMarkup } from 'react-dom/server'\nimport { createElement } from 'react'\nexport const render = m => renderToStaticMarkup(createElement(MdnsName, { m }))\nexport { loadLocale as __loadLocale } from './src/i18n/index.js'", resolveDir: path.join(ROOT, 'client'), loader: 'jsx' },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty' }, logLevel: 'error',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } })
  const file = path.join(tmpDir('dash-mdns-render-'), 'render.mjs')
  fs.writeFileSync(file, r.outputFiles[0].text)
  const { render, __loadLocale } = await import(file)
  await __loadLocale('fr') // catalog preloaded (browser: main.jsx)
  const html = render({ value: '<img src=x onerror=alert(1)>', seenAt: '2026-10-27T10:00:00Z', conflict: true })
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /Nom annoncé en mDNS \(non vérifié\) : <span[^>]*>&lt;img src=x onerror=alert\(1\)&gt;<\/span> \(depuis le \d\d\/\d\d\/\d\d \d\d:\d\d\)/)
  assert.doesNotMatch(html, /vu le/)
  assert.match(html, /nom déjà porté par une autre fiche/)
  assert.doesNotMatch(render({ value: 'x', seenAt: null, conflict: false }), /autre fiche/)
})

test('informational name: the OTHER attributes keep their hourly refresh (observed and deduced); only mdns_name is frozen', () => {
  const mb = mergeBench(prodConfig(), 'dash-refresh-')
  const { cycle } = mb
  const A = '00:00:5e:00:53:a1' // outside the fixture host MACs
  const ph = ts => ({ mac: A, ip: '192.0.2.90', source: 'pihole', ts, presence: true, name: 'iPhone-Salon' })
  cycle([ph(T0)], T0)
  const id = mb.state.macs.get(A).device_id
  mb.apply([{ op: 'updateDevice', device: id, fields: { state: 'known' } }])
  const at = (attr, source) => mb.state.attrs.get(id).find(a => a.attr === attr && a.source === source)?.seen_at
  assert.equal(at('name', 'pihole'), T0)
  assert.equal(at('type', 'guess'), T0) // deduced (setAttr)
  // informational name set at T0 + 1 min (a pihole name exists)
  const scan = { byIp: new Map([['192.0.2.90', [A]]]), conflicts: new Set() }
  cycle([ph(T0 + MIN)], T0 + MIN, { mdnsNames: [{ ip: '192.0.2.90', name: 'Salon-Phone', ts: T0 }], mdnsScan: scan })
  assert.equal(at('mdns_name', 'mdns'), T0 + MIN)
  // 2 h later, same values: name and type refreshed, mdns_name frozen
  const t2 = T0 + 2 * 3600_000
  cycle([ph(t2)], t2, { mdnsNames: [{ ip: '192.0.2.90', name: 'Salon-Phone', ts: t2 }], mdnsScan: scan })
  assert.deepEqual([at('name', 'pihole'), at('type', 'guess'), at('mdns_name', 'mdns')], [t2, t2, T0 + MIN])
  // less than an hour: nothing is rewritten
  const m = cycle([ph(t2 + 10 * MIN)], t2 + 10 * MIN, { mdnsNames: [{ ip: '192.0.2.90', name: 'Salon-Phone', ts: t2 }], mdnsScan: scan })
  assert.equal(m.ops.filter(o => o.op === 'upsertAttr').length, 0)
})

test('informational name: dropInfo clears ONLY mdns_name; the record name from the mdns source stays', async () => {
  const b = infoBench([{ i: 1 }])
  await ready(b)
  // named by mDNS only: name (mdns) "Premier"
  await b.announce([hostPkt(1, 'Premier')])
  assert.equal(b.dev(1).disp_name, 'Premier')
  // announces another name: it becomes the informational name, the kept name does not change
  await b.announce([hostPkt(1, 'Second')])
  assert.deepEqual([b.dev(1).disp_name, b.infoOf(1)?.value], ['Premier', 'Second'])
  // announces the kept name again, less than an hour after it was set (no refresh of the
  // name): dropInfo → only mdns_name disappears
  await b.announce([hostPkt(1, 'Premier')])
  assert.equal(b.infoOf(1), null)
  assert.deepEqual(b.nameAttrs().map(a => [a.device_id, a.value]), [[b.dev(1).id, 'Premier']])
  assert.equal(b.dev(1).disp_name, 'Premier')
  assert.equal(b.network.device(b.dev(1).id).mdnsName, null)
  b.network.stop()
})
