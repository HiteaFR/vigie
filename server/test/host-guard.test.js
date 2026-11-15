// Checked Host header (DNS
// rebinding). node:http requests (fetch ignores a supplied Host header), server on 127.0.0.1:0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { hostGuard, allowedHostsOf, sameOrigin, createAuth, createAudit, hashPassword } from '../lib/auth.js'
import { parseConfig } from '../lib/config.js'
import { tmpStore } from './tmpdir.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
// config.example.json of the repository (plus the prod config.json): same form, IP and name allowed
const delivered = () => parseConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/fixtures/config.reference.json'), 'utf8')))

async function server(cfg) {
  const app = express()
  app.use(hostGuard(allowedHostsOf(cfg)))
  app.get('/api/agents', (req, res) => res.json({ hosts: ['donnée sensible'] }))
  app.get('/api/healthz', (req, res) => res.json({ ok: true }))
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const port = srv.address().port
  const get = (p, host) => new Promise((res, rej) => {
    // host null: NO Host header (setHost false), otherwise node would add one
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', setHost: host != null, headers: host == null ? {} : { host } }, x => {
      let d = ''
      x.on('data', c => { d += c })
      x.on('end', () => res({ status: x.statusCode, body: d }))
    })
    r.on('error', rej)
    r.end()
  })
  return { get, close: () => srv.close() }
}

test('Host evil.example → 421, body without data', async () => {
  const s = await server(delivered().config)
  try {
    const r = await s.get('/api/agents', 'evil.example')
    assert.equal(r.status, 421)
    // the received name and the steps to follow, nothing about the instance
    assert.deepEqual(JSON.parse(r.body), { error: 'hôte non autorisé', host: 'evil.example', hint: 'ajouter ce nom à allowedHosts dans la config, puis redémarrer' })
    assert.doesNotMatch(r.body, /sensible/)
  } finally {
    s.close()
  }
})

test('example config: vigie.example.net, 192.0.2.148, localhost, 127.0.0.1, [::1]:8088 → 200; dev.local (removed) → 421', async () => {
  const { config, errors } = delivered()
  assert.ok(!errors, errors?.join('\n'))
  const s = await server(config)
  try {
    for (const h of ['vigie.example.net', '192.0.2.148', 'localhost', '127.0.0.1', '[::1]:8088']) assert.equal((await s.get('/api/agents', h)).status, 200, h)
    for (const h of ['dev.local', 'dev.local:80']) assert.equal((await s.get('/api/agents', h)).status, 421, h)
  } finally {
    s.close()
  }
})

test('port and case: vigie.example.net:443, VIGIE.example.net and 192.0.2.148:80 → 200', async () => {
  const s = await server(delivered().config)
  try {
    for (const h of ['vigie.example.net:443', 'VIGIE.example.net', 'Vigie.Example.net:8080', '192.0.2.148:80']) assert.equal((await s.get('/api/agents', h)).status, 200, h)
  } finally {
    s.close()
  }
})

test('health check: Host localhost (curl of deploy.yml) and 192.0.2.148:80 (probe by IP) → 200; missing Host → 421', async () => {
  const s = await server(delivered().config)
  try {
    assert.equal((await s.get('/api/healthz', 'localhost')).status, 200)
    assert.equal((await s.get('/api/healthz', '192.0.2.148:80')).status, 200)
    // missing Host: node already refuses an HTTP/1.1 request without Host (400, before Express);
    // the middleware itself answers 421 (HTTP/1.0, or another server) — no data in either case
    const none = await s.get('/api/agents', null)
    assert.ok([400, 421].includes(none.status), String(none.status))
    assert.doesNotMatch(none.body, /sensible/)
    let code = null
    let body = null
    const res = { status: c => { code = c; return res }, set: () => res, json: b => { body = b } }
    hostGuard(allowedHostsOf({}))({ get: () => undefined, path: '/api/agents' }, res, () => { code = 'next' })
    assert.deepEqual([code, body], [421, { error: 'hôte non autorisé', host: '(aucun)', hint: 'ajouter ce nom à allowedHosts dans la config, puis redémarrer' }])
  } finally {
    s.close()
  }
})

test('allowedHosts: an added name is allowed; without the key → 421; dashboardUrl name allowed', async () => {
  const base = { allowedHosts: [], alerts: {} }
  const a = await server({ ...base, allowedHosts: ['dash.tailnet.example'] })
  const b = await server(base)
  const c = await server({ ...base, alerts: { dashboardUrl: 'http://tableau.example:8080/' } })
  try {
    assert.equal((await a.get('/api/agents', 'dash.tailnet.example')).status, 200)
    assert.equal((await b.get('/api/agents', 'dash.tailnet.example')).status, 421)
    assert.equal((await c.get('/api/agents', 'tableau.example')).status, 200)
  } finally {
    a.close()
    b.close()
    c.close()
  }
})

