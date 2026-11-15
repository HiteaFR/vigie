// Network module: parsers of the passive sources. Fixtures in the exact shape of the
// responses recorded read-only (Pi-hole FTL v6, ip -j neigh, Proxmox config), anonymized
// values (RFC 7042, RFC 5737).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDevices, parseLeases, readDevices } from '../lib/network/sources/pihole.js'
import { parseNeigh, readNeigh } from '../lib/network/sources/neigh.js'
import { parseNetLine, guestSightings } from '../lib/network/sources/pve.js'
import { configSightings } from '../lib/network/sources/config.js'
import { createSources } from '../lib/sources.js'
import { testPkiDir } from './tls-fixtures.js'
import { parseConfig } from '../lib/config.js'

const S = 1792520000 // epoch seconds (FTL)

test('Pi-hole network/devices: one observation per (MAC, IPv4), dates in ms', () => {
  const json = {
    devices: [
      { id: 1, hwaddr: '00:00:5e:00:53:01', interface: 'eth0', firstSeen: S - 86400, lastQuery: S - 30, numQueries: 12, macVendor: 'Exemple SA',
        ips: [{ ip: '192.0.2.10', name: 'nas.lan', lastSeen: S, nameUpdated: S }, { ip: '2001:db8::10', name: null, lastSeen: S, nameUpdated: S }] },
      // two IPs for one MAC (alternating workstation): two observations
      { id: 2, hwaddr: '00:00:5E:00:53:02', interface: 'eth0', firstSeen: S - 50, lastQuery: 0, numQueries: 0, macVendor: '',
        ips: [{ ip: '192.0.2.36', name: null, lastSeen: S - 600, nameUpdated: 0 }, { ip: '192.0.2.37', name: '*', lastSeen: S, nameUpdated: 0 }] },
      // no IP: identity only
      { id: 3, hwaddr: '02:00:00:00:53:03', interface: 'eth0', firstSeen: S - 9000, lastQuery: S - 8000, numQueries: 1, macVendor: null, ips: [] },
      // Pi-hole itself and null MAC: dropped
      { id: 4, hwaddr: '00:00:00:00:00:00', interface: 'lo', firstSeen: S, lastQuery: S, numQueries: 1, macVendor: null, ips: [{ ip: '127.0.0.1', name: 'localhost', lastSeen: S, nameUpdated: S }] },
      { id: 5, hwaddr: '00:00:00:00:00:00', interface: 'eth0', firstSeen: S, lastQuery: S, numQueries: 1, macVendor: null, ips: [] },
    ],
    took: 0.002,
  }
  const out = parseDevices(json)
  assert.deepEqual(out[0], {
    mac: '00:00:5e:00:53:01', source: 'pihole', vendor: 'Exemple SA', firstSeen: (S - 86400) * 1000, lastQuery: (S - 30) * 1000,
    ip: '192.0.2.10', ts: S * 1000, presence: true, name: 'nas.lan', hostname: 'nas.lan',
  })
  assert.equal(out.length, 4)
  assert.deepEqual(out.slice(1, 3).map(o => [o.mac, o.ip, o.ts, o.name]), [
    ['00:00:5e:00:53:02', '192.0.2.36', (S - 600) * 1000, undefined],
    ['00:00:5e:00:53:02', '192.0.2.37', S * 1000, undefined],
  ])
  assert.equal(out[1].vendor, undefined)
  assert.deepEqual(out[3], { mac: '02:00:00:00:53:03', source: 'pihole', vendor: undefined, firstSeen: (S - 9000) * 1000, lastQuery: (S - 8000) * 1000, ip: null, ts: (S - 8000) * 1000, presence: false })
  assert.throws(() => parseDevices({ error: { key: 'unauthorized' } }), /inattendue/)
})

