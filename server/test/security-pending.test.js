// Dating of pending security fixes under auto updates (in the database) and rules
// autoupdate_off, autoupdate_failed and security_updates (auto update mode). Dummy data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { createSecurityPending, isSecurityPending, autoActive } from '../lib/updates/pending.js'
import { tmpStore } from './tmpdir.js'
import { fmtDuration } from '../lib/clock.js'

const AU = { installed: true, enabled: true, securityOnly: true, lastRunAt: 1_800_000_000, lastResult: 'success', applied: [{ name: 'openssl', version: '3.0.17-1~deb12u3' }] }
const H = 3600_000
const NOW = Date.parse('2026-11-05T06:00:00Z')
const pkg = (name, version = '1.0-1+deb12u1', suite = 'bookworm-security', held = false) => ({ name, suite, version, from: '1.0-1', held })
// cleaned v7 slow report (cleanSlow), timestamped at t
const slowV7 = (t, packages = [], au = {}) => cleanSlow({
  version: 7, ts: Math.floor(t / 1000),
  apt: { listsAt: Math.floor(t / 1000), upgradable: packages.length, security: packages.filter(isSecurityPending).length, packages },
  autoUpdate: { ...AU, lastRunAt: Math.floor((t - 2 * H) / 1000), applied: [], ...au },
})

