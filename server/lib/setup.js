// Installation wizard (scripts/init.js). Writes a minimal valid config, the environment
// file (0600) with the admin hash and the secrets, the pinned CAs, and, optionally, the agent's
// SSH key. Two modes:
//   - interactive (terminal, the default): questions, connection tests, summary before writing;
//   - non-interactive (--non-interactive or --yes): options only, secrets through VIGIE_INIT_*
//     environment variables or --secrets-stdin, NEVER as an argument; no question.
// Safeguards: refuses to overwrite without --force; never writes to a system path (/etc,
// /var/lib: those of a running instance, for example coming from CONFIG_PATH or ENV_FILE) without
// an explicit option; no secret in output, errors or logs.
//
// Proxmox TLS (proxmox[].ca "pki/<id>.pem", PKI_DIR folder): the CA is either a provided PEM
// file (for example /etc/pve/pve-root-ca.pem copied from the node), or the CA presented by the
// server, kept only after the user compares its SHA-256 fingerprint
// (interactive) or against --pve-ca-fingerprint (non-interactive). The presented certificate is
// read without verification, explicitly, and sends NO secret; the test call, on the other hand, goes
// through the server's pinned agent (lib/tls.js), as in production. Never a permissive fallback.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { parseArgs } from 'node:util'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { fetch as uFetch } from 'undici'
import { LOCALES, DEFAULT_LOCALE } from './i18n.js'
import { createPrompter, askAdminPassword, adminPasswordProblem, Aborted, InputClosed } from './cli.js'
import { hashPassword, parseCidrs } from './auth.js'
import { agentFor, tlsErrorCode } from './tls.js'
import { parseConfig } from './config.js'
import { withUserAgent } from './http.js'

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT_DIR = path.resolve(SERVER_DIR, '..')
export const SECRET_ENV = Object.freeze({ admin: 'VIGIE_INIT_ADMIN_PASSWORD', pve: 'VIGIE_INIT_PVE_TOKEN_SECRET', gitea: 'VIGIE_INIT_GITEA_TOKEN' })
const SYSTEM_DIRS = ['/etc', '/var/lib']
const DEFAULT_TIMEOUT_MS = 10_000
const ID = /^[a-z0-9][a-z0-9-]*$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
// no space, @, !, = nor control character (a "=" would end a secret on the TOKEN_ID line)
const TOKEN_ID = /^[^\s@!=\u0000-\u001f\u007f]+@[^\s@!=\u0000-\u001f\u007f]+![^\s@!=\u0000-\u001f\u007f]+$/
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

export class InitError extends Error {}

// --- options --------------------------------------------------------------------------------------

const OPTIONS = {
  config: { type: 'string' }, env: { type: 'string' }, pki: { type: 'string' }, state: { type: 'string' },
  force: { type: 'boolean' }, 'non-interactive': { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  title: { type: 'string' }, locale: { type: 'string' }, listen: { type: 'string' }, 'allowed-hosts': { type: 'string' }, 'admin-cidrs': { type: 'string' }, 'http-login': { type: 'boolean' },
  'pve-url': { type: 'string' }, 'pve-name': { type: 'string' }, 'pve-id': { type: 'string' }, 'pve-env': { type: 'string' }, 'pve-token-id': { type: 'string' },
  'pve-ca': { type: 'string' }, 'pve-ca-fingerprint': { type: 'string' },
  'gitea-url': { type: 'string' }, 'gitea-owner': { type: 'string' },
  'ssh-key': { type: 'boolean' }, 'skip-tests': { type: 'boolean' }, 'keep-failed': { type: 'boolean' }, 'secrets-stdin': { type: 'boolean' },
  'pve-allow-http': { type: 'boolean' },
  timeout: { type: 'string' },
}
export const USAGE = `Usage: npm run init -- [options]   (from server/)

Interactive wizard by default (terminal required). Non-interactive mode (Docker, scripts):
  --non-interactive | --yes       no question; a missing required value = failure
Paths (defaults: config.json and .env at the root, server/pki, <root>/data):
  --config <file> --env <file> --pki <directory> --state <directory> --force
Instance: --title <text> --locale <en|fr> (default en) --listen <address> --allowed-hosts <a,b> --admin-cidrs <c1,c2> --http-login
Proxmox:  --pve-url <url> --pve-name <label> --pve-id <id> --pve-env <PREFIX> --pve-token-id <user@realm!name>
          --pve-ca <PEM file> | --pve-ca-fingerprint <SHA-256 fingerprint of the presented CA>
Gitea:    --gitea-url <url> --gitea-owner <owner>
          --pve-allow-http (Proxmox over http: token in clear text, refused without this option)
Other:    --ssh-key --skip-tests --keep-failed --timeout <seconds, 1 to 300>
Secrets (never as arguments): variables ${SECRET_ENV.admin}, ${SECRET_ENV.pve},
  ${SECRET_ENV.gitea}, or --secrets-stdin (NAME=value lines with these names).`

export function parseInitArgs(argv) {
  for (const a of argv) {
    if (/^--?[^=]*(password|passwd|secret|token)(?!-id)/i.test(a) && !/^--secrets-stdin$/.test(a)) {
      throw new InitError(`an option looks like a secret (name not shown): secrets are never passed as arguments (variables ${Object.values(SECRET_ENV).join(', ')} or --secrets-stdin)`)
    }
  }
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false })
  } catch (e) {
    // parseArgs messages sometimes quote the value ("Unexpected argument 'X'"): a misplaced
    // secret would end up in the error output or a CI log. Clean messages, without any value
    const msg = e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' ? 'positional argument refused (value not shown)'
      : e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unknown option (name not shown)'
        : e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 'option without its value, or a value given to an option that takes none'
          : 'invalid arguments'
    throw new InitError(`${msg}; see --help`)
  }
  const v = parsed.values
  if (v.locale !== undefined && !LOCALES.includes(v.locale)) throw new InitError(`--locale: ${LOCALES.join(' or ')} expected`)
  if (v['pve-ca'] && v['pve-ca-fingerprint']) throw new InitError('--pve-ca and --pve-ca-fingerprint: one or the other, not both')
  if (v.timeout !== undefined) {
    const n = Number(v.timeout)
    if (!Number.isFinite(n) || n < 1 || n > 300) throw new InitError('--timeout: number of seconds expected, from 1 to 300')
  }
  if (v['secrets-stdin'] && !v['non-interactive'] && !v.yes) throw new InitError('--secrets-stdin only applies in non-interactive mode (--non-interactive or --yes)')
  return v
}

