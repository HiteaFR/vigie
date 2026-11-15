// Shared Pi-hole session (lib/pihole.js) and the widget that uses it: a single
// login for concurrent calls, a single reconnection on 401, no leak of the
// password or the URL in errors, closed on shutdown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPihole, createPiholes } from '../lib/pihole.js'
import { createWidgets } from '../lib/widgets.js'

const BASE = 'http://192.0.2.53'
const PASSWORD = 'mot-de-passe-de-test'

// fake FTL: numbered, expirable sessions, request log
function fakeFtl({ refuse = false } = {}) {
  const calls = []
  const valid = new Set()
  let n = 0
  const fetch = async (url, opts = {}) => {
    const u = new URL(url)
    const method = opts.method || 'GET'
    const sid = opts.headers?.['X-FTL-SID'] ?? null
    calls.push({ method, path: u.pathname + u.search, sid })
    if (u.pathname === '/api/auth' && method === 'POST') {
      const ok = !refuse && JSON.parse(opts.body).password === PASSWORD
      if (!ok) return Response.json({ session: { valid: false, sid: null } }, { status: 401 })
      const s = `sid-${++n}`
      valid.add(s)
      return Response.json({ session: { valid: true, sid: s } })
    }
    if (u.pathname === '/api/auth' && method === 'DELETE') {
      valid.delete(sid)
      return new Response(null, { status: 204 })
    }
    if (!valid.has(sid)) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (u.pathname === '/api/stats/summary') return Response.json({ queries: { total: 1234, percent_blocked: 12.5 } })
    if (u.pathname === '/api/texte') return new Response('pas du json')
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  return { fetch, calls, valid, expireAll: () => valid.clear() }
}

test('pihole: a single login for concurrent calls', async () => {
  const ftl = fakeFtl()
  const ph = createPihole({ url: BASE, password: PASSWORD, fetch: ftl.fetch })
  const [a, b] = await Promise.all([ph.get('/api/stats/summary'), ph.get('/api/stats/summary')])
  assert.equal(a.queries.total, 1234)
  assert.deepEqual(a, b)
  assert.equal(ftl.calls.filter(c => c.method === 'POST').length, 1)
  assert.equal(ph.open, true)
  assert.equal(await ph.get('/api/texte'), 'pas du json')
})

test('pihole: expired session → one reconnection, then an error without URL or secret', async () => {
  const ftl = fakeFtl()
  const ph = createPihole({ url: BASE, password: PASSWORD, fetch: ftl.fetch })
  await ph.get('/api/stats/summary')
  ftl.expireAll()
  assert.equal((await ph.get('/api/stats/summary')).queries.total, 1234)
  assert.equal(ftl.calls.filter(c => c.method === 'POST').length, 2)

  // 404: no retry, short message without host or parameters
  await assert.rejects(ph.get('/api/inconnu?x=1'), e => {
    assert.equal(e.message, '/api/inconnu → HTTP 404')
    return true
  })

  const refused = createPihole({ url: BASE, password: 'faux', fetch: fakeFtl().fetch })
  await assert.rejects(refused.get('/api/stats/summary'), e => {
    assert.equal(e.message, 'authentification Pi-hole refusée (401)')
    assert.ok(!e.message.includes('faux') && !e.message.includes('192.0.2'))
    return true
  })
})

test('pihole: the login does not use the dispatcher without TLS verification', async () => {
  const seen = []
  const fetch = async (url, opts = {}) => {
    seen.push([opts.method || 'GET', 'dispatcher' in opts])
    return opts.method === 'POST' ? Response.json({ session: { sid: 's' } }) : Response.json({})
  }
  const ph = createPihole({ url: BASE, password: PASSWORD, fetch })
  await ph.get('/api/info/version')
  assert.deepEqual(seen, [['POST', false], ['GET', true]])
})

test('pihole: shared registry, missing secret, sessions closed', async () => {
  const ftl = fakeFtl()
  const piholes = createPiholes({ env: { PH_PW: PASSWORD }, fetch: ftl.fetch })
  const a = piholes.get(`${BASE}/admin`, 'PH_PW')
  assert.equal(piholes.get(BASE, 'PH_PW'), a) // same origin, same secret → same session
  await a.get('/api/stats/summary')
  await piholes.stop()
  assert.equal(a.open, false)
  assert.equal(ftl.valid.size, 0)
  const del = ftl.calls.find(c => c.method === 'DELETE')
  assert.equal(del.sid, 'sid-1')
  await piholes.stop() // idempotent: no further request
  assert.equal(ftl.calls.filter(c => c.method === 'DELETE').length, 1)

  const missing = createPiholes({ env: {}, fetch: ftl.fetch }).get(BASE, 'PH_ABSENT')
  await assert.rejects(missing.get('/api/stats/summary'), /secret PH_ABSENT absent/)
})

test('Pi-hole widget: goes through the shared session, behavior unchanged', async () => {
  const ftl = fakeFtl()
  const env = { PH_PW: PASSWORD }
  const piholes = createPiholes({ env, fetch: ftl.fetch })
  const cfg = {
    services: [{
      id: 'pihole', name: 'Pi-hole',
      widget: {
        url: BASE, auth: { type: 'pihole', secretEnv: 'PH_PW' },
        fields: [
          { label: 'Requêtes', path: '/api/stats/summary', json: 'queries.total', format: 'int' },
          { label: 'Bloquées', path: '/api/stats/summary', json: 'queries.percent_blocked', format: 'percent' },
        ],
      },
    }],
  }
  const widgets = createWidgets(cfg, env, { piholes })
  await widgets.runAll()
  const r = widgets.get('pihole')
  assert.equal(r.error, null)
  assert.deepEqual(r.fields.map(f => f.label), ['Requêtes', 'Bloquées'])
  assert.match(r.fields[0].value, /^1\s?234$/)
  assert.equal(r.fields[1].value, '12,5 %')
  // a given path is called only once, and the network module would reuse the session
  assert.equal(ftl.calls.filter(c => c.path === '/api/stats/summary').length, 1)
  await piholes.get(BASE, 'PH_PW').get('/api/stats/summary')
  assert.equal(ftl.calls.filter(c => c.method === 'POST').length, 1)

  await widgets.stop()
  assert.equal(ftl.valid.size, 0)

  // FTL refusing the login: error shown by the widget, previous values kept
  const down = createWidgets(cfg, env, { piholes: createPiholes({ env, fetch: fakeFtl({ refuse: true }).fetch }) })
  await down.runAll()
  assert.equal(down.get('pihole').error, 'authentification Pi-hole refusée (401)')
})
