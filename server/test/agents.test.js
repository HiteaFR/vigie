// dash-report agent: the report reduction lets no sensitive field through,
// and the rules produce the right signals. Run in CI (npm test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast, cleanSlow } from '../lib/agents.js'
import { createRules } from '../lib/alerts/rules.js'
import { parseConfig } from '../lib/config.js'

const FORBIDDEN = ['Env', 'env', 'Mounts', 'mounts', 'Cmd', 'cmd', 'Args', 'Config', 'Entrypoint', 'Binds', 'Labels']

function keysDeep(o, out = new Set()) {
  if (Array.isArray(o)) o.forEach(x => keysDeep(x, out))
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.add(k); keysDeep(v, out) }
  return out
}

// a modified (or buggy) agent that would send back the full inspect
const hostile = {
  schema: 1, version: 1, mode: 'fast', ts: 1792256951, hostname: 'docker', os: 'Debian', kernel: '6.12',
  Env: ['ROOT=1'], mem: { total: 8e9, available: 7e9, Env: 'x' },
  fs: [{ mount: '/', type: 'ext4', size: 100, used: 90, avail: 10, Mounts: ['/secret'] }],
  systemd: { failed: [], watched: [], Cmd: 'x' },
  docker: {
    version: '29', Env: ['X=1'],
    containers: [{
      name: '/api', image: 'app:1', state: 'running', health: 'unhealthy', restarts: 2,
      Env: ['DB_PASSWORD=hunter2'], Mounts: [{ Source: '/srv' }], Cmd: ['run', '--token=abc'], Args: ['--token=abc'],
      Config: { Env: ['A=1'], Labels: { secret: 'x' } }, env: 'A=1', cmd: 'x',
    }],
  },
}

test('cleanFast: no sensitive field gets through', () => {
  const out = cleanFast(hostile)
  const keys = keysDeep(out)
  for (const k of FORBIDDEN) assert.ok(!keys.has(k), `forbidden key present: ${k}`)
  const txt = JSON.stringify(out)
  for (const secret of ['hunter2', 'token=abc', '/srv', '/secret', 'ROOT=1']) assert.ok(!txt.includes(secret), secret)
  assert.equal(out.docker.containers[0].name, 'api')
  assert.equal(out.docker.containers[0].health, 'unhealthy')
})

test('cleanSlow: apt and images allowlist', () => {
  const out = cleanSlow({ ts: 1, apt: { listsAt: 1, upgradable: 2, security: 1, packages: [{ name: 'a', suite: 's', version: '2', from: '1', Env: 'x' }] }, images: [{ id: 'sha', tags: ['a:1'], digests: [], Config: { Env: ['x'] } }] })
  const keys = keysDeep(out)
  for (const k of FORBIDDEN) assert.ok(!keys.has(k), k)
  // versions: only plausible package names and strings get through
  const v = cleanSlow({ versions: { caddy: '2.8.4', 'php8.4-fpm': '8.4.26', 'X Y': '1', Env: 'secret', nodejs: { a: 1 } } }).versions
  assert.deepEqual(v, { caddy: '2.8.4', 'php8.4-fpm': '8.4.26' })
})

function rulesWith(state, updates = null) {
  const raw = {
    version: 2, title: 'test',
    hosts: [
      { id: 'pve-b', name: 'pve-b', kind: 'pve-node', pve: 'dev', ip: '192.0.2.168', env: 'dev' },
      { id: 'd1', name: 'docker', kind: 'vm', pve: 'dev', vmid: 101, ip: '192.0.2.231', parent: 'pve-b', env: 'dev', agent: 'ssh' },
    ],
    proxmox: [{ id: 'dev', label: 'PVE dev', host: 'https://192.0.2.168:8006', env: 'PVE_DEV', ca: 'pki/pve-b.pem' }],
    groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  }
  const cfg = parseConfig(raw).config
  assert.ok(cfg, 'valid test config')
  const agents = { hosts: cfg.hosts.filter(h => h.agent), get: () => state }
  return createRules(cfg, { checks: [], result: () => null }, agents, updates)
}

test('rules: disk, container, apt, reboot', () => {
  const now = Date.now()
  const fast = cleanFast({ ...hostile, ts: now / 1000, reboot: { required: true, reason: 'noyau' } })
  fast.docker.containers[0].recentRestarts = 4
  const sigs = rulesWith({ ok: true, at: now, fast, slow: { apt: { listsAt: now / 1000 - 30 * 86400, upgradable: 5, security: 2 } } }).evaluate({}, now)
  const by = k => sigs.find(s => s.key === k)
  assert.equal(by('agent_unreachable:d1').cond, false)
  assert.equal(by('guest_disk:d1:/').cond, true)
  assert.equal(by('guest_disk:d1:/').severity, 'warning') // 90 %: dev capped
  assert.equal(by('container_unhealthy:d1/api').cond, true)
  assert.equal(by('container_restarting:d1/api').cond, true)
  assert.equal(by('reboot_required:d1').severity, 'info')
  assert.equal(by('apt_stale:d1').cond, true)
  assert.equal(by('security_updates:d1').cond, true)
  assert.ok(by('guest_disk:d1:/').parents.includes('agent_unreachable:d1'))
  assert.ok(by('agent_unreachable:d1').parents.includes('guest_stopped:d1'))
})

