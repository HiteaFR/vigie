// The REAL server/index.js, started by test/server-boot.js on a fake config (CONFIG_PATH),
// without .env (ENV_FILE=none), temporary database, port 0; ENV_FILE=<path>; defaults
// unchanged (systemd unit, CI). The repository .env is never read (trace-env.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_FILES, readCi } from './workflows.js'
import { DatabaseSync } from 'node:sqlite'
import { createNetwork } from '../lib/network/index.js'
import { bootServer, request, TRACE_ENV } from './server-boot.js'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')

test('real startup on a fake config, ENV_FILE=none: /api/healthz 200, no .env touched; SIGTERM → exit code 0, audit summaries written, database closed (WAL emptied)', { timeout: 30_000 }, async t => {
  const s = await bootServer(t, { preload: [TRACE_ENV] })
  const r = await request(s.port, '/api/healthz')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.checks, 0)
  assert.match(s.logs(), /vigie listening on :\d+/)
  assert.doesNotMatch(s.logs(), /TRACE-ENV/, 'ENV_FILE=none: no .env file read')
  // an aggregated refusal (login not configured): written only by audit.flush() at shutdown
  const login = await request(s.port, '/api/login', { method: 'POST', body: { password: 'x' }, headers: { origin: `http://127.0.0.1:${s.port}` } })
  assert.equal(login.status, 503)
  const { code, signal } = await s.stop()
  assert.deepEqual([code, signal], [0, null], s.logs())
  assert.doesNotMatch(s.logs(), /TypeError|shutdown: /)
  // database closed cleanly: no more WAL, healthy database, refusal summary present
  const db = path.join(s.stateDir, 'dashboard.db')
  assert.ok(fs.existsSync(db))
  assert.equal(fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0, false, 'WAL flushed')
  const ro = new DatabaseSync(db, { readOnly: true })
  try {
    assert.equal(ro.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const rows = ro.prepare("SELECT action, ok, detail FROM audit WHERE action = 'login'").all()
    assert.equal(rows.length, 1, JSON.stringify(rows))
    assert.equal(rows[0].ok, 0)
  } finally {
    ro.close()
  }
})

test('LISTEN_HOST: listens on the given address only (127.0.0.1 in the tests); address always explicit (static)', { timeout: 30_000 }, async t => {
  const s = await bootServer(t)
  assert.equal((await request(s.port, '/api/healthz')).status, 200)
  // 127.0.0.2 is also loopback: refused, listening is indeed limited to 127.0.0.1
  const other = await new Promise(resolve => {
    const c = net.connect({ host: '127.0.0.2', port: s.port })
    c.once('connect', () => { c.destroy(); resolve('connecté') })
    c.once('error', e => resolve(e.code))
  })
  assert.equal(other, 'ECONNREFUSED')
  assert.match(INDEX, /const server = app\.listen\(PORT, security\.listenHost\.value, listening\)/)
  assert.doesNotMatch(INDEX, /process\.env\.HOST\b/)
  const doc = fs.readFileSync(path.join(ROOT, 'docs/configuration.md'), 'utf8') // documentation moved from the README to docs/
  assert.match(doc, /`LISTEN_HOST`/)
})

test('HOST set in the environment (machine name, address): no effect; without LISTEN_HOST or listenHost, 127.0.0.1 only', { timeout: 30_000 }, async t => {
  const connectTo = (host, port) => new Promise(resolve => {
    const c = net.connect({ host, port })
    c.once('connect', () => { c.destroy(); resolve('connecté') })
    c.once('error', e => resolve(e.code))
  })
  for (const HOST of ['127.0.0.2', 'machine-factice.exemple.test']) {
    const s = await bootServer(t, { env: { HOST, LISTEN_HOST: undefined } })
    assert.equal((await request(s.port, '/api/healthz')).status, 200, HOST)
    assert.equal(await connectTo('127.0.0.2', s.port), 'ECONNREFUSED', HOST)
    assert.equal(await connectTo('127.0.0.1', s.port), 'connecté', HOST)
    assert.match(s.logs(), /security: listenHost=127\.0\.0\.1 \(default\)/, HOST)
    await s.stop()
  }
})

