// Module and plugin host (lib/plugins/host.js). A fake plugin throws, on demand,
// in each hook (setup, collection, signals, digest, summary), then recovers: the other modules
// and the evaluation keep going, its signals are frozen (no silent resolution beyond
// FORGET_AFTER), plugin_error is raised then resolved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { z } from 'zod'
import { definePlugin, moduleOf, createHost, validatePluginConfig, PLUGIN_API_VERSION, PluginError } from '../lib/plugins/host.js'
import { createCollector } from '../lib/alerts/collect.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { parseConfig } from '../lib/config.js'
import { createRules, CORE_RULES } from '../lib/alerts/rules.js'
import fs from 'node:fs'
import { collectRoutes } from './golden/route-walk.js'
import { tmpStore } from './tmpdir.js'

const MIN = 60_000
const T0 = Date.parse('2026-11-12T09:00:00Z')
const quiet = { log() {}, warn() {}, error() {} }

// fake plugin: each hook throws when boom[hook] is true
function fake(boom, { id = 'faux', setupThrows = false } = {}) {
  return definePlugin({
    id, apiVersion: 0, label: id,
    configSchema: z.object({ seuil: z.number().int() }).strict(),
    secrets: ['FAUX_JETON'],
    setup(ctx) {
      if (setupThrows) throw new Error('setup cassé')
      return {
        collect: { [`${id}-src`]: { periodSec: 30, fn: async () => { if (boom.collect) throw new Error('source muette'); return { n: 1 } } } },
        rules: ['faux_rule'],
        signals: (snap, now) => {
          if (boom.signals) throw new Error('boom\nligne 2')
          return [{ key: `faux_rule:${id}`, rule: 'faux_rule', entity: id, title: `Faux ${id}`, env: 'prod', cond: true, severity: 'warning', detail: `seuil ${ctx.config.seuil}`, link: '/', parents: [] }]
        },
        digest: { slot: 'end', lines: () => { if (boom.digest) throw new Error('digest cassé'); return [`🧪 ${id} : ok`] } },
        summary: { key: id, value: () => { if (boom.summary) throw new Error('résumé cassé'); return { ok: true, secret: ctx.secret('FAUX_JETON'), autre: ctx.secret('PATH') } } },
        routes: router => router.get(`/api/p/${id}/etat`, (req, res) => res.json({ ok: true })),
        labels: { faux_rule: 'Faux' },
      }
    },
  })
}
const other = moduleOf('autre', {
  rules: ['autre'],
  signals: () => [{ key: 'autre:x', rule: 'autre', entity: 'x', title: 'Autre', env: 'prod', cond: false, severity: 'warning', parents: [] }],
  digest: { slot: 'end', lines: () => ['🟢 autre'] },
  summary: { key: 'autre', value: () => 42 },
})
const CFG = { plugins: { faux: { seuil: 3 } } }
const MINIMAL = { version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], alerts: {} }

test('definePlugin: id, apiVersion 0 only, setup and zod schema required; known hooks and slots', () => {
  assert.equal(PLUGIN_API_VERSION, 0)
  assert.throws(() => definePlugin({ id: 'Faux', apiVersion: 0, setup() {} }), /invalid id/)
  assert.throws(() => definePlugin({ id: 'faux', apiVersion: 1, setup() {} }), /apiVersion 1 not supported \(this host: 0\)/)
  assert.throws(() => definePlugin({ id: 'faux', setup() {} }), /apiVersion undefined/)
  assert.throws(() => definePlugin({ id: 'faux', apiVersion: 0 }), /setup\(ctx\) expected/)
  assert.throws(() => definePlugin({ id: 'faux', apiVersion: 0, setup() {}, configSchema: {} }), /zod schema/)
  assert.throws(() => moduleOf('m', { inconnu: () => {} }), /unknown hook "inconnu"/)
  assert.throws(() => moduleOf('m', { digest: { slot: 'milieu', lines: () => [] } }), /unknown digest slot/)
  assert.throws(() => moduleOf('m', { collect: { src: { periodSec: 5, fn: () => {} } } }), /periodSec \(>= 10\)/)
  assert.throws(() => createHost({ modules: [other, other] }), /duplicate id/)
})

