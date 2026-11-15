// Error messages of modules and plugins are masked before going out
// (lib/redact.js, the host's brief()): /api/plugins, plugin_error detail hence /api/alerts, digest
// and Telegram, log. Sentinel on each output, in the golden world.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, MASK } from '../lib/redact.js'
import { definePlugin, createHost } from '../lib/plugins/host.js'
import { buildDigest } from '../lib/notify/digest.js'
import { buildWorld, notifications, ENV, NOW } from './golden/world.js'
import { tmpDir } from './tmpdir.js'

test('redact: URL credentials, parameters, headers and authentication schemes, secret pairs, tokens and known values masked; ordinary messages intact', () => {
  const cases = [
    ['fetch http://admin:S3cr3tPass@gitea.example.net/api?token=abcdef123456&x=1 échoué', `fetch http://${MASK}@gitea.example.net/api?token=${MASK}&x=${MASK} échoué`],
    ['https://jeton123@hote.example.test/x', `https://${MASK}@hote.example.test/x`],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc suite', `Authorization: ${MASK} suite`],
    ['authorization=Basic dXNlcjpwYXNz ok', `authorization=${MASK} ok`],
    ['X-Api-Key=abc123 X-Plex-Token: zzz fin', `X-Api-Key=${MASK} X-Plex-Token: ${MASK} fin`],
    ['réponse Bearer abcdef0123 refusée', `réponse Bearer ${MASK} refusée`],
    ['password=hunter2 et api_key: "k-123"', `password=${MASK} et api_key: "${MASK}"`],
    ['clé ghp_abcdefghijklmnopqrstuvwx1234 refusée', `clé ${MASK} refusée`],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0 seul', `jwt ${MASK} seul`],
    ['valeur valeur-secrete-xyz et valeur%20secrete', `valeur ${MASK} et ${MASK}`],
  ]
  for (const [inp, want] of cases) assert.equal(redact(inp, ['valeur-secrete-xyz', 'valeur secrete', 'abc']), want, inp)
  for (const plain of ['Gitea 502', 'délai dépassé', 'ECONNREFUSED 127.0.0.1:3000', 'secret ABSENT absent de l\'environnement', 'signal refusé : service_down:web (clé hors du type faux)',
    'id network réservé au cœur (source ou module du cœur), plugin non chargé', '/nulle-part → HTTP 404', 'sonde fragile (plugin sonde-fragile) : boum', 'abc courte non masquée']) {
    assert.equal(redact(plain, ['abc']), plain, plain)
  }
})

// plugin that throws a message full of secrets: URL with credentials, parameter, Bearer, and the
// value of its own declared secret
const SECRET = 'valeur-du-secret-declare'
const LEAKS = ['S3cr3tPass', 'abcdef123456', 'eyJhbGciOiJIUzI1NiJ9', SECRET, 'jeton-de-banc']
const leaky = definePlugin({
  id: 'fuite', apiVersion: 0, label: 'Fuite', configured: () => true, secrets: ['FUITE_JETON'],
  setup(ctx) {
    const s = ctx.secret('FUITE_JETON')
    return {
      rules: ['fuite_rule'],
      signals: () => { throw new Error(`fetch http://admin:S3cr3tPass@h.example.test/api?token=abcdef123456 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ; clé ${s}`) },
    }
  },
})

test('sentinel: the message of a plugin that throws goes out masked on /api/plugins (host.view), /api/alerts (active and incidents), the digest and Telegram; plugin_error does go out', async () => {
  const w = await buildWorld({ storeDir: tmpDir('vigie-p4c-redact-'), extraPlugins: [leaky], env: { ...ENV, FUITE_JETON: SECRET } })
  const n = await notifications(w)
  const view = JSON.stringify(w.host.view())
  const alerts = JSON.stringify({ active: n.engine.active(), incidents: n.engine.incidents(0, 1000) })
  const digest = buildDigest({ cfg: w.cfg, engine: n.engine, snap: w.snap, monitor: w.monitor, formatter: n.formatter, clock: n.clock, host: w.host, silences: n.silences, mark: false, now: NOW })
  // the send queue is flushed in batches: flush it to the end while advancing the clock
  for (let t = NOW + 60_000; t <= NOW + 3 * 3600_000; t += 60_000) await n.notifier.flush(t)
  const telegram = n.sent.map(m => m.text).join('\n')
  // the output exists (otherwise the sentinel would prove nothing)
  assert.match(view, /"id":"fuite".*"state":"error"/)
  assert.match(alerts, /plugin_error:fuite/)
  assert.match(telegram, /Plugin Fuite en erreur/)
  // digest: only the 10 most severe alerts; here plugin_error (warning) is not among them, hence
  // the minimal case below; no leak either way
  for (const leak of LEAKS) assert.ok(!digest.includes(leak), `digest contains ${leak}`)
  for (const [name, out] of [['/api/plugins', view], ['/api/alerts', alerts], ['Telegram', telegram]]) {
    for (const leak of LEAKS) assert.ok(!out.includes(leak), `${name} contains ${leak}`)
    assert.ok(out.includes(`http://${MASK}@h.example.test/api?token=${MASK}`), `${name}: redacted message present`)
  }
  w.store.db.close()
})

