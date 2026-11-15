// Setup wizard (lib/setup.js, scripts/init.js). Options and safeguards (secrets never
// as arguments, production paths, refusal to overwrite), non-interactive mode, wizard driven by scripted
// stdin, connection tests against FAKE local Proxmox (https, test CA) and Gitea (success,
// 401, timeout, unrecognized TLS), no secret in the output, real server startup on the output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CI_FILES, readCi } from './workflows.js'
import { createPrompter, Aborted, InputClosed } from '../lib/cli.js'
import { runInit, parseInitArgs, resolvePaths, maskUrl, testProxmox, testGitea, presentedChain, caFromPem, SECRET_ENV, USAGE } from '../lib/setup.js'
import { verifyPassword } from '../lib/auth.js'
import { parseConfig } from '../lib/config.js'
import { tlsFixtures } from './tls-fixtures.js'
import { tmpDir } from './tmpdir.js'
import { bootServer, request } from './server-boot.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(SERVER, '..')
const PASSWORD = 'mot de passe admin du banc P3b'
const PVE_SECRET = 'aaaaaaaa-bbbb-cccc-dddd-SECRET-PVE'
const GITEA_TOKEN = 'jeton-gitea-SECRET-0123456789'
const SECRETS = [PASSWORD, PVE_SECRET, GITEA_TOKEN]

// captured output
function sink() {
  const s = new PassThrough()
  let text = ''
  s.on('data', d => { text += d })
  return { stream: s, text: () => text }
}
const noSecret = (text, what) => { for (const x of SECRETS) assert.ok(!text.includes(x), `${what}: secret shown`) }

// --- fake servers ---------------------------------------------------------------------------------

