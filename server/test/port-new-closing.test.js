// Automatic closing of a port_new whose port no longer listens. Real SQLite database
// (temporary folder removed after the test), real engine, real notifier on a fake Telegram;
// fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules, PORT_GONE_MAX, PORT_SLOW_FRESH } from '../lib/alerts/rules.js'
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
const RAW = {
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'dp', name: 'docker-a', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.231', env: 'prod', agent: 'ssh' },
    { id: 'd2', name: 'docker-b', kind: 'vm', pve: 'prod', vmid: 102, ip: '192.0.2.144', env: 'prod', agent: 'ssh' },
  ],
}
const CFG = parseConfig(RAW).config
const IDS = CFG.hosts.filter(h => h.agent).map(h => h.id)
const STD = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: false }, firewall: { type: 'nftables', active: true } }
const L = (...ports) => ports.map(p => (typeof p === 'number' ? { proto: 'tcp', addr: '0.0.0.0', port: p, process: `p${p}` } : p))
const slow = (t, listening, version = 8) => cleanSlow({ version, ts: Math.floor(t / 1000), posture: STD, listening })
const live = (s, t) => ({ ok: true, at: t, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow: s, slowAt: t })

// bench: real memory, rules, engine and notifier; fake Telegram (counts the sends)
function bench(t) {
  const store = tmpStore('dash-l17-ports-', t)
  const states = {}
  const agents = { hosts: CFG.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } }
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: IDS })
  const clock = createClock('Europe/Paris')
  const sent = []
  const telegram = { configured: true, send: async text => { sent.push(text) } }
  const notifier = createNotifier({ cfg: CFG, store, clock, telegram, formatter: createFormatter({ dashboardUrl: null, clock }), log: { log() {}, error() {} } })
  const rules = createRules(CFG, { checks: [], result: () => null }, agents, null, null, null, mem)
  const engine = createEngine({ cfg: CFG, store, rules, notifier, clock, startedAt: T0 - DAY })
  const b = {
    store, states, mem, engine, notifier, sent,
    // fast and slow reports received at t1 (fresh); observed by the memory if observe
    report(id, t1, listening, { version = 8, observe = true } = {}) {
      states[id] = live(slow(t1, listening, version), t1)
      if (observe) mem.observe(agents, t1)
    },
    sigs: now => rules.evaluate({}, now).filter(x => x.rule === 'port_new'),
    sig: (now, key) => rules.evaluate({}, now).find(x => x.key === key),
    // engine evaluations from t1 to t2, every 15 s (like index.js)
    run(t1, t2) { for (let x = t1; x <= t2; x += 15_000) engine.evaluate({}, x) },
    firing: key => engine.active().some(a => a.key === key && a.state === 'firing'),
    outbox: () => store.db.prepare("SELECT kind, key, deliver FROM outbox WHERE key LIKE 'port_new:%' ORDER BY id").all().map(r => `${r.kind}:${r.deliver}:${r.key}`),
    incidents: key => store.db.prepare('SELECT started_at, resolved_at FROM incidents WHERE key = ? ORDER BY id').all(key),
  }
  return b
}

// bootstrap at T0, then 8443 appears at T0 + 1 h: alert fires (info, digest)
function withNewPort(t) {
  const b = bench(t)
  b.report('dp', T0, L(22, 80))
  b.report('dp', T0 + H, L(22, 80, 8443))
  b.run(T0 + H, T0 + H + MIN)
  assert.ok(b.firing('port_new:dp:tcp/8443'))
  return b
}

test('port gone (fresh v8 slow report, bootstrapped host): cond false, the alert resolves, the incident closes', t => {
  const b = withNewPort(t)
  const t2 = T0 + 2 * H
  b.report('dp', t2, L(22, 80))
  assert.ok(b.mem.portRow('dp', 'tcp', 8443).closed_at != null)
  const s = b.sig(t2, 'port_new:dp:tcp/8443')
  assert.deepEqual([s.cond, s.severity, s.title], [false, 'info', 'Port tcp/8443 · docker-a'])
  assert.deepEqual(s.parents, ['agent_unreachable:dp', 'guest_stopped:dp', 'pve_unreachable:prod'])
  b.engine.evaluate({}, t2)
  assert.equal(b.firing('port_new:dp:tcp/8443'), false)
  assert.equal(b.engine.get('port_new:dp:tcp/8443'), null, 'state forgotten after the resolution')
  assert.equal(b.incidents('port_new:dp:tcp/8443')[0].resolved_at, t2)
  // known ports stay false, with nothing more
  assert.deepEqual(b.sigs(t2).map(x => [x.key, x.cond]).sort(), [['port_new:dp:tcp/22', false], ['port_new:dp:tcp/80', false], ['port_new:dp:tcp/8443', false]])
})

