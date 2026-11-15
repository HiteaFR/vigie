// Golden of the notifications, frozen on the code from before the channels. Three outputs:
// - outbox.txt: send queue of the golden world with a fake Telegram that goes down (network, 429, 500),
//   rejects a message (400), rejects the HTML ("parse entities"), then comes back; calls received in
//   order, then the final state of each queue row;
// - notify-policy.txt: sending policy (immediate, digest, nothing; with or without sound) by event
//   type, severity, environment and moment (working day, quiet hours, weekend), deferred
//   queue and the digest that consumes it;
// - bot.txt: bot replies to its commands, acknowledgments and silences by button (reason asked,
//   reply to the reason, expired request), refused accounts.
// No network call: fake Telegram; fixed clock.
import { createNotifier } from '../../lib/notify/notifier.js'
import { TelegramError } from '../../lib/notify/telegram.js'
import { createFormatter } from '../../lib/notify/format.js'
import { createDigest } from '../../lib/notify/digest.js'
import { createBot } from '../../lib/notify/bot.js'
import { createEngine } from '../../lib/alerts/engine.js'
import { createSilences } from '../../lib/alerts/silences.js'
import { createClock } from '../../lib/clock.js'
import { openDb } from '../../lib/db.js'
import { tmpDir } from '../tmpdir.js'

const MIN = 60_000
const H = 3600_000
const quietLog = { log() {}, warn() {}, error() {} }
const hm = (clock, t) => clock.hm(t)
const firstLine = s => String(s).split('\n')[0]

// --- send queue: Telegram outages, then recovery ---------------------------------------------------
// script: one response per send call (in order); beyond that, success
function scriptedTelegram(script) {
  const calls = []
  let n = 0
  return {
    configured: true,
    chatId: '42',
    calls,
    async send(text, opts = {}) {
      const step = script[n++] ?? 'ok'
      calls.push({ step, text, silent: !!opts.silent, html: opts.html !== false, buttons: opts.replyMarkup?.inline_keyboard?.map(row => row.map(b => b.callback_data).join('+')) ?? [] })
      if (typeof step === 'function') return step(text)
      if (step === 'ok') return { message_id: n }
      if (step === 'réseau') throw new TelegramError('réseau : ECONNRESET')
      if (step === '429') throw new TelegramError('Too Many Requests: retry after 7', { retryAfter: 7 })
      if (step === '500') throw new TelegramError('Internal Server Error')
      if (step === '400') throw new TelegramError('Bad Request: message is too long', { permanent: true })
      if (step === 'html') throw new TelegramError("Bad Request: can't parse entities", { permanent: true })
      throw new Error(`étape inconnue ${step}`)
    },
  }
}

export async function outboxOutput(w, NOW) {
  const clock = createClock(w.cfg.alerts.timezone)
  const formatter = createFormatter({ dashboardUrl: w.cfg.alerts.dashboardUrl, clock })
  // 1 network, 2 429, 3 batch in 400 → one by one: 4 ok, 5 400 (rejected), 6 500 (the rest goes again),
  // 7 HTML refused → 8 plain text ok, then everything goes through
  const telegram = scriptedTelegram(['réseau', '429', '400', 'ok', '400', '500', 'html', 'ok'])
  const notifier = createNotifier({ cfg: w.cfg, store: w.store, clock, telegram, formatter, buttons: true, log: quietLog })
  const silences = createSilences({ store: w.store })
  const start = NOW - 2 * H
  const engine = createEngine({ cfg: w.cfg, store: w.store, rules: w.rules, notifier, clock, silences, startedAt: start - H })
  for (let t = start; t <= NOW; t += 5 * MIN) engine.evaluate(w.snap, t)
  notifier.enqueueRaw('test', '🧪 message direct', { now: NOW })
  const out = ['# appels à Telegram (heure · réponse · son · HTML · boutons · première ligne · éléments)']
  for (let t = NOW; t <= NOW + 3 * H; t += MIN) {
    const before = telegram.calls.length
    await notifier.flush(t)
    for (const c of telegram.calls.slice(before)) {
      out.push(`${hm(clock, t)} · ${c.step} · ${c.silent ? 'muet' : 'son'} · ${c.html ? 'html' : 'brut'} · [${c.buttons.join(' ')}] · ${firstLine(c.text)} · ${c.text.split('\n\n').length}`)
    }
  }
  out.push('', '# file (id · clé · type · gravité · voie · muet · envoyé · essais · prochain essai · abandon · erreur)')
  const at = t => (t == null ? '—' : hm(clock, t))
  for (const r of w.store.db.prepare('SELECT * FROM outbox ORDER BY id').all()) {
    out.push(`${r.id} · ${r.key ?? '—'} · ${r.kind} · ${r.severity ?? '—'} · ${r.deliver} · ${r.silent} · ${at(r.sent_at)} · ${r.attempts} · ${r.next_try ? at(r.next_try) : '—'} · ${r.dropped ?? '—'} · ${r.last_error ?? '—'}`)
  }
  const st = notifier.status(NOW + 3 * H)
  out.push('', `# état : ${JSON.stringify({ ...st, lastSentAt: at(st.lastSentAt), lastError: st.lastError && { ...st.lastError, at: at(st.lastError.at) } })}`)
  return `${out.join('\n')}\n`
}