// --- paths -----------------------------------------------------------------------------------------

const nonEmpty = v => typeof v === 'string' && v.trim() !== ''
// real path: realpath of the closest existing parent (symbolic links resolved, including a
// broken link or a folder not created yet), then the rest of the path
export function realTarget(p, depth = 0) {
  let cur = path.resolve(p)
  const rest = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest)
    } catch {
      // broken link: follow its target (relative to its folder), without an infinite loop
      let link = null
      try { if (fs.lstatSync(cur).isSymbolicLink()) link = fs.readlinkSync(cur) } catch { /* missing */ }
      if (link != null && depth < 40) return realTarget(path.join(path.resolve(path.dirname(cur), link), ...rest), depth + 1)
      const up = path.dirname(cur)
      if (up === cur) return path.join(cur, ...rest)
      rest.unshift(path.basename(cur))
      cur = up
    }
  }
}
const realDir = d => { try { return fs.realpathSync(d) } catch { return d } }
const inside = (p, d) => p === d || p.startsWith(`${d}/`)

// systemDirs injectable (tests: simulated "system" folder)
export function resolvePaths(opts, env = {}, { root = ROOT_DIR, serverDir = SERVER_DIR, systemDirs = SYSTEM_DIRS } = {}) {
  const pick = (flag, envValue, def) => (nonEmpty(opts[flag]) ? { p: path.resolve(opts[flag]), explicit: true } : nonEmpty(envValue) ? { p: path.resolve(envValue), explicit: false } : { p: def, explicit: false })
  const out = {
    config: pick('config', env.CONFIG_PATH, path.join(root, 'config.json')),
    env: pick('env', env.ENV_FILE && env.ENV_FILE !== 'none' ? env.ENV_FILE : '', path.join(root, '.env')),
    pki: pick('pki', env.PKI_DIR, path.join(serverDir, 'pki')),
    state: pick('state', env.STATE_DIRECTORY, path.join(root, 'data')),
  }
  // paths coming from a variable or defaults: compared AFTER resolving links (a link to /etc
  // or to the state folder of an instance does not pass); ssh folder included (inside state)
  const sys = systemDirs.flatMap(d => [d, realDir(d)])
  for (const [k, v] of Object.entries(out)) {
    if (v.explicit) continue
    const targets = k === 'state' ? [v.p, path.join(v.p, 'ssh')] : [v.p]
    if (targets.some(t => sys.some(d => inside(t, d) || inside(realTarget(t), d)))) {
      throw new InitError(`${k}: ${v.p} is (or leads, through a link) in a system path (instance in service?); give it explicitly (--${k}) to write there`)
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.p]))
}

// --- utilities -------------------------------------------------------------------------------------

