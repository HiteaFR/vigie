// Persistent send queue (outbox table) and notification policy.
//
//  - critical: sent right away, with sound (recoveries and reminders without sound)
//  - warning : right away without sound; at night (quiet hours), postponed to the digest.
//              In dev (staging), only during business hours, otherwise digest.
//  - info    : digest only
//
// Messages go out grouped: we wait HOLD_MS after the first one, so that a
// burst (e.g. a host going down with its services) fits in a single message.
// An unsent notification stays queued and goes out again after a restart.
import { telegramChannel, plain } from './channels.js'
import { redact } from '../redact.js'
import { t as tr } from '../i18n.js'
import { DROPPED } from '../codes.js'

const HOLD_MS = 15_000
// reasons for dropping a queued message (dropped column of outbox and outbox_delivery): codes of
// lib/codes.js; readers only test IS NULL and DRY_RUN, whose value never changed, so the former
// French values of older rows need no mapping here (droppedCode gives it, for any future reader)
export { DROPPED }
const EXPIRE_MS = 24 * 3600_000

// Telegram is a channel (lib/notify/channels.js: rendering, buttons, plain-text fallback);
// buttonsFor lives there and is still exported from here
export { buttonsFor } from './channels.js'

// channels besides Telegram (channels() → list of channels, lib/notify/channels.js; plugins through
// host.channels()). Each one receives every immediate notification created since it was put into
// service (kv channel.<id>.since), with the same policy (grouping, expiry, retry,
// one-by-one sending after a refusal); its state is in outbox_delivery. Channel errors (Telegram
// included) are masked (lib/redact.js) before the queue, the state and the log. A failing channel blocks
// neither Telegram nor the others: each has its own queue and retries. Dry run: no channel sends.
export const CHANNEL_ERROR_FOR_SEC = 600
// a channel's Retry-After (Telegram included) is capped: an 86,400 does not freeze the channel for 24 h
export const RETRY_AFTER_MAX_SEC = 15 * 60
export function createNotifier({ cfg, store, clock, telegram, formatter, dryRun = false, buttons = false, log = console, channels = () => [] }) {
  const { db } = store
  const A = cfg.alerts
  const q = {
    insert: db.prepare(`INSERT INTO outbox (created_at, key, kind, severity, text, silent, deliver, incident_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    pending: db.prepare(`SELECT * FROM outbox WHERE sent_at IS NULL AND dropped IS NULL AND deliver = 'now'
      ORDER BY created_at, id LIMIT ?`),
    sent: db.prepare('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?'),
    failed: db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_try = ? WHERE id = ?'),
    dropped: db.prepare('UPDATE outbox SET dropped = ?, last_error = COALESCE(?, last_error) WHERE id = ?'),
    deferred: db.prepare(`SELECT * FROM outbox WHERE sent_at IS NULL AND dropped IS NULL AND deliver = 'digest' ORDER BY created_at`),
    consume: db.prepare(`UPDATE outbox SET sent_at = ? WHERE sent_at IS NULL AND dropped IS NULL AND deliver = 'digest' AND created_at <= ?`),
    counts: db.prepare(`SELECT deliver, COUNT(*) n FROM outbox WHERE sent_at IS NULL AND dropped IS NULL GROUP BY deliver`),
    lastSent: db.prepare(`SELECT MAX(sent_at) t FROM outbox WHERE deliver = 'now' AND sent_at IS NOT NULL AND dropped IS NULL`),
    // channels besides Telegram
    chPending: db.prepare(`SELECT o.*, COALESCE(d.attempts, 0) AS ch_attempts, COALESCE(d.next_try, 0) AS ch_next FROM outbox o
      LEFT JOIN outbox_delivery d ON d.outbox_id = o.id AND d.channel = ?
      WHERE o.deliver = 'now' AND o.created_at >= ? AND d.sent_at IS NULL AND d.dropped IS NULL AND (o.dropped IS NULL OR o.dropped <> '${DROPPED.DRY_RUN}')
      ORDER BY o.created_at, o.id LIMIT ?`),
    chSent: db.prepare(`INSERT INTO outbox_delivery (outbox_id, channel, sent_at, attempts) VALUES (?, ?, ?, 1)
      ON CONFLICT(outbox_id, channel) DO UPDATE SET sent_at = excluded.sent_at, attempts = attempts + 1, last_error = NULL`),
    chFailed: db.prepare(`INSERT INTO outbox_delivery (outbox_id, channel, attempts, next_try, last_error) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(outbox_id, channel) DO UPDATE SET attempts = attempts + 1, next_try = excluded.next_try, last_error = excluded.last_error`),
    chDropped: db.prepare(`INSERT INTO outbox_delivery (outbox_id, channel, dropped, last_error) VALUES (?, ?, ?, ?)
      ON CONFLICT(outbox_id, channel) DO UPDATE SET dropped = excluded.dropped, last_error = COALESCE(excluded.last_error, last_error)`),
    chCount: db.prepare(`SELECT COUNT(*) n FROM outbox o LEFT JOIN outbox_delivery d ON d.outbox_id = o.id AND d.channel = ?
      WHERE o.deliver = 'now' AND o.created_at >= ? AND d.sent_at IS NULL AND d.dropped IS NULL`),
    chLast: db.prepare('SELECT MAX(sent_at) t FROM outbox_delivery WHERE channel = ?'),
  }
  // ongoing failure per channel (since when, last message): channel_error alert
  let primaryFailingSince = null
  const chState = new Map() // id → { lastError, failingSince }
  const stateOf = id => chState.get(id) ?? chState.set(id, { lastError: null, failingSince: null }).get(id)
  let lastError = null
  let busy = false

  const quiet = now => clock.inWindow(now, A.quietHours)
  const business = now => clock.inWindow(now, A.businessHours)

  // → 'now' | 'digest' | 'skip', and silent or not
  function policy(kind, st, now) {
    const sev = st.severity
    const followUp = kind === 'resolve' || kind === 'remind' || kind === 'stable'
    if (kind === 'resolve' || (kind === 'stable' && st.state === 'ok')) {
      // the recovery follows the channel of the opening
      return st.notifiedVia === 'now' || kind === 'stable' ? { via: 'now', silent: true } : { via: 'digest' }
    }
    if (sev === 'critical') return { via: 'now', silent: followUp }
    if (sev === 'info') return { via: kind === 'remind' ? 'skip' : 'digest' }
    const allowed = st.env === 'dev' ? business(now) && !quiet(now) : !quiet(now)
    if (allowed) return { via: 'now', silent: true }
    return { via: kind === 'remind' ? 'skip' : 'digest' }
  }

  function enqueue(kind, st, now, extra) {
    const { via, silent = true } = policy(kind, st, now)
    if (via === 'skip') return via
    const text = formatter.render(kind, st, now, extra)
    q.insert.run(now, st.key, kind, st.severity, text, silent ? 1 : 0, via, st.incidentId ?? null)
    if (dryRun || via === 'digest') log.log(`[alert:${via}${silent ? '' : ':sound'}] ${text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ⏎ ')}`)
    return via
  }

  // direct send (digest, test): also goes through the queue for history
  function enqueueRaw(kind, text, { silent = true, now = Date.now() } = {}) {
    q.insert.run(now, null, kind, null, text, silent ? 1 : 0, 'now', null)
    if (dryRun) log.log(`[${kind}] ${text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ⏎ ')}`)
  }

  // main channel (Telegram): its state lives in the queue columns (sent_at, attempts,
  // next_try, dropped)
  const primary = telegramChannel({ telegram, buttons, log })

  async function flush(now = Date.now()) {
    if (busy) return
    busy = true
    try {
      await flushPrimary(now)
      // the other channels, each isolated (its failure stops neither Telegram nor the next ones)
      if (!dryRun) {
        for (const ch of extra()) {
          try {
            await flushChannel(ch, now)
          } catch (e) {
            log.error(`${ch.id}: ${redact(String(e?.message || e))}`)
          }
        }
      }
    } finally {
      busy = false
    }
  }

  // configured channels besides Telegram (a list that throws: none)
  function extra() {
    try {
      return (channels() ?? []).filter(c => c && c.configured && c.id !== primary.id)
    } catch (e) {
      log.error(`channels: ${redact(String(e?.message || e))}`)
      return []
    }
  }

  // Telegram: state kept in the queue columns
  async function flushPrimary(now) {
    {
      const rows = q.pending.all(200)
      if (!rows.length) {
        primaryFailingSince = null
        return
      }
      for (const r of rows) {
        if (now - r.created_at > EXPIRE_MS) q.dropped.run(DROPPED.EXPIRED, null, r.id)
      }
      const live = rows.filter(r => now - r.created_at <= EXPIRE_MS && r.next_try <= now)
      if (!live.length) return
      // give the burst time to arrive (except for a direct send: digest, test)
      const urgent = live.some(r => r.key == null)
      if (!urgent && now - live[0].created_at < HOLD_MS) return
      if (dryRun || !primary.configured) {
        if (dryRun) for (const r of live) q.dropped.run(DROPPED.DRY_RUN, null, r.id)
        return // without Telegram, the queue waits (and expires after 24 h)
      }
      const batch = []
      let len = 0
      for (const r of live.slice(0, primary.limits.maxBatch)) {
        if (batch.length && len + r.text.length + 2 > primary.limits.maxLen) break
        batch.push(r)
        len += r.text.length + 2
      }
      // critical first; the message only rings if at least one item asks for it
      const order = { critical: 0, warning: 1, info: 2 }
      batch.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
      const delayOf = e => (primary.classify(e).retryAfter ? Math.min(primary.classify(e).retryAfter, RETRY_AFTER_MAX_SEC) * 1000 : Math.min(15 * 60_000, 10_000 * 2 ** Math.min(6, batch[0].attempts)))
      try {
        await primary.send(batch)
        for (const r of batch) q.sent.run(now, r.id)
        lastError = null
        primaryFailingSince = null
      } catch (e) {
        lastError = { at: now, message: redact(String(e.message || e)) }
        primaryFailingSince ??= now
        log.error(`${primary.id}: ${lastError.message}`)
        if (primary.classify(e).permanent && batch.length === 1) {
          q.dropped.run(DROPPED.REJECTED, lastError.message, batch[0].id)
          return
        }
        if (primary.classify(e).permanent) {
          // a refused message no longer blocks the batch. One-by-one sending, in
          // order: success → sent; permanent refusal → dropped ("rejected"); other error →
          // this message and the following ones go back to waiting, and we stop there
          for (let i = 0; i < batch.length; i++) {
            const r = batch[i]
            try {
              await primary.send([r])
              q.sent.run(now, r.id)
            } catch (e2) {
              const message = redact(String(e2.message || e2))
              if (primary.classify(e2).permanent) {
                log.error(`${primary.id}: message rejected (${message})`)
                q.dropped.run(DROPPED.REJECTED, message, r.id)
                continue
              }
              lastError = { at: now, message }
              log.error(`${primary.id}: ${message}`)
              const delay = delayOf(e2)
              for (const x of batch.slice(i)) q.failed.run(message, now + delay, x.id)
              return
            }
          }
          return
        }
        const delay = delayOf(e)
        for (const r of batch) q.failed.run(lastError.message, now + delay, r.id)
      }
    }
  }

  // queue item as a channel receives it (rendered HTML text, and its plain-text version)
  const view = r => ({ id: r.id, key: r.key, kind: r.kind, severity: r.severity, silent: !!r.silent, text: r.text, plain: plain(r.text), incidentId: r.incident_id ?? null, createdAt: r.created_at })
  const SEV = { critical: 0, warning: 1, info: 2 }

  // a channel besides Telegram: same policy, state in outbox_delivery
  async function flushChannel(ch, now) {
    const st = stateOf(ch.id)
    const key = `channel.${ch.id}.since`
    let since = Number(store.kv.get(key))
    if (!Number.isFinite(since) || store.kv.get(key) == null) {
      since = now
      store.kv.set(key, since)
    }
    const rows = q.chPending.all(ch.id, since, 200)
    if (!rows.length) {
      st.failingSince = null
      return
    }
    for (const r of rows) if (now - r.created_at > EXPIRE_MS) q.chDropped.run(r.id, ch.id, DROPPED.EXPIRED, null)
    const fresh = rows.filter(r => now - r.created_at <= EXPIRE_MS)
    const accepted = []
    for (const r of fresh) {
      let ok = true
      try {
        ok = ch.accepts ? !!ch.accepts(view(r)) : true
      } catch {
        ok = true
      }
      if (ok) accepted.push(r)
      else q.chDropped.run(r.id, ch.id, DROPPED.FILTERED, null)
    }
    const live = accepted.filter(r => r.ch_next <= now)
    if (!live.length) return
    const urgent = live.some(r => r.key == null)
    if (!urgent && now - live[0].created_at < HOLD_MS) return
    const batch = []
    let len = 0
    for (const r of live.slice(0, ch.limits.maxBatch)) {
      if (batch.length && len + r.text.length + 2 > ch.limits.maxLen) break
      batch.push(r)
      len += r.text.length + 2
    }
    batch.sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3))
    const delayOf = (e, attempts) => {
      const ra = ch.classify(e).retryAfter
      return ra ? Math.min(ra, RETRY_AFTER_MAX_SEC) * 1000 : Math.min(15 * 60_000, 10_000 * 2 ** Math.min(6, attempts))
    }
    const fail = (e, list) => {
      const message = redact(String(e?.message || e))
      st.lastError = { at: now, message }
      st.failingSince ??= now
      log.error(`${ch.id}: ${message}`)
      return message
    }
    try {
      await ch.send(batch.map(view))
      for (const r of batch) q.chSent.run(r.id, ch.id, now)
      st.lastError = null
      st.failingSince = null
    } catch (e) {
      const message = fail(e)
      if (!ch.classify(e).permanent) {
        const delay = delayOf(e, batch[0].ch_attempts)
        for (const r of batch) q.chFailed.run(r.id, ch.id, now + delay, message)
        return
      }
      if (batch.length === 1) {
        q.chDropped.run(batch[0].id, ch.id, DROPPED.REJECTED, message)
        return
      }
      // refusal of a batch: one by one, as for Telegram
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i]
        try {
          await ch.send([view(r)])
          q.chSent.run(r.id, ch.id, now)
        } catch (e2) {
          const m2 = fail(e2)
          if (ch.classify(e2).permanent) {
            q.chDropped.run(r.id, ch.id, DROPPED.REJECTED, m2)
            continue
          }
          const delay = delayOf(e2, r.ch_attempts)
          for (const x of batch.slice(i)) q.chFailed.run(x.id, ch.id, now + delay, m2)
          return
        }
      }
    }
  }

  // one alert per configured channel, raised while it keeps failing (CHANNEL_ERROR_FOR_SEC);
  // it goes out on all channels, the failing one receives it when it comes back (with Telegram
  // alone, this is how you learn it was down)
  function channelSignals() {
    const one = (ch, failingSince, lastErr) => ({
      key: `channel_error:${ch.id}`, rule: 'channel_error', entity: ch.id, title: tr('notify.channel_error_title', { label: ch.label }), env: 'prod',
      cond: failingSince != null, forSec: CHANNEL_ERROR_FOR_SEC, severity: 'warning', detail: failingSince != null ? lastErr?.message ?? null : null,
      link: '/alerts', parents: [],
    })
    const out = primary.configured && !dryRun ? [one(primary, primaryFailingSince, lastError)] : []
    if (!dryRun) for (const ch of extra()) out.push(one(ch, stateOf(ch.id).failingSince, stateOf(ch.id).lastError))
    return out
  }

  return {
    enqueue,
    enqueueRaw,
    flush,
    quiet,
    channelSignals,
    deferred: () => q.deferred.all(),
    consumeDeferred: now => q.consume.run(now, now),
    status(now = Date.now()) {
      const c = Object.fromEntries(q.counts.all().map(r => [r.deliver, r.n]))
      return {
        telegram: primary.configured,
        dryRun,
        quietNow: quiet(now),
        queued: c.now ?? 0,
        deferred: c.digest ?? 0,
        lastSentAt: q.lastSent.get()?.t ?? null,
        lastError,
        // each channel (Telegram first): configured, pending, last send, last error
        channels: [
          { id: primary.id, label: primary.label, configured: primary.configured, queued: c.now ?? 0, lastSentAt: q.lastSent.get()?.t ?? null, lastError },
          ...extra().map(ch => {
            const since = Number(store.kv.get(`channel.${ch.id}.since`) ?? now)
            return { id: ch.id, label: ch.label, configured: true, queued: q.chCount.get(ch.id, since)?.n ?? 0, lastSentAt: q.chLast.get(ch.id)?.t ?? null, lastError: stateOf(ch.id).lastError }
          }),
        ],
      }
    },
  }
}
