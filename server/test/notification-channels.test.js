// Several notification channels. Telegram (main channel, state in outbox) and extra channels
// (state in outbox_delivery): each keeps going when the other is down, commissioning
// (nothing earlier), filter, dry run, refusal, retry, channel_error alert, a plugin's
// channel (bounded timeout, masked message). Fake Telegram and channels, fixed clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier, CHANNEL_ERROR_FOR_SEC } from '../lib/notify/notifier.js'
import { TelegramError } from '../lib/notify/telegram.js'
import { createFormatter } from '../lib/notify/format.js'
import { createClock } from '../lib/clock.js'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { definePlugin, createHost } from '../lib/plugins/host.js'
import { tmpDir } from './tmpdir.js'

const quiet = { log() {}, warn() {}, error() {} }
const NOW = Date.parse('2026-11-10T09:00:00Z') // 10:00 in Paris, outside quiet hours
const MIN = 60_000
const cfg = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }).config
const clock = createClock(cfg.alerts.timezone)
const formatter = createFormatter({ dashboardUrl: 'https://vigie.example.test', clock })

function telegramFake() {
  const t = { configured: true, chatId: '42', down: false, sent: [] }
  t.send = async (text, opts = {}) => {
    if (t.down) throw new TelegramError('réseau : ECONNRESET')
    t.sent.push(text)
    return { message_id: t.sent.length }
  }
  return t
}
function channelFake(id, over = {}) {
  const c = { id, label: id.toUpperCase(), configured: true, limits: { maxBatch: 12, maxLen: 3800 }, down: false, sent: [], ...over }
  c.send = async list => {
    if (c.down === 'permanent') throw Object.assign(new Error('refusé'), { permanent: true })
    if (c.down) throw new Error('serveur injoignable')
    c.sent.push(list.map(r => `${r.kind}:${r.severity ?? '—'}:${r.plain.split('\n')[0]}`))
  }
  c.classify = e => ({ permanent: !!e?.permanent, retryAfter: e?.retryAfter ?? null })
  return c
}
const alert = (n, severity = 'critical') => ({ key: `r:${n}`, rule: 'r', entity: String(n), title: `Alerte ${n}`, env: 'prod', severity, state: 'firing', incidentId: n, detail: 'détail', since: NOW, firedAt: NOW })
const setup = ({ channels = [], dryRun = false } = {}) => {
  const store = openDb(tmpDir('vigie-p4e-'))
  const telegram = telegramFake()
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter, dryRun, log: quiet, channels: () => channels })
  return { store, telegram, notifier }
}

test('Telegram down, extra channel active: the channel delivers, Telegram keeps its queue and retries; on recovery, Telegram delivers once, without duplicates on the channel side', async () => {
  const ntfy = channelFake('ntfy')
  const { store, telegram, notifier } = setup({ channels: [ntfy] })
  await notifier.flush(NOW - MIN) // commissioning of the channel (nothing yet)
  telegram.down = true
  notifier.enqueue('open', alert(1), NOW)
  notifier.enqueue('open', alert(2, 'warning'), NOW)
  await notifier.flush(NOW + 20_000)
  assert.deepEqual(telegram.sent, [])
  assert.deepEqual(ntfy.sent, [['open:critical:🔴 Alerte 1 — r', 'open:warning:🟠 Alerte 2 — r']])
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_at IS NULL').get().n, 2, 'Telegram: still queued')
  telegram.down = false
  for (let t = NOW + MIN; t <= NOW + 10 * MIN; t += MIN) await notifier.flush(t)
  assert.equal(telegram.sent.length, 1)
  assert.equal(ntfy.sent.length, 1, 'no duplicate on the channel side')
  const st = notifier.status(NOW + 10 * MIN)
  assert.deepEqual(st.channels.map(c => [c.id, c.configured, c.queued, c.lastError]), [['telegram', true, 0, null], ['ntfy', true, 0, null]])
})

