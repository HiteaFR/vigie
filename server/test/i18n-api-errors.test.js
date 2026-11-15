// API errors shown by the interface (and bot replies) via the catalog; HTTP codes and
// JSON keys unchanged, former French byte for byte.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorHandler } from '../lib/http-errors.js'
import { createSilences, describeMatcher } from '../lib/alerts/silences.js'
import { validateReason, validateMac, deletionBlock } from '../lib/network/writes.js'
import { autoUpdateStatus } from '../lib/updates/autostatus.js'
import { eventText, agentConflictDetail } from '../lib/network/events.js'
import { hostHint } from '../lib/auth.js'
import { openDb } from '../lib/db.js'
import { setLocale } from '../lib/i18n.js'
import { tmpDir } from './tmpdir.js'

const both = fn => {
  const fr = fn()
  setLocale('en')
  try {
    return [fr, fn()]
  } finally {
    setLocale('fr')
  }
}
const message = fn => {
  try {
    fn()
    return null
  } catch (e) {
    return [e.status ?? null, e.message]
  }
}

test('final handler: same status, message via the catalog', () => {
  const run = status => {
    let out
    const res = { headersSent: false, status(s) { out = { s }; return this }, json(j) { out.j = j } }
    errorHandler({ error() {} })(Object.assign(new Error('x'), { status }), { method: 'GET', path: '/x' }, res, () => {})
    return [out.s, out.j.error]
  }
  assert.deepEqual(both(() => [400, 413, 415, 418].map(run)), [
    [[400, 'requête invalide'], [413, 'corps trop gros'], [415, 'type de contenu non pris en charge'], [500, 'erreur interne']],
    [[400, 'invalid request'], [413, 'body too large'], [415, 'unsupported content type'], [500, 'internal error']],
  ])
})

test('silences, network, posture: refusals in both languages, same statuses', t => {
  const store = openDb(tmpDir('p5c-api-', t))
  t.after(() => store.db.close())
  const silences = createSilences({ store })
  const view = () => [
    message(() => silences.create({ matcher: {}, reason: 'motif valable', by: 'a', source: 'ui' })),
    message(() => silences.create({ matcher: { host: 'web' }, reason: 'x', by: 'a', source: 'ui' })),
    message(() => validateReason('a')),
    message(() => validateMac('zz')),
    describeMatcher({ host: 'web' }),
    deletionBlock({ id: 1, host_id: 'web' }, { macs: new Map() }, { cfg: { hosts: [{ id: 'web' }] } }).why,
    hostHint(),
  ]
  const [fr, en] = both(view)
  assert.deepEqual(fr.slice(2), [[400, 'motif obligatoire (3 à 200 caractères)'], [400, 'MAC invalide'], 'hôte web', 'appareil lié à l\'hôte web : il serait recréé au relevé suivant', 'ajouter ce nom à allowedHosts dans la config, puis redémarrer'])
  assert.deepEqual(en.slice(2), [[400, 'reason required (3 to 200 characters)'], [400, 'invalid MAC'], 'host web', 'device linked to host web: it would be created again at the next read', 'add this name to allowedHosts in the config, then restart'])
  assert.match(fr[0][1], /^cible : un seul critère/)
  assert.match(en[0][1], /^target: a single criterion/)
  assert.equal(fr[1][1], 'motif obligatoire (3 caractères au moins)')
  assert.equal(en[1][1], 'reason required (at least 3 characters)')
})

test('automatic updates (host state) and container conflict (persisted event) in both languages', () => {
  assert.deepEqual(both(() => [autoUpdateStatus(null).detail, autoUpdateStatus({ version: 6 }).detail]), [
    ['pas encore de rapport de l\'agent', 'agent sans suivi des MAJ auto (v6)'],
    ['no agent report yet', 'agent without auto-update tracking (v6)'],
  ])
  // format written today, and rendering of an old row (written in French by an earlier version)
  const old = 'conteneur docker-a/web/lan : déjà associé à la fiche 4 ; rattachement par identité suspendu'
  const now = agentConflictDetail('docker-a/web/lan', 4, null)
  assert.equal(now, 'container docker-a/web/lan: already linked to record 4; identity attachment suspended')
  assert.equal(agentConflictDetail('docker-a/web/lan', null, 'docker-b/web/lan'), 'container docker-a/web/lan: record already linked to docker-b/web/lan; identity attachment suspended')
  for (const d of [old, now]) assert.deepEqual(both(() => eventText('agent_conflict', d)), [old, 'container docker-a/web/lan: already linked to device 4; identity attachment suspended'])
})

