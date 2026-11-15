// Safe defaults, client: without anonymous read or a session, the login screen is shown instead
// of errors (SPA and wall display); with anonymous read or a session, no change. Pure
// decision (lib/access.js) and real rendering of App (react-dom/server, prefilled react-query cache).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accessState, loginBlocker, SESSION_WAIT_MS } from '../../client/src/lib/access.js'
import { clientBundle } from './client-render.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const CLOSED = { admin: false, anonymousRead: false, configured: true, networkAllowed: true, httpRefused: false, expiresAt: null }

test('accessState: pending as long as the session is not read; login without a session or anonymous read; open otherwise (session, anonymous, server from before safe defaults, /api/session failing)', () => {
  assert.equal(accessState(undefined), 'pending')
  assert.equal(accessState(undefined, { error: true }), 'open')
  assert.equal(accessState(CLOSED), 'login')
  assert.equal(accessState({ ...CLOSED, admin: true }), 'open')
  assert.equal(accessState({ ...CLOSED, anonymousRead: true }), 'open')
  const { anonymousRead, ...old } = CLOSED
  assert.equal(anonymousRead, false)
  assert.equal(accessState(old), 'open', 'server without the field (older version): as before')
})

test('loginBlocker: not configured, network not allowed, HTTP refused, in this order; otherwise nothing', () => {
  assert.match(loginBlocker({ ...CLOSED, configured: false }), /non configurée/)
  assert.match(loginBlocker({ ...CLOSED, networkAllowed: false, httpRefused: true }), /Réseau non autorisé/)
  assert.match(loginBlocker({ ...CLOSED, httpRefused: true }), /HTTPS/)
  assert.equal(loginBlocker(CLOSED), null)
})

const client = t => clientBundle(t, 'p2-app', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import App from './src/App.jsx'",
  'export function app({ seed = {}, path = "/" } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: path }, h(AdminProvider, null, h(App)))))',
  '}',
])

test('App without anonymous read or session: login screen (title, password), neither menu nor view, SPA like the wall display; reason shown instead of the form if login is impossible from here', async t => {
  const c = await client(t)
  if (!c) return
  for (const path of ['/', '/reseau', '/mural']) {
    const html = c.app({ seed: { session: CLOSED, config: { title: 'Banc factice' } }, path })
    assert.match(html, /<h1[^>]*>Banc factice<\/h1>/, path)
    assert.match(html, /Connexion requise pour consulter ce tableau de bord/, path)
    assert.match(html, /<input type="password"[^>]*aria-label="Mot de passe"/, path)
    assert.doesNotMatch(html, /<nav|Cockpit/, path)
  }
  const http = c.app({ seed: { session: { ...CLOSED, httpRefused: true }, config: { title: 'Banc factice' } } })
  assert.match(http, /role="alert"[^>]*>Connexion refusée en HTTP/)
  assert.doesNotMatch(http, /type="password"/)
  // session not read yet: minimal loading state, neither login nor application
  const pending = c.app({ seed: { config: { title: 'Banc factice' } } })
  assert.match(pending, /<div aria-busy="true"[^>]*>Chargement…<\/div>/)
  assert.doesNotMatch(pending, /Connexion requise|<nav/)
})

test('App with anonymous read or a session: no login screen (as before safe defaults)', async t => {
  const c = await client(t)
  if (!c) return
  for (const session of [{ ...CLOSED, anonymousRead: true }, { ...CLOSED, admin: true }]) {
    for (const path of ['/', '/mural']) {
      const html = c.app({ seed: { session, config: { title: 'Banc factice' } }, path })
      assert.doesNotMatch(html, /Connexion requise pour consulter/, `${path} ${JSON.stringify(session)}`)
      // the application itself: the shell and the cockpit on "/", the wall display view (loaded on demand) on /mural
      if (path === '/') assert.ok(html.length > 5000, `shell rendered (${html.length} characters)`)
      else assert.match(html, /Chargement de la vue/)
    }
  }
})

test('bounded wait for /api/session: beyond SESSION_WAIT_MS (short), the application is shown as on failure', () => {
  assert.ok(SESSION_WAIT_MS > 0 && SESSION_WAIT_MS <= 5000, String(SESSION_WAIT_MS))
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/src/App.jsx'), 'utf8')
  assert.match(app, /setTimeout\(\(\) => setSessionLate\(true\), SESSION_WAIT_MS\)/)
  assert.match(app, /accessState\(session, \{ error: sessionError \|\| sessionLate \}\)/)
  assert.equal(accessState(undefined, { error: true }), 'open')
})