// --- sending policy, deferred, digest ---------------------------------------------------------------
export function policyOutput(cfg) {
  const clock = createClock(cfg.alerts.timezone)
  const formatter = createFormatter({ dashboardUrl: cfg.alerts.dashboardUrl, clock })
  const store = openDb(tmpDir('vigie-golden-policy-'))
  const notifier = createNotifier({ cfg, store, clock, telegram: { configured: false }, formatter, log: quietLog })
  // moments (Paris time): Tuesday 10:00 (working), Tuesday 20:00 (evening, outside working hours),
  // Tuesday 02:00 (quiet hours), Saturday 11:00 (weekend)
  const moments = { 'mardi 10:00': Date.parse('2026-11-10T09:00:00Z'), 'mardi 20:00': Date.parse('2026-11-10T19:00:00Z'), 'mardi 02:00': Date.parse('2026-11-10T01:00:00Z'), 'samedi 11:00': Date.parse('2026-11-14T10:00:00Z') }
  const kinds = ['open', 'escalate', 'remind', 'resolve', 'stable']
  const out = ['# voie (now, digest, skip) et son, par type × gravité × environnement × moment']
  let id = 0
  for (const [label, t] of Object.entries(moments)) {
    for (const env of ['prod', 'dev']) {
      for (const sev of ['critical', 'warning', 'info']) {
        const cells = []
        for (const kind of kinds) {
          for (const notifiedVia of kind === 'resolve' ? ['now', 'digest'] : [null]) {
            id++
            const st = { key: `r:${id}`, rule: 'r', entity: String(id), title: `Alerte ${id}`, env, severity: sev, state: kind === 'stable' ? 'ok' : 'firing', notifiedVia, incidentId: id, detail: 'détail', since: t - H, firedAt: t - H, host: null, link: null }
            const via = notifier.enqueue(kind, st, t)
            const row = store.db.prepare('SELECT silent FROM outbox WHERE key = ?').get(st.key)
            cells.push(`${kind}${notifiedVia ? `(${notifiedVia})` : ''}=${via}${row ? (row.silent ? '' : '+son') : ''}`)
          }
        }
        out.push(`${label} · ${env} · ${sev} : ${cells.join(' ')}`)
      }
    }
  }
  // deferred, then the next day's 08:00 digest that consumes them
  const deferred = notifier.deferred()
  out.push('', `# différés : ${deferred.length}`, ...deferred.slice(0, 12).map(r => `${r.key} · ${r.kind} · ${r.severity} · ${firstLine(r.text)}`))
  const digest = createDigest({ cfg, store, notifier, clock, build: () => '☀️ digest de banc', log: quietLog })
  const ticks = []
  for (const t of [Date.parse('2026-11-11T06:59:00Z'), Date.parse('2026-11-11T07:00:00Z'), Date.parse('2026-11-11T07:01:00Z'), Date.parse('2026-11-11T12:00:00Z')]) ticks.push(`${clock.hm(t)}=${digest.tick(t)}`)
  const st = notifier.status(Date.parse('2026-11-11T07:01:00Z'))
  out.push('', `# digest : ${ticks.join(' ')} ; différés restants ${notifier.deferred().length} ; file ${st.queued} ; ligne du digest : ${store.db.prepare("SELECT kind, deliver, silent, text FROM outbox WHERE kind = 'digest'").all().map(r => `${r.kind}/${r.deliver}/${r.silent}/${r.text}`).join(', ')}`)
  out.push(`# heures calmes : ${Object.entries(moments).map(([l, t]) => `${l}=${notifier.quiet(t)}`).join(' ')}`)
  store.db.close()
  return `${out.join('\n')}\n`
}

