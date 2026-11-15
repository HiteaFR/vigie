// Telegram client (lib/notify/telegram.js) with a FAKE fetch: no real request, fake token.
// Sending, 400 that drops the message (with the real notifier), 429 and retry_after, 409, 401,
// network error and timeout; the token never appears in an error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTelegram, TelegramError } from '../lib/notify/telegram.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createClock } from '../lib/clock.js'
import { createFormatter } from '../lib/notify/format.js'
import { prodConfig, quiet } from './network-fixture.js'
import { tmpStore } from './tmpdir.js'

const TOKEN = '123456:jeton-factice-du-banc'
const T = Date.parse('2026-10-28T10:00:00Z')

// fake fetch: reply(url, body, n) → { status, json } or throws; keeps each call
function fakeFetch(reply) {
  const calls = []
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, method: init.method, headers: init.headers, body, signal: init.signal })
    const r = await reply(url, body, calls.length)
    return new Response(r.raw ?? JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}
const ok = result => ({ json: { ok: true, result } })
const ko = (status, description, parameters) => ({ status, json: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) } })
const caught = async p => {
  try {
    await p
  } catch (e) {
    return e
  }
  assert.fail('error expected')
}

test('telegram configured: token and chat required; chatId as text', () => {
  const f = fakeFetch(() => ok(true))
  assert.equal(createTelegram({ token: TOKEN, chatId: 42, fetch: f.fetch }).configured, true)
  assert.equal(createTelegram({ token: TOKEN, chatId: 42, fetch: f.fetch }).chatId, '42')
  assert.equal(createTelegram({ token: TOKEN, fetch: f.fetch }).configured, false)
  assert.equal(createTelegram({ chatId: 42, fetch: f.fetch }).configured, false)
  assert.equal(createTelegram({ fetch: f.fetch }).chatId, null)
  assert.equal(f.calls.length, 0)
})

