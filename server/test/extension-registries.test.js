// Extension registries (lib/registry.js) and extensions declared by plugins
// (lib/plugins/extensions.js). Fake plugins; registries global to the process: distinct names
// per test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { definePlugin, createHost, PluginError } from '../lib/plugins/host.js'
import { registerExtensions } from '../lib/plugins/extensions.js'
import { probeTypes, createRegistry } from '../lib/registry.js'
import { parseConfig } from '../lib/config.js'
import { runCheck, describe, PLUGIN_MARGIN_MS } from '../lib/checks.js'
import { createMonitor } from '../lib/monitor.js'

const quiet = { log() {}, warn() {}, error() {} }
const MINIMAL = { version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }
const withChecks = checks => ({ ...MINIMAL, services: [{ id: 's', name: 'S', group: 'g', env: 'prod', checks }] })
const plugin = (id, extensions, extra = {}) => definePlugin({ id, apiVersion: 0, configured: () => true, setup: () => ({}), extensions, ...extra })

test('registry: valid and unique name (core included), frozen entries, registration order; the four core types', () => {
  const r = createRegistry('essai')
  r.add('a', { x: 1 })
  r.add('b-2', { x: 2 }, 'plug')
  assert.deepEqual(r.names(), ['a', 'b-2'])
  assert.deepEqual([r.get('b-2').owner, r.get('a').owner, r.get('a').name], ['plug', 'core', 'a'])
  assert.ok(Object.isFrozen(r.get('a')))
  assert.throws(() => r.add('a', {}), /essai a already declared by the core/)
  assert.throws(() => r.add('b-2', {}, 'autre'), /essai b-2 already declared by plugin plug/)
  assert.throws(() => r.add('A', {}), /essai: invalid name/)
  r.removeOwner('plug')
  assert.deepEqual(r.names(), ['a'])
  assert.deepEqual(probeTypes.names().slice(0, 4), ['http', 'tcp', 'tls', 'dns'])
  assert.deepEqual(probeTypes.list().slice(0, 4).map(p => [p.owner, p.intervalSec]), [['core', 60], ['core', 60], ['core', 21600], ['core', 60]])
})

test('plugin probe: type added to the config (plugin fields, host label and interval), describe, default period, normalized result', async () => {
  const seen = []
  const ping = plugin('sonde-ping', { probes: { ping: {
    fields: { host: z.string(), count: z.number().int().optional() },
    intervalSec: 120,
    run: async (c, o) => (seen.push([c.host, o.timeoutMs]), { state: 'ok', latencyMs: 3, code: 'ping', extra: 'ignoré' }),
    describe: c => ({ label: c.label || `ping ${c.host}`, display: `ping://${c.host}` }),
  } } })
  assert.deepEqual(registerExtensions([ping]).errors, new Map())
  assert.deepEqual(probeTypes.get('ping').owner, 'sonde-ping')
  // config: accepted, unknown fields refused, union widened to the plugin type
  assert.equal(parseConfig(withChecks([{ type: 'ping', host: '192.0.2.1', interval: '5m' }])).errors, undefined)
  assert.deepEqual(parseConfig(withChecks([{ type: 'ping', host: '192.0.2.1', ttl: 3 }])).errors, ['services.0.checks.0: Unrecognized key: "ttl"'])
  assert.deepEqual(parseConfig(withChecks([{ type: 'icmp' }])).errors, ["services.0.checks.0.type: Invalid discriminator value. Expected 'http' | 'tcp' | 'tls' | 'dns' | 'ping'"])
  // monitor: label, display, period of the type
  const cfg = parseConfig(withChecks([{ type: 'ping', host: '192.0.2.1' }, { type: 'ping', host: '192.0.2.2', label: 'passerelle', interval: '30s' }])).config
  const m = createMonitor(cfg, { setTimer: () => 0 })
  assert.deepEqual(m.checks.map(c => [c.label, c.display, c.intervalSec]), [['ping 192.0.2.1', 'ping://192.0.2.1', 120], ['passerelle', 'ping://192.0.2.2', 30]])
  // result: known fields only
  assert.deepEqual(await runCheck({ type: 'ping', host: '192.0.2.1' }, { timeoutMs: 100, retryDelayMs: 0 }), { state: 'ok', latencyMs: 3, code: 'ping' })
  assert.deepEqual(seen, [['192.0.2.1', 100]])
})

