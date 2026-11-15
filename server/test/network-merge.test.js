// Network module: merging of observations (lib/network/merge.js), applied by the
// real store on a temporary database. Real-world cases, anonymized:
// reassigned IP, a workstation alternating between two IPs, recreated macvlan, random MACs,
// stable locally administered MAC of a guest, PTR versus config name, duplicate names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { cleanName, cleanText, guessKind, bestAttr, matchHost, isGenericName, isPending, setHostSuffixes } from '../lib/network/merge.js'
import { createNetwork } from '../lib/network/index.js'
import { mergeBench } from './network-fixture.js'

const T0 = Date.parse('2026-10-20T12:00:00Z')
const MIN = 60_000
const DAY = 86400_000

const testCfg = (network = {}) => {
  const { config, errors } = parseConfig({
    version: 2, title: 't',
    proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod' },
      { id: 'nas', name: 'NAS-1', kind: 'appliance', ip: '192.0.2.159', env: 'prod' },
      { id: 'router', name: 'Routeur', kind: 'appliance', ip: '192.0.2.254', env: 'prod', mac: '00:00:5E:00:53:FE' },
      { id: 'ha', name: 'ha-box', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.154', parent: 'pve', env: 'prod' },
      { id: 'vps-ext', name: 'vps-ext', kind: 'vm', pve: 'prod', vmid: 103, ip: '192.0.2.233', parent: 'pve', env: 'prod' },
    ],
    groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { pihole: { url: 'http://192.0.2.158', secretEnv: 'PH' }, neigh: {} }, ipIdentity: ['192.0.2.192/27'], ...network },
  })
  if (errors) throw new Error(errors.join('\n'))
  return config
}

// bench: pure merge + real store, like a module scan (mergeBench from network-fixture)
function bench(network) {
  const b = mergeBench(testCfg(network), 'dash-net-')
  return Object.assign(b, {
    dev(mac) { return b.state.devices.get(b.state.macs.get(mac)?.device_id) },
    events: type => b.store.db.prepare('SELECT * FROM net_events WHERE type = ? ORDER BY id').all(type),
  })
}
const ph = (mac, ip, ts, extra = {}) => ({ mac, ip, source: 'pihole', ts, presence: true, ...extra })

test('network.hostSuffixes: domain suffixes removed on top of the local ones, set when the module starts, none by default; schema', t => {
  t.after(() => setHostSuffixes([]))
  const bad = v => parseConfig({ version: 2, title: 't', network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: {}, hostSuffixes: v } }).errors
  assert.deepEqual(testCfg().network.hostSuffixes, [])
  assert.deepEqual(testCfg({ hostSuffixes: ['isp.example.net', '.box.example'] }).network.hostSuffixes, ['isp.example.net', '.box.example'])
  for (const v of [['bad suffix'], ['-x.example'], ['x..example'], ['x.example/'], Array(17).fill('a.example'), 'isp.example.net', [42]]) assert.ok(bad(v), JSON.stringify(v))
  // network module: the config setting is applied before any name is cleaned
  const b = bench({ hostSuffixes: ['isp.example.net', '.BOX.example'] })
  createNetwork({ cfg: b.cfg, store: b.store, now: () => T0, log: { warn() {}, error() {}, log() {} } })
  assert.equal(cleanName('imprimante.isp.example.net.'), 'imprimante')
  assert.equal(cleanName('tv.box.example'), 'tv')
  assert.equal(cleanName('nas.lan'), 'nas', 'local suffixes kept')
  assert.equal(cleanName('poste.ispXexample.net'), 'poste.ispXexample.net', 'a literal dot, not a wildcard')
  assert.equal(cleanName('isp.example.net'), 'isp.example.net', 'a bare suffix is not removed')
  b.cycle([ph('00:00:5e:00:53:a1', '192.0.2.81', T0, { name: 'imprimante.isp.example.net', hostname: 'imprimante.isp.example.net' })], T0)
  assert.equal(b.dev('00:00:5e:00:53:a1').disp_name, 'imprimante')
  // without the setting (config without hostSuffixes): default, local suffixes only
  const d = bench()
  createNetwork({ cfg: d.cfg, store: d.store, now: () => T0, log: { warn() {}, error() {}, log() {} } })
  assert.equal(cleanName('imprimante.isp.example.net'), 'imprimante.isp.example.net')
  assert.equal(cleanName('nas.local'), 'nas')
})

test('cleanName, generic names, bestAttr', () => {
  assert.equal(cleanName('gitea.lan.'), 'gitea')
  assert.equal(cleanName('camera-1.local'), 'camera-1')
  assert.equal(cleanName('routeur.isp.example.net'), 'routeur.isp.example.net') // no ISP domain by default
  assert.equal(cleanName('x.home.lan'), 'x')
  assert.equal(cleanName('auto.exemple.fr'), 'auto.exemple.fr')
  assert.equal(cleanName('a\u0000b\u001b[31mc'), 'ab[31mc')
  assert.equal(cleanName('<b>gras</b>'), '<b>gras</b>') // escaped on display, never interpreted here
  assert.equal(cleanName('x'.repeat(100)).length, 64)
  for (const v of ['', '*', '(name not found)', '(unknown)', 'null', '[]', null, undefined]) assert.equal(cleanName(v), null, String(v))
  assert.equal(cleanText('hote.exemple.fr.\u0007\u001b'), 'hote.exemple.fr')
  assert.equal(cleanText('x'.repeat(300)).length, 253)
  assert.equal(cleanText('  '), null)
  assert.equal(isGenericName('android-3f2a9c'), true)
  assert.equal(isGenericName('esp_12ab'), true)
  assert.equal(isGenericName('docker'), true)
  assert.equal(isGenericName('Phone-X1'), false)
  const attrs = [
    { attr: 'name', source: 'pihole', value: 'site-a', rank: 4, seen_at: 10 },
    { attr: 'name', source: 'pve', value: 'vps-ext', rank: 8, seen_at: 5 },
    { attr: 'name', source: 'dhcp', value: 'vieux', rank: 4, seen_at: 1 },
  ]
  assert.deepEqual(bestAttr(attrs, 'name'), { value: 'vps-ext', source: 'pve', rank: 8 })
  assert.equal(bestAttr(attrs, 'vendor'), null)
})

test('guessKind: guessed kind and profile', () => {
  assert.deepEqual(guessKind({ hostKind: 'lxc' }), { type: 'server', profile: 'fixed' })
  assert.deepEqual(guessKind({ hostKind: 'pve-node' }), { type: 'hypervisor', profile: 'fixed' })
  assert.deepEqual(guessKind({ vendor: 'Espressif Inc.', names: ['camera-2'] }), { type: 'camera', profile: 'sleepy' })
  assert.deepEqual(guessKind({ vendor: 'Tuya Smart Inc.' }), { type: 'iot', profile: 'sleepy' })
  assert.deepEqual(guessKind({ vendor: 'Synology Incorporated' }), { type: 'nas', profile: 'fixed' })
  assert.deepEqual(guessKind({ names: ['PHONE-FE-exemple'], grade: 'weak' }), { type: 'phone', profile: 'sleepy' })
  assert.deepEqual(guessKind({ names: ['XboxOne'], vendor: 'Microsoft' }), { type: 'console', profile: 'normal' })
  assert.deepEqual(guessKind({ names: ['homeassistant', 'docker.exemple.example.net'] }), { type: null, profile: 'normal' })
  assert.deepEqual(guessKind({ names: ['echo-salon'], vendor: 'Amazon Technologies Inc.' }), { type: 'speaker', profile: 'normal' })
  assert.deepEqual(guessKind({ vendor: 'Sagemcom Broadband SAS' }), { type: 'router', profile: 'fixed' })
  assert.deepEqual(guessKind({ vendor: 'TP-Link Systems Inc', names: ['TL-SG608E'] }), { type: 'switch', profile: 'fixed' })
  assert.deepEqual(guessKind({ vendor: 'Inconnu SA' }), { type: null, profile: 'normal' })
})