const RAW = {
  version: 2, title: 'test',
  hosts: [
    { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod' },
    { id: 'p1', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, ip: '192.0.2.158', parent: 'pve', env: 'prod', agent: 'ssh' },
    { id: 'd1', name: 'docker', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.231', parent: 'pve', env: 'dev', agent: 'ssh' },
  ],
  proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve.pem' }],
  groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
}
const CFG = parseConfig(RAW).config
// dummy agents: state per host { ok, at, fast, slow, slowAt }
const agentsOf = states => ({ hosts: CFG.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } })
const live = (slow, t = NOW) => ({ ok: true, at: t, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow, slowAt: t })
const sigsOf = (states, updates, now = NOW) => {
  const s = createRules(CFG, { checks: [], result: () => null }, agentsOf(states), updates).evaluate({}, now)
  return k => s.find(x => x.key === k)
}

test('config: autoUpdateMaxAgeHours and securityPendingHours, 48 h by default, strictly positive', () => {
  assert.equal(CFG.alerts.autoUpdateMaxAgeHours, 48)
  assert.equal(CFG.alerts.securityPendingHours, 48)
  assert.equal(parseConfig({ ...RAW, alerts: { autoUpdateMaxAgeHours: 72, securityPendingHours: 24 } }).config.alerts.securityPendingHours, 24)
  for (const bad of [0, -1, '48']) {
    assert.ok(parseConfig({ ...RAW, alerts: { autoUpdateMaxAgeHours: bad } }).errors, String(bad))
    assert.ok(parseConfig({ ...RAW, alerts: { securityPendingHours: bad } }).errors, String(bad))
  }
})

test('dating: 1st observation under auto updates, version changing without losing first_seen, applied → removed, held and non -security excluded', t => {
  const store = tmpStore('dash-l9-', t)
  const P = createSecurityPending({ db: store.db, hostIds: ['p1', 'd1'] })
  const t0 = NOW - 60 * H
  P.observe(agentsOf({ p1: live(slowV7(t0, [pkg('openssl'), pkg('libssl3'), pkg('nginx', '2', 'bookworm-security', true), pkg('firefox', '144.0', 'mozilla')]), t0) }), t0)
  assert.deepEqual(P.get('p1').map(p => [p.name, p.since]), [['libssl3', t0], ['openssl', t0]])
  // same report (slowAt unchanged): nothing moves, even if the content differed
  const same = live(slowV7(t0, []), t0)
  P.observe(agentsOf({ p1: same }), t0 + H)
  assert.equal(P.get('p1').length, 2)
  // new report: openssl changes candidate version (first_seen kept), libssl3 applied
  // (removed), curl appears (first_seen = timestamp of THIS report)
  const t1 = NOW - 30 * H
  P.observe(agentsOf({ p1: live(slowV7(t1, [pkg('openssl', '3.0.18-1~deb12u1'), pkg('curl')]), t1) }), t1)
  assert.deepEqual(P.get('p1').map(p => [p.name, p.version, p.since]), [['openssl', '3.0.18-1~deb12u1', t0], ['curl', '1.0-1+deb12u1', t1]])
  // report timestamp in the future: capped at now
  const t2 = NOW - 20 * H
  P.observe(agentsOf({ d1: live(slowV7(t2 + 5 * H, [pkg('bash')]), t2) }), t2)
  assert.equal(P.get('d1')[0].since, t2)
  // in the database: what the cache sees
  const rows = store.db.prepare('SELECT host, name, version, first_seen FROM apt_security_pending ORDER BY host, name').all()
  assert.deepEqual(rows.map(r => [r.host, r.name, r.first_seen]), [['d1', 'bash', t2], ['p1', 'curl', t1], ['p1', 'openssl', t0]])
})

test('dating: auto updates not active (disabled, not security only, v6, null) → host rows purged; report without apt or missing → nothing moves', t => {
  const store = tmpStore('dash-l9-', t)
  const P = createSecurityPending({ db: store.db, hostIds: ['p1', 'd1'] })
  let t0 = NOW - 60 * H
  const seed = () => { t0 += 1000; P.observe(agentsOf({ p1: live(slowV7(t0, [pkg('openssl')]), t0) }), t0) }
  const off = [
    slowV7(NOW, [pkg('openssl')], { enabled: false }),
    slowV7(NOW, [pkg('openssl')], { securityOnly: false }),
    slowV7(NOW, [pkg('openssl')], { installed: false }),
    cleanSlow({ version: 6, ts: NOW / 1000, apt: { packages: [pkg('openssl')] } }),
    cleanSlow({ version: 7, ts: NOW / 1000, autoUpdate: null, apt: { packages: [pkg('openssl')] } }),
  ]
  for (const [i, slow] of off.entries()) {
    seed()
    assert.equal(P.get('p1').length, 1)
    P.observe(agentsOf({ p1: { ...live(slow), slowAt: NOW + i } }), NOW)
    assert.deepEqual(P.get('p1'), [], `case ${i}`)
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM apt_security_pending WHERE host = 'p1'").get().n, 0)
  }
  seed()
  const since = P.get('p1')[0].since
  // active but without apt, agent without slow report, host unknown to the agents: nothing moves
  P.observe(agentsOf({ p1: { ...live({ ...slowV7(NOW), apt: null }), slowAt: NOW + 100 } }), NOW)
  P.observe(agentsOf({ p1: { ok: false, slow: null, slowAt: null } }), NOW)
  assert.deepEqual(P.get('p1').map(p => p.since), [since])
})

test('dating: service restart → ages kept (database); host removed from the config → purged', t => {
  const store = tmpStore('dash-l9-', t)
  const t0 = NOW - 50 * H
  const A1 = createSecurityPending({ db: store.db, hostIds: ['p1', 'd1'] })
  A1.observe(agentsOf({ p1: live(slowV7(t0, [pkg('openssl')]), t0), d1: live(slowV7(t0, [pkg('bash')]), t0) }), t0)
  // "restart": new instance on the same database, BEFORE any observation
  const A2 = createSecurityPending({ db: store.db, hostIds: ['p1'] })
  assert.deepEqual(A2.get('p1'), [{ name: 'openssl', version: '1.0-1+deb12u1', since: t0 }])
  assert.deepEqual(A2.get('d1'), [])
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM apt_security_pending WHERE host = 'd1'").get().n, 0)
  // the rule sees the same "blocked" before and after the restart
  const upd = P => ({ signals: () => [], isIgnored: () => false, securityPending: h => P.get(h) })
  const before = sigsOf({ p1: live(slowV7(NOW, [pkg('openssl')])) }, upd(A1))('security_updates:p1')
  const after = sigsOf({ p1: live(slowV7(NOW, [pkg('openssl')])) }, upd(A2))('security_updates:p1')
  assert.deepEqual([before.cond, after.cond, after.detail], [true, true, `bloqué depuis ${fmtDuration(50 * H)} : openssl`])
})

test('rules: v6 → no new alert, security_updates unchanged (info as soon as a fix is pending)', () => {
  const v6 = cleanSlow({ version: 6, ts: NOW / 1000, apt: { listsAt: NOW / 1000, upgradable: 3, security: 2, packages: [pkg('openssl'), pkg('curl')] }, autoUpdate: AU })
  const by = sigsOf({ p1: live(v6) }, { signals: () => [], isIgnored: () => false, securityPending: () => { throw new Error('jamais lu en v6') } })
  assert.equal(by('autoupdate_off:p1').cond, null)
  assert.equal(by('autoupdate_failed:p1').cond, null)
  assert.deepEqual([by('security_updates:p1').cond, by('security_updates:p1').severity, by('security_updates:p1').detail], [true, 'info', '2 de sécurité sur 3 en attente'])
  // v7 without block (apt missing on the host): same
  const by7 = sigsOf({ p1: live(cleanSlow({ version: 7, ts: NOW / 1000, autoUpdate: null })) }, null)
  assert.equal(by7('autoupdate_off:p1').cond, null)
  assert.equal(by7('autoupdate_failed:p1').cond, null)
})

test('rules: autoupdate_off (which one), warning in prod as in dev; parents agent then host', () => {
  const cases = [[{ installed: false }, 'unattended-upgrades absent'], [{ enabled: false }, 'MAJ automatiques désactivées'], [{ securityOnly: false }, 'MAJ automatiques pas limitées à la sécurité']]
  for (const [au, detail] of cases) {
    for (const id of ['p1', 'd1']) {
      const s = sigsOf({ [id]: live(slowV7(NOW, [], au)) }, null)(`autoupdate_off:${id}`)
      assert.deepEqual([s.cond, s.detail, s.severity, s.rule], [true, detail, 'warning', 'autoupdate_off'], `${id} ${detail}`)
      assert.deepEqual(s.parents, [`agent_unreachable:${id}`, `guest_stopped:${id}`, 'pve_unreachable:prod'])
    }
  }
  const ok = sigsOf({ p1: live(slowV7(NOW)) }, null)('autoupdate_off:p1')
  assert.deepEqual([ok.cond, ok.detail], [false, null])
})

test('rules: autoupdate_failed (failure, too old, never run with delay); no double alert when auto updates are turned off', () => {
  const at = h => Math.floor((NOW - h * H) / 1000)
  const f = (au, upd = null) => sigsOf({ p1: live(slowV7(NOW, [], au)) }, upd)('autoupdate_failed:p1')
  // auto updates seen active since (agent memory)
  const fSince = (au, since) => createRules(CFG, { checks: [], result: () => null }, agentsOf({ p1: live(slowV7(NOW, [], au)) }), null, null, null, { autoActiveSince: () => since }).evaluate({}, NOW).find(x => x.key === 'autoupdate_failed:p1')
  assert.deepEqual([f({ lastResult: 'failed' }).cond, f({ lastResult: 'failed' }).detail], [true, 'dernier passage en échec'])
  assert.deepEqual([f({ lastRunAt: at(49) }).cond, f({ lastRunAt: at(49) }).detail], [true, `dernier passage il y a ${fmtDuration(49 * H)}`])
  assert.equal(f({ lastRunAt: at(47) }).cond, false)
  // never run: no information (nothing pending) without a first-seen date, or seen
  // for less than 48 h; beyond that: raised without waiting
  const never = { lastRunAt: null, lastResult: null }
  assert.deepEqual([f(never).cond, f(never).forSec, f(never).detail], [null, undefined, null])
  assert.deepEqual([fSince(never, NOW - 47.9 * H).cond, fSince(never, NOW - 47.9 * H).detail], [null, null])
  assert.deepEqual([fSince(never, NOW - 48 * H).cond, fSince(never, NOW - 48 * H).forSec, fSince(never, NOW - 48 * H).detail], [true, undefined, 'aucun passage enregistré'])
  assert.equal(f({ lastRunAt: at(47) }).forSec, undefined)
  assert.equal(f({}).severity, 'warning')
  // turned off: autoupdate_off only, autoupdate_failed false (even when failed)
  assert.equal(f({ enabled: false, lastResult: 'failed' }).cond, false)
  // configurable threshold
  const cfg = parseConfig({ ...RAW, alerts: { autoUpdateMaxAgeHours: 24 } }).config
  const s = createRules(cfg, { checks: [], result: () => null }, { hosts: cfg.hosts.filter(h => h.agent), get: () => live(slowV7(NOW, [], { lastRunAt: at(30) })) }, null).evaluate({}, NOW)
  assert.equal(s.find(x => x.key === 'autoupdate_failed:p1').cond, true)
})

test('rules: security_updates under auto updates = fix blocked for more than 48 h; postpone and ignore take precedence; non -security never blocked', () => {
  const pend = list => ({ signals: () => [], isIgnored: () => false, securityPending: () => list })
  const slow = slowV7(NOW, [pkg('openssl'), pkg('curl'), pkg('firefox', '144.0', 'mozilla')])
  // pending for less than 48 h: nothing
  let s = sigsOf({ p1: live(slow) }, pend([{ name: 'curl', version: '1', since: NOW - 47 * H }]))('security_updates:p1')
  assert.deepEqual([s.cond, s.severity], [false, 'warning'])
  // blocked: warning, the oldest first, 5 names at most
  const many = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((name, i) => ({ name, version: '1', since: NOW - (70 - i) * H }))
  s = sigsOf({ p1: live(slow), d1: live(slow) }, pend([...many, { name: 'curl', version: '1', since: NOW - H }]))('security_updates:p1')
  assert.deepEqual([s.cond, s.severity, s.detail], [true, 'warning', `bloqué depuis ${fmtDuration(70 * H)} : a1, a2, a3, a4, a5 (+2)`])
  assert.equal(sigsOf({ d1: live(slow) }, pend(many))('security_updates:d1').severity, 'warning') // dev: same severity
  // postpone or ignore from the Updates page: takes precedence
  assert.equal(sigsOf({ p1: live(slow) }, { signals: () => [], isIgnored: id => id === 'apt:p1', securityPending: () => many })('security_updates:p1').cond, false)
  // dating unavailable (simulation without the updates module): no information
  assert.equal(sigsOf({ p1: live(slow) }, null)('security_updates:p1').cond, null)
  // configurable threshold
  const cfg = parseConfig({ ...RAW, alerts: { securityPendingHours: 12 } }).config
  const c = createRules(cfg, { checks: [], result: () => null }, { hosts: cfg.hosts.filter(h => h.agent), get: () => live(slow) }, pend([{ name: 'curl', version: '1', since: NOW - 13 * H }])).evaluate({}, NOW)
  assert.equal(c.find(x => x.key === 'security_updates:p1').cond, true)
})

test('end to end: firefox from the Mozilla repository pending → never counted nor blocked', t => {
  const store = tmpStore('dash-l9-', t)
  const P = createSecurityPending({ db: store.db, hostIds: ['p1'] })
  const ff = [pkg('firefox', '144.0~build1', 'mozilla')]
  const t0 = NOW - 100 * H
  P.observe(agentsOf({ p1: live(slowV7(t0, ff), t0) }), t0)
  assert.deepEqual(P.get('p1'), [])
  assert.equal(isSecurityPending(ff[0]), false)
  const s = sigsOf({ p1: live(slowV7(NOW, ff)) }, { signals: () => [], isIgnored: () => false, securityPending: h => P.get(h) })('security_updates:p1')
  assert.equal(s.cond, false)
})

test('end to end: auto updates active → disabled: purge, autoupdate_off raised, security_updates back to v6 behaviour (same key, info), without "blocked"', t => {
  const store = tmpStore('dash-l9-', t)
  const P = createSecurityPending({ db: store.db, hostIds: ['p1'] })
  const upd = { signals: () => [], isIgnored: () => false, securityPending: h => P.get(h) }
  const t0 = NOW - 60 * H
  P.observe(agentsOf({ p1: live(slowV7(t0, [pkg('openssl')]), t0) }), t0)
  let by = sigsOf({ p1: live(slowV7(NOW, [pkg('openssl')])) }, upd)
  assert.deepEqual([by('security_updates:p1').cond, by('security_updates:p1').severity, by('autoupdate_off:p1').cond], [true, 'warning', false])
  // disabled: new report
  const offSlow = slowV7(NOW, [pkg('openssl')], { enabled: false })
  P.observe(agentsOf({ p1: { ...live(offSlow), slowAt: NOW + 1 } }), NOW)
  assert.deepEqual(P.get('p1'), [])
  by = sigsOf({ p1: live(offSlow) }, upd)
  assert.deepEqual([by('autoupdate_off:p1').cond, by('autoupdate_failed:p1').cond], [true, false])
  const su = by('security_updates:p1')
  assert.deepEqual([su.cond, su.severity, su.detail], [true, 'info', '1 de sécurité sur 1 en attente'])
  const all = createRules(CFG, { checks: [], result: () => null }, agentsOf({ p1: live(offSlow) }), upd).evaluate({}, NOW)
  assert.equal(all.filter(x => x.key === 'security_updates:p1').length, 1, 'a single security_updates key per host')
  assert.ok(!all.some(x => /bloqué/.test(x.detail ?? '')))
})

test('rules: agent unreachable → no auto update signal (no cascade), autoActive requires v7', () => {
  const down = { ok: false, at: NOW - 10 * 60_000, error: 'timeout', fast: null, slow: slowV7(NOW, [pkg('openssl')], { enabled: false, lastResult: 'failed' }), slowAt: NOW }
  const by = sigsOf({ p1: down }, { signals: () => [], isIgnored: () => false, securityPending: () => [{ name: 'openssl', version: '1', since: NOW - 99 * H }] })
  assert.equal(by('agent_unreachable:p1').cond, true)
  for (const k of ['autoupdate_off:p1', 'autoupdate_failed:p1']) assert.equal(by(k).cond, null, k)
  assert.equal(by('security_updates:p1'), undefined)
  assert.equal(autoActive({ version: 6, autoUpdate: AU }), false)
  assert.equal(autoActive(null), false)
  assert.equal(autoActive({ version: 7, autoUpdate: AU }), true)
})

test('engine: security_updates "blocked" raised, then service restart (same database) → stays raised, neither resolution nor renotification', async t => {
  const { createEngine } = await import('../lib/alerts/engine.js')
  const { createClock } = await import('../lib/clock.js')
  const store = tmpStore('dash-l9-engine-', t)
  const sent = []
  const notifier = { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }
  const t0 = NOW - 60 * H
  const boot = startedAt => {
    const P = createSecurityPending({ db: store.db, hostIds: ['p1', 'd1'] })
    const states = { p1: live(slowV7(NOW, [pkg('openssl')])) }
    const rules = createRules(CFG, { checks: [], result: () => null }, agentsOf(states), { signals: () => [], isIgnored: () => false, securityPending: h => P.get(h) })
    return { P, engine: createEngine({ cfg: CFG, store, rules, notifier, clock: createClock('Europe/Paris'), startedAt }) }
  }
  const a = boot(NOW - 3 * H)
  a.P.observe(agentsOf({ p1: live(slowV7(t0, [pkg('openssl')]), t0) }), t0)
  a.engine.evaluate({}, NOW)
  a.engine.evaluate({}, NOW + 30_000)
  const st = () => a.engine.active().find(x => x.key === 'security_updates:p1')
  assert.equal(st()?.state, 'firing')
  assert.deepEqual(sent.filter(x => x.endsWith('security_updates:p1')), ['open:security_updates:p1'])
  // restart: new instances on the same database, right after startup (grace period)
  const b = boot(NOW + 60_000)
  for (const dt of [61_000, 120_000, 600_000]) b.engine.evaluate({}, NOW + dt)
  const again = b.engine.active().find(x => x.key === 'security_updates:p1')
  assert.equal(again?.state, 'firing')
  assert.deepEqual(sent.filter(x => x.endsWith('security_updates:p1')), ['open:security_updates:p1'], 'neither resolution nor new opening')
})

test('dating: first_seen = timestamp of the REPORT (not the observation time), capped at now', t => {
  const store = tmpStore('dash-l9-', t)
  const P = createSecurityPending({ db: store.db, hostIds: ['p1'] })
  const reportAt = NOW - 3 * H
  // report from 3 h ago, observed only now (refresh every 10 min, service restarted…)
  P.observe(agentsOf({ p1: { ...live(slowV7(reportAt, [pkg('openssl')]), reportAt), slowAt: NOW } }), NOW)
  assert.equal(P.get('p1')[0].since, reportAt)
})

test('rules: UNCLEANED v6 report carrying an autoUpdate block → ignored by the rules too (second barrier)', () => {
  const raw = { version: 6, ts: NOW / 1000, apt: { listsAt: NOW / 1000, upgradable: 1, security: 1, packages: [pkg('openssl')] }, autoUpdate: { ...AU, enabled: false } }
  const by = sigsOf({ p1: live(raw) }, { signals: () => [], isIgnored: () => false, securityPending: () => [{ name: 'openssl', version: '1', since: NOW - 99 * H }] })
  assert.deepEqual([by('autoupdate_off:p1').cond, by('autoupdate_failed:p1').cond], [null, null])
  assert.deepEqual([by('security_updates:p1').severity, by('security_updates:p1').detail], ['info', '1 de sécurité sur 1 en attente'])
})

test('rules: parents of the three rules = the agent, then the host (guest, Proxmox API)', () => {
  const by = sigsOf({ p1: live(slowV7(NOW, [pkg('openssl')], { lastResult: 'failed' })) }, { signals: () => [], isIgnored: () => false, securityPending: () => [{ name: 'openssl', version: '1', since: NOW - 99 * H }] })
  for (const k of ['autoupdate_off:p1', 'autoupdate_failed:p1', 'security_updates:p1']) {
    assert.deepEqual(by(k).parents, ['agent_unreachable:p1', 'guest_stopped:p1', 'pve_unreachable:prod'], k)
  }
  assert.deepEqual([by('autoupdate_failed:p1').cond, by('security_updates:p1').cond], [true, true])
})

test('real case (v7 shape confirmed): v7 + securityOnly false (wave not rolled out yet) → one autoupdate_off warning, nothing else', () => {
  // mariadb, agent-vm, docker-b before the wave: installed and enabled true, securityOnly false
  const slow = slowV7(NOW, [], { securityOnly: false })
  const s = createRules(CFG, { checks: [], result: () => null }, agentsOf({ p1: live(slow), d1: live(slow) }), { signals: () => [], isIgnored: () => false, securityPending: () => [] }).evaluate({}, NOW)
  const up = s.filter(x => x.cond === true)
  assert.deepEqual(up.map(x => [x.key, x.severity, x.detail]), [
    ['autoupdate_off:p1', 'warning', 'MAJ automatiques pas limitées à la sécurité'],
    ['autoupdate_off:d1', 'warning', 'MAJ automatiques pas limitées à la sécurité'],
  ])
})

test('real case: a run that crashes without conclusion leaves no line → no new run for 49 h → autoupdate_failed', () => {
  const by = sigsOf({ p1: live(slowV7(NOW, [], { lastRunAt: Math.floor((NOW - 49 * H) / 1000), lastResult: 'success' })) }, null)
  assert.deepEqual([by('autoupdate_failed:p1').cond, by('autoupdate_failed:p1').forSec ?? 0], [true, 0])
  assert.equal(sigsOf({ p1: live(slowV7(NOW, [], { lastRunAt: Math.floor((NOW - 47 * H) / 1000) })) }, null)('autoupdate_failed:p1').cond, false)
})

test('real case (mailpit): unattended-upgrades just installed (lastRunAt and lastResult null) → neither autoupdate_failed nor "blocked" before 48 h, then failed', async t => {
  const { createEngine } = await import('../lib/alerts/engine.js')
  const { createClock } = await import('../lib/clock.js')
  const { createAgentMemory } = await import('../lib/agentmemory.js')
  const store = tmpStore('dash-l9-mailpit-', t)
  const P = createSecurityPending({ db: store.db, hostIds: ['p1', 'd1'] })
  // first-seen date of auto updates, from the agent memory (like index.js)
  const M = createAgentMemory({ db: store.db, kv: store.kv, hostIds: ['p1', 'd1'] })
  const sent = []
  const T0 = NOW
  let now = T0
  const state = () => live(slowV7(now, [pkg('openssl')], { lastRunAt: null, lastResult: null }), now)
  const states = { p1: state() }
  const engine = createEngine({ cfg: CFG, store, rules: createRules(CFG, { checks: [], result: () => null }, agentsOf(states), { signals: () => [], isIgnored: () => false, securityPending: h => P.get(h) }, null, null, M),
    notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: T0 - 3 * H })
  const step = h => { now = T0 + h * H; states.p1 = state(); P.observe(agentsOf(states), now); M.observe(agentsOf(states), now); engine.evaluate({}, now) }
  for (const h of [0, 1, 12, 24, 36, 47.9]) {
    step(h)
    // nothing shown either (no pending alert)
    assert.equal(engine.active().some(a => a.key === 'autoupdate_failed:p1'), false, `${h} h`)
  }
  assert.deepEqual(sent, [], 'nothing before 48 h')
  step(48.1)
  // never run for 48 h, and openssl pending for 48 h under auto updates: both, once
  assert.deepEqual([...sent].sort(), ['open:autoupdate_failed:p1', 'open:security_updates:p1'])
})
