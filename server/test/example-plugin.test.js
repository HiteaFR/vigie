// Example plugin (server/plugins/example, client/src/plugins/example), missing from the active
// lists, loaded in a test host against a LOCAL fake service (127.0.0.1): collection through
// ctx.http (vigie User-Agent, Bearer token), rule and source_error, digest, summary, route,
// extensions (probe, widget auth and format, update sources, service definitions), and client-side
// view and tile.
import { test } from 'node:test'
import { setLocale } from '../lib/i18n.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'
import example from '../plugins/example/index.js'
import { PLUGINS } from '../plugins/index.js'
import { createHost, validatePluginConfig } from '../lib/plugins/host.js'
import { registerExtensions } from '../lib/plugins/extensions.js'
import { CORE_RULES } from '../lib/alerts/rules.js'
import { CORE_MODULE_RULES, RESERVED_PLUGIN_IDS } from '../lib/plugins/core.js'
import { createHttp } from '../lib/http.js'
import { parseConfig } from '../lib/config.js'
import { runCheck } from '../lib/checks.js'
import { loadDefsSets } from '../lib/network/probe.js'
import { serviceDefSets } from '../lib/registry.js'
import { clientBundle } from './client-render.js'
import { request } from './server-boot.js'

const TOKEN = 'jeton-exemple-123'
const quiet = { log() {}, warn() {}, error() {} }
const NOW = Date.parse('2026-11-10T09:00:00Z')