test('plugin config: plugins.<id> validated by the plugin schema, unknown block refused; without a block, plugin not configured (nothing called)', () => {
  const boom = {}
  assert.deepEqual(validatePluginConfig(CFG, [fake(boom)]), [])
  assert.deepEqual(validatePluginConfig({ plugins: { faux: { seuil: 'x' } } }, [fake(boom)]), ['plugins.faux.seuil: Invalid input: expected number, received string'])
  assert.deepEqual(validatePluginConfig({ plugins: { ailleurs: {} } }, [fake(boom)]), ['plugins.ailleurs: unknown plugin (known: faux)'])
  // the root schema accepts the plugins block
  const parsed = parseConfig({ ...MINIMAL, plugins: { faux: { seuil: 1 } } })
  assert.deepEqual(parsed.errors, undefined)
  assert.deepEqual(parsed.config.plugins, { faux: { seuil: 1 } })
  let called = false
  const host = createHost({ cfg: {}, log: quiet, plugins: [definePlugin({ id: 'absent', apiVersion: 0, setup() { called = true; return {} } })] })
  assert.equal(called, false)
  assert.deepEqual(host.list(), [{ id: 'absent', label: 'absent', kind: 'plugin', configured: false, errors: {} }])
})

test('signal isolation: a plugin that throws is frozen (cond null), plugin_error is raised then resolved; the other modules keep going', () => {
  const boom = {}
  const host = createHost({ cfg: CFG, log: quiet, modules: [other], plugins: [fake(boom)] })
  const keyed = s => Object.fromEntries(s.map(x => [x.key, x]))
  let s = keyed(host.signals({}, T0))
  assert.equal(s['faux_rule:faux'].cond, true)
  assert.equal(s['faux_rule:faux'].detail, 'seuil 3')
  assert.equal(s['plugin_error:faux'].cond, false)
  assert.equal(s['plugin_error:autre'].cond, false)
  boom.signals = true
  s = keyed(host.signals({}, T0 + MIN))
  assert.equal(s['faux_rule:faux'].cond, null, 'frozen: neither firing nor resolution')
  assert.equal(s['faux_rule:faux'].title, 'Faux faux')
  assert.equal(s['autre:x'].cond, false, 'the other modules evaluate normally')
  assert.deepEqual([s['plugin_error:faux'].cond, s['plugin_error:faux'].title, s['plugin_error:faux'].detail, s['plugin_error:faux'].severity], [true, 'Plugin faux en erreur', 'signals : boom ligne 2', 'warning'])
  assert.equal(s['plugin_error:autre'].cond, false)
  boom.signals = false
  s = keyed(host.signals({}, T0 + 2 * MIN))
  assert.equal(s['faux_rule:faux'].cond, true)
  assert.equal(s['plugin_error:faux'].cond, false, 'resolved when the hook succeeds again')
})

test('digest and summary isolation: "unavailable" line in its place, null key, the others intact, then recovery', () => {
  const boom = { digest: true, summary: true }
  const host = createHost({ cfg: CFG, env: { FAUX_JETON: 'j', PATH: '/bin' }, log: quiet, modules: [other], plugins: [fake(boom)] })
  assert.deepEqual(host.digestLines('end', {}), ['🟢 autre', '⚠️ faux : indisponible'])
  assert.deepEqual(host.digestLines('ci', {}), [])
  assert.deepEqual(host.summaries({}), { autre: 42, faux: null })
  const pe = host.signals({}, T0).find(x => x.key === 'plugin_error:faux')
  assert.equal(pe.cond, true)
  assert.equal(pe.detail, 'digest : digest cassé · summary : résumé cassé')
  boom.digest = false
  boom.summary = false
  assert.deepEqual(host.digestLines('end', {}), ['🟢 autre', '🧪 faux : ok'])
  // declared secret read, undeclared secret refused (null)
  assert.deepEqual(host.summaries({}), { autre: 42, faux: { ok: true, secret: 'j', autre: null } })
  assert.equal(host.signals({}, T0).find(x => x.key === 'plugin_error:faux').cond, false)
})

