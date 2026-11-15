// TLS verified for calls that carry a secret. Local HTTPS servers (127.0.0.1 and ::1, port 0)
// with the TEST certificates generated at startup (tls-fixtures.js, fixtures/tls/gen.sh); each
// fake server counts the requests received and the Authorization headers. No network access
// outside the loopback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fetch as uFetch } from 'undici'
import { agentFor, tlsCategory, strictAgent, permissiveAgent, pinnedAgent, isPrivateIpv4Literal } from '../lib/tls.js'
import { createWidgets, widgetAgent } from '../lib/widgets.js'
import { runCheck, checkAgent } from '../lib/checks.js'
import { createSources } from '../lib/sources.js'
import { parseConfig } from '../lib/config.js'
import { tmpDir } from './tmpdir.js'
import { tlsFixtures } from './tls-fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(here, '..')
const ROOT = path.join(SERVER, '..')
const FIX = tlsFixtures()
const read = f => fs.readFileSync(path.join(FIX, f))
const caPem = f => fs.readFileSync(path.join(FIX, 'pki', f), 'utf8')

// test HTTPS server: 127.0.0.1, and ::1 on the same port if possible (localhost → ::1 first)
async function tlsServer(leaf, handler = (req, res) => res.end(JSON.stringify({ data: [] }))) {
  const stats = { requests: 0, auth: 0, tokens: [] }
  const onReq = (req, res) => {
    stats.requests++
    if (req.headers.authorization) {
      stats.auth++
      stats.tokens.push(req.headers.authorization)
    }
    handler(req, res)
  }
  const opts = { key: read(`${leaf}.key`), cert: read(`${leaf}.pem`) }
  const servers = [https.createServer(opts, onReq)]
  for (const s of servers) s.on('tlsClientError', () => {})
  await new Promise((resolve, reject) => servers[0].listen(0, '127.0.0.1', resolve).once('error', reject))
  const port = servers[0].address().port
  const v6 = https.createServer(opts, onReq)
  v6.on('tlsClientError', () => {})
  await new Promise(resolve => v6.listen(port, '::1', () => { servers.push(v6); resolve() }).once('error', () => resolve()))
  return { port, stats, close: () => Promise.all(servers.map(s => new Promise(r => s.close(r)))) }
}

test('Tailscale: bearer widget to a NAME (localhost), self-signed certificate (B) → TLS failure, 0 requests, 0 Authorization', async () => {
  const srv = await tlsServer('leaf-b', (req, res) => res.end(JSON.stringify({ a: 1 })))
  try {
    const url = `https://localhost:${srv.port}`
    const cfg = { services: [{ id: 'tailscale', widget: { url, auth: { type: 'bearer', secretEnv: 'TS_KEY' }, fields: [{ label: 'x', path: '/api/x', json: 'a' }] } }] }
    const widgets = createWidgets(cfg, { TS_KEY: 'jeton-tailnet' }, { piholes: { get() {}, stop: async () => {} } })
    assert.equal(widgetAgent(cfg.services[0].widget), strictAgent)
    await widgets.runAll()
    const r = widgets.get('tailscale')
    assert.ok(r.error, 'error expected')
    assert.match(r.error, /CERT|SELF_SIGNED|UNABLE_TO/)
    assert.equal(srv.stats.requests, 0)
    assert.equal(srv.stats.auth, 0)
    // control: the server is reachable (permissive agent, without token) → the request does arrive
    const t = await uFetch(`${url}/api/x`, { dispatcher: permissiveAgent })
    await t.body?.cancel()
    assert.deepEqual([srv.stats.requests, srv.stats.auth], [1, 0])
  } finally {
    await srv.close()
  }
})

