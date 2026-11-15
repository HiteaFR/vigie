// Consistency anchor of the ARP probe: a sweep only counts if the gateway answers in it.
// Gateway: the subnets[].gateway override, otherwise the container's default route read
// from /proc/net/route (default: fixture). Every failure is closed: presence frozen,
// presenceSince not set, source_error, message without the file's content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultGateway, hexToIp } from '../lib/network/sources/route.js'
import { parseConfig } from '../lib/config.js'
import { r3Bench, routeFile, FIXTURE_HOSTS } from './network-fixture.js'

const T = Date.parse('2026-10-21T08:00:00Z')
const HEAD = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
const row = (iface, dest, gw, flags, metric, mask = '00000000') => `${iface}\t${dest}\t${gw}\t${flags}\t0\t0\t${metric}\t${mask}\t0\t0\t0\n`

test('defaultGateway: default route, UP and GATEWAY flags, interface, metric, tie, unreadable content', () => {
  assert.equal(hexToIp('FE00000A'), '10.0.0.254')
  assert.equal(hexToIp('zz'), null)
  // the real /proc/net/route format (dashboard container)
  assert.deepEqual(defaultGateway(HEAD + row('eth0', '00000000', 'FE00000A', '0003', 0) + row('docker0', '000011AC', '00000000', '0001', 0, '0000FFFF'), 'eth0'), { gateway: '10.0.0.254', error: null })
  // route without RTF_UP or without RTF_GATEWAY: ignored
  assert.equal(defaultGateway(HEAD + row('eth0', '00000000', 'FE00000A', '0002', 0), 'eth0').error, 'passerelle inconnue')
  assert.equal(defaultGateway(HEAD + row('eth0', '00000000', 'FE00000A', '0001', 0), 'eth0').error, 'passerelle inconnue')
  // only on another interface, or not a default route (destination, mask)
  assert.equal(defaultGateway(HEAD + row('eth1', '00000000', 'FE00000A', '0003', 0), 'eth0').error, 'passerelle inconnue')
  assert.equal(defaultGateway(HEAD + row('eth0', '0000000A', 'FE00000A', '0003', 0, '00FFFFFF'), 'eth0').error, 'passerelle inconnue')
  assert.equal(defaultGateway(HEAD + row('eth0', '00000000', 'FE00000A', '0003', 0, '000000FF'), 'eth0').error, 'passerelle inconnue')
  // two routes: the lowest metric wins; tie between two different gateways: inconclusive
  assert.equal(defaultGateway(HEAD + row('eth0', '00000000', '0100000A', '0003', 200) + row('eth0', '00000000', 'FE00000A', '0003', 100), 'eth0').gateway, '10.0.0.254')
  assert.deepEqual(defaultGateway(HEAD + row('eth0', '00000000', '0100000A', '0003', 100) + row('eth0', '00000000', 'FE00000A', '0003', 100), 'eth0'), { gateway: null, error: 'passerelle ambiguë' })
  assert.equal(defaultGateway(HEAD + row('eth0', '00000000', 'FE00000A', '0003', 100) + row('eth0', '00000000', 'FE00000A', '0003', 100), 'eth0').gateway, '10.0.0.254')
  // unreadable
  for (const t of ['', 'pas une table', null, HEAD]) assert.equal(defaultGateway(t, 'eth0').error, 'passerelle inconnue')
})

test('schema: the subnets[].gateway override must be an IPv4 inside the CIDR', () => {
  const cfgOf = gateway => parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN', ...(gateway ? { gateway } : {}) }], sources: {} } })
  assert.equal(cfgOf(null).errors ?? null, null)
  assert.equal(cfgOf('192.0.2.254').errors ?? null, null)
  assert.match(cfgOf('198.51.100.1').errors.join(), /gateway outside the subnet/)
  assert.ok(cfgOf('192.0.2.300').errors)
})

test('route read: gateway of the default route; a route change is picked up at the next sweep', async () => {
  const b = r3Bench({ T, gateway: 'route' }) // default route → 192.0.2.40
  await b.run(2)
  assert.ok(b.store.kv.get('network.presenceSince'))
  assert.deepEqual(b.network.view().gateway, { ip: '192.0.2.40', source: 'route' })
  b.route.text = routeFile('290200C0') // 192.0.2.41, which also answers
  await b.run(2)
  assert.deepEqual(b.network.view().gateway, { ip: '192.0.2.41', source: 'route' })
  assert.equal(b.network.view().sources.arp.ok, true)
  b.route.text = routeFile('630200C0') // 192.0.2.99: missing from the sweep
  await b.run(2)
  assert.equal(b.network.view().sources.arp.error, 'passerelle absente du balayage')
})

test('override from the config: takes precedence over the route', async () => {
  const b = r3Bench({ T, gateway: 'config', route: { text: routeFile('630200C0') } }) // route to a silent IP
  await b.run(2)
  assert.deepEqual(b.network.view().gateway, { ip: '192.0.2.40', source: 'config' })
  assert.ok(b.store.kv.get('network.presenceSince'))
})

test('route missing, outside the LAN, unreadable, ambiguous: closed failure reported (a single source_error), presenceSince not set, no per-device message', async () => {
  const tie = routeFile('280200C0', { metric: 100 }) + routeFile('290200C0', { metric: 100 }).split('\n')[1] + '\n'
  for (const [text, error] of [[`${HEAD}`, 'passerelle inconnue'], [routeFile('016433C6'), 'passerelle hors LAN'], [new Error('EACCES /proc/net/route SECRET'), 'passerelle inconnue'],
    [routeFile('280200C0', { flags: '0002' }), 'passerelle inconnue'], [tie, 'passerelle ambiguë']]) {
    const b = r3Bench({ T, gateway: 'route', route: { text } })
    await b.run(16)
    assert.equal(b.store.kv.get('network.presenceSince'), null, error)
    assert.equal(b.network.view().sources.arp.error, error)
    assert.doesNotMatch(JSON.stringify(b.network.view().sources.arp), /SECRET|EACCES|016433C6/)
    assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_devices WHERE online IS NOT NULL').get().n, 0)
    assert.deepEqual(b.firing('source_error:network/arp').length, 1, error)
    assert.equal(b.firing('net_').length, 0)
    assert.equal(b.telegram.sent.length, 1) // the failing source, nothing per device
    assert.match(b.telegram.sent[0].text, /sonde ARP/)
  }
})

test('sweep without the gateway, or empty file: does not count; then presence frozen and source in error', async () => {
  const b = r3Bench({ T })
  const noGw = FIXTURE_HOSTS.filter(h => h.ip !== '192.0.2.40')
  await b.run(20, [])
  await b.run(20, noGw)
  assert.equal(b.store.kv.get('network.presenceSince'), null)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_devices WHERE online IS NOT NULL').get().n, 0)
  assert.equal(b.network.view().sources.arp.error, 'passerelle absente du balayage')
  assert.deepEqual([b.outbox(), b.telegram.sent.length], [0, 0]) // before the first valid sweep: not reported
  // the gateway answers: normal start, then empty sweeps flip nobody
  await b.run(60)
  const before = b.store.db.prepare('SELECT id, online FROM net_devices ORDER BY id').all()
  await b.run(30, [])
  assert.deepEqual(b.store.db.prepare('SELECT id, online FROM net_devices ORDER BY id').all(), before)
  assert.equal(b.network.view().presence, 'passive')
  assert.equal(b.firing('source_error:network/arp').length, 1)
  assert.equal(b.firing('net_down').length, 0)
})
