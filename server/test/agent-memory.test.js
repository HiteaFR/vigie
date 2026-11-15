// v8 agent memory (agentmemory.js) and the posture_regression and port_new
// rules. Real SQLite database, closed then reopened; fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { createAgentMemory, REOPEN_DAYS, postureOf, exposedPorts } from '../lib/agentmemory.js'
import { tmpStore } from './tmpdir.js'

const H = 3600_000
const DAY = 24 * H
const T0 = Date.parse('2026-11-03T08:00:00Z')
const RAW = {
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'p1', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, ip: '192.0.2.158', env: 'prod', agent: 'ssh' },
    { id: 'd1', name: 'docker-lab', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.231', env: 'dev', agent: 'ssh' },
    { id: 'g1', name: 'gitea', kind: 'lxc', pve: 'prod', vmid: 106, ip: '192.0.2.143', env: 'prod', agent: 'ssh' },
  ],
}
const CFG = parseConfig(RAW).config
const IDS = CFG.hosts.filter(h => h.agent).map(h => h.id)
const STD = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: false }, firewall: { type: 'nftables', active: true } }
const OPEN = { ssh: { permitRootLogin: 'yes', passwordAuth: true }, firewall: { type: 'none', active: false } }
const L = (...ports) => ports.map(p => (typeof p === 'number' ? { proto: 'tcp', addr: '0.0.0.0', port: p, process: `p${p}` } : p))
const slow = (t, posture, listening, version = 8) => cleanSlow({ version, ts: Math.floor(t / 1000), posture, listening })
const live = (s, t) => ({ ok: true, at: t, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow: s, slowAt: t })

// bench: real database in a temporary folder; reopen() closes and reopens it (restart)
function bench(t) {
  const s0 = tmpStore('dash-l12-mem-', t)
  const dir = s0.tmpDir
  let store = s0
  const states = {}
  const agents = { hosts: CFG.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } }
  const b = {
    states, agents, store,
    mem: createAgentMemory({ db: store.db, kv: store.kv, hostIds: IDS }),
    report(id, t1, posture, listening, version = 8) { states[id] = live(slow(t1, posture, listening, version), t1) },
    observe(now) { b.mem.observe(agents, now) },
    sigs(now) {
      const all = createRules(CFG, { checks: [], result: () => null }, agents, null, null, null, b.mem).evaluate({}, now)
      return k => all.find(x => x.key === k)
    },
    up(now) { return createRules(CFG, { checks: [], result: () => null }, agents, null, null, null, b.mem).evaluate({}, now).filter(x => x.cond === true) },
    reopen() {
      store.db.close()
      store = openDb(dir)
      b.store = store
      b.mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: IDS })
    },
  }
  t.after(() => { try { store.db.close() } catch { /* already closed */ } })
  return b
}

test('posture criteria and exposed ports (pure)', () => {
  assert.deepEqual(postureOf(STD), { ssh_root: true, ssh_password: true, firewall: true })
  assert.deepEqual(postureOf(OPEN), { ssh_root: false, ssh_password: false, firewall: false })
  assert.deepEqual(postureOf({ ssh: null, firewall: null }), { ssh_root: null, ssh_password: null, firewall: null })
  assert.deepEqual(postureOf({ ssh: { permitRootLogin: 'forced-commands-only', passwordAuth: null }, firewall: { type: 'ufw', active: false } }), { ssh_root: true, ssh_password: null, firewall: false })
  const e = exposedPorts([
    { proto: 'tcp', addr: '127.0.0.1', port: 5432, process: 'postgres' },
    { proto: 'tcp', addr: '::1', port: 5432, process: 'postgres' },
    { proto: 'tcp', addr: '[::1]', port: 6379, process: 'redis' },
    { proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'sshd' },
    { proto: 'tcp', addr: '[::]', port: 22, process: 'sshd' },
    { proto: 'udp', addr: '127.0.0.53', port: 53, process: 'resolved' },
    { proto: 'udp', addr: '192.0.2.158', port: 53, process: 'pihole-FTL' },
  ])
  assert.deepEqual([...e.keys()], ['tcp/22', 'udp/53'])
  assert.deepEqual(e.get('tcp/22').addrs, ['0.0.0.0', '[::]'])
  assert.deepEqual(e.get('udp/53').processes, ['resolved', 'pihole-FTL'])
  assert.equal(REOPEN_DAYS, 7)
})