test('agentFor: full table (strict, permissive, pinned); RFC 1918 and 127/8 as literal IP only', () => {
  const pem = caPem('ca-a.pem')
  const strict = ['https://example.com', 'https://dev.local', 'https://8.8.8.8', 'https://172.32.0.1', 'https://192.169.0.1',
    'https://172.15.255.255', 'https://11.0.0.1', 'https://[fd00::1]', 'https://[::1]',
    // an IP of a public network.subnets is not "private"
    'https://203.0.113.5', 'https://198.51.100.7']
  for (const u of strict) {
    assert.equal(agentFor(u), strictAgent, `${u} without a secret`)
    assert.equal(agentFor(u, { secret: true }), strictAgent, `${u} with a secret`)
  }
  for (const u of ['https://192.168.50.5', 'https://10.1.2.3', 'https://172.24.0.1', 'https://172.16.0.1', 'https://172.31.255.254', 'https://127.0.0.1', 'https://127.8.9.10:8443/x']) {
    assert.equal(agentFor(u), permissiveAgent, `${u} without a secret → permissive`)
    assert.equal(tlsCategory(u), 'private')
    assert.equal(agentFor(u, { secret: true }), strictAgent, `${u} with a secret → strict`)
  }
  assert.equal(agentFor('https://192.168.50.155:8006', { secret: true, ca: pem }), pinnedAgent(pem))
  assert.equal(tlsCategory('https://192.168.50.155:8006', { secret: true, ca: pem }), 'pinned')
  assert.notEqual(pinnedAgent(pem), strictAgent)
  assert.notEqual(pinnedAgent(pem), permissiveAgent)
  // checks exception: by name, with tls 'insecure' and without secret
  assert.equal(agentFor('https://app.example.test', { tls: 'insecure' }), permissiveAgent)
  assert.equal(tlsCategory('https://app.example.test', { tls: 'insecure' }), 'exception')
  assert.equal(agentFor('https://app.example.test'), strictAgent)
  assert.equal(agentFor('https://app.example.test', { tls: 'insecure', secret: true }), strictAgent)
  assert.equal(isPrivateIpv4Literal('192.168.50.5.example.com'), false)
  assert.equal(isPrivateIpv4Literal('localhost'), false)
})