test('sameOrigin: Host and Origin at evil.example → refused; allowed origin → accepted', () => {
  const req = (host, origin) => ({ get: k => ({ host, origin })[k] ?? null })
  const allowed = allowedHostsOf(delivered().config)
  assert.equal(sameOrigin(req('evil.example', 'http://evil.example'), allowed), false)
  assert.equal(sameOrigin(req('evil.example', 'http://evil.example')), false) // default list: loopback
  assert.equal(sameOrigin(req('vigie.example.net', 'https://vigie.example.net'), allowed), true)
  assert.equal(sameOrigin(req('192.0.2.148', 'http://192.0.2.148'), allowed), true)
  assert.equal(sameOrigin(req('192.0.2.148', 'http://evil.example'), allowed), false)
  assert.equal(sameOrigin(req('dev.local', 'http://dev.local'), allowed), false) // no longer allowed
})

test('schema: invalid allowedHosts refused; missing key → []; config.example.json of the repository valid', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/fixtures/config.reference.json'), 'utf8'))
  // IP and allowed name of the example; dev.local is not among them
  assert.deepEqual(raw.allowedHosts, ['192.0.2.148', 'vigie.example.net'])
  for (const bad of [['bad host!'], ['dev.local:80'], ['http://dev.local'], ['']]) {
    assert.ok(parseConfig({ ...raw, allowedHosts: bad }).errors, JSON.stringify(bad))
  }
  const { allowedHosts, ...without } = raw
  assert.ok(allowedHosts)
  assert.deepEqual(parseConfig(without).config.allowedHosts, [])
  assert.ok(!delivered().errors)
})

// dashboardUrl config: the allowed hosts of the example config. allowedHostsOf adds
// the name of alerts.dashboardUrl; this name is ALSO in allowedHosts, so no host depends on
// dashboardUrl alone (changing it neither removes nor adds any allowed host)
test('example config: exact allowed hosts; the dashboardUrl name is already in allowedHosts', () => {
  const { config, errors } = delivered()
  assert.ok(!errors, errors?.join('\n'))
  assert.equal(config.alerts.dashboardUrl, 'https://vigie.example.net')
  const want = ['127.0.0.1', '192.0.2.148', '[::1]', 'localhost', 'vigie.example.net']
  assert.deepEqual([...allowedHostsOf(config)].sort(), want)
  assert.ok(config.allowedHosts.includes(new URL(config.alerts.dashboardUrl).hostname))
  const { dashboardUrl, ...alerts } = config.alerts
  assert.ok(dashboardUrl)
  assert.deepEqual([...allowedHostsOf({ ...config, alerts })].sort(), want)
})

// wiring of the Host check in server/index.js
test('static: hostGuard is the first app.use, before express.json; login and createAuth receive the list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  assert.match(src, /^const hosts = allowedHostsOf\(cfg\)$/m)
  const uses = [...src.matchAll(/^app\.use\((.*)$/gm)].map(m => m[1])
  assert.equal(uses[0], 'hostGuard(hosts))', `first app.use: ${uses[0]}`)
  assert.ok(src.indexOf('app.use(hostGuard(hosts))') < src.indexOf('express.json('), 'hostGuard before express.json')
  const login = src.slice(src.indexOf("app.post('/api/login'"), src.indexOf("app.post('/api/logout'"))
  assert.ok(login.length > 0, 'route /api/login found')
  assert.match(login, /sameOrigin\(req, hosts\)/)
  assert.match(src, /createAuth\(\{[^}]*\ballowedHosts: hosts\b[^}]*\}\)/)
})

test('behavior: example config, Host 192.0.2.148, Origin http://192.0.2.148 and valid session → next(), no refused-origin error', async () => {
  const { config } = delivered()
  const store = tmpStore('dash-host-guard-')
  const audit = createAudit(store, { tickMs: 0 })
  const hash = await hashPassword('mot de passe solide')
  // httpLogin: login from the LAN over HTTP (Host and Origin are the subject)
  const auth = createAuth({ store, audit, allowedHosts: allowedHostsOf(config), httpLogin: true, env: { ADMIN_PASSWORD_HASH: hash, ADMIN_ALLOWED_CIDRS: '192.0.2.0/24' }, log: { error() {} } })
  const headers = { host: '192.0.2.148', origin: 'http://192.0.2.148' }
  const base = { socket: { remoteAddress: '192.0.2.50' }, secure: false }
  let cookie = null
  const r = await auth.login({ ...base, get: k => headers[k] ?? null }, { setHeader: (k, v) => { cookie = String(v).split(';')[0] } }, 'mot de passe solide')
  assert.equal(r.ok, true)
  assert.ok(cookie)
  const req = { ...base, method: 'POST', path: '/api/network/devices/edit', get: k => ({ ...headers, cookie })[k] ?? null, is: t => t === 'application/json' }
  let refused = null
  let passed = false
  auth.require(req, { status: s => ({ json: b => { refused = [s, b.error] } }) }, () => { passed = true })
  assert.equal(refused, null, `refused: ${refused}`)
  assert.equal(passed, true)
  assert.equal(req.actor, 'admin (192.0.2.50)')
})