test('rules: container_unhealthy only while running (Docker keeps the last health after a stop)', () => {
  const now = Date.now()
  const cond = state => {
    const fast = cleanFast({ ...hostile, ts: now / 1000 })
    fast.docker.containers[0].state = state
    return rulesWith({ ok: true, at: now, fast }).evaluate({}, now).find(s => s.key === 'container_unhealthy:d1/api').cond
  }
  assert.equal(cond('running'), true)
  for (const state of ['exited', 'paused', 'created', 'dead', 'restarting', null]) assert.equal(cond(state), false, String(state))
})

test('rules: agent unreachable → the other signals go quiet', () => {
  const now = Date.now()
  const sigs = rulesWith({ ok: false, at: now - 10 * 60_000, error: 'clé refusée', errorKind: 'auth', fast: cleanFast(hostile) }).evaluate({}, now)
  assert.equal(sigs.find(s => s.key === 'agent_unreachable:d1').cond, true)
  assert.ok(!sigs.some(s => s.rule === 'guest_disk' || s.rule === 'container_unhealthy'))
})

test('rules: host key changed → immediate alert', () => {
  const sigs = rulesWith({ ok: false, at: null, error: "clé d'hôte", errorKind: 'hostkey' }).evaluate({}, Date.now())
  const a = sigs.find(s => s.key === 'agent_unreachable:d1')
  assert.equal(a.forSec, 0)
  assert.equal(a.cond, true)
})

test('apt: held packages kept apart (v5), security updates ignored from the updates page', () => {
  const slow = cleanSlow({ apt: { listsAt: 1, upgradable: 0, security: 0, held: 1, packages: [{ name: 'nginx', suite: 'stable', version: '2', from: '1', held: true }] } })
  assert.equal(slow.apt.held, 1)
  assert.equal(slow.apt.packages[0].held, true)
  const now = Date.now()
  const state = { ok: true, at: now, fast: cleanFast({ ...hostile, ts: now / 1000 }), slow: { apt: { listsAt: now / 1000, upgradable: 3, security: 2 } } }
  const updates = { signals: () => [], isIgnored: id => id === 'apt:d1' }
  assert.equal(rulesWith(state).evaluate({}, now).find(s => s.key === 'security_updates:d1').cond, true)
  assert.equal(rulesWith(state, updates).evaluate({}, now).find(s => s.key === 'security_updates:d1').cond, false)
})

// --- v6 allowlist -------------------------------------------------------------------------
const { parseReport } = await import('../lib/agents.js')
const v6 = (extra = {}) => ({
  schema: 1, version: 6, mode: 'fast', ts: 1792256951, hostname: 'docker',
  net: {
    ifaces: [{ name: 'ens18', mac: 'BC:24:11:00:53:01', ipv4: ['192.0.2.10/24'] }],
    neigh: [{ ip: '192.0.2.254', mac: '00:00:5e:00:53:fe', dev: 'ens18', state: 'REACHABLE' }],
  },
  docker: {
    version: '29.9.1',
    networks: [{ name: 'local', driver: 'macvlan' }, { name: 'bridge', driver: 'bridge' }],
    containers: [{ name: '/speedtest-tracker', image: 'x:1', state: 'running',
      networks: [{ network: 'bridge', ip: '172.18.0.4', mac: '02:42:ac:12:00:04' }, { network: 'local', ip: '192.0.2.193', mac: '0A:00:00:00:53:F1' }, null] }],
  },
  ...extra,
})

test('cleanFast: v5 → v6 fields undefined (never []); v6 nominal', () => {
  const r5 = cleanFast({ ...v6(), version: 5 })
  assert.equal(r5.net, undefined)
  assert.equal('net' in r5, false)
  assert.equal(r5.docker.networks, undefined)
  assert.equal(r5.docker.containers[0].networks, undefined)
  const r = cleanFast(v6())
  assert.deepEqual(r.net, { ifaces: [{ name: 'ens18', mac: 'bc:24:11:00:53:01', ipv4: ['192.0.2.10/24'] }], neigh: [{ ip: '192.0.2.254', mac: '00:00:5e:00:53:fe', dev: 'ens18', state: 'REACHABLE' }] })
  assert.deepEqual(r.docker.networks, [{ name: 'local', driver: 'macvlan' }, { name: 'bridge', driver: 'bridge' }])
  assert.deepEqual(r.docker.containers[0].networks, [{ network: 'bridge', ip: '172.18.0.4', mac: '02:42:ac:12:00:04' }, { network: 'local', ip: '192.0.2.193', mac: '0a:00:00:00:53:f1' }])
  // v6 without net or networks (ip missing, docker network ls failing): null, not []
  const bare = cleanFast({ ...v6(), net: null, docker: { version: '29', networks: null, containers: [] } })
  assert.deepEqual([bare.net, bare.docker.networks], [null, null])
})