test('extra channel down, Telegram active: Telegram delivers exactly as without the channel; the channel retries (growing delay), then delivers; channel_error raised during the failure, cleared on success', async () => {
  const ntfy = channelFake('ntfy')
  const ref = setup()
  const { telegram, notifier } = setup({ channels: [ntfy] })
  await notifier.flush(NOW - MIN)
  ntfy.down = true
  for (const n of [ref.notifier, notifier]) {
    n.enqueue('open', alert(1), NOW)
    n.enqueue('open', alert(2, 'warning'), NOW)
    n.enqueueRaw('test', '🧪 direct', { now: NOW + MIN })
  }
  const seen = []
  for (let t = NOW + 20_000; t <= NOW + 3 * MIN; t += 20_000) {
    await ref.notifier.flush(t)
    await notifier.flush(t)
    seen.push(notifier.channelSignals().map(s => `${s.key}=${s.cond}`).join(' '))
  }
  assert.deepEqual(telegram.sent, ref.telegram.sent, 'Telegram: same messages, same order')
  assert.deepEqual(ntfy.sent, [])
  assert.equal(seen.at(-1), 'channel_error:telegram=false channel_error:ntfy=true')
  const sig = notifier.channelSignals().find(s => s.key === 'channel_error:ntfy')
  assert.deepEqual([sig.rule, sig.title, sig.detail, sig.forSec, sig.severity], ['channel_error', 'Canal NTFY en échec', 'serveur injoignable', CHANNEL_ERROR_FOR_SEC, 'warning'])
  assert.deepEqual(notifier.status(NOW + 3 * MIN).channels[1].lastError.message, 'serveur injoignable')
  ntfy.down = false
  for (let t = NOW + 4 * MIN; t <= NOW + 30 * MIN; t += MIN) await notifier.flush(t)
  assert.deepEqual(ntfy.sent.flat(), ['open:critical:🔴 Alerte 1 — r', 'open:warning:🟠 Alerte 2 — r', 'test:—:🧪 direct'])
  assert.equal(notifier.channelSignals().find(s => s.key === 'channel_error:ntfy').cond, false)
})

test('extra channel: nothing from before its commissioning; filter (accepts) → "filtered"; permanent refusal of a batch → one by one, the refused one "rejected"; dry run: no sending; channel list that throws: Telegram keeps going', async () => {
  // earlier
  const late = channelFake('tard')
  const a = setup({ channels: [] })
  a.notifier.enqueue('open', alert(1), NOW)
  const chans = []
  const b = createNotifier({ cfg, store: a.store, clock, telegram: a.telegram, formatter, log: quiet, channels: () => chans })
  chans.push(late)
  await b.flush(NOW + MIN)
  b.enqueue('open', alert(2), NOW + MIN)
  for (let t = NOW + 2 * MIN; t <= NOW + 5 * MIN; t += MIN) await b.flush(t)
  assert.deepEqual(late.sent.flat(), ['open:critical:🔴 Alerte 2 — r'])
  // filter
  const crit = channelFake('crit', { accepts: r => r.severity === 'critical' })
  const c = setup({ channels: [crit] })
  await c.notifier.flush(NOW - MIN)
  c.notifier.enqueue('open', alert(1), NOW)
  c.notifier.enqueue('open', alert(2, 'warning'), NOW)
  await c.notifier.flush(NOW + MIN)
  assert.deepEqual(crit.sent.flat(), ['open:critical:🔴 Alerte 1 — r'])
  assert.deepEqual(c.store.db.prepare("SELECT outbox_id, dropped FROM outbox_delivery WHERE channel = 'crit' ORDER BY outbox_id").all().map(r => [r.outbox_id, r.dropped]), [[1, null], [2, 'filtered']])
  // refusal of a batch: one by one
  let n = 0
  const picky = channelFake('picky')
  picky.send = async list => {
    n++
    if (list.length > 1 || list[0].incidentId === 2) throw Object.assign(new Error('trop long'), { permanent: true })
    picky.sent.push(list[0].incidentId)
  }
  const d = setup({ channels: [picky] })
  await d.notifier.flush(NOW - MIN)
  for (const i of [1, 2, 3]) d.notifier.enqueue('open', alert(i), NOW)
  await d.notifier.flush(NOW + MIN)
  assert.deepEqual(picky.sent, [1, 3])
  assert.deepEqual(d.store.db.prepare("SELECT outbox_id, dropped FROM outbox_delivery WHERE channel = 'picky' AND dropped IS NOT NULL").all().map(r => [r.outbox_id, r.dropped]), [[2, 'rejected']])
  // dry run
  const dry = channelFake('dry')
  const e = setup({ channels: [dry], dryRun: true })
  e.notifier.enqueue('open', alert(1), NOW)
  await e.notifier.flush(NOW + MIN)
  assert.deepEqual([dry.sent, e.telegram.sent, e.notifier.channelSignals()], [[], [], []])
  // list that throws
  const f = setup()
  const g = createNotifier({ cfg, store: f.store, clock, telegram: f.telegram, formatter, log: quiet, channels: () => { throw new Error('hôte cassé') } })
  g.enqueue('open', alert(1), NOW)
  await g.flush(NOW + MIN)
  assert.equal(f.telegram.sent.length, 1)
})