async function service() {
  const s = { depth: 3, status: 200, got: [] }
  const srv = http.createServer((req, res) => {
    s.got.push({ path: req.url, auth: req.headers.authorization ?? null, ua: (req.headers['user-agent'] ?? '').split('/')[0] })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') return res.end(JSON.stringify({ status: s.health ?? 'ok' }))
    if (s.status !== 200) { res.statusCode = s.status; return res.end('{}') }
    res.end(JSON.stringify({ depth: s.depth }))
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  s.url = `http://127.0.0.1:${srv.address().port}`
  s.close = () => new Promise(r => srv.close(r))
  return s
}
const benchHost = (url, over = {}) => createHost({
  cfg: { plugins: { example: { url, maxDepth: 5 } } }, env: { EXAMPLE_TOKEN: TOKEN }, log: quiet, plugins: [example],
  coreRules: CORE_RULES, reservedRules: CORE_MODULE_RULES, reservedIds: RESERVED_PLUGIN_IDS, http: createHttp({ defaultSecret: true }), ...over,
})

test('example: missing from the active lists (server and client); config validated by its schema', () => {
  assert.ok(!PLUGINS.some(p => p.id === 'example'), 'not in server/plugins/index.js')
  for (const f of ['index.jsx', 'nav.js', 'meta.js']) assert.doesNotMatch(fs.readFileSync(new URL(`../../client/src/plugins/${f}`, import.meta.url), 'utf8'), /example/, f)
  assert.deepEqual(validatePluginConfig({ plugins: { example: { url: 'http://192.0.2.1:8080' } } }, [example]), [])
  assert.deepEqual(validatePluginConfig({ plugins: { example: { url: 'pas une url' } } }, [example]), ['plugins.example.url: Invalid URL'])
})

test('example in a test host: collection (ctx.http, vigie User-Agent, Bearer), rule, source_error, digest, summary, route; collection error = data', async () => {
  const svc = await service()
  try {
    const host = benchHost(svc.url)
    assert.equal(host.view().modules.find(m => m.id === 'example').state, 'active')
    const [col] = host.collectors()
    assert.equal(col.name, 'example-queue')
    const snap = { 'example-queue': { data: await col.fn(), at: NOW, error: null } }
    assert.deepEqual(snap['example-queue'].data, { depth: 3 })
    assert.deepEqual(svc.got[0], { path: '/api/queue', auth: `Bearer ${TOKEN}`, ua: 'vigie' })
    const keyed = s => Object.fromEntries(host.signals(s, NOW).filter(x => x.rule !== 'plugin_error').map(x => [x.key, x.cond]))
    assert.deepEqual(keyed(snap), { 'source_error:example-queue': false, 'example_queue:main': false })
    svc.depth = 9
    assert.deepEqual(keyed({ 'example-queue': { data: await col.fn(), at: NOW, error: null } }), { 'source_error:example-queue': false, 'example_queue:main': true })
    // texts through the plugin catalog, in the instance locale (fr by default, en)
    assert.deepEqual(host.digestLines('end', { snap, now: NOW }), ['🧪 File d\'exemple : 3'])
    assert.deepEqual(host.summaries({ snap, now: NOW }).example, { depth: 3, max: 5 })
    assert.deepEqual(host.labels({}), { example_queue: 'File trop longue' })
    const texts = () => host.signals({ 'example-queue': { data: { depth: 1 }, at: NOW, error: null } }, NOW).filter(x => x.rule !== 'plugin_error').map(x => [x.title, x.detail])
    assert.deepEqual(texts(), [['File d\'exemple illisible', null], ['File d\'exemple', '1 tâche en attente']])
    setLocale('en')
    try {
      assert.deepEqual(texts(), [['Example queue unreadable', null], ['Example queue', '1 job waiting']])
      assert.deepEqual(host.digestLines('end', { snap, now: NOW }), ['🧪 Example queue: 3'])
      assert.deepEqual(host.labels({}), { example_queue: 'Queue too long' })
    } finally {
      setLocale('fr')
    }
    // collection error: data (source_error), not plugin_error
    svc.status = 503
    await assert.rejects(col.fn(), /^Error: file : HTTP 503$/)
    setLocale('en')
    try {
      await assert.rejects(col.fn(), /^Error: queue: HTTP 503$/)
    } finally {
      setLocale('fr')
    }
    const err = { 'example-queue': { data: { depth: 9 }, at: NOW, error: 'file : HTTP 503' } }
    assert.deepEqual(keyed(err), { 'source_error:example-queue': true, 'example_queue:main': null })
    assert.equal(host.signals(err, NOW).find(x => x.key === 'plugin_error:example').cond, false)
    // route, mounted by the host: it serves the last collected value (never an
    // outgoing request per incoming request; 20 GETs → no request to the service)
    svc.status = 200
    const app = express()
    host.mount(app, { wrap: fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next) })
    const srv = app.listen(0, '127.0.0.1')
    await new Promise(r => srv.once('listening', r))
    try {
      const before = svc.got.length
      for (let i = 0; i < 20; i++) {
        const r = await request(srv.address().port, '/api/example')
        assert.deepEqual([r.status, r.json.depth, r.json.max], [200, 9, 5])
      }
      assert.equal(svc.got.length, before, 'no outgoing request for 20 GETs')
      // the next collection updates what the route serves
      svc.depth = 4
      await col.fn()
      assert.equal(svc.got.length, before + 1)
      assert.equal((await request(srv.address().port, '/api/example')).json.depth, 4)
    } finally {
      srv.close()
    }
  } finally {
    await svc.close()
  }
})

test('example, extensions: probe, widget auth and format, update sources in the config; probe run; service definitions read by the network probe', async () => {
  assert.deepEqual(registerExtensions([example], { env: {} }).errors, new Map())
  const svc = await service()
  try {
    const raw = { version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], alerts: {}, services: [{
      id: 's', name: 'S', group: 'g', env: 'prod', url: svc.url,
      checks: [{ type: 'example-health', url: `${svc.url}/health` }],
      widget: { url: svc.url, auth: { type: 'example-key', secretEnv: 'EXAMPLE_KEY' }, fields: [{ label: 'Taille', path: '/x', json: 'size', format: 'example-mb' }] },
      version: { current: { from: 'example-version', url: `${svc.url}/version` }, latest: { from: 'example-feed', url: `${svc.url}/feed` } },
    }] }
    assert.equal(parseConfig(raw).errors, undefined)
    assert.deepEqual(await runCheck({ type: 'example-health', url: `${svc.url}/health` }, { timeoutMs: 1000, retryDelayMs: 0 }).then(r => [r.state, r.code]), ['ok', 200])
    // the probe measures with the clock it receives (now), never Date.now()
    let tick = 1000
    const r = await runCheck({ type: 'example-health', url: `${svc.url}/health` }, { timeoutMs: 1000, retryDelayMs: 0, now: () => (tick += 250) })
    assert.equal(r.latencyMs, 250)
    assert.doesNotMatch(fs.readFileSync(new URL('../plugins/example/index.js', import.meta.url), 'utf8'), /Date\.now\(\)/)
    svc.health = 'degraded'
    assert.deepEqual(await runCheck({ type: 'example-health', url: `${svc.url}/health` }, { timeoutMs: 1000, retryDelayMs: 0 }).then(r => [r.state, r.error]), ['crit', 'status: degraded'])
    const defs = loadDefsSets({ plugins: serviceDefSets.list() })
    assert.deepEqual(defs.sets.at(-1), { source: 'plugin example', count: 1, error: null })
  } finally {
    await svc.close()
  }
})

