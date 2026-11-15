// ntfy plugin against a LOCAL fake ntfy server (127.0.0.1). Config, rendering (text,
// title, priority, tags, topic), token (header only, never in a message, a log
// or a state), filters, failures (500, 401, 429, timeout), and the two failures crossed with Telegram.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import ntfy from '../plugins/ntfy/index.js'
import { PLUGINS } from '../plugins/index.js'
import { createHost, validatePluginConfig } from '../lib/plugins/host.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { TelegramError } from '../lib/notify/telegram.js'
import { createFormatter } from '../lib/notify/format.js'
import { createClock } from '../lib/clock.js'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { tmpDir } from './tmpdir.js'

const TOKEN = 'tk_jeton-ntfy-de-banc-123'
const NOW = Date.parse('2026-11-10T09:00:00Z')
const MIN = 60_000
const cfg = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }).config
const clock = createClock(cfg.alerts.timezone)
const formatter = createFormatter({ dashboardUrl: 'https://vigie.example.test', clock })

async function ntfyServer() {
  const s = { got: [], status: 200, hang: false, headers: {} }
  const srv = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    s.got.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, ua: req.headers['user-agent'], type: req.headers['content-type'], body: body ? JSON.parse(body) : null })
    if (s.hang) return
    res.statusCode = s.status
    for (const [k, v] of Object.entries(s.headers)) res.setHeader(k, v)
    res.end('{}')
  })
  srv.on('connection', c => (s.sockets ??= new Set()).add(c))
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  s.url = `http://127.0.0.1:${srv.address().port}`
  s.close = () => new Promise(r => { for (const c of s.sockets ?? []) c.destroy(); srv.close(r) })
  return s
}
const tgFake = () => {
  const t = { configured: true, chatId: '42', down: false, sent: [] }
  t.send = async text => { if (t.down) throw new TelegramError('réseau : ECONNRESET'); t.sent.push(text); return { message_id: 1 } }
  return t
}
const alert = (n, severity = 'critical') => ({ key: `r:${n}`, rule: 'r', entity: String(n), title: `Alerte ${n}`, env: 'prod', severity, state: 'firing', incidentId: n, detail: 'détail & co', since: NOW, firedAt: NOW })
function setup(server, block = {}, { env = { NTFY_TOKEN: TOKEN }, channelTimeoutMs } = {}) {
  const logs = []
  const log = { log() {}, warn() {}, error: m => logs.push(String(m)) }
  const host = createHost({ cfg: { plugins: { ntfy: { url: server.url, topic: 'vigie-banc', ...block } } }, env, log, plugins: [ntfy], ...(channelTimeoutMs ? { channelTimeoutMs } : {}) })
  const store = openDb(tmpDir('vigie-p4e-ntfy-'))
  const telegram = tgFake()
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter, log, channels: () => host.channels() })
  return { host, store, telegram, notifier, logs }
}

test('ntfy config: plugins.ntfy block validated (url, topic, priorities 1-5, minimum severity); missing: not configured, no channel, nothing goes out; in the plugin list', async () => {
  assert.ok(PLUGINS.includes(ntfy))
  const errs = block => validatePluginConfig({ plugins: { ntfy: block } }, [ntfy])
  assert.deepEqual(errs({ url: 'https://ntfy.example.test', topic: 'vigie' }), [])
  assert.ok(errs({ url: 'https://ntfy.example.test', topic: 'mauvais sujet' }).some(e => /plugins\.ntfy\.topic: topic/.test(e)))
  assert.ok(errs({ url: 'https://ntfy.example.test', topic: 'v', priorities: { critical: 9 } }).some(e => /plugins\.ntfy\.priorities\.critical/.test(e)))
  assert.ok(errs({ url: 'https://ntfy.example.test', topic: 'v', minSeverity: 'grave' }).some(e => /plugins\.ntfy\.minSeverity/.test(e)))
  assert.ok(errs({ url: 'https://ntfy.example.test', topic: 'v', inconnu: 1 }).length > 0)
  const server = await ntfyServer()
  try {
    const host = createHost({ cfg: {}, env: { NTFY_TOKEN: TOKEN }, log: { log() {}, warn() {}, error() {} }, plugins: [ntfy] })
    assert.deepEqual(host.channels(), [])
    assert.equal(host.view().modules.find(m => m.id === 'ntfy').state, 'unconfigured')
    const store = openDb(tmpDir('vigie-p4e-ntfy-off-'))
    const n = createNotifier({ cfg, store, clock, telegram: tgFake(), formatter, log: { log() {}, error() {} }, channels: () => host.channels() })
    n.enqueue('open', alert(1), NOW)
    await n.flush(NOW + MIN)
    assert.deepEqual(server.got, [])
    assert.deepEqual(n.status(NOW).channels.map(c => c.id), ['telegram'])
  } finally {
    await server.close()
  }
})