test('isolation of a plugin probe: hang = crit (bounded timeout); error and invalid result THROW with a prefixed message; the monitor turns it into an "unknown" result (data), without counting a failure; describe that throws: fallback', async () => {
  const mode = { v: 'lève' }
  const p = plugin('sonde-fragile', { probes: { fragile: {
    fields: {},
    run: () => {
      if (mode.v === 'lève') throw new Error('boum')
      if (mode.v === 'bloque') return new Promise(() => {})
      if (mode.v === 'invalide') return { state: 'peut-être' }
      return { state: 'crit', error: 'x'.repeat(500) }
    },
    describe: () => { throw new Error('describe cassé') },
  } } })
  registerExtensions([p])
  const o = { timeoutMs: 50, retryDelayMs: 0 }
  await assert.rejects(runCheck({ type: 'fragile' }, o), /^Error: sonde fragile \(plugin sonde-fragile\) : boum$/)
  mode.v = 'bloque'
  const t0 = Date.now()
  // timeout exceeded = crit (like the core), second attempt included
  assert.deepEqual(await runCheck({ type: 'fragile' }, o), { state: 'crit', latencyMs: 50 + PLUGIN_MARGIN_MS, code: 0, error: 'délai dépassé' })
  assert.ok(Date.now() - t0 < 2 * (50 + PLUGIN_MARGIN_MS) + 500, 'bounded timeout')
  mode.v = 'invalide'
  await assert.rejects(runCheck({ type: 'fragile' }, o), /résultat invalide/)
  mode.v = 'crit'
  const r = await runCheck({ type: 'fragile' }, o)
  assert.deepEqual([r.state, r.error.length], ['crit', 200], 'bounded message')
  assert.deepEqual(describe({ type: 'fragile', label: 'ma sonde' }), { label: 'ma sonde', display: 'fragile' })
  assert.deepEqual(describe({ type: 'fragile' }), { label: 'fragile', display: 'fragile' })
  // real monitor: the error becomes an "unknown" result, fails and oks unchanged; the other probes keep going
  mode.v = 'lève'
  const cfg = parseConfig(withChecks([{ type: 'fragile' }])).config
  const m = createMonitor(cfg, { setTimer: () => 0, run: c => runCheck(c, o) })
  await m.runAll()
  const res = m.result('s#0')
  assert.deepEqual([res.state, res.fails, res.oks], ['unknown', 0, 0])
  assert.match(res.error, /sonde fragile \(plugin sonde-fragile\) : boum/)
})

test('refused extensions: core name or already taken → nothing registered for this plugin (all or nothing), plugin_error:<id> (extensions hook); definePlugin checks the shape', () => {
  const thief = plugin('voleur', { probes: { libre: { fields: {}, run: () => ({ state: 'ok' }), describe: () => ({ label: 'l', display: 'l' }) }, http: { fields: {}, run: () => ({ state: 'ok' }), describe: () => ({ label: 'h', display: 'h' }) } } })
  const r = registerExtensions([thief])
  assert.equal(r.errors.get('voleur'), 'probe type http already declared by the core')
  assert.ok(!probeTypes.has('libre'), 'all or nothing')
  assert.equal(probeTypes.get('http').owner, 'core')
  const host = createHost({ cfg: {}, log: quiet, plugins: [thief], extensionErrors: r.errors })
  const pe = host.signals({}, Date.parse('2026-11-12T09:00:00Z')).find(s => s.key === 'plugin_error:voleur')
  assert.deepEqual([pe.cond, pe.detail], [true, 'extensions : probe type http already declared by the core'])
  // an id reserved for the core registers nothing
  const reserved = plugin('backups', { probes: { sauve: { fields: {}, run: () => ({ state: 'ok' }), describe: () => ({ label: 's', display: 's' }) } } })
  assert.deepEqual(registerExtensions([reserved], { reservedIds: ['backups'] }).errors, new Map())
  assert.ok(!probeTypes.has('sauve'))
  // shape checked at definition
  assert.throws(() => plugin('x', { canaux: {} }), /unknown extension "canaux"/)
  assert.throws(() => plugin('x', { probes: { p: { fields: {}, describe: () => ({}) } } }), /probe p: run and describe expected/)
  assert.throws(() => plugin('x', { probes: { p: { run() {}, describe() {} } } }), /fields \(zod shape\) expected/)
  assert.throws(() => plugin('x', { probes: { p: { fields: { label: z.string() }, run() {}, describe() {} } } }), /field label reserved/)
  assert.throws(() => plugin('x', { probes: { p: { fields: {}, run() {}, describe() {}, intervalSec: 5 } } }), PluginError)
})

// --- widgets ----------------------------------------------------------------------------------------
import http from 'node:http'
import { createWidgets } from '../lib/widgets.js'
import { widgetAuths, widgetFormats } from '../lib/registry.js'

async function appServer(handler) {
  const srv = http.createServer(handler)
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) }
}