test('report received but not yet observed by the memory (observation every 60 s): the missing port resolves anyway', t => {
  const b = withNewPort(t)
  const t2 = T0 + 2 * H
  b.report('dp', t2, L(22, 80), { observe: false })
  assert.equal(b.mem.portRow('dp', 'tcp', 8443).closed_at, null, 'memory not up to date yet')
  assert.equal(b.sig(t2, 'port_new:dp:tcp/8443').cond, false)
  b.engine.evaluate({}, t2)
  assert.equal(b.firing('port_new:dp:tcp/8443'), false)
})

test('without fresh data, nothing moves, even past the 10 min after which the engine forgets an alert without a signal', async t => {
  const cases = {
    'agent injoignable': s => ({ ...s, ok: false, error: 'ssh' }),
    'rapport fast périmé': s => ({ ...s, at: s.at - 6 * MIN }),
    'rapport slow périmé': s => ({ ...s, slow: slow(s.slowAt - PORT_SLOW_FRESH, L(22, 80)), slowAt: s.slowAt - PORT_SLOW_FRESH }),
    'agent revenu en v7': s => ({ ...s, slow: slow(s.slowAt, L(22, 80), 7) }),
    'listening absent': s => ({ ...s, slow: { ...slow(s.slowAt, L(22, 80)), listening: null } }),
  }
  for (const [name, alter] of Object.entries(cases)) {
    await t.test(name, tt => {
      const b = withNewPort(tt)
      const t2 = T0 + 2 * H
      b.report('dp', t2, L(22, 80), { observe: false })
      b.states.dp = alter(b.states.dp)
      const s = b.sig(t2, 'port_new:dp:tcp/8443')
      assert.equal(s?.cond, null, name)
      b.run(t2, t2 + 30 * MIN)
      assert.ok(b.firing('port_new:dp:tcp/8443'), `${name}: still firing after 30 min`)
      assert.equal(b.incidents('port_new:dp:tcp/8443')[0].resolved_at, null, name)
      assert.deepEqual(b.outbox(), ['open:digest:port_new:dp:tcp/8443'], `${name}: no resolution`)
    })
  }
})

test('host not bootstrapped (no v8 report ever observed): no port_new signal', t => {
  const b = bench(t)
  b.report('d2', T0, L(22, 4444), { version: 7 })
  b.report('dp', T0, L(22), { observe: false })
  assert.deepEqual(b.sigs(T0 + MIN), [])
})

test('port closed then back without "Known": alerts again (new open, new incident); "Known": nothing more', t => {
  const b = withNewPort(t)
  const t2 = T0 + 2 * H
  b.report('dp', t2, L(22, 80))
  b.run(t2, t2 + MIN)
  assert.equal(b.firing('port_new:dp:tcp/8443'), false)
  const t3 = T0 + 3 * H
  b.report('dp', t3, L(22, 80, 8443))
  assert.equal(b.mem.portRow('dp', 'tcp', 8443).known_at, null)
  assert.equal(b.sig(t3, 'port_new:dp:tcp/8443').cond, true)
  b.run(t3, t3 + MIN)
  assert.ok(b.firing('port_new:dp:tcp/8443'))
  assert.equal(b.incidents('port_new:dp:tcp/8443').length, 2)
  assert.deepEqual(b.outbox(), ['open:digest:port_new:dp:tcp/8443', 'resolve:digest:port_new:dp:tcp/8443', 'open:digest:port_new:dp:tcp/8443'])
  // "Known", then closed and back: silent
  b.mem.portKnown('dp', 'tcp', 8443, 'service déployé', 'admin', t3 + 2 * MIN)
  b.engine.evaluate({}, t3 + 2 * MIN)
  assert.equal(b.firing('port_new:dp:tcp/8443'), false)
  b.report('dp', t3 + H, L(22, 80))
  b.report('dp', t3 + 2 * H, L(22, 80, 8443))
  assert.deepEqual(b.sigs(t3 + 2 * H).filter(x => x.cond !== false), [])
})