test('telegram send: JSON POST to sendMessage, HTML by default, silent, buttons, reply; result returned', async () => {
  const f = fakeFetch(() => ok({ message_id: 7 }))
  const tg = createTelegram({ token: TOKEN, chatId: '42', fetch: f.fetch })
  assert.deepEqual(await tg.send('<b>alerte</b>'), { message_id: 7 })
  const [c] = f.calls
  assert.equal(c.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.equal(c.method, 'POST')
  assert.equal(c.headers['content-type'], 'application/json')
  assert.ok(c.signal instanceof AbortSignal)
  assert.deepEqual(c.body, { chat_id: '42', text: '<b>alerte</b>', parse_mode: 'HTML', disable_notification: false, link_preview_options: { is_disabled: true } })
  const kb = { inline_keyboard: [[{ text: 'Acquitter', callback_data: 'ack:x' }]] }
  await tg.send('brut', { silent: true, html: false, replyMarkup: kb, replyTo: 5 })
  assert.deepEqual(f.calls[1].body, { chat_id: '42', text: 'brut', disable_notification: true, link_preview_options: { is_disabled: true }, reply_markup: kb, reply_parameters: { message_id: 5, allow_sending_without_reply: true } })
})

test('telegram other methods: getUpdates (delay = timeout + 15 s), answerCallback truncated to 190, setCommands, clearButtons', async () => {
  const f = fakeFetch(() => ok([]))
  const tg = createTelegram({ token: TOKEN, chatId: '42', fetch: f.fetch })
  await tg.getUpdates({ timeout: 30, offset: 9 })
  await tg.answerCallback('cb1', 'x'.repeat(300))
  await tg.setCommands([{ command: 'status', description: 'état' }])
  await tg.clearButtons(77)
  assert.deepEqual(f.calls.map(c => c.url.split('/').pop()), ['getUpdates', 'answerCallbackQuery', 'setMyCommands', 'editMessageReplyMarkup'])
  assert.deepEqual(f.calls[0].body, { timeout: 30, offset: 9 })
  assert.equal(f.calls[1].body.text.length, 190)
  assert.deepEqual(f.calls[2].body.scope, { type: 'chat', chat_id: '42' })
  assert.deepEqual(f.calls[3].body, { chat_id: '42', message_id: 77, reply_markup: { inline_keyboard: [] } })
})

test('telegram errors: 400 permanent; 429 retry_after (30 by default); 409 → 60 s; 401 and 403 not permanent; unreadable body → "HTTP <code>"', async () => {
  const cases = [
    [ko(400, 'Bad Request: message is too long'), { message: 'Bad Request: message is too long', permanent: true, retryAfter: null }],
    [ko(429, 'Too Many Requests: retry after 12', { retry_after: 12 }), { message: 'Too Many Requests: retry after 12', permanent: false, retryAfter: 12 }],
    [ko(429, 'Too Many Requests'), { message: 'Too Many Requests', permanent: false, retryAfter: 30 }],
    [ko(409, 'Conflict: terminated by other getUpdates request'), { message: 'Conflict: terminated by other getUpdates request', permanent: false, retryAfter: 60 }],
    [ko(401, 'Unauthorized'), { message: 'Unauthorized', permanent: false, retryAfter: null }],
    [ko(403, 'Forbidden: bot was blocked by the user'), { message: 'Forbidden: bot was blocked by the user', permanent: false, retryAfter: null }],
    [{ status: 502, raw: '<html>Bad Gateway</html>' }, { message: 'HTTP 502', permanent: false, retryAfter: null }],
  ]
  for (const [reply, want] of cases) {
    const tg = createTelegram({ token: TOKEN, chatId: '42', fetch: fakeFetch(() => reply).fetch })
    const e = await caught(tg.send('x'))
    assert.ok(e instanceof TelegramError, want.message)
    assert.deepEqual({ message: e.message, permanent: e.permanent, retryAfter: e.retryAfter }, want)
  }
})

test('telegram network error and timeout: TelegramError with the network error code, without URL or token', async () => {
  const boom = Object.assign(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  const net = createTelegram({ token: TOKEN, chatId: '42', fetch: async () => { throw boom } })
  const e1 = await caught(net.send('x'))
  assert.deepEqual([e1 instanceof TelegramError, e1.message, e1.permanent, e1.retryAfter], [true, 'réseau : ECONNREFUSED', false, null])
  const slow = createTelegram({ token: TOKEN, chatId: '42', fetch: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') } })
  const e2 = await caught(slow.send('x'))
  assert.equal(e2.message, 'réseau : TimeoutError')
  for (const e of [e1, e2]) {
    assert.doesNotMatch(`${e.message} ${e.stack}`, /jeton-factice|api\.telegram\.org/)
  }
})

test('telegram + notifier: a 400 drops the message ("rejected"), a 429 puts it back in the queue after retry_after', async () => {
  const run = async reply => {
    const store = tmpStore('dash-telegram-')
    const tz = createClock('Europe/Paris')
    const f = fakeFetch(reply)
    const telegram = createTelegram({ token: TOKEN, chatId: '42', fetch: f.fetch })
    const n = createNotifier({ cfg: prodConfig(), store, clock: tz, telegram, formatter: createFormatter({ dashboardUrl: 'http://dash.test', clock: tz }), log: quiet })
    n.enqueueRaw('test', 'message factice', { now: T })
    await n.flush(T)
    return { calls: f.calls, row: store.db.prepare('SELECT sent_at IS NOT NULL AS sent, dropped, last_error, next_try FROM outbox').get() }
  }
  const sent = await run(() => ok({ message_id: 1 }))
  assert.deepEqual([sent.calls.length, !!sent.row.sent, sent.row.dropped], [1, true, null])
  const rejected = await run(() => ko(400, 'Bad Request: chat not found'))
  assert.deepEqual([rejected.calls.length, !!rejected.row.sent, rejected.row.dropped], [1, false, 'rejected'])
  assert.match(rejected.row.last_error, /chat not found/)
  // HTML refused: one attempt as plain text, then drop if it is refused too
  const html = await run(() => ko(400, "Bad Request: can't parse entities"))
  assert.deepEqual([html.calls.length, html.calls[0].body.parse_mode, html.calls[1].body.parse_mode, html.row.dropped], [2, 'HTML', undefined, 'rejected'])
  const limited = await run(() => ko(429, 'Too Many Requests', { retry_after: 17 }))
  assert.deepEqual([!!limited.row.sent, limited.row.dropped, limited.row.next_try], [false, null, T + 17_000])
})