// fake https Proxmox (leaf-a certificate signed by test CA A); chain: also presents the CA
async function fakePve(t, { chain = true, mode = 'ok' } = {}) {
  const f = tlsFixtures()
  const st = { hits: 0, auth: [] }
  const cert = fs.readFileSync(path.join(f, 'leaf-a.pem'), 'utf8') + (chain ? fs.readFileSync(path.join(f, 'pki/ca-a.pem'), 'utf8') : '')
  const srv = https.createServer({ key: fs.readFileSync(path.join(f, 'leaf-a.key')), cert }, (req, res) => {
    st.hits++
    st.auth.push(req.headers.authorization)
    if (mode === 'hang') return
    if (req.headers.authorization !== `PVEAPIToken=vigie@pve!lecture=${PVE_SECRET}`) { res.writeHead(401); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/api2/json/version') return res.end(JSON.stringify({ data: { version: '8.4.1' } }))
    if (req.url === '/api2/json/nodes') return res.end(JSON.stringify({ data: [{ node: 'pve-b' }, { node: 'pve-a' }] }))
    res.end('{}')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.closeAllConnections?.(); return new Promise(r => srv.close(r)) })
  return { st, url: `https://127.0.0.1:${srv.address().port}`, caA: fs.readFileSync(path.join(f, 'pki/ca-a.pem'), 'utf8'), caB: fs.readFileSync(path.join(f, 'pki/ca-b.pem'), 'utf8') }
}

// fake http Gitea; runners: 200 or 403 (read:admin permission missing)
async function fakeGitea(t, { runners = 200 } = {}) {
  const st = { hits: 0 }
  const srv = http.createServer((req, res) => {
    st.hits++
    if (req.headers.authorization !== `token ${GITEA_TOKEN}`) { res.writeHead(401); return res.end() }
    if (req.url === '/api/v1/user') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ login: 'dev-factice' })) }
    if (req.url.startsWith('/api/v1/admin/actions/runners')) { res.writeHead(runners); return res.end(runners === 200 ? '{"runners":[]}' : '{}') }
    if (req.url.startsWith('/api/v1/users/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
    res.writeHead(404)
    res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return { st, url: `http://127.0.0.1:${srv.address().port}` }
}

// fake ssh-keygen: writes a dummy key pair
const fakeKeygen = async file => {
  fs.writeFileSync(file, 'clé privée factice\n', { mode: 0o600 })
  fs.writeFileSync(`${file}.pub`, 'ssh-ed25519 AAAAfactice vigie-agent\n')
}

function dirs(t) {
  const d = tmpDir('dash-p3b-', t)
  return { d, args: ['--config', path.join(d, 'config.json'), '--env', path.join(d, 'vigie.env'), '--pki', path.join(d, 'pki'), '--state', path.join(d, 'state')] }
}

// --- options and paths -----------------------------------------------------------------------------

test('options: secrets refused as arguments (even under another name); known options; unknown → error; --help', async () => {
  for (const a of ['--password=x', '--admin-password', 'x', '--pve-token-secret=y', '--token', '--gitea-token=z', '--secret=w']) {
    if (a === 'x') continue
    assert.throws(() => parseInitArgs([a]), /secrets are never passed as arguments/, a)
  }
  assert.equal(parseInitArgs(['--pve-token-id', 'vigie@pve!lecture'])['pve-token-id'], 'vigie@pve!lecture')
  assert.throws(() => parseInitArgs(['--inconnue']), /see --help/)
  assert.throws(() => parseInitArgs(['positionnel']), /see --help/)
  const out = sink()
  assert.equal(await runInit({ argv: ['--help'], output: out.stream, errOutput: sink().stream }), 0)
  assert.match(out.text(), /--non-interactive/)
  for (const n of Object.values(SECRET_ENV)) assert.match(USAGE, new RegExp(n))
})

test('paths: defaults at the root; system path (/etc, /var/lib) coming from a variable refused without an explicit option', () => {
  const p = resolvePaths({}, {}, { root: '/r', serverDir: '/r/server' })
  assert.deepEqual(p, { config: '/r/config.json', env: '/r/.env', pki: '/r/server/pki', state: '/r/data' })
  for (const env of [{ CONFIG_PATH: '/etc/vigie/config.json' }, { ENV_FILE: '/etc/exemple.env' }, { PKI_DIR: '/etc/vigie/pki' }, { STATE_DIRECTORY: '/var/lib/vigie' }]) {
    assert.throws(() => resolvePaths({}, env, { root: '/r', serverDir: '/r/server' }), /system path \(instance in service\?\)/, JSON.stringify(env))
  }
  assert.equal(resolvePaths({ config: '/etc/vigie/config.json' }, {}).config, '/etc/vigie/config.json', 'explicit: allowed')
  assert.equal(resolvePaths({}, { CONFIG_PATH: '/srv/vigie/config.json' }, { root: '/r', serverDir: '/r/server' }).config, '/srv/vigie/config.json', 'outside a system path: allowed')
  assert.equal(resolvePaths({}, { ENV_FILE: 'none' }, { root: '/r', serverDir: '/r/server' }).env, '/r/.env')
})

// --- non-interactive mode --------------------------------------------------------------------------

test('non-interactive: valid config (check-config), verifiable hash, env in 0600, refusal to overwrite, --force, no secret in the output', async t => {
  const { d, args } = dirs(t)
  const out = sink()
  const errs = sink()
  const env = { [SECRET_ENV.admin]: PASSWORD }
  assert.equal(await runInit({ argv: ['--non-interactive', '--title', 'Banc P3b', ...args], env, output: out.stream, errOutput: errs.stream }), 0, errs.text())
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'))
  assert.equal(parseConfig(cfg).errors, undefined)
  assert.deepEqual([cfg.title, cfg.listenHost, cfg.security], ['Banc P3b', '127.0.0.1', { anonymousRead: false, httpLogin: false, adminCidrs: ['127.0.0.1/32'] }])
  execFileSync(process.execPath, [path.join(SERVER, 'scripts/check-config.js'), path.join(d, 'config.json')], { stdio: 'pipe' })
  const envText = fs.readFileSync(path.join(d, 'vigie.env'), 'utf8')
  const hash = envText.match(/^ADMIN_PASSWORD_HASH=(.*)$/m)[1]
  assert.equal(await verifyPassword(PASSWORD, hash), true)
  assert.equal(fs.statSync(path.join(d, 'vigie.env')).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(d).filter(f => f.endsWith('.tmp')).length, 0)
  noSecret(out.text() + errs.text(), 'output')
  assert.match(out.text(), /Open: http:\/\/127\.0\.0\.1:8088/)
  // refusal to overwrite, then --force
  const e2 = sink()
  assert.equal(await runInit({ argv: ['--yes', ...args], env, output: sink().stream, errOutput: e2.stream }), 1)
  assert.match(e2.text(), /already present: .*config\.json.*--force to overwrite/)
  assert.equal(await runInit({ argv: ['--yes', '--force', ...args], env, output: sink().stream, errOutput: sink().stream }), 0)
})

test('non-interactive: missing required value → clean failure, nothing written; short password refused; secrets through --secrets-stdin', async t => {
  const { d, args } = dirs(t)
  const run = async (argv, env, input) => {
    const errs = sink()
    const code = await runInit({ argv, env, input: input ?? new PassThrough(), output: sink().stream, errOutput: errs.stream })
    return { code, err: errs.text() }
  }
  let r = await run(['--yes', ...args], {})
  assert.deepEqual([r.code, /VIGIE_INIT_ADMIN_PASSWORD or --secrets-stdin missing/.test(r.err)], [1, true])
  r = await run(['--yes', ...args], { [SECRET_ENV.admin]: 'court' })
  assert.match(r.err, /12 characters at least/)
  r = await run(['--yes', '--pve-url', 'http://127.0.0.1:9', ...args], { [SECRET_ENV.admin]: PASSWORD })
  assert.match(r.err, /--pve-token-id .* missing/)
  r = await run(['--yes', '--pve-url', 'http://127.0.0.1:9', '--pve-token-id', 'vigie@pve!lecture', ...args], { [SECRET_ENV.admin]: PASSWORD })
  assert.match(r.err, /Proxmox token secret: VIGIE_INIT_PVE_TOKEN_SECRET or --secrets-stdin missing/)
  r = await run(['--yes', '--pve-url', 'https://127.0.0.1:9', '--pve-token-id', 'vigie@pve!lecture', ...args], { [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.pve]: PVE_SECRET })
  assert.match(r.err, /Proxmox over https: --pve-ca <PEM file> or --pve-ca-fingerprint <SHA-256> required \(no permissive fallback\)/)
  r = await run(['--yes', '--gitea-url', 'http://127.0.0.1:9', '--skip-tests', ...args], { [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.gitea]: GITEA_TOKEN })
  assert.match(r.err, /--gitea-owner missing/)
  assert.equal(fs.existsSync(path.join(d, 'config.json')) || fs.existsSync(path.join(d, 'vigie.env')), false, 'nothing written')
  // --secrets-stdin
  const input = new PassThrough()
  input.end(`${SECRET_ENV.admin}=${PASSWORD}\nAUTRE=ignorée\n`)
  r = await run(['--yes', '--secrets-stdin', ...args], {}, input)
  assert.equal(r.code, 0, r.err)
  noSecret(r.err, 'error')
})

test('non-interactive: https Proxmox through the fingerprint of the presented CA, Gitea (read:admin warning), SSH key; failed test → stop, unless --keep-failed', async t => {
  const pve = await fakePve(t)
  const gitea = await fakeGitea(t, { runners: 403 })
  const { d, args } = dirs(t)
  const fp = caFromPem(pve.caA).fingerprint256
  const env = { [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.pve]: PVE_SECRET, [SECRET_ENV.gitea]: GITEA_TOKEN }
  const out = sink()
  const errs = sink()
  const argv = ['--yes', '--pve-url', pve.url, '--pve-token-id', 'vigie@pve!lecture', '--pve-ca-fingerprint', fp.toLowerCase().replace(/:/g, ''), '--gitea-url', gitea.url, '--ssh-key', ...args]
  assert.equal(await runInit({ argv, env, output: out.stream, errOutput: errs.stream, keygen: fakeKeygen }), 0, errs.text())
  assert.match(out.text(), /✓ Proxmox 8\.4\.1, nodes: pve-a, pve-b/)
  assert.match(out.text(), /✓ Gitea: dev-factice/)
  assert.match(out.text(), /⚠ runners unreadable \(HTTP 403\): read:admin permission required/)
  noSecret(out.text() + errs.text(), 'output')
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'))
  assert.deepEqual(cfg.proxmox, [{ id: 'pve', label: 'Proxmox', host: pve.url, env: 'PVE', ca: 'pki/pve.pem' }])
  // init writes the plugin block, plugins.gitea
  assert.deepEqual(cfg.plugins.gitea, { owner: 'dev-factice', repos: [] })
  assert.equal(cfg.gitea, undefined)
  assert.equal(caFromPem(fs.readFileSync(path.join(d, 'pki/pve.pem'), 'utf8')).fingerprint256, fp)
  const envText = fs.readFileSync(path.join(d, 'vigie.env'), 'utf8')
  assert.match(envText, /^PVE_TOKEN_ID=vigie@pve!lecture$/m)
  assert.match(envText, new RegExp(`^PVE_TOKEN_SECRET=${PVE_SECRET}$`, 'm'))
  assert.match(envText, new RegExp(`^GITEA_URL=${gitea.url.replace(/[.:/]/g, '\\$&')}$`, 'm'))
  assert.match(envText, new RegExp(`^GITEA_TOKEN=${GITEA_TOKEN}$`, 'm'))
  assert.equal(fs.statSync(path.join(d, 'state/ssh')).mode & 0o777, 0o700)
  assert.equal(fs.readFileSync(path.join(d, 'state/ssh/known_hosts'), 'utf8'), '')
  assert.match(out.text(), /ssh-ed25519 AAAAfactice vigie-agent/)
  // fingerprint that does not match → refused; failed test → stop; --keep-failed → kept
  const d2 = dirs(t)
  const e2 = sink()
  assert.equal(await runInit({ argv: ['--yes', '--pve-url', pve.url, '--pve-token-id', 'vigie@pve!lecture', '--pve-ca-fingerprint', caFromPem(pve.caB).fingerprint256, ...d2.args], env, output: sink().stream, errOutput: e2.stream }), 1)
  assert.match(e2.text(), /no CA presented by the server has this fingerprint/)
  const caBFile = path.join(d2.d, 'ca-b.pem')
  fs.writeFileSync(caBFile, pve.caB)
  const e3 = sink()
  const hitsBefore = pve.st.hits
  assert.equal(await runInit({ argv: ['--yes', '--pve-url', pve.url, '--pve-token-id', 'vigie@pve!lecture', '--pve-ca', caBFile, ...d2.args], env, output: sink().stream, errOutput: e3.stream }), 1)
  assert.match(e3.text(), /Proxmox: certificate not recognised \(.+\) by the chosen CA: the secret was not sent/)
  assert.equal(pve.st.hits, hitsBefore, 'no HTTP request received: the token was not sent')
  const e4 = sink()
  assert.equal(await runInit({ argv: ['--yes', '--keep-failed', '--pve-url', pve.url, '--pve-token-id', 'vigie@pve!lecture', '--pve-ca', caBFile, ...d2.args], env, output: sink().stream, errOutput: e4.stream }), 0, e4.text())
  noSecret(e2.text() + e3.text() + e4.text(), 'errors')
})

// --- connection tests ------------------------------------------------------------------------------

test('testProxmox: success (version, nodes); 401; bounded timeout; unrecognized TLS without sending the token; never a secret in the messages', async t => {
  const pve = await fakePve(t)
  const ok = await testProxmox({ url: pve.url, tokenId: 'vigie@pve!lecture', tokenSecret: PVE_SECRET, caPem: pve.caA })
  assert.deepEqual([ok.ok, ok.version, ok.nodes], [true, '8.4.1', ['pve-a', 'pve-b']])
  const bad = await testProxmox({ url: pve.url, tokenId: 'vigie@pve!lecture', tokenSecret: 'faux', caPem: pve.caA })
  assert.deepEqual([bad.ok, bad.kind], [false, 'auth'])
  const hits = pve.st.hits
  const tlsBad = await testProxmox({ url: pve.url, tokenId: 'vigie@pve!lecture', tokenSecret: PVE_SECRET, caPem: pve.caB })
  assert.deepEqual([tlsBad.ok, tlsBad.kind], [false, 'tls'])
  assert.equal(pve.st.hits, hits, 'TLS refused: no request, the token was not sent')
  // without a pinned CA: public store, unknown test CA → refused
  assert.equal((await testProxmox({ url: pve.url, tokenId: 'x@pve!y', tokenSecret: PVE_SECRET })).kind, 'tls')
  const hang = await fakePve(t, { mode: 'hang' })
  const t0 = Date.now()
  const slow = await testProxmox({ url: hang.url, tokenId: 'vigie@pve!lecture', tokenSecret: PVE_SECRET, caPem: hang.caA, timeoutMs: 300 })
  assert.deepEqual([slow.ok, slow.kind], [false, 'timeout'])
  assert.ok(Date.now() - t0 < 5000)
  const down = await testProxmox({ url: 'https://127.0.0.1:9', tokenId: 'x@pve!y', tokenSecret: PVE_SECRET, caPem: pve.caA, timeoutMs: 2000 })
  assert.equal(down.kind, 'network')
  for (const r of [bad, tlsBad, slow, down]) noSecret(JSON.stringify(r), r.kind)
})

test('presentedChain: the presented CA (with its fingerprint); server without its CA → no CA; caFromPem refuses a leaf', async t => {
  const withCa = await fakePve(t)
  const chain = await presentedChain(withCa.url)
  assert.deepEqual(chain.map(c => c.ca), [false, true])
  assert.equal(chain[1].fingerprint256, caFromPem(withCa.caA).fingerprint256)
  const leafOnly = await fakePve(t, { chain: false })
  assert.deepEqual((await presentedChain(leafOnly.url)).map(c => c.ca), [false])
  assert.throws(() => caFromPem(chain[0].pem), /is not a CA/)
  assert.throws(() => caFromPem('pas un PEM'), /unreadable PEM file/)
  assert.equal(withCa.st.hits, 0, 'certificate read: no HTTP request')
})

test('testGitea: user and permissions (runners read:admin, repositories); 401; never the token in the messages', async t => {
  const g = await fakeGitea(t)
  const ok = await testGitea({ url: g.url, token: GITEA_TOKEN })
  assert.deepEqual([ok.ok, ok.login, ok.owner, ok.warnings], [true, 'dev-factice', 'dev-factice', []])
  const g2 = await fakeGitea(t, { runners: 403 })
  const w = await testGitea({ url: g2.url, token: GITEA_TOKEN, owner: 'autre' })
  assert.equal(w.owner, 'autre')
  assert.match(w.warnings.join(' '), /read:admin/)
  const bad = await testGitea({ url: g.url, token: 'faux' })
  assert.deepEqual([bad.ok, bad.kind], [false, 'auth'])
  noSecret(JSON.stringify([ok, w, bad]), 'gitea')
  assert.equal(maskUrl('https://user:pass@gitea.example.net:3000/x?token=abc'), 'https://gitea.example.net:3000/x')
})

// --- interactive wizard (scripted stdin) -----------------------------------------------------------

async function scripted(t, lines, { argv, keygen = fakeKeygen } = {}) {
  const input = new PassThrough()
  const out = sink()
  const errs = sink()
  input.end(`${lines.join('\n')}\n`)
  const code = await runInit({ argv, env: {}, input, output: out.stream, errOutput: errs.stream, tty: false, allowScripted: true, keygen })
  return { code, out: out.text(), err: errs.text() }
}

test('wizard: title, password (2nd attempt), network listening (names, networks, HTTP), Proxmox through fingerprint, Gitea, SSH key, summary then writing; no secret displayed', async t => {
  const pve = await fakePve(t)
  const g = await fakeGitea(t)
  const { d, args } = dirs(t)
  const r = await scripted(t, [
    'Banc interactif', // title
    '2', // interface language: French
    PASSWORD, 'autre chose', // 1st attempt: different confirmation
    PASSWORD, PASSWORD, // 2nd attempt
    '2', // listening: ::
    'vigie.example.net,192.0.2.148', // allowed names
    '127.0.0.1/32,192.0.2.0/24', // admin networks
    'n', // HTTP refused
    'o', // one Proxmox cluster
    'PVE de test', '', pve.url, '', 'vigie@pve!lecture', PVE_SECRET,
    '1', // presented CA
    'o', // fingerprint confirmed
    'n', // no other cluster
    'o', g.url, GITEA_TOKEN, '', // Gitea, default owner
    'o', // SSH key
    'o', // write
  ], { argv: args })
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /The two entries differ/)
  assert.match(r.out, /SHA-256 fingerprint: [0-9A-F:]{95}/)
  assert.match(r.out, /✓ Proxmox 8\.4\.1, nodes: pve-a, pve-b/)
  assert.match(r.out, /✓ logged in as dev-factice/)
  assert.match(r.out, /Summary \(no secret shown\)/)
  noSecret(r.out + r.err, 'assistant')
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'))
  assert.equal(parseConfig(cfg).errors, undefined)
  assert.equal(cfg.locale, 'fr', 'chosen language, written to the config')
  assert.deepEqual([cfg.title, cfg.listenHost, cfg.allowedHosts, cfg.security], ['Banc interactif', '::', ['vigie.example.net', '192.0.2.148'], { anonymousRead: false, httpLogin: false, adminCidrs: ['127.0.0.1/32', '192.0.2.0/24'] }])
  assert.deepEqual(cfg.proxmox, [{ id: 'pve-de-test', label: 'PVE de test', host: pve.url, env: 'PVE', ca: 'pki/pve-de-test.pem' }])
  // init writes the plugin block, plugins.gitea
  assert.deepEqual(cfg.plugins.gitea, { owner: 'dev-factice', repos: [] })
  assert.equal(cfg.gitea, undefined)
  const hash = fs.readFileSync(path.join(d, 'vigie.env'), 'utf8').match(/^ADMIN_PASSWORD_HASH=(.*)$/m)[1]
  assert.equal(await verifyPassword(PASSWORD, hash), true)
})