test('whole fleet moved to v8 with existing gaps and ports: nothing fires (bootstrap)', t => {
  const b = bench(t)
  b.report('p1', T0, OPEN, L(22, 80, 443, 53))
  b.report('d1', T0, { ssh: { permitRootLogin: 'yes', passwordAuth: false }, firewall: { type: 'iptables', active: false } }, L(22, 2375, 8080))
  b.report('g1', T0, STD, L(22, 3000))
  b.observe(T0)
  const by = b.sigs(T0 + 1000)
  for (const id of IDS) assert.equal(by(`posture_regression:${id}`).cond, false, id)
  assert.deepEqual(b.up(T0 + 1000).filter(x => /posture_regression|port_new/.test(x.rule)), [])
  // memory: gaps have no "seen compliant"; ports are known through bootstrap
  assert.equal(b.mem.postureRow('p1', 'ssh_password'), null)
  assert.equal(b.mem.postureRow('g1', 'firewall').first_ok, T0)
  assert.equal(b.mem.portRow('d1', 'tcp', 2375).known_by, 'bootstrap')
  // and still nothing after closing and reopening the database
  b.reopen()
  assert.deepEqual(b.up(T0 + 2000).filter(x => /posture_regression|port_new/.test(x.rule)), [])
})

test('posture regression: seen compliant then gap → warning (prod and dev alike), plain detail; survives restart; compliant again → resolved', t => {
  const b = bench(t)
  b.report('p1', T0, STD, L(22))
  b.report('d1', T0, STD, L(22))
  b.observe(T0)
  const t1 = T0 + 2 * DAY
  b.report('p1', t1, { ssh: { permitRootLogin: 'yes', passwordAuth: true }, firewall: { type: 'nftables', active: true } }, L(22))
  b.report('d1', t1, { ssh: STD.ssh, firewall: { type: 'nftables', active: false } }, L(22))
  b.observe(t1)
  let by = b.sigs(t1 + 1000)
  const p = by('posture_regression:p1')
  assert.deepEqual([p.cond, p.severity, p.detail], [true, 'warning', 'connexion root autorisée (PermitRootLogin yes) (conforme jusqu\'au 03/11) · mot de passe SSH accepté (conforme jusqu\'au 03/11)'])
  assert.deepEqual(p.parents, ['agent_unreachable:p1', 'guest_stopped:p1', 'pve_unreachable:prod'])
  assert.deepEqual([by('posture_regression:d1').cond, by('posture_regression:d1').severity, by('posture_regression:d1').detail], [true, 'warning', 'pare-feu nftables inactif (conforme jusqu\'au 03/11)'])
  b.reopen()
  by = b.sigs(t1 + 2000)
  assert.equal(by('posture_regression:p1').cond, true, 'memory in the database: the regression is still seen after a restart')
  // compliant again: resolved
  b.report('p1', t1 + H, STD, L(22))
  b.observe(t1 + H)
  assert.equal(b.sigs(t1 + H + 1000)('posture_regression:p1').cond, false)
})

