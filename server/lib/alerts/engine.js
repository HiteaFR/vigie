// Alert engine: one state machine per "rule:entity" key.
//
//   (none) ──cond──▶ pending ──(forSec elapsed, outside grace period)──▶ firing ──▶ opening notification
//   firing ──!cond──▶ ok ──▶ recovery notification (with the duration)
//   4 triggers in 30 min ──▶ flapping: one notification, then silence until 30 min without a flip
//
// An alert whose parent (stopped guest, unreachable Proxmox) is down, which is
// muted in the config or in a maintenance window is "suppressed": visible in the
// UI, never notified. If the failure persists when the suppression ends, it is
// notified at that moment. State is persisted: a restart notifies nothing again.
//
// A silence (UI, bot) suppresses like a maintenance; an ack (mandatory reason,
// optional expiry) stops the reminders of an ongoing alert without preventing
// the recovery notification, and ends with it.
import { seconds } from '../duration.js'
import { t as tr } from '../i18n.js'

const RANK = { info: 0, warning: 1, critical: 2 }
const FLAP_WINDOW = 30 * 60_000
const FLAP_COUNT = 4
const FORGET_AFTER = 10 * 60_000 // signal gone (config changed): the alert is forgotten

export function createEngine({ cfg, store, rules, notifier, clock, silences = null, startedAt = Date.now() }) {
  const { db } = store
  const A = cfg.alerts
  const states = new Map()
  let lastEvalAt = null

  const q = {
    upsert: db.prepare(`INSERT INTO alert_state (key, rule, entity, state, severity, since, fired_at, last_notified, notified, flapping, transitions, incident_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET rule = excluded.rule, entity = excluded.entity, state = excluded.state,
        severity = excluded.severity, since = excluded.since, fired_at = excluded.fired_at,
        last_notified = excluded.last_notified, notified = excluded.notified, flapping = excluded.flapping,
        transitions = excluded.transitions, incident_id = excluded.incident_id, payload = excluded.payload`),
    remove: db.prepare('DELETE FROM alert_state WHERE key = ?'),
    openIncident: db.prepare(`INSERT INTO incidents (key, rule, entity, title, env, severity, started_at, summary, suppressed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateIncident: db.prepare('UPDATE incidents SET severity = ?, summary = ?, suppressed = ? WHERE id = ?'),
    closeIncident: db.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL'),
    recentIncidents: db.prepare('SELECT * FROM incidents WHERE started_at >= ? OR resolved_at IS NULL ORDER BY started_at DESC LIMIT ?'),
    ackIncident: db.prepare('UPDATE incidents SET ack_by = ?, ack_reason = ?, ack_at = ? WHERE id = ?'),
  }

  for (const r of db.prepare('SELECT * FROM alert_state').all()) {
    const p = JSON.parse(r.payload || '{}')
    states.set(r.key, {
      key: r.key, rule: r.rule, entity: r.entity, state: r.state, severity: r.severity,
      since: r.since, firedAt: r.fired_at, lastNotified: r.last_notified, notified: !!r.notified,
      flapping: !!r.flapping, transitions: JSON.parse(r.transitions || '[]'), incidentId: r.incident_id,
      ...p, lastSeen: Date.now(),
    })
  }

  function persist(st) {
    const payload = JSON.stringify({
      title: st.title, env: st.env, detail: st.detail, link: st.link, host: st.host,
      suppressed: st.suppressed, notifiedVia: st.notifiedVia, extra: st.extra, masksChildren: st.masksChildren,
      ack: st.ack ?? null, hostId: st.hostId ?? null, quietResolve: !!st.quietResolve,
    })
    q.upsert.run(st.key, st.rule, st.entity, st.state, st.severity, st.since, st.firedAt ?? null,
      st.lastNotified ?? null, st.notified ? 1 : 0, st.flapping ? 1 : 0,
      JSON.stringify(st.transitions), st.incidentId ?? null, payload)
  }
  function drop(st) {
    states.delete(st.key)
    q.remove.run(st.key)
  }

  // notification: the notifier picks the channel (immediate, digest, none) based on
  // severity, environment and time of day; only what was sent is recorded
  function notify(kind, st, t, extra = {}) {
    const via = notifier.enqueue(kind, st, t, extra)
    if (via === 'skip') return via
    st.lastNotified = t
    if (kind === 'open' || kind === 'stable' || kind === 'escalate') {
      st.notified = true
      st.notifiedVia = via
    }
    return via
  }

  const inGrace = t => t - startedAt < A.startupGraceSec * 1000

  // criteria live under match (schema); all those present must match
  function maintenanceFor(sig, t) {
    return cfg.maintenance.find(m => clock.inWindow(t, m)
      && (!m.match.host || sig.hostId === m.match.host)
      && (!m.match.service || sig.entity === m.match.service || !!sig.services?.includes(m.match.service))
      && (!m.match.rule || sig.rule === m.match.rule))
  }

  function suppressionOf(sig, t) {
    const parent = sig.parents?.map(k => states.get(k)).find(p => p?.state === 'firing' && p.masksChildren !== false)
    if (parent) return tr('alerts.dependency', { title: parent.title })
    if (sig.muted) return tr('alerts.muted')
    const m = maintenanceFor(sig, t)
    if (m) return m.reason ? tr('alerts.maintenance_reason', { reason: m.reason }) : tr('alerts.maintenance')
    const s = silences?.match(sig, t)
    if (s) return tr('alerts.silenced', { reason: s.reason })
    return null
  }

  const ackActive = (st, t) => !!st.ack && (st.ack.until == null || st.ack.until > t)

  function refresh(st, sig) {
    st.title = sig.title
    st.env = sig.env
    st.link = sig.link
    st.host = sig.host ?? null
    st.hostId = sig.hostId ?? null
    if (sig.detail) st.detail = sig.detail
    st.masksChildren = sig.masksChildren ?? true
    st.noRepeat = !!sig.noRepeat
    // resolution without a message ("Known" is not a recovery)
    st.quietResolve = !!sig.quietResolve
    if (sig.rule === 'pve_unreachable') st.extra = st.masksChildren ? rules.impacted(sig.key) : null
  }

  function fire(st, t, suppressed) {
    st.state = 'firing'
    st.firedAt = t
    st.suppressed = suppressed
    st.transitions = [...st.transitions.filter(x => t - x < FLAP_WINDOW), t]
    st.incidentId = Number(q.openIncident.run(st.key, st.rule, st.entity, st.title, st.env, st.severity,
      st.since, st.detail ?? null, suppressed).lastInsertRowid)
    if (st.flapping) {
      // already reported as flapping: silence until it stabilises
    } else if (st.transitions.length >= FLAP_COUNT) {
      st.flapping = true
      notify('flap', st, t)
    } else if (!suppressed) {
      notify('open', st, t)
    }
    persist(st)
  }

  function resolve(st, t, { silent = false } = {}) {
    if (st.incidentId) q.closeIncident.run(t, st.incidentId)
    if (!silent && !st.quietResolve && st.notified && !st.flapping) notify('resolve', st, t, { duration: t - st.since })
    st.state = 'ok'
    st.notified = false
    st.notifiedVia = null
    st.suppressed = null
    st.incidentId = null
    st.detail = null
    st.ack = null
    if (st.flapping || st.transitions.some(x => t - x < FLAP_WINDOW)) persist(st)
    else drop(st)
  }

  function apply(sig, t) {
    let st = states.get(sig.key)
    if (st) st.lastSeen = t
    const suppressed = suppressionOf(sig, t)

    if (sig.cond === null) {
      if (st && st.state === 'firing') unmask(st, suppressed, t)
      return
    }

    if (!sig.cond) {
      if (!st) return
      // a signal that asks for a silent resolution gets it, even if the alert went
      // out without one (record deleted). Monotonic: never makes a resolution noisy.
      if (sig.quietResolve) st.quietResolve = true
      if (st.state === 'pending') {
        if (st.transitions.length) {
          st.state = 'ok'
          persist(st)
        } else drop(st)
      } else if (st.state === 'firing') resolve(st, t)
      return
    }

    if (!st || st.state === 'ok') {
      st = {
        key: sig.key, rule: sig.rule, entity: sig.entity, severity: sig.severity,
        transitions: [], flapping: false, notified: false, ...st,
        state: 'pending', since: t, lastSeen: t,
      }
      states.set(sig.key, st)
      refresh(st, sig)
      st.severity = sig.severity
      persist(st)
    } else {
      refresh(st, sig)
    }

    if (st.state === 'pending') {
      // wait for the end of the delay, of the startup grace, and for the parents to settle
      const parentPending = sig.parents?.some(k => states.get(k)?.state === 'pending' && states.get(k).masksChildren !== false)
      if (t - st.since >= (sig.forSec ?? 0) * 1000 && !inGrace(t) && !parentPending) {
        st.severity = sig.severity
        fire(st, t, suppressed)
      }
      return
    }

    // firing: escalation, severity, suppression, reminder
    if (RANK[sig.severity] !== RANK[st.severity]) {
      const worse = RANK[sig.severity] > RANK[st.severity]
      st.severity = sig.severity
      if (worse && st.notified && !st.suppressed && !st.flapping) notify('escalate', st, t)
      if (st.incidentId) q.updateIncident.run(st.severity, st.detail ?? null, st.suppressed ?? null, st.incidentId)
      persist(st)
    }
    unmask(st, suppressed, t)
    const repeat = A.repeat[st.severity]
    if (repeat && !st.noRepeat && !ackActive(st, t) && st.notified && !st.suppressed && !st.flapping && st.notifiedVia === 'now'
      && t - (st.lastNotified ?? t) >= seconds(repeat) * 1000) {
      if (notify('remind', st, t, { duration: t - st.since }) !== 'skip') persist(st)
    }
  }

  // the suppression ends (parent recovered, end of maintenance) and the failure persists
  function unmask(st, suppressed, t) {
    if (st.suppressed === suppressed) return
    const wasMasked = !!st.suppressed
    st.suppressed = suppressed
    if (wasMasked && !suppressed && !st.notified && !st.flapping) notify('open', st, t)
    if (st.incidentId) q.updateIncident.run(st.severity, st.detail ?? null, suppressed ?? null, st.incidentId)
    persist(st)
  }

  function housekeeping(t) {
    for (const st of [...states.values()]) {
      if (t - st.lastSeen > FORGET_AFTER) {
        if (st.state === 'firing') resolve(st, t, { silent: true })
        drop(st)
        continue
      }
      if (st.flapping && st.transitions.every(x => t - x >= FLAP_WINDOW)) {
        st.flapping = false
        st.transitions = []
        // an alert with silent resolution (record deleted…) gets no "stabilised" message
        if (!st.quietResolve) notify('stable', st, t)
        if (st.state === 'ok') drop(st)
        else persist(st)
      } else if (st.state === 'ok' && !st.flapping && st.transitions.every(x => t - x >= FLAP_WINDOW)) {
        drop(st)
      }
    }
  }

  function evaluate(snap, t = Date.now()) {
    const signals = rules.evaluate(snap, t)
    // parents first: a service must not go out before the Proxmox that hosts it, nor before its
    // missing or stopped container, even if they are raised in the same pass
    const order = { pve_unreachable: 0, guest_stopped: 1, container_down: 2 }
    signals.sort((a, b) => (order[a.rule] ?? 3) - (order[b.rule] ?? 3))
    for (const sig of signals) apply(sig, t)
    housekeeping(t)
    lastEvalAt = t
    return signals.length
  }

  const view = st => ({
    key: st.key, rule: st.rule, entity: st.entity, title: st.title, env: st.env,
    severity: st.severity, state: st.state, since: st.since, firedAt: st.firedAt ?? null,
    suppressed: st.suppressed ?? null, flapping: st.flapping, detail: st.detail ?? null,
    host: st.host ?? null, link: st.link ?? null, notified: st.notified,
    incidentId: st.incidentId ?? null, hostId: st.hostId ?? null,
    ack: st.ack && ackActive(st, Date.now()) ? st.ack : null,
  })

  // ack: mandatory reason; only a firing alert can be acknowledged
  function ack(key, { by, reason, until = null, t = Date.now() }) {
    const st = states.get(key)
    if (!st || st.state !== 'firing') throw Object.assign(new Error(tr('api.alert_not_firing')), { status: 404 })
    const r = String(reason ?? '').trim()
    if (r.length < 3 || r.length > 200) throw Object.assign(new Error(tr('api.reason_required')), { status: 400 })
    if (until != null && (!Number.isFinite(until) || until <= t || until > t + 90 * 86400_000)) throw Object.assign(new Error(tr('api.bad_until')), { status: 400 })
    st.ack = { by, reason: r, at: t, until }
    if (st.incidentId) q.ackIncident.run(by, r, t, st.incidentId)
    persist(st)
    return view(st)
  }
  function unack(key) {
    const st = states.get(key)
    if (!st?.ack) return null
    st.ack = null
    if (st.incidentId) q.ackIncident.run(null, null, null, st.incidentId)
    persist(st)
    return view(st)
  }

  return {
    evaluate,
    ack,
    unack,
    get: key => (states.has(key) ? view(states.get(key)) : null),
    byIncident: id => {
      const st = [...states.values()].find(s => s.incidentId === id && s.state === 'firing')
      return st ? view(st) : null
    },
    get lastEvalAt() { return lastEvalAt },
    active: () => [...states.values()].filter(s => s.state !== 'ok').map(view)
      .sort((a, b) => (a.state === 'firing' ? 0 : 1) - (b.state === 'firing' ? 0 : 1)
        || RANK[b.severity] - RANK[a.severity] || a.since - b.since),
    incidents: (sinceMs, limit = 200) => q.recentIncidents.all(sinceMs, limit).map(r => ({
      id: r.id, key: r.key, rule: r.rule, entity: r.entity, title: r.title, env: r.env,
      severity: r.severity, startedAt: r.started_at, resolvedAt: r.resolved_at,
      summary: r.summary, suppressed: r.suppressed,
      ack: r.ack_at ? { by: r.ack_by, reason: r.ack_reason, at: r.ack_at } : null,
    })),
  }
}
