// arp source: parseArp (pure) and readArp (missing file, ts, safeguards), and the config
// schema that restricts the path to /run/net-scan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArp, readArp } from '../lib/network/sources/arp.js'
import { selfSightings } from '../lib/network/sources/self.js'
import { parseCidr } from '../lib/net/ip.js'
import { parseConfig } from '../lib/config.js'
import { arpProbe, OTHER_UID } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const cidrs = [parseCidr('192.0.2.0/24')]
const file = (hosts, extra = {}) => JSON.stringify({ v: 1, ts: T, iface: 'eth0', cidr: '192.0.2.0/24', ms: 2300, ok: true, hosts, ...extra })
const h = (ip, mac, o = {}) => ({ ip, mac, hdrmac: mac, dup: 0, ...o })

test('parseArp: valid file, safeguards, IP outside the CIDR, invalid MAC, version, future ts', () => {
  const r = parseArp(file([h('192.0.2.10', '00:00:5E:00:53:10'), h('192.0.2.254', '00:00:5e:00:53:fe')]), { cidrs, now: T + 1000 })
  assert.deepEqual([r.ok, r.ts, r.ms, r.hosts.length], [true, T, 2300, 2])
  assert.deepEqual(r.hosts[0], { mac: '00:00:5e:00:53:10', ip: '192.0.2.10', source: 'arp', ts: T, presence: true })
  // real net-scan format for a normal reply: hdrmac null, dup 0 → no anomaly
  const real = parseArp(file([{ ip: '192.0.2.12', mac: '00:00:5e:00:53:12', hdrmac: null, dup: 0 }]), { cidrs, now: T })
  assert.deepEqual([real.hosts.length, real.anomalies.hdrmac, real.anomalies.dup, real.anomalies.invalid], [1, 0, 0, 0])
  // invalid entries counted, never copied
  const bad = parseArp(file([h('198.51.100.4', '00:00:5e:00:53:11'), h('192.0.2.11', 'zz:00:5e:00:53:11'), h('192.0.2.300', '00:00:5e:00:53:12'), h('192.0.2.13', '00:00:5e:00:53:13', { dup: -1 }), null]), { cidrs, now: T })
  assert.deepEqual([bad.ok, bad.hosts.length, bad.anomalies.invalid], [true, 0, 5])
  // truncated, unknown version, too many hosts, too large: refused without quoting the content
  const cut = parseArp(file([h('192.0.2.10', '00:00:5e:00:53:10')]).slice(0, 40), { cidrs, now: T })
  assert.deepEqual([cut.ok, cut.ts], [false, null])
  assert.doesNotMatch(cut.error, /192\.0\.2/)
  assert.match(parseArp(JSON.stringify({ v: 2, ts: T, ok: true, hosts: [] }), { cidrs, now: T }).error, /version inconnue/)
  const many = parseArp(file(Array.from({ length: 1025 }, (_, i) => h(`192.0.2.${i % 250}`, '00:00:5e:00:53:01'))), { cidrs, now: T })
  assert.deepEqual([many.ok, many.ts], [false, T])
  assert.match(many.error, /plus de 1024 hôtes/)
  assert.equal(parseArp('x'.repeat(600 * 1024), { cidrs, now: T }).ok, false)
  // ts in the future: capped at the read time
  assert.equal(parseArp(file([]), { cidrs, now: T - 60_000 }).ts, T - 60_000)
  // failed sweep: error re-capped (control characters removed, 80 characters)
  const ko = parseArp(JSON.stringify({ v: 1, ts: T, ok: false, error: `arp-scan : pcap\u0007 ${'x'.repeat(200)}` }), { cidrs, now: T })
  assert.deepEqual([ko.ok, ko.ts, ko.error.length <= 80, /\u0007/.test(ko.error)], [false, T, true, false])
})

test('parseArp: same IP with two MACs → two observations and one anomaly; hdrmac ≠ mac and dup > 0 counted', () => {
  const r = parseArp(file([
    h('192.0.2.20', '00:00:5e:00:53:20'), h('192.0.2.20', '00:00:5e:00:53:21'),
    h('192.0.2.22', '00:00:5e:00:53:22', { hdrmac: '00:00:5e:00:53:99' }),
    h('192.0.2.23', '00:00:5e:00:53:23', { dup: 2 }),
  ]), { cidrs, now: T })
  assert.equal(r.hosts.length, 4)
  assert.deepEqual([r.anomalies.multiMacIps, r.anomalies.hdrmac, r.anomalies.dup], [1, 1, 1])
  assert.deepEqual(r.anomalies.conflicts.map(c => c.key).sort(), ['ip:192.0.2.20', 'mac:00:00:5e:00:53:22', 'mac:00:00:5e:00:53:23'])
})

test('readArp: missing file → not installed; present → read; path outside /run/net-scan refused by the schema', () => {
  const p = arpProbe()
  assert.deepEqual(readArp({ file: p.file, cidrs, now: T, uid: OTHER_UID }), { installed: false })
  assert.deepEqual(readArp({ file: '/nonexistent-dash/arp.json', cidrs, now: T, uid: OTHER_UID }), { installed: false })
  p.write(T, [h('192.0.2.10', '00:00:5e:00:53:10')])
  const r = readArp({ file: p.file, cidrs, now: T, uid: OTHER_UID })
  assert.deepEqual([r.installed, r.ok, r.ts, r.hosts.length], [true, true, T, 1])
  const cfgOf = f => parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { arp: { file: f } } } })
  assert.equal(cfgOf('/run/net-scan/arp.json').errors ?? null, null)
  assert.equal(cfgOf('/run/net-scan/arp.json').config.network.sources.arp.intervalSec, 120)
  for (const f of ['/etc/passwd', '/run/net-scan/../shadow.json', '/run/net-scan/sub/arp.json', '/run/net-scan/arp.txt', 'run/net-scan/arp.json']) assert.ok(cfgOf(f).errors, f)
})

test('selfSightings: the container\'s LAN interface, IPv4 only', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }],
    eth0: [
      { address: '192.0.2.148', family: 'IPv4', mac: '00:00:5e:00:53:f0', internal: false },
      { address: 'fe80::1', family: 'IPv6', mac: '00:00:5e:00:53:f0', internal: false },
      { address: '198.51.100.9', family: 'IPv4', mac: '00:00:5e:00:53:f0', internal: false },
    ],
  }
  assert.deepEqual(selfSightings(ifaces, { iface: 'eth0', cidrs, now: T }), [{ mac: '00:00:5e:00:53:f0', ip: '192.0.2.148', source: 'self', ts: T, presence: true }])
  assert.deepEqual(selfSightings(ifaces, { iface: 'eth9', cidrs, now: T }), [])
})
