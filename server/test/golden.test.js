// Golden tests. They freeze the CURRENT behavior before the plugin refactor (plugin host,
// Gitea as a plugin, channels): rule signals, byte-exact digest (Gitea configured or not), body of
// /api/summary, responses of /api/gitea and /api/runners, collection (sources, start, periods),
// deploy: items of the updates, Telegram notifications (text, order, buttons) and route table of
// the real server (method, path, guard, read gate). Inputs: test/golden/world.js (frozen world,
// neutral data, no network call). References: test/golden/*.json|txt, readable in review.
//
// DELIBERATE update of a reference (never in npm test): from server/,
//   npm run golden:update
// rewrites the files of test/golden/; read the diff (git diff test/golden/) and justify it in the
// commit. An unwanted difference is a regression: fix the code, not the reference.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmpdir.js'
import { GOLDEN_DIR, outputs, buildWorld, englishOutputs } from './golden/world.js'
import { createRules, CORE_RULES } from '../lib/alerts/rules.js'
import { routeTable, routesText } from './golden/routes.js'
import { clientOutputs, CLIENT_INSTALLED } from './golden/client.js'
import { clientViewsOutputs, CASE_COUNT } from './golden/client-views.js'
import { collectRoutes } from './golden/route-walk.js'
import express from 'express'

const expected = name => fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf8')
const HINT = 'differs from the reference: regression, or intended update (npm run golden:update, then review git diff test/golden/)'

test('golden: signals, digest, summary, Gitea, collection, deploy: updates, Telegram notifications', async t => {
  const out = await outputs({ storeDir: tmpDir('vigie-golden-', t) })
  const files = fs.readdirSync(GOLDEN_DIR).filter(f => /\.(json|txt)$/.test(f) && f !== 'routes.txt' && !f.startsWith('client') && !f.endsWith('.en.txt')).sort()
  assert.deepEqual(Object.keys(out).sort(), files, 'reference set: one output per file, no more, no less')
  for (const [name, text] of Object.entries(out)) assert.equal(text, expected(name), `${name}: ${HINT}`)
})

// instance texts in English (Telegram, digest, incidents, network, extras, bot…), same world
test('golden English: Telegram, incidents, digest (with and without Gitea), cycle, full digest, network, extras, rules, send queue, bot', async t => {
  const out = await englishOutputs({ storeDir: tmpDir('vigie-golden-en-', t) })
  const files = fs.readdirSync(GOLDEN_DIR).filter(f => f.endsWith('.en.txt') && !f.startsWith('client')).sort()
  assert.deepEqual(Object.keys(out).sort(), files, 'English reference set: one per file, no more, no less')
  for (const [name, text] of Object.entries(out)) {
    assert.ok(text, `${name}: empty output`)
    assert.equal(text, expected(name), `${name}: ${HINT}`)
  }
})

test('golden: each rule type emitted by the core (without module) in the frozen world is in CORE_RULES; each signal of a module is of a declared type', async t => {
  const w = await buildWorld({ storeDir: tmpDir('vigie-golden-core-', t) })
  const core = createRules(w.cfg, w.monitor, w.agents, null, null, null, null).evaluate(w.snap, Date.parse('2026-11-10T09:00:00Z'))
  assert.ok(core.length > 50)
  assert.deepEqual([...new Set(core.map(s => s.rule))].filter(r => !CORE_RULES.includes(r)), [], 'type emitted by the core outside CORE_RULES')
  const all = w.rules.evaluate(w.snap, Date.parse('2026-11-10T09:00:00Z'))
  const coreKeys = new Set(core.map(s => s.key))
  const errors = all.filter(s => s.rule === 'plugin_error' && s.cond)
  assert.deepEqual(errors.map(s => `${s.key} : ${s.detail}`), [], 'no module signal refused')
  assert.ok(all.filter(s => !coreKeys.has(s.key)).every(s => s.rule === 'plugin_error' || !CORE_RULES.includes(s.rule) || s.rule === 'source_error'))
  // no key emitted twice in one pass, on the full world (core, core modules, plugins)
  const seen = new Map()
  for (const s of all) seen.set(s.key, (seen.get(s.key) ?? 0) + 1)
  assert.deepEqual([...seen].filter(([, n]) => n > 1), [], 'key emitted twice')
  w.store.db.close()
})

test('golden: route table of the real server (method, path, guard, read without session)', async t => {
  const rows = await routeTable(tmpDir('vigie-golden-routes-', t))
  assert.equal(routesText(rows), expected('routes.txt'), `routes.txt: ${HINT}`)
})

test('golden: check of the listing, a mounted (and nested) router appears with its prefix', () => {
  // expected form of a plugin: express.Router mounted by app.use(prefix, router)
  const app = express()
  app.get('/api/avant', (req, res) => res.end())
  const plugin = express.Router()
  plugin.get('/etat', (req, res) => res.end())
  plugin.post('/action', (req, res) => res.end())
  const inner = express.Router()
  inner.get('/fiche/:id', (req, res) => res.end())
  plugin.use('/sous', inner)
  app.use('/api/p/demo', plugin)
  const racine = express.Router()
  racine.get('/api/racine', (req, res) => res.end())
  app.use(racine)
  app.all('/api/*', (req, res) => res.end())
  assert.deepEqual(collectRoutes(app._router), [
    { method: 'GET', path: '/api/avant' },
    { method: 'GET', path: '/api/p/demo/etat' },
    { method: 'POST', path: '/api/p/demo/action' },
    { method: 'GET', path: '/api/p/demo/sous/fiche/:id' },
    { method: 'GET', path: '/api/racine' },
    { method: 'ALL', path: '/api/*' },
  ])
})

test('golden client: navigation (side, mobile), served routes, cockpit tiles and panels, rule labels', async t => {
  if (!CLIENT_INSTALLED) return t.skip('client not installed (npm ci in client/)')
  assert.equal(await clientOutputs(), expected('client.txt'), `client.txt: ${HINT}`)
})

// client views rendered in French, frozen on the code before the text extraction: any
// difference is a regression of the extraction (or a deliberate fix, justified in the commit)
test('golden of the client views: frame, views, drawers and forms rendered in French (sample data, frozen time)', async t => {
  if (!CLIENT_INSTALLED) return t.skip('client not installed (npm ci in client/)')
  assert.ok(CASE_COUNT >= 55, `${CASE_COUNT} cases`)
  assert.equal(await clientViewsOutputs('fr'), expected('client-views.txt'), `client-views.txt: ${HINT}`)
})

// the same views in English (reference for reviewing the English catalog); the sample
// data does not change (its texts, coming from the server, stay in French)
test('golden of the client views in English: same cases, English catalog', async t => {
  if (!CLIENT_INSTALLED) return t.skip('client not installed (npm ci in client/)')
  assert.equal(await clientViewsOutputs('en'), expected('client-views.en.txt'), `client-views.en.txt: ${HINT}`)
})

test('golden: neutral references (example.net, RFC 5737) and no secret from the bench', () => {
  for (const f of fs.readdirSync(GOLDEN_DIR).filter(x => /\.(json|txt)$/.test(x))) {
    const text = expected(f)
    assert.doesNotMatch(text, /jeton-de-banc|secret-de-banc/, `${f}: test-bench secret copied`)
    for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) assert.match(ip, /^(192\.0\.2|198\.51\.100|203\.0\.113|127\.0\.0)\./, `${f}: IP outside RFC 5737 (${ip})`)
  }
})