test('Pi-hole dhcp/leases: active lease = identity, never presence', () => {
  const now = S * 1000
  const out = parseLeases({
    leases: [
      { expires: S + 3600, hwaddr: '00:00:5e:00:53:21', ip: '192.0.2.21', name: 'Galaxy-Exemple', clientid: '01:00:00:5e:00:53:21' },
      { expires: 0, hwaddr: '00:00:5e:00:53:22', ip: '192.0.2.22', name: '*', clientid: '*' }, // never-ending lease, no name
      { expires: S - 1, hwaddr: '00:00:5e:00:53:23', ip: '192.0.2.23', name: 'vieux', clientid: '*' }, // expired
      { expires: S + 60, hwaddr: 'pas une mac', ip: '192.0.2.24', name: '', clientid: '' },
    ],
    took: 0.0005,
  }, now)
  assert.deepEqual(out, [
    { mac: '00:00:5e:00:53:21', ip: '192.0.2.21', source: 'dhcp', ts: now, presence: false, name: 'Galaxy-Exemple', leaseExpires: (S + 3600) * 1000 },
    // never-ending lease: expiry pushed back 15 min at every reading
    { mac: '00:00:5e:00:53:22', ip: '192.0.2.22', source: 'dhcp', ts: now, presence: false, name: undefined, leaseExpires: now + 15 * 60_000 },
  ])
  assert.throws(() => parseLeases({}, now), /inattendue/)
})

test('Pi-hole: read through the shared session, explicit size parameters', async () => {
  const paths = []
  const pihole = { get: async p => { paths.push(p); return { devices: [] } } }
  assert.deepEqual(await readDevices(pihole), [])
  assert.match(paths[0], /max_devices=1000&max_addresses=10/)
})

