// Installation by a newcomer, first part: optional Gitea (configured = gitea block AND
// non-empty GITEA_URL; otherwise no read, no source_error, "not configured"), empty Proxmox,
// startup without a file in "to configure" mode, agent key in the state folder, readable 421,
// trustedProxies as CIDR (IPv4 and IPv6).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost } from '../lib/plugins/host.js'
import { createHttp } from '../lib/http.js'
import { CORE_RULES } from '../lib/alerts/rules.js'
import gitea from '../plugins/gitea/index.js'
import { createCollector } from '../lib/alerts/collect.js'
import { createRules } from '../lib/alerts/rules.js'
import { buildDigest } from '../lib/notify/digest.js'
import { createFormatter } from '../lib/notify/format.js'
import { createClock } from '../lib/clock.js'
import { summary } from '../lib/status.js'
import { configSource, parseConfig, UNCONFIGURED } from '../lib/config.js'
import { createAgents } from '../lib/agents.js'
import { clientIp, viaHttps, localSocket, hostGuard, allowedHostsOf, shownHost, hostHint, createAuth, createAudit, hashPassword } from '../lib/auth.js'
import { proxyMatcher, parseProxyEntry } from '../lib/net/proxies.js'
import { tmpDir, tmpStore } from './tmpdir.js'
import { bootServer, bootConfig, request, until } from './server-boot.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(SERVER, '..')
const NOW = Date.parse('2026-11-10T10:00:00Z')
const ANON = { security: { anonymousRead: true } }
const OFF = { configured: false, data: null, at: null, error: null }

// --- optional Gitea ------------------------------------------------------------------------------

const base = parseConfig(bootConfig()).config
const noGitea = (() => {
  const { gitea, ...rest } = bootConfig()
  assert.ok(gitea)
  return parseConfig(rest).config
})()
// Gitea is a plugin (server/plugins/gitea): same host as index.js, injected fetch
const quiet = { log() {}, warn() {}, error() {} }
const giteaHost = (cfg, env, fetch = async () => { throw new Error('aucun appel attendu') }) => createHost({ cfg, env, log: quiet, coreRules: CORE_RULES, plugins: [gitea], http: createHttp({ fetch }) })
const sourceOf = (host, name) => host.collectors().find(c => c.name === name)

test('Gitea configured = gitea block AND non-empty GITEA_URL; otherwise never read (no network call)', async () => {
  const calls = []
  const fetch = async url => { calls.push(String(url)); return { ok: true, json: async () => [] } }
  const cases = [
    [noGitea, { GITEA_URL: 'http://127.0.0.1:9' }, false],
    [base, {}, false],
    [base, { GITEA_URL: '' }, false],
    [base, { GITEA_URL: '   ' }, false],
    [base, { GITEA_URL: 'http://127.0.0.1:9' }, true],
  ]
  for (const [cfg, env, want] of cases) {
    const h = giteaHost(cfg, env, fetch)
    assert.deepEqual([sourceOf(h, 'gitea').configured, sourceOf(h, 'runners').configured], [want, want], JSON.stringify(env))
    if (!want) {
      await assert.rejects(sourceOf(h, 'gitea').fn(), /Gitea non configuré/)
      await assert.rejects(sourceOf(h, 'runners').fn(), /Gitea non configuré/)
    }
  }
  assert.deepEqual(calls, [], 'no request to Gitea when it is not configured')
})

test('collector: unconfigured source never scheduled nor read (start, runAll); snapshot { configured: false }', async () => {
  const calls = []
  const timers = []
  const src = name => async () => { calls.push(name); return [] }
  const sources = { cluster: src('cluster'), backups: src('backups'), nodes: src('nodes'), disks: src('disks') }
  // sources of the unconfigured gitea plugin (no GITEA_URL), spied on
  const extra = giteaHost(base, {}).collectors().map(x => ({ ...x, fn: src(x.name) }))
  const c = createCollector(sources, { setTimer: (fn, ms) => timers.push({ fn, ms }), random: () => 0, now: () => NOW, extra })
  assert.deepEqual([c.snap.gitea, c.snap.runners], [OFF, OFF])
  c.start()
  assert.equal(timers.length, 4)
  for (const t of timers.splice(0)) await t.fn()
  await c.runAll()
  assert.ok(!calls.includes('gitea') && !calls.includes('runners'), calls.join(','))
  assert.deepEqual([c.snap.gitea, c.snap.runners], [OFF, OFF])
})