test('log: the message written to the log by the host is masked too', () => {
  const logs = []
  const host = createHost({ cfg: {}, env: { FUITE_JETON: SECRET }, log: { log() {}, warn() {}, error: m => logs.push(m) }, plugins: [leaky] })
  host.signals({}, NOW)
  assert.equal(logs.length, 1)
  for (const leak of LEAKS) assert.ok(!logs[0].includes(leak), leak)
})

test('sentinel (digest): plugin_error the only active alert, its detail appears in the digest, masked', async () => {
  const { parseConfig } = await import('../lib/config.js')
  const { createRules } = await import('../lib/alerts/rules.js')
  const { createEngine } = await import('../lib/alerts/engine.js')
  const { createClock } = await import('../lib/clock.js')
  const { createFormatter } = await import('../lib/notify/format.js')
  const { createSilences } = await import('../lib/alerts/silences.js')
  const { openDb } = await import('../lib/db.js')
  const cfg = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: { startupGraceSec: 0 } }).config
  const store = openDb(tmpDir('vigie-p4c-redact-digest-'))
  const host = createHost({ cfg, env: { FUITE_JETON: SECRET }, log: { log() {}, warn() {}, error() {} }, plugins: [leaky] })
  const monitor = { checks: [], result: () => null, completed: 0 }
  const clock = createClock(cfg.alerts.timezone)
  const engine = createEngine({ cfg, store, rules: createRules(cfg, monitor, null, null, null, null, null, { host }), notifier: { enqueue: () => 'now' }, clock, startedAt: NOW - 3 * 3600_000 })
  for (let t = NOW - 3600_000; t <= NOW; t += 5 * 60_000) engine.evaluate({}, t)
  assert.equal(engine.get('plugin_error:fuite').state, 'firing')
  const digest = buildDigest({ cfg, engine, snap: {}, monitor, formatter: createFormatter({ dashboardUrl: 'https://vigie.example.test', clock }), clock, host, silences: createSilences({ store }), mark: false, now: NOW })
  assert.match(digest, /Plugin Fuite en erreur/)
  assert.ok(digest.includes(`http://${MASK}@h.example.test/api?token=${MASK}`), digest)
  for (const leak of LEAKS) assert.ok(!digest.includes(leak), `digest contains ${leak}`)
  store.db.close()
})

test('masking refinement: leaks covered (declared secret regardless of case, short Basic in base64, base64 with "/", token after Bearer or token); no over-masking (token expired, Basic authentication failed, URL paths with digits, parameter names, long words)', () => {
  const leaks = [
    ['JETON-TRES-SECRET-42 refusé', `${MASK} refusé`],
    ['clé Jeton-Tres-Secret-42 et %4A%45%54%4F%4E', `clé ${MASK} et %4A%45%54%4F%4E`],
    ['auth YWI6Y2Q= refusée', `auth ${MASK} refusée`],
    ['valeur dGVzdA== ici', `valeur ${MASK} ici`],
    ['clé dGVzdC9hYmMvZGVmZ2hpams0NTY3ODkw/A== fin', `clé ${MASK} fin`],
    ['clé Zm9vL2Jhci9CYXoxMjM0NTY3ODkwYWJj sans rembourrage', `clé ${MASK} sans rembourrage`],
    ['Bearer abc123x', `Bearer ${MASK}`],
    ['Token abcdefghijklmnopqr x', `Token ${MASK} x`],
    ['token 9f8e7d6c refusé', `token ${MASK} refusé`],
    ['uuid 123e4567-e89b-12d3-a456-426614174000', `uuid ${MASK}`],
  ]
  for (const [inp, want] of leaks) assert.equal(redact(inp, ['jeton-tres-secret-42']), want, inp)
  const readable = [
    'token expired, renew it',
    'Basic authentication failed',
    'Bearer token expired',
    'invalid token format',
    'http://gitea.example.net/api/v1/repos/org/app2024/actions/runs/123456789',
    'GET /api/v1/repos/Org/App2/actions/tasks → 502',
    '/var/lib/vigie/plugins/outil-2026/cache/donnees-123.json introuvable',
    'status=ok',
    'a==b',
    'anticonstitutionnellement long',
    'sha abc1234 · run #42',
    'UND_ERR_CONNECT_TIMEOUT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]
  for (const t of readable) assert.equal(redact(t, ['jeton-tres-secret-42']), t, t)
  // parameters: the value is masked, never the name
  assert.equal(redact('GET /x?content=abc&page=2'), `GET /x?content=${MASK}&page=${MASK}`)
  // intended, documented limit: an undeclared run of letters without a digit stays readable
  assert.equal(redact('clé abcdefghijklmnopqrstuvwxyzabcd'), 'clé abcdefghijklmnopqrstuvwxyzabcd')
})