test('ntfy sending: JSON on the root (topic, title, plain text, priority, tags), batch grouped, vigie User-Agent, token in Authorization: Bearer only; minimum severity and messages without severity filtered', async () => {
  const server = await ntfyServer()
  try {
    const { notifier, store } = setup(server, { priorities: { warning: 2 } })
    await notifier.flush(NOW - MIN)
    notifier.enqueue('open', alert(1), NOW)
    notifier.enqueue('open', alert(2, 'warning'), NOW)
    await notifier.flush(NOW + 20_000)
    assert.equal(server.got.length, 1)
    const g = server.got[0]
    assert.deepEqual([g.method, g.path, g.auth, g.ua.split('/')[0], g.type], ['POST', '/', `Bearer ${TOKEN}`, 'vigie', 'application/json'])
    assert.deepEqual(g.body, {
      topic: 'vigie-banc', title: '🔴 Alerte 1 — r (+1)', priority: 5, tags: ['rotating_light', 'warning'],
      message: store.db.prepare('SELECT text FROM outbox ORDER BY id').all().map(r => r.text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join('\n\n'),
    })
    assert.ok(!g.body.message.includes('<b>') && g.body.message.includes('détail & co'), 'plain text, entities decoded')
    // minimum severity critical, without the messages without severity
    const s2 = await ntfyServer()
    const b = setup(s2, { minSeverity: 'critical', untyped: false })
    await b.notifier.flush(NOW - MIN)
    b.notifier.enqueue('open', alert(3, 'warning'), NOW)
    b.notifier.enqueue('open', alert(4), NOW)
    b.notifier.enqueueRaw('digest', '☀️ digest', { now: NOW })
    await b.notifier.flush(NOW + 20_000)
    assert.deepEqual(s2.got.map(x => [x.body.title, x.body.priority]), [['🔴 Alerte 4 — r', 5]])
    assert.deepEqual(b.store.db.prepare("SELECT dropped FROM outbox_delivery WHERE channel = 'ntfy' ORDER BY outbox_id").all().map(r => r.dropped), ['filtered', null, 'filtered'])
    await s2.close()
    // without a token: no Authorization header
    const s3 = await ntfyServer()
    const c = setup(s3, {}, { env: {} })
    await c.notifier.flush(NOW - MIN)
    c.notifier.enqueueRaw('test', '🧪 essai', { now: NOW })
    await c.notifier.flush(NOW + MIN)
    assert.deepEqual([s3.got[0].auth, s3.got[0].body.priority, s3.got[0].body.tags], [null, 3, []])
    await s3.close()
  } finally {
    await server.close()
  }
})

test('ntfy failures: 500 → retry, 401 → rejected, 429 → Retry-After, silent server → bounded timeout; token never in an error, a log or the state; channel_error raised then cleared', async () => {
  const server = await ntfyServer()
  try {
    const { notifier, store, logs, telegram } = setup(server, {}, { channelTimeoutMs: 200 })
    await notifier.flush(NOW - MIN)
    const row = id => store.db.prepare("SELECT * FROM outbox_delivery WHERE channel = 'ntfy' AND outbox_id = ?").get(id)
    server.status = 500
    notifier.enqueue('open', alert(1), NOW)
    await notifier.flush(NOW + MIN)
    assert.deepEqual([row(1).attempts, row(1).last_error, row(1).next_try], [1, 'ntfy 500', NOW + MIN + 10_000])
    assert.equal(notifier.channelSignals().find(s => s.key === 'channel_error:ntfy').cond, true)
    server.status = 429
    server.headers = { 'retry-after': '120' }
    await notifier.flush(NOW + 2 * MIN)
    assert.equal(row(1).next_try, NOW + 2 * MIN + 120_000)
    server.status = 200
    server.headers = {}
    server.hang = true
    await notifier.flush(NOW + 5 * MIN)
    assert.equal(row(1).last_error, 'délai dépassé')
    server.hang = false
    await notifier.flush(NOW + 7 * MIN)
    assert.equal(row(1).sent_at, NOW + 7 * MIN)
    assert.equal(notifier.channelSignals().find(s => s.key === 'channel_error:ntfy').cond, false)
    server.status = 401
    notifier.enqueue('open', alert(2), NOW + 8 * MIN)
    await notifier.flush(NOW + 9 * MIN)
    assert.deepEqual([row(2).dropped, row(2).last_error], ['rejected', 'ntfy 401'])
    assert.equal(telegram.sent.length, 2, 'Telegram: every alert, despite ntfy')
    const all = JSON.stringify({ logs, status: notifier.status(NOW + 9 * MIN), rows: store.db.prepare('SELECT * FROM outbox_delivery').all() })
    assert.ok(!all.includes(TOKEN), 'token never in clear')
  } finally {
    await server.close()
  }
})

test('crossed failures: Telegram down and ntfy active → ntfy delivers; ntfy down and Telegram active → Telegram delivers; each catches up on recovery, without duplicates', async () => {
  const server = await ntfyServer()
  try {
    const { notifier, telegram, store } = setup(server)
    await notifier.flush(NOW - MIN)
    telegram.down = true
    notifier.enqueue('open', alert(1), NOW)
    await notifier.flush(NOW + MIN)
    assert.deepEqual([telegram.sent.length, server.got.length], [0, 1])
    telegram.down = false
    server.status = 503
    notifier.enqueue('open', alert(2), NOW + 2 * MIN)
    for (let t = NOW + 3 * MIN; t <= NOW + 4 * MIN; t += MIN) await notifier.flush(t)
    // Telegram catches up 1 and delivers 2, grouped into one message
    assert.equal(telegram.sent.length, 1)
    assert.ok(telegram.sent[0].includes('Alerte 1') && telegram.sent[0].includes('Alerte 2'))
    server.status = 200
    for (let t = NOW + 5 * MIN; t <= NOW + 15 * MIN; t += MIN) await notifier.flush(t)
    // ntfy: 1 delivered, 2 refused (503) then delivered; one successful delivery per alert
    assert.deepEqual(store.db.prepare("SELECT outbox_id FROM outbox_delivery WHERE channel = 'ntfy' AND sent_at IS NOT NULL ORDER BY outbox_id").all().map(r => r.outbox_id), [1, 2])
    assert.equal(server.got.at(-1).body.title, '🔴 Alerte 2 — r')
    assert.equal(telegram.sent.length, 1, 'no Telegram duplicate')
  } finally {
    await server.close()
  }
})
