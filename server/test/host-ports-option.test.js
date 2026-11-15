// Host option alerts.ports false: no port_new alert for that host (dev
// workstation). Real SQLite database (temporary folder removed after the test), real memory, real
// rules, real engine, real notifier on a fake Telegram; dummy data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { createAgentMemory } from '../lib/agentmemory.js'
import { tmpStore } from './tmpdir.js'

const MIN = 60_000
const H = 3600_000
const DAY = 24 * H
const T0 = Date.parse('2026-11-03T10:00:00Z') // Monday, outside quiet hours
const raw = (orcaAlerts) => ({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'dev', label: 'd', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'devbox', name: 'devbox', kind: 'vm', pve: 'dev', vmid: 107, ip: '192.0.2.147', env: 'dev', agent: 'ssh', ...(orcaAlerts !== undefined ? { alerts: orcaAlerts } : {}) },
    { id: 'd3', name: 'docker-c', kind: 'vm', pve: 'dev', vmid: 105, ip: '192.0.2.145', env: 'dev', agent: 'ssh' },
  ],
})
const cfgOf = orcaAlerts => {
  const r = parseConfig(raw(orcaAlerts))
  assert.ok(r.config, r.errors?.join('\n'))
  return r.config
}
const STD = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: false }, firewall: { type: 'nftables', active: true } }
const ROOT = { ...STD, ssh: { ...STD.ssh, permitRootLogin: 'yes' } }
const L = (...ports) => ports.map(p => ({ proto: 'tcp', addr: '0.0.0.0', port: p, process: `p${p}` }))
const slow = (t, listening, posture = STD) => cleanSlow({ version: 8, ts: Math.floor(t / 1000), posture, listening })
const live = (s, t) => ({ ok: true, at: t, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow: s, slowAt: t })

// bench: the config changes along the way (setConfig) without recreating the engine
function bench(t, orcaAlerts) {
  let cfg = cfgOf(orcaAlerts)
  const store = tmpStore('dash-l18-ports-', t)
  const states = {}
  const agents = { hosts: cfg.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } }
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: agents.hosts.map(h => h.id) })
  const clock = createClock('Europe/Paris')
  const sent = []
  const telegram = { configured: true, send: async text => { sent.push(text) } }
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter: createFormatter({ dashboardUrl: null, clock }), log: { log() {}, error() {} } })
  const rules = createRules(cfg, { checks: [], result: () => null }, agents, null, null, null, mem)
  const engine = createEngine({ cfg, store, rules, notifier, clock, startedAt: T0 - DAY })
  return {
    store, mem, engine, sent,
    setConfig(a) {
      cfg = cfgOf(a)
      agents.hosts = cfg.hosts.filter(h => h.agent)
    },
    report(id, t1, listening, posture) {
      states[id] = live(slow(t1, listening, posture), t1)
      mem.observe(agents, t1)
    },
    sigs: (now, rule = 'port_new') => rules.evaluate({}, now).filter(x => x.rule === rule),
    run(t1, t2) { for (let x = t1; x <= t2; x += 15_000) engine.evaluate({}, x) },
    firing: key => engine.active().some(a => a.key === key && a.state === 'firing'),
    outbox: () => store.db.prepare("SELECT kind, key, deliver FROM outbox WHERE key LIKE 'port_new:%' ORDER BY id").all().map(r => `${r.kind}:${r.deliver}:${r.key}`),
    incidents: key => store.db.prepare('SELECT started_at, resolved_at FROM incidents WHERE key = ? ORDER BY id').all(key),
  }
}

// seeding at T0 on both hosts, then 8081 appears everywhere at T0 + 1 h
function newPortEverywhere(b) {
  b.report('devbox', T0, L(22))
  b.report('d3', T0, L(22))
  b.report('devbox', T0 + H, L(22, 8081))
  b.report('d3', T0 + H, L(22, 8081))
}