// --- every https:// URL of a complete config ---
// TEST config (no longer the production config.json) that exercises each category: two pinned
// PVEs (CAs from tlsFixtures), probes on a literal private IPv4, strict names (probes, widget with
// secret, versions with and without secret), links (services[].url, bookmarks, notes, dashboardUrl)
const T3_RAW = {
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], gitea: { owner: 'o' },
  allowedHosts: ['vigie.example.net'],
  alerts: { dashboardUrl: 'https://vigie.example.net' },
  proxmox: [
    { id: 'prod', label: 'PVE prod', host: 'https://192.168.50.155:8006', env: 'PVE_PROD', ca: 'pki/ca-a.pem' },
    { id: 'dev', label: 'PVE dev', host: 'https://192.168.50.168:8006', env: 'PVE', ca: 'pki/ca-b.pem' },
  ],
  hosts: [{ id: 'h', name: 'h', kind: 'appliance', ip: '192.168.50.156', env: 'prod' }],
  services: [
    { id: 'p1', name: 'P1', group: 'g', host: 'h', checks: [{ type: 'http', url: 'https://192.168.50.156:8443/' }, { type: 'http', url: 'https://192.168.50.156:9443/health' }] },
    { id: 'p2', name: 'P2', group: 'g', host: 'h', checks: [{ type: 'http', url: 'https://192.168.50.157/' }, { type: 'http', url: 'https://10.0.0.5:8006/' }] },
    { id: 'site-a', name: 'Site A', group: 'g', env: 'prod', url: 'https://site-a.example.net', checks: [{ type: 'http', url: 'https://site-a.example.net/', expect: { status: 200 } }] },
    { id: 'site-b', name: 'Site B', group: 'g', env: 'prod', url: 'https://site-b.example.net', checks: [{ type: 'http', url: 'https://site-b.example.net/' }] },
    { id: 'saas', name: 'SaaS', group: 'g', env: 'prod', url: 'https://saas.example.net', widget: { url: 'https://api.saas.example.net', auth: { type: 'bearer', secretEnv: 'SAAS_KEY' }, fields: [{ label: 'N', path: '/v1/x', json: 'n' }] } },
    { id: 'media', name: 'Media', group: 'g', host: 'h', url: 'http://192.168.50.156:32400', version: { current: { from: 'http-json', url: 'https://media.example.net/identity', path: 'v', auth: { type: 'header', name: 'X-Token', secretEnv: 'MEDIA_TOKEN' } }, latest: { from: 'http-json', url: 'https://releases.example.net/latest.json', path: 'v', notes: 'https://releases.example.net/notes' } } },
  ],
  bookmarks: [{ group: 'Liens', items: [{ name: 'Doc', url: 'https://docs.example.net/' }] }],
}
function versionUrls(v) {
  if (!v) return []
  if (v.from === 'ha') return [{ url: v.url, secret: true, what: 'version ha' }]
  const comps = Array.isArray(v) ? v : [v]
  const out = []
  for (const c of comps) {
    if (c.current?.url) out.push({ url: c.current.url, secret: !!c.current.auth, what: 'version current' })
    if (c.latest?.url) out.push({ url: c.latest.url, secret: false, what: 'version latest' })
  }
  return out
}
test('complete config: each https:// URL classified in ONE category; all names strict (no tls exception); PVEs pinned; no permissive secret', () => {
  const raw = T3_RAW
  const { config, errors } = parseConfig(raw)
  assert.ok(!errors, errors?.join('\n'))
  const calls = [] // { url, cat, secret, what }
  const cat = (url, opts, agent) => {
    const c = tlsCategory(url, opts)
    // the agent actually used by the module matches the category
    const expect = c === 'strict' ? strictAgent : c === 'pinned' ? pinnedAgent(opts.ca) : permissiveAgent
    assert.equal(agent ?? agentFor(url, opts), expect, `${url}: module agent`)
    return c
  }
  for (const p of config.proxmox) {
    if (!p.host.startsWith('https://')) continue
    const pem = fs.readFileSync(path.join(FIX, p.ca), 'utf8')
    calls.push({ url: p.host, secret: true, what: 'proxmox', cat: cat(p.host, { secret: true, ca: pem }) })
  }
  for (const s of config.services) {
    for (const c of s.checks ?? []) {
      if (c.type === 'http' && c.url.startsWith('https://')) calls.push({ url: c.url, secret: false, what: 'check', tls: c.tls, cat: cat(c.url, { tls: c.tls }, checkAgent(c)) })
    }
    if (s.widget?.url.startsWith('https://')) calls.push({ url: s.widget.url, secret: !!s.widget.auth, what: 'widget', cat: cat(s.widget.url, { secret: !!s.widget.auth }, widgetAgent(s.widget)) })
    for (const v of versionUrls(s.version)) if (v.url.startsWith('https://')) calls.push({ ...v, cat: cat(v.url, { secret: v.secret }) })
  }
  const host = u => new URL(u).hostname
  const isName = u => !/^[\d.]+$/.test(host(u)) && !host(u).startsWith('[')
  // names: all strict; no tls exception in this config (mechanism tested elsewhere in this file)
  const named = calls.filter(c => isName(c.url))
  assert.deepEqual(named.filter(c => c.cat !== 'strict').map(c => c.url), [])
  assert.deepEqual(calls.filter(c => c.tls).map(c => c.url), [])
  for (const h of ['site-a.example.net', 'site-b.example.net', 'api.saas.example.net', 'media.example.net', 'releases.example.net']) {
    const found = named.filter(c => host(c.url) === h)
    assert.ok(found.length, `${h} present`)
    for (const c of found) assert.equal(c.cat, 'strict', c.url)
  }
  // both PVEs pinned; no call with a secret in permissive mode nor with tls insecure
  assert.deepEqual(calls.filter(c => c.what === 'proxmox').map(c => [c.url, c.cat]), [['https://192.168.50.155:8006', 'pinned'], ['https://192.168.50.168:8006', 'pinned']])
  for (const c of calls.filter(c => c.secret)) {
    assert.ok(c.cat === 'strict' || c.cat === 'pinned', `${c.url} (secret): ${c.cat}`)
    assert.equal(c.tls, undefined)
  }
  // checks on a literal private IPv4: permissive
  const priv = calls.filter(c => c.what === 'check' && !isName(c.url))
  assert.ok(priv.length >= 4)
  for (const c of priv) assert.equal(c.cat, 'private', c.url)
  // all https:// URLs of the config: called (classified above) or links shown in the
  // browser (services[].url, bookmarks, notes), classified too; no unknown path
  // alerts.dashboardUrl: link in Telegram messages (notify/format.js), never called by the server
  const LINKS = [/^\.services\[\d+\]\.url$/, /^\.bookmarks\[\d+\]\.items\[\d+\]\.url$/, /\.version(\[\d+\])?\.(latest\.)?notes$/, /^\.alerts\.dashboardUrl$/]
  const FETCHED = [/^\.proxmox\[\d+\]\.host$/, /^\.services\[\d+\]\.checks\[\d+\]\.url$/, /^\.services\[\d+\]\.widget\.url$/, /\.version(\[\d+\])?\.(current|latest)\.url$/, /\.version\.url$/]
  const all = []
  const walk = (o, p) => {
    if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${p}[${i}]`))
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`)
    else if (typeof o === 'string' && o.startsWith('https://')) all.push({ p, url: o })
  }
  walk(raw, '')
  const fetchedUrls = new Set(calls.map(c => c.url))
  const unclassified = []
  for (const { p, url } of all) {
    const kinds = [FETCHED.some(r => r.test(p)) && fetchedUrls.has(url) && 'appel', LINKS.some(r => r.test(p)) && 'lien'].filter(Boolean)
    if (kinds.length !== 1) unclassified.push(`${p} = ${url} (${kinds.join('+') || 'aucune'})`)
    else if (kinds[0] === 'lien') assert.ok(['strict', 'private'].includes(tlsCategory(url)), `${p}`)
  }
  assert.deepEqual(unclassified, [])
})