test('shutdown: index.js goes through shutdown() (bot, network, Pi-hole sessions, then audit.flush and database close); inert network module: asynchronous stop()', { timeout: 30_000 }, async () => {
  const sig = INDEX.slice(INDEX.indexOf("for (const sig of ['SIGTERM', 'SIGINT'])"))
  // module steps via the host, between the bot and the Pi-hole sessions; the network module
  // is labeled in French there (lib/plugins/core.js)
  assert.match(sig, /steps: \[\['bot', \(\) => bot\.stop\(\)\], \.\.\.host\.stopSteps\(\), \['sessions Pi-hole', \(\) => piholes\.stop\(\)\]\]/)
  const { createHost } = await import('../lib/plugins/host.js')
  const { coreModules } = await import('../lib/plugins/core.js')
  const h = createHost({ log: { log() {}, warn() {}, error() {} } })
  for (const m of coreModules({ updates: {}, network: { stop: async () => {} } })) h.addModule(m)
  assert.deepEqual(h.stopSteps().map(([label]) => label), ['réseau'])
  assert.match(sig, /finalize: \[\(\) => audit\.flush\(\), \(\) => store\.db\.close\(\)\]/)
  assert.match(sig, /\}\)\.finally\(\(\) => process\.exit\(0\)\)/)
  assert.doesNotMatch(sig, /network\.stop\(\)\.then/)
  const net = createNetwork({ cfg: { hosts: [], services: [] }, store: null })
  const p = net.stop()
  assert.ok(p instanceof Promise)
  assert.equal(await p, undefined)
})

test('without ENV_FILE: <root>/.env consulted as before (never read by the test: the trace answers "absent")', { timeout: 30_000 }, async t => {
  const s = await bootServer(t, { env: { ENV_FILE: undefined }, preload: [TRACE_ENV] })
  assert.match(s.logs(), new RegExp(`TRACE-ENV exists ${path.join(ROOT, '.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
  assert.doesNotMatch(s.logs(), /TRACE-ENV read/)
  assert.equal((await request(s.port, '/api/healthz')).status, 200)
})

test('ENV_FILE=<path>: that file is loaded (fake variable ALERTS_DRY_RUN=1 visible in the log), an already set variable keeps its value', { timeout: 30_000 }, async t => {
  const dir = tmpDir('dash-envfile-', t)
  const file = path.join(dir, 'banc.env')
  fs.writeFileSync(file, '# fichier factice du banc\nALERTS_DRY_RUN=1\nBOT_DISABLED="0"\n')
  const s = await bootServer(t, { env: { ENV_FILE: file, BOT_DISABLED: '1', TRACE_ENV_MATCH: file }, preload: [TRACE_ENV] })
  assert.match(s.logs(), /ALERTS_DRY_RUN=1: notifications are logged/)
  assert.match(s.logs(), new RegExp(`TRACE-ENV read ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(s.logs(), /TRACE-ENV (exists|read) \S*\/\.env\n/, 'the .env at the root is not read')
})

test('invalid or unreadable CONFIG_PATH: exit 1, message naming the file', { timeout: 30_000 }, async t => {
  const dir = tmpDir('dash-badcfg-', t)
  await assert.rejects(bootServer(t, { env: { CONFIG_PATH: path.join(dir, 'absente.json') } }), /arrêté au démarrage \(1\)[\s\S]*reading \S*absente\.json/)
  await assert.rejects(bootServer(t, { config: { version: 2, title: 'x' } }), /arrêté au démarrage \(1\)[\s\S]*config\.json invalid:/)
})

test('static: without CONFIG_PATH or ENV_FILE, same paths as before; the CI sets neither; the example unit sets CONFIG_PATH and PKI_DIR, never ENV_FILE', { timeout: 30_000 }, () => {
  assert.match(INDEX, /const envPath = ENV_FILE === 'none' \? null : ENV_FILE \? path\.resolve\(ENV_FILE\) : path\.join\(ROOT, '\.env'\)/)
  // same file choice (configSource), plus the "to be configured" mode if the default file is missing
  assert.match(INDEX, /configSource\(\{ configPath: process\.env\.CONFIG_PATH, defaultFile: path\.join\(ROOT, 'config\.json'\) \}\)/)
  for (const f of CI_FILES) assert.doesNotMatch(readCi(f), /CONFIG_PATH|ENV_FILE/, f)
  const unit = fs.readFileSync(path.join(ROOT, 'deploy/vigie.service.example'), 'utf8')
  assert.match(unit, /^Environment=CONFIG_PATH=\/etc\/vigie\/config\.json$/m)
  assert.match(unit, /^Environment=PKI_DIR=\/etc\/vigie\/pki$/m)
  assert.doesNotMatch(unit, /ENV_FILE/)
  const doc = fs.readFileSync(path.join(ROOT, 'docs/configuration.md'), 'utf8') // documentation moved from the README to docs/
  assert.match(doc, /`CONFIG_PATH`/)
  assert.match(doc, /`ENV_FILE=none`/)
})