test('rules: no source_error from Gitea or from unconfigured runners; configured and failing: source_error as before', () => {
  const rules = createRules(base, { checks: [], result: () => null }, null, null, null, null, null, { host: giteaHost(base, { GITEA_URL: 'http://127.0.0.1:9' }) })
  const keys = snap => rules.evaluate(snap, NOW).filter(x => x.rule === 'source_error').map(x => [x.key, x.cond])
  assert.deepEqual(keys({ gitea: OFF, runners: OFF }), [])
  assert.deepEqual(keys({ gitea: { data: null, error: 'Gitea 502', at: NOW }, runners: { data: [], error: null, at: NOW } }),
    [['source_error:gitea', true], ['source_error:runners', false]])
  // configured but not read yet: pending (cond null), as before
  assert.deepEqual(keys({}), [['source_error:gitea', null], ['source_error:runners', null]])
})

test('digest and cockpit: "CI : non configurée" without "aucun échec"; CI tile configured false, without error', () => {
  const clock = createClock('Europe/Paris')
  const engine = { active: () => [], incidents: () => [], lastEvalAt: NOW, digestSince: () => [], digestCounts: () => ({}) }
  const host = giteaHost(base, { GITEA_URL: 'http://127.0.0.1:9' })
  const digest = snap => buildDigest({ cfg: base, engine, snap, monitor: { checks: [] }, formatter: createFormatter({ dashboardUrl: null, clock }), clock, host, now: NOW })
  let off
  try {
    off = digest({ gitea: OFF, runners: OFF })
  } catch (e) {
    assert.fail(`digest: ${e.message}`)
  }
  const text = JSON.stringify(off)
  assert.match(text, /CI : non configurée/)
  assert.doesNotMatch(text, /CI : [^"]*aucun échec/)
  assert.match(JSON.stringify(digest({ gitea: { data: [], error: null }, runners: { data: [], error: null } })), /CI : runners 0\/0 en ligne · aucun échec/)
  const s = summary({ cfg: base, snap: { gitea: OFF, runners: OFF }, monitor: { checks: [], result: () => null }, engine: { active: () => [], incidents: () => [] }, servicesView: () => [], host, now: NOW })
  assert.deepEqual(s.ci, { configured: false, runnersOnline: null, runnersTotal: null, failing: [], running: 0, error: null })
})

test('real startup without gitea or Proxmox (proxmox: []): every GET route without a 5xx error, /api/gitea and /api/runners { configured: false }, no source_error', { timeout: 60_000 }, async t => {
  const { gitea, ...cfg } = bootConfig({ ...ANON, proxmox: [] })
  assert.ok(gitea)
  const s = await bootServer(t, { config: cfg, env: { GITEA_URL: 'http://127.0.0.1:9' } })
  assert.deepEqual((await request(s.port, '/api/gitea')).json, { configured: false })
  assert.deepEqual((await request(s.port, '/api/runners')).json, { configured: false })
  // first alert evaluation 15 s after startup (every(15_000), index.js): wait for
  // 25 s, not 15 (race right at the delay, occasional failure under load)
  assert.ok(await until(async () => (await request(s.port, '/api/healthz')).json?.alertsEvaluatedAt, 25_000))
  const routes = ['/api/cluster', '/api/backups', '/api/proxmox', '/api/agents', '/api/updates', '/api/alerts', '/api/services', '/api/summary', '/api/summary?env=prod',
    '/api/health', '/api/history/bands?range=24h', '/api/network', '/api/silences', '/api/refresh', '/api/config', '/api/session']
  for (const p of routes) assert.ok((await request(s.port, p)).status < 500, p)
  const sum = (await request(s.port, '/api/summary')).json
  assert.equal(sum.ci.configured, false)
  assert.deepEqual([sum.guests.total, sum.backups.length], [0, 0])
  assert.deepEqual((await request(s.port, '/api/cluster')).json, [])
  const active = (await request(s.port, '/api/alerts')).json.active
  assert.deepEqual(active.filter(a => a.rule === 'source_error'), [])
})

// local fake Gitea: /api/v1/...; state 'ok' or 'down'
async function fakeGitea(t) {
  const st = { mode: 'ok', hits: 0 }
  const srv = http.createServer((req, res) => {
    st.hits++
    if (st.mode === 'down') { res.writeHead(502); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.startsWith('/api/v1/users/')) return res.end(JSON.stringify([{ name: 'depot' }]))
    if (req.url.includes('/actions/tasks')) return res.end(JSON.stringify({ workflow_runs: [{ status: 'success', run_number: 7, head_branch: 'main', created_at: '2026-11-10T09:00:00Z', updated_at: '2026-11-10T09:01:00Z', display_title: 'x' }] }))
    if (req.url.startsWith('/api/v1/admin/actions/runners')) return res.end(JSON.stringify({ runners: [{ id: 1, name: 'r', status: 'online', labels: [] }] }))
    if (req.url.match(/\/repos\/[^/]+\/depot$/)) return res.end(JSON.stringify({ default_branch: 'main', html_url: 'http://exemple.test/depot' }))
    res.end('[]')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return { st, url: `http://127.0.0.1:${srv.address().port}` }
}

test('real startup with gitea AND GITEA_URL (production case): Gitea read (repository table), as before', { timeout: 60_000 }, async t => {
  const g = await fakeGitea(t)
  const s = await bootServer(t, { config: bootConfig({ ...ANON, gitea: { owner: 'factice' } }), env: { GITEA_URL: g.url, GITEA_TOKEN: 'jeton-factice' } })
  const r = await request(s.port, '/api/gitea')
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json), r.body)
  assert.equal(r.json[0].name, 'depot')
  assert.ok(g.st.hits > 0)
  assert.ok(Array.isArray((await request(s.port, '/api/runners')).json))
  assert.equal((await request(s.port, '/api/summary')).json.ci.configured, true)
})

// --- "to configure" mode -------------------------------------------------------------------------

test('configSource: "to configure" only if CONFIG_PATH is MISSING and the default does not exist (lstat ENOENT); CONFIG_PATH set but empty → error', () => {
  const def = '/racine/config.json'
  const enoent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) }
  const eacces = () => { throw Object.assign(new Error('refusé'), { code: 'EACCES' }) }
  assert.deepEqual(configSource({ configPath: undefined, defaultFile: def, lstat: enoent }), { file: def, unconfigured: true })
  assert.deepEqual(configSource({ configPath: undefined, defaultFile: def, lstat: () => ({}) }), { file: def, unconfigured: false }, 'present, or a link, even broken')
  assert.deepEqual(configSource({ configPath: undefined, defaultFile: def, lstat: eacces }), { file: def, unconfigured: false }, 'other error: read, so stop')
  for (const v of ['', '   ']) assert.match(configSource({ configPath: v, defaultFile: def, lstat: enoent }).error, /CONFIG_PATH is set but empty/, JSON.stringify(v))
  assert.deepEqual(configSource({ configPath: '/etc/x/config.json', defaultFile: def, lstat: enoent }), { file: '/etc/x/config.json', unconfigured: false })
  const r = parseConfig(UNCONFIGURED)
  assert.equal(r.errors, undefined)
  assert.deepEqual([r.config.services, r.config.hosts, r.config.proxmox, r.config.gitea], [[], [], [], undefined])
})