// --- pinned cluster, real handshake ---
const cluster = (port, ca, pkiDir = path.join(FIX, 'pki')) => createSources(
  { proxmox: [{ id: 't', label: 'test', host: `https://127.0.0.1:${port}`, env: 'TPVE', ca }] },
  { TPVE_TOKEN_ID: 'root@pam!t', TPVE_TOKEN_SECRET: 'jeton-pve-test' },
  { pkiDir },
)
test('cluster ca = CA A, leaf A server → successful call, token received', async () => {
  const srv = await tlsServer('leaf-a')
  try {
    const [c] = await cluster(srv.port, 'pki/ca-a.pem').cluster()
    assert.equal(c.error, undefined)
    assert.equal(srv.stats.auth, 1)
    assert.match(srv.stats.tokens[0], /^PVEAPIToken=root@pam!t=jeton-pve-test$/)
  } finally {
    await srv.close()
  }
})

test('cluster ca = CA A, leaf B server → "certificate not verified", 0 requests', async () => {
  const srv = await tlsServer('leaf-b')
  try {
    const [c] = await cluster(srv.port, 'pki/ca-a.pem').cluster()
    assert.match(c.error, /^Proxmox : certificat non vérifié \([A-Z_]+\) — CA épinglée pki\/ca-a\.pem$/)
    assert.equal(srv.stats.requests, 0)
  } finally {
    await srv.close()
  }
})

test('default identity: ca = CA A, leaf A WITHOUT the IP in SAN → ERR_TLS_CERT_ALTNAME_INVALID, 0 requests', async () => {
  const srv = await tlsServer('leaf-a-nosan')
  try {
    const [c] = await cluster(srv.port, 'pki/ca-a.pem').cluster()
    assert.match(c.error, /certificat non vérifié \(ERR_TLS_CERT_ALTNAME_INVALID\)/)
    assert.equal(srv.stats.requests, 0)
  } finally {
    await srv.close()
  }
})