test('widget registries: core formats and authentications in the previous order; plugin: authentication (headers, query) and format added to the config and the engine', async () => {
  assert.deepEqual(widgetFormats.names().slice(0, 10), ['number', 'int', 'percent', 'mbps', 'ms', 'rate', 'until', 'ago', 'bool', 'text'])
  assert.deepEqual(widgetAuths.names().slice(0, 5), ['header', 'bearer', 'query', 'pihole', 'qbittorrent'])
  const p = plugin('widget-signe', { widgetAuths: {
    signe: { fields: { secretEnv: z.string(), realm: z.string() }, headers: async (a, { secret, url }) => ({ 'X-Signe': `${a.realm}:${secret(a.secretEnv)}:${new URL(url).hostname}` }) },
    jeton: { fields: { secretEnv: z.string() }, query: (a, { secret }) => [['jeton', secret(a.secretEnv)], ['v', '2']] },
  }, widgetFormats: { octets: { numeric: true, format: v => `${Number(v) / 1000} ko` }, majuscules: { numeric: false, format: v => String(v).toUpperCase() } } })
  assert.deepEqual(registerExtensions([p]).errors, new Map())
  const seen = []
  const srv = await appServer((req, res) => {
    seen.push([req.url, req.headers['x-signe'] ?? null])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ taille: 2500, nom: 'abc', texte: 'x' }))
  })
  try {
    const raw = { ...MINIMAL, services: [
      { id: 'a', name: 'A', group: 'g', env: 'prod', url: srv.url, widget: { url: srv.url, auth: { type: 'signe', secretEnv: 'SIG', realm: 'r1' }, fields: [{ label: 'Taille', path: '/a', json: 'taille', format: 'octets' }, { label: 'Nom', path: '/a', json: 'nom', format: 'majuscules' }, { label: 'Texte', path: '/a', json: 'texte', format: 'octets' }] } },
      { id: 'b', name: 'B', group: 'g', env: 'prod', url: srv.url, widget: { url: srv.url, auth: { type: 'jeton', secretEnv: 'JET' }, fields: [{ label: 'T', path: '/b?x=1', json: 'taille', format: 'int' }] } },
    ] }
    const parsed = parseConfig(raw)
    assert.equal(parsed.errors, undefined)
    assert.deepEqual(parseConfig({ ...raw, services: [{ ...raw.services[0], widget: { ...raw.services[0].widget, auth: { type: 'signe', secretEnv: 'SIG' } } }] }).errors, ['services.0.widget.auth.realm: Invalid input: expected string, received undefined'])
    assert.match(parseConfig({ ...raw, services: [{ ...raw.services[1], widget: { ...raw.services[1].widget, fields: [{ label: 'x', path: '/x', format: 'kilo' }] } }] }).errors[0], /expected one of "number"\|"int"\|.*\|"text"\|"octets"\|"majuscules"$/)
    const w = createWidgets(parsed.config, { SIG: 'sig-1', JET: 'jet-2' }, { piholes: { get() {} } })
    await w.runAll()
    assert.deepEqual(w.get('a').fields, [{ label: 'Taille', value: '2.5 ko' }, { label: 'Nom', value: 'ABC' }, { label: 'Texte', value: '—' }])
    assert.deepEqual(w.get('b').fields, [{ label: 'T', value: '2\u202f500' }])
    assert.deepEqual(seen.sort(), [['/a', 'r1:sig-1:127.0.0.1'], ['/b?x=1&jeton=jet-2&v=2', null]])
  } finally {
    await srv.close()
  }
})

test('isolation of plugin widgets: authentication that throws or hangs (bounded timeout) and format that throws → widget error as DATA (prefixed message, old values kept), the other widgets keep going', async () => {
  const mode = { auth: 'ok', fmt: 'ok' }
  const p = plugin('widget-fragile', { widgetAuths: {
    capricieuse: { fields: {}, headers: () => (mode.auth === 'lève' ? Promise.reject(new Error('jeton expiré')) : mode.auth === 'bloque' ? new Promise(() => {}) : {}) },
  }, widgetFormats: { cassant: { numeric: false, format: v => { if (mode.fmt === 'lève') throw new Error('format cassé'); return `<${v}>` } } } })
  registerExtensions([p])
  const srv = await appServer((req, res) => res.end(JSON.stringify({ v: 1 })))
  try {
    const cfg = parseConfig({ ...MINIMAL, services: [
      { id: 'f', name: 'F', group: 'g', env: 'prod', url: srv.url, widget: { url: srv.url, auth: { type: 'capricieuse' }, fields: [{ label: 'V', path: '/v', json: 'v', format: 'cassant' }] } },
      { id: 'sain', name: 'Sain', group: 'g', env: 'prod', url: srv.url, widget: { url: srv.url, fields: [{ label: 'V', path: '/v', json: 'v' }] } },
    ] }).config
    const w = createWidgets(cfg, {}, { piholes: { get() {} }, pluginTimeoutMs: 100 })
    await w.runAll()
    assert.deepEqual(w.get('f').fields, [{ label: 'V', value: '<1>' }])
    mode.auth = 'lève'
    await w.runAll()
    assert.deepEqual([w.get('f').error, w.get('f').stale, w.get('f').fields], ['authentification capricieuse (plugin widget-fragile) : jeton expiré', true, [{ label: 'V', value: '<1>' }]])
    mode.auth = 'bloque'
    const t0 = Date.now()
    await w.runAll()
    assert.equal(w.get('f').error, 'authentification capricieuse (plugin widget-fragile) : délai dépassé')
    assert.ok(Date.now() - t0 < 2000)
    mode.auth = 'ok'
    mode.fmt = 'lève'
    await w.runAll()
    assert.equal(w.get('f').error, 'format cassant (plugin widget-fragile) : format cassé')
    assert.deepEqual([w.get('sain').error, w.get('sain').fields], [null, [{ label: 'V', value: '1' }]], 'the other widgets keep going')
  } finally {
    await srv.close()
  }
  // shape checked at definition
  assert.throws(() => plugin('x', { widgetAuths: { a: { fields: {} } } }), /auth a: headers or query expected/)
  assert.throws(() => plugin('x', { widgetAuths: { a: { fields: { type: z.string() }, headers() {} } } }), /field type reserved/)
  assert.throws(() => plugin('x', { widgetFormats: { f: { format() {} } } }), /numeric \(boolean\) and format expected/)
  assert.equal(registerExtensions([plugin('vol-format', { widgetFormats: { int: { numeric: true, format: String } } })]).errors.get('vol-format'), 'widget format int already declared by the core')
})