// --- bot ----------------------------------------------------------------------------------------------
export async function botOutput(w, NOW) {
  const clock = createClock(w.cfg.alerts.timezone)
  const formatter = createFormatter({ dashboardUrl: w.cfg.alerts.dashboardUrl, clock })
  const calls = []
  let msgId = 100
  const telegram = {
    configured: true, chatId: '42',
    send: async (text, opts = {}) => { calls.push(`envoi${opts.silent ? '' : ' (son)'}${opts.replyMarkup ? ` ${JSON.stringify(opts.replyMarkup)}` : ''}${opts.replyTo ? ` en réponse à ${opts.replyTo}` : ''} : ${text}`); return { message_id: ++msgId } },
    answerCallback: async (id, text = '') => { calls.push(`réponse au bouton ${id}${text ? ` : ${text}` : ''}`) },
    clearButtons: async id => { calls.push(`boutons retirés du message ${id}`) },
    getUpdates: async () => [], setCommands: async () => {},
  }
  const silences = createSilences({ store: w.store })
  const notifier = { enqueue: () => 'skip', enqueueRaw() {} }
  const engine = createEngine({ cfg: w.cfg, store: w.store, rules: w.rules, notifier, clock, silences, startedAt: NOW - 3 * H })
  for (let t = NOW - 2 * H; t <= NOW; t += 5 * MIN) engine.evaluate(w.snap, t)
  const audits = []
  const audit = { log: e => audits.push(`${e.actor} · ${e.action} · ${e.target ?? '—'}${e.ok === false ? ' · refus' : ''}${e.detail ? ` · ${e.detail}` : ''}`), refused: e => audits.push(`refus · ${e.actor} · ${e.target}`) }
  let t = NOW
  const refresher = { run: () => ({ cooldownSec: 42 }) }
  const bot = createBot({ telegram, store: w.store, cfg: w.cfg, engine, silences, refresher, audit, clock, texts: { status: () => '🟢 état de banc', digest: () => '☀️ digest de banc' }, allowedIds: '7, 8', log: quietLog, now: () => t })
  const firing = engine.active().filter(a => a.state === 'firing' && a.incidentId).sort((a, b) => a.incidentId - b.incidentId)
  const a1 = firing[0]
  const a2 = firing[1]
  const out = []
  const step = async (label, u) => {
    const before = calls.length
    const ab = audits.length
    await bot.handle({ update_id: ++msgId, ...u })
    out.push(`## ${label}`, ...calls.slice(before), ...audits.slice(ab).map(x => `audit : ${x}`), '')
  }
  const msg = (text, { from = 7, chat = 42, replyTo = null } = {}) => ({ message: { message_id: ++msgId, text, from: { id: from, username: `u${from}` }, chat: { id: chat }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } })
  const cb = (data, { from = 7 } = {}) => ({ callback_query: { id: `cb${msgId}`, data, from: { id: from, username: `u${from}` }, message: { message_id: 555, chat: { id: 42 } } } })
  await step('compte non autorisé', msg('/status', { from: 9 }))
  await step('chat non autorisé', msg('/status', { chat: 43 }))
  await step('bouton d\'un compte non autorisé', cb(`a:${a1.incidentId}`, { from: 9 }))
  for (const c of ['/help', '/start', '/status', '/down', '/silences', '/digest', '/refresh', '/inconnue', 'bonjour', '/ack', `/ack #${a1.incidentId}`, `/ack #${a1.incidentId} ok`, '/ack #999999 je regarde', `/ack #${a1.incidentId} je m'en occupe`, `/unack #${a1.incidentId}`, `/unack #${a1.incidentId}`,
    '/mute', '/mute inconnu 2h motif', '/mute web 99j motif', '/mute web 2h', '/mute web 2h migration de banc', '/silences', '/unmute 999', '/unmute 1', '/connu 3 téléphone', '/reseau', '/appareil 3']) {
    await step(c, msg(c))
  }
  // buttons: acknowledgment and silence, reason asked then given, too short, expired, unknown alert
  await step(`bouton ack de #${a1.incidentId}`, cb(`a:${a1.incidentId}`))
  const askAck = msgId
  await step('motif trop court', msg('ok', { replyTo: askAck }))
  await step(`bouton ack de #${a1.incidentId} (encore)`, cb(`a:${a1.incidentId}`))
  await step('motif donné', msg('je regarde le banc', { replyTo: msgId }))
  await step(`bouton silence de #${a2.incidentId}`, cb(`s:${a2.incidentId}`))
  const askMute = msgId
  t = NOW + 20 * MIN
  await step('motif donné trop tard (demande expirée)', msg('trop tard pour ce motif', { replyTo: askMute }))
  t = NOW
  await step(`bouton silence de #${a2.incidentId} (encore)`, cb(`s:${a2.incidentId}`))
  await step('motif donné', msg('maintenance de banc', { replyTo: msgId }))
  await step('bouton d\'une alerte inconnue', cb('a:999999'))
  await step('bouton retiré (i:)', cb('i:3'))
  await step('bouton réseau sans module', cb('n:3'))
  await step('donnée de bouton forgée', cb('x:1'))
  out.push(`# état : ${JSON.stringify(bot.status())}`)
  return `${out.join('\n')}\n`
}