test('accepted gap: neutral and no alert; compliant again → acceptance dropped; new regression → alerts again (database closed and reopened between steps)', t => {
  const b = bench(t)
  b.report('p1', T0, STD, L(22))
  b.observe(T0)
  const t1 = T0 + DAY
  const gap = { ...STD, ssh: { permitRootLogin: 'prohibit-password', passwordAuth: true } }
  b.report('p1', t1, gap, L(22))
  b.observe(t1)
  assert.equal(b.sigs(t1)('posture_regression:p1').cond, true)
  const r = b.mem.accept('p1', 'ssh_password', 'clé perdue, accès temporaire', 'admin', gap, t1 + 10)
  assert.deepEqual(r.accepted, { at: t1 + 10, by: 'admin', reason: 'clé perdue, accès temporaire' })
  b.reopen()
  assert.equal(b.sigs(t1 + 20)('posture_regression:p1').cond, false, 'accepted: resolved, and kept in the database')
  const view = b.mem.postureView('p1', gap)
  assert.deepEqual([view.ssh_password.state, view.ssh_password.accepted.reason, view.ssh_root.state], ['accepted', 'clé perdue, accès temporaire', 'ok'])
  // compliant again: the acceptance is dropped
  const t2 = t1 + DAY
  b.report('p1', t2, STD, L(22))
  b.observe(t2)
  b.reopen()
  assert.equal(b.mem.postureRow('p1', 'ssh_password').accepted_at, null)
  assert.equal(b.mem.postureView('p1', STD).ssh_password.state, 'ok')
  // new regression: alerts again
  const t3 = t2 + DAY
  b.report('p1', t3, gap, L(22))
  b.reopen() // the cache is reloaded before the observation
  b.observe(t3)
  assert.equal(b.sigs(t3 + 10)('posture_regression:p1').cond, true)
})

