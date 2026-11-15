// Bulk actions from the Alerts page. The whole batch is validated first (400: empty or too
// long list, reason, expiry); then each item is processed on its own, not all-or-nothing:
// valid items go through even if others fail, and the result is returned item by item. The
// route writes the audit (one line per successful item) and the notification.
import { t as tg, tHtml } from '../notify/format.js'
import { t as tr } from '../i18n.js'

export const BULK_MAX = 200
const KEY_MAX = 300
const SHOWN = 5 // titles quoted in a batch notification; beyond that: "… and N others"
const TITLE_MAX = 80

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })
export function reasonOf(reason) {
  const r = String(reason ?? '').trim()
  if (r.length < 3 || r.length > 200) throw bad(tr('api.reason_required'))
  return r
}
function listOf(v, what) {
  if (!Array.isArray(v) || !v.length) throw bad(tr('api.bulk.empty', { what }))
  if (v.length > BULK_MAX) throw bad(tr('api.bulk.too_many', { what, max: BULK_MAX, count: v.length }))
  return v
}

// ack of a batch of alerts: same rules as the single ack (engine), plus refusal of an alert
// already acknowledged (ack in progress); → [{ key, ok: true, title } | { key, ok: false, error }]
export function ackMany(engine, { keys, reason, until = null, by, t = Date.now() }) {
  listOf(keys, tr('api.bulk.alerts'))
  if (keys.some(k => typeof k !== 'string' || !k || k.length > KEY_MAX)) throw bad(tr('api.bulk.bad_key'))
  const r = reasonOf(reason)
  if (until != null && (!Number.isFinite(until) || until <= t || until > t + 90 * 86400_000)) throw bad(tr('api.bad_until'))
  return [...new Set(keys)].map(key => {
    const cur = engine.get(key)
    if (!cur) return { key, ok: false, error: tr('api.bulk.unknown_alert') }
    if (cur.state !== 'firing') return { key, ok: false, error: tr('api.bulk.not_firing') }
    if (cur.ack) return { key, ok: false, error: tr('api.bulk.already_acked') }
    try {
      return { key, ok: true, title: engine.ack(key, { by, reason: r, until, t }).title }
    } catch (e) {
      return { key, ok: false, error: String(e.message || e) }
    }
  })
}

// "Known" for a batch of ports: same rules as the single action (agent memory);
// → [{ host, proto, port, ok: true } | { host, proto, port, ok: false, error }]
export function knownMany(memory, { items, reason, by, now = Date.now() }) {
  listOf(items, 'ports')
  const r = reasonOf(reason)
  const seen = new Set()
  const out = []
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      out.push({ host: null, proto: null, port: null, ok: false, error: tr('api.bulk.bad_item') })
      continue
    }
    const host = String(it.host ?? '').slice(0, 100)
    const proto = String(it.proto ?? '').slice(0, 10)
    const port = Number(it.port)
    const id = `${host}/${proto}/${port}`
    if (seen.has(id)) continue
    seen.add(id)
    try {
      memory.portKnown(host, proto, port, r, by, now)
      out.push({ host, proto, port, ok: true })
    } catch (e) {
      out.push({ host, proto, port, ok: false, error: String(e.message || e) })
    }
  }
  return out
}

// a single notification for the whole batch; a single alert: the message of the single ack
export function ackMessage(titles, reason) {
  const short = s => (String(s).length > TITLE_MAX ? `${String(s).slice(0, TITLE_MAX - 1)}…` : String(s))
  if (titles.length === 1) return tHtml('ack.ui_one', { title: short(titles[0]), reason })
  const more = titles.length - SHOWN
  return [
    tHtml('ack.ui_many', { count: titles.length, reason }),
    ...titles.slice(0, SHOWN).map(x => `• ${tg(short(x))}`),
    ...(more > 0 ? [tr('ack.more', { count: more })] : []),
  ].join('\n')
}