test('matchHost: Proxmox MAC, hosts[].mac, then IP only for a strong MAC', () => {
  const cfg = testCfg()
  const strong = [{ mac: '00:00:5e:00:53:49', grade: 'strong' }]
  const weak = [{ mac: '02:00:00:00:53:49', grade: 'weak' }]
  assert.deepEqual(matchHost({ last_ip: '192.0.2.159' }, strong, { cfg }), { hostId: 'nas', src: 'ip' })
  assert.equal(matchHost({ last_ip: '192.0.2.159' }, weak, { cfg }), null)
  assert.deepEqual(matchHost({ last_ip: null }, [{ mac: '00:00:5e:00:53:fe', grade: 'strong' }], { cfg }), { hostId: 'router', src: 'config' })
  assert.deepEqual(matchHost({ last_ip: '192.0.2.159' }, weak, { cfg, guestIndex: new Map([['02:00:00:00:53:49', 'ha']]) }), { hostId: 'ha', src: 'pve' })
})

test('multi-source merge: one record per MAC, ranks, host link, locally administered MAC of a guest', () => {
  const b = bench()
  const HA = '02:42:00:00:53:44' // locally administered MAC set in the Proxmox config
  const m = b.cycle([
    ph(HA, '192.0.2.154', T0 - 30_000, { name: 'homeassistant.local', hostname: 'homeassistant.local' }),
    { mac: HA, ip: '192.0.2.154', source: 'neigh', ts: T0, presence: true },
    { mac: HA.toUpperCase(), ip: '192.0.2.154', source: 'pve', ts: T0, presence: false, name: 'ha-box', hostId: 'ha' },
    ph('00:00:5e:00:53:33', '192.0.2.233', T0, { name: 'site-a.local' }),
    { mac: '00:00:5e:00:53:33', ip: '192.0.2.233', source: 'pve', ts: T0, presence: false, name: 'vps-ext', hostId: 'vps-ext' },
    ph('00:00:5e:00:53:49', '192.0.2.159', T0, { vendor: 'Synology Incorporated', name: 'NAS-1' }),
  ], T0)
  // Proxmox identity: "known" by default; the NAS, linked only by its IP, follows the normal rule
  assert.equal(m.stats.created, 1)
  const ha = b.dev(HA)
  assert.equal(b.state.macs.get(HA).grade, 'hypervisor')
  assert.equal(b.state.macs.get(HA).random, 1)
  assert.deepEqual([ha.state, ha.host_id, ha.host_src, ha.disp_name, ha.disp_type, ha.last_ip, ha.last_seen], ['known', 'ha', 'pve', 'ha-box', 'server', '192.0.2.154', T0])
  // PTR "site-a" versus config name "vps-ext": the config wins
  assert.equal(b.dev('00:00:5e:00:53:33').disp_name, 'vps-ext')
  // NAS linked by its IP (strong MAC): name from the host at rank 8, vendor from Pi-hole
  const nas = b.dev('00:00:5e:00:53:49')
  assert.deepEqual([nas.state, nas.host_id, nas.host_src, nas.disp_name, nas.vendor, nas.disp_type], ['new', 'nas', 'ip', 'NAS-1', 'Synology Incorporated', 'nas'])
  assert.equal(b.state.devices.size, 3)
  // vendor guessed by Pi-hole for a locally administered MAC: ignored
  b.cycle([ph('02:00:00:00:53:61', '192.0.2.61', T0, { vendor: 'Amazon Technologies Inc.' })], T0)
  assert.equal(b.dev('02:00:00:00:53:61').vendor, null)
  // hostile FQDN cleaned; an observation date in the future is brought back to now
  b.cycle([ph('00:00:5e:00:53:62', '192.0.2.62', T0 + DAY, { name: 'x.lan', hostname: 'piege\u001b[2J.exemple.fr.' })], T0)
  const p62 = b.dev('00:00:5e:00:53:62')
  assert.equal(p62.last_seen, T0)
  assert.equal(b.state.attrs.get(p62.id).find(a => a.attr === 'hostname').value, 'piege[2J.exemple.fr')
  // user input wins: a name entered by the user is never replaced by a discovery
  b.apply([{ op: 'updateDevice', device: nas.id, fields: { name: 'NAS salon' } }])
  b.cycle([ph('00:00:5e:00:53:49', '192.0.2.159', T0 + MIN, { name: 'autre-nom' })], T0 + MIN)
  assert.equal(b.dev('00:00:5e:00:53:49').disp_name, 'NAS salon')
  // identical scan: no unnecessary write
  const again = b.cycle([ph('00:00:5e:00:53:49', '192.0.2.159', T0 + MIN, { name: 'autre-nom' })], T0 + MIN + 1000)
  assert.deepEqual(again.ops, [])
})