// --- update sources -----------------------------------------------------------------------------------
import { createUpdates } from '../lib/updates/index.js'
import { openDb } from '../lib/db.js'
import { latestSources, currentSources } from '../lib/registry.js'
import { tmpDir } from './tmpdir.js'

const NOW = Date.parse('2026-11-10T09:00:00Z')
const upstreamStub = over => ({ github: async () => [], githubTags: async () => [], giteaCom: async () => [], pypi: async () => [], httpJson: async () => ({}), eol: async () => [], node: async () => [], remoteDigest: async () => null, remoteTags: async () => [], pvePackages: async () => [], errors: () => [], stats: () => ({}), ...over })
async function versionsOf(services, { upstream = upstreamStub(), pluginTimeoutMs } = {}) {
  const parsed = parseConfig({ ...MINIMAL, hosts: [{ id: 'h', name: 'hote', kind: 'appliance', env: 'prod', ip: '192.0.2.20' }], services: services.map(s => ({ group: 'g', host: 'h', url: 'http://192.0.2.20/', ...s })) })
  if (parsed.errors) return { errors: parsed.errors }
  const store = openDb(tmpDir('vigie-p4d-maj-'))
  const u = createUpdates({ cfg: parsed.config, store, agents: { hosts: [], get: () => null }, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: quiet, ...(pluginTimeoutMs ? { pluginTimeoutMs } : {}) })
  await u.refresh(NOW)
  const list = u.view().components.filter(c => c.service)
  store.db.close()
  return { list }
}

test('update source registries: core ones in the previous order (gitea = gitea.com releases); plugin: latest version and installed version sources in the config and the engine, choice from a list as for GitHub', async () => {
  assert.deepEqual(latestSources.names().slice(0, 4), ['github', 'gitea', 'pypi', 'http-json'])
  assert.deepEqual(currentSources.names().slice(0, 3), ['http-json', 'http-regex', 'agent'])
  const p = plugin('forge-maison', {
    latestSources: {
      forge: { fields: { projet: z.string() }, label: src => `forge:${src.projet}`, latest: async (src, { releases, current }) => releases([{ tag: 'v2.1.0', url: `https://forge.example.test/${src.projet}/2.1.0` }, { tag: 'v2.0.0' }, { tag: `v${current}` }]) },
      fixe: { fields: { version: z.string() }, latest: async src => ({ latest: src.version, url: 'https://fixe.example.test', inconnu: 'ignoré' }) },
    },
    currentSources: { lue: { fields: { valeur: z.string() }, current: async src => src.valeur } },
  })
  assert.deepEqual(registerExtensions([p]).errors, new Map())
  const { list } = await versionsOf([
    { id: 'a', name: 'A', version: { current: { from: 'lue', valeur: '2.0.0' }, latest: { from: 'forge', projet: 'outil' } } },
    { id: 'b', name: 'B', version: { current: { from: 'lue', valeur: '1.0' }, latest: { from: 'fixe', version: '1.2' } } },
  ])
  const by = Object.fromEntries(list.map(c => [c.id, c]))
  assert.deepEqual([by['svc:a'].current, by['svc:a'].latest, by['svc:a'].gap, by['svc:a'].source, by['svc:a'].url], ['2.0.0', '2.1.0', 'minor', 'forge:outil', 'https://forge.example.test/outil/2.1.0'])
  assert.deepEqual([by['svc:b'].latest, by['svc:b'].gap, by['svc:b'].source, by['svc:b'].url], ['1.2', 'minor', 'fixe', 'https://fixe.example.test'])
  // config: unknown source refused as before; plugin fields validated
  assert.deepEqual((await versionsOf([{ id: 'c', name: 'C', version: { current: { from: 'lue' } } }])).errors, ['services.0.version: Invalid input'])
})