test('setup that throws: plugin disabled, plugin_error raised, the other plugins and modules start', () => {
  const host = createHost({ cfg: { plugins: { faux: { seuil: 1 }, bis: { seuil: 2 } } }, log: quiet, modules: [other], plugins: [fake({}, { setupThrows: true }), fake({}, { id: 'bis' })] })
  const s = host.signals({}, T0)
  assert.equal(s.find(x => x.key === 'plugin_error:faux').detail, 'setup : setup cassé')
  assert.ok(s.some(x => x.key === 'faux_rule:bis'))
  assert.ok(!s.some(x => x.key === 'faux_rule:faux'))
  assert.deepEqual(host.digestLines('end', {}), ['🟢 autre', '🧪 bis : ok'])
  assert.deepEqual(host.collectors().map(c => c.name), ['bis-src'])
})

test('collection: a plugin source enters the shared collector; an error stays data (snap.error), the other sources keep going', async () => {
  const boom = { collect: true }
  const host = createHost({ cfg: CFG, log: quiet, plugins: [fake(boom)] })
  const timers = []
  const sources = { cluster: async () => [], runners: async () => [], giteaRepos: async () => [], backups: async () => [], nodes: async () => [], disks: async () => [], configured: { gitea: false, runners: false } }
  const c = createCollector(sources, { setTimer: (fn, ms) => timers.push(ms), random: () => 0, now: () => T0, extra: host.collectors() })
  c.start()
  assert.equal(timers.length, 5, 'cluster, backups, nodes, disks and the plugin source (gitea and runners not configured)')
  await c.runAll()
  assert.equal(c.snap['faux-src'].error, 'source muette')
  assert.deepEqual(c.snap.cluster.data, [])
  boom.collect = false
  await c.runAll()
  assert.deepEqual(c.snap['faux-src'].data, { n: 1 })
  assert.equal(c.snap['faux-src'].error, null)
  assert.throws(() => createCollector(sources, { extra: [{ name: 'cluster', periodSec: 30, fn: () => {} }] }), /duplicate source cluster/)
  // plugin not configured: source never read, snapshot { configured: false }
  const off = createCollector(sources, { extra: [{ name: 'off-src', periodSec: 30, fn: () => { throw new Error('lue') }, configured: false }] })
  await off.runAll()
  assert.deepEqual(off.snap['off-src'], { configured: false, data: null, at: null, error: null })
})

test('engine: a plugin down for 20 min (beyond FORGET_AFTER) keeps its alert open, plugin_error goes out then resolves; the evaluation (heartbeat) keeps going', t => {
  const store = tmpStore('vigie-p4a-host-', t)
  const boom = {}
  const host = createHost({ cfg: CFG, log: quiet, plugins: [fake(boom)] })
  const sent = []
  const notifier = { enqueue: (kind, st) => (sent.push(`${kind}:${st.key}`), 'now') }
  const engine = createEngine({ cfg: parseConfig(MINIMAL).config, store, rules: { evaluate: (snap, now) => host.signals(snap, now), impacted: () => ({ services: [], guests: 0 }) }, notifier, clock: createClock('Europe/Paris'), startedAt: T0 - 3600_000 })
  engine.evaluate({}, T0)
  assert.equal(engine.get('faux_rule:faux').state, 'firing')
  boom.signals = true
  for (let m = 1; m <= 20; m++) engine.evaluate({}, T0 + m * MIN)
  assert.equal(engine.lastEvalAt, T0 + 20 * MIN, 'evaluation never interrupted')
  assert.equal(engine.get('faux_rule:faux').state, 'firing', 'never resolved silently')
  assert.equal(engine.get('plugin_error:faux').state, 'firing')
  assert.ok(!sent.includes('resolve:faux_rule:faux'))
  boom.signals = false
  engine.evaluate({}, T0 + 21 * MIN)
  assert.notEqual(engine.get('plugin_error:faux')?.state ?? 'ok', 'firing', 'plugin_error resolved on recovery')
  assert.ok(sent.includes('open:plugin_error:faux') && sent.includes('resolve:plugin_error:faux'), sent.join(' '))
  assert.equal(engine.get('faux_rule:faux').state, 'firing')
})