test('new devices: bootstrap, MACs excluded by nature, old entries, cap', () => {
  const b = bench({ maxNewPerCycle: 2 })
  const m1 = b.cycle([
    ph('00:00:5e:00:53:01', '192.0.2.21', T0),
    ph('00:00:00:00:00:00', '192.0.2.22', T0),
    ph('01:00:5e:00:00:fb', '192.0.2.23', T0),
    ph('02:42:ac:12:00:02', '192.0.2.24', T0), // no more user-entered exclusion: inventoried
    ph('00:00:5e:00:53:05', '192.0.2.199', T0),
    ph('00:00:5e:00:53:06', '192.0.2.26', T0 - 31 * DAY), // silent in Pi-hole for 31 days: outside the window
    ph('00:00:5e:00:53:09', '192.0.2.29', T0 - 40 * DAY, { lastQuery: T0 - 2 * DAY }), // recent DNS query: inside the window
    ph('00:00:5e:00:53:0a', '192.0.2.30', T0 - 40 * DAY), // old in Pi-hole, but lease still active
    { mac: '00:00:5e:00:53:0a', ip: '192.0.2.30', source: 'dhcp', ts: T0, presence: false, leaseExpires: T0 + 3600_000 },
    { mac: '00:00:5e:00:53:07', ip: null, source: 'pihole', ts: T0, presence: false }, // no IP
    ph('00:00:5e:00:53:08', '172.18.0.3', T0), // outside the subnets (Docker bridge)
  ], T0, { baseline: true })
  // by nature: null MAC, multicast; outside the LAN: Docker bridge; outside the window: the old entry
  assert.deepEqual([m1.stats.excluded, m1.stats.outside, m1.stats.notAdmitted], [2, 1, 1])
  assert.equal(b.state.devices.size, 5)
  assert.equal(b.dev('00:00:5e:00:53:06'), undefined)
  // seen only by DHCP: old last presence sighting, lease expiry kept
  assert.deepEqual([b.dev('00:00:5e:00:53:0a').last_seen, b.dev('00:00:5e:00:53:0a').last_dhcp], [T0 - 40 * DAY, T0 + 3600_000])
  assert.deepEqual([b.dev('00:00:5e:00:53:01').state, b.dev('00:00:5e:00:53:01').review], ['known', 1])
  // after bootstrap: at most maxNewPerCycle "new" records per scan
  const m2 = b.cycle(['11', '12'].map(x => ph(`00:00:5e:00:53:${x}`, `192.0.2.${x}`, T0 + MIN)), T0 + MIN)
  assert.deepEqual([m2.stats.created, m2.stats.capped], [2, 0])
  assert.equal(b.dev('00:00:5e:00:53:11').state, 'new')
  assert.equal(b.events('new').length, 7) // 5 during bootstrap, 2 afterwards
  // above the cap, the WHOLE scan is refused (no burst of alerts) and an episode opens
  const m3 = b.cycle(['13', '14', '15'].map(x => ph(`00:00:5e:00:53:${x}`, `192.0.2.${x}`, T0 + 2 * MIN)), T0 + 2 * MIN)
  assert.deepEqual([m3.stats.created, m3.stats.capped], [0, 3])
  assert.equal(b.flood.episode.since, T0 + 2 * MIN)
  // during the episode, Proxmox identities are still created; a lone host IP is not
  b.cycle([ph('00:00:5e:00:53:13', '192.0.2.13', T0 + 7 * MIN), ph('00:00:5e:00:53:49', '192.0.2.159', T0 + 7 * MIN),
    { mac: '02:42:00:00:53:44', ip: '192.0.2.154', source: 'pve', ts: T0 + 7 * MIN, presence: false, name: 'ha-box', hostId: 'ha' }], T0 + 7 * MIN)
  assert.equal(b.dev('00:00:5e:00:53:13'), undefined)
  assert.equal(b.dev('00:00:5e:00:53:49'), undefined)
  assert.equal(b.dev('02:42:00:00:53:44').state, 'known')
  assert.deepEqual([b.flood.refused.get('00:00:5e:00:53:13').runs, b.flood.refused.get('00:00:5e:00:53:13').presenceRuns], [2, 2])
  // present in a 3rd scan, 10 min after first seen: persistent, created as "new"
  b.cycle([ph('00:00:5e:00:53:13', '192.0.2.13', T0 + 12 * MIN)], T0 + 12 * MIN)
  assert.equal(b.dev('00:00:5e:00:53:13').state, 'new')
  assert.equal(b.flood.refused.has('00:00:5e:00:53:13'), false)
  // end of the episode 1 h after the last overflow
  b.cycle([], T0 + 2 * MIN + 3600_000)
  assert.equal(b.flood.episode, null)
})

test('spoofing of a host IP: "new", never linked in place of the real record', () => {
  const b = bench()
  // the router (hosts[].mac) is known; pve (linked by IP only) is off
  b.cycle([{ mac: '00:00:5e:00:53:fe', ip: '192.0.2.254', source: 'config', ts: T0, presence: false, name: 'Routeur', hostId: 'router' },
    ph('00:00:5e:00:53:fe', '192.0.2.254', T0)], T0)
  // after bootstrap, an intruder (universal MAC) takes the IP of pve, another one the router's
  b.cycle([ph('00:00:5e:00:53:a5', '192.0.2.155', T0 + MIN), ph('00:00:5e:00:53:a6', '192.0.2.254', T0 + MIN)], T0 + MIN)
  const onPve = b.dev('00:00:5e:00:53:a5')
  assert.deepEqual([onPve.state, onPve.host_id, onPve.host_src], ['new', 'pve', 'ip']) // link by IP possible, normal state
  const onBox = b.dev('00:00:5e:00:53:a6')
  assert.deepEqual([onBox.state, onBox.host_id], ['new', null]) // the router stays carried by its MAC
  const box = b.dev('00:00:5e:00:53:fe')
  assert.deepEqual([box.state, box.host_id, box.host_src], ['known', 'router', 'config'])
  // during bootstrap: known and to review, like everything else
  const c = bench()
  c.cycle([ph('00:00:5e:00:53:a7', '192.0.2.155', T0)], T0, { baseline: true })
  assert.deepEqual([c.dev('00:00:5e:00:53:a7').state, c.dev('00:00:5e:00:53:a7').review], ['known', 1])
})

test('bootstrap: cap ten times higher, a flood stays bounded', () => {
  const b = bench({ maxNewPerCycle: 2 })
  const m = b.cycle(Array.from({ length: 25 }, (_, i) => ph(`00:00:5e:00:5${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}`, `192.0.2.${100 + i}`, T0)), T0, { baseline: true })
  assert.deepEqual([b.state.devices.size, m.stats.capped], [20, 5])
})

test('reassigned IP (.36): two devices, never merged by the IP alone', () => {
  const b = bench()
  b.cycle([ph('00:00:5e:00:53:a1', '192.0.2.36', T0, { name: 'camera-2' })], T0)
  b.cycle([ph('00:00:5e:00:53:a2', '192.0.2.36', T0 + 20 * MIN, { name: 'Poste-Exemple' })], T0 + 20 * MIN)
  assert.notEqual(b.dev('00:00:5e:00:53:a1').id, b.dev('00:00:5e:00:53:a2').id)
  assert.equal(b.state.devices.size, 2)
})

test('IP change: DHCP noise ignored, stable or expected IP reported', () => {
  const b = bench()
  const A = '00:00:5e:00:53:b1'
  // a workstation alternating between two known IPs: no event
  b.cycle([ph(A, '192.0.2.36', T0 - 9 * DAY)], T0 - 9 * DAY)
  b.cycle([ph(A, '192.0.2.37', T0 - 8 * DAY)], T0 - 8 * DAY)
  b.cycle([ph(A, '192.0.2.36', T0 - 2 * MIN), ph(A, '192.0.2.37', T0 - MIN)], T0)
  b.cycle([ph(A, '192.0.2.36', T0 + MIN)], T0 + MIN)
  assert.equal(b.events('ip_changed').length, 0)
  assert.equal(b.dev(A).last_ip, '192.0.2.36')
  // IP held for 8 days, then a never-seen IP: event
  const B = '00:00:5e:00:53:b2'
  b.cycle([ph(B, '192.0.2.40', T0 - 8 * DAY)], T0 - 8 * DAY)
  b.cycle([ph(B, '192.0.2.40', T0 - MIN)], T0 - MIN)
  b.cycle([ph(B, '192.0.2.41', T0 + 2 * MIN)], T0 + 2 * MIN)
  assert.deepEqual(b.events('ip_changed').map(e => e.detail), ['192.0.2.40 → 192.0.2.41'])
  // expected IP (user-entered): any change counts
  const C = '00:00:5e:00:53:b3'
  b.cycle([ph(C, '192.0.2.50', T0)], T0)
  b.apply([{ op: 'updateDevice', device: b.dev(C).id, fields: { expected_ip: '192.0.2.50' } }])
  b.cycle([ph(C, '192.0.2.51', T0 + 3 * MIN)], T0 + 3 * MIN)
  assert.equal(b.events('ip_changed').length, 2)
})

