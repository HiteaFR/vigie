// container_down: a DECLARED container (services[].container) missing from the agent
// report or not running. Real createRules and real engine (forSec, parents, notifications), config
// validated by the schema; FAKE agents and probes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { parseConfig } from '../lib/config.js'
import { createSilences } from '../lib/alerts/silences.js'
import { tmpStore } from './tmpdir.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const NOW = Date.parse('2026-11-01T12:00:00Z')
const noMonitor = { checks: [], result: () => null }

function cfgOf({ services, hosts = [], alerts, maintenance } = {}) {
  const p = parseConfig({
    version: 2, title: 't', gitea: { owner: 'x' }, groups: [{ id: 'sites', name: 'Sites' }],
    proxmox: [{ id: 'prod', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD' }, { id: 'dev', label: 'Dev', host: 'http://192.0.2.168:8006', env: 'PVE' }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', env: 'prod' },
      { id: 'pve-b', name: 'pve-b', kind: 'pve-node', pve: 'dev', env: 'dev' },
      { id: 'docker-b', name: 'docker-b', kind: 'vm', pve: 'dev', vmid: 102, parent: 'pve-b', env: 'dev', agent: 'ssh', ip: '192.0.2.144' },
      { id: 'docker-a', name: 'docker-a', kind: 'vm', pve: 'prod', vmid: 100, parent: 'pve', env: 'prod', agent: 'ssh', ip: '192.0.2.156' },
      { id: 'nas', name: 'nas', kind: 'appliance', env: 'prod', ip: '192.0.2.159' },
      ...hosts,
    ],
    services: services ?? [
      { id: 'site-a-staging', name: 'Site A (staging)', group: 'sites', host: 'docker-b', container: 'site-a-php', checks: [{ type: 'http', url: 'https://site-a.example.net' }] },
      { id: 'site-b-staging', name: 'Site B (staging)', group: 'sites', host: 'docker-b', container: 'site-b-php', checks: [{ type: 'http', url: 'https://site-b.example.net' }] },
      // match through the compose service (container monitoring-grafana-1)
      { id: 'grafana', name: 'Grafana', group: 'sites', host: 'docker-a', container: 'grafana', checks: [{ type: 'tcp', target: '192.0.2.156:3000' }] },
      // without a container, or on a host without an agent: no container_down rule
      { id: 'apache', name: 'Apache', group: 'sites', host: 'docker-b', checks: [{ type: 'tcp', target: '192.0.2.144:8081' }] },
      { id: 'plex', name: 'Plex', group: 'sites', host: 'nas', container: 'plex', checks: [{ type: 'tcp', target: '192.0.2.159:32400' }] },
    ],
    ...(alerts ? { alerts } : {}),
    ...(maintenance ? { maintenance } : {}),
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}
const ctr = (name, state = 'running', over = {}) => ({ name, service: name, state, health: null, restarts: 0, recentRestarts: 0, ...over })
const fastOf = containers => ({ fs: [], docker: containers === null ? null : { version: '29.0.0', containers }, reboot: { required: false } })
// fake agents: state per host (default: fresh report with the given containers)
function agentsOf(cfg, byHost) {
  return {
    hosts: cfg.hosts.filter(h => h.agent),
    get: id => byHost[id] ?? { ok: true, at: NOW - 30_000, fast: fastOf([]), slow: null },
  }
}
const fresh = containers => ({ ok: true, at: NOW - 30_000, fast: fastOf(containers), slow: null })
const RUNNING = {
  'docker-b': fresh([ctr('site-b-php'), ctr('site-a-php'), ctr('sites-apache', 'running', { service: 'apache' })]),
  'docker-a': fresh([ctr('monitoring-grafana-1', 'running', { service: 'grafana' })]),
}
const evalWith = (cfg, byHost, monitor = noMonitor) => createRules(cfg, monitor, agentsOf(cfg, byHost)).evaluate({}, NOW)
const sig = (list, key) => list.find(s => s.key === key)
const downs = list => list.filter(s => s.rule === 'container_down')

test('container_down: one signal per declared container on a host with an agent; name or compose service; all running → cond false', () => {
  const cfg = cfgOf()
  const out = evalWith(cfg, RUNNING)
  assert.deepEqual(downs(out).map(s => [s.key, s.cond]).sort(), [
    ['container_down:docker-a/grafana', false],
    ['container_down:docker-b/site-a-php', false],
    ['container_down:docker-b/site-b-php', false],
  ])
  const s = sig(out, 'container_down:docker-b/site-a-php')
  assert.deepEqual([s.entity, s.title, s.hostId, s.env, s.link], ['docker-b/site-a-php', 'Conteneur site-a-php · docker-b', 'docker-b', 'dev', '/infra?h=docker-b'])
  assert.ok(s.forSec >= 120, `forSec ${s.forSec}`)
})

test('container_down: missing → detail says absent from the agent report; stopped → detail gives the state (exited); any state ≠ running fires (created, paused, dead, restarting); prod critical, dev warning', () => {
  const cfg = cfgOf()
  const out = evalWith(cfg, {
    'docker-b': fresh([ctr('site-b-php', 'exited'), ctr('sites-apache')]),
    'docker-a': fresh([]),
  })
  const siteA = sig(out, 'container_down:docker-b/site-a-php')
  assert.deepEqual([siteA.cond, siteA.severity, siteA.detail], [true, 'warning', 'absent du rapport de l\'agent'])
  const ak = sig(out, 'container_down:docker-b/site-b-php')
  assert.deepEqual([ak.cond, ak.severity, ak.detail], [true, 'warning', 'état : exited'])
  const g = sig(out, 'container_down:docker-a/grafana')
  assert.deepEqual([g.cond, g.severity, g.detail], [true, 'critical', 'absent du rapport de l\'agent'])
  for (const state of ['created', 'paused', 'dead', 'restarting', 'removing']) {
    const x = sig(evalWith(cfg, { ...RUNNING, 'docker-b': fresh([ctr('site-a-php', state), ctr('site-b-php')]) }), 'container_down:docker-b/site-a-php')
    assert.deepEqual([x.cond, x.detail], [true, `état : ${state}`], state)
  }
  // similar name, but neither the name nor the service: missing
  const near = sig(evalWith(cfg, { ...RUNNING, 'docker-a': fresh([ctr('monitoring-grafana-1', 'running', { service: 'grafana-old' })]) }), 'container_down:docker-a/grafana')
  assert.equal(near.cond, true)
  // host severity override, and muted service → muted alert
  const cfg2 = cfgOf({
    hosts: [{ id: 'lab', name: 'lab', kind: 'vm', pve: 'prod', vmid: 130, parent: 'pve', env: 'prod', agent: 'ssh', ip: '192.0.2.30', alerts: { severity: 'warning' } }],
    services: [
      { id: 'a', name: 'A', group: 'sites', host: 'lab', container: 'a', checks: [{ type: 'tcp', target: '192.0.2.30:1' }] },
      { id: 'b', name: 'B', group: 'sites', host: 'lab', container: 'b', alerts: { mute: true }, checks: [{ type: 'tcp', target: '192.0.2.30:2' }] },
    ],
  })
  const o2 = evalWith(cfg2, { lab: fresh([]) })
  assert.deepEqual([sig(o2, 'container_down:lab/a').severity, sig(o2, 'container_down:lab/a').muted], ['warning', false])
  assert.equal(sig(o2, 'container_down:lab/b').muted, true)
})

test('container_down without data → cond null (never an invented alert): agent unreachable, never read, report older than 5 min, no docker block, unknown state', () => {
  const cfg = cfgOf()
  const cases = {
    unreachable: { ok: false, error: 'ssh: timeout', at: NOW - 30_000, fast: fastOf([]) },
    'never read': { ok: null },
    'report 5 min 1 s old': { ok: true, at: NOW - 5 * 60_000 - 1000, fast: fastOf([]), slow: null },
    'without fast': { ok: true, at: NOW - 30_000, fast: null, slow: null },
    'without docker': fresh(null),
    'unknown state': fresh([ctr('site-a-php', null), ctr('site-b-php', null)]),
  }
  for (const [name, st] of Object.entries(cases)) {
    const out = evalWith(cfg, { ...RUNNING, 'docker-b': st })
    const s = sig(out, 'container_down:docker-b/site-a-php')
    assert.ok(s, name)
    assert.deepEqual([s.cond, s.detail], [null, null], name)
  }
  // report of 4 min 59 s: still fresh, the absence counts
  const ok = sig(evalWith(cfg, { ...RUNNING, 'docker-b': { ...fresh([]), at: NOW - 5 * 60_000 + 1000 } }), 'container_down:docker-b/site-a-php')
  assert.equal(ok.cond, true)
  // empty list (docker without containers): this is not "no data"
  assert.equal(sig(evalWith(cfg, { ...RUNNING, 'docker-b': fresh([]) }), 'container_down:docker-b/site-b-php').cond, true)
})

test('parents: container_down ← agent_unreachable + host parents (+ container_restarting of the seen container); service_down of a service with a container ← container_down', () => {
  const cfg = cfgOf()
  const out = evalWith(cfg, { ...RUNNING, 'docker-b': fresh([ctr('site-b-php', 'restarting')]) })
  assert.deepEqual(sig(out, 'container_down:docker-b/site-a-php').parents, ['agent_unreachable:docker-b', 'guest_stopped:docker-b', 'pve_unreachable:dev'])
  assert.deepEqual(sig(out, 'container_down:docker-b/site-b-php').parents, ['agent_unreachable:docker-b', 'guest_stopped:docker-b', 'pve_unreachable:dev', 'container_restarting:docker-b/site-b-php'])
  assert.deepEqual(sig(out, 'container_down:docker-a/grafana').parents.at(-1), 'container_restarting:docker-a/monitoring-grafana-1')
  const monitor = { checks: cfg.services.map(s => ({ id: `${s.id}#0`, serviceId: s.id, type: s.checks[0].type })), result: () => ({ state: 'crit', fails: 5, oks: 0, code: 500 }) }
  const out2 = evalWith(cfg, RUNNING, monitor)
  assert.deepEqual(sig(out2, 'service_down:site-a-staging').parents, ['container_down:docker-b/site-a-php', 'guest_stopped:docker-b', 'pve_unreachable:dev'])
  assert.deepEqual(sig(out2, 'service_down:grafana').parents, ['container_down:docker-a/grafana', 'guest_stopped:docker-a', 'pve_unreachable:prod'])
  assert.deepEqual(sig(out2, 'service_down:apache').parents, ['guest_stopped:docker-b', 'pve_unreachable:dev'])
  // host without an agent: no container_down signal, so no parent
  assert.deepEqual(sig(out2, 'service_down:plex').parents, [])
  assert.equal(downs(out2).some(s => s.hostId === 'nas'), false)
})

// real engine: notifications sent (key and type)
function run(cfg, { agentAt, monitorAt, from = NOW, to = NOW + 10 * 60_000, step = 15_000, store = tmpStore('dash-l15-'), silences = null }) {
  const sent = []
  let t = from
  // report received 30 s before each pass (fresh throughout the simulation)
  // (lastAt: date of the last successful report, kept by a failed read)
  const agents = { hosts: cfg.hosts.filter(h => h.agent), get: id => { const st = agentAt(id, t); return { ...st, at: st.lastAt ?? t - 30_000 } } }
  const checks = cfg.services.map(s => ({ id: `${s.id}#0`, serviceId: s.id, type: s.checks[0].type }))
  const monitor = { checks, result: id => monitorAt(id, t) }
  const rules = createRules(cfg, monitor, agents)
  const engine = createEngine({ cfg, store, rules, silences, notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: NOW - 3600_000 })
  for (; t <= to; t += step) engine.evaluate({}, t)
  return { sent, engine }
}
const okCheck = { state: 'ok', fails: 0, oks: 5, code: 200 }
const failCheck = { state: 'crit', fails: 5, oks: 0, code: 500 }

test('real engine: container gone and site at 500 in the SAME pass → a single notification (container_down); service_down masked', () => {
  const cfg = cfgOf({ alerts: { startupGraceSec: 0 } })
  const T = NOW + 60_000
  const { sent, engine } = run(cfg, {
    agentAt: (id, t) => (id === 'docker-b' && t >= T ? fresh([ctr('site-b-php'), ctr('sites-apache', 'running', { service: 'apache' })]) : RUNNING[id]),
    monitorAt: (id, t) => (id === 'site-a-staging#0' && t >= T ? failCheck : okCheck),
  })
  assert.deepEqual(sent.filter(x => x.startsWith('open')), ['open:container_down:docker-b/site-a-php'])
  const svc = engine.get('service_down:site-a-staging')
  assert.equal(svc.state, 'firing')
  assert.match(svc.suppressed, /dépendance : Conteneur site-a-php/)
})

test('real engine: recreation under 2 min (compose up) → nothing; stop over 2 min → notified once; restart loop → only container_restarting', () => {
  const cfg = cfgOf({ alerts: { startupGraceSec: 0 } })
  let r = run(cfg, { agentAt: id => RUNNING[id], monitorAt: () => okCheck })
  assert.deepEqual(r.sent, [])
  const gone = (from, to) => ({
    agentAt: (id, t) => (id === 'docker-b' && t >= from && t < to ? fresh([ctr('site-b-php'), ctr('site-a-php', 'exited')]) : RUNNING[id]),
    monitorAt: () => okCheck,
  })
  // stopped 90 s, then back
  r = run(cfg, gone(NOW + 60_000, NOW + 150_000))
  assert.deepEqual(r.sent, [], 'recreated within 90 s: no notification')
  r = run(cfg, gone(NOW + 60_000, Infinity))
  assert.deepEqual(r.sent.filter(x => x.startsWith('open')), ['open:container_down:docker-b/site-a-php'])
  assert.equal(r.engine.get('container_down:docker-b/site-a-php').detail, 'état : exited')
  // restart loop: container_restarting is sent right away, container_down is masked
  r = run(cfg, {
    agentAt: id => (id === 'docker-b' ? fresh([ctr('site-b-php'), ctr('site-a-php', 'restarting', { restarts: 12 })]) : RUNNING[id]),
    monitorAt: () => okCheck,
  })
  assert.deepEqual(r.sent.filter(x => x.startsWith('open')), ['open:container_restarting:docker-b/site-a-php'])
  assert.match(r.engine.get('container_down:docker-b/site-a-php').suppressed, /dépendance/)
})

test('labels and simulation: server and client RULE_LABEL, container_down listed by alerts-preview', async () => {
  const { RULE_LABEL: server } = await import('../lib/alerts/rules.js')
  const { RULE_LABEL: client } = await import('../../client/src/lib/alerts.js')
  assert.equal(server.container_down, 'Conteneur absent ou arrêté')
  assert.equal(client.container_down, server.container_down)
  const { L15_RULES } = await import('../scripts/alerts-preview.mjs')
  assert.deepEqual(L15_RULES, ['container_down'])
})

// grafana stopped (container monitoring-grafana-1 exited) and probe failing from NOW + 1 min
const grafanaStops = {
  agentAt: (id, t) => (id === 'docker-a' && t >= NOW + 60_000 ? fresh([ctr('monitoring-grafana-1', 'exited', { service: 'grafana' })]) : RUNNING[id]),
  monitorAt: (id, t) => (id === 'grafana#0' && t >= NOW + 60_000 ? failCheck : okCheck),
}
const opens = r => r.sent.filter(x => x.startsWith('open'))

test('silence set on a service (real createSilences, real engine): also covers the container_down of its container; a silence on another service does not', () => {
  const cfg = cfgOf({ alerts: { startupGraceSec: 0 } })
  assert.deepEqual(opens(run(cfg, grafanaStops)), ['open:container_down:docker-a/grafana'], 'control without a silence')
  const silenced = service => {
    const store = tmpStore('dash-l15-silence-')
    const silences = createSilences({ store, now: () => NOW })
    silences.create({ matcher: { service }, reason: 'mute grafana 1h', by: 'admin (test)', source: 'bot', endsAt: NOW + 3600_000 })
    return run(cfg, { ...grafanaStops, store, silences })
  }
  const r = silenced('grafana')
  assert.deepEqual(opens(r), [])
  assert.match(r.engine.get('container_down:docker-a/grafana').suppressed, /^silence : mute grafana 1h/)
  assert.equal(r.engine.get('container_down:docker-a/grafana').state, 'firing')
  // service_down: masked (dependency or silence), never notified
  assert.ok(r.engine.get('service_down:grafana').suppressed)
  assert.deepEqual(opens(silenced('site-a-staging')), ['open:container_down:docker-a/grafana'])
  // the service target keeps its earlier matches (exact entity, probe #n)
  const s = createSilences({ store: tmpStore('dash-l15-silence-'), now: () => NOW })
  s.create({ matcher: { service: 'grafana' }, reason: 'contrôle', by: 'x', source: 'ui', endsAt: NOW + 3600_000 })
  assert.ok(s.match({ key: 'service_down:grafana', entity: 'grafana' }, NOW))
  assert.ok(s.match({ key: 'cert_expiry:grafana#1', entity: 'grafana#1' }, NOW))
  assert.equal(s.match({ key: 'container_down:docker-a/x', entity: 'docker-a/x', services: ['autre'] }, NOW), null)
  assert.equal(s.match({ key: 'container_down:docker-a/x', entity: 'docker-a/x' }, NOW), null)
})

test('maintenance on a service (config): also covers the container_down of its container; on another service it does not', () => {
  const window = service => [{ start: '00:00', end: '23:59', match: { service }, reason: 'migration' }]
  const r = run(cfgOf({ alerts: { startupGraceSec: 0 }, maintenance: window('grafana') }), grafanaStops)
  assert.deepEqual(opens(r), [])
  assert.equal(r.engine.get('container_down:docker-a/grafana').suppressed, 'maintenance (migration)')
  assert.deepEqual(opens(run(cfgOf({ alerts: { startupGraceSec: 0 }, maintenance: window('site-a-staging') }), grafanaStops)), ['open:container_down:docker-a/grafana'])
  // signal: the list of services that declare the container
  const cfg2 = cfgOf({ services: [
    { id: 'a', name: 'A', group: 'sites', host: 'docker-b', container: 'php', checks: [{ type: 'tcp', target: '192.0.2.144:1' }] },
    { id: 'b', name: 'B', group: 'sites', host: 'docker-b', container: 'php', checks: [{ type: 'tcp', target: '192.0.2.144:2' }] },
  ] })
  assert.deepEqual(sig(evalWith(cfg2, { 'docker-b': fresh([]) }), 'container_down:docker-b/php').services, ['a', 'b'])
})

test('container_down parent of service_down only with a docker report under 5 min old (even after a failed read): agent lost for over 5 min, old report or no docker block → no parent', () => {
  const cfg = cfgOf()
  const monitor = { checks: cfg.services.map(s => ({ id: `${s.id}#0`, serviceId: s.id, type: s.checks[0].type })), result: () => failCheck }
  const parentsWith = st => sig(evalWith(cfg, { ...RUNNING, 'docker-a': st }, monitor), 'service_down:grafana').parents
  const without = ['guest_stopped:docker-a', 'pve_unreachable:prod']
  assert.deepEqual(parentsWith(RUNNING['docker-a']), ['container_down:docker-a/grafana', ...without])
  assert.deepEqual(parentsWith({ ...RUNNING['docker-a'], at: NOW - 5 * 60_000 + 1000 })[0], 'container_down:docker-a/grafana')
  assert.deepEqual(parentsWith(fresh([])), ['container_down:docker-a/grafana', ...without], 'empty list: still data')
  // failed read, kept report under 5 min old → the parent stays
  assert.deepEqual(parentsWith({ ok: false, error: 'ssh: timeout', at: NOW - 4 * 60_000, fast: RUNNING['docker-a'].fast })[0], 'container_down:docker-a/grafana')
  for (const [name, st] of Object.entries({
    'unreachable for 5 min 1 s': { ok: false, error: 'ssh: timeout', at: NOW - 5 * 60_000 - 1000, fast: RUNNING['docker-a'].fast },
    'unreachable without a kept report': { ok: false, error: 'ssh: timeout', at: NOW - 30_000, fast: null },
    'never read': { ok: null },
    'report 5 min 1 s old': { ...RUNNING['docker-a'], at: NOW - 5 * 60_000 - 1000 },
    'without fast': { ok: true, at: NOW - 30_000, fast: null },
    'without docker': fresh(null),
  })) assert.deepEqual(parentsWith(st), without, name)
})

// grafana exited from NOW, probe failing from NOW; agent reads failing at the given instants
// (fast report and last success date kept, like agents.js)
const EXITED = fresh([ctr('monitoring-grafana-1', 'exited', { service: 'grafana' })])
function grafanaWithFailures(failing) {
  let lastOk = null
  return {
    agentAt: (id, t) => {
      if (id !== 'docker-a') return RUNNING[id]
      if (failing(t)) return { ok: false, error: 'ssh: timeout', errorKind: 'other', fast: EXITED.fast, lastAt: lastOk }
      lastOk = t - 30_000
      return EXITED
    },
    monitorAt: id => (id === 'grafana#0' ? failCheck : okCheck),
  }
}

test('real engine: agent lost 45 s after the stop → service_down critical is sent at the latest around T + 300 s (end of the kept report), never an endless wait; container_down never notified', () => {
  const cfg = cfgOf({ alerts: { startupGraceSec: 0 } })
  const r = run(cfg, { ...grafanaWithFailures(t => t >= NOW + 45_000), to: NOW + 40 * 60_000 })
  const svc = r.engine.get('service_down:grafana')
  assert.deepEqual([svc.state, svc.suppressed, svc.severity], ['firing', null, 'critical'])
  assert.ok(svc.firedAt > NOW + 120_000 && svc.firedAt <= NOW + 315_000, `service_down fired at T + ${(svc.firedAt - NOW) / 1000} s`)
  assert.equal(r.engine.get('container_down:docker-a/grafana').state, 'pending')
  assert.deepEqual(opens(r).sort(), ['open:agent_unreachable:docker-a', 'open:service_down:grafana'])
})

test('real engine: container_down notified at 120 s, then a failed ssh read at T + 10 min → no other notification (service_down stays masked)', () => {
  const cfg = cfgOf({ alerts: { startupGraceSec: 0 } })
  const r = run(cfg, { ...grafanaWithFailures(t => t === NOW + 10 * 60_000), to: NOW + 20 * 60_000 })
  assert.deepEqual(opens(r), ['open:container_down:docker-a/grafana'])
  assert.match(r.engine.get('service_down:grafana').suppressed, /dépendance : Conteneur grafana/)
})

test('real engine: a failed ssh read WHILE waiting for container_down → a single notification (container_down), service_down masked', () => {
  const cfg = cfgOf({ alerts: { startupGraceSec: 0 } })
  const r = run(cfg, { ...grafanaWithFailures(t => t === NOW + 60_000), to: NOW + 20 * 60_000 })
  assert.deepEqual(opens(r), ['open:container_down:docker-a/grafana'])
  assert.match(r.engine.get('service_down:grafana').suppressed, /dépendance : Conteneur grafana/)
})