test('wizard: Proxmox test fails → fix then succeed; CA not presented → PEM file; abort at the summary → nothing written; closed input → clean failure', async t => {
  const leafOnly = await fakePve(t, { chain: false })
  const caFile = path.join(tmpDir('dash-p3b-ca-', t), 'pve-root-ca.pem')
  fs.writeFileSync(caFile, leafOnly.caA)
  const { d, args } = dirs(t)
  const r = await scripted(t, [
    '', '', PASSWORD, PASSWORD, '1', // default title and language (en), local listening
    'o', '', '', leafOnly.url, '', 'vigie@pve!lecture', 'mauvais-secret',
    '1', // presented CA: missing → back to the choice
    '2', caFile, 'o', // PEM file, fingerprint confirmed
    'c', // 401 → fix
    '', '', leafOnly.url, '', 'vigie@pve!lecture', PVE_SECRET, '2', caFile, 'o',
    'n', 'n', 'n', // no other cluster, no Gitea, no key
    'n', // do not write
  ], { argv: args })
  assert.equal(r.code, 2, r.out + r.err)
  assert.match(r.out, /The server does not present its CA/)
  assert.match(r.out, /✗ token refused \(401\)/)
  assert.match(r.out, /✓ Proxmox 8\.4\.1/)
  assert.match(r.out, /Nothing was written/)
  assert.equal(fs.existsSync(path.join(d, 'config.json')), false)
  noSecret(r.out + r.err, 'assistant')
  const cut = await scripted(t, ['Titre', '', PASSWORD], { argv: args })
  assert.equal(cut.code, 1)
  assert.match(cut.err, /input closed before the end of the questions/)
})