// --- schema ---
const base = (over = {}) => ({
  version: 2, title: 't', gitea: { owner: 'o' }, groups: [{ id: 'g', name: 'G' }],
  hosts: [{ id: 'h', name: 'H', kind: 'appliance', env: 'prod', ip: '192.0.2.9' }],
  proxmox: [], services: [], ...over,
})
const svc = extra => ({ id: 's', name: 'S', group: 'g', host: 'h', url: 'http://192.0.2.9/', ...extra })
const refused = (raw, re) => {
  const r = parseConfig(raw)
  assert.ok(r.errors, `refusal expected: ${JSON.stringify(raw).slice(0, 160)}`)
  if (re) assert.match(r.errors.join('\n'), re)
}
const accepted = raw => {
  const r = parseConfig(raw)
  assert.ok(!r.errors, r.errors?.join('\n'))
}
test('schema: ca required for https, pki/ path only; tls refused outside checks; tlsReason mandatory; widget auth over https to a private IP refused', () => {
  const pve = extra => ({ id: 'p', label: 'P', host: 'https://192.0.2.155:8006', env: 'PVE', ...extra })
  refused(base({ proxmox: [pve()] }), /proxmox\.0\.ca: ca required/)
  refused(base({ proxmox: [pve({ ca: '../etc/x.pem' })] }), /proxmox\.0\.ca/)
  refused(base({ proxmox: [pve({ ca: '/etc/pve/pve-root-ca.pem' })] }), /proxmox\.0\.ca/)
  accepted(base({ proxmox: [pve({ ca: 'pki/pve-prod.pem' })] }))
  accepted(base({ proxmox: [pve({ host: 'http://192.0.2.155:8006' })] }))
  refused(base({ proxmox: [pve({ ca: 'pki/pve-prod.pem', tls: 'insecure' })] }), /"tls"/)
  const field = [{ label: 'x', path: '/x', json: 'a' }]
  refused(base({ services: [svc({ widget: { url: 'https://api.example.com', auth: { type: 'bearer', secretEnv: 'K' }, fields: field, tls: 'insecure' } })] }), /"tls"/)
  refused(base({ services: [svc({ widget: { url: 'https://api.example.com', fields: field, tls: 'insecure' } })] }), /"tls"/)
  refused(base({ services: [svc({ version: { current: { from: 'http-json', url: 'https://192.0.2.9/v', path: 'v' }, tls: 'insecure' } })] }), /"tls"|version/)
  refused(base({ services: [svc({ version: { current: { from: 'http-json', url: 'https://192.0.2.9/v', path: 'v', auth: { type: 'header', name: 'X-Api-Key', secretEnv: 'K' }, tls: 'insecure' } } })] }), /"tls"|version/)
  refused(base({ services: [svc({ version: { from: 'ha', url: 'https://ha.example.com', secretEnv: 'K', tls: 'insecure' } })] }), /"tls"|version/)
  const check = extra => svc({ checks: [{ type: 'http', url: 'https://app.example.com', ...extra }] })
  refused(base({ services: [check({ tls: 'insecure' })] }), /check 0 tls: "insecure" without tlsReason/)
  refused(base({ services: [check({ tls: 'insecure', tlsReason: '   ' })] }), /without tlsReason/)
  refused(base({ services: [check({ tlsReason: 'x' })] }), /check 0 tlsReason without tls/)
  refused(base({ services: [check({ tls: 'permissive', tlsReason: 'x' })] }), /tls/)
  refused(base({ services: [svc({ checks: [{ type: 'tcp', target: 'app.example.com:443', tls: 'insecure', tlsReason: 'x' }] })] }), /'tls'|checks/)
  accepted(base({ services: [check({ tls: 'insecure', tlsReason: 'staging, CA privée' })] }))
  refused(base({ services: [svc({ widget: { url: 'https://192.168.50.9', auth: { type: 'bearer', secretEnv: 'K' }, fields: field } })] }), /widget with auth over https to a private IP/)
  accepted(base({ services: [svc({ widget: { url: 'https://192.168.50.9', fields: field } })] }))
  accepted(base({ services: [svc({ widget: { url: 'https://api.example.com', auth: { type: 'bearer', secretEnv: 'K' }, fields: field } })] }))
})