// probe off (passive mode): the 10-minute rule still holds; the probe-on twin follows
test('recreated macvlan (ipIdentity range), probe off: separate record at 2 min, pending attachment after 10 min', () => {
  const b = bench()
  const OLD = '02:42:00:00:53:c1'
  const NEW = '62:00:00:00:53:c2'
  b.cycle([{ mac: OLD, ip: '192.0.2.193', source: 'neigh', ts: T0, presence: true, name: 'speedtest' }], T0)
  // recreated 2 min later: the old MAC is not "absent" yet → separate record
  const early = bench()
  early.cycle([{ mac: OLD, ip: '192.0.2.193', source: 'neigh', ts: T0, presence: true }], T0)
  early.cycle([{ mac: NEW, ip: '192.0.2.193', source: 'neigh', ts: T0 + 2 * MIN, presence: true }], T0 + 2 * MIN)
  assert.equal(early.state.devices.size, 2)
  // after 10 min of absence: same record, but attachment PENDING:
  // record to review, the MAC counts neither for freshness nor for the primary MAC
  b.cycle([{ mac: NEW, ip: '192.0.2.193', source: 'neigh', ts: T0 + 15 * MIN, presence: true }], T0 + 15 * MIN)
  assert.equal(b.state.devices.size, 1)
  assert.equal(b.dev(NEW).id, b.dev(OLD).id)
  assert.deepEqual([b.state.macs.get(NEW).attach, isPending(b.state.macs.get(NEW))], ['ip', true])
  assert.deepEqual([b.dev(NEW).primary_mac, b.dev(NEW).last_seen, b.dev(NEW).review], [OLD, T0, 1])
  assert.match(b.events('mac_added')[0].detail, /macvlan range/)
  // outside the range: no attachment by IP
  b.cycle([{ mac: '00:00:5e:00:53:c3', ip: '192.0.2.50', source: 'neigh', ts: T0, presence: true }], T0)
  b.cycle([{ mac: '02:00:00:00:53:c4', ip: '192.0.2.50', source: 'neigh', ts: T0 + 30 * MIN, presence: true }], T0 + 30 * MIN)
  assert.equal(b.state.devices.size, 3)
})

test('random MAC: attached on a non-generic DHCP name and a single candidate', () => {
  const b = bench()
  const dhcp = (mac, ip, ts, name) => ({ mac, ip, source: 'dhcp', ts, presence: false, name })
  b.cycle([ph('fe:00:00:00:53:01', '192.0.2.60', T0), dhcp('fe:00:00:00:53:01', '192.0.2.60', T0, 'Tab-Exemple')], T0)
  b.cycle([ph('fe:00:00:00:53:02', '192.0.2.61', T0 + 20 * MIN), dhcp('fe:00:00:00:53:02', '192.0.2.61', T0 + 20 * MIN, 'Tab-Exemple')], T0 + 20 * MIN)
  assert.equal(b.dev('fe:00:00:00:53:02').id, b.dev('fe:00:00:00:53:01').id)
  assert.match(b.events('mac_added')[0].detail, /same name "Tab-Exemple"/)
  assert.deepEqual([b.state.macs.get('fe:00:00:00:53:02').attach, b.dev('fe:00:00:00:53:01').review], ['name', 1])
  // rotating MACs of the same object in a single scan (Pi-hole table): a single record
  const r = bench()
  r.cycle([1, 2, 3].map(i => ph(`fe:00:00:00:54:0${i}`, `192.0.2.10${i}`, T0 - (10 - i) * DAY, { name: 'M310-Exemple' })), T0, { baseline: true })
  assert.equal(r.state.devices.size, 1)
  assert.equal(r.dev('fe:00:00:00:54:03').primary_mac, 'fe:00:00:00:54:01') // the other two are pending
  // same name, overlapping lifetimes: two distinct devices (two phones)
  const g = bench()
  g.cycle([
    ph('02:00:00:00:55:01', '192.0.2.111', T0 - 1 * DAY, { name: 'Galaxy-Exemple', firstSeen: T0 - 20 * DAY }),
    ph('02:00:00:00:55:02', '192.0.2.112', T0 - 2 * DAY, { name: 'Galaxy-Exemple', firstSeen: T0 - 15 * DAY }),
  ], T0, { baseline: true })
  assert.equal(g.state.devices.size, 2)
  // disjoint lifetimes (rotation): grouped, including from one scan to the next
  g.cycle([ph('02:00:00:00:55:03', '192.0.2.113', T0 + 20 * MIN, { name: 'Galaxy-Exemple', firstSeen: T0 + 10 * MIN })], T0 + 20 * MIN)
  assert.equal(g.state.devices.size, 3) // two candidates: no random attachment
  // generic name ("docker", "(name not found)"): never attached
  b.cycle([ph('02:00:00:00:53:11', '192.0.2.71', T0), dhcp('02:00:00:00:53:11', '192.0.2.71', T0, 'docker')], T0)
  b.cycle([ph('02:00:00:00:53:12', '192.0.2.72', T0 + 20 * MIN), dhcp('02:00:00:00:53:12', '192.0.2.72', T0 + 20 * MIN, 'docker')], T0 + 20 * MIN)
  assert.notEqual(b.dev('02:00:00:00:53:12').id, b.dev('02:00:00:00:53:11').id)
  b.cycle([1, 2, 3].map(i => ph(`00:00:5e:00:53:d${i}`, `192.0.2.8${i}`, T0, { name: '(name not found)' })), T0)
  for (const i of [1, 2, 3]) assert.equal(b.dev(`00:00:5e:00:53:d${i}`).disp_name, null)
  // two possible candidates: a new record rather than a wrong attachment
  const c = bench()
  c.cycle([dhcp('02:00:00:00:53:21', '192.0.2.91', T0, 'Tablette'), ph('02:00:00:00:53:21', '192.0.2.91', T0)], T0)
  c.cycle([dhcp('02:00:00:00:53:22', '192.0.2.92', T0, 'Tablette'), ph('02:00:00:00:53:22', '192.0.2.92', T0)], T0)
  c.cycle([dhcp('02:00:00:00:53:23', '192.0.2.93', T0 + 20 * MIN, 'Tablette'), ph('02:00:00:00:53:23', '192.0.2.93', T0 + 20 * MIN)], T0 + 20 * MIN)
  assert.equal(c.state.devices.size, 3)
})

test('locally administered MAC seen first on the network, then declared by Proxmox: note recorded', () => {
  const b = bench()
  const M = '02:42:00:00:53:44'
  b.cycle([ph(M, '192.0.2.154', T0)], T0, { baseline: true })
  assert.equal(b.state.macs.get(M).grade, 'weak')
  b.cycle([{ mac: M, ip: '192.0.2.154', source: 'pve', ts: T0 + MIN, presence: false, name: 'ha-box', hostId: 'ha' }], T0 + MIN)
  assert.equal(b.state.macs.get(M).grade, 'hypervisor')
  assert.deepEqual([b.dev(M).host_id, b.dev(M).host_src, b.dev(M).disp_name], ['ha', 'pve', 'ha-box'])
  // pve source down at the next scan: the link stays
  b.cycle([ph(M, '192.0.2.154', T0 + 2 * MIN)], T0 + 2 * MIN)
  assert.equal(b.dev(M).host_src, 'pve')
})