// --- real startup on the init output ---------------------------------------------------------------

test('real server startup on the config and the environment file written by init: admin login OK on the loopback', { timeout: 60_000 }, async t => {
  const { d, args } = dirs(t)
  assert.equal(await runInit({ argv: ['--yes', '--title', 'Banc démarré', ...args], env: { [SECRET_ENV.admin]: PASSWORD }, output: sink().stream, errOutput: sink().stream }), 0)
  const s = await bootServer(t, { config: JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')), env: { ENV_FILE: path.join(d, 'vigie.env') } })
  // init writes the locale; non-interactive without --locale: the product default, en
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')).locale, 'en')
  assert.deepEqual((await request(s.port, '/api/config')).json, { title: 'Banc démarré', locale: 'en' })
  assert.equal((await request(s.port, '/api/session')).json.configured, true)
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { origin: `http://127.0.0.1:${s.port}` } })
  assert.equal(login.status, 200, login.body)
  assert.match(s.logs(), /security: listenHost=127\.0\.0\.1 \(env\) ; anonymousRead=false \(config\) ; httpLogin=false \(config\) ; adminCidrs=127\.0\.0\.1\/32 \(config\)/)
})

// --- static ------------------------------------------------------------------------------------------

test('static: init missing from the CI and from the example unit; npm init script; admin-password.js reuses lib/cli.js; no secret option', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'deploy/vigie.service.example'), 'utf8')
  for (const f of CI_FILES) assert.doesNotMatch(readCi(f), /init\.js|npm run init|setup\.js/, f)
  assert.doesNotMatch(unit, /init\.js|npm run init|setup\.js/)
  assert.match(JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8')).scripts.init, /scripts\/init\.js/)
  const ap = fs.readFileSync(path.join(SERVER, 'scripts/admin-password.js'), 'utf8')
  assert.match(ap, /from '\.\.\/lib\/cli\.js'/)
  assert.doesNotMatch(ap, /setRawMode|function ask\(/)
  const src = fs.readFileSync(path.join(SERVER, 'lib/setup.js'), 'utf8')
  const opts = src.slice(src.indexOf('const OPTIONS = {'), src.indexOf('export const USAGE'))
  assert.doesNotMatch(opts.replace(/'pve-token-id'|'secrets-stdin'|'pve-allow-http'/g, ''), /password|secret|token/i)
  // a single place without verification: reading the presented certificate (presentedChain), without a request
  assert.equal((src.match(/rejectUnauthorized: false/g) || []).length, 1)
  const chainFn = src.slice(src.indexOf('export function presentedChain('), src.indexOf('// bounded test request'))
  assert.match(chainFn, /rejectUnauthorized: false/)
  assert.doesNotMatch(chainFn, /fetch|Authorization|write\(/)
})

test('masked terminal input (fake TTY): raw mode, nothing displayed, backspace; Ctrl-C → interruption; raw mode always restored', async () => {
  const input = new PassThrough()
  const raw = []
  input.isTTY = true
  input.setRawMode = v => raw.push(v)
  const out = sink()
  const p = createPrompter({ input, output: out.stream })
  const got = p.secret('Secret')
  input.write('abcX\u007fdef\r')
  assert.equal(await got, 'abcdef')
  assert.deepEqual(raw, [true, false])
  assert.equal(out.text(), 'Secret : \n', 'neither the input nor asterisks')
  const name = p.line('Nom', 'défaut')
  input.write('\n')
  assert.equal(await name, 'défaut')
  const cut = p.secret('Autre')
  input.write('ab\u0003')
  await assert.rejects(cut, Aborted)
  assert.deepEqual(raw, [true, false, true, false])
  p.close()
})

// --- fixes ---------------------------------------------------------------------------------------

test('no value copied into argument errors (positional, unknown option, glued value, validations)', async () => {
  const SEKRET = 'SEKRET-mal-place-42'
  const cases = [
    ['--non-interactive', '--listen', '0.0.0.0', SEKRET],
    ['--pve-token-id', 'u@pve!n', SEKRET],
    [`--inconnue=${SEKRET}`],
    [`-x${SEKRET}`],
    [`--force=${SEKRET}`],
    ['--title'],
  ]
  for (const argv of cases) {
    const errs = sink()
    assert.equal(await runInit({ argv, env: {}, output: sink().stream, errOutput: errs.stream }), 1, argv.join(' '))
    assert.ok(!errs.text().includes(SEKRET), `${argv.join(' ')} → ${errs.text()}`)
    assert.match(errs.text(), /see --help/)
  }
  assert.throws(() => parseInitArgs(['positionnel']), /positional argument refused \(value not shown\)/)
  assert.throws(() => parseInitArgs([`--inconnue=${SEKRET}`]), /unknown option \(name not shown\); see --help/)
  // validations: never the received value
  const { d, args } = dirs({ after() {} })
  for (const extra of [['--listen', SEKRET + '/x'], ['--allowed-hosts', `ok.example,${SEKRET}:80`], ['--admin-cidrs', `127.0.0.1/32,${SEKRET}`], ['--pve-url', `http://127.0.0.1:9`, '--pve-token-id', `${SEKRET}`]]) {
    const errs = sink()
    assert.equal(await runInit({ argv: ['--yes', ...args, ...extra], env: { [SECRET_ENV.admin]: PASSWORD }, output: sink().stream, errOutput: errs.stream }), 1, extra.join(' '))
    assert.ok(!errs.text().includes(SEKRET), `${extra.join(' ')} → ${errs.text()}`)
  }
  fs.rmSync(d, { recursive: true, force: true })
})

test('--pve-ca and --pve-ca-fingerprint together refused; --timeout out of bounds refused; --secrets-stdin outside non-interactive mode refused', () => {
  assert.throws(() => parseInitArgs(['--pve-ca', 'x.pem', '--pve-ca-fingerprint', '00:11']), /one or the other, not both/)
  for (const v of ['abc', '0', '-3', '301', 'NaN', '']) assert.throws(() => parseInitArgs([`--timeout=${v}`]), /--timeout: number of seconds expected, from 1 to 300/, v)
  assert.equal(parseInitArgs(['--timeout', '30']).timeout, '30')
  assert.throws(() => parseInitArgs(['--secrets-stdin']), /only applies in non-interactive mode/)
  assert.equal(parseInitArgs(['--yes', '--secrets-stdin'])['secrets-stdin'], true)
})

test('path safeguard after resolving links (variable or default to a simulated system folder, and to the real /etc); ssh folder included', async t => {
  const base = tmpDir('dash-p3b-liens-', t)
  const sys = path.join(base, 'systeme')
  fs.mkdirSync(path.join(sys, 'instance'), { recursive: true })
  const work = path.join(base, 'travail')
  fs.mkdirSync(work)
  fs.symlinkSync(sys, path.join(work, 'lien'))
  fs.symlinkSync(path.join(sys, 'instance'), path.join(work, 'data'))
  fs.symlinkSync(path.join(sys, 'absent.json'), path.join(work, 'casse.json'))
  const opt = { root: work, serverDir: path.join(work, 'server'), systemDirs: [sys] }
  const refused = env => assert.throws(() => resolvePaths({}, env, opt), /leads, through a link\) in a system path/, JSON.stringify(env))
  refused({ ENV_FILE: path.join(work, 'lien/x.env'), CONFIG_PATH: path.join(work, 'c.json'), STATE_DIRECTORY: path.join(work, 'st') })
  refused({ CONFIG_PATH: path.join(work, 'lien/pas/encore/cree/config.json'), STATE_DIRECTORY: path.join(work, 'st') })
  refused({ CONFIG_PATH: path.join(work, 'casse.json'), STATE_DIRECTORY: path.join(work, 'st') }, 'lien cassé')
  refused({ PKI_DIR: path.join(work, 'lien/pki'), STATE_DIRECTORY: path.join(work, 'st') })
  // default: <root>/data as a link to the state folder of an instance (SSH key included)
  refused({})
  // explicit: allowed; without a link: allowed
  assert.equal(resolvePaths({ env: path.join(work, 'lien/x.env'), state: path.join(work, 'st') }, {}, opt).env, path.join(work, 'lien/x.env'))
  assert.equal(resolvePaths({}, { STATE_DIRECTORY: path.join(work, 'st') }, opt).config, path.join(work, 'config.json'))
  // real /etc (no write attempted: refused before)
  const etcLink = path.join(base, 'etc-lien')
  fs.symlinkSync('/etc', etcLink)
  const { args } = dirs(t)
  const errs = sink()
  const argv = ['--yes', ...args.filter((x, i) => args[i - 1] !== '--env' && x !== '--env')]
  assert.equal(await runInit({ argv, env: { ENV_FILE: path.join(etcLink, 'vigie-essai.env'), [SECRET_ENV.admin]: PASSWORD }, output: sink().stream, errOutput: errs.stream }), 1)
  assert.match(errs.text(), /env: .* system path/)
  assert.equal(fs.existsSync('/etc/vigie-essai.env'), false)
})