test('routes and labels: plugin router mounted by the host; label of an existing rule refused; module added after startup refused', () => {
  const host = createHost({ cfg: CFG, log: quiet, plugins: [fake({})] })
  const app = express()
  host.mount(app, {})
  app.all('/api/*', (req, res) => res.status(404).end())
  assert.deepEqual(collectRoutes(app._router), [{ method: 'GET', path: '/api/p/faux/etat' }, { method: 'ALL', path: '/api/*' }])
  assert.deepEqual(host.labels({ service_down: 'Service hors ligne' }), { faux_rule: 'Faux' })
  assert.throws(() => host.labels({ faux_rule: 'Autre libellé' }), PluginError)
  host.start()
  assert.throws(() => host.addModule(other), /added after startup/)
})

// --- isolation holes, replayed on the real host and the real engine --------------------------------

const svcCfg = parseConfig({ ...MINIMAL, groups: [{ id: 'g', name: 'G' }], services: [{ id: 'web', name: 'Web', group: 'g', env: 'prod', checks: [{ type: 'tcp', target: '192.0.2.80:80' }] }] }).config
const failing = { checks: [{ id: 'web#0', serviceId: 'web', type: 'tcp', label: 'TCP 80' }], result: () => ({ state: 'crit', fails: 5, oks: 0, error: 'refusé' }) }
const plug = (id, hooks) => definePlugin({ id, apiVersion: 0, configured: () => true, setup: () => hooks })

test('key ownership: a plugin declares neither a core type nor plugin_error; key outside its types or already emitted refused; no open/resolve flapping (repro)', t => {
  // repro: the plugin emits service_down:web with cond false, the core emits it with true
  const sneaky = plug('sournois', { rules: ['faux'], signals: () => [{ key: 'service_down:web', rule: 'faux', cond: false, title: 'x', env: 'prod', parents: [] }] })
  const claims = plug('pretend', { rules: ['service_down'], signals: () => [] })
  const host = createHost({ cfg: {}, log: quiet, plugins: [sneaky, claims], coreRules: CORE_RULES })
  assert.match(host.list().find(m => m.id === 'pretend').errors.setup.message, /rule type service_down already emitted by the core/)
  const store = tmpStore('vigie-p4a-i1-', t)
  const sent = []
  const engine = createEngine({ cfg: svcCfg, store, rules: createRules(svcCfg, failing, null, null, null, null, null, { host }), notifier: { enqueue: (kind, st) => (sent.push(`${kind}:${st.key}`), 'now') }, clock: createClock('Europe/Paris'), startedAt: T0 - 3600_000 })
  for (let m = 0; m < 6; m++) engine.evaluate({}, T0 + m * MIN)
  assert.equal(engine.get('service_down:web').state, 'firing')
  assert.deepEqual(sent.filter(x => x.endsWith(':service_down:web')), ['open:service_down:web'], 'one opening, no flapping')
  assert.match(engine.get('plugin_error:sournois').detail, /signal refusé : service_down:web \(clé hors du type faux\)/)
  assert.equal(engine.get('plugin_error:pretend').state, 'firing')
  // key outside its type, plugin_error reserved, source_error outside its space (source_error:<id>,
  // <id>/… or one of its sources), key already emitted in the pass
  const out = createHost({ cfg: {}, log: quiet, coreRules: CORE_RULES, plugins: [
    plug('a', { rules: ['a_rule', 'source_error'], collect: { 'a-src': { periodSec: 30, fn: async () => 1 } }, signals: () => [{ key: 'b_rule:1', rule: 'a_rule' }, { key: 'source_error:a', rule: 'source_error' }, { key: 'source_error:a/x', rule: 'source_error' }, { key: 'source_error:a-src', rule: 'source_error' }, { key: 'source_error:commun', rule: 'source_error' }, { key: 'plugin_error:x', rule: 'plugin_error' }] }),
    plug('b', { rules: ['source_error'], signals: () => [{ key: 'source_error:a', rule: 'source_error' }, { key: 'source_error:b', rule: 'source_error' }] }),
    plug('c', { rules: ['plugin_error'], signals: () => [] }),
  ] }).signals({}, T0)
  const keys = out.filter(x => x.rule !== 'plugin_error').map(x => x.key)
  assert.deepEqual(keys, ['source_error:a', 'source_error:a/x', 'source_error:a-src', 'source_error:b'])
  const pe = Object.fromEntries(out.filter(x => x.rule === 'plugin_error').map(x => [x.entity, x.detail]))
  assert.match(pe.a, /b_rule:1 \(clé hors du type a_rule\), source_error:commun \(source_error hors de a et de ses sources\), plugin_error:x \(type plugin_error non déclaré\)/)
  assert.match(pe.b, /source_error:a \(source_error hors de b et de ses sources\)/)
  assert.match(pe.c, /setup : module c: rule type plugin_error reserved for the host/)
  // a core key in the same pass (taken) is refused to a module
  const t2 = createHost({ cfg: {}, log: quiet, plugins: [plug('d', { rules: ['source_error'], signals: () => [{ key: 'source_error:d', rule: 'source_error' }] })] }).signals({}, T0, { taken: new Set(['source_error:d']) })
  assert.ok(!t2.some(x => x.key === 'source_error:d'))
  assert.match(t2.find(x => x.key === 'plugin_error:d').detail, /source_error:d \(clé déjà émise dans ce passage\)/)
})