test('cleanFast: hostile v6 report → injected fields absent, names bounded and literal, limits, invalid entries removed', () => {
  const evil = '<img src=x onerror=alert(1)>\u0007\u001b'.padEnd(10_000, 'x')
  const r = v6({
    Env: ['ROOT=1'],
    net: {
      Env: 'x',
      ifaces: [
        { name: 'bad name', mac: '00:00:5e:00:53:02', ipv4: ['192.0.2.2/24'] }, { name: 'ok0', mac: 'zz', ipv4: ['192.0.2.3/24'] }, { name: 'noip', mac: null, ipv4: ['300.0.0.1/24'] },
        ...Array.from({ length: 50 }, (_, i) => ({ name: `eth${i}`, mac: '00:00:5e:00:53:01', ipv4: ['192.0.2.1/24'], Aliases: ['secret'] })),
      ],
      neigh: [
        { ip: '198.51.100.9', mac: 'zz', dev: 'ens18', state: 'REACHABLE' }, { ip: '198.51.100.9', mac: '00:00:5e:00:53:09', dev: 'ens18', state: 'FAILED' },
        ...Array.from({ length: 600 }, (_, i) => ({ ip: `192.0.2.${i % 250}`, mac: '00:00:5e:00:53:03', dev: 'ens18', state: 'REACHABLE', DriverOpts: { a: 1 } })),
      ],
    },
    docker: {
      version: '29', Labels: { secret: 'x' },
      networks: [{ name: evil, driver: 'weird', DriverOpts: { secret: 1 }, Labels: { a: 1 } }, { name: 'local', driver: 'macvlan' }],
      containers: [{
        name: '/c', Env: ['DB_PASSWORD=hunter2'], Cmd: ['--token=abc'], Mounts: [{ Source: '/srv' }], Labels: { s: 1 },
        networks: [
          { network: evil, ip: '192.0.2.193', mac: '0a:00:00:00:53:f1', Aliases: ['alias-secret'], DNSNames: ['dns-secret'], DriverOpts: { o: 1 }, EndpointID: 'eid', Gateway: '192.0.2.254' },
          { network: 'n2', ip: '999.1.1.1', mac: '0a:00:00:00:53:f2' }, { network: 'n3', ip: '192.0.2.5', mac: 'pas-une-mac' },
          ...Array.from({ length: 20 }, (_, i) => ({ network: `x${i}`, ip: null, mac: null })),
        ],
      }],
    },
  })
  const out = cleanFast(r)
  const keys = keysDeep(out)
  for (const k of ['Env', 'Cmd', 'Mounts', 'Labels', 'Aliases', 'DNSNames', 'DriverOpts', 'EndpointID', 'Gateway']) assert.ok(!keys.has(k), k)
  const txt = JSON.stringify(out)
  for (const secret of ['hunter2', 'token=abc', '/srv', 'alias-secret', 'dns-secret', 'ROOT=1']) assert.ok(!txt.includes(secret), secret)
  assert.equal(out.net.ifaces.length, 32)
  assert.equal(out.net.neigh.length, 512)
  assert.ok(!out.net.ifaces.some(i => ['bad name', 'ok0', 'noip'].includes(i.name)))
  assert.ok(!out.net.neigh.some(x => x.ip === '198.51.100.9'))
  const n0 = out.docker.networks[0]
  assert.equal(n0.name.length, 64)
  assert.ok(n0.name.startsWith('<img src=x onerror=alert(1)>') && !/[\u0000-\u001f]/.test(n0.name))
  assert.equal(n0.driver, 'other')
  const eps = out.docker.containers[0].networks
  assert.equal(eps.length, 8)
  assert.deepEqual(eps[0], { network: n0.name, ip: '192.0.2.193', mac: '0a:00:00:00:53:f1' })
  assert.ok(!eps.some(e => e.network === 'n2' || e.network === 'n3'))
})

test('fast report over 512 KiB refused (report too large message); slow not affected', () => {
  const big = JSON.stringify({ ...v6(), pad: 'x'.repeat(600 * 1024) })
  assert.throws(() => parseReport(big, 'fast'), e => e.info.kind === 'format' && e.info.msg === 'rapport trop gros')
  assert.equal(parseReport(JSON.stringify(v6()), 'fast').version, 6)
  assert.throws(() => parseReport('{', 'fast'), e => /JSON invalide/.test(e.info.msg))
})
