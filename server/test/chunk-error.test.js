// View not found after a deployment. Pure decision (lib/chunkError.js),
// real rendering of the panel (ui/ViewBoundary.jsx), static wiring in App.jsx.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isChunkError, chunkDecision, RELOAD_KEY } from '../../client/src/lib/chunkError.js'
import { clientBundle } from './client-render.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalogue loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = f => fs.readFileSync(path.join(ROOT, 'client/src', f), 'utf8')
const store = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }
}
const B1 = 'http://dash.test/assets/index-AAAA.js'
const B2 = 'http://dash.test/assets/index-BBBB.js'
const CHUNK = new TypeError('Failed to fetch dynamically imported module: http://dash.test/assets/Ci-ancien.js')

test('isChunkError: chunk loading failures (Chrome, Firefox, Safari, Vite); nothing else', () => {
  for (const e of [CHUNK, new TypeError('error loading dynamically imported module: http://x/assets/A.js'), new TypeError('Importing a module script failed.'),
    Object.assign(new Error('Loading chunk 12 failed.'), { name: 'ChunkLoadError' }), new Error('Unable to preload CSS for /assets/Ci.css'), new Error('Loading CSS chunk 3 failed')]) {
    assert.equal(isChunkError(e), true, e.message)
  }
  for (const e of [new TypeError("Cannot read properties of undefined (reading 'length')"), new Error('HTTP 503'), null, undefined, new Error('')]) {
    assert.equal(isChunkError(e), false, String(e?.message))
  }
})

test('chunkDecision: ONE reload per build; the same build afterwards → message; a new build → a reload again', () => {
  const s = store()
  assert.equal(chunkDecision(CHUNK, { storage: s, build: B1 }), 'reload')
  assert.equal(s.m.get(RELOAD_KEY), B1)
  for (let i = 0; i < 3; i++) assert.equal(chunkDecision(CHUNK, { storage: s, build: B1 }), 'message')
  assert.equal(chunkDecision(CHUNK, { storage: s, build: B2 }), 'reload')
  assert.equal(s.m.get(RELOAD_KEY), B2)
  assert.equal(chunkDecision(CHUNK, { storage: s, build: B2 }), 'message')
})

test('chunkDecision: storage unavailable (missing, read or write that throws) → message, NO automatic reload', () => {
  assert.equal(chunkDecision(CHUNK, { storage: null, build: B1 }), 'message')
  assert.equal(chunkDecision(CHUNK, { storage: { getItem() { throw new Error('SecurityError') }, setItem() {} }, build: B1 }), 'message')
  assert.equal(chunkDecision(CHUNK, { storage: { getItem: () => null, setItem() { throw new Error('QuotaExceededError') } }, build: B1 }), 'message')
})

test('chunkDecision: any other render error → panel, without reload or write', () => {
  const s = store()
  assert.equal(chunkDecision(new TypeError("Cannot read properties of undefined (reading 'x')"), { storage: s, build: B1 }), 'error')
  assert.equal(s.m.size, 0)
})

test('real rendering of the panel: new version (chunk) or view error; role alert, Reload button, escaped text', async t => {
  const c = await clientBundle(t, 'view-boundary', [
    "import { ViewErrorPanel } from './src/ui/ViewBoundary.jsx'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement } from 'react'",
    'export const panel = p => renderToStaticMarkup(createElement(ViewErrorPanel, p))',
  ])
  if (!c) return
  const chunk = c.panel({ kind: 'message' })
  assert.match(chunk, /^<div role="alert"/)
  assert.match(chunk, /Nouvelle version du dashboard disponible/)
  assert.match(chunk, /<button type="button"[^>]*>.*Recharger<\/button>/)
  const other = c.panel({ kind: 'error', message: 'boum <img src=x>' })
  assert.match(other, /Cette vue a rencontré une erreur/)
  assert.match(other, /boum &lt;img src=x&gt;/)
  assert.doesNotMatch(other, /Nouvelle version/)
})

test('static: the boundary wraps the Suspense of the views and of the wall display, resets on route change, reloads only on "reload"', () => {
  const app = SRC('App.jsx')
  assert.match(app, /^import ViewBoundary from '\.\/ui\/ViewBoundary\.jsx'$/m)
  assert.match(app, /<ViewBoundary resetKey=\{location\}>\n\s+<Suspense fallback=\{<ViewFallback \/>\}>\n\s+<Switch>/)
  assert.match(app, /<ViewBoundary resetKey=\{location\}><Suspense fallback=\{<ViewFallback \/>\}><Mural config=\{config\.data\} \/><\/Suspense><\/ViewBoundary>/)
  const vb = SRC('ui/ViewBoundary.jsx')
  assert.match(vb, /^const BUILD = import\.meta\.url$/m)
  assert.match(vb, /const kind = chunkDecision\(error, \{ storage: sessionStore\(\), build: BUILD \}\)\n\s+if \(kind === 'reload'\) \{\n\s+window\.location\.reload\(\)/)
  assert.equal((vb.match(/location\.reload\(\)/g) || []).length, 2) // automatic reload (reload) and button
  assert.match(vb, /if \(prev\.resetKey !== this\.props\.resetKey && this\.state\.error\) this\.setState\(\{ error: null, kind: null \}\)/)
  assert.match(vb, /try \{\n\s+return window\.sessionStorage\n\s+\} catch \{\n\s+return null/)
})