test('reserved ids: a plugin named like a core source or module is refused at load (plugin_error:refused/<id>) without taking the id; list taken from the code (collector, core modules)', async t => {
  const { RESERVED_PLUGIN_IDS, coreModules } = await import('../lib/plugins/core.js')
  // the list comes from the code: snapshot sources of the core collector, ids of the core modules, proxmox
  const coreSnap = Object.keys(createCollector({}, { setTimer: () => {} }).snap)
  const moduleIds = coreModules({ updates: {}, network: {} }).map(m => m.id)
  assert.deepEqual([...RESERVED_PLUGIN_IDS].sort(), [...new Set([...coreSnap, ...moduleIds, 'proxmox'])].sort())
  for (const id of ['backups', 'cluster', 'nodes', 'disks', 'network', 'updates', 'proxmox']) assert.ok(RESERVED_PLUGIN_IDS.includes(id), id)
  // plugins backups (a source) and network (a module, added AFTER the plugins, as in index.js)
  let called = 0
  const sneaky = id => definePlugin({ id, apiVersion: 0, configured: () => true, setup: () => (called++, { rules: ['source_error'], collect: { [`${id}-x`]: { periodSec: 30, fn: async () => 1 } }, signals: () => [{ key: `source_error:${id}/prod`, rule: 'source_error' }] }) })
  const logs = []
  const host = createHost({ cfg: {}, log: { ...quiet, error: m => logs.push(m) }, coreRules: CORE_RULES, reservedIds: RESERVED_PLUGIN_IDS, plugins: [sneaky('backups'), sneaky('network'), plug('libre', { rules: ['libre'], signals: () => [] })] })
  assert.equal(called, 0, 'setup never called for a reserved id')
  assert.deepEqual(host.ids, ['libre'], 'no id taken')
  assert.deepEqual(host.collectors().map(c => c.name), [], 'no source')
  const net = coreModules({ updates: {}, network: { signals: () => [], digestLines: () => [], summary: () => null } }).find(m => m.id === 'network')
  host.addModule(net)
  assert.deepEqual(host.ids, ['network', 'libre'], 'the core module of the same name loads next')
  const s = host.signals({}, T0)
  assert.ok(!s.some(x => x.key.startsWith('source_error:')), 'no signal of the refused plugin')
  const pe = Object.fromEntries(s.filter(x => x.rule === 'plugin_error').map(x => [x.key, [x.cond, x.title, x.detail]]))
  assert.deepEqual(pe['plugin_error:refused/backups'], [true, 'Plugin backups refusé', 'chargement : id backups réservé au cœur (source ou module du cœur), plugin non chargé'])
  assert.equal(pe['plugin_error:refused/network'][0], true)
  assert.equal(pe['plugin_error:network'][0], false, 'the network module does not inherit the error')
  assert.equal(pe['plugin_error:libre'][0], false)
  assert.deepEqual(host.list().filter(m => m.refused).map(m => [m.id, m.configured, m.errors.load.message]), [['backups', false, 'id backups réservé au cœur (source ou module du cœur), plugin non chargé'], ['network', false, 'id network réservé au cœur (source ou module du cœur), plugin non chargé']])
  assert.equal(logs.filter(m => /load: id (backups|network) réservé/.test(m)).length, 2)
  // the engine: the alert goes out (after the plugin_error delay) and stays raised
  const store = tmpStore('vigie-p4b-ids-', t)
  const engine = createEngine({ cfg: svcCfg, store, rules: createRules(svcCfg, failing, null, null, null, null, null, { host }), notifier: { enqueue: () => 'now' }, clock: createClock('Europe/Paris'), startedAt: T0 - 3600_000 })
  for (let m = 0; m < 12; m++) engine.evaluate({}, T0 + m * MIN)
  assert.equal(engine.get('plugin_error:refused/backups').state, 'firing')
  // without reservedIds (unit test host), nothing is reserved
  assert.deepEqual(createHost({ cfg: {}, log: quiet, plugins: [sneaky('disks')] }).ids, ['disks'])
})

