// Alert selection for bulk actions (pure module
// client/src/lib/alertSelection.js) and real rendering of the Alerts page (esbuild + react-dom/server):
// no checkbox without an admin session, checkboxes and shortcuts with the session, environment
// filter respected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effective, toggle, prune, groups, portOf, allPorts, resultText } from '../../client/src/lib/alertSelection.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBundle } from './client-render.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const NOW = Date.now()
const alert = (key, over = {}) => ({
  key, rule: key.split(':')[0], entity: 'x', title: `Titre ${key}`, env: 'prod', severity: 'info', state: 'firing', since: NOW - 3600_000,
  firedAt: NOW - 3600_000, suppressed: null, flapping: false, detail: null, host: null, link: null, notified: true, incidentId: 1, hostId: 'docker-a', ack: null, ...over,
})
const P1 = alert('port_new:docker-a:tcp/32765')
const P2 = alert('port_new:docker-a:udp/32768')
const P3 = alert('port_new:docker-b:tcp/34573', { hostId: 'docker-b' })
const D = alert('guest_disk:docker-c:/', { rule: 'guest_disk', hostId: 'docker-c', severity: 'warning', env: 'dev' })

test('selection: effective = checked AND visible (filter, alert gone), in list order', () => {
  const sel = new Set([P2.key, D.key, 'port_new:docker-a:tcp/1'])
  assert.deepEqual(effective(sel, [P1, P2, P3, D]), [P2.key, D.key])
  assert.deepEqual(effective(sel, [P1, P2, P3]), [P2.key], 'D hidden by the filter: never sent')
  assert.deepEqual(effective(new Set(), [P1]), [])
})

test('pruning on each update; an alert gone then back with the same key is no longer checked', () => {
  const s0 = new Set([P1.key, P2.key])
  assert.equal(prune(s0, [P1, P2, P3]), s0, 'nothing to remove: same set (no extra render)')
  const s1 = prune(s0, [P1, P3])
  assert.deepEqual([...s1], [P1.key], 'P2 resolved: removed')
  assert.deepEqual([...s0].sort(), [P1.key, P2.key].sort(), 'original set intact')
  // P2 comes back on the next refresh: not checked
  assert.deepEqual(effective(prune(s1, [P1, P2, P3]), [P1, P2, P3]), [P1.key])
  assert.deepEqual([...prune(s0, [])], [])
  // wiring: the page prunes on each new /api/alerts response (the whole active list)
  const src = fs.readFileSync(path.join(ROOT, 'client/src/views/Alerts.jsx'), 'utf8')
  assert.match(src, /useEffect\(\(\) => \{\n\s+if \(d\) setSelected\(cur => prune\(cur, d\.active\)\)\n\s+\}, \[d\]\)/)
})

test('selection: toggle of a key, a group, everything (all checked → all unchecked); original set intact', () => {
  const s0 = new Set([P1.key])
  const s1 = toggle(s0, [P1.key, P2.key])
  assert.deepEqual([...s1].sort(), [P1.key, P2.key].sort())
  assert.deepEqual([...s0], [P1.key])
  assert.deepEqual([...toggle(s1, [P1.key, P2.key])], [])
  assert.deepEqual([...toggle(s1, [P2.key])], [P1.key])
  assert.deepEqual([...toggle(s0, [])], [P1.key])
})

test('rule + host groups: at least two alerts, readable label; missing host: rule only', () => {
  const ci1 = alert('ci_failed:a', { rule: 'ci_failed', hostId: null })
  const ci2 = alert('ci_failed:b', { rule: 'ci_failed', hostId: null })
  assert.deepEqual(groups([P1, P3, P2, D, ci1, ci2]).map(g => [g.label, g.keys]), [
    ['Nouveau port en écoute · docker-a', [P1.key, P2.key]],
    ['CI en échec', [ci1.key, ci2.key]],
  ])
  assert.deepEqual(groups([P1, P3]), [])
})

test('"Mark as known": port_new keys only; readable result', () => {
  assert.deepEqual(portOf(P1.key), { host: 'docker-a', proto: 'tcp', port: 32765 })
  assert.deepEqual(portOf('port_new:hote:avec:deux-points:udp/53'), { host: 'hote:avec:deux-points', proto: 'udp', port: 53 })
  assert.equal(portOf('port_new:docker-a:sctp/1'), null)
  assert.equal(portOf(D.key), null)
  assert.equal(allPorts([P1.key, P3.key]), true)
  assert.equal(allPorts([P1.key, D.key]), false)
  assert.equal(allPorts([]), false)
  const results = [{ ok: true }, { ok: false, error: 'déjà acquittée' }, { ok: false, error: 'alerte inconnue' }, { ok: false, error: 'déjà acquittée' }]
  assert.equal(resultText({ results, ok: 12, failed: 3 }), '12 acquittées, 3 en échec (déjà acquittée ×2, alerte inconnue)')
  assert.equal(resultText({ results: [{ ok: true }], ok: 1, failed: 0 }), '1 acquittée')
  assert.equal(resultText({ results: [{ ok: false, error: 'port déjà connu' }], ok: 0, failed: 1 }, ['port marqué connu', 'ports marqués connus']), '0 port marqué connu, 1 en échec (port déjà connu)')
})

const client = t => clientBundle(t, 'l17', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import Alerts from './src/views/Alerts.jsx'",
  'export function render({ seed = {}, search = "" } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: "/alertes", ssrSearch: search }, h(AdminProvider, null, h(Alerts)))))',
  '}',
])
const notifier = { telegram: true, dryRun: false, quietNow: false, queued: 0, deferred: 0, lastSentAt: null, lastError: null, graceUntil: 0, quietHours: { start: '23:00', end: '07:30' }, digestAt: '08:00', heartbeat: null }
const seed = admin => ({
  alerts: { generatedAt: new Date().toISOString(), active: [P1, P2, P3, D], incidents: [], notifier },
  session: { admin, configured: true, networkAllowed: true, bot: { enabled: false } },
  silences: { active: [], recent: [] },
})

test('Alerts page without an admin session: no checkbox, no selection shortcut (as before)', async t => {
  const c = await client(t)
  if (!c) return
  const html = c.render({ seed: seed(false) })
  assert.match(html, /Titre port_new:docker-a:tcp\/32765/)
  assert.doesNotMatch(html, /type="checkbox"/)
  assert.doesNotMatch(html, /Tout sélectionner|Sélectionner «|Actions sur la sélection/)
})

test('Alerts page with the admin session: one checkbox per alert, "Select all" and groups on the visible alerts (environment filter applied)', async t => {
  const c = await client(t)
  if (!c) return
  const html = c.render({ seed: seed(true) })
  assert.equal(html.match(/aria-label="Sélectionner «/g).length, 4)
  assert.match(html, /Tout sélectionner \(4\)/)
  assert.match(html, /aria-pressed="false"[^>]*>Nouveau port en écoute · docker-a \(2\)/)
  assert.doesNotMatch(html, /Actions sur la sélection/, 'nothing checked: no action bar')
  const prod = c.render({ seed: seed(true), search: 'env=prod' })
  assert.equal(prod.match(/aria-label="Sélectionner «/g).length, 3)
  assert.match(prod, /Tout sélectionner \(3\)/)
  assert.doesNotMatch(prod, /guest_disk:docker-c/)
  const dev = c.render({ seed: seed(true), search: 'env=dev' })
  assert.match(dev, /Tout sélectionner \(1\)/)
  assert.doesNotMatch(dev, /Nouveau port en écoute · docker-a \(/, 'group filtered out with its alerts')
})