test('isolation of plugin update sources: error, hang (bounded timeout) or missing version → component error as DATA (prefixed message), the other components keep going', async () => {
  const p = plugin('maj-fragile', {
    latestSources: {
      leve: { fields: {}, latest: async () => { throw new Error('API fermée') } },
      bloque: { fields: {}, latest: () => new Promise(() => {}) },
    },
    currentSources: { vide: { fields: {}, current: async () => null } },
  })
  registerExtensions([p])
  const t0 = Date.now()
  const { list, errors } = await versionsOf([
    { id: 'x', name: 'X', version: { current: { from: 'http-json', url: 'http://192.0.2.30/v', path: 'v' }, latest: { from: 'leve' } } },
    { id: 'y', name: 'Y', version: { current: { from: 'http-json', url: 'http://192.0.2.30/v', path: 'v' }, latest: { from: 'bloque' } } },
    { id: 'z', name: 'Z', version: { current: { from: 'vide' } } },
    { id: 'ok', name: 'Ok', version: { current: { from: 'http-json', url: 'http://192.0.2.30/v', path: 'v' }, latest: { from: 'gitea', repo: 'org/forge' } } },
  ], { pluginTimeoutMs: 100, upstream: upstreamStub({ httpJson: async () => ({ v: '1.0.0' }), giteaCom: async () => [{ tag: 'v1.1.0' }] }) })
  assert.equal(errors, undefined)
  assert.ok(Date.now() - t0 < 3000, 'bounded timeout')
  const err = Object.fromEntries(list.map(c => [c.id, c.error]))
  assert.equal(err['svc:x'], 'dernière version leve (plugin maj-fragile) : API fermée')
  assert.equal(err['svc:y'], 'dernière version bloque (plugin maj-fragile) : délai dépassé')
  assert.equal(err['svc:z'], 'version installée vide (plugin maj-fragile) : version absente')
  const ok = list.find(c => c.id === 'svc:ok')
  assert.deepEqual([ok.error, ok.latest, ok.source], [null, '1.1.0', 'gitea'])
  // shape checked at definition
  assert.throws(() => plugin('x', { latestSources: { s: { fields: {} } } }), /latest-version source s: latest expected/)
  assert.throws(() => plugin('x', { currentSources: { s: { fields: { from: z.string() }, current() {} } } }), /field from reserved/)
  assert.equal(registerExtensions([plugin('vol-source', { latestSources: { github: { fields: {}, latest() {} } } })]).errors.get('vol-source'), 'latest-version source github already declared by the core')
})

// --- service definitions ------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { DEFS_FILE, loadDefs, loadDefsSets, recognise, MAX_TOTAL_DEFS } from '../lib/network/probe.js'
import { serviceDefSets } from '../lib/registry.js'

const defsJson = (defs, attribution = 'essai') => JSON.stringify({ attribution, defs })
const def = (id, match, category = 'essai') => ({ id, name: id.toUpperCase(), category, match })

test('extra definitions: without additions, exactly the shipped file; folders (*.json sorted) then plugins, added after the shipped one; invalid set, id already defined or cap exceeded dropped entirely with its error; the shipped one stays', () => {
  const core = loadDefs(DEFS_FILE)
  const alone = loadDefsSets()
  assert.deepEqual([alone.defs, alone.ports, alone.attribution], [core.defs, core.ports, core.attribution])
  assert.deepEqual(alone.sets, [{ source: 'livrées', count: core.defs.length, error: null }])
  const a = tmpDir('vigie-p4d-defs-a-')
  const b = tmpDir('vigie-p4d-defs-b-')
  fs.writeFileSync(path.join(a, '20-outil.json'), defsJson([def('outil', { allOf: [{ port: 7070 }, { http: { port: 7070, path: '/sante', contains: 'outil' } }] }), def('autre', { port: 7071 })]))
  fs.writeFileSync(path.join(a, '10-casse.json'), '{')
  fs.writeFileSync(path.join(a, '30-double.json'), defsJson([def('ssh', { port: 2222 })]))
  fs.writeFileSync(path.join(a, 'ignore.txt'), 'pas du json')
  fs.writeFileSync(path.join(b, 'meme-id.json'), defsJson([def('outil', { port: 7072 })]))
  const r = loadDefsSets({ dirs: [a, b, path.join(a, 'absent')], plugins: [{ source: 'plugin p', data: { attribution: 'p', defs: [def('du-plugin', { port: 7073 })] } }] })
  assert.ok(r.ok)
  assert.deepEqual(r.sets.map(s => [path.basename(s.source), s.count, s.error]), [
    ['livrées', core.defs.length, null],
    ['10-casse.json', 0, 'definitions: invalid JSON'],
    ['20-outil.json', 2, null],
    ['30-double.json', 0, 'definitions: id already defined (ssh)'],
    ['meme-id.json', 0, 'definitions: id already defined (outil)'],
    ['absent', 0, 'definitions: unreadable directory'],
    ['plugin p', 1, null],
  ])
  assert.deepEqual(r.defs.slice(0, core.defs.length), core.defs, 'built-in ones first, unchanged')
  assert.deepEqual(r.defs.slice(core.defs.length).map(d => d.id), ['outil', 'autre', 'du-plugin'])
  assert.ok([7070, 7071, 7073].every(p => r.ports.includes(p)) && !r.ports.includes(2222) && !r.ports.includes(7072))
  // resolution: the added definition recognizes its service
  const resp = (p, pth) => (p === 7070 && pth === '/sante' ? { status: 200, body: 'outil ok', headers: {}, bytes: 8 } : null)
  const seen = recognise(r, { open: new Set([7070, 22]), resp, vendor: null, portOwners: r.portOwners })
  assert.deepEqual([...seen], [[22, { service: 'ssh', confidence: 'low' }], [7070, { service: 'outil', confidence: 'high' }]])
  // cap: a set that would exceed it is dropped
  const big = tmpDir('vigie-p4d-defs-big-')
  const chunk = n => defsJson(Array.from({ length: 64 }, (_, i) => def(`g${n}-${i}`, { port: 10000 + n * 64 + i })))
  for (let n = 0; n < 4; n++) fs.writeFileSync(path.join(big, `${n}.json`), chunk(n))
  const capped = loadDefsSets({ dirs: [big] })
  assert.ok(capped.defs.length <= MAX_TOTAL_DEFS)
  assert.equal(capped.sets.at(-1).error, `definitions: more than ${MAX_TOTAL_DEFS} in total`)
  // an invalid shipped file still disables the probe
  const off = loadDefsSets({ file: path.join(a, 'absent.json'), dirs: [a] })
  assert.deepEqual([off.ok, off.error], [false, 'definitions: unreadable file'])
})