// --- pending attachments, forbidden targets, families, rules ----------------

test('spoofing by DHCP name: pending attachment, never "active", record to review', () => {
  const b = bench()
  const dhcp = (mac, ip, ts, name) => ({ mac, ip, source: 'dhcp', ts, presence: false, name, leaseExpires: ts + 3600_000 })
  // the household phone, then it goes away
  b.cycle([ph('06:00:00:00:56:01', '192.0.2.61', T0), dhcp('06:00:00:00:56:01', '192.0.2.61', T0, 'Telephone-Maison')], T0, { baseline: true })
  const phone = b.dev('06:00:00:00:56:01')
  b.apply([{ op: 'updateDevice', device: phone.id, fields: { review: 0 } }])
  // 2 h later, an intruder announces the same name with a random MAC
  const t = T0 + 2 * 3600_000
  b.cycle([ph('0a:00:00:00:56:99', '192.0.2.62', t), dhcp('0a:00:00:00:56:99', '192.0.2.62', t, 'Telephone-Maison')], t)
  const m = b.state.macs.get('0a:00:00:00:56:99')
  assert.deepEqual([m.device_id, m.attach, isPending(m)], [phone.id, 'name', true])
  const d = b.dev('06:00:00:00:56:01')
  // the absent device does not look active, its IP does not change, it becomes "to review" again
  assert.deepEqual([d.last_seen, d.last_ip, d.review, d.primary_mac], [T0, '192.0.2.61', 1, '06:00:00:00:56:01'])
  // the pending MAC has its own sighting row (visible in the drawer)
  assert.equal(b.state.seen.get('0a:00:00:00:56:99|pihole').last_seen, t)
  // the spoofer renames nothing and brings no attribute
  assert.deepEqual(b.state.attrs.get(phone.id).filter(a => a.attr === 'name').map(a => [a.source, a.seen_at]), [['dhcp', T0]]) // nothing from the intruder
})

test('forbidden targets: linked host, strong MAC → new record', () => {
  const dhcp = (mac, ip, ts, name) => ({ mac, ip, source: 'dhcp', ts, presence: false, name })
  const t = T0 + 2 * 3600_000
  for (const [label, prep] of [
    ['hôte lié', (b, id) => b.apply([{ op: 'updateDevice', device: id, fields: { host_id: 'nas', host_src: 'user' } }])],
  ]) {
    const b = bench()
    b.cycle([ph('06:00:00:00:57:01', '192.0.2.71', T0), dhcp('06:00:00:00:57:01', '192.0.2.71', T0, 'Tablette-Salon')], T0)
    prep(b, b.dev('06:00:00:00:57:01').id)
    b.cycle([ph('0a:00:00:00:57:02', '192.0.2.72', t), dhcp('0a:00:00:00:57:02', '192.0.2.72', t, 'Tablette-Salon')], t)
    assert.notEqual(b.dev('0a:00:00:00:57:02').id, b.dev('06:00:00:00:57:01').id, label)
    assert.equal(b.state.macs.get('0a:00:00:00:57:02').attach, null, label)
  }
  // record carrying a universal MAC: no attachment by name
  const b = bench()
  b.cycle([ph('00:00:5e:00:57:03', '192.0.2.73', T0), dhcp('00:00:5e:00:57:03', '192.0.2.73', T0, 'Portable-Bureau')], T0)
  b.cycle([ph('0a:00:00:00:57:04', '192.0.2.74', t), dhcp('0a:00:00:00:57:04', '192.0.2.74', t, 'Portable-Bureau')], t)
  assert.notEqual(b.dev('0a:00:00:00:57:04').id, b.dev('00:00:5e:00:57:03').id)
  // macvlan range: same rule (target linked to a host → new record)
  const c = bench()
  c.cycle([{ mac: '02:42:00:00:57:05', ip: '192.0.2.195', source: 'neigh', ts: T0, presence: true }], T0)
  c.apply([{ op: 'updateDevice', device: c.dev('02:42:00:00:57:05').id, fields: { host_id: 'nas', host_src: 'user' } }])
  c.cycle([{ mac: '62:00:00:00:57:06', ip: '192.0.2.195', source: 'neigh', ts: t, presence: true }], t)
  assert.notEqual(c.dev('62:00:00:00:57:06').id, c.dev('02:42:00:00:57:05').id)
})

test('validated family: prefix + name → attached without alert; other name → normal path; old ignore rule has no effect', () => {
  const b = bench()
  const dhcp = (mac, ip, ts, name) => ({ mac, ip, source: 'dhcp', ts, presence: false, name })
  b.cycle([ph('fe:00:00:00:58:01', '192.0.2.81', T0), dhcp('fe:00:00:00:58:01', '192.0.2.81', T0, 'Tab-Exemple')], T0)
  const target = b.dev('fe:00:00:00:58:01')
  b.ns.insertRule({ prefix: 'fe:00:00', action: 'attach', device_id: target.id, name: 'Tab-Exemple', reason: 'famille' }, { actor: 'test', ts: T0 })
  // legacy row: the ignore action no longer exists, it hides nothing
  b.ns.insertRule({ prefix: '0e:00:00', action: 'ignore', reason: 'bruit' }, { actor: 'test', ts: T0 })
  b.apply([])
  const t = T0 + 5 * MIN // even while the old MAC is present: the rule wins
  b.cycle([ph('fe:00:00:00:58:02', '192.0.2.82', t), dhcp('fe:00:00:00:58:02', '192.0.2.82', t, 'Tab-Exemple'),
    ph('fe:00:00:00:58:03', '192.0.2.83', t), dhcp('fe:00:00:00:58:03', '192.0.2.83', t, 'Autre-Nom'),
    ph('0e:00:00:00:58:04', '192.0.2.84', t)], t)
  const m2 = b.state.macs.get('fe:00:00:00:58:02')
  assert.deepEqual([m2.device_id, m2.attach, isPending(m2)], [target.id, 'rule', false])
  assert.equal(b.dev('fe:00:00:00:58:01').review, 0) // confirmed by default: not "to review"
  assert.match(b.events('mac_added').at(-1).detail, /family fe:00:00 "Tab-Exemple"/)
  assert.notEqual(b.dev('fe:00:00:00:58:03').id, target.id) // other name: new record
  assert.ok(b.dev('0e:00:00:00:58:04')) // the old ignore rule hides nothing
  // attached by the family: dated (informational alert for 24 h)
  assert.deepEqual([b.state.macs.get('fe:00:00:00:58:02').confirmed_at, b.state.macs.get('fe:00:00:00:58:02').confirmed_by.startsWith('rule:')], [t, true])
})