// --- missing or expired CA ---
test('check-config: missing or expired CA → exit 1; at startup, cluster in explicit error, service created, 0 requests', async () => {
  // config of the complete-config test and test CA (no longer the production config.json or CAs)
  const raw = T3_RAW
  const dir = tmpDir('dash-tls-ca-')
  fs.mkdirSync(path.join(dir, 'server/pki'), { recursive: true })
  for (const f of ['ca-a.pem', 'ca-b.pem']) fs.copyFileSync(path.join(FIX, 'pki', f), path.join(dir, 'server/pki', f))
  fs.copyFileSync(path.join(FIX, 'pki/ca-expired.pem'), path.join(dir, 'server/pki/expiree.pem'))
  const script = path.join(SERVER, 'scripts/check-config.js')
  const run = ca => {
    const f = path.join(dir, `config-${ca.replace(/\W/g, '_')}.json`)
    fs.writeFileSync(f, JSON.stringify({ ...raw, proxmox: raw.proxmox.map((p, i) => (i === 0 ? { ...p, ca } : p)) }))
    // CA folder via PKI_DIR (no longer the server/ next to the checked file)
    return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, f], { encoding: 'utf8', env: { ...process.env, PKI_DIR: path.join(dir, 'server/pki') } })
  }
  const ok = run('pki/ca-a.pem')
  assert.equal(ok.status, 0, ok.stderr)
  const absent = run('pki/absente.pem')
  assert.equal(absent.status, 1)
  assert.match(absent.stderr, /proxmox prod: CA missing \(pki\/absente\.pem\)/)
  const expired = run('pki/expiree.pem')
  assert.equal(expired.status, 1)
  assert.match(expired.stderr, /proxmox prod: CA expired \(pki\/expiree\.pem\)/)
  // a LEAF under pki/ is not a CA
  fs.copyFileSync(path.join(FIX, 'leaf-a.pem'), path.join(dir, 'server/pki/feuille.pem'))
  const leaf = run('pki/feuille.pem')
  assert.equal(leaf.status, 1)
  assert.match(leaf.stderr, /proxmox prod: not a CA \(pki\/feuille\.pem\)/)
  // a CA expiring in less than 90 days → warning, exit 0 (injected date)
  fs.copyFileSync(path.join(FIX, 'pki/ca-a.pem'), path.join(dir, 'server/pki/proche.pem'))
  const end = new Date(new X509Certificate(caPem('ca-a.pem')).validTo).getTime()
  const soonCfg = path.join(dir, 'config-proche.json')
  // both clusters on this CA: at the injected date, the real CAs would be expired
  fs.writeFileSync(soonCfg, JSON.stringify({ ...raw, proxmox: raw.proxmox.map(p => ({ ...p, ca: 'pki/proche.pem' })) }))
  const soon = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, soonCfg], { encoding: 'utf8', env: { ...process.env, PKI_DIR: path.join(dir, 'server/pki'), CHECK_CONFIG_NOW: String(end - 30 * 86400_000 - 3600_000) } })
  assert.equal(soon.status, 0, soon.stderr)
  assert.match(soon.stderr, /⚠ proxmox prod: CA pki\/proche\.pem expires in 30 d/)
  const far = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, soonCfg], { encoding: 'utf8', env: { ...process.env, PKI_DIR: path.join(dir, 'server/pki'), CHECK_CONFIG_NOW: String(end - 91 * 86400_000) } })
  assert.equal(far.status, 0, far.stderr)
  assert.doesNotMatch(far.stderr, /expires in/)
  // startup: same fault → cluster in explicit error, no request, no permissive fallback
  for (const [ca, msg, root] of [['pki/absente.pem', 'CA absente (pki/absente.pem)', path.join(FIX, 'pki')], ['pki/ca-expired.pem', 'CA expirée (pki/ca-expired.pem)', path.join(FIX, 'pki')], ['pki/feuille.pem', 'pas une CA (pki/feuille.pem)', path.join(dir, 'server/pki')]]) {
    let calls = 0
    const s = createSources(
      { proxmox: [{ id: 'prod', label: 'P', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca }] },
      { PVE_PROD_TOKEN_ID: 'id', PVE_PROD_TOKEN_SECRET: 'jeton' },
      { pkiDir: root, fetch: async () => { calls++; return new Response('{"data":[]}') } },
    )
    const [c] = await s.cluster()
    assert.equal(c.error, `certificat non vérifié : ${msg}`)
    assert.equal(calls, 0)
    assert.equal(s.clusters[0].caError, msg)
  }
})