test('a plugin\'s channel (channel hook): bounded sending (timeout exceeded → retry), masked message (URL, token, declared secret), permanent refusal and retryAfter passed on; Telegram keeps going', async () => {
  const SECRET = 'jeton-du-canal-xyz'
  const mode = { v: 'bloque' }
  const p = definePlugin({ id: 'canal-test', apiVersion: 0, label: 'Canal test', configured: () => true, secrets: ['CANAL_JETON'], setup: () => ({
    channel: {
      label: 'Test', maxBatch: 50,
      send: async list => {
        if (mode.v === 'bloque') return new Promise(() => {})
        if (mode.v === 'fuite') throw new Error(`POST http://u:motdepasse@ntfy.example.test/x?auth=abc123 Bearer ${SECRET}`)
        if (mode.v === '429') throw Object.assign(new Error('trop de requêtes'), { retryAfter: 90 })
        mode.sent = (mode.sent ?? 0) + list.length
      },
    },
  }) })
  const host = createHost({ cfg: {}, env: { CANAL_JETON: SECRET }, log: quiet, plugins: [p], channelTimeoutMs: 50 })
  const [ch] = host.channels()
  assert.deepEqual([ch.id, ch.label, ch.limits], ['canal-test', 'Test', { maxBatch: 12, maxLen: 3800 }])
  const { store, telegram, notifier } = setup({ channels: host.channels() })
  await notifier.flush(NOW - MIN)
  notifier.enqueue('open', alert(1), NOW)
  const t0 = Date.now()
  await notifier.flush(NOW + MIN)
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(telegram.sent.length, 1, 'Telegram delivers despite the blocked channel')
  const row = () => store.db.prepare("SELECT * FROM outbox_delivery WHERE channel = 'canal-test'").get()
  assert.deepEqual([row().attempts, row().last_error, row().next_try], [1, 'délai dépassé', NOW + MIN + 10_000])
  mode.v = 'fuite'
  await notifier.flush(NOW + 2 * MIN)
  assert.equal(row().last_error, 'POST http://***@ntfy.example.test/x?auth=*** Bearer ***')
  mode.v = '429'
  await notifier.flush(NOW + 5 * MIN)
  assert.equal(row().next_try, NOW + 5 * MIN + 90_000)
  mode.v = 'ok'
  await notifier.flush(NOW + 7 * MIN)
  assert.deepEqual([mode.sent, row().sent_at], [1, NOW + 7 * MIN])
})

test('rules: channel_error is a core type, emitted last (after the modules), without moving anything; without channels, none', async () => {
  const { createRules, CORE_RULES, RULE_LABEL } = await import('../lib/alerts/rules.js')
  assert.ok(CORE_RULES.includes('channel_error'))
  assert.equal(RULE_LABEL.channel_error, 'Canal de notification en échec')
  const monitor = { checks: [], result: () => null }
  const host = createHost({ cfg: {}, log: quiet, plugins: [] })
  const sig = { key: 'channel_error:telegram', rule: 'channel_error', entity: 'telegram', title: 'Canal Telegram en échec', env: 'prod', cond: true, forSec: 600, severity: 'warning', detail: 'x', link: '/alertes', parents: [] }
  const without = createRules(cfg, monitor, null, null, null, null, null, { host }).evaluate({}, NOW)
  const withCh = createRules(cfg, monitor, null, null, null, null, null, { host, channels: () => [sig] }).evaluate({}, NOW)
  assert.deepEqual(withCh.slice(0, -1), without)
  assert.deepEqual(withCh.at(-1), sig)
  assert.ok(!without.some(s => s.rule === 'channel_error'))
})

test('masking: a Telegram or channel error that would carry a URL with credentials, a token or a Bearer goes out masked (queue, state, log)', async () => {
  const logs = []
  const store = openDb(tmpDir('vigie-p4e-redact-'))
  const telegram = { configured: true, chatId: '42', send: async () => { throw new TelegramError('réseau : https://api.example.test/botAAA:bbb123456789012345678901234/sendMessage?token=abc123 Bearer xyz9876543210') } }
  const ch = channelFake('autre')
  ch.send = async () => { throw new Error('POST http://u:p4ss@h.example.test/?jeton=s3cret Bearer zz98765432') }
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter, log: { log() {}, error: m => logs.push(String(m)) }, channels: () => [ch] })
  await notifier.flush(NOW - MIN)
  notifier.enqueue('open', alert(1), NOW)
  await notifier.flush(NOW + MIN)
  const all = JSON.stringify({ logs, status: notifier.status(NOW + MIN), outbox: store.db.prepare('SELECT last_error FROM outbox').all(), delivery: store.db.prepare('SELECT last_error FROM outbox_delivery').all() })
  for (const leak of ['bbb123456789012345678901234', 'abc123', 'xyz9876543210', 'p4ss', 's3cret', 'zz98765432']) assert.ok(!all.includes(leak), leak)
  assert.match(all, /http:\/\/\*\*\*@h\.example\.test\/\?jeton=\*\*\*/)
})

