// A permanently refused message
// no longer blocks its batch. Real notifier, fake Telegram (no real sending).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../lib/notify/notifier.js'
import { TelegramError } from '../lib/notify/telegram.js'
import { createClock } from '../lib/clock.js'
import { createFormatter } from '../lib/notify/format.js'
import { prodConfig, quiet } from './network-fixture.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-27T10:00:00Z')

// rules(text, opts) → undefined (success) or a TelegramError to throw
function bench(rules) {
  const store = tmpStore('dash-notifier-split-')
  const tz = createClock('Europe/Paris')
  const calls = []
  const telegram = {
    configured: true, chatId: '1',
    send: async (text, opts = {}) => {
      calls.push({ text, html: opts.html !== false })
      const e = rules(text, opts)
      if (e) throw e
      return { message_id: calls.length }
    },
  }
  const n = createNotifier({ cfg: prodConfig(), store, clock: tz, telegram, formatter: createFormatter({ dashboardUrl: 'http://x', clock: tz }), log: quiet })
  const rows = () => store.db.prepare('SELECT text, sent_at IS NOT NULL AS sent, dropped, last_error, next_try, attempts FROM outbox ORDER BY id').all()
  const pending = () => store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_at IS NULL AND dropped IS NULL').get().n
  return { n, calls, rows, pending }
}
const refused = msg => new TelegramError(`Bad Request: ${msg}`, { permanent: true })
const network = () => new TelegramError('réseau : ECONNRESET')

test('batch of 3, the 2nd refused with 400 → 1 and 3 sent in the same pass, 2 dropped as "rejected"; queue empty', async () => {
  const b = bench(text => (text.includes('deux') ? refused('message is too long') : undefined))
  for (const t of ['un', 'deux', 'trois']) b.n.enqueueRaw('test', `message ${t}`, { now: T })
  await b.n.flush(T)
  const r = b.rows()
  assert.deepEqual(r.map(x => [x.text, !!x.sent, x.dropped]), [['message un', true, null], ['message deux', false, 'rejected'], ['message trois', true, null]])
  assert.match(r[1].last_error, /message is too long/)
  assert.equal(b.pending(), 0)
  // a single pass: the batch, then the three one by one
  assert.equal(b.calls.length, 4)
})

test('batch of 3, sending the 2nd alone fails on the network → 1 sent, 2 and 3 pending with a delay; 3 never tried', async () => {
  const b = bench(text => {
    if (text.includes('\n\n')) return refused('message is too long') // the whole batch
    if (text.includes('deux')) return network()
    return undefined
  })
  for (const t of ['un', 'deux', 'trois']) b.n.enqueueRaw('test', `message ${t}`, { now: T })
  await b.n.flush(T)
  const r = b.rows()
  assert.deepEqual(r.map(x => [x.text, !!x.sent, x.dropped]), [['message un', true, null], ['message deux', false, null], ['message trois', false, null]])
  for (const x of r.slice(1)) {
    assert.ok(x.next_try > T, 'delay set')
    assert.equal(x.attempts, 1)
    assert.match(x.last_error, /ECONNRESET/)
  }
  assert.ok(!b.calls.some(c => c.text === 'message trois'), 'the 3rd is not tried alone')
})

test('batch of one, refused with 400 → dropped as "rejected" (unchanged)', async () => {
  const b = bench(() => refused('chat not found'))
  b.n.enqueueRaw('test', 'message seul', { now: T })
  await b.n.flush(T)
  assert.deepEqual(b.rows().map(x => [!!x.sent, x.dropped]), [[false, 'rejected']])
  assert.equal(b.calls.length, 1)
})

test('batch of 2 refused, one of them with HTML refused alone ("parse entities") then accepted as plain text → 2 sent', async () => {
  const b = bench((text, opts) => {
    if (text.includes('\n\n')) return refused('message is too long') // the whole batch
    if (opts.html !== false && text.includes('<b>mal fermé')) return refused("can't parse entities: unclosed tag")
    return undefined
  })
  b.n.enqueueRaw('test', 'message simple', { now: T })
  b.n.enqueueRaw('test', '<b>mal fermé message', { now: T })
  await b.n.flush(T)
  assert.deepEqual(b.rows().map(x => [x.text, !!x.sent, x.dropped]), [['message simple', true, null], ['<b>mal fermé message', true, null]])
  // the second went out as plain text, tag removed
  const last = b.calls.at(-1)
  assert.deepEqual([last.html, last.text], [false, 'mal fermé message'])
})