test(`bound: at most ${PORT_GONE_MAX} gone-port signals per host, most recent first; known ports emit none`, t => {
  const b = bench(t)
  b.report('dp', T0, L(22))
  // 80 ephemeral ports, opened then closed one by one (one hour each)
  const ports = Array.from({ length: 80 }, (_, i) => 40000 + i)
  for (const [i, p] of ports.entries()) {
    b.report('dp', T0 + (2 * i + 1) * H, L(22, p))
    b.report('dp', T0 + (2 * i + 2) * H, L(22))
  }
  const now = T0 + 160 * H + MIN
  const gone = b.sigs(now).filter(x => x.key !== 'port_new:dp:tcp/22')
  assert.equal(gone.length, PORT_GONE_MAX)
  assert.ok(gone.every(x => x.cond === false))
  assert.deepEqual(gone.map(x => x.key).slice(0, 2), ['port_new:dp:tcp/40079', 'port_new:dp:tcp/40078'])
  // the memory purges what has been closed for more than 7 days: at most 7 days of history remain
  assert.ok(b.mem.unknownPorts('dp').length <= 7 * 24 / 2 + 1, String(b.mem.unknownPorts('dp').length))
  // a port that just disappeared (memory not yet updated) comes before the closed ones
  b.report('dp', now + H, L(22, 50000))
  b.report('dp', now + 2 * H, L(22), { observe: false })
  assert.equal(b.sigs(now + 2 * H).find(x => x.key !== 'port_new:dp:tcp/22').key, 'port_new:dp:tcp/50000')
})

test('a "Known" port then closed (or a closed bootstrap port) emits no signal', t => {
  const b = bench(t)
  b.report('dp', T0, L(22, 80))
  b.report('dp', T0 + H, L(22, 80, 9443))
  b.mem.portKnown('dp', 'tcp', 9443, 'service déployé', 'admin', T0 + H + MIN)
  b.report('dp', T0 + 2 * H, L(22))
  assert.ok(b.mem.portRow('dp', 'tcp', 9443).closed_at != null)
  assert.ok(b.mem.portRow('dp', 'tcp', 80).closed_at != null)
  const fresh = b.sigs(T0 + 2 * H)
  assert.deepEqual(fresh.map(x => x.key), ['port_new:dp:tcp/22'])
  // nor without fresh data
  b.states.dp = { ...b.states.dp, ok: false, error: 'ssh' }
  assert.deepEqual(b.sigs(T0 + 2 * H), [])
})

test(`more than ${PORT_GONE_MAX} port_new still open and a 30 min data gap → none forgotten, no reopening on return`, t => {
  const b = bench(t)
  b.report('dp', T0, L(22))
  const ports = Array.from({ length: PORT_GONE_MAX + 8 }, (_, i) => 41000 + i)
  b.report('dp', T0 + H, L(22, ...ports))
  b.run(T0 + H, T0 + H + MIN)
  const firing = () => b.engine.active().filter(a => a.state === 'firing' && a.rule === 'port_new').length
  assert.equal(firing(), ports.length)
  // agent unreachable 30 min: everything stays firing (cond null for each open row, no cap)
  const t2 = T0 + H + 2 * MIN
  b.states.dp = { ...b.states.dp, ok: false, error: 'ssh' }
  assert.equal(b.sigs(t2).filter(x => x.cond === null).length, ports.length)
  b.run(t2, t2 + 30 * MIN)
  assert.equal(firing(), ports.length)
  // agent back, same ports: no resolution and no new open
  const t3 = t2 + 31 * MIN
  b.report('dp', t3, L(22, ...ports))
  b.run(t3, t3 + 5 * MIN)
  assert.equal(firing(), ports.length)
  const box = b.outbox()
  assert.equal(box.filter(x => x.startsWith('open:')).length, ports.length)
  assert.equal(box.filter(x => x.startsWith('resolve:')).length, 0)
})

test('no burst: 10 port_new (info) closed at once, during the day → no Telegram message, resolutions in the digest only', async t => {
  const b = bench(t)
  b.report('dp', T0, L(22))
  const ports = Array.from({ length: 10 }, (_, i) => 32000 + i)
  b.report('dp', T0 + H, L(22, ...ports))
  b.run(T0 + H, T0 + H + MIN)
  assert.equal(b.engine.active().filter(a => a.state === 'firing').length, 10)
  b.report('dp', T0 + 2 * H, L(22))
  b.run(T0 + 2 * H, T0 + 2 * H + 20 * MIN)
  assert.equal(b.engine.active().length, 0)
  for (const x of [0, 20_000, 60_000]) await b.notifier.flush(T0 + 2 * H + x)
  assert.deepEqual(b.sent, [], 'no immediate sending')
  const box = b.outbox()
  assert.equal(box.length, 20)
  assert.ok(box.every(r => r.includes(':digest:')), box.join(' '))
})