// displayable URL: without credentials (user:pass@) nor query
export function maskUrl(u) {
  try {
    const x = new URL(u)
    x.username = ''
    x.password = ''
    x.search = ''
    return x.toString().replace(/\/$/, '')
  } catch {
    return '(invalid URL)'
  }
}
const toPem = raw => `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pve'
const errCode = e => String(e?.cause?.code || e?.code || e?.name || 'error')

// CA of a PEM (text) → { pem, subject, validTo, fingerprint256 }; otherwise InitError
export function caFromPem(pem, now = Date.now()) {
  let cert
  try {
    cert = new X509Certificate(pem)
  } catch {
    throw new InitError('unreadable PEM file (X.509 certificate expected)')
  }
  if (!cert.ca) {
    const many = (String(pem).match(/-----BEGIN CERTIFICATE-----/g) || []).length > 1
    throw new InitError(many ? 'the file holds several certificates and the first one is not a CA: keep only the CA one' : `this certificate is not a CA (${cert.subject.replace(/\n/g, ', ')})`)
  }
  if (!(new Date(cert.validTo).getTime() > now)) throw new InitError('this CA has expired')
  return { pem: cert.toString(), subject: cert.subject.replace(/\n/g, ', '), validTo: cert.validTo, fingerprint256: cert.fingerprint256 }
}
// file designated by an option or an answer: never its path in a message (it may carry
// a misplaced secret), only the error code
function readUserFile(file, what) {
  try {
    return fs.readFileSync(path.resolve(file), 'utf8')
  } catch (e) {
    throw new InitError(`${what} file unreadable (${errCode(e)})`)
  }
}
const normFp = s => String(s ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase()

// chain presented by a TLS server, read WITHOUT verification (no request, no secret):
// → [{ subject, issuer, ca, selfSigned, fingerprint256, pem }]
export function presentedChain(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const u = new URL(url)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const port = Number(u.port || 443)
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
    const timer = setTimeout(() => { sock.destroy(); reject(new InitError(`no TLS answer in ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
    sock.once('secureConnect', () => {
      clearTimeout(timer)
      const out = []
      const seen = new Set()
      let c = sock.getPeerCertificate(true)
      while (c && c.raw && !seen.has(c.fingerprint256)) {
        seen.add(c.fingerprint256)
        const x = new X509Certificate(c.raw)
        out.push({ subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.replace(/\n/g, ', '), ca: x.ca, selfSigned: x.subject === x.issuer, fingerprint256: x.fingerprint256, validTo: x.validTo, pem: toPem(c.raw) })
        c = c.issuerCertificate
      }
      sock.destroy()
      resolve(out)
    })
    sock.once('error', e => { clearTimeout(timer); reject(new InitError(`TLS connection failed (${errCode(e)})`)) })
  })
}

// bounded test request → { status, json }; classified errors, never the secret nor the header
async function probe(url, headers, { ca = null, timeoutMs, fetch }) {
  let r
  try {
    r = await fetch(url, { headers: withUserAgent(headers), dispatcher: agentFor(url, { secret: true, ca }), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const tlsCode = tlsErrorCode(e)
    if (tlsCode) return { kind: 'tls', message: `certificate not recognised (${tlsCode})${ca ? ' by the chosen CA' : ''}: the secret was not sent` }
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { kind: 'timeout', message: `no answer in ${Math.round(timeoutMs / 1000)} s` }
    return { kind: 'network', message: `unreachable (${errCode(e)})` }
  }
  let json = null
  try {
    json = await r.json()
  } catch { /* non-JSON body */ }
  return { status: r.status, json }
}

// Proxmox: version and nodes → { ok, version, nodes } or { ok: false, kind, message }
export async function testProxmox({ url, tokenId, tokenSecret, caPem = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetch = uFetch }) {
  const base = url.replace(/\/+$/, '')
  const headers = { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` }
  const v = await probe(`${base}/api2/json/version`, headers, { ca: caPem, timeoutMs, fetch })
  if (v.kind) return { ok: false, ...v }
  if (v.status === 401 || v.status === 403) return { ok: false, kind: 'auth', message: `token refused (${v.status}): check the id, the secret and the permissions (PVEAuditor)` }
  if (v.status !== 200 || !v.json?.data) return { ok: false, kind: 'http', message: `unexpected answer (HTTP ${v.status})` }
  const n = await probe(`${base}/api2/json/nodes`, headers, { ca: caPem, timeoutMs, fetch })
  const nodes = n.status === 200 && Array.isArray(n.json?.data) ? n.json.data.map(x => String(x.node)).sort() : []
  return { ok: true, version: String(v.json.data.version ?? '?'), nodes, warnings: n.status === 200 ? [] : ['node list unreadable (Sys.Audit permission?)'] }
}

// Gitea: user, then useful permissions (runners: read:admin; repositories: read:repository)
export async function testGitea({ url, token, owner = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetch = uFetch }) {
  const base = url.replace(/\/+$/, '')
  const headers = { Authorization: `token ${token}` }
  const me = await probe(`${base}/api/v1/user`, headers, { timeoutMs, fetch })
  if (me.kind) return { ok: false, ...me }
  if (me.status === 401 || me.status === 403) return { ok: false, kind: 'auth', message: `token refused (${me.status}): read:user permission required` }
  if (me.status !== 200 || !me.json?.login) return { ok: false, kind: 'http', message: `unexpected answer (HTTP ${me.status})` }
  const login = String(me.json.login)
  const who = owner || login
  const warnings = []
  const runners = await probe(`${base}/api/v1/admin/actions/runners`, headers, { timeoutMs, fetch })
  if (runners.status !== 200) warnings.push(`runners unreadable (${runners.kind ? runners.message : `HTTP ${runners.status}`}): read:admin permission required, the CI view will not have the runners`)
  const repos = await probe(`${base}/api/v1/users/${encodeURIComponent(who)}/repos?limit=1`, headers, { timeoutMs, fetch })
  if (repos.status !== 200) warnings.push(`repositories of "${who}" unreadable (${repos.kind ? repos.message : `HTTP ${repos.status}`}): read:repository permission required`)
  return { ok: true, login, owner: who, warnings }
}

// --- config and files ------------------------------------------------------------------------------

export function buildConfig(a) {
  return {
    version: 2,
    title: a.title,
    locale: a.locale ?? DEFAULT_LOCALE,
    listenHost: a.listen,
    ...(a.allowedHosts?.length ? { allowedHosts: a.allowedHosts } : {}),
    security: { anonymousRead: false, httpLogin: !!a.httpLogin, adminCidrs: a.adminCidrs },
    proxmox: a.proxmox.map(c => ({ id: c.id, label: c.label, host: c.url, env: c.env, ...(c.caPem ? { ca: `pki/${c.id}.pem` } : {}) })),
    hosts: [],
    groups: [],
    services: [],
    ...(a.gitea ? { plugins: { gitea: { owner: a.gitea.owner, repos: [] } } } : {}),
    alerts: {},
  }
}
const envLine = (k, v) => {
  if (/[\u0000-\u001f\u007f]/.test(String(v))) throw new InitError(`${k}: control characters refused`)
  return `${k}=${v}`
}
export function buildEnv(a, now = new Date()) {
  const lines = [`# Vigie: written by init on ${now.toISOString().slice(0, 10)} (0600, never committed)`, envLine('ADMIN_PASSWORD_HASH', a.hash)]
  for (const c of a.proxmox) lines.push(envLine(`${c.env}_TOKEN_ID`, c.tokenId), envLine(`${c.env}_TOKEN_SECRET`, c.tokenSecret))
  if (a.gitea) lines.push(envLine('GITEA_URL', a.gitea.url.replace(/\/+$/, '')), envLine('GITEA_TOKEN', a.gitea.token))
  return `${lines.join('\n')}\n`
}

// atomic write: temporary file in the same folder (mode given at creation), then rename
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'wx', mode)
    try {
      fs.writeSync(fd, text)
      fs.fchmodSync(fd, mode)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true }) // never leave a temporary file (secrets included) behind
    throw e
  }
}