test('Proxmox over http in non-interactive mode refused without --pve-allow-http; with it, "token in clear text" warning', async t => {
  const { args } = dirs(t)
  const env = { [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.pve]: PVE_SECRET }
  const errs = sink()
  assert.equal(await runInit({ argv: ['--yes', '--skip-tests', '--pve-url', 'http://127.0.0.1:9', '--pve-token-id', 'vigie@pve!lecture', ...args], env, output: sink().stream, errOutput: errs.stream }), 1)
  assert.match(errs.text(), /Proxmox over http: the token would travel in clear text; https recommended, otherwise --pve-allow-http/)
  const out = sink()
  assert.equal(await runInit({ argv: ['--yes', '--skip-tests', '--pve-allow-http', '--pve-url', 'http://127.0.0.1:9', '--pve-token-id', 'vigie@pve!lecture', ...args], env, output: out.stream, errOutput: sink().stream }), 0)
  assert.match(out.text(), /⚠ Proxmox over http: token in clear text on the network/)
})

test('remarks: TOKEN_ID without "=" or control characters; CA and key collisions before the questions; open listening without a name → warning; leaf PEM then CA → message', async t => {
  const { d, args } = dirs(t)
  const env = { [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.pve]: PVE_SECRET }
  for (const id of ['vigie@pve!lecture=SECRET', 'vigie@pve!lec\u0001ture']) {
    const errs = sink()
    assert.equal(await runInit({ argv: ['--yes', '--skip-tests', '--pve-allow-http', '--pve-url', 'http://127.0.0.1:9', '--pve-token-id', id, ...args], env, output: sink().stream, errOutput: errs.stream }), 1)
    assert.match(errs.text(), /--pve-token-id .* missing/)
    assert.ok(!errs.text().includes('SECRET'))
  }
  // collisions detected before any question
  fs.mkdirSync(path.join(d, 'pki'), { recursive: true })
  fs.writeFileSync(path.join(d, 'pki/pve.pem'), 'existant')
  const e1 = sink()
  assert.equal(await runInit({ argv: ['--yes', '--pve-url', 'https://127.0.0.1:9', '--pve-token-id', 'vigie@pve!lecture', '--pve-ca', '/inexistant.pem', ...args], env, output: sink().stream, errOutput: e1.stream }), 1)
  assert.match(e1.text(), /already present: .*pki\/pve\.pem/)
  fs.mkdirSync(path.join(d, 'state/ssh'), { recursive: true })
  fs.writeFileSync(path.join(d, 'state/ssh/id_ed25519'), 'clé existante')
  const e2 = sink()
  assert.equal(await runInit({ argv: ['--yes', '--ssh-key', ...args], env, output: sink().stream, errOutput: e2.stream }), 1)
  assert.match(e2.text(), /already present: .*id_ed25519/)
  // interactive: identifier whose CA exists → another identifier asked; existing key kept
  const pve = await fakePve(t)
  const r = await scripted(t, ['', '', PASSWORD, PASSWORD, '1', 'o', 'PVE', 'pve', 'pve2', pve.url, '', 'vigie@pve!lecture', PVE_SECRET, '1', 'o', 'n', 'n', 'o', 'o'], { argv: args })
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /pki\/pve\.pem already exists: another id, or --force/)
  assert.match(r.out, /id_ed25519 already exists: kept as is/)
  assert.equal(fs.readFileSync(path.join(d, 'state/ssh/id_ed25519'), 'utf8'), 'clé existante')
  // open listening without an allowed name: warning
  const d2 = dirs(t)
  const out = sink()
  assert.equal(await runInit({ argv: ['--yes', '--listen', '::', ...d2.args], env, output: out.stream, errOutput: sink().stream }), 0)
  assert.match(out.text(), /⚠ no allowed name \(allowedHosts\)/)
  // leaf PEM then CA
  const f = tlsFixtures()
  const both = fs.readFileSync(path.join(f, 'leaf-a.pem'), 'utf8') + fs.readFileSync(path.join(f, 'pki/ca-a.pem'), 'utf8')
  assert.throws(() => caFromPem(both), /several certificates and the first one is not a CA: keep only the CA one/)
})