test('example client side: registry (lazy route, tile), navigation outside the mobile bar, label; view and tile rendered (through its catalog, in French and in English)', async t => {
  const c = await clientBundle(t, 'p4f-example', [
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement as h } from 'react'",
    "import { Router } from 'wouter'",
    "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
    "import plugin from './src/plugins/example/index.jsx'",
    "import nav from './src/plugins/example/nav.js'",
    "import meta from './src/plugins/example/meta.js'",
    "import ExampleView from './src/plugins/example/ExampleView.jsx'",
    "import { ExampleKpi } from './src/plugins/example/tiles.jsx'",
    'export { plugin, nav, meta }',
    'export function render(which, data) {',
    '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })',
    "  qc.setQueryData(['/api/example'], data)",
    "  const el = which === 'view' ? h(ExampleView) : h(ExampleKpi, { s: { example: data }, env: 'all' })",
    "  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: '/example' }, el)))",
    '}',
  ])
  if (!c) return
  assert.deepEqual([c.plugin.id, c.plugin.routes.map(r => r.path), c.plugin.tiles.kpi.map(x => x.order)], ['example', ['/example'], [90]])
  assert.deepEqual(c.meta.labels, { example_queue: { label: { en: 'Queue too long', fr: 'File trop longue' }, order: 1000 } })
  // plugin catalog (locales/), registered by meta.js under "example."; navigation
  // label read at render time (getter), hence in the locale loaded afterwards
  assert.deepEqual(c.nav.map(n => [n.path, n.label, n.order, n.mobile]), [['/example', 'Exemple', 85, false]])
  assert.match(c.render('view', { depth: 9, max: 5 }), /File d&#x27;exemple.*9<\/span> tâches en attente \(alerte au-delà de 5\)/s)
  assert.match(c.render('view', { depth: 1, max: 5 }), /1<\/span> tâche en attente \(alerte au-delà de 5\)/s)
  const tile = c.render('kpi', { depth: 3, max: 5 })
  assert.match(tile, /href="\/example"/)
  assert.match(tile, /File.*3.*alerte au-delà de 5/s)
  assert.match(c.render('kpi', {}), /File.*—.*inconnue/s)
  await c.__loadLocale('en')
  try {
    assert.deepEqual(c.nav.map(n => n.label), ['Example'])
    assert.match(c.render('view', { depth: 9, max: 5 }), /Example queue.*9<\/span> jobs waiting \(alert above 5\)/s)
    assert.match(c.render('view', { depth: 1, max: 5 }), /1<\/span> job waiting \(alert above 5\)/s)
    assert.match(c.render('kpi', { depth: 3, max: 5 }), /Queue.*3.*alert above 5/s)
  } finally {
    await c.__loadLocale('fr')
  }
})