test('transition: ci_failed and runner_offline leave CORE_RULES for the gitea plugin (no double emission); if they came back to the core, the plugin would be refused; CORE_RULES = types emitted by rules.js', async () => {
  const { default: realGitea } = await import('../plugins/gitea/index.js')
  assert.ok(!CORE_RULES.includes('ci_failed') && !CORE_RULES.includes('runner_offline'), 'moved out of the core')
  const env = { GITEA_URL: 'http://gitea.example.net' }
  const cfg = { plugins: { gitea: { owner: 'o' } } }
  const snap = { gitea: { data: [{ name: 'app', defaultBranch: 'main', mainRun: { status: 'failure', number: 3, title: 't' } }], error: null }, runners: { data: [{ name: 'r1', status: 'offline' }], error: null } }
  const host = createHost({ cfg, env, log: quiet, plugins: [realGitea], coreRules: CORE_RULES })
  const keys = host.signals(snap, T0).map(x => x.key)
  assert.deepEqual(keys.filter(k => !k.startsWith('plugin_error:')), ['source_error:gitea', 'source_error:runners', 'ci_failed:app', 'runner_offline:r1'])
  // safeguard: a core that would still emit ci_failed refuses the plugin at load
  const twice = createHost({ cfg, env, log: quiet, plugins: [realGitea], coreRules: [...CORE_RULES, 'ci_failed', 'runner_offline'] })
  assert.ok(!twice.signals(snap, T0).some(x => x.key === 'ci_failed:app'), 'never emitted twice')
  assert.match(twice.list()[0].errors.setup.message, /rule type ci_failed already emitted by the core/)
  // plus channel_error, core type emitted by the notifier (lib/notify/notifier.js)
  const src = fs.readFileSync(new URL('../lib/alerts/rules.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../lib/notify/notifier.js', import.meta.url), 'utf8')
  assert.deepEqual([...CORE_RULES].sort(), [...new Set([...src.matchAll(/rule: '([a-z_]+)'/g)].map(m => m[1]))].sort())
  assert.doesNotMatch(src, /rule: '(ci_failed|runner_offline)'/)
  // two modules never declare the same type (except shared)
  assert.match(createHost({ cfg: {}, log: quiet, plugins: [plug('x', { rules: ['t'], signals: () => [] }), plug('y', { rules: ['t'], signals: () => [] })] }).list()[1].errors.setup.message, /rule type t already declared by x/)
})

