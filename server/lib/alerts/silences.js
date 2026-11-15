// Silences set from the UI or the bot. A silenced alert stays visible
// (suppressed, as in maintenance) and is not notified; if it is still there
// when the silence ends, the engine notifies it. The reason is mandatory, and
// so is the expiry unless "no end" (reminded every day in the digest).
//
// Target (matcher), exactly one criterion among:
//   { key }      a specific alert ("service_down:gitea"), trailing "*" accepted
//   { host }     everything about a host (id from hosts[])
//   { service }  a service (probes, certificates, declared container: container_down)
//   { rule }     a whole rule ("apt_stale")
import { t as tr } from '../i18n.js'
const MAX_SILENCE_MS = 90 * 86400_000
const KINDS = ['key', 'host', 'service', 'rule']

function validateSilence({ matcher, reason, endsAt }, now = Date.now()) {
  const keys = Object.keys(matcher || {}).filter(k => matcher[k] != null && matcher[k] !== '')
  if (keys.length !== 1 || !KINDS.includes(keys[0])) return tr('api.silence.target')
  const v = String(matcher[keys[0]])
  if (v.length > 200 || !/^[\w.:/#*@+-]+$/.test(v)) return tr('api.silence.bad_target')
  const r = String(reason ?? '').trim()
  if (r.length < 3) return tr('api.reason_min')
  if (r.length > 200) return tr('api.reason_max')
  if (endsAt != null && (!Number.isFinite(endsAt) || endsAt <= now || endsAt > now + MAX_SILENCE_MS)) return tr('api.silence.bad_end')
  return null
}

export function silenceMatches(m, sig) {
  if (m.key) return m.key.endsWith('*') ? sig.key.startsWith(m.key.slice(0, -1)) : sig.key === m.key
  if (m.host) return sig.hostId === m.host || sig.entity === m.host || String(sig.entity).startsWith(`${m.host}/`)
  // services of the signal (container_down: services that declare the container)
  if (m.service) return sig.entity === m.service || String(sig.entity).startsWith(`${m.service}#`) || !!sig.services?.includes(m.service)
  if (m.rule) return sig.rule === m.rule
  return false
}

export function describeMatcher(m) {
  if (m.key) return tr('silences.target.key', { v: m.key })
  if (m.host) return tr('silences.target.host', { v: m.host })
  if (m.service) return tr('silences.target.service', { v: m.service })
  if (m.rule) return tr('silences.target.rule', { v: m.rule })
  return '?'
}

export function createSilences({ store, now = () => Date.now() }) {
  const { db } = store
  const q = {
    insert: db.prepare('INSERT INTO silences (matcher, reason, created_by, source, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)'),
    active: db.prepare('SELECT * FROM silences WHERE ended_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY created_at'),
    recent: db.prepare('SELECT * FROM silences WHERE created_at >= ? OR ended_at IS NULL ORDER BY created_at DESC LIMIT 100'),
    get: db.prepare('SELECT * FROM silences WHERE id = ?'),
    end: db.prepare('UPDATE silences SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL'),
  }
  const view = r => ({
    id: r.id, matcher: JSON.parse(r.matcher), target: describeMatcher(JSON.parse(r.matcher)),
    reason: r.reason, createdBy: r.created_by, source: r.source, createdAt: r.created_at,
    endsAt: r.ends_at, endedAt: r.ended_at, endedBy: r.ended_by,
  })
  // read on every evaluation (every 15 s): small table, no index needed
  let cache = { at: 0, list: [] }
  const active = (t = now()) => {
    if (t - cache.at > 5000) cache = { at: t, list: q.active.all(t).map(view) }
    return cache.list.filter(s => s.endsAt == null || s.endsAt > t)
  }
  const invalidate = () => { cache = { at: 0, list: [] } }

  return {
    validate: validateSilence,
    create({ matcher, reason, by, source, endsAt = null }) {
      const t = now()
      const err = validateSilence({ matcher, reason, endsAt }, t)
      if (err) throw Object.assign(new Error(err), { status: 400 })
      const clean = Object.fromEntries(Object.entries(matcher).filter(([, v]) => v != null && v !== ''))
      const id = Number(q.insert.run(JSON.stringify(clean), String(reason).trim(), by, source, t, endsAt).lastInsertRowid)
      invalidate()
      return view(q.get.get(id))
    },
    end(id, by) {
      const ok = q.end.run(now(), by, id).changes > 0
      invalidate()
      return ok ? view(q.get.get(id)) : null
    },
    get: id => {
      const r = q.get.get(id)
      return r ? view(r) : null
    },
    active,
    recent: (days = 7) => q.recent.all(now() - days * 86400_000).map(view),
    match(sig, t = now()) {
      return active(t).find(s => silenceMatches(s.matcher, sig)) ?? null
    },
  }
}
