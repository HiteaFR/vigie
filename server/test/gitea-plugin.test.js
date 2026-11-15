// Gitea, first plugin (server/plugins/gitea). Alert keys from before the plugin kept (an alert
// open in prod neither resolves nor reopens on deployment), plugins.gitea config and the old
// "gitea" block, core without Gitea.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost, validatePluginConfig } from '../lib/plugins/host.js'
import { createRules, CORE_RULES } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { parseConfig } from '../lib/config.js'
import { PLUGINS } from '../plugins/index.js'
import { coreModules, CORE_MODULE_RULES } from '../lib/plugins/core.js'
import { definePlugin } from '../lib/plugins/host.js'
import gitea from '../plugins/gitea/index.js'
import { tmpStore } from './tmpdir.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const T0 = Date.parse('2026-11-12T09:00:00Z')
const MIN = 60_000
const quiet = { log() {}, warn() {}, error() {} }
const MINIMAL = { version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], alerts: {} }
const ENV = { GITEA_URL: 'http://gitea.example.net', GITEA_TOKEN: 'jeton' }
const SNAP = {
  gitea: { data: [{ name: 'app', defaultBranch: 'main', mainRun: { status: 'failure', number: 12, title: 'app : correctif' } }], error: null, at: T0 },
  runners: { data: [{ id: 2, name: 'runner-b', status: 'offline' }], error: null, at: T0 },
}

test('deployment: Gitea alerts opened by the core from before the plugin, then evaluated by the plugin after restart: same keys, no resolution or reopening, same incident', t => {
  const store = tmpStore('vigie-p4b-deploi-', t)
  const cfg = parseConfig({ ...MINIMAL, gitea: { owner: 'example' } }).config
  const clock = createClock('Europe/Paris')
  const sent = []
  const notifier = { enqueue: (kind, st) => (sent.push(`${kind}:${st.key}`), 'now') }
  // before the plugin: signals as the core emitted them (golden reference signals.json)
  const before = [
    { key: 'ci_failed:app', rule: 'ci_failed', entity: 'app', title: 'CI app', env: 'prod', cond: true, severity: 'warning', detail: 'main #12 app : correctif', link: '/ci', parents: [] },
    { key: 'runner_offline:runner-b', rule: 'runner_offline', entity: 'runner-b', title: 'Runner runner-b', env: 'prod', cond: true, forSec: 600, severity: 'warning', detail: 'état : offline', link: '/ci', parents: [] },
  ]
  const old = createEngine({ cfg, store, rules: { evaluate: () => before, impacted: () => ({ services: [], guests: 0 }) }, notifier, clock, startedAt: T0 - 3600_000 })
  for (let m = 0; m <= 15; m++) old.evaluate({}, T0 + m * MIN)
  const opened = before.map(s => old.get(s.key))
  assert.deepEqual(opened.map(s => s.state), ['firing', 'firing'])
  const n = sent.length
  // after the plugin: restart on the same database, plugin rules through the host
  const host = createHost({ cfg, env: ENV, log: quiet, plugins: [gitea], coreRules: CORE_RULES })
  const next = createEngine({ cfg, store, rules: createRules(cfg, { checks: [], result: () => null }, null, null, null, null, null, { host }), notifier, clock, startedAt: T0 - 3600_000 })
  for (let m = 16; m <= 30; m++) next.evaluate(SNAP, T0 + m * MIN)
  assert.deepEqual(sent.slice(n).filter(x => !x.includes('plugin_error')), [], 'neither resolution nor reopening')
  for (const s of opened) {
    const now = next.get(s.key)
    assert.deepEqual([now.state, now.incidentId, now.title, now.detail], ['firing', s.incidentId, s.title, s.detail], s.key)
  }
})