test('pve and config identities: attach set at creation', () => {
  const b = bench()
  b.cycle([{ mac: '02:42:00:00:53:44', ip: '192.0.2.154', source: 'pve', ts: T0, presence: false, name: 'ha-box', hostId: 'ha' },
    { mac: '00:00:5e:00:53:fe', ip: '192.0.2.254', source: 'config', ts: T0, presence: false, name: 'Routeur', hostId: 'router' },
    ph('00:00:5e:00:53:31', '192.0.2.31', T0)], T0)
  assert.deepEqual(['02:42:00:00:53:44', '00:00:5e:00:53:fe', '00:00:5e:00:53:31'].map(m => b.state.macs.get(m).attach), ['pve', 'config', null])
})

// --- IP handover: recreated macvlan container, handover observed during the sweep -----------------
const P = '192.0.2.193'
const OLD = '62:00:00:00:53:e2'
const NEW = '0a:00:00:00:53:f1'
const arpOf = (hosts, ts, conflicts = []) => {
  const arpScan = { ts, byIp: new Map(), macs: new Set(), conflicts: new Set(conflicts) }
  for (const h of hosts) {
    arpScan.macs.add(h.mac)
    arpScan.byIp.set(h.ip, [...(arpScan.byIp.get(h.ip) ?? []), h.mac])
  }
  return { arpScan, sightings: hosts.map(h => ({ mac: h.mac, ip: h.ip, source: 'arp', ts, presence: true })) }
}
// history: previous sweeps, most recent first, reduced to the ipIdentity range
const hist = (...scans) => scans.map((hosts, i) => ({ ts: T0 - i, ips: hosts.reduce((o, h) => ({ ...o, [h.ip]: [...(o[h.ip] ?? []), h.mac] }), {}) }))
function l1Bench(network) {
  const b = bench(network)
  b.cycle([{ mac: OLD, ip: P, source: 'neigh', ts: T0, presence: true, name: 'speedtest' }], T0)
  b.apply([{ op: 'updateDevice', device: b.dev(OLD).id, fields: { state: 'known' } }])
  b.F = b.dev(OLD).id
  b.scan = (hosts, ts, { history = hist([{ mac: OLD, ip: P }]), conflicts = [], l1Recent, l1Macs, probe = 'on' } = {}) => {
    const { arpScan, sightings } = arpOf(hosts, ts, conflicts)
    return b.cycle(sightings, ts, { probe, arpScan, idHistory: history, l1Recent, l1Macs })
  }
  return b
}
const isL1 = (b, m) => m.l1.length === 1 && b.dev(NEW)?.id === b.F && b.state.macs.get(NEW).attach === 'ip' && isPending(b.state.macs.get(NEW))

test('IP handover (probe-on twin of "recreated macvlan"): handover at the sweep → pending attachment (ip), marked IP handover, no record; IP handover counts for last_present only', () => {
  const b = l1Bench()
  const t = T0 + 2 * MIN
  const m = b.scan([{ mac: NEW, ip: P }], t)
  assert.ok(isL1(b, m))
  assert.deepEqual(m.l1, [{ mac: NEW, device: b.F, ip: P }])
  assert.equal(m.ops.filter(o => o.op === 'insertDevice').length, 0)
  assert.equal(b.events('mac_added')[0].detail, `${NEW}: IP handover: same IP ${P} (macvlan range, handover at scan)`)
  const F = b.state.devices.get(b.F)
  assert.deepEqual([F.last_present, F.last_ip, F.primary_mac, F.review], [t, P, OLD, 1])
  assert.equal(b.state.macs.get(OLD).attach, null) // old MAC kept, unchanged
})

test('IP handover rule 0: probe running, unknown MAC seen by neigh alone in the range → neither created nor attached; outside the range → created', () => {
  const b = l1Bench()
  const m = b.cycle([{ mac: NEW, ip: P, source: 'neigh', ts: T0 + MIN, presence: true }, { mac: NEW, ip: P, source: 'pihole', ts: T0 + MIN, presence: true }], T0 + MIN, { probe: 'on' })
  assert.equal(b.state.macs.has(NEW), false)
  assert.equal(m.ops.filter(o => o.op === 'insertDevice').length, 0)
  b.cycle([{ mac: '0a:00:00:00:53:f9', ip: '192.0.2.150', source: 'neigh', ts: T0 + MIN, presence: true }], T0 + MIN, { probe: 'on' })
  assert.equal(b.dev('0a:00:00:00:53:f9').state, 'new')
})

test('IP handover: straddling (n−1 silent, n−2 old) → IP handover; two silent sweeps → normal path', () => {
  const a = l1Bench()
  assert.ok(isL1(a, a.scan([{ mac: NEW, ip: P }], T0 + 4 * MIN, { history: hist([], [{ mac: OLD, ip: P }]) })))
  const b = l1Bench()
  const m = b.scan([{ mac: NEW, ip: P }], T0 + 6 * MIN, { history: hist([], [], [{ mac: OLD, ip: P }]) })
  assert.deepEqual([m.l1.length, b.dev(NEW).state], [0, 'new'])
})

test('IP handover refused: both MACs in the same sweep, old one on another IP, dup/hdrmac/conflict, MAC of the record present', () => {
  for (const [hosts, conflicts] of [
    [[{ mac: OLD, ip: P }, { mac: NEW, ip: P }], [`ip:${P}`]],
    [[{ mac: NEW, ip: P }, { mac: OLD, ip: '192.0.2.194' }], []],
    [[{ mac: NEW, ip: P }], [`mac:${NEW}`]],
    [[{ mac: NEW, ip: P }], [`ip:${P}`]],
  ]) {
    const b = l1Bench()
    const m = b.scan(hosts, T0 + 2 * MIN, { conflicts })
    assert.equal(m.l1.length, 0, JSON.stringify(hosts))
    assert.notEqual(b.dev(NEW)?.id, b.F, JSON.stringify(hosts))
  }
})

test('IP handover refused: new record, linked record, two records on the IP; probe down (nothing) or off (10 min)', () => {
  const nw = l1Bench()
  nw.apply([{ op: 'updateDevice', device: nw.F, fields: { state: 'new' } }])
  assert.equal(nw.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN).l1.length, 0)
  const linked = l1Bench()
  linked.apply([{ op: 'updateDevice', device: linked.F, fields: { host_id: 'nas', host_src: 'user' } }])
  assert.equal(linked.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN).l1.length, 0)
  const two = l1Bench()
  two.cycle([{ mac: '00:00:5e:00:53:f7', ip: '192.0.2.150', source: 'neigh', ts: T0, presence: true }], T0)
  two.apply([{ op: 'updateDevice', device: two.dev('00:00:5e:00:53:f7').id, fields: { last_ip: P } }])
  assert.equal(two.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN).l1.length, 0)
  const down = l1Bench()
  const md = down.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN, { probe: 'down' })
  assert.deepEqual([md.l1.length, down.state.macs.has(NEW)], [0, false])
  const off = l1Bench()
  const mo = off.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN, { probe: 'off' })
  assert.deepEqual([mo.l1.length, off.dev(NEW).state], [0, 'new']) // 2 min: 10-minute rule → separate record
})

