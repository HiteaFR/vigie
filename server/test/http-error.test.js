// Error messages of the client reads. httpError (client/src/
// lib/httpError.js) reads { error } in the JSON body, in the format of post() (admin.jsx); falls back
// to "HTTP <code>"; status kept. Real Node Responses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpError } from '../../client/src/lib/httpError.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const res = (body, status, type = 'application/json') => new Response(body, { status, headers: { 'content-type': type } })

test('JSON body { error } → its message, status kept', async () => {
  const e = await httpError(res(JSON.stringify({ error: 'hôte non autorisé' }), 421))
  assert.equal(e.message, 'hôte non autorisé')
  assert.equal(e.status, 421)
  assert.ok(e instanceof Error)
})

test('non-JSON body (HTML page of a proxy), JSON without error, empty or non-text error → "HTTP <code>"', async () => {
  assert.equal((await httpError(res('<html><body>502 Bad Gateway</body></html>', 502, 'text/html'))).message, 'HTTP 502')
  assert.equal((await httpError(res(JSON.stringify({ ok: false }), 500))).message, 'HTTP 500')
  assert.equal((await httpError(res(JSON.stringify({ error: '' }), 503))).message, 'HTTP 503')
  assert.equal((await httpError(res(JSON.stringify({ error: { code: 1 } }), 500))).message, 'HTTP 500')
  assert.equal((await httpError(res('null', 500))).message, 'HTTP 500')
})

test('empty body → "HTTP <code>"', async () => {
  const e = await httpError(new Response(null, { status: 404 }))
  assert.deepEqual([e.message, e.status], ['HTTP 404', 404])
  assert.equal((await httpError(res('', 401))).message, 'HTTP 401')
})

test('static: j() (api.js) throws httpError(r) on a non-ok response; same format as post() (admin.jsx)', () => {
  const api = fs.readFileSync(path.join(ROOT, 'client/src/api.js'), 'utf8')
  assert.match(api, /^import \{ httpError \} from '\.\/lib\/httpError\.js'$/m)
  assert.match(api, /if \(!r\.ok\) throw await httpError\(r\)/)
  assert.doesNotMatch(api, /→ \$\{r\.status\}/)
  const admin = fs.readFileSync(path.join(ROOT, 'client/src/admin.jsx'), 'utf8')
  assert.match(admin, /new Error\(j\.error \|\| `HTTP \$\{r\.status\}`\), \{ status: r\.status \}/)
})