// already present (link included)?
export const exists = f => { try { fs.lstatSync(f); return true } catch { return false } }
export function checkTargets(paths, { force, pemNames = [], sshKey = false }) {
  const busy = [paths.config, paths.env, ...pemNames.map(n => path.join(paths.pki, n)), ...(sshKey ? [path.join(paths.state, 'ssh', 'id_ed25519')] : [])]
    .filter(exists)
  if (busy.length && !force) throw new InitError(`already present: ${busy.join(', ')} (--force to overwrite)`)
}

function sshKeygen(file) {
  return new Promise((resolve, reject) => {
    execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'vigie-agent', '-f', file], { timeout: 15_000 }, e => (e ? reject(new InitError(`ssh-keygen: ${e.code === 'ENOENT' ? 'not found (openssh-client package)' : errCode(e)}`)) : resolve()))
  })
}

// safe order: CA, then SSH key, then environment file, then config LAST (a present config
// means that everything else is). No transaction across files: on failure,
// the message says what was already written; no temporary file is left (writeAtomic)
// recheck: resolvePaths replayed right before writing (questions may take time: a link set in the
// meantime to a system path is refused); same expected paths
export async function writeAll(paths, a, { force = false, keygen = sshKeygen, recheck = null } = {}) {
  if (recheck) {
    const now = recheck()
    if (Object.keys(paths).some(k => now[k] !== paths[k])) throw new InitError('paths changed since the wizard started: nothing was written')
  }
  const cfg = buildConfig(a)
  const parsed = parseConfig(cfg)
  if (parsed.errors) throw new InitError(`generated config invalid: ${parsed.errors.join('; ')}`)
  checkTargets(paths, { force, pemNames: a.proxmox.filter(c => c.caPem).map(c => `${c.id}.pem`), sshKey: a.sshKey })
  const written = []
  const step = async (what, fn) => {
    try {
      await fn()
      written.push(what)
    } catch (e) {
      throw new InitError(`cannot write ${what} (${e instanceof InitError ? e.message : errCode(e)}); already written: ${written.length ? written.join(', ') : 'nothing'}`)
    }
  }
  for (const c of a.proxmox.filter(x => x.caPem)) {
    const f = path.join(paths.pki, `${c.id}.pem`)
    await step(f, () => writeAtomic(f, c.caPem, 0o644))
  }
  let pub = null
  if (a.sshKey) {
    const dir = path.join(paths.state, 'ssh')
    const key = path.join(dir, 'id_ed25519')
    await step(key, async () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dir, 0o700)
      for (const f of [key, `${key}.pub`]) if (force) fs.rmSync(f, { force: true })
      await keygen(key)
      const kh = path.join(dir, 'known_hosts')
      if (!fs.existsSync(kh)) fs.writeFileSync(kh, '', { mode: 0o644 })
      pub = fs.readFileSync(`${key}.pub`, 'utf8').trim()
    })
  }
  await step(paths.env, () => writeAtomic(paths.env, buildEnv(a), 0o600))
  await step(paths.config, () => writeAtomic(paths.config, `${JSON.stringify(cfg, null, 2)}\n`, 0o644))
  return { config: cfg, pub }
}

// --- values ----------------------------------------------------------------------------------------