test('IP handover: tombstone → returned, "new" record, never IP handover; second IP handover within the hour → normal path', () => {
  const b = l1Bench()
  b.store.db.prepare('INSERT INTO net_tombstones (mac, deleted_at, device_id, reason, deleted_by) VALUES (?, ?, ?, ?, ?)').run(NEW, T0 - DAY, 99, 'test', 'admin')
  b.apply([])
  const m = b.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN)
  assert.deepEqual([m.l1.length, b.dev(NEW).state, b.events('returned').length], [0, 'new', 1])
  const r = l1Bench()
  const mr = r.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN, { l1Recent: new Set([r.F]) })
  assert.deepEqual([mr.l1.length, r.dev(NEW).state], [0, 'new'])
})

test('IP handover: an active IP-handover MAC serves as old MAC (7-day chain); escalated, never; a pending MAC outside IP handover does not count', () => {
  const b = l1Bench()
  b.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN)
  const NEW2 = '0a:00:00:00:53:f2'
  const t7 = T0 + 7 * DAY
  // the 2nd recreation: NEW (active IP handover, pending) answered the previous sweep
  const m2 = b.scan([{ mac: NEW2, ip: P }], t7, { history: hist([{ mac: NEW, ip: P }]), l1Macs: new Set([NEW]) })
  assert.deepEqual([m2.l1.length, b.dev(NEW2).id, [...b.state.macs.values()].filter(x => x.device_id === b.F && isPending(x)).length], [1, b.F, 2])
  assert.equal(b.state.devices.get(b.F).last_present, t7)
  // escalated IP-handover MAC (missing from l1Macs): does not serve as old MAC
  const c = l1Bench()
  c.scan([{ mac: NEW, ip: P }], T0 + 2 * MIN)
  const m3 = c.scan([{ mac: NEW2, ip: P }], t7, { history: hist([{ mac: NEW, ip: P }]), l1Macs: new Set() })
  // normal path: no IP handover (here the 10-minute rule applies, the old MAC has been silent for 7 days)
  assert.equal(m3.l1.length, 0)
  assert.ok(c.events('mac_added').every(e => !e.detail.startsWith(`${NEW2}: IP handover`)))
  // pending MAC outside IP handover (attachment by IP after 10 min, probe off): does not count for last_present
  const d = l1Bench()
  d.cycle([{ mac: NEW, ip: P, source: 'neigh', ts: T0 + 15 * MIN, presence: true }], T0 + 15 * MIN)
  assert.deepEqual([d.dev(NEW).id, d.state.macs.get(NEW).attach], [d.F, 'ip'])
  assert.equal(d.state.devices.get(d.F).last_present, T0)
  d.cycle([{ mac: NEW, ip: P, source: 'neigh', ts: T0 + 20 * MIN, presence: true }], T0 + 20 * MIN, { l1Macs: new Set() })
  assert.equal(d.state.devices.get(d.F).last_present, T0)
})

// A VM removed from config.json kept its "pve" link in the database;
// the map built host:vps-ext, unknown to the config → 500 on /api/network/topology
test('pve or config link to a host removed from the config → removed; kept if PVE is only down', () => {
  const b = bench()
  const MAC = '00:00:5e:00:53:33'
  b.cycle([ph(MAC, '192.0.2.233', T0), { mac: MAC, ip: '192.0.2.233', source: 'pve', ts: T0, presence: false, name: 'vps-ext', hostId: 'vps-ext' }], T0)
  assert.deepEqual([b.dev(MAC).host_id, b.dev(MAC).host_src], ['vps-ext', 'pve'])
  // PVE down (no pve observation), host still in the config: the safe link stays
  b.cycle([ph(MAC, '192.0.2.233', T0 + 5 * MIN)], T0 + 5 * MIN)
  assert.deepEqual([b.dev(MAC).host_id, b.dev(MAC).host_src], ['vps-ext', 'pve'])
  // host removed from the config: the record becomes an ordinary device again
  const cfg = { ...b.cfg, hosts: b.cfg.hosts.filter(h => h.id !== 'vps-ext') }
  b.cycle([ph(MAC, '192.0.2.233', T0 + 10 * MIN)], T0 + 10 * MIN, { cfg })
  assert.deepEqual([b.dev(MAC).host_id, b.dev(MAC).host_src], [null, null])
})

test('USER-ENTERED link (host_src user) to a host removed from the config → removed at the next scan, without observation of the record', () => {
  const b = bench()
  const MAC = '00:00:5e:00:53:34'
  b.cycle([ph(MAC, '192.0.2.34', T0)], T0)
  const id = b.dev(MAC).id
  b.apply([{ op: 'updateDevice', device: id, fields: { host_id: 'vps-ext', host_src: 'user' } }])
  // host still in config: user input wins, scan after scan
  b.cycle([], T0 + 5 * MIN)
  assert.deepEqual([b.dev(MAC).host_id, b.dev(MAC).host_src], ['vps-ext', 'user'])
  // host removed: the orphan user input is erased, even without observation of the record in this scan
  const cfg = { ...b.cfg, hosts: b.cfg.hosts.filter(h => h.id !== 'vps-ext') }
  b.cycle([], T0 + 10 * MIN, { cfg })
  assert.deepEqual([b.dev(MAC).host_id, b.dev(MAC).host_src], [null, null])
})

// --- attachment by name in probe mode ---------
// record "45": weak MAC A, DHCP name Phone-de-alex, last arp at 09:33; STALE Pi-hole
// sighting of A pushed forward to the scan time (in production, up to 16:00); new MAC B in
// the ARP scan at 13:06, without a name (sources/arp.js), hint from the last passive scan
const D = Date.parse('2026-10-27T00:00:00Z')
const at = (h, m = 0) => D + h * 3600_000 + m * MIN
const PHONE_A = '0a:00:00:00:45:01'
const PHONE_B = '5a:00:00:00:d0:16'
const PHONE = 'Phone-de-alex'
function phoneBench({ arpAt = at(9, 33), piholeAt = at(13, 6), lastSeen = piholeAt, extra = [] } = {}) {
  const b = bench()
  const views = [['arp', arpAt], ['pihole', piholeAt], ...extra].filter(([, t]) => t != null)
  b.apply([
    { op: 'insertDevice', ref: 'new:1', fields: { state: 'known', review: 0, origin: 'scan', created_at: D - 10 * DAY, updated_at: D - 10 * DAY, first_seen: D - 10 * DAY, last_seen: lastSeen, disp_name: PHONE, primary_mac: PHONE_A, last_ip: '192.0.2.45' } },
    { op: 'upsertMac', mac: PHONE_A, device: 'new:1', grade: 'weak', random: 1, first_seen: D - 10 * DAY, last_seen: lastSeen, last_ip: '192.0.2.45', attach: null },
    ...views.map(([source, t]) => ({ op: 'upsertSeen', mac: PHONE_A, source, last_seen: t, last_ip: '192.0.2.45' })),
    { op: 'upsertAttr', device: 'new:1', attr: 'name', source: 'dhcp', value: PHONE, rank: 6, seen_at: at(9, 0) },
  ])
  b.id45 = b.dev(PHONE_A).id
  return b
}
const arpSeen = (mac, ip, ts, extra = {}) => ({ mac, ip, source: 'arp', ts, presence: true, ...extra })
const hintB = new Map([[PHONE_B, PHONE]])