// copy of the server/ tree (and an empty client/dist) in a temporary folder: the "root" has no config.json
function rootCopy(t) {
  const dir = tmpDir('dash-p3a-root-', t)
  const skip = new Set([path.join(SERVER, 'test'), path.join(SERVER, 'data')])
  fs.cpSync(SERVER, path.join(dir, 'server'), { recursive: true, filter: src => !skip.has(src) })
  return dir
}

test('real startup without a file or CONFIG_PATH: "to configure" mode (log, public session), reads still guarded; missing CONFIG_PATH → stop', { timeout: 90_000 }, async t => {
  const dir = rootCopy(t)
  const s = await bootServer(t, { env: { CONFIG_PATH: undefined }, cwd: path.join(dir, 'server') })
  assert.match(s.logs(), /config missing \(.*config\.json\): "to configure" mode/)
  const sess = (await request(s.port, '/api/session')).json
  assert.equal(sess.unconfigured, true)
  assert.deepEqual(Object.keys(sess).sort(), ['admin', 'anonymousRead', 'configured', 'expiresAt', 'httpRefused', 'networkAllowed', 'unconfigured'])
  const hz = (await request(s.port, '/api/healthz')).json
  assert.deepEqual([hz.ok, hz.unconfigured, hz.alertsEvaluatedAt], [true, true, null])
  assert.match(s.logs(), /no collection, versions, digest, bot or heartbeat/)
  // without config, the product default locale (en)
  assert.deepEqual((await request(s.port, '/api/config')).json, { title: 'Vigie', locale: 'en' })
  assert.equal((await request(s.port, '/api/alerts')).status, 401, 'read gated as with the safe defaults')
  // a declared instance (CONFIG_PATH) never starts empty
  await assert.rejects(bootServer(t, { env: { CONFIG_PATH: path.join(dir, 'absente.json') }, cwd: path.join(dir, 'server') }), /arrêté au démarrage \(1\)[\s\S]*reading \S*absente\.json/)
  // CONFIG_PATH set but empty or made of spaces ("CONFIG_PATH=" line of an EnvironmentFile): stop
  for (const v of ['', '   ']) await assert.rejects(bootServer(t, { env: { CONFIG_PATH: v }, cwd: path.join(dir, 'server') }), /arrêté au démarrage \(1\)[\s\S]*CONFIG_PATH is set but empty/, JSON.stringify(v))
  // default as a broken symbolic link: stop (never the "to configure" mode)
  fs.symlinkSync(path.join(dir, 'nulle-part.json'), path.join(dir, 'config.json'))
  await assert.rejects(bootServer(t, { env: { CONFIG_PATH: undefined }, cwd: path.join(dir, 'server') }), /arrêté au démarrage \(1\)[\s\S]*reading /)
  fs.unlinkSync(path.join(dir, 'config.json'))
  // default file present but invalid: stop
  fs.writeFileSync(path.join(dir, 'config.json'), '{ pas du json')
  await assert.rejects(bootServer(t, { env: { CONFIG_PATH: undefined }, cwd: path.join(dir, 'server') }), /arrêté au démarrage \(1\)/)
})

