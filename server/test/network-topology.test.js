// Network map: buildTopology and toMermaid (pure). Tree, gateway, manually entered
// links, cycles, linked records as a single node, grouping, hostile names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology, toMermaid, findCycle, effectiveParents, mermaidLabel, canonicalRef } from '../lib/network/topology.js'
import { parseConfig } from '../lib/config.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const cfg = (() => {
  const { config, errors } = parseConfig({
    version: 2, title: 't',
    proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod' },
      { id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 101, ip: '192.0.2.11', env: 'prod' },
      { id: 'db', name: 'db', kind: 'vm', pve: 'prod', vmid: 102, ip: '192.0.2.12', env: 'prod' },
      { id: 'app', name: 'app', kind: 'lxc', pve: 'prod', vmid: 103, ip: '192.0.2.13', parent: 'db', env: 'prod' },
      { id: 'router', name: 'Routeur', kind: 'appliance', ip: '192.0.2.254', env: 'prod' },
    ],
    groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: {} },
  })
  if (errors) throw new Error(errors.join('\n'))
  return config
})()
const dev = (id, f = {}) => [id, { id, state: 'known', primary_mac: `00:00:5e:00:53:${String(id).padStart(2, '0')}`, disp_name: `appareil-${id}`, disp_type: 'phone', last_ip: `192.0.2.${100 + id}`, online: 1, ...f }]
const devices = (...list) => new Map(list)
const byId = (topo, id) => topo.nodes.find(n => n.id === id)

test('full tree: gateway (record linked to the router), hypervisor, guests, config parent, devices', () => {
  const ds = devices(dev(20, { host_id: 'router', last_ip: '192.0.2.254', disp_type: 'router' }), dev(1), dev(2, { state: 'new' }), dev(3, { online: 0, alert_down: 1 }))
  const topo = buildTopology({ cfg, devices: ds, gateway: '192.0.2.254', now: T })
  const parent = id => byId(topo, id).parent
  assert.equal(topo.gateway, 'host:router')
  assert.deepEqual([parent('host:router'), parent('host:pve'), parent('host:web'), parent('host:db'), parent('host:app'), parent('dev:1')],
    ['internet', 'host:router', 'host:pve', 'host:pve', 'host:db', 'host:router'])
  assert.deepEqual([byId(topo, 'host:web').origin, byId(topo, 'host:app').origin, byId(topo, 'dev:1').origin], ['pve', 'config', 'default'])
  // linked record = a single node (host:router), never dev:20
  assert.equal(byId(topo, 'dev:20'), undefined)
  assert.deepEqual([byId(topo, 'dev:1').state, byId(topo, 'dev:2').state, byId(topo, 'dev:3').state], ['ok', 'warn', 'crit'])
  assert.equal(byId(topo, 'dev:1').link, '?d=1')
  assert.equal(byId(topo, 'host:web').link, '?h=web')
  // stable order: two identical computations
  assert.deepEqual(buildTopology({ cfg, devices: ds, gateway: '192.0.2.254', now: T }), topo)
})

test('gateway without a record → gw:<ip>; no gateway → everything under internet', () => {
  const topo = buildTopology({ cfg, devices: devices(dev(1)), gateway: '192.0.2.1', now: T })
  assert.equal(topo.gateway, 'gw:192.0.2.1')
  assert.deepEqual([byId(topo, 'gw:192.0.2.1').parent, byId(topo, 'dev:1').parent], ['internet', 'gw:192.0.2.1'])
  const bare = buildTopology({ cfg, devices: devices(dev(1)), gateway: null, now: T })
  assert.equal(byId(bare, 'dev:1').parent, 'internet')
})