const splitList = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean)
export function validateHosts(list) {
  list.forEach((h, i) => { if (!HOSTNAME.test(h)) throw new InitError(`allowedHosts: entry no. ${i + 1} is neither a host name nor an IPv4 address (without port)`) })
  return list
}
export function validateCidrs(list) {
  if (!list.length) throw new InitError('adminCidrs: at least one network')
  list.forEach((c, i) => {
    try {
      parseCidrs(c)
    } catch {
      throw new InitError(`adminCidrs: network no. ${i + 1} is invalid (a.b.c.d or a.b.c.d/nn)`)
    }
  })
  return list
}
export function validateListen(v) {
  const s = String(v ?? '').trim()
  if (!s || (!net.isIP(s) && !HOSTNAME.test(s))) throw new InitError('invalid listen address (IP or host name expected)')
  return s
}
// listening open to the network without an accepted name: only localhost passes, any other name or IP → 421
function warnNoHosts(io, a) {
  if (!isLoopbackListen(a.listen) && !a.allowedHosts?.length) io.say('⚠ no allowed name (allowedHosts): only localhost will open the dashboard; through an IP or a name, answer 421')
}
export const isLoopbackListen = v => v === '127.0.0.1' || v === '::1' || v === 'localhost' || /^127\./.test(v)
function validateUrl(u, what) {
  let x
  try {
    x = new URL(u)
  } catch {
    throw new InitError(`${what}: invalid URL`)
  }
  if (!['http:', 'https:'].includes(x.protocol)) throw new InitError(`${what}: http:// or https:// expected`)
  if (x.username || x.password) throw new InitError(`${what}: no credentials in the URL (the token is asked separately)`)
  return x.toString().replace(/\/+$/, '')
}
// proposed local network: /24 of each non-internal IPv4
function localNetworks() {
  const out = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.add(`${a.address.split('.').slice(0, 3).join('.')}.0/24`)
  }
  return [...out]
}

// --- flow ------------------------------------------------------------------------------------------

// io: { say, line, secret, yesno, choose } (lib/cli.js); ctx: { fetch, timeoutMs, now }
async function askListen(io, a) {
  const choice = await io.choose('Server listen address:', [
    { key: '1', label: '127.0.0.1: this machine only (recommended; a local HTTPS proxy can serve the rest)' },
    { key: '2', label: ':: : all interfaces, IPv6 and IPv4' },
    { key: '3', label: '0.0.0.0: all IPv4 interfaces' },
    { key: '4', label: 'another address' },
  ], '1')
  a.listen = { 1: '127.0.0.1', 2: '::', 3: '0.0.0.0' }[choice] ?? validateListen(await io.line('Address'))
  a.adminCidrs = ['127.0.0.1/32']
  if (isLoopbackListen(a.listen)) return
  io.say('The dashboard will be reachable over the network. Nothing is readable without a session')
  io.say('(anonymous read disabled); still to choose: the names allowed in the Host header and the')
  io.say('networks from which one can log in and act.')
  for (;;) {
    try {
      a.allowedHosts = validateHosts(splitList(await io.line('Names or IPv4 addresses used to open it (comma-separated; localhost is always allowed)', '')))
      warnNoHosts(io, a)
      break
    } catch (e) { io.say(e.message) }
  }
  const def = ['127.0.0.1/32', ...localNetworks()].join(',')
  for (;;) {
    try {
      a.adminCidrs = validateCidrs(splitList(await io.line('Networks allowed for the admin login (CIDR, commas)', def)))
      break
    } catch (e) { io.say(e.message) }
  }
  io.say('Admin login over HTTP: refused by default outside this machine (the password would travel in')
  io.say('clear text). Prefer an HTTPS proxy (trustedProxies, see docs/security.md).')
  a.httpLogin = await io.yesno('Accept the admin login over HTTP from these networks anyway? (not recommended)', false)
}

async function askTls(io, c, ctx) {
  for (;;) {
    const how = await io.choose(`Certificate of ${maskUrl(c.url)}: which CA to pin?`, [
      { key: '1', label: 'the CA presented by the server, after comparing its fingerprint' },
      { key: '2', label: 'a PEM file of the CA (on a Proxmox node: /etc/pve/pve-root-ca.pem)' },
    ], '1')
    try {
      let ca
      if (how === '1') {
        const chain = await presentedChain(c.url, ctx)
        const cas = chain.filter(x => x.ca)
        if (!cas.length) {
          io.say('The server does not present its CA (only its certificate): provide the PEM file of the CA.')
          continue
        }
        ca = caFromPem(cas[cas.length - 1].pem, ctx.now())
      } else {
        ca = caFromPem(readUserFile(await io.line('PEM file of the CA'), 'CA'), ctx.now())
      }
      io.say(`CA: ${ca.subject} (valid until ${ca.validTo})`)
      io.say(`SHA-256 fingerprint: ${ca.fingerprint256}`)
      io.say('Compare on the node: openssl x509 -in /etc/pve/pve-root-ca.pem -noout -fingerprint -sha256')
      if (await io.yesno('Does the fingerprint match?', false)) return ca.pem
      io.say('CA not kept.')
    } catch (e) {
      io.say(e instanceof InitError ? e.message : `cannot read (${errCode(e)})`)
    }
    if (!await io.yesno('Try the CA choice again?', true)) return null
  }
}