test('configured instance: neither session nor healthz carry unconfigured; healthz keeps exactly its shape', { timeout: 30_000 }, async t => {
  const s = await bootServer(t)
  assert.equal('unconfigured' in (await request(s.port, '/api/session')).json, false)
  assert.deepEqual(Object.keys((await request(s.port, '/api/healthz')).json), ['ok', 'version', 'commit', 'uptimeSec', 'checks', 'completed', 'alertsEvaluatedAt'])
})

test('"to configure" mode (static): no versions, collection, evaluation, sending, digest, bot, or heartbeat', () => {
  const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8')
  // updates.start goes through the core module (lib/plugins/core.js), which receives unconfigured
  const core = fs.readFileSync(path.join(SERVER, 'lib/plugins/core.js'), 'utf8')
  assert.match(src, /coreModules\(\{ updates, network, unconfigured \}\)/)
  assert.match(core, /start: \(\) => \{ if \(!unconfigured\) updates\.start\(\) \}/)
  assert.equal(core.match(/updates\.start\(\)/g).length, 1)
  assert.match(src, /if \(!unconfigured\) collector\.start\(\)/)
  assert.match(src, /if \(!unconfigured\) \{\n  every\(15_000, \(\) => engine\.evaluate\(collector\.snap\)\)\n  every\(5_000, \(\) => notifier\.flush\(\)\)\n  every\(60_000, \(\) => digest\.tick\(\)\)\n\}/)
  assert.match(src, /if \(botWanted && !unconfigured\) bot\.start\(\)/)
  assert.match(src, /if \(heartbeat\.url && !unconfigured\) \{/)
  // no other call of these startups
  assert.equal(src.match(/updates\.start\(\)/g), null, 'updates.start only by the core module')
  for (const re of [/collector\.start\(\)/g, /bot\.start\(\)/g, /digest\.tick\(\)/g, /notifier\.flush\(\)/g]) assert.equal(src.match(re).length, 1, String(re))
})

// --- agent key in the state folder ---------------------------------------------------------------

test('agents: SSH key in the shared state folder (STATE_DIRECTORY, otherwise <root>/data), DASHREPORT_SSH_KEY first; no more hard-coded production path', () => {
  const cfg = { hosts: [] }
  assert.equal(createAgents(cfg, { STATE_DIRECTORY: '/var/lib/x' }).sshKey, '/var/lib/x/ssh/id_ed25519')
  assert.equal(createAgents(cfg, {}, { root: '/racine' }).sshKey, '/racine/data/ssh/id_ed25519')
  assert.equal(createAgents(cfg, { DASHREPORT_SSH_KEY: '/k/id', STATE_DIRECTORY: '/var/lib/x' }).sshKey, '/k/id')
  assert.doesNotMatch(fs.readFileSync(path.join(SERVER, 'lib/agents.js'), 'utf8'), /'\/var\/lib\/[\w-]+'/)
})

// --- readable 421 --------------------------------------------------------------------------------

test('421: JSON for the API (received name, steps to follow); HTML page for a browser outside /api; nothing about the instance; name escaped and bounded', { timeout: 30_000 }, async t => {
  const s = await bootServer(t, { config: bootConfig({ subtitle: 'sous-titre-sentinelle', footer: 'pied-sentinelle' }) })
  const api = await request(s.port, '/api/alerts', { host: 'evil.example', headers: { accept: 'text/html' } })
  assert.equal(api.status, 421)
  assert.deepEqual(api.json, { error: 'hôte non autorisé', host: 'evil.example', hint: hostHint() })
  const page = await request(s.port, '/reseau', { host: 'Evil.Example:8443', headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(page.status, 421)
  assert.match(page.headers['content-type'], /^text\/html/)
  assert.match(page.body, /Ce serveur ne répond pas au nom <code>evil\.example<\/code>/)
  assert.match(page.body, /ajouter <code>"evil\.example"<\/code> à <code>allowedHosts<\/code>/)
  assert.doesNotMatch(page.body, /<script|Banc de test|sentinelle|web-factice|127\.0\.0\.1/)
  assert.equal(page.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'")
  assert.equal(page.headers['cache-control'], 'no-store')
  // without Accept HTML: JSON, even outside /api
  const plain = await request(s.port, '/', { host: 'evil.example' })
  assert.deepEqual([plain.status, plain.json?.host], [421, 'evil.example'])
  // escaping and bound (the name comes from the client)
  const evil = await request(s.port, '/', { host: 'a"b.example', headers: { accept: 'text/html' } })
  assert.doesNotMatch(evil.body, /a"b/)
  assert.equal(shownHost('x'.repeat(300)).length, 100)
  assert.equal(shownHost('a\u0000b c'), 'abc')
  assert.equal(shownHost(''), '(aucun)')
})

test('421 unit: HTML only outside /api with Accept text/html; the displayed name is the one hostGuard compares', () => {
  const run = (host, p, accept) => {
    const out = {}
    const res = { status: c => { out.code = c; return res }, set: () => res, type: x => { out.type = x; return res }, send: b => { out.body = b }, json: b => { out.json = b } }
    hostGuard(allowedHostsOf({}))({ get: k => ({ host, accept })[k.toLowerCase()], path: p }, res, () => { out.next = true })
    return out
  }
  assert.equal(run('localhost:8088', '/', 'text/html').next, true)
  assert.equal(run('EVIL.example:80', '/x', 'text/html').type, 'html')
  assert.equal(run('evil.example', '/api', 'text/html').json.host, 'evil.example')
  assert.equal(run('evil.example', '/api/x', '*/*').json.host, 'evil.example')
  assert.equal(run('[::2]:80', '/x', 'application/json').json.host, '[::2]')
})

// --- trustedProxies as CIDR ----------------------------------------------------------------------

const req = (sock, headers = {}, encrypted = false) => ({ socket: { remoteAddress: sock, encrypted }, get: k => headers[k.toLowerCase()] ?? null })

test('parseProxyEntry: IPv4, IPv6, CIDR of both; prefix too wide (< /8, < /32 in IPv6), too long, name, port refused', () => {
  assert.deepEqual(parseProxyEntry('192.0.2.153'), { address: '192.0.2.153', prefix: 32, family: 'ipv4' })
  assert.deepEqual(parseProxyEntry('172.16.0.0/12'), { address: '172.16.0.0', prefix: 12, family: 'ipv4' })
  assert.deepEqual(parseProxyEntry('FD00::/32'), { address: 'fd00::', prefix: 32, family: 'ipv6' })
  assert.deepEqual(parseProxyEntry('10.0.0.0/8'), { address: '10.0.0.0', prefix: 8, family: 'ipv4' })
  assert.deepEqual(parseProxyEntry('2001:db8::1'), { address: '2001:db8::1', prefix: 128, family: 'ipv6' })
  for (const bad of ['0.0.0.0/0', '::/0', '10.0.0.0/7', '0.0.0.0/1', 'fd00::/31', 'fd00::/8', '192.0.2.0/33', 'fd00::/129', 'proxy.example', '192.0.2.1:80', '[::1]', '', '192.0.2.0/', ' /8']) assert.equal(parseProxyEntry(bad), null, bad)
})

test('mapped IPv4: ::/32, ::ffff:0.0.0.0/96 and any range covering ::ffff:0:0/96 refused; mapped entry = its IPv4 form (/8 rule); an IPv6-only config never trusts an IPv4', () => {
  for (const bad of ['::/32', '::/64', '::/80', '::ffff:0.0.0.0/96', '::fffe:0:0/95', '::ffff:10.0.0.0/103', '0:0:0:0:0:ffff::/96']) assert.equal(parseProxyEntry(bad), null, bad)
  assert.deepEqual(parseProxyEntry('::ffff:198.51.100.0/120'), { address: '198.51.100.0', prefix: 24, family: 'ipv4' })
  assert.deepEqual(parseProxyEntry('::ffff:c633:6400/120'), { address: '198.51.100.0', prefix: 24, family: 'ipv4' }, 'hexadecimal form')
  assert.deepEqual(parseProxyEntry('::ffff:198.51.100.7'), { address: '198.51.100.7', prefix: 32, family: 'ipv4' })
  assert.deepEqual(parseProxyEntry('::ffff:10.0.0.0/104'), { address: '10.0.0.0', prefix: 8, family: 'ipv4' })
  const mapped = proxyMatcher(['::ffff:198.51.100.0/120', '::ffff:203.0.113.9'])
  assert.deepEqual(['198.51.100.7', '::ffff:198.51.100.7', '198.51.101.1', '203.0.113.9', '203.0.113.10'].map(x => mapped.has(x)), [true, true, false, true, false])
  // other IPv6 ranges that carry an IPv4 (NAT64, compatible, 6to4 in /32): never matched with IPv4s
  const v6only = proxyMatcher(['fd00::/32', '64:ff9b::/96', '::/96', '2002::/32', '2001:db8::/32'])
  for (const ip of ['8.8.8.8', '203.0.113.9', '192.0.2.50', '10.0.0.1', '::ffff:8.8.8.8']) assert.equal(v6only.has(ip), false, ip)
  assert.equal(clientIp(req('8.8.8.8', { 'x-forwarded-for': '127.0.0.1' }), v6only), '8.8.8.8', 'XFF from an IPv4 never read')
  assert.equal(viaHttps(req('203.0.113.9', { 'x-forwarded-proto': 'https' }), v6only), false)
  assert.equal(v6only.has('64:ff9b::808:808'), true, 'a real IPv6 in the range is still trusted')
})

test('clientIp and viaHttps with a CIDR proxy: proxy in the range trusted (XFF from right to left), out of range ignored; IPv6; exact IP unchanged', () => {
  const trusted = proxyMatcher(['172.16.0.0/12', 'fd00:12::/32', '192.0.2.153'])
  // proxy in a container, any address of the range
  assert.equal(clientIp(req('172.18.0.7', { 'x-forwarded-for': '192.0.2.50' }), trusted), '192.0.2.50')
  assert.equal(clientIp(req('::ffff:172.18.0.7', { 'x-forwarded-for': '192.0.2.50' }), trusted), '192.0.2.50')
  assert.equal(clientIp(req('fd00:12::7', { 'x-forwarded-for': '2001:db8::50' }), trusted), '2001:db8::50')
  assert.equal(clientIp(req('fd00:13::7', { 'x-forwarded-for': '2001:db8::50' }), trusted), 'fd00:13::7', 'IPv6 out of range')
  // exact IP of a single proxy: unchanged
  assert.equal(clientIp(req('192.0.2.153', { 'x-forwarded-for': '192.0.2.51' }), trusted), '192.0.2.51')
  // out of range: XFF ignored, the socket IP
  assert.equal(clientIp(req('172.32.0.1', { 'x-forwarded-for': '192.0.2.50' }), trusted), '172.32.0.1')
  assert.equal(clientIp(req('192.0.2.154', { 'x-forwarded-for': '127.0.0.1' }), trusted), '192.0.2.154')
  // no bypass: entries forged on the left never read; trusted entries skipped
  assert.equal(clientIp(req('172.18.0.7', { 'x-forwarded-for': '127.0.0.1, 192.0.2.60' }), trusted), '192.0.2.60')
  assert.equal(clientIp(req('172.18.0.7', { 'x-forwarded-for': '192.0.2.60, 172.20.0.9' }), trusted), '192.0.2.60', 'chain of proxies in the range')
  assert.equal(clientIp(req('172.18.0.7', { 'x-forwarded-for': '172.20.0.9' }), trusted), null, 'all trusted: fail closed')
  assert.equal(clientIp(req('172.18.0.7', {}), trusted), null)
  // X-Forwarded-Proto: only from the range
  assert.equal(viaHttps(req('172.18.0.7', { 'x-forwarded-proto': 'https' }), trusted), true)
  assert.equal(viaHttps(req('172.32.0.1', { 'x-forwarded-proto': 'https' }), trusted), false)
  // raw array (tests, direct calls): same result
  assert.equal(clientIp(req('172.18.0.7', { 'x-forwarded-for': '192.0.2.50' }), ['172.16.0.0/12']), '192.0.2.50')
})

test('loopback exception intact: socket only; a trusted proxy in a range (even local) does not benefit from it', async () => {
  const trusted = proxyMatcher(['127.0.0.0/8', '172.16.0.0/12'])
  assert.equal(localSocket(req('127.0.0.1'), proxyMatcher(['172.16.0.0/12'])), true)
  assert.equal(localSocket(req('127.0.0.5'), trusted), false, 'local proxy in the range')
  assert.equal(localSocket(req('172.18.0.7', { 'x-forwarded-for': '127.0.0.1' }), trusted), false)
  const store = tmpStore('dash-p3a-auth-')
  const audit = createAudit(store, { tickMs: 0 })
  const HASH = await hashPassword('mot de passe P3a')
  let verified = 0
  const auth = createAuth({ store, audit, log: { error() {} }, trustedProxies: ['172.16.0.0/12'], adminCidrs: ['127.0.0.0/8', '192.0.2.0/24'], verify: async () => { verified++; return true }, env: { ADMIN_PASSWORD_HASH: HASH } })
  const login = r => auth.login(r, { setHeader() {} }, 'mot de passe P3a')
  // proxy in range that copies an XFF 127.0.0.1 over HTTP → 403, password not checked
  const forged = await login(req('172.18.0.7', { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http' }))
  assert.deepEqual([forged.status, verified], [403, 0])
  // same proxy over HTTPS, LAN client → allowed
  assert.equal((await login(req('172.18.0.7', { 'x-forwarded-for': '192.0.2.70', 'x-forwarded-proto': 'https' }))).ok, true)
  // proxy in range: never "known"
  assert.equal(auth.isKnown('172.18.0.7'), false)
})