test('manual link takes priority; dev:<id> link of a linked record read as host:; orphan → warnings; cycle refused', () => {
  const ds = devices(dev(20, { host_id: 'router', last_ip: '192.0.2.254' }), dev(1), dev(2))
  const links = [{ id: 1, child: 'dev:20', parent: 'internet' }, { id: 2, child: 'dev:1', parent: 'dev:2' }, { id: 3, child: 'dev:99', parent: 'internet' }]
  const topo = buildTopology({ cfg, devices: ds, links, gateway: '192.0.2.254', now: T })
  assert.deepEqual([byId(topo, 'host:router').parent, byId(topo, 'dev:1').parent, byId(topo, 'dev:1').origin], ['internet', 'dev:2', 'manual'])
  assert.ok(topo.warnings.some(w => /lien 3 orphelin/.test(w)))
  // cycle: dev:2 → dev:1 while dev:1 → dev:2
  const { parents } = effectiveParents({ cfg, devices: ds, links, gateway: '192.0.2.254' })
  assert.equal(findCycle(parents, 'dev:2', 'dev:1'), true)
  assert.equal(findCycle(parents, 'dev:2', 'host:pve'), false)
  // bounded depth: a chain longer than the limit counts as a cycle
  const chain = new Map(Array.from({ length: 100 }, (_, i) => [`dev:${i}`, `dev:${i + 1}`]))
  assert.equal(findCycle(chain, 'x', 'dev:0', 64), true)
  // a cycle already in the database (old links): falls back to the default parent, reported
  const loop = buildTopology({ cfg, devices: ds, links: [{ id: 4, child: 'dev:1', parent: 'dev:2' }, { id: 5, child: 'dev:2', parent: 'dev:1' }], gateway: '192.0.2.254', now: T })
  assert.ok(loop.warnings.some(w => /cycle/.test(w)))
  assert.ok(['host:router', 'internet'].includes(byId(loop, 'dev:1').parent) || ['host:router', 'internet'].includes(byId(loop, 'dev:2').parent))
})

test('grouping beyond 6 leaves of the same type', () => {
  const ds = devices(...Array.from({ length: 8 }, (_, i) => dev(i + 1, { disp_type: 'iot' })), dev(30, { disp_type: 'phone' }))
  const topo = buildTopology({ cfg, devices: ds, gateway: null, now: T })
  assert.deepEqual(topo.groups.map(g => [g.id, g.members.length]), [['grp:internet/iot', 8]])
  assert.equal(byId(topo, 'dev:1').group, 'grp:internet/iot')
  assert.equal(byId(topo, 'dev:30').group, undefined)
})