async function askProxmox(io, a, ctx) {
  const ids = new Set(a.proxmox.map(c => c.id))
  const envs = new Set(a.proxmox.map(c => c.env))
  const c = {}
  c.label = await io.line('Cluster label', a.proxmox.length ? `Proxmox ${a.proxmox.length + 1}` : 'Proxmox')
  for (;;) {
    c.id = await io.line('Id (lowercase letters, digits, dashes)', slug(c.label))
    const pemTaken = ctx.paths && !ctx.force && exists(path.join(ctx.paths.pki, `${c.id}.pem`))
    if (ID.test(c.id) && !ids.has(c.id) && !pemTaken) break
    io.say(ids.has(c.id) ? 'id already taken' : pemTaken ? `${path.join(ctx.paths.pki, `${c.id}.pem`)} already exists: another id, or --force` : 'invalid id')
  }
  for (;;) {
    try {
      c.url = validateUrl(await io.line('API URL', 'https://192.0.2.10:8006'), 'URL')
      break
    } catch (e) { io.say(e.message) }
  }
  for (;;) {
    c.env = (await io.line('Environment variable prefix', envs.size ? `PVE_${c.id.toUpperCase().replace(/-/g, '_')}` : 'PVE')).toUpperCase()
    if (ENV_NAME.test(c.env) && !envs.has(c.env)) break
    io.say(envs.has(c.env) ? 'prefix already taken' : 'invalid prefix (uppercase letters, digits, _)')
  }
  for (;;) {
    c.tokenId = await io.line('Token id (user@realm!name, PVEAuditor role)')
    if (TOKEN_ID.test(c.tokenId)) break
    io.say('expected form: user@realm!name (example: vigie@pve!read)')
  }
  c.tokenSecret = await io.secret('Token secret')
  if (c.url.startsWith('http:') && !await io.yesno('URL over http: the token would travel in clear text. Continue?', false)) return 'restart'
  c.caPem = c.url.startsWith('https:') ? await askTls(io, c, ctx) : null
  if (c.url.startsWith('https:') && !c.caPem) {
    io.say('Without a pinned CA, a Proxmox over https cannot be read (no permissive fallback).')
    return (await io.yesno('Start this cluster again?', true)) ? 'restart' : 'drop'
  }
  for (;;) {
    io.say(`Testing ${maskUrl(c.url)}…`)
    const t = await testProxmox({ url: c.url, tokenId: c.tokenId, tokenSecret: c.tokenSecret, caPem: c.caPem, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch })
    if (t.ok) {
      io.say(`✓ Proxmox ${t.version}, nodes: ${t.nodes.join(', ') || '(none readable)'}`)
      for (const w of t.warnings) io.say(`⚠ ${w}`)
      break
    }
    io.say(`✗ ${t.message}`)
    const next = await io.choose('What now?', [{ key: 'r', label: 'retry' }, { key: 'c', label: 'correct (redo this cluster)' }, { key: 'g', label: 'keep anyway' }, { key: 'a', label: 'drop this cluster' }], 'r')
    if (next === 'c') return 'restart'
    if (next === 'a') return 'drop'
    if (next === 'g') break
  }
  a.proxmox.push(c)
  return 'ok'
}

async function askGitea(io, a, ctx) {
  for (;;) {
    let url
    try {
      url = validateUrl(await io.line('Gitea URL', 'http://192.0.2.30:3000'), 'URL')
    } catch (e) {
      io.say(e.message)
      continue
    }
    const token = await io.secret('Gitea token (read:user, read:repository; read:admin for the runners)')
    for (;;) {
      io.say(`Testing ${maskUrl(url)}…`)
      const t = await testGitea({ url, token, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch })
      if (t.ok) {
        io.say(`✓ logged in as ${t.login}`)
        for (const w of t.warnings) io.say(`⚠ ${w}`)
        const owner = await io.line('Owner of the watched repositories', t.owner)
        a.gitea = { url, token, owner }
        return
      }
      io.say(`✗ ${t.message}${t.kind === 'tls' ? ' (Gitea over https must present a public certificate; otherwise http on the LAN)' : ''}`)
      const next = await io.choose('What now?', [{ key: 'r', label: 'retry' }, { key: 'c', label: 'correct' }, { key: 'g', label: 'keep anyway' }, { key: 'a', label: 'drop Gitea' }], 'r')
      if (next === 'c') break
      if (next === 'a') return
      if (next === 'g') {
        a.gitea = { url, token, owner: await io.line('Owner of the watched repositories') }
        return
      }
    }
  }
}

function summary(io, paths, a) {
  io.say('')
  io.say('Summary (no secret shown):')
  io.say(`  title        : ${a.title}`)
  io.say(`  language     : ${a.locale ?? DEFAULT_LOCALE}`)
  io.say(`  listen       : ${a.listen}${a.allowedHosts?.length ? `; allowed names: ${a.allowedHosts.join(', ')}` : ''}`)
  io.say(`  admin        : networks ${a.adminCidrs.join(', ')}; HTTP ${a.httpLogin ? 'accepted' : 'refused outside loopback'}; anonymous read: no`)
  io.say(`  Proxmox      : ${a.proxmox.length ? a.proxmox.map(c => `${c.label} (${maskUrl(c.url)}, ${c.env}_*${c.caPem ? `, CA pki/${c.id}.pem` : ''})`).join('; ') : 'none'}`)
  io.say(`  Gitea        : ${a.gitea ? `${maskUrl(a.gitea.url)}, repositories of ${a.gitea.owner}` : 'no'}`)
  io.say(`  SSH key      : ${a.sshKey ? path.join(paths.state, 'ssh', 'id_ed25519') : 'no'}`)
  io.say(`  files        : ${paths.config}; ${paths.env} (0600)${a.proxmox.some(c => c.caPem) ? `; ${paths.pki}/` : ''}`)
}