test('extra definitions: network.probe.defsDirs (absolute paths, 8 at most); plugin: extensions.serviceDefs validated at registration (invalid → plugin_error, nothing registered), read by the probe; probe status (extraDefs only if there are additions)', async () => {
  const net = { subnets: [{ cidr: '192.0.2.0/24', name: 'lan' }], sources: {}, probe: { enabled: false, defsDirs: ['relatif'] } }
  assert.deepEqual(parseConfig({ ...MINIMAL, network: net }).errors, ['network.probe.defsDirs.0: absolute path'])
  assert.equal(parseConfig({ ...MINIMAL, network: { ...net, probe: { defsDirs: ['/etc/vigie/defs.d'] } } }).errors, undefined)
  assert.equal(parseConfig({ ...MINIMAL, network: { ...net, probe: {} } }).config.network.probe.defsDirs, undefined, 'absent by default')
  // plugin
  const good = plugin('defs-plugin', { serviceDefs: { attribution: 'plugin', defs: [def('service-plugin', { port: 7080 })] } })
  const bad = plugin('defs-casse', { serviceDefs: { attribution: 'plugin', defs: [def('MAJ', { port: 1 })] } })
  const r = registerExtensions([good, bad])
  assert.deepEqual([...r.errors.keys()], ['defs-casse'])
  assert.match(r.errors.get('defs-casse'), /^serviceDefs : definitions: defs\.0\.id/)
  assert.deepEqual(serviceDefSets.list().map(s => [s.source, s.owner]), [['plugin defs-plugin', 'defs-plugin']])
  assert.throws(() => plugin('x', { serviceDefs: { defs: 'non' } }), /serviceDefs: \{ attribution, defs \} expected/)
  // the network module probe reads the plugin sets; status without additions: previous shape
  const { createProbe } = await import('../lib/network/probe.js')
  const cfg = { hosts: [], network: { probe: { enabled: false, exclude: [] } } }
  const p1 = createProbe({ ns: null, kv: { get: () => null, set() {} }, cfg, clock: null, getState: () => ({}), log: quiet })
  assert.ok(p1.defs.defs.some(d => d.id === 'service-plugin'))
  assert.deepEqual(p1.status().extraDefs, [{ source: 'plugin defs-plugin', count: 1, error: null }])
  const p0 = createProbe({ ns: null, kv: { get: () => null, set() {} }, cfg, clock: null, getState: () => ({}), log: quiet, defsPlugins: [] })
  assert.ok(!('extraDefs' in p0.status()))
})

test('doc (docs/network.md): the published example of extra definitions is accepted as is; the section cites the limits of the code', () => {
  const doc = fs.readFileSync(new URL('../../docs/network.md', import.meta.url), 'utf8')
  assert.ok(doc.includes('### Additional service definitions'))
  const sec = doc.slice(doc.indexOf('### Additional service definitions'))
  const json = sec.match(/```json\n([\s\S]*?)```/)[1]
  const dir = tmpDir('vigie-p4d-readme-')
  fs.writeFileSync(path.join(dir, 'exemple.json'), json)
  const r = loadDefsSets({ dirs: [dir] })
  assert.deepEqual(r.sets.at(-1), { source: path.join(dir, 'exemple.json'), count: 1, error: null })
  assert.match(sec, new RegExp(`${MAX_TOTAL_DEFS} in total`))
})

test('probe status: extraDefs gives the name of the added file, never its path (read by /api/network)', async () => {
  const { createProbe } = await import('../lib/network/probe.js')
  const dir = tmpDir('vigie-p4d-status-')
  fs.writeFileSync(path.join(dir, 'a.json'), defsJson([def('status-a', { port: 7090 })]))
  const logs = []
  const p = createProbe({ ns: null, kv: { get: () => null, set() {} }, cfg: { hosts: [], network: { probe: { enabled: false, exclude: [], defsDirs: [dir, path.join(dir, 'absent')] } } }, clock: null, getState: () => ({}), log: { ...quiet, error: m => logs.push(m) }, defsPlugins: [] })
  assert.deepEqual(p.status().extraDefs, [{ source: 'a.json', count: 1, error: null }, { source: 'absent', count: 0, error: 'definitions: unreadable directory' }])
  assert.ok(!JSON.stringify(p.status()).includes(dir))
  assert.deepEqual(logs, [`network: definitions dropped (${path.join(dir, 'absent')}): definitions: unreadable directory`])
})