test('routes that throw at mount: plugin disabled, plugin_error, router never mounted; mounting the others continues', () => {
  const host = createHost({ cfg: {}, log: quiet, plugins: [
    plug('casse', { rules: ['casse_r'], signals: () => [{ key: 'casse_r:1', rule: 'casse_r', cond: true }], routes: r => { r.get('/api/p/casse/a', (q, s) => s.end()); throw new Error('montage cassé') } }),
    plug('sain', { routes: r => r.get('/api/p/sain/a', (q, s) => s.end()) }),
  ] })
  const app = express()
  assert.doesNotThrow(() => host.mount(app, {}))
  assert.deepEqual(collectRoutes(app._router), [{ method: 'GET', path: '/api/p/sain/a' }])
  const s = host.signals({}, T0)
  assert.ok(!s.some(x => x.key === 'casse_r:1'), 'disabled: no more signals')
  assert.equal(s.find(x => x.key === 'plugin_error:casse').detail, 'routes : montage cassé')
})

test('asynchronous start that rejects: same treatment as a start that throws (plugin disabled, plugin_error)', async () => {
  const host = createHost({ cfg: {}, log: quiet, plugins: [plug('lent', { rules: ['lent_r'], signals: () => [{ key: 'lent_r:1', rule: 'lent_r', cond: true }], start: async () => { throw new Error('démarrage refusé') } })] })
  host.start()
  await new Promise(resolve => setImmediate(resolve))
  const s = host.signals({}, T0)
  assert.ok(!s.some(x => x.key === 'lent_r:1'))
  assert.equal(s.find(x => x.key === 'plugin_error:lent').detail, 'start : démarrage refusé')
})

test('summary.value that returns a promise: refused (null key, plugin_error), never "{}" silently', () => {
  const host = createHost({ cfg: {}, log: quiet, plugins: [plug('promis', { summary: { key: 'promis', value: async () => ({ n: 1 }) } })] })
  assert.deepEqual(host.summaries({}), { promis: null })
  assert.equal(JSON.stringify(host.summaries({})), '{"promis":null}')
  assert.match(host.signals({}, T0).find(x => x.key === 'plugin_error:promis').detail, /summary : summary\.value doit rendre une valeur, pas une promesse/)
})

test('source that never returns: per-source timeout (configurable, bounded) then "délai dépassé" error, like a collection error', async () => {
  const host = createHost({ cfg: {}, log: quiet, plugins: [plug('muet', { collect: { 'muet-src': { periodSec: 30, timeoutSec: 1, fn: () => new Promise(() => {}) } } })] })
  const [c0] = host.collectors()
  assert.equal(c0.timeoutSec, 1)
  const sources = { cluster: async () => [], runners: async () => [], giteaRepos: async () => [], backups: async () => [], nodes: async () => [], disks: async () => [] }
  const c = createCollector(sources, { setTimer: () => {}, now: () => T0, extra: host.collectors() })
  await c.runAll()
  assert.deepEqual([c.snap['muet-src'].error, c.snap['muet-src'].data], ['délai dépassé', null])
  // default min(periodSec, 60) s, bounded by periodSec
  const d = createHost({ cfg: {}, log: quiet, plugins: [plug('d1', { collect: { 'd1-a': { periodSec: 30, fn: async () => 1 }, 'd1-b': { periodSec: 600, fn: async () => 1 }, 'd1-c': { periodSec: 20, timeoutSec: 90, fn: async () => 1 } } })] })
  assert.deepEqual(d.collectors().map(x => x.timeoutSec), [30, 60, 20])
  assert.throws(() => moduleOf('m', { collect: { s: { periodSec: 30, timeoutSec: 0, fn: () => {} } } }), /timeoutSec entier >= 1/)
})