function finish(io, paths, a, pub, env) {
  const port = env.PORT || 8088
  const where = isLoopbackListen(a.listen) ? `http://127.0.0.1:${port}` : `http://<${a.allowedHosts?.[0] ?? 'address of this machine'}>:${port}`
  io.say('')
  io.say(`✓ written: ${paths.config}, ${paths.env} (0600)${a.proxmox.some(c => c.caPem) ? `, CA in ${paths.pki}` : ''}`)
  if (pub) io.say(`Public key of the agent (to install on the hosts, see docs/agent.md):\n  ${pub}`)
  io.say(`Check (from server/): ${paths.pki !== path.join(SERVER_DIR, 'pki') ? `PKI_DIR=${paths.pki} ` : ''}node scripts/check-config.js ${paths.config}`)
  io.say(`Start: CONFIG_PATH=${paths.config} ENV_FILE=${paths.env}${paths.pki !== path.join(SERVER_DIR, 'pki') ? ` PKI_DIR=${paths.pki}` : ''} npm start   (from server/)`)
  io.say(`Open: ${where}`)
  io.say('Next: services and probes in the config (docs/configuration.md), Telegram in the environment')
  io.say('file (docs/alerts.md), then restart.')
}

// secrets of the non-interactive mode: VIGIE_INIT_* variables, or NAME=value lines on stdin
async function readSecrets(opts, env, input) {
  const out = { ...Object.fromEntries(Object.entries(SECRET_ENV).map(([k, name]) => [k, nonEmpty(env[name]) ? env[name] : null])) }
  if (opts['secrets-stdin']) {
    let text = ''
    for await (const d of input) text += d
    for (const l of text.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)=(.*)$/)
      const k = m && Object.entries(SECRET_ENV).find(([, n]) => n === m[1])?.[0]
      if (k) out[k] = m[2].replace(/\r$/, '')
    }
  }
  return out
}

async function nonInteractive(opts, env, input, io, ctx) {
  const secrets = await readSecrets(opts, env, input)
  const need = (cond, what) => { if (!cond) throw new InitError(`${what} missing (non-interactive mode)`) }
  need(secrets.admin, `admin password: ${SECRET_ENV.admin} or --secrets-stdin`)
  const why = adminPasswordProblem(secrets.admin)
  if (why) throw new InitError(`admin password: ${why}`)
  const a = { title: nonEmpty(opts.title) ? opts.title.trim() : 'Vigie', locale: opts.locale ?? DEFAULT_LOCALE, listen: validateListen(opts.listen ?? '127.0.0.1'), proxmox: [], gitea: null, sshKey: !!opts['ssh-key'], httpLogin: !!opts['http-login'] }
  a.allowedHosts = validateHosts(splitList(opts['allowed-hosts']))
  a.adminCidrs = validateCidrs(opts['admin-cidrs'] ? splitList(opts['admin-cidrs']) : ['127.0.0.1/32'])
  warnNoHosts(io, a)
  a.hash = await hashPassword(secrets.admin)
  const test = !opts['skip-tests']
  if (opts['pve-url']) {
    const c = { url: validateUrl(opts['pve-url'], '--pve-url'), label: opts['pve-name'] || 'Proxmox', id: opts['pve-id'] || 'pve', env: (opts['pve-env'] || 'PVE').toUpperCase(), tokenId: opts['pve-token-id'] }
    if (!ID.test(c.id)) throw new InitError('--pve-id: lowercase letters, digits and dashes')
    if (!ENV_NAME.test(c.env)) throw new InitError('--pve-env: uppercase letters, digits and _')
    need(c.tokenId && TOKEN_ID.test(c.tokenId), '--pve-token-id (user@realm!name)')
    need(secrets.pve, `Proxmox token secret: ${SECRET_ENV.pve} or --secrets-stdin`)
    c.tokenSecret = secrets.pve
    c.caPem = null
    // like the wizard: over http, the token would travel in clear text → refused, unless an explicit option
    if (c.url.startsWith('http:')) {
      if (!opts['pve-allow-http']) throw new InitError('Proxmox over http: the token would travel in clear text; https recommended, otherwise --pve-allow-http')
      io.say('⚠ Proxmox over http: token in clear text on the network (--pve-allow-http)')
    }
    if (c.url.startsWith('https:')) {
      if (opts['pve-ca']) c.caPem = caFromPem(readUserFile(opts['pve-ca'], '--pve-ca'), ctx.now()).pem
      else if (opts['pve-ca-fingerprint']) {
        const want = normFp(opts['pve-ca-fingerprint'])
        const hit = (await presentedChain(c.url, ctx)).find(x => x.ca && normFp(x.fingerprint256) === want)
        if (!hit) throw new InitError('--pve-ca-fingerprint: no CA presented by the server has this fingerprint')
        c.caPem = caFromPem(hit.pem, ctx.now()).pem
      } else throw new InitError('Proxmox over https: --pve-ca <PEM file> or --pve-ca-fingerprint <SHA-256> required (no permissive fallback)')
    }
    if (test) {
      const t = await testProxmox({ url: c.url, tokenId: c.tokenId, tokenSecret: c.tokenSecret, caPem: c.caPem, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch })
      if (t.ok) io.say(`✓ Proxmox ${t.version}, nodes: ${t.nodes.join(', ') || '(none readable)'}`)
      else if (!opts['keep-failed']) throw new InitError(`Proxmox: ${t.message}`)
      else io.say(`⚠ Proxmox: ${t.message} (kept: --keep-failed)`)
    }
    a.proxmox.push(c)
  }
  if (opts['gitea-url']) {
    const url = validateUrl(opts['gitea-url'], '--gitea-url')
    need(secrets.gitea, `Gitea token: ${SECRET_ENV.gitea} or --secrets-stdin`)
    let owner = opts['gitea-owner'] || null
    if (test) {
      const t = await testGitea({ url, token: secrets.gitea, owner, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch })
      if (t.ok) {
        io.say(`✓ Gitea: ${t.login}`)
        for (const w of t.warnings) io.say(`⚠ ${w}`)
        owner = owner || t.owner
      } else if (!opts['keep-failed']) throw new InitError(`Gitea: ${t.message}`)
      else io.say(`⚠ Gitea: ${t.message} (kept: --keep-failed)`)
    }
    need(owner, '--gitea-owner')
    a.gitea = { url, token: secrets.gitea, owner }
  }
  return a
}