// --- masking of plugin extension messages ---------------------------------------------------------------
test('masking: errors of plugin probes, widgets and update sources go out masked (URL with credentials, parameters, Bearer, values of secrets declared by the plugin and of the widget secrets)', async () => {
  const SECRET = 'valeur-secrete-du-plugin'
  const WSECRET = 'valeur-secrete-du-widget'
  const msg = extra => `fetch http://admin:S3cr3tPass@h.example.test/api?token=abcdef123456 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ${extra}`
  const LEAKS = ['S3cr3tPass', 'abcdef123456', 'eyJhbGciOiJIUzI1NiJ9', SECRET, WSECRET]
  const clean = (where, s) => {
    for (const l of LEAKS) assert.ok(!String(s).includes(l), `${where} contains ${l}`)
    assert.match(String(s), /http:\/\/\*\*\*@h\.example\.test\/api\?token=\*\*\*/, where)
  }
  const p = definePlugin({ id: 'fuite-ext', apiVersion: 0, configured: () => true, setup: () => ({}), secrets: ['FUITE_EXT'], extensions: {
    probes: { fuite: { fields: {}, run: () => { throw new Error(msg(SECRET)) }, describe: () => ({ label: 'f', display: 'f' }) }, fuite2: { fields: {}, run: () => ({ state: 'crit', error: msg(SECRET) }), describe: () => ({ label: 'f', display: 'f' }) } },
    widgetAuths: { fuite: { fields: { secretEnv: z.string() }, headers: (a, { secret }) => { throw new Error(msg(`${SECRET} ${secret(a.secretEnv)}`)) } } },
    widgetFormats: { fuite: { numeric: false, format: () => { throw new Error(msg(SECRET)) } } },
    latestSources: { fuite: { fields: {}, latest: async () => { throw new Error(msg(SECRET)) } } },
  } })
  assert.deepEqual(registerExtensions([p], { env: { FUITE_EXT: SECRET } }).errors, new Map())
  // probe: thrown error, and error field of a result
  await assert.rejects(runCheck({ type: 'fuite' }, { timeoutMs: 50, retryDelayMs: 0 }), e => (clean('probe', e.message), true))
  clean('probe result', (await runCheck({ type: 'fuite2' }, { timeoutMs: 50, retryDelayMs: 0 })).error)
  // widgets: authentication (plugin secret and widget secret), format
  const srv = await appServer((req, res) => res.end(JSON.stringify({ v: 1 })))
  try {
    const cfg = parseConfig({ ...MINIMAL, services: [
      { id: 'a', name: 'A', group: 'g', env: 'prod', url: srv.url, widget: { url: srv.url, auth: { type: 'fuite', secretEnv: 'W_SECRET' }, fields: [{ label: 'V', path: '/v', json: 'v' }] } },
      { id: 'f', name: 'F', group: 'g', env: 'prod', url: srv.url, widget: { url: srv.url, fields: [{ label: 'V', path: '/v', json: 'v', format: 'fuite' }] } },
    ] }).config
    const w = createWidgets(cfg, { W_SECRET: WSECRET }, { piholes: { get() {} } })
    await w.runAll()
    clean('widget (auth)', w.get('a').error)
    clean('widget (format)', w.get('f').error)
  } finally {
    await srv.close()
  }
  // update source
  const { list } = await versionsOf([{ id: 'm', name: 'M', version: { current: { from: 'http-json', url: 'http://192.0.2.31/v', path: 'v' }, latest: { from: 'fuite' } } }], { upstream: upstreamStub({ httpJson: async () => ({ v: '1.0' }) }) })
  clean('update source', list.find(c => c.id === 'svc:m').error)
})