test('Retry-After capped at 15 min: Telegram (429 retry_after 86,400) and a plugin\'s channel (retryAfter 86,400) retry at most 15 min later', async () => {
  const { RETRY_AFTER_MAX_SEC } = await import('../lib/notify/notifier.js')
  assert.equal(RETRY_AFTER_MAX_SEC, 900)
  // Telegram
  const store = openDb(tmpDir('vigie-p4e-ra-'))
  const telegram = { configured: true, chatId: '42', send: async () => { throw new TelegramError('Too Many Requests: retry after 86400', { retryAfter: 86_400 }) } }
  const n = createNotifier({ cfg, store, clock, telegram, formatter, log: quiet })
  n.enqueue('open', alert(1), NOW)
  await n.flush(NOW + MIN)
  assert.equal(store.db.prepare('SELECT next_try FROM outbox').get().next_try, NOW + MIN + 900_000)
  // a plugin's channel
  const p = definePlugin({ id: 'canal-lent', apiVersion: 0, configured: () => true, setup: () => ({ channel: { send: async () => { throw Object.assign(new Error('trop de requêtes'), { retryAfter: 86_400 }) } } }) })
  const host = createHost({ cfg: {}, log: quiet, plugins: [p] })
  const s2 = openDb(tmpDir('vigie-p4e-ra2-'))
  const n2 = createNotifier({ cfg, store: s2, clock, telegram: telegramFake(), formatter, log: quiet, channels: () => host.channels() })
  await n2.flush(NOW - MIN)
  n2.enqueue('open', alert(1), NOW)
  await n2.flush(NOW + MIN)
  assert.equal(s2.db.prepare("SELECT next_try FROM outbox_delivery WHERE channel = 'canal-lent'").get().next_try, NOW + MIN + 900_000)
  // and a (non-plugin) channel that passes 86,400 as is: capped too by the notifier
  const raw = channelFake('brut')
  raw.send = async () => { throw Object.assign(new Error('attendre'), { retryAfter: 86_400 }) }
  const s3 = openDb(tmpDir('vigie-p4e-ra3-'))
  const n3 = createNotifier({ cfg, store: s3, clock, telegram: telegramFake(), formatter, log: quiet, channels: () => [raw] })
  await n3.flush(NOW - MIN)
  n3.enqueue('open', alert(1), NOW)
  await n3.flush(NOW + MIN)
  assert.equal(s3.db.prepare("SELECT next_try FROM outbox_delivery WHERE channel = 'brut'").get().next_try, NOW + MIN + 900_000)
})

test('channel_error goes out on every channel: the one that was down receives it on recovery (Telegram alone: we learn it had gone down)', async () => {
  const { createEngine } = await import('../lib/alerts/engine.js')
  const { createRules } = await import('../lib/alerts/rules.js')
  const { createSilences } = await import('../lib/alerts/silences.js')
  const store = openDb(tmpDir('vigie-p4e-ce-'))
  const telegram = telegramFake()
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter, log: quiet })
  const host = createHost({ cfg: {}, log: quiet, plugins: [] })
  const rules = createRules(cfg, { checks: [], result: () => null }, null, null, null, null, null, { host, channels: () => notifier.channelSignals() })
  const engine = createEngine({ cfg, store, rules, notifier, clock, silences: createSilences({ store }), startedAt: NOW - 3600_000 })
  notifier.enqueueRaw('test', '🧪 premier', { now: NOW })
  telegram.down = true
  for (let t = NOW; t <= NOW + 15 * MIN; t += MIN) {
    engine.evaluate({}, t)
    await notifier.flush(t)
  }
  assert.equal(engine.get('channel_error:telegram').state, 'firing')
  telegram.down = false
  for (let t = NOW + 16 * MIN; t <= NOW + 20 * MIN; t += MIN) {
    engine.evaluate({}, t)
    await notifier.flush(t)
  }
  assert.ok(telegram.sent.some(m => m.includes('Canal Telegram en échec')), 'received by Telegram when it is back')
})