test('remarks: write failure → no .tmp left, message about what is already written; order CA, key, env, config', async t => {
  const { d, args } = dirs(t)
  const env = { [SECRET_ENV.admin]: PASSWORD }
  // the env targets a read-only folder: the config (written last) must not exist
  const ro = path.join(d, 'lecture-seule')
  fs.mkdirSync(ro, { mode: 0o555 })
  t.after(() => { try { fs.chmodSync(ro, 0o755) } catch { /* already removed */ } })
  const argv = ['--yes', '--ssh-key', '--config', path.join(d, 'config.json'), '--env', path.join(ro, 'vigie.env'), '--state', path.join(d, 'state')]
  const errs = sink()
  const code = await runInit({ argv, env, output: sink().stream, errOutput: errs.stream, keygen: fakeKeygen })
  if (process.getuid?.() === 0) return // root writes everywhere: the case does not happen
  assert.equal(code, 1)
  assert.match(errs.text(), /cannot write .*vigie\.env \(EACCES\); already written: .*id_ed25519/)
  assert.equal(fs.existsSync(path.join(d, 'config.json')), false, 'config written last')
  assert.deepEqual(fs.readdirSync(ro), [], 'no temporary file')
  assert.equal(args.length, 8)
})

test('terminal input: Ctrl-D → closed input; arrows and special keys ignored in a secret', async () => {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  const p = createPrompter({ input, output: sink().stream })
  const a = p.secret('Secret')
  input.write('ab\u001b[Acd\u001bOB\u001b[3~e\r')
  assert.equal(await a, 'abcde')
  const b = p.secret('Autre')
  input.write('zz\u0004')
  await assert.rejects(b, InputClosed)
  p.close()
})

