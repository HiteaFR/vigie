// HTTP errors in JSON
// without stack, async routes wrapped, admin hash checked at startup, unhandled rejections
// logged without stopping the process. Express servers on 127.0.0.1:0, no network access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { errorHandler, wrap } from '../lib/http-errors.js'
import { createAuth, createAudit } from '../lib/auth.js'
import { tmpStore } from './tmpdir.js'
import { quiet } from './network-fixture.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')

// same composition as server/index.js: JSON ≤ 8 KB on /api, routes, final handler
async function server(routes, log = quiet) {
  const app = express()
  app.use('/api', express.json({ limit: '8kb' }))
  routes(app)
  app.use(errorHandler(log))
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

test('malformed JSON → 400 JSON invalid-request error, without stack or path', async () => {
  const s = await server(app => app.post('/api/login', wrap(async (req, res) => res.json({ ok: true }))))
  try {
    const r = await post(s.base, '/api/login', '{')
    assert.equal(r.status, 400)
    assert.match(r.headers.get('content-type'), /^application\/json/)
    const text = await r.text()
    assert.deepEqual(JSON.parse(text), { error: 'requête invalide' })
    assert.doesNotMatch(text, /node_modules|\bat\b|\/opt\/|SyntaxError/)
  } finally {
    s.close()
  }
})

test('body of 9 KB → 413 JSON body-too-large error; type 415 kept', async () => {
  const s = await server(app => {
    app.post('/api/x', (req, res) => res.json({ ok: true }))
    app.post('/api/type', (req, res, next) => next(Object.assign(new Error('type'), { status: 415 })))
  })
  try {
    const r = await post(s.base, '/api/x', JSON.stringify({ a: 'x'.repeat(9000) }))
    assert.equal(r.status, 413)
    assert.deepEqual(await r.json(), { error: 'corps trop gros' })
    const t = await post(s.base, '/api/type', '{}')
    assert.equal(t.status, 415)
    assert.deepEqual(await t.json(), { error: 'type de contenu non pris en charge' })
  } finally {
    s.close()
  }
})

test('an error carrying a status outside the list (404) → 500 internal error', async () => {
  const s = await server(app => app.get('/api/x', wrap(async () => { throw Object.assign(new Error('x'), { status: 404 }) })))
  try {
    const r = await fetch(`${s.base}/api/x`)
    assert.equal(r.status, 500)
    assert.deepEqual(await r.json(), { error: 'erreur interne' })
  } finally {
    s.close()
  }
})

test('async route that rejects → 500 JSON internal error, logged; the process lives on (next request → 200)', async () => {
  const logged = []
  const s = await server(app => {
    app.get('/api/boum', wrap(async () => { throw new Error('secret interne /opt/x') }))
    app.get('/api/ok', (req, res) => res.json({ ok: true }))
  }, { error: m => logged.push(m) })
  try {
    const r = await fetch(`${s.base}/api/boum?jeton=abc`)
    assert.equal(r.status, 500)
    const text = await r.text()
    assert.deepEqual(JSON.parse(text), { error: 'erreur interne' })
    assert.doesNotMatch(text, /secret|\/opt\//)
    assert.equal((await fetch(`${s.base}/api/ok`)).status, 200)
    // log: method, path WITHOUT query, stack
    assert.equal(logged.length, 1)
    assert.match(logged[0], /^internal error: GET \/api\/boum\n/)
    assert.doesNotMatch(logged[0], /jeton/)
    assert.match(logged[0], /secret interne/)
  } finally {
    s.close()
  }
})

test('ADMIN_PASSWORD_HASH with invalid parameters: createAuth starts, configured false, login → 503 without exception', async () => {
  const store = tmpStore('dash-http-errors-')
  const logged = []
  const bad = `scrypt$1$1$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`
  const auth = createAuth({ store, audit: createAudit(store), env: { ADMIN_PASSWORD_HASH: bad, ADMIN_ALLOWED_CIDRS: '127.0.0.0/8' }, log: { error: m => logged.push(m) } })
  const req = { socket: { remoteAddress: '127.0.0.1' }, get: () => null }
  assert.equal(auth.configured, false)
  assert.equal(auth.status(req).configured, false)
  const r = await auth.login(req, { setHeader() {} }, 'nimporte')
  assert.deepEqual([r.ok, r.status, r.error], [false, 503, 'connexion admin désactivée : hachage invalide'])
  assert.match(logged.join('\n'), /connexion admin désactivée : hachage invalide \(ERR_CRYPTO_INVALID_SCRYPT_PARAMS\)/)
  // invalid form: same deactivation
  const auth2 = createAuth({ store, audit: createAudit(store), env: { ADMIN_PASSWORD_HASH: 'scrypt$abc' }, log: quiet })
  assert.equal(auth2.configured, false)
})

test('static: each async route of server/index.js is wrapped by wrap(', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  const routes = src.split('\n').filter(l => /app\.(get|post|put|patch|delete)\(/.test(l) && /\basync\b/.test(l))
  assert.ok(routes.length >= 5, `${routes.length} async routes`)
  // routes of the gitea plugin, wrapped as well
  assert.match(fs.readFileSync(path.join(ROOT, 'server/plugins/gitea/index.js'), 'utf8'), /const read = fn => wrap\(async \(req, res\) => \{/)
  for (const l of routes) assert.match(l, /wrap\(async /, l.trim())
  assert.match(src, /app\.use\(errorHandler\(console\)\)/)
  // the module routes (including the network) are mounted by the host, wrap passed on
  assert.match(src, /host\.mount\(app, \{[^}]*\bwrap\b/)
  assert.match(fs.readFileSync(path.join(ROOT, 'server/lib/plugins/core.js'), 'utf8'), /mountNetwork\(router, \{ network, \.\.\.h \}\)/)
  // the final handler comes after the static service and before listen
  const i = src.indexOf("app.get('*'"), j = src.indexOf('app.use(errorHandler'), k = src.indexOf('app.listen(')
  assert.ok(i > 0 && i < j && j < k)
})

test('static: the systemd unit (public example; the prod one is in the infra repository) sets NODE_ENV=production', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'deploy/vigie.service.example'), 'utf8')
  assert.match(unit, /^Environment=NODE_ENV=production$/m)
})

test('child process: an unhandled rejection is logged, the process is still alive 200 ms later', () => {
  const mod = path.join(ROOT, 'server/lib/http-errors.js')
  const code = `import(${JSON.stringify(mod)}).then(m => {
    m.installProcessHandlers({ error: x => console.error(String(x).split('\\n')[0]) })
    Promise.reject(new Error('rejet de test'))
    setTimeout(() => { console.log('vivant'); process.exit(0) }, 200)
  })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /vivant/)
  assert.match(r.stderr, /unhandled rejection: Error: rejet de test/)
  // and server/index.js installs them
  assert.match(fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8'), /^installProcessHandlers\(console\)$/m)
})