test('hostile names: literal in the JSON, escaped in the .mmd (# first), no directive coming from the data', () => {
  const hostile = ['<script>alert(1)</script>', '"]--> x', '%%{init: {"theme":"dark"}}%%', 'a`b', 'x#lt;img src=x onerror=alert(1)#gt;', 'click n0 call evil()']
  const ds = devices(...hostile.map((name, i) => dev(i + 1, { disp_name: name })))
  const topo = buildTopology({ cfg, devices: ds, gateway: null, now: T })
  assert.equal(byId(topo, 'dev:1').label, '<script>alert(1)</script>') // text: React escapes it at render time
  const mmd = toMermaid(topo)
  assert.equal(mermaidLabel('x#lt;y'), 'x#35;lt;y') // never "<" when rendered
  assert.equal(mermaidLabel('<"&>'), '#lt;#quot;#amp;#gt;')
  assert.equal(mermaidLabel('a`b\nc\u0007'), 'abc')
  assert.ok(mermaidLabel('x'.repeat(200)).length <= 64)
  assert.doesNotMatch(mmd, /<script|"\]-->|`/)
  assert.match(mmd, /x#35;lt;img src=x onerror=alert\(1\)#35;gt;/) // the text stays, inert: "#lt;" never turns back into "<"
  assert.doesNotMatch(mmd, /^\s*(click|classDef|%%\{init)/m) // no directive line
  assert.match(mmd, /^graph LR\n/)
  for (const line of mmd.split('\n').slice(1).filter(Boolean)) assert.match(line, /^ {2}n\d+(\["[^"]*"\]| --> n\d+)$/)
})

// --- external host under Internet (A), parent inferred from services (B) -------------
const { PROD_HOSTS, PROD_SERVICES, PROD_DEVICES, PROD_BEFORE } = await import('./network-fixture.js')
const { literalIpv4, deviceParent } = await import('../lib/network/topology.js')
const prodCfg = (patch = c => c) => {
  const { config, errors } = parseConfig(patch({
    version: 2, title: 't',
    proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' }, { id: 'dev', label: 'PVE dev', host: 'https://192.0.2.168:8006', env: 'PVE_DEV', ca: 'pki/pve-b.pem' }],
    hosts: structuredClone(PROD_HOSTS),
    groups: [{ id: 'g', name: 'G' }],
    services: PROD_SERVICES.map(s => ({ ...s, name: s.id, group: 'g', ...(s.url ? {} : { checks: [{ type: 'http', url: `http://${s.id}.example.net/` }] }) })),
    gitea: { owner: 'o' },
    network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: {} },
  }))
  if (errors) throw new Error(errors.join('\n'))
  return config
}
const mac = id => `00:00:5e:00:53:${id.toString(16).padStart(2, '0')}`
// records of the prod fixture: the linked router (20, gateway) and the 13 unlinked devices
function prodState(edit = () => {}) {
  const devices = new Map([[20, { id: 20, state: 'known', primary_mac: mac(20), host_id: 'router', disp_name: 'Routeur', last_ip: '192.0.2.254', online: 1 }]])
  for (const [id, ip, type, online] of PROD_DEVICES) devices.set(id, { id, state: 'known', primary_mac: mac(id), disp_name: `appareil-${id}`, disp_type: type, last_ip: ip, online })
  const macs = new Map([...devices.values()].map(d => [d.primary_mac, { mac: d.primary_mac, device_id: d.id, last_ip: d.last_ip, attach: null, confirmed_at: null }]))
  const links = [{ id: 1, child: 'host:router', parent: 'internet', kind: 'uplink', port: null, note: null }]
  const s = { devices, macs, links }
  edit(s)
  return s
}
const parentsOf = (c, s) => Object.fromEntries(buildTopology({ cfg: c, ...s, gateway: '192.0.2.254', now: T }).nodes.filter(n => n.kind !== 'group' && n.parent).map(n => [n.id, n.parent]))
const node = (c, s, id) => buildTopology({ cfg: c, ...s, gateway: '192.0.2.254', now: T }).nodes.find(n => n.id === id)

test('prod fixture: EXACTLY 2 nodes change parent, 0 warning', () => {
  const c = prodCfg()
  const s = prodState()
  const topo = buildTopology({ cfg: c, ...s, gateway: '192.0.2.254', now: T })
  const after = parentsOf(c, s)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(PROD_BEFORE).sort())
  const changed = Object.keys(after).filter(k => after[k] !== PROD_BEFORE[k]).sort()
  assert.deepEqual(changed, ['dev:36', 'host:vps-ext-prod'])
  const n36 = topo.nodes.find(n => n.id === 'dev:36')
  const ext = topo.nodes.find(n => n.id === 'host:vps-ext-prod')
  assert.deepEqual([ext.parent, ext.origin], ['internet', 'external'])
  assert.deepEqual([n36.parent, n36.origin, n36.originService], ['host:docker-a', 'service', 'speedtest'])
  assert.deepEqual(topo.warnings, [])
})

test('A: external → internet; manual link and config parent take precedence; cycle → internet; appliance → gateway', () => {
  const c = prodCfg()
  assert.deepEqual([node(c, prodState(), 'host:nas').parent, node(c, prodState(), 'host:nas').origin], ['host:router', 'default'])
  const linked = prodState(s => s.links.push({ id: 2, child: 'host:vps-ext-prod', parent: 'host:nas', kind: 'other' }))
  assert.deepEqual([node(c, linked, 'host:vps-ext-prod').parent, node(c, linked, 'host:vps-ext-prod').origin], ['host:nas', 'manual'])
  const cp = prodCfg(x => { x.hosts.find(h => h.id === 'vps-ext-prod').parent = 'nas'; return x })
  assert.deepEqual([node(cp, prodState(), 'host:vps-ext-prod').parent, node(cp, prodState(), 'host:vps-ext-prod').origin], ['host:nas', 'config'])
  // cycle: vps-ext-prod under nas (config) and nas under vps-ext-prod (old link)
  const cyc = prodState(s => s.links.push({ id: 3, child: 'host:nas', parent: 'host:vps-ext-prod', kind: 'other' }))
  const { parents, warnings } = effectiveParents({ cfg: cp, ...cyc, gateway: '192.0.2.254' })
  assert.ok(warnings.some(w => /cycle/.test(w)))
  const ext = parents.get('host:vps-ext-prod')
  const nas = parents.get('host:nas')
  assert.ok((ext.parent === 'internet' && ext.origin === 'external') || nas.origin === 'default', JSON.stringify({ ext, nas }))
  assert.ok(!findCycle(parents, 'host:nas', nas.parent) && !findCycle(parents, 'host:vps-ext-prod', ext.parent))
  // an external that breaks the cycle (first one met) falls back to internet, not the gateway
  const cyc2 = prodState(s => s.links.push({ id: 4, child: 'host:vps-ext-prod', parent: 'dev:37', kind: 'other' }, { id: 5, child: 'dev:37', parent: 'host:vps-ext-prod', kind: 'other' }))
  const p2 = effectiveParents({ cfg: c, ...cyc2, gateway: '192.0.2.254' }).parents
  assert.deepEqual(p2.get('host:vps-ext-prod'), { parent: 'internet', origin: 'external' })
  assert.deepEqual([p2.get('dev:37').parent, p2.get('dev:37').origin], ['host:vps-ext-prod', 'manual'])
})

test('B: new intruder, pending MAC, changing IP, linked record, manual link, IP outside the LAN or of a host, check only', () => {
  const c = prodCfg()
  const at = (s, id = 'dev:36') => [node(c, s, id).parent, node(c, s, id).origin]
  // intruder: new record on .193 → gateway, warn state; the same record turned known → docker-a
  const intrus = prodState(s => { s.devices.get(36).state = 'new' })
  assert.deepEqual(at(intrus), ['host:router', 'default'])
  assert.equal(node(c, intrus, 'dev:36').state, 'warn')
  assert.deepEqual(at(prodState()), ['host:docker-a', 'service'])
  // only a pending MAC (attachment by name) carries .193 → gateway
  const pending = prodState(s => { s.macs.get(mac(36)).attach = 'name' })
  assert.deepEqual(at(pending), ['host:router', 'default'])
  assert.deepEqual(at(prodState(s => { Object.assign(s.macs.get(mac(36)), { attach: 'name', confirmed_at: T }) })), ['host:docker-a', 'service'])
  // changing IP (.193 → .150) → back to the gateway
  assert.deepEqual(at(prodState(s => { s.devices.get(36).last_ip = '192.0.2.150'; s.macs.get(mac(36)).last_ip = '192.0.2.150' })), ['host:router', 'default'])
  // linked record: its node is host:<id>, the rule does not apply
  const linkedDev = prodState(s => { s.devices.get(36).host_id = 'nas' })
  assert.equal(node(c, linkedDev, 'dev:36'), undefined)
  assert.deepEqual([node(c, linkedDev, 'host:nas').parent, node(c, linkedDev, 'host:nas').origin], ['host:router', 'default'])
  // manual link takes priority over service
  assert.deepEqual(at(prodState(s => s.links.push({ id: 9, child: 'dev:36', parent: 'host:nas', kind: 'ethernet' }))), ['host:nas', 'manual'])
  // IP of a host (.246, docker-a): identity, never a parent
  assert.deepEqual(at(prodState(s => { s.devices.get(37).last_ip = '192.0.2.156'; s.macs.get(mac(37)).last_ip = '192.0.2.156' }), 'dev:37'), ['host:router', 'default'])
  // IP outside the LAN: nothing
  const out = prodCfg(x => { x.services.push({ id: 'dehors', name: 'dehors', group: 'g', host: 'docker-a', url: 'http://203.0.113.9/' }); return x })
  const sOut = prodState(s => { s.devices.get(37).last_ip = '203.0.113.9'; s.macs.get(mac(37)).last_ip = '203.0.113.9' })
  assert.deepEqual([node(out, sOut, 'dev:37').parent, node(out, sOut, 'dev:37').origin], ['host:router', 'default'])
  // check whose target is .193, without URL: nothing
  const chk = prodCfg(x => { const sp = x.services.find(s => s.id === 'speedtest'); delete sp.url; sp.checks = [{ type: 'tcp', target: '192.0.2.193:80' }]; return x })
  assert.deepEqual([node(chk, prodState(), 'dev:36').parent, node(chk, prodState(), 'dev:36').origin], ['host:router', 'default'])
})

test('B: two hosts on the same IP → default + warning; same host → no warning; names and non-literal forms → nothing', () => {
  const two = prodCfg(x => { x.services.push({ id: 'autre', name: 'autre', group: 'g', host: 'docker-lab', url: 'https://192.0.2.193:8443/' }); return x })
  const t2 = buildTopology({ cfg: two, ...prodState(), gateway: '192.0.2.254', now: T })
  assert.deepEqual([t2.nodes.find(n => n.id === 'dev:36').parent, t2.nodes.find(n => n.id === 'dev:36').origin], ['host:router', 'default'])
  assert.deepEqual(t2.warnings, ['IP 192.0.2.193 revendiquée par plusieurs hôtes (docker-a, docker-lab) : parent par défaut'])
  const same = prodCfg(x => { x.services.push({ id: 'bis', name: 'bis', group: 'g', host: 'docker-a', url: 'http://192.0.2.193:9000/' }); return x })
  const t3 = buildTopology({ cfg: same, ...prodState(), gateway: '192.0.2.254', now: T })
  assert.deepEqual([t3.nodes.find(n => n.id === 'dev:36').origin, t3.nodes.find(n => n.id === 'dev:36').originService, t3.warnings], ['service', 'speedtest', []])
  for (const url of ['http://3232235969/', 'http://0xC0.0.2.193/', 'http://192.0.2.193.nip.io/', 'http://speedtest.example.net/', 'http://192.0.02.193/', 'http://[::ffff:192.0.2.193]/', 'pas une url']) {
    assert.equal(literalIpv4(url), null, url)
    if (url === 'pas une url') continue // rejected by the config schema
    const c = prodCfg(x => { x.services.find(s => s.id === 'speedtest').url = url; return x })
    assert.equal(node(c, prodState(), 'dev:36').origin, 'default', url)
  }
  assert.deepEqual(['http://192.0.2.193', 'HTTPS://u:p@192.0.2.193:8080/x?y#z'].map(literalIpv4), ['192.0.2.193', '192.0.2.193'])
})

test('B: cycle through the service parent (link host:docker-a → dev:36 refused); no DNS resolution', async () => {
  const c = prodCfg()
  const s = prodState()
  const { parents } = effectiveParents({ cfg: c, ...s, gateway: '192.0.2.254' })
  assert.equal(findCycle(parents, 'host:docker-a', 'dev:36'), true)
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../lib/network/topology.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /node:dns|from 'dns'|lookup\(|resolve4/)
  // mapParent (record) = map parent
  const mp = deviceParent(s.devices.get(36), { cfg: c, ...s, gateway: '192.0.2.254' })
  assert.deepEqual(mp, { ref: 'host:docker-a', label: 'docker-a', ip: '192.0.2.156', origin: 'service', originService: 'speedtest' })
})

// --- follow-up fixes -----------------------------------------------------------
test('a probe (checks[].url) targeting .193, without a service URL → no parent', () => {
  const c = prodCfg(x => { const sp = x.services.find(s => s.id === 'speedtest'); delete sp.url; sp.checks = [{ type: 'http', url: 'http://192.0.2.193/' }]; return x })
  assert.deepEqual([node(c, prodState(), 'dev:36').parent, node(c, prodState(), 'dev:36').origin], ['host:router', 'default'])
})

test('cycle created by a recomputation → the service parent gives way, the manual link stays; mapParent = map', () => {
  const c = prodCfg()
  // record 1 = docker-a (linked); manual link host:docker-a → dev:50 set when 50 was on .150
  const st = ip => prodState(s => {
    s.devices.set(1, { id: 1, state: 'known', primary_mac: mac(1), host_id: 'docker-a', disp_name: 'Docker', last_ip: '192.0.2.156', online: 1 })
    s.devices.set(50, { id: 50, state: 'known', primary_mac: mac(50), disp_name: 'appareil-50', disp_type: 'other', last_ip: ip, online: 1 })
    for (const id of [1, 50]) s.macs.set(mac(id), { mac: mac(id), device_id: id, last_ip: s.devices.get(id).last_ip, attach: null, confirmed_at: null })
    s.links.push({ id: 7, child: 'host:docker-a', parent: 'dev:50', kind: 'ethernet', port: '4', note: null })
  })
  const before = buildTopology({ cfg: c, ...st('192.0.2.150'), gateway: '192.0.2.254', now: T })
  assert.deepEqual(before.warnings, [])
  const s = st('192.0.2.193') // 50 moves to .193: its service parent would be host:docker-a → cycle
  const topo = buildTopology({ cfg: c, ...s, gateway: '192.0.2.254', now: T })
  const dp = topo.nodes.find(n => n.id === 'host:docker-a')
  const d50 = topo.nodes.find(n => n.id === 'dev:50')
  assert.deepEqual([dp.parent, dp.origin, dp.linkId], ['dev:50', 'manual', 7])
  assert.deepEqual([d50.parent, d50.origin], ['host:router', 'default'])
  assert.deepEqual(topo.warnings, ['cycle autour de dev:50 : parent par défaut'])
  // dev:36 (.193 too) leads to the cycle without being part of it: it keeps its service parent
  const d36 = topo.nodes.find(n => n.id === 'dev:36')
  assert.deepEqual([d36.parent, d36.origin], ['host:docker-a', 'service'])
  // mapParent: same as the map; linked record → parent of the host:docker-a node, with link
  const mp1 = deviceParent(s.devices.get(1), { cfg: c, ...s, gateway: '192.0.2.254' })
  assert.deepEqual(mp1, { ref: 'dev:50', label: 'appareil-50', ip: '192.0.2.193', origin: 'manual', link: { id: 7, kind: 'ethernet', port: '4', note: null } })
  const mp50 = deviceParent(s.devices.get(50), { cfg: c, ...s, gateway: '192.0.2.254' })
  assert.deepEqual([mp50.ref, mp50.origin], [d50.parent, d50.origin])
  // linked record without a manual link: mapParent = parent of the host:<id> node (config), never missing
  const plain = prodState(s2 => s2.devices.set(1, { id: 1, state: 'known', primary_mac: mac(1), host_id: 'docker-a', disp_name: 'Docker', last_ip: '192.0.2.156', online: 1 }))
  const mp = deviceParent(plain.devices.get(1), { cfg: c, ...plain, gateway: '192.0.2.254' })
  assert.deepEqual([mp.ref, mp.origin], [node(c, plain, 'host:docker-a').parent, 'config'])
})

test('ambiguity warning computed on the config, one per IP, even without a record or with two records', () => {
  const two = prodCfg(x => {
    x.services.push({ id: 'autre', name: 'autre', group: 'g', host: 'docker-lab', url: 'https://192.0.2.193:8443/' })
    x.services.push({ id: 'seul', name: 'seul', group: 'g', host: 'docker-b', url: 'http://192.0.2.77/' }, { id: 'seul2', name: 'seul2', group: 'g', host: 'docker-c', url: 'http://192.0.2.77:81/' })
    // host IP claimed by two hosts: excluded before the computation, no warning
    x.services.push({ id: 'h2', name: 'h2', group: 'g', host: 'docker-lab', url: 'http://192.0.2.156:9/' })
    return x
  })
  const want = ['IP 192.0.2.193 revendiquée par plusieurs hôtes (docker-a, docker-lab) : parent par défaut', 'IP 192.0.2.77 revendiquée par plusieurs hôtes (docker-b, docker-c) : parent par défaut']
  const twoDevs = prodState(s => { s.devices.get(37).last_ip = '192.0.2.193'; s.macs.get(mac(37)).last_ip = '192.0.2.193' })
  for (const s of [prodState(), twoDevs]) assert.deepEqual(buildTopology({ cfg: two, ...s, gateway: '192.0.2.254', now: T }).warnings, want)
  assert.deepEqual([node(two, twoDevs, 'dev:36').origin, node(two, twoDevs, 'dev:37').origin], ['default', 'default'])
})

// --- agent origin; cycle of more than 64 nodes -------------------
test('agent origin: associated record → host:H (agent, originContainer), before service; manual link takes priority; linked record → no agent', () => {
  const c = prodCfg()
  const ctr = new Map([[36, { host: 'docker-a', name: 'speedtest-tracker', network: 'local' }]])
  const at = (s, containerOf = ctr, id = 'dev:36') => buildTopology({ cfg: c, ...s, containerOf, gateway: '192.0.2.254', now: T }).nodes.find(n => n.id === id)
  const n = at(prodState())
  assert.deepEqual([n.parent, n.origin, n.originContainer, n.originService], ['host:docker-a', 'agent', 'speedtest-tracker', undefined])
  // agent before service: a container announced on another host wins over the URL
  const other = at(prodState(), new Map([[36, { host: 'docker-lab', name: 'x', network: 'local' }]]))
  assert.deepEqual([other.parent, other.origin], ['host:docker-lab', 'agent'])
  // host unknown to the config: service rule
  assert.equal(at(prodState(), new Map([[36, { host: 'ailleurs', name: 'x', network: 'local' }]])).origin, 'service')
  // manual link takes priority
  const linked = at(prodState(s => s.links.push({ id: 9, child: 'dev:36', parent: 'host:nas', kind: 'ethernet' })))
  assert.deepEqual([linked.parent, linked.origin], ['host:nas', 'manual'])
  // record linked to a host: host: node, never the agent origin
  const s = prodState(x => { x.devices.get(36).host_id = 'nas' })
  assert.equal(at(s, ctr, 'dev:36'), undefined)
  assert.notEqual(at(s, ctr, 'host:nas').origin, 'agent')
  // mapParent = map
  const mp = deviceParent(prodState().devices.get(36), { cfg: c, ...prodState(), containerOf: ctr, gateway: '192.0.2.254' })
  assert.deepEqual([mp.ref, mp.origin, mp.originContainer], ['host:docker-a', 'agent', 'speedtest-tracker'])
})

test('cycle of 70 manual links → the map builds, at least one warning; cycle of 3 unchanged', () => {
  const c = prodCfg()
  const s = prodState(st => {
    for (let i = 100; i < 170; i++) st.devices.set(i, { id: i, state: 'known', primary_mac: mac(i), disp_name: `n${i}`, last_ip: `198.51.100.${i - 99}`, online: 1 })
    for (let i = 100; i < 170; i++) st.links.push({ id: i, child: `dev:${i}`, parent: `dev:${i === 169 ? 100 : i + 1}`, kind: 'ethernet' })
    // a chain of 5 upstream nodes, leading to the cycle without being part of it
    for (let i = 200; i < 205; i++) {
      st.devices.set(i, { id: i, state: 'known', primary_mac: mac(i), disp_name: `a${i}`, last_ip: `198.51.100.${i - 50}`, online: 1 })
      st.links.push({ id: i, child: `dev:${i}`, parent: i === 204 ? 'dev:130' : `dev:${i + 1}`, kind: 'ethernet' })
    }
  })
  const topo = buildTopology({ cfg: c, ...s, gateway: '192.0.2.254', now: T })
  assert.ok(topo.warnings.some(w => /cycle/.test(w)))
  // ONE SINGLE node gives way (the one of the cycle handled first), upstream nodes keep their link
  const yielded = topo.nodes.filter(n => n.id.startsWith('dev:') && Number(n.id.slice(4)) >= 100 && n.origin !== 'manual')
  assert.deepEqual(yielded.map(n => n.id), ['dev:100'])
  for (let i = 200; i < 205; i++) assert.equal(topo.nodes.find(n => n.id === `dev:${i}`).origin, 'manual')
  // each node goes up to internet (tree), without a loop
  const parent = new Map(topo.nodes.map(n => [n.id, n.parent]))
  for (const n of topo.nodes) {
    let cur = n.id
    for (let k = 0; k < 500 && cur !== 'internet'; k++) cur = parent.get(cur)
    assert.equal(cur, 'internet', n.id)
  }
  // one parent per node and a single root: what stratify (map) requires
  assert.deepEqual(topo.nodes.filter(n => !n.parent).map(n => n.id), ['internet'])
  // cycle of 3 (manual link, service): unchanged (the service gives way, the manual link stays)
  const k3 = prodState(st => {
    st.devices.set(50, { id: 50, state: 'known', primary_mac: mac(50), disp_name: 'appareil-50', last_ip: '192.0.2.193', online: 1 })
    st.macs.set(mac(50), { mac: mac(50), device_id: 50, last_ip: '192.0.2.193', attach: null, confirmed_at: null })
    st.devices.set(1, { id: 1, state: 'known', primary_mac: mac(1), host_id: 'docker-a', disp_name: 'Docker', last_ip: '192.0.2.156', online: 1 })
    st.links.push({ id: 7, child: 'host:docker-a', parent: 'dev:50', kind: 'ethernet' })
  })
  const t3 = buildTopology({ cfg: c, ...k3, gateway: '192.0.2.254', now: T })
  assert.deepEqual([t3.nodes.find(n => n.id === 'host:docker-a').origin, t3.nodes.find(n => n.id === 'dev:50').origin], ['manual', 'default'])
})

// record whose host left the config (host_id still in the database, before the next
// scan or through a manual association) → ordinary device, never host:<unknown> nor an exception
test('record linked to a host missing from the config → dev: node, map, record parent and Mermaid without exception', () => {
  const ds = devices(dev(20, { host_id: 'router', last_ip: '192.0.2.254' }), dev(13, { host_id: 'vps-ext', last_ip: '192.0.2.233' }))
  const links = [{ id: 1, child: 'dev:13', parent: 'internet' }]
  const topo = buildTopology({ cfg, devices: ds, links, gateway: '192.0.2.254', now: T })
  assert.equal(byId(topo, 'host:vps-ext'), undefined)
  assert.deepEqual([byId(topo, 'dev:13').kind, byId(topo, 'dev:13').parent, byId(topo, 'dev:13').origin], ['device', 'internet', 'manual'])
  assert.ok(!topo.nodes.some(n => n.parent === 'host:vps-ext'))
  assert.ok(toMermaid(topo).includes('appareil-13'))
  assert.equal(deviceParent(ds.get(13), { cfg, devices: ds, links, gateway: '192.0.2.254' }).ref, 'internet')
  // entering a link (writes.js): dev:13 stays dev:13, never host:vps-ext
  const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))
  assert.deepEqual([canonicalRef('dev:13', { devices: ds, hostsById }), canonicalRef('dev:20', { devices: ds, hostsById }), canonicalRef('host:vps-ext', { devices: ds, hostsById })], ['dev:13', 'host:router', null])
  const sans = buildTopology({ cfg, devices: ds, gateway: '192.0.2.254', now: T })
  assert.equal(byId(sans, 'dev:13').parent, 'host:router')
})