test('config: plugins.gitea (schema), old "gitea" block accepted with a warning, both refused; plugin known from the static list', () => {
  // ntfy is added after gitea
  assert.deepEqual(PLUGINS.map(p => p.id), ['gitea', 'ntfy'])
  assert.deepEqual(validatePluginConfig({ plugins: { gitea: { owner: 'o' } } }, PLUGINS), [])
  assert.deepEqual(validatePluginConfig({ gitea: { owner: 'o', repos: ['a'] } }, PLUGINS), [])
  assert.deepEqual(validatePluginConfig({ plugins: { gitea: { owner: 'o' } }, gitea: { owner: 'o' } }, PLUGINS), ['plugins.gitea and gitea: a single block for plugin gitea (keep plugins.gitea)'])
  assert.deepEqual(validatePluginConfig({ plugins: { gitea: { repos: [] } } }, PLUGINS), ['plugins.gitea.owner: Invalid input: expected string, received undefined'])
  assert.deepEqual(validatePluginConfig({ gitea: { owner: 'o', autre: 1 } }, PLUGINS), ['gitea: Unrecognized key: "autre"'])
  // the root schema accepts both forms (the plugin validates the content)
  assert.ok(parseConfig({ ...MINIMAL, gitea: { owner: 'o' } }).config)
  assert.ok(parseConfig({ ...MINIMAL, plugins: { gitea: { owner: 'o' } } }).config)
  const warns = []
  const log = { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} }
  createHost({ cfg: { gitea: { owner: 'o' } }, env: ENV, log, plugins: [gitea] })
  assert.deepEqual(warns, ['[gitea] config.json: old "gitea" block, replace it with "plugins.gitea" (accepted until publication)'])
  warns.length = 0
  createHost({ cfg: { plugins: { gitea: { owner: 'o' } } }, env: ENV, log, plugins: [gitea] })
  assert.deepEqual(warns, [])
  // declared secrets: the two variables from before the plugin, and nothing else
  assert.deepEqual(gitea.secrets, ['GITEA_URL', 'GITEA_TOKEN'])
})

test('core without Gitea: no source, rule, route, digest line, summary block, or update item outside the plugin', () => {
  const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8')
  for (const f of ['index.js', 'lib/sources.js', 'lib/alerts/collect.js', 'lib/alerts/rules.js', 'lib/notify/digest.js', 'lib/status.js', 'lib/refresh.js']) {
    const code = read(f).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.doesNotMatch(code, /gitea|GITEA|runners|ci_failed|runner_offline/i, f)
  }
  // updates: no more reading of the Gitea snapshot (deploy: items through the components hook)
  const updates = read('lib/updates/index.js')
  assert.doesNotMatch(updates, /snap\.gitea|deployComponents/)
  assert.match(updates, /extraComponents\(\)\.map\(component\)/)
})

test('types of core modules reserved before plugins: a plugin that declares eol or net_new is refused (plugin_error), startup continues and the core modules are added', () => {
  const thief = definePlugin({ id: 'voleur', apiVersion: 0, configured: () => true, setup: () => ({ rules: ['eol'], signals: () => [{ key: 'eol:x', rule: 'eol', cond: true }] }) })
  const thief2 = definePlugin({ id: 'voleur-reseau', apiVersion: 0, configured: () => true, setup: () => ({ rules: ['net_new'], signals: () => [] }) })
  const host = createHost({ cfg: {}, env: ENV, log: quiet, plugins: [thief, thief2], coreRules: CORE_RULES, reservedRules: CORE_MODULE_RULES })
  assert.doesNotThrow(() => { for (const m of coreModules({ updates: { signals: () => [] }, network: { signals: () => [] } })) host.addModule(m) })
  const errs = Object.fromEntries(host.list().map(m => [m.id, m.errors.setup?.message ?? null]))
  assert.deepEqual(errs, {
    updates: null, network: null,
    voleur: 'rule type eol already declared by updates (core module)',
    'voleur-reseau': 'rule type net_new already declared by network (core module)',
  })
  const s = host.signals({}, T0)
  assert.ok(!s.some(x => x.key === 'eol:x'))
  assert.equal(s.find(x => x.key === 'plugin_error:voleur').cond, true)
})