test('ip -j neigh: REACHABLE = presence, STALE/DELAY/PROBE = association', async () => {
  const now = 1_700_000_000_000
  const json = JSON.stringify([
    { dst: '192.0.2.10', dev: 'eth0', lladdr: '00:00:5E:00:53:0A', state: ['REACHABLE'] },
    { dst: '192.0.2.11', dev: 'eth0', lladdr: '00:00:5e:00:53:0b', state: ['STALE'] },
    { dst: '192.0.2.12', dev: 'eth0', lladdr: '00:00:5e:00:53:0c', state: ['DELAY'] },
    { dst: '192.0.2.13', dev: 'eth0', lladdr: '00:00:5e:00:53:0d', state: ['PROBE'] },
    { dst: '192.0.2.14', dev: 'eth0', state: ['FAILED'] },
    { dst: '192.0.2.15', dev: 'eth0', state: ['INCOMPLETE'] },
    { dst: 'fe80::1', dev: 'eth0', lladdr: '00:00:5e:00:53:10', router: null, state: ['STALE'] },
  ])
  assert.deepEqual(parseNeigh(json, now).map(s => [s.ip, s.mac, s.presence, s.ts, s.source]), [
    ['192.0.2.10', '00:00:5e:00:53:0a', true, now, 'neigh'],
    ['192.0.2.11', '00:00:5e:00:53:0b', false, now, 'neigh'],
    ['192.0.2.12', '00:00:5e:00:53:0c', false, now, 'neigh'],
    ['192.0.2.13', '00:00:5e:00:53:0d', false, now, 'neigh'],
  ])
  assert.deepEqual(parseNeigh('', now), [])
  assert.throws(() => parseNeigh('pas du json', now), /illisible/)
  assert.throws(() => parseNeigh({ dst: 'x' }, now), /inattendu/)
  // read: execFile without a shell, validated interface, short error
  let call
  const run = (cmd, args, opts, cb) => {
    call = [cmd, args]
    cb(null, json)
  }
  assert.equal((await readNeigh({ iface: 'eth0', now, run })).length, 4)
  assert.deepEqual(call, ['ip', ['-j', '-4', 'neigh', 'show', 'dev', 'eth0']])
  await assert.rejects(readNeigh({ iface: 'eth0; rm -rf /', run }), /invalid interface/)
  await assert.rejects(readNeigh({ run: (c, a, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' })) }), /commande absente/)
})

test('Proxmox: netX lines of VMs and containers, MAC in uppercase', () => {
  assert.deepEqual(parseNetLine('virtio=00:00:5E:00:53:31,bridge=vmbr0,firewall=1'), { mac: '00:00:5e:00:53:31', ip: null, bridge: 'vmbr0' })
  assert.deepEqual(parseNetLine('name=eth0,bridge=vmbr0,gw=192.0.2.254,hwaddr=02:00:00:00:53:32,ip=192.0.2.32/24,type=veth'),
    { mac: '02:00:00:00:53:32', ip: '192.0.2.32', bridge: 'vmbr0' })
  assert.deepEqual(parseNetLine('name=eth0,bridge=vmbr1,hwaddr=00:00:5E:00:53:33,ip=dhcp,type=veth'), { mac: '00:00:5e:00:53:33', ip: null, bridge: 'vmbr1' })
  assert.equal(parseNetLine('bridge=vmbr0'), null)
  assert.equal(parseNetLine(null), null)
})

const baseCfg = {
  version: 2, title: 't', proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod', mac: '00:00:5E:00:53:45' },
    { id: 'docker', name: 'docker-a', kind: 'vm', pve: 'prod', vmid: 100, ip: '192.0.2.156', parent: 'pve', env: 'prod' },
    { id: 'pihole', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, ip: '192.0.2.158', parent: 'pve', env: 'prod' },
  ],
  groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
}

test('Proxmox: guestNics (simulated fetch) → observations linked to cfg.hosts', async () => {
  const { config: cfg, errors } = parseConfig(baseCfg)
  assert.equal(errors, undefined)
  const api = {
    '/cluster/resources?type=vm': [
      { vmid: 100, name: 'Docker', type: 'qemu', node: 'pve', status: 'running' },
      { vmid: 105, name: 'pihole', type: 'lxc', node: 'pve', status: 'running' },
      { vmid: 900, name: 'modele', type: 'qemu', node: 'pve', status: 'stopped', template: 1 },
    ],
    '/nodes/pve/qemu/100/config': { net0: 'virtio=00:00:5E:00:53:46,bridge=vmbr0,firewall=1', name: 'Docker' },
    '/nodes/pve/qemu/100/agent/network-get-interfaces': { result: [
      { name: 'ens18', 'hardware-address': '00:00:5e:00:53:46', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '192.0.2.156', prefix: 24 }] },
      { name: 'docker0', 'hardware-address': '02:42:00:00:00:01', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '172.17.0.1', prefix: 16 }] },
    ] },
    '/nodes/pve/lxc/105/config': { net0: 'name=eth0,bridge=vmbr0,gw=192.0.2.254,hwaddr=00:00:5E:00:53:48,ip=192.0.2.158/24,type=veth' },
    '/nodes/pve/lxc/105/interfaces': [{ name: 'eth0', hwaddr: '00:00:5e:00:53:48', inet: '192.0.2.158/24' }, { name: 'lo', hwaddr: '00:00:00:00:00:00', inet: '127.0.0.1/8' }],
  }
  const calls = []
  const fetch = async url => {
    const p = String(url).replace('https://192.0.2.155:8006/api2/json', '')
    calls.push(p)
    return p in api ? Response.json({ data: api[p] }) : new Response('', { status: 403 })
  }
  // test CA (the production CAs are no longer in server/pki)
  const sources = createSources(cfg, { PVE_PROD_TOKEN_ID: 'id', PVE_PROD_TOKEN_SECRET: 'secret' }, { fetch, pkiDir: testPkiDir() })
  const nics = await sources.guestNics()
  assert.equal(nics[0].error, undefined)
  assert.deepEqual(nics[0].guests.map(g => [g.vmid, g.nics.map(n => [n.mac, n.ip, n.ips])]), [
    [100, [['00:00:5e:00:53:46', null, ['192.0.2.156']]]],
    [105, [['00:00:5e:00:53:48', '192.0.2.158', ['192.0.2.158']]]],
  ])
  await sources.guestNics() // 10-min cache: no new call
  assert.equal(calls.length, 5)
  const now = 1_700_000_000_000
  assert.deepEqual(guestSightings(nics, cfg, now), [
    { mac: '00:00:5e:00:53:46', ip: '192.0.2.156', source: 'pve', ts: now, presence: false, name: 'docker-a', hostId: 'docker' },
    { mac: '00:00:5e:00:53:48', ip: '192.0.2.158', source: 'pve', ts: now, presence: false, name: 'pihole', hostId: 'pihole' },
  ])
  assert.deepEqual(guestSightings([{ id: 'prod', error: 'Proxmox 401' }], cfg, now), [])
  // hosts[].mac from the config (lowercased by the schema)
  assert.deepEqual(configSightings(cfg, now), [{ mac: '00:00:5e:00:53:45', ip: '192.0.2.155', source: 'config', ts: now, presence: false, name: 'pve', hostId: 'pve' }])
})