test('removing the acceptance: the gap seen compliant alerts again; refusals (compliant, unknown, reason, host, criterion, no acceptance)', t => {
  const b = bench(t)
  b.report('p1', T0, STD, L(22))
  b.observe(T0)
  b.report('p1', T0 + H, OPEN, L(22))
  b.observe(T0 + H)
  b.mem.accept('p1', 'firewall', 'pare-feu de Proxmox', 'admin', OPEN)
  assert.match(b.sigs(T0 + H + 1000)('posture_regression:p1').detail, /^connexion root.*mot de passe SSH accepté \(conforme jusqu'au 03\/11\)$/)
  b.mem.unaccept('p1', 'firewall', 'finalement non', 'admin')
  assert.match(b.sigs(T0 + H + 1000)('posture_regression:p1').detail, /aucun pare-feu \(conforme jusqu'au 03\/11\)$/)
  const err = (fn, status, re) => assert.throws(fn, e => e.status === status && re.test(e.message))
  err(() => b.mem.accept('p1', 'firewall', 'ok', 'a', OPEN), 400, /motif/)
  err(() => b.mem.accept('p1', 'ssh_root', 'motif long', 'a', STD), 409, /conforme/)
  err(() => b.mem.accept('p1', 'ssh_root', 'motif long', 'a', { ssh: null, firewall: null }), 409, /inconnu/)
  err(() => b.mem.accept('x', 'ssh_root', 'motif long', 'a', OPEN), 404, /hôte/)
  err(() => b.mem.accept('p1', 'root', 'motif long', 'a', OPEN), 400, /critère/)
  err(() => b.mem.unaccept('p1', 'ssh_root', 'motif long', 'a'), 409, /aucune acceptation/)
  err(() => b.mem.unaccept('p1', 'firewall', '', 'a'), 400, /motif/)
})

test('LXC without an internal firewall: gap badge, never an alert (never seen compliant); acceptable with a reason; active then stopped → alerts again', t => {
  const b = bench(t)
  const noFw = { ...STD, firewall: { type: 'none', active: false } }
  b.report('p1', T0, noFw, L(22))
  b.observe(T0)
  for (const dt of [H, DAY, 30 * DAY]) {
    b.report('p1', T0 + dt, noFw, L(22))
    b.observe(T0 + dt)
    assert.equal(b.sigs(T0 + dt)('posture_regression:p1').cond, false)
  }
  assert.equal(b.mem.postureView('p1', noFw).firewall.state, 'gap')
  b.mem.accept('p1', 'firewall', 'couvert par le pare-feu de Proxmox', 'admin', noFw)
  assert.equal(b.mem.postureView('p1', noFw).firewall.state, 'accepted')
  // firewall enabled then stopped: regression (enabling it dropped the acceptance)
  b.report('p1', T0 + 31 * DAY, STD, L(22))
  b.observe(T0 + 31 * DAY)
  b.report('p1', T0 + 32 * DAY, noFw, L(22))
  b.observe(T0 + 32 * DAY)
  assert.equal(b.sigs(T0 + 32 * DAY)('posture_regression:p1').cond, true)
})

test('unknown values (null): no memory, no alert; v7, agent down or no memory: no information', t => {
  const b = bench(t)
  b.report('p1', T0, { ssh: null, firewall: null }, L(22))
  b.observe(T0)
  b.report('p1', T0 + H, { ssh: null, firewall: null }, L(22))
  b.observe(T0 + H)
  assert.equal(b.mem.postureRow('p1', 'ssh_root'), null)
  assert.equal(b.sigs(T0 + H)('posture_regression:p1').cond, false)
  b.report('d1', T0, OPEN, L(22, 9999), 7)
  b.observe(T0)
  const by = b.sigs(T0)
  assert.equal(by('posture_regression:d1').cond, null)
  assert.ok(!b.up(T0).some(x => x.key.startsWith('port_new:d1')))
  assert.equal(b.mem.bootstrapped('d1'), false, 'v7: no bootstrap')
  b.states.p1 = { ...b.states.p1, ok: false, at: T0 - 10 * 60_000 }
  assert.equal(b.sigs(T0 + 2 * H)('posture_regression:p1').cond, null)
  const noMem = createRules(CFG, { checks: [], result: () => null }, b.agents, null).evaluate({}, T0)
  assert.equal(noMem.find(x => x.key === 'posture_regression:g1')?.cond ?? null, null)
})

test('exposed ports: new → info; "Known" → resolved; closed then reopened within 7 days → silent; later → new; local never; purge', t => {
  const b = bench(t)
  b.report('p1', T0, STD, L(22, 80))
  b.observe(T0)
  // new port, and a local-only port
  const t1 = T0 + H
  b.report('p1', t1, STD, L(22, 80, 8443, { proto: 'tcp', addr: '127.0.0.1', port: 9000, process: 'local' }))
  b.observe(t1)
  let by = b.sigs(t1)
  const n = by('port_new:p1:tcp/8443')
  assert.deepEqual([n.cond, n.severity, n.detail], [true, 'info', 'nouveau port en écoute (p8443) sur 0.0.0.0'])
  assert.deepEqual(n.parents, ['agent_unreachable:p1', 'guest_stopped:p1', 'pve_unreachable:prod'])
  assert.equal(by('port_new:p1:tcp/22').cond, false)
  assert.equal(by('port_new:p1:tcp/9000'), undefined)
  // view: statuses
  assert.deepEqual(b.mem.portsView('p1', b.states.p1.slow.listening).map(p => [p.port, p.status]), [[22, 'known'], [80, 'known'], [8443, 'new'], [9000, 'local']])
  // "Known": resolved, survives restart
  b.mem.portKnown('p1', 'tcp', 8443, 'nouveau proxy', 'admin', t1 + 10)
  b.reopen()
  assert.equal(b.sigs(t1 + 20)('port_new:p1:tcp/8443').cond, false)
  // closed, then reopened 6 days later: silent and still known
  b.report('p1', t1 + H, STD, L(22, 80))
  b.observe(t1 + H)
  assert.equal(b.mem.portRow('p1', 'tcp', 8443).closed_at, t1 + H)
  b.report('p1', t1 + 6 * DAY, STD, L(22, 80, 8443))
  b.observe(t1 + 6 * DAY)
  assert.equal(b.sigs(t1 + 6 * DAY)('port_new:p1:tcp/8443').cond, false)
  // closed, then reopened 8 days later: new
  b.report('p1', t1 + 7 * DAY, STD, L(22, 80))
  b.observe(t1 + 7 * DAY)
  b.report('p1', t1 + 15 * DAY, STD, L(22, 80, 8443))
  b.observe(t1 + 15 * DAY)
  by = b.sigs(t1 + 15 * DAY)
  assert.equal(by('port_new:p1:tcp/8443').cond, true)
  assert.equal(b.mem.portRow('p1', 'tcp', 8443).known_at, null)
  // purge: a port closed for more than 7 days disappears from the table
  b.report('p1', t1 + 16 * DAY, STD, L(22))
  b.observe(t1 + 16 * DAY)
  assert.ok(b.mem.portRow('p1', 'tcp', 80).closed_at != null)
  b.report('p1', t1 + 24 * DAY, STD, L(22))
  b.observe(t1 + 24 * DAY)
  assert.equal(b.mem.portRow('p1', 'tcp', 80), null)
  assert.equal(b.store.db.prepare("SELECT count(*) AS n FROM host_ports WHERE host = 'p1' AND port = 80").get().n, 0)
  // "Known": refusals
  const err = (fn, status) => assert.throws(fn, e => e.status === status)
  err(() => b.mem.portKnown('p1', 'tcp', 22, 'déjà', 'a'), 409)
  err(() => b.mem.portKnown('p1', 'tcp', 81, 'inconnu', 'a'), 404)
  err(() => b.mem.portKnown('p1', 'sctp', 22, 'protocole', 'a'), 400)
  err(() => b.mem.portKnown('p1', 'tcp', 70000, 'port', 'a'), 400)
  err(() => b.mem.portKnown('p1', 'tcp', 8443, 'x', 'a'), 400)
  err(() => b.mem.portKnown('zz', 'tcp', 22, 'hôte', 'a'), 404)
})

test('host removed from the config: memory purged at creation; unchanged report: nothing moves', t => {
  const b = bench(t)
  b.report('p1', T0, STD, L(22))
  b.report('g1', T0, STD, L(22))
  b.observe(T0)
  const m2 = createAgentMemory({ db: b.store.db, kv: b.store.kv, hostIds: ['p1', 'd1'] })
  assert.equal(m2.postureRow('g1', 'firewall'), null)
  assert.equal(b.store.db.prepare("SELECT count(*) AS n FROM host_posture WHERE host = 'g1'").get().n, 0)
  assert.equal(b.store.db.prepare("SELECT count(*) AS n FROM host_ports WHERE host = 'g1'").get().n, 0)
  assert.equal(m2.bootstrapped('g1'), false)
  // same report (slowAt unchanged), different content: nothing
  b.states.p1 = { ...b.states.p1, slow: slow(T0, STD, L(22, 4444)) }
  b.observe(T0 + H)
  assert.equal(b.mem.portRow('p1', 'tcp', 4444), null)
})

test('engine: posture regression firing, service restart (database reopened) → stays firing, no resolution and no new notification', t => {
  const b = bench(t)
  const sent = []
  const notifier = { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }
  const engineOf = startedAt => createEngine({ cfg: CFG, store: b.store, rules: createRules(CFG, { checks: [], result: () => null }, b.agents, null, null, null, b.mem), notifier, clock: createClock('Europe/Paris'), startedAt })
  b.report('p1', T0, STD, L(22))
  b.observe(T0)
  b.report('p1', T0 + DAY, OPEN, L(22, 8443))
  b.observe(T0 + DAY)
  const e1 = engineOf(T0 - H)
  e1.evaluate({}, T0 + DAY)
  e1.evaluate({}, T0 + DAY + 30_000)
  assert.ok(e1.active().some(a => a.key === 'posture_regression:p1' && a.state === 'firing'))
  const opened = sent.filter(x => x.startsWith('open:'))
  assert.deepEqual(opened.sort(), ['open:port_new:p1:tcp/8443', 'open:posture_regression:p1'])
  b.reopen()
  const e2 = engineOf(T0 + DAY + 60_000)
  for (const dt of [61_000, 120_000, 600_000]) e2.evaluate({}, T0 + DAY + dt)
  assert.ok(e2.active().some(a => a.key === 'posture_regression:p1' && a.state === 'firing'))
  assert.ok(e2.active().some(a => a.key === 'port_new:p1:tcp/8443' && a.state === 'firing'))
  assert.deepEqual(sent.filter(x => x.startsWith('open:') || x.startsWith('resolve:')).sort(), opened, 'neither resolution nor new opening')
})

test('/api/agents (agentsView): posture and ports (and slow.posture, slow.listening) only with an admin session; without a session, nothing, not even a summary; v7: unknown', async t => {
  const { agentsView } = await import('../lib/agentmemory.js')
  const b = bench(t)
  b.report('p1', T0, OPEN, L(22, 8443))
  b.observe(T0)
  const hosts = [
    { id: 'p1', name: 'pihole', agent: 'ssh', slow: b.states.p1.slow },
    { id: 'd1', name: 'docker-lab', agent: 'ssh', slow: slow(T0, OPEN, L(22), 7) },
    { id: 'x', name: 'sans-agent', agent: null },
  ]
  const pub = agentsView(hosts, b.mem, { admin: false })
  assert.deepEqual([pub[0].slow.posture, pub[0].slow.listening], [null, null])
  assert.deepEqual(pub[0].v8, { known: true, restricted: true, posture: null, ports: null })
  assert.doesNotMatch(JSON.stringify(pub), /permitRootLogin|passwordAuth|firewall|ssh_password|8443/, 'no trace of posture or port without a session')
  assert.deepEqual(pub[1].v8, { known: false, restricted: true, posture: null, ports: null })
  assert.equal(pub[2].v8, undefined)
  assert.ok(hosts[0].slow.posture && Array.isArray(hosts[0].slow.listening), 'the view does not modify the agent state')
  const adm = agentsView(hosts, b.mem, { admin: true })
  assert.equal(adm[0].v8.restricted, false)
  assert.equal(adm[0].v8.posture.ssh_password.state, 'gap')
  assert.deepEqual(adm[0].v8.ports.map(p => [p.proto, p.port, p.status]), [['tcp', 22, 'known'], ['tcp', 8443, 'known']])
  assert.deepEqual([adm[0].slow.posture, adm[0].slow.listening.length], [OPEN, 2])
})

test('wiring (static): agent memory created on the service database, passed to the rules, observed every 60 s; admin routes', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /const memory = createAgentMemory\(\{ db: store\.db, kv: store\.kv, hostIds: cfg\.hosts\.filter\(h => h\.agent\)\.map\(h => h\.id\) \}\)/)
  // network goes through the host (core modules); the memory is still passed to the rules
  // plus the notification channel signals
  assert.match(src, /createRules\(cfg, monitor, agents, updates, null, widgets, memory, \{ host, channels: \(\) => notifier\.channelSignals\(\) \}\)/)
  assert.match(src, /^every\(60_000, \(\) => memory\.observe\(agents\)\)$/m)
  for (const r of ['posture/accept', 'posture/unaccept', 'ports/known']) assert.match(src, new RegExp(`app\\.post\\('/api/agents/${r}', admin, `), r)
})

test('first v8 report not yet observed (the observation runs every 60 s): no port_new; raw v7 report carrying posture and ports: never observed', t => {
  const b = bench(t)
  b.report('p1', T0, STD, L(22, 80, 443))
  assert.equal(b.mem.bootstrapped('p1'), false)
  assert.ok(!b.up(T0).some(x => x.rule === 'port_new'), 'before the bootstrap: nothing')
  b.observe(T0)
  assert.ok(!b.up(T0).some(x => x.rule === 'port_new'), 'after the bootstrap: everything is known')
  // uncleaned v7: the memory learns nothing (no posture seen compliant, no bootstrap)
  b.states.d1 = live({ version: 7, ts: Math.floor(T0 / 1000), posture: STD, listening: L(22) }, T0)
  b.observe(T0)
  assert.equal(b.mem.bootstrapped('d1'), false)
  assert.equal(b.mem.postureRow('d1', 'firewall'), null)
})

test('host removed from the config, never bootstrapped (posture only): its posture is purged too', t => {
  const b = bench(t)
  b.report('g1', T0, STD, null) // listening missing: no bootstrap
  b.observe(T0)
  assert.equal(b.mem.bootstrapped('g1'), false)
  assert.ok(b.mem.postureRow('g1', 'firewall'))
  createAgentMemory({ db: b.store.db, kv: b.store.kv, hostIds: ['p1', 'd1'] })
  assert.equal(b.store.db.prepare("SELECT count(*) AS n FROM host_posture WHERE host = 'g1'").get().n, 0)
})

test('Tailscale peerapi (tailscaled, TCP, tailnet addresses only): shown, never exposed', () => {
  const ts = (addr, extra = {}) => ({ proto: 'tcp', addr, port: 40005, process: 'tailscaled', ...extra })
  // tailnet only, IPv4 (100.64.0.0/10 bounds) and IPv6 (fd7a:115c:a1e0::/48, any case, brackets)
  for (const addr of ['100.114.161.86', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::7928:a157', '[FD7A:115C:A1E0:AB12::1]']) {
    assert.deepEqual([...exposedPorts([ts(addr)]).keys()], [], addr)
  }
  // outside the tailnet ranges: exposed
  for (const addr of ['100.63.255.1', '100.128.0.1', '0.0.0.0', '::', 'fd7a:115c:a1e1::1', '192.0.2.5']) {
    assert.deepEqual([...exposedPorts([ts(addr)]).keys()], ['tcp/40005'], addr)
  }
  // UDP (WireGuard 41641) or another process on a tailnet address: exposed
  assert.deepEqual([...exposedPorts([ts('100.114.161.86', { proto: 'udp' })]).keys()], ['udp/40005'])
  assert.deepEqual([...exposedPorts([ts('100.114.161.86', { process: 'nginx' })]).keys()], ['tcp/40005'])
  assert.deepEqual([...exposedPorts([ts('100.114.161.86', { process: null })]).keys()], ['tcp/40005'])
  // same port also on another address: exposed, every address listed
  const both = exposedPorts([ts('100.114.161.86'), ts('0.0.0.0')])
  assert.deepEqual(both.get('tcp/40005').addrs, ['100.114.161.86', '0.0.0.0'])
})

test('IPv4-mapped loopback (::ffff:127.0.0.0/104) = local: shown, never an alert or memory', t => {
  const b = bench(t)
  const mapped = [
    { proto: 'tcp', addr: '::ffff:127.0.0.1', port: 6379, process: 'redis' },
    { proto: 'tcp', addr: '[::ffff:127.1.2.3]', port: 6380, process: 'redis' },
    { proto: 'tcp', addr: '::FFFF:127.0.0.1', port: 6381, process: 'redis' },
  ]
  assert.deepEqual([...exposedPorts(mapped).keys()], [])
  // a mapped IPv4 outside loopback stays exposed
  assert.deepEqual([...exposedPorts([{ proto: 'tcp', addr: '::ffff:192.0.2.5', port: 8080, process: 'x' }]).keys()], ['tcp/8080'])
  // first v8 report: bootstrapped, but no row for these ports
  b.report('p1', T0, STD, [...L(22), ...mapped])
  b.observe(T0)
  assert.equal(b.mem.bootstrapped('p1'), true)
  for (const p of [6379, 6380, 6381]) assert.equal(b.mem.portRow('p1', 'tcp', p), null, String(p))
  // then: a new port on mapped loopback fires nothing
  b.report('p1', T0 + H, STD, [...L(22), ...mapped, { proto: 'tcp', addr: '::ffff:127.0.0.1', port: 9000, process: 'local' }])
  b.observe(T0 + H)
  assert.ok(!b.up(T0 + H).some(x => x.rule === 'port_new'))
  assert.equal(b.mem.portRow('p1', 'tcp', 9000), null)
  assert.deepEqual(b.mem.portsView('p1', b.states.p1.slow.listening).filter(p => p.port >= 6379).map(p => [p.port, p.status]), [[6379, 'local'], [6380, 'local'], [6381, 'local'], [9000, 'local']])
})