test('alerts.ports false → no port_new signal for the host; port memory keeps going, "Known" still possible', t => {
  const b = bench(t, { ports: false })
  newPortEverywhere(b)
  const now = T0 + H
  assert.deepEqual(b.sigs(now).filter(s => s.hostId === 'devbox'), [], 'no signal for devbox')
  assert.deepEqual(b.sigs(now).filter(s => s.hostId === 'd3').map(s => [s.key, s.cond]).sort(), [['port_new:d3:tcp/22', false], ['port_new:d3:tcp/8081', true]])
  b.run(now, now + 5 * MIN)
  assert.equal(b.firing('port_new:devbox:tcp/8081'), false)
  assert.ok(b.firing('port_new:d3:tcp/8081'))
  assert.deepEqual(b.outbox(), ['open:digest:port_new:d3:tcp/8081'])
  // memory: the devbox port is recorded, as new (host drawer, Network record)
  assert.equal(b.mem.portRow('devbox', 'tcp', 8081).known_at, null)
  assert.equal(b.mem.portsView('devbox', slow(now, L(22, 8081)).listening).find(p => p.port === 8081).status, 'new')
  // "Known" (admin) then closed: memory follows, still no signal
  b.mem.portKnown('devbox', 'tcp', 8081, 'port de dev', 'admin')
  assert.ok(b.mem.portRow('devbox', 'tcp', 8081).known_at != null)
  // an ephemeral port (9000, never "Known") comes and goes: neither raised nor closed
  b.report('devbox', now + 30 * MIN, L(22, 8081, 9000))
  assert.deepEqual(b.sigs(now + 30 * MIN).filter(s => s.hostId === 'devbox'), [])
  b.report('devbox', now + H, L(22))
  assert.ok(b.mem.portRow('devbox', 'tcp', 8081).closed_at != null)
  assert.ok(b.mem.portRow('devbox', 'tcp', 9000).closed_at != null)
  assert.equal(b.mem.unknownPorts('devbox').length, 1, '9000 stays new in memory')
  assert.deepEqual(b.sigs(now + H).filter(s => s.hostId === 'devbox'), [])
})

test('without the option (or set to true, or alerts without ports), nothing changes', t => {
  for (const a of [undefined, { ports: true }, { mute: false }]) {
    const b = bench(t, a)
    newPortEverywhere(b)
    const sig = b.sigs(T0 + H).filter(s => s.hostId === 'devbox').map(s => [s.key, s.cond]).sort()
    assert.deepEqual(sig, [['port_new:devbox:tcp/22', false], ['port_new:devbox:tcp/8081', true]], JSON.stringify(a))
    b.run(T0 + H, T0 + H + MIN)
    assert.ok(b.firing('port_new:devbox:tcp/8081'), JSON.stringify(a))
  }
})

test('the option does not affect posture_regression', t => {
  const b = bench(t, { ports: false })
  b.report('devbox', T0, L(22), STD)
  assert.deepEqual(b.sigs(T0, 'posture_regression').map(s => [s.key, s.cond]), [['posture_regression:devbox', false], ['posture_regression:d3', null]])
  b.report('devbox', T0 + H, L(22), ROOT)
  const s = b.sigs(T0 + H, 'posture_regression').find(x => x.hostId === 'devbox')
  assert.equal(s.cond, true)
  assert.match(s.detail, /root/)
})

test('option set on a host with port_new already raised → silently forgotten after 10 min, no notification', t => {
  const b = bench(t)
  newPortEverywhere(b)
  const t1 = T0 + H
  b.run(t1, t1 + MIN)
  assert.ok(b.firing('port_new:devbox:tcp/8081'))
  const outboxBefore = b.outbox()
  assert.deepEqual(outboxBefore, ['open:digest:port_new:devbox:tcp/8081', 'open:digest:port_new:d3:tcp/8081'])
  const sentBefore = b.sent.length
  // config deployment: alerts.ports false on devbox
  b.setConfig({ ports: false })
  const t2 = t1 + 2 * MIN
  b.run(t2, t2 + 9 * MIN)
  assert.ok(b.firing('port_new:devbox:tcp/8081'), 'still there before FORGET_AFTER')
  b.run(t2 + 9 * MIN + 15_000, t2 + 15 * MIN)
  assert.equal(b.firing('port_new:devbox:tcp/8081'), false, 'forgotten')
  assert.equal(b.engine.get('port_new:devbox:tcp/8081'), null)
  assert.ok(b.firing('port_new:d3:tcp/8081'), 'the other host keeps its own')
  assert.deepEqual(b.outbox(), outboxBefore, 'no resolution queued (neither Telegram nor digest)')
  assert.equal(b.sent.length, sentBefore, 'no Telegram message')
  // the incident is closed (history) when forgotten
  assert.ok(b.incidents('port_new:devbox:tcp/8081')[0].resolved_at != null)
})

test('the schema rejects an invalid alerts.ports value, and ports on a service', () => {
  for (const bad of [{ ports: 'no' }, { ports: 0 }, { ports: null }, { port: false }]) {
    const r = parseConfig(raw(bad))
    assert.ok(!r.config && r.errors?.length, `refused: ${JSON.stringify(bad)}`)
    assert.match(r.errors.join('\n'), /alerts/)
  }
  const svc = raw(undefined)
  svc.services = [{ id: 's', name: 'S', group: 'g', host: 'devbox', url: 'http://x', alerts: { ports: false } }]
  assert.ok(!parseConfig(svc).config, 'ports reserved for hosts')
  assert.ok(parseConfig(raw({ ports: false, mute: true, severity: 'info' })).config)
})