test('permissive check (tls: insecure) receiving a 302 to another host → 302 returned, the target never contacted', async () => {
  let target = 0
  const tgt = http.createServer((req, res) => { target++; res.end('cible') })
  await new Promise(r => tgt.listen(0, '127.0.0.1', r))
  const srv = await tlsServer('leaf-b', (req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${tgt.address().port}/vole` })
    res.end()
  })
  try {
    const c = { type: 'http', url: `https://localhost:${srv.port}/`, tls: 'insecure', tlsReason: 'test' }
    assert.equal(checkAgent(c), permissiveAgent)
    const r = await runCheck(c)
    assert.equal(r.code, 302)
    assert.equal(r.state, 'ok')
    assert.equal(target, 0)
    assert.equal(srv.stats.requests, 1)
  } finally {
    await srv.close()
    await new Promise(r => tgt.close(r))
  }
})

// --- static ---
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else out.push(p)
  }
  return out
}
test('static: rejectUnauthorized: false only in lib/tls.js, lib/checks.js (tls probe) and lib/setup.js (reading the presented certificate); no other undici agent; no NODE_TLS_REJECT_UNAUTHORIZED', () => {
  const code = files(SERVER).filter(f => /\.(m?js|cjs)$/.test(f) && !f.startsWith(path.join(SERVER, 'test') + path.sep))
  const rel = f => path.relative(SERVER, f)
  const insecure = code.filter(f => /rejectUnauthorized\s*:\s*false/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
  assert.deepEqual(insecure, ['lib/checks.js', 'lib/setup.js', 'lib/tls.js'])
  // init wizard, a single line, tls.connect reading the presented certificate (no request,
  // no secret; the fingerprint is confirmed by the user before pinning the CA)
  const setupLines = fs.readFileSync(path.join(SERVER, 'lib/setup.js'), 'utf8').split('\n').filter(l => /rejectUnauthorized\s*:\s*false/.test(l))
  assert.equal(setupLines.length, 1)
  assert.match(setupLines[0], /tls\.connect\(/)
  const checks = fs.readFileSync(path.join(SERVER, 'lib/checks.js'), 'utf8')
  const lines = checks.split('\n').filter(l => /rejectUnauthorized\s*:\s*false/.test(l))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /tls\.connect\(/)
  const agents = code.filter(f => /new (Agent|Pool|Client|ProxyAgent|EnvHttpProxyAgent|RetryAgent)\(|setGlobalDispatcher/.test(fs.readFileSync(f, 'utf8'))).map(rel)
  assert.deepEqual(agents, ['lib/tls.js'])
  // the variable that disables all Node TLS verification appears nowhere
  const name = 'NODE_TLS_' + 'REJECT_UNAUTHORIZED'
  const scanned = [...files(SERVER), ...files(path.join(ROOT, 'deploy')), ...files(path.join(ROOT, '.github')), ...(fs.existsSync(path.join(ROOT, '.gitea')) ? files(path.join(ROOT, '.gitea')) : [])]
    .filter(f => !/\.(key|pem|png|svg|ico|db|tsv)$/.test(f))
  assert.ok(scanned.length > 50)
  const found = scanned.filter(f => f !== fileURLToPath(import.meta.url) && fs.readFileSync(f, 'utf8').includes(name)).map(f => path.relative(ROOT, f))
  assert.deepEqual(found, [])
})

// --- the agent actually used by the other authenticated modules ---
test('upstream, versions, Pi-hole and Gitea: with secret → strict (even on a private IP); without secret on a private IP → permissive; names → strict', async () => {
  const { createUpstream } = await import('../lib/updates/upstream.js')
  const { createUpdates } = await import('../lib/updates/index.js')
  const { createPihole } = await import('../lib/pihole.js')
  const { tmpStore } = await import('./tmpdir.js')
  const seen = []
  const spy = async (url, opts = {}) => {
    seen.push({ url: String(url), d: opts.dispatcher, method: opts.method ?? 'GET' })
    return Response.json(String(url).includes('/api/auth') ? { session: { sid: 's' } } : [])
  }
  const agentOf = u => seen.filter(x => x.url.startsWith(u)).map(x => x.d)
  // upstream: without secret on a private IP → permissive; with a declared secret or Authorization → strict; names → strict
  const up = createUpstream({ store: tmpStore('dash-tls-up-'), env: { GITHUB_TOKEN: 'gh' }, fetch: spy, log: { error() {} } })
  await up.httpJson('https://192.168.50.156:9443/api/status')
  await up.httpJson('https://192.168.50.156:9443/secret', { headers: { 'X-Api-Key': 'k' }, secret: true })
  await up.httpJson('https://192.168.50.154:8123/api/states', { headers: { Authorization: 'Bearer t' } })
  await up.httpJson('https://plex.tv/api/downloads/5.json')
  await up.github('o/r').catch(() => {})
  assert.deepEqual(agentOf('https://192.168.50.156:9443/api/status'), [permissiveAgent])
  assert.deepEqual(agentOf('https://192.168.50.156:9443/secret'), [strictAgent])
  assert.deepEqual(agentOf('https://192.168.50.154:8123/api/states'), [strictAgent])
  assert.deepEqual(agentOf('https://plex.tv/'), [strictAgent])
  assert.ok(agentOf('https://api.github.com/').length && agentOf('https://api.github.com/').every(d => d === strictAgent))
  // versions: the module declares the secret (any auth header, Home Assistant)
  const calls = []
  const raw = {
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }], gitea: { owner: 'x' },
    hosts: [{ id: 'h', name: 'h', kind: 'appliance', ip: '192.168.50.156', env: 'prod' }],
    services: [
      { id: 'a', name: 'A', group: 'g', host: 'h', url: 'http://x', version: { current: { from: 'http-json', url: 'https://192.168.50.156:9443/api/status', path: 'v' } } },
      { id: 'b', name: 'B', group: 'g', host: 'h', url: 'http://x', version: { current: { from: 'http-json', url: 'https://192.0.2.20:8443/api', path: 'v', auth: { type: 'header', name: 'X-Api-Key', secretEnv: 'K' } } } },
      { id: 'c', name: 'C', group: 'g', host: 'h', url: 'http://x', version: { from: 'ha', url: 'https://192.168.50.154:8123', secretEnv: 'HA' } },
    ],
  }
  const { config } = parseConfig(raw)
  const fake = {
    github: async () => [], githubTags: async () => [], eol: async () => [], node: async () => [], errors: () => [], stats: () => ({}),
    httpJson: async (url, opts = {}) => { calls.push({ url, secret: !!opts.secret, d: agentFor(url, { secret: !!opts.secret }) }); return url.endsWith('/api/states') ? [] : { v: '1.0' } },
  }
  const updates = createUpdates({ cfg: config, store: tmpStore('dash-tls-upd-'), agents: { hosts: [], get: () => null }, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream: fake, env: { K: 'k', HA: 't' }, log: { error() {} } })
  await updates.refresh()
  const by = u => calls.find(c => c.url.startsWith(u))
  assert.deepEqual([by('https://192.168.50.156:9443').secret, by('https://192.168.50.156:9443').d], [false, permissiveAgent])
  assert.deepEqual([by('https://192.0.2.20:8443').secret, by('https://192.0.2.20:8443').d], [true, strictAgent])
  assert.deepEqual([by('https://192.168.50.154:8123').secret, by('https://192.168.50.154:8123').d], [true, strictAgent])
  // Pi-hole over https (private IP): strict reads; login via the global agent (strict too)
  const ph = createPihole({ url: 'https://192.168.50.158', password: 'p', fetch: spy })
  await ph.get('/api/info/version')
  assert.deepEqual(seen.filter(x => x.url.startsWith('https://192.168.50.158/api/info')).map(x => x.d), [strictAgent])
  assert.deepEqual(seen.filter(x => x.url.startsWith('https://192.168.50.158/api/auth')).map(x => x.d), [undefined])
  // widget with auth to a private IP → strict; qBittorrent login (password) → strict:
  // real handshake to an unrecognized certificate (leaf A), 0 requests received
  assert.equal(widgetAgent({ url: 'https://192.168.50.9', auth: { type: 'bearer' } }), strictAgent)
  const qb = await tlsServer('leaf-a')
  try {
    const cfg = { services: [{ id: 'qbit', widget: { url: `https://127.0.0.1:${qb.port}`, auth: { type: 'qbittorrent', userEnv: 'QB_USER', secretEnv: 'QB_PASS' }, fields: [{ label: 'x', path: '/api/v2/transfer/info', json: 'a' }] } }] }
    const w = createWidgets(cfg, { QB_USER: 'admin', QB_PASS: 'mot-de-passe-test' }, { piholes: { get() {}, stop: async () => {} } })
    await w.runAll()
    assert.match(w.get('qbit').error, /CERT|SELF_SIGNED|UNABLE_TO/)
    assert.equal(qb.stats.requests, 0)
  } finally {
    await qb.close()
  }
  // Gitea over https (private IP): token → strict; plugin, calls via ctx.http (secret forced
  // by the Authorization header), with the real agentFor
  const { createHost } = await import('../lib/plugins/host.js')
  const { createHttp } = await import('../lib/http.js')
  const { default: gitea } = await import('../plugins/gitea/index.js')
  const gh = createHost({ cfg: { plugins: { gitea: { owner: 'o', repos: ['r'] } } }, env: { GITEA_URL: 'https://192.168.50.143:3000', GITEA_TOKEN: 'tok' }, log: { log() {}, warn() {}, error() {} }, plugins: [gitea], http: createHttp({ fetch: spy, defaultSecret: false }) })
  await gh.collectors().find(c => c.name === 'gitea').fn().catch(() => {})
  const g = seen.filter(x => x.url.startsWith('https://192.168.50.143:3000/'))
  assert.ok(g.length > 0)
  for (const x of g) assert.equal(x.d, strictAgent, x.url)
})