test('config.example.json starts as is (with nothing else); README about init without options and the systemd installation', { timeout: 60_000 }, async t => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))
  const s = await bootServer(t, { config: example })
  assert.equal((await request(s.port, '/api/healthz')).status, 200)
  // the example sets the locale explicitly (en, the product default)
  assert.deepEqual((await request(s.port, '/api/config')).json, { title: 'Vigie', subtitle: 'Local example', locale: 'en' })
  assert.match(s.logs(), /security: listenHost=127\.0\.0\.1 \(env\) ; anonymousRead=false \(config\)/)
  assert.doesNotMatch(s.logs(), /invalide|Error/)
  // the installation doc moved from the README to docs/installation.md (in English)
  const doc = fs.readFileSync(path.join(ROOT, 'docs/installation.md'), 'utf8')
  assert.match(doc, /without options, writes `<root>\/\.env`/)
  assert.match(doc, /systemd installation: always `--config` and `--env`/)
})

// --- last review -------------------------------------------------------------------------------------

test('file path never copied (--pve-ca, PEM asked by the wizard); catch-all reduced to the error code', async t => {
  const SEKRET = 'SEKRET-dans-un-chemin-77'
  const { args } = dirs(t)
  const errs = sink()
  const env = { [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.pve]: PVE_SECRET }
  assert.equal(await runInit({ argv: ['--yes', '--pve-url', 'https://127.0.0.1:9', '--pve-token-id', 'vigie@pve!lecture', '--pve-ca', `/nonexistent/${SEKRET}.pem`, ...args], env, output: sink().stream, errOutput: errs.stream }), 1)
  assert.match(errs.text(), /--pve-ca file unreadable \(ENOENT\)/)
  assert.ok(!errs.text().includes(SEKRET), errs.text())
  // wizard: nonexistent PEM file, then cluster abandoned
  const r = await scripted(t, ['', '', PASSWORD, PASSWORD, '1', 'o', '', '', 'https://127.0.0.1:9', '', 'vigie@pve!lecture', PVE_SECRET, '2', `/nonexistent/${SEKRET}.pem`, 'n', 'n', 'n', 'n', 'n', 'n'], { argv: args })
  assert.match(r.out, /CA file unreadable \(ENOENT\)/)
  assert.ok(!(r.out + r.err).includes(SEKRET))
  const src = fs.readFileSync(path.join(SERVER, 'lib/setup.js'), 'utf8')
  assert.match(src, /`unexpected error \(\$\{errCode\(e\)\}\)`/)
  assert.doesNotMatch(src, /unexpected error[^\n]*e\?\.message/)
  assert.doesNotMatch(src.replace(/function readUserFile[\s\S]*?\n}\n/, ''), /readFileSync\(path\.resolve\(/, 'every read of a received path goes through readUserFile')
})

test('unknown option never copied, even when it looks like a secret', async () => {
  for (const a of ['--SEKRETunknown', '--SEKRET9x=valeur', '-Z', '--SEKRETtoken=abc', '--motSEKRETpassword']) {
    const errs = sink()
    assert.equal(await runInit({ argv: [a], env: {}, output: sink().stream, errOutput: errs.stream }), 1, a)
    assert.ok(!errs.text().includes('SEKRET') && !errs.text().includes(a.split('=')[0]), `${a} → ${errs.text()}`)
    assert.match(errs.text(), /unknown option \(name not shown\); see --help|an option looks like a secret \(name not shown\)/)
  }
})

test('race: path safeguard replayed right before writing; a link set during the wizard to a system path is refused, nothing written', async t => {
  const base = tmpDir('dash-p3b-course-', t)
  const sys = path.join(base, 'systeme')
  const work = path.join(base, 'travail')
  fs.mkdirSync(sys)
  fs.mkdirSync(work)
  // the env folder does not exist at the start; the fake Gitea, queried during the wizard, sets
  // the link work/vigie → "system" folder (like a local user between two questions)
  const fetch = async url => {
    if (!fs.existsSync(path.join(work, 'vigie'))) fs.symlinkSync(sys, path.join(work, 'vigie'))
    return new Response(String(url).endsWith('/api/v1/user') ? JSON.stringify({ login: 'dev-factice' }) : '[]', { status: 200 })
  }
  const env = { ENV_FILE: path.join(work, 'vigie/env'), CONFIG_PATH: path.join(work, 'config.json'), STATE_DIRECTORY: path.join(work, 'state'), PKI_DIR: path.join(work, 'pki'), [SECRET_ENV.admin]: PASSWORD, [SECRET_ENV.gitea]: GITEA_TOKEN }
  const errs = sink()
  const code = await runInit({ argv: ['--yes', '--gitea-url', 'http://127.0.0.1:9'], env, fetch, systemDirs: [sys], output: sink().stream, errOutput: errs.stream })
  assert.equal(code, 1)
  assert.match(errs.text(), /env: .*leads, through a link\) in a system path/)
  assert.deepEqual(fs.readdirSync(sys), [], 'nothing written in the system directory')
  assert.equal(fs.existsSync(path.join(work, 'config.json')), false)
  // without a link set in the meantime: written normally
  fs.unlinkSync(path.join(work, 'vigie'))
  fs.mkdirSync(path.join(work, 'vigie'))
  assert.equal(await runInit({ argv: ['--yes', '--gitea-url', 'http://127.0.0.1:9'], env, fetch: async url => new Response(String(url).endsWith('/api/v1/user') ? '{"login":"dev-factice"}' : '[]', { status: 200 }), systemDirs: [sys], output: sink().stream, errOutput: sink().stream }), 0)
  assert.ok(fs.existsSync(path.join(work, 'vigie/env')))
})