test('probe mode: stale Pi-hole sighting of A, B in the ARP scan with the hint → pending attachment to 45, 0 record created', () => {
  const b = phoneBench()
  const m = b.cycle([arpSeen(PHONE_B, '192.0.2.52', at(13, 6))], at(13, 6), { probe: 'on', nameHints: hintB })
  assert.equal(m.ops.filter(o => o.op === 'insertDevice').length, 0)
  assert.equal(b.dev(PHONE_B).id, b.id45)
  const mb = b.state.macs.get(PHONE_B)
  assert.deepEqual([mb.attach, isPending(mb), b.dev(PHONE_A).review], ['name', true, 1])
  assert.match(b.events('mac_added').at(-1).detail, /same name "Phone-de-alex"/)
})

test('probe mode: A present in arp (two devices), or two "Phone-X1" seen together → no attachment', () => {
  const b = phoneBench({ arpAt: at(13, 5) })
  b.cycle([arpSeen(PHONE_B, '192.0.2.52', at(13, 6))], at(13, 6), { probe: 'on', nameHints: hintB })
  assert.notEqual(b.dev(PHONE_B).id, b.id45)
  assert.equal(b.dev(PHONE_B).state, 'new')
  // both in the same sweep
  const g = phoneBench()
  g.cycle([arpSeen(PHONE_A, '192.0.2.45', at(13, 6)), arpSeen(PHONE_B, '192.0.2.52', at(13, 6))], at(13, 6), { probe: 'on', nameHints: hintB })
  assert.notEqual(g.dev(PHONE_B).id, g.id45)
})

test('probe mode: life[0] = s.ts, an old firstSeen carried by the observation does not widen the lifetime', () => {
  const b = phoneBench({ piholeAt: at(9, 33) })
  b.cycle([arpSeen(PHONE_B, '192.0.2.52', at(13, 6), { firstSeen: at(8, 0) })], at(13, 6), { probe: 'on', nameHints: hintB })
  assert.equal(b.dev(PHONE_B).id, b.id45)
})

test('family in probe mode: the name hint is enough, even with the old MAC present; other name → no family; nameWait → neither record nor attachment', () => {
  const b = phoneBench({ arpAt: at(13, 5) })
  b.ns.insertRule({ prefix: '5a:00:00', action: 'attach', device_id: b.id45, name: PHONE, reason: 'famille' }, { actor: 'test', ts: at(9, 0) })
  b.apply([])
  const scan = [arpSeen(PHONE_B, '192.0.2.52', at(13, 6))]
  // without a hint, the name is missing: the family does not apply; while waiting, nothing is written
  const waited = b.cycle(scan, at(13, 6), { probe: 'on', nameWait: new Set([PHONE_B]) })
  assert.equal(waited.ops.filter(o => o.op === 'insertDevice' || o.op === 'upsertMac').length, 0)
  assert.equal(b.state.macs.has(PHONE_B), false)
  // name of another device: the family does not apply
  const other = phoneBench({ arpAt: at(13, 5) })
  other.ns.insertRule({ prefix: '5a:00:00', action: 'attach', device_id: other.id45, name: PHONE, reason: 'famille' }, { actor: 'test', ts: at(9, 0) })
  other.apply([])
  other.cycle(scan, at(13, 6), { probe: 'on', nameHints: new Map([[PHONE_B, 'Autre-Nom']]) })
  assert.notEqual(other.dev(PHONE_B).id, other.id45)
  // right name: attached and confirmed by default
  b.cycle(scan, at(13, 6), { probe: 'on', nameHints: hintB })
  const m = b.state.macs.get(PHONE_B)
  assert.deepEqual([m.device_id, m.attach, isPending(m), b.dev(PHONE_A).review], [b.id45, 'rule', false, 0])
})

test('hint without a single candidate → normal creation ("new"); the hint writes no attribute', () => {
  const b = phoneBench()
  // second record with the same name, also absent: two candidates
  b.apply([
    { op: 'insertDevice', ref: 'new:2', fields: { state: 'known', review: 0, origin: 'scan', created_at: D - 9 * DAY, updated_at: D - 9 * DAY, first_seen: D - 9 * DAY, last_seen: at(9, 0), disp_name: PHONE, primary_mac: '0a:00:00:00:45:02', last_ip: '192.0.2.46' } },
    { op: 'upsertMac', mac: '0a:00:00:00:45:02', device: 'new:2', grade: 'weak', random: 1, first_seen: D - 9 * DAY, last_seen: at(9, 0), last_ip: '192.0.2.46', attach: null },
    { op: 'upsertSeen', mac: '0a:00:00:00:45:02', source: 'arp', last_seen: at(9, 0), last_ip: '192.0.2.46' },
    { op: 'upsertAttr', device: 'new:2', attr: 'name', source: 'dhcp', value: PHONE, rank: 6, seen_at: at(9, 0) },
  ])
  const m = b.cycle([arpSeen(PHONE_B, '192.0.2.52', at(13, 6))], at(13, 6), { probe: 'on', nameHints: hintB })
  assert.equal(m.ops.filter(o => o.op === 'insertDevice').length, 1)
  const d = b.dev(PHONE_B)
  assert.deepEqual([d.state, d.disp_name], ['new', null])
  assert.deepEqual(b.state.attrs.get(d.id).filter(a => a.attr === 'name'), [])
  assert.equal(m.ops.some(o => o.op === 'upsertAttr' && o.value === PHONE), false)
  // single candidate: attached, and the hint adds no attribute to the target record either
  const u = phoneBench()
  const names = () => JSON.stringify(u.state.attrs.get(u.id45).filter(x => x.attr === 'name').map(x => [x.source, x.value]))
  const before = names()
  const mu = u.cycle([arpSeen(PHONE_B, '192.0.2.52', at(13, 6))], at(13, 6), { probe: 'on', nameHints: hintB })
  assert.equal(u.dev(PHONE_B).id, u.id45)
  assert.equal(mu.ops.some(o => o.op === 'upsertAttr' && o.attr === 'name'), false)
  assert.equal(names(), before)
})

test('without probe: unchanged, last_seen pushed forward by a source without presence keeps the overlap', () => {
  // A: Pi-hole presence at 12:50 (absent at 13:06), but last_seen pushed forward to 13:06 (DHCP lease):
  // the lifetime of A overlaps the arrival of B, no attachment (previous behavior)
  const b = phoneBench({ arpAt: null, piholeAt: at(12, 50), lastSeen: at(13, 6) })
  b.cycle([ph(PHONE_B, '192.0.2.52', at(13, 6)), { mac: PHONE_B, ip: '192.0.2.52', source: 'dhcp', ts: at(13, 6), presence: false, name: PHONE }], at(13, 6))
  assert.notEqual(b.dev(PHONE_B).id, b.id45)
  // A ended before B arrived (last_seen 12:50): attached, as before
  const r = phoneBench({ arpAt: null, piholeAt: at(12, 50), lastSeen: at(12, 50) })
  r.cycle([ph(PHONE_B, '192.0.2.52', at(13, 6)), { mac: PHONE_B, ip: '192.0.2.52', source: 'dhcp', ts: at(13, 6), presence: false, name: PHONE }], at(13, 6))
  assert.equal(r.dev(PHONE_B).id, r.id45)
  // without probe, the probe hint is not passed: the name comes from the scan (cycleName)
})