async function interactive(io, ctx) {
  io.say('Vigie: setup wizard. Ctrl-C to quit without writing anything.')
  const a = { proxmox: [], gitea: null, httpLogin: false, allowedHosts: [] }
  a.title = await io.line('Dashboard title', 'Vigie')
  // language of the interface, Telegram and the digest; written into the config (product default: en)
  a.locale = { 1: 'en', 2: 'fr' }[await io.choose('Interface language:', [{ key: '1', label: 'English (en)' }, { key: '2', label: 'français (fr)' }], '1')]
  ;({ hash: a.hash } = await askAdminPassword(io))
  await askListen(io, a)
  while (await io.yesno(a.proxmox.length ? 'Add another Proxmox cluster?' : 'Add a Proxmox cluster?', false)) {
    let r
    do r = await askProxmox(io, a, ctx)
    while (r === 'restart')
  }
  if (await io.yesno('Set up Gitea (repository activity, CI, runners)?', false)) await askGitea(io, a, ctx)
  a.sshKey = await io.yesno('Create the SSH key of the dash-report agent?', false)
  const key = ctx.paths && path.join(ctx.paths.state, 'ssh', 'id_ed25519')
  if (a.sshKey && key && !ctx.force && exists(key)) {
    io.say(`${key} already exists: kept as is (--force to create it again)`)
    a.sshKey = false
  }
  return a
}

// entry point: → exit code (0 written, 1 error, 2 aborted without writing, 130 Ctrl-C)
// allowScripted: interactive mode on a non-terminal stream (tests: scripted stdin)
export async function runInit({ argv = [], env = process.env, input = process.stdin, output = process.stdout, errOutput = process.stderr, tty = !!input.isTTY, allowScripted = false, fetch = uFetch, timeoutMs, now = () => Date.now(), keygen, systemDirs = null } = {}) {
  const err = m => errOutput.write(`init: ${m}\n`)
  let io = null
  try {
    const opts = parseInitArgs(argv)
    if (opts.help) {
      output.write(`${USAGE}\n`)
      return 0
    }
    const ctx = { fetch, now, timeoutMs: timeoutMs ?? (opts.timeout ? Math.max(1, Number(opts.timeout)) * 1000 : DEFAULT_TIMEOUT_MS) }
    const paths = resolvePaths(opts, env, systemDirs ? { systemDirs } : {})
    const batch = !!(opts['non-interactive'] || opts.yes)
    // collisions detected before any question (CA and key known in advance in non-interactive mode)
    checkTargets(paths, { force: !!opts.force, pemNames: batch && opts['pve-url']?.startsWith('https:') ? [`${opts['pve-id'] || 'pve'}.pem`] : [], sshKey: batch && !!opts['ssh-key'] })
    ctx.paths = paths
    ctx.force = !!opts.force
    let a
    if (batch) {
      io = { say: t => output.write(`${t}\n`) }
      a = await nonInteractive(opts, env, input, io, ctx)
    } else {
      if (!tty && !allowScripted) throw new InitError('terminal required for the wizard; otherwise --non-interactive (see --help)')
      io = createPrompter({ input, output, tty })
      a = await interactive(io, ctx)
      summary(io, paths, a)
      if (!await io.yesno('Write these files?', true)) {
        io.say('Nothing was written.')
        return 2
      }
    }
    const { pub } = await writeAll(paths, a, { force: !!opts.force, ...(keygen ? { keygen } : {}), recheck: () => resolvePaths(opts, env, systemDirs ? { systemDirs } : {}) })
    finish(io, paths, a, pub, env)
    return 0
  } catch (e) {
    if (e instanceof Aborted) {
      err('interrupted, nothing was written')
      return 130
    }
    // catch-all: the code only, never e.message (which may quote a path or a received value)
    err(e instanceof InitError || e instanceof InputClosed ? e.message : `unexpected error (${errCode(e)})`)
    return 1
  } finally {
    io?.close?.()
  }
}
