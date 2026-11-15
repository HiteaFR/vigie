// Client: "to configure" page (no config file), before the login screen; CI view
// and cockpit tile when Gitea is not configured. Pure decision and real rendering (react-dom/server).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accessState } from '../../client/src/lib/access.js'
import { clientBundle } from './client-render.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/src')
const CLOSED = { admin: false, anonymousRead: false, configured: false, networkAllowed: true, httpRefused: false, expiresAt: null }

test('accessState: unconfigured before anything (even with anonymous read or a session); otherwise as with safe defaults', () => {
  assert.equal(accessState({ ...CLOSED, unconfigured: true }), 'unconfigured')
  assert.equal(accessState({ ...CLOSED, anonymousRead: true, unconfigured: true }), 'unconfigured')
  assert.equal(accessState(CLOSED), 'login')
  assert.equal(accessState({ ...CLOSED, anonymousRead: true }), 'open')
})

const client = t => clientBundle(t, 'p3a-app', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import App from './src/App.jsx'",
  "import Ci from './src/plugins/gitea/Ci.jsx'",
  'function wrap(el, seed, path) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: path }, h(AdminProvider, null, el))))',
  '}',
  'export const app = ({ seed = {}, path = "/" } = {}) => wrap(h(App), seed, path)',
  'export const ci = ({ seed = {} } = {}) => wrap(h(Ci), seed, "/ci")',
])

test('App in "to configure" mode: dedicated page (what to do, README), neither login nor application, SPA like the wall display', async t => {
  const c = await client(t)
  if (!c) return
  for (const p of ['/', '/mural', '/reseau']) {
    const html = c.app({ seed: { session: { ...CLOSED, unconfigured: true }, config: { title: 'Vigie' } }, path: p })
    assert.match(html, /<h1[^>]*>Vigie : à configurer<\/h1>/, p)
    assert.match(html, /npm run init/)
    assert.match(html, /config\.example\.json/)
    assert.match(html, /admin-password\.js/)
    assert.match(html, /Détails : docs\/installation\.md\./)
    assert.doesNotMatch(html, /type="password"|<nav/, p)
  }
})

test('CI view: Gitea not configured → a message and the steps to follow, without an error panel; configured → panels', async t => {
  const c = await client(t)
  if (!c) return
  const off = c.ci({ seed: { gitea: { configured: false }, runners: { configured: false } } })
  assert.match(off, /Gitea non configuré/)
  assert.match(off, /GITEA_URL/)
  assert.doesNotMatch(off, /Runners CI|Activité Gitea/)
  const on = c.ci({ seed: { gitea: [], runners: [] } })
  assert.match(on, /Runners CI/)
  assert.match(on, /Activité Gitea/)
})

test('cockpit (static): CI tile "not configured" in the neutral state, CI card that says so, lists protected against the { configured: false } object', () => {
  // CI tile and card of the gitea plugin
  const src = fs.readFileSync(path.join(CLIENT, 'plugins/gitea/tiles.jsx'), 'utf8')
  // "non configurée" through the plugin catalog (gitea.tile_off)
  assert.match(src, /sub=\{ci\.configured === false \? t\('gitea\.tile_off'\)/)
  assert.match(src, /state=\{ci\.configured === false \? 'none'/)
  assert.match(src, /if \(gitea\.data\?\.configured === false\)/)
  assert.match(src, /Array\.isArray\(gitea\.data\) \? gitea\.data : \[\]/)
  assert.match(src, /Array\.isArray\(runners\.data\) \? runners\.data : \[\]/)
})