// --- plugin probe: hang, transient exception, lasting exception ---------------------------------------
test('plugin probe: hang = crit ("délai dépassé", like the core); transient exception = unknown without a counted failure; lasting exception (failAfter passes in a row) = failure, service_down at the same moment as a core probe; a success resets', async () => {
  const { createRules } = await import('../lib/alerts/rules.js')
  const mode = { v: 'ok' }
  const p = plugin('sonde-durable', { probes: { durable: { fields: {}, describe: () => ({ label: 'd', display: 'd' }), run: () => {
    if (mode.v === 'pend') return new Promise(() => {})
    if (mode.v === 'lève') throw new Error('bibliothèque cassée')
    return { state: 'ok', latencyMs: 1, code: 'd' }
  } } } })
  registerExtensions([p])
  const o = { timeoutMs: 30, retryDelayMs: 0 }
  // hang: crit, with the second attempt like the core
  mode.v = 'pend'
  assert.deepEqual(await runCheck({ type: 'durable' }, o), { state: 'crit', latencyMs: 30 + PLUGIN_MARGIN_MS, code: 0, error: 'délai dépassé' })
  // monitor and service_down
  const cfg = parseConfig({ ...MINIMAL, services: [{ id: 's', name: 'S', group: 'g', env: 'prod', checks: [{ type: 'durable' }] }] }).config
  assert.equal(cfg.alerts.failAfter, 3)
  const m = createMonitor(cfg, { setTimer: () => 0, run: c => runCheck(c, o) })
  const rules = createRules(cfg, m)
  const down = () => rules.evaluate({}, Date.now()).find(s => s.key === 'service_down:s')
  const pass = async () => { await m.runAll(); const r = m.result('s#0'); return [r.state, r.fails, r.errors ?? 0, down().cond] }
  mode.v = 'ok'
  assert.deepEqual(await pass(), ['ok', 0, 0, null])
  // hang in the monitor: 3 crit → service_down
  mode.v = 'pend'
  assert.deepEqual([await pass(), await pass(), await pass()].map(x => x.slice(0, 2).concat(x[3])), [['crit', 1, null], ['crit', 2, null], ['crit', 3, true]])
  mode.v = 'ok'
  await pass(); await pass()
  assert.equal(down().cond, false, 'recovered after recoverAfter successes')
  // transient exception: unknown, nothing counted, reset on success
  mode.v = 'lève'
  // (unknown keeps the earlier successes: service_down stays recovered, as for the core)
  assert.deepEqual(await pass(), ['unknown', 0, 1, false])
  assert.deepEqual(await pass(), ['unknown', 0, 2, false])
  mode.v = 'ok'
  assert.deepEqual(await pass(), ['ok', 0, 0, false])
  // lasting exception: on the 3rd pass in a row, failure with 3 counted failures → service_down
  mode.v = 'lève'
  await pass(); await pass()
  const third = await pass()
  assert.deepEqual(third, ['crit', 3, 3, true])
  assert.match(m.result('s#0').error, /^sonde en erreur \(3 passages de suite\) : sonde durable \(plugin sonde-durable\) : bibliothèque cassée$/)
  assert.deepEqual(await pass(), ['crit', 4, 4, true])
  mode.v = 'ok'
  // a success resets; service_down waits for recoverAfter successes (null: unchanged)
  assert.deepEqual(await pass(), ['ok', 0, 0, null])
  // core probe that throws (unexpected case): as before, unknown without a counter
  const core = createMonitor(parseConfig({ ...MINIMAL, services: [{ id: 'c', name: 'C', group: 'g', env: 'prod', checks: [{ type: 'tcp', target: '192.0.2.1:1' }] }] }).config, { setTimer: () => 0, run: () => { throw new Error('inattendu') } })
  for (let i = 0; i < 4; i++) await core.runAll()
  assert.deepEqual([core.result('c#0').state, core.result('c#0').fails, 'errors' in core.result('c#0')], ['unknown', 0, false])
})

// --- defsDirs: safe reading -------------------------------------------------------------------------
import { execFileSync } from 'node:child_process'
import { readDefsFile, MAX_DEFS_BYTES } from '../lib/network/probe.js'

test('defsDirs, safe reading: FIFO refused without blocking, 30 MB file refused without being read, link (to /etc/hostname) refused without copying the content; the other files of the folder are still read', { timeout: 10_000 }, () => {
  const dir = tmpDir('vigie-p4d-sur-')
  execFileSync('mkfifo', [path.join(dir, 'a-fifo.json')])
  fs.writeFileSync(path.join(dir, 'b-gros.json'), '')
  fs.truncateSync(path.join(dir, 'b-gros.json'), 30 * 1024 * 1024)
  fs.symlinkSync('/etc/hostname', path.join(dir, 'c-lien.json'))
  fs.writeFileSync(path.join(dir, 'd-bon.json'), defsJson([def('sur-bon', { port: 7099 })]))
  fs.writeFileSync(path.join(dir, 'e-limite.json'), defsJson([def('sur-limite', { port: 7098 })], 'x'.repeat(200)).padEnd(MAX_DEFS_BYTES, ' '))
  const t0 = Date.now()
  const r = loadDefsSets({ dirs: [dir] })
  assert.ok(Date.now() - t0 < 2000, 'no hang')
  assert.deepEqual(r.sets.slice(1).map(s => [path.basename(s.source), s.count, s.error]), [
    ['a-fifo.json', 0, 'definitions: not a regular file'],
    ['b-gros.json', 0, 'definitions: file over 1 MiB'],
    ['c-lien.json', 0, 'definitions: link refused'],
    ['d-bon.json', 1, null],
    ['e-limite.json', 1, null],
  ])
  const host = fs.readFileSync('/etc/hostname', 'utf8').trim()
  if (host.length >= 3) assert.ok(!JSON.stringify(r.sets).includes(host), 'link content never copied')
  // ordinary file right at the limit: read; one more byte: refused
  const ok = path.join(dir, 'f.json')
  fs.writeFileSync(ok, defsJson([def('sur-f', { port: 7097 })]).padEnd(MAX_DEFS_BYTES, ' '))
  assert.equal(readDefsFile(ok).ok, true)
  fs.appendFileSync(ok, ' ')
  assert.equal(readDefsFile(ok).error, 'definitions: file over 1 MiB')
  // missing folder: unreadable, without throwing
  assert.equal(readDefsFile(path.join(dir, 'absent.json')).error, 'definitions: unreadable file')
})