test('map, suggestions, on-demand probe, posture criteria: in both languages', async () => {
  const { buildTopology } = await import('../lib/network/topology.js')
  const { CRITERION_LABEL } = await import('../lib/agentmemory.js')
  const { mergeDefs } = await import('../lib/network/probe.js')
  const view = () => [CRITERION_LABEL.firewall, mergeDefs({ ok: true, defs: [], portOwners: new Map() }, []).sets[0].source, mergeDefs({ ok: false, error: 'x' }, []).sets[0].source]
  assert.deepEqual(both(view), [['pare-feu', 'livrées', 'livrées'], ['firewall', 'shipped', 'shipped']])
  const topo = () => {
    const t = buildTopology({ cfg: { hosts: [], network: { subnets: [] } }, devices: new Map(), links: [{ id: 9, child: 'dev:99', parent: 'dev:98' }], gateway: '192.0.2.1' })
    return [t.warnings, t.nodes.find(n => n.kind === 'gateway')?.label]
  }
  assert.deepEqual(both(topo), [[['lien 9 orphelin ignoré'], 'Passerelle 192.0.2.1'], [['orphan link 9 ignored'], 'Gateway 192.0.2.1']])
})

test('map: children sorted by the instance locale (no more hardcoded "fr"), default name of a device', async () => {
  const { buildTopology } = await import('../lib/network/topology.js')
  const src = (await import('node:fs')).readFileSync(new URL('../lib/network/topology.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /localeCompare\([^)]*'fr'\)/)
  // observable order: members of a group (more than 6 leaves of the same type under a parent)
  const names = ['éclair', 'zèbre', 'abeille', 'Été', 'ours', 'île', 'Zoé', null]
  const devices = new Map(names.map((name, i) => [i + 1, { id: i + 1, disp_name: name, disp_type: 'other', primary_mac: `00:00:5e:00:53:${String(i + 10)}`, last_ip: `192.0.2.${20 + i}`, state: 'known' }]))
  const members = () => {
    const t = buildTopology({ cfg: { hosts: [], network: { subnets: [{ cidr: '192.0.2.0/24' }] } }, devices, gateway: '192.0.2.1' })
    return t.groups[0].members.map(id => t.nodes.find(n => n.id === id).label)
  }
  const [fr, en] = both(members)
  assert.deepEqual(fr, ['00:00:5e:00:53:17', 'abeille', 'éclair', 'Été', 'île', 'ours', 'zèbre', 'Zoé'])
  assert.deepEqual(en, fr)
})

test('suppression reasons: dependency, muted, maintenance, silence, in both languages', async t => {
  const { createEngine } = await import('../lib/alerts/engine.js')
  const { createClock } = await import('../lib/clock.js')
  const { parseConfig } = await import('../lib/config.js')
  const NOW = Date.parse('2026-11-10T09:00:00Z') // Tuesday 10:00 in Paris
  const raw = { version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }], alerts: { startupGraceSec: 0 },
    hosts: [{ id: 'h1', name: 'h1', kind: 'external', ip: '192.0.2.1', env: 'prod' }, { id: 'h2', name: 'h2', kind: 'external', ip: '192.0.2.2', env: 'prod' }],
    services: [{ id: 'web', name: 'web', group: 'g', host: 'h1', url: 'http://192.0.2.1' }],
    maintenance: [{ start: '09:00', end: '11:00', match: { host: 'h1' }, reason: 'mise à jour' }, { start: '09:00', end: '11:00', match: { host: 'h2' } }] }
  const cfg = parseConfig(raw).config
  const store = openDb(tmpDir('p5c-mask-', t))
  t.after(() => store.db.close())
  const silences = createSilences({ store, now: () => NOW })
  silences.create({ matcher: { key: 'r:silence' }, reason: 'travaux <b>', by: 'admin', source: 'ui', endsAt: null })
  const sig = (key, extra = {}) => ({ key, rule: 'service_down', entity: key, title: key, env: 'prod', cond: true, severity: 'warning', parents: [], ...extra })
  const rules = { impacted: () => ({}), evaluate: () => [sig('r:parent'), sig('r:enfant', { parents: ['r:parent'] }), sig('r:muette', { muted: true }), sig('r:maint', { hostId: 'h1' }), sig('r:maint2', { hostId: 'h2' }), sig('r:silence')] }
  const engine = createEngine({ cfg, store, rules, notifier: { enqueue: () => 'skip' }, clock: createClock('Europe/Paris'), silences, startedAt: NOW - 3600_000 })
  const view = () => {
    engine.evaluate({}, NOW)
    engine.evaluate({}, NOW + 60_000)
    return Object.fromEntries(engine.active().filter(a => a.key !== 'r:parent').map(a => [a.key, a.suppressed]))
  }
  assert.deepEqual(both(view), [
    { 'r:enfant': 'dépendance : r:parent', 'r:muette': 'muette dans la config', 'r:maint': 'maintenance (mise à jour)', 'r:maint2': 'maintenance', 'r:silence': 'silence : travaux <b>' },
    { 'r:enfant': 'dependency: r:parent', 'r:muette': 'muted in the config', 'r:maint': 'maintenance (mise à jour)', 'r:maint2': 'maintenance', 'r:silence': 'silence: travaux <b>' },
  ])
})
