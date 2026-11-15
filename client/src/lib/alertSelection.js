// Alert selection for bulk actions on the Alerts page (admin). Pure: the view keeps a set of
// checked keys; the effective selection is always intersected with the visible alerts
// (environment filter applied, alert still active), so an alert hidden by a filter or gone
// between two refreshes is never sent.
import { RULE_LABEL } from './alerts.js'
import { t } from '../i18n/index.js'

// checked keys still visible, in list order
export const effective = (selected, visible) => visible.filter(a => selected.has(a.key)).map(a => a.key)

// checked keys still active (the server's whole list, filtered or not); same set when nothing
// changes, to avoid a re-render
export function prune(selected, active) {
  const keys = new Set(active.map(a => a.key))
  return [...selected].every(k => keys.has(k)) ? selected : new Set([...selected].filter(k => keys.has(k)))
}

// toggle a key, a group or the whole list (all checked → all unchecked)
export function toggle(selected, keys) {
  const next = new Set(selected)
  const all = keys.length > 0 && keys.every(k => next.has(k))
  for (const k of keys) {
    if (all) next.delete(k)
    else next.add(k)
  }
  return next
}

// rule + host groups with at least two visible alerts (e.g. every port_new of one host)
export function groups(visible) {
  const m = new Map()
  for (const a of visible) {
    const id = `${a.rule}|${a.hostId ?? ''}`
    const g = m.get(id) ?? { id, rule: a.rule, hostId: a.hostId ?? null, keys: [] }
    g.keys.push(a.key)
    m.set(id, g)
  }
  return [...m.values()].filter(g => g.keys.length >= 2)
    .map(g => ({ ...g, label: `${RULE_LABEL[g.rule] || g.rule}${g.hostId ? ` · ${g.hostId}` : ''}` }))
}

// port_new:<host>:<proto>/<port> → { host, proto, port }, otherwise null
const PORT_KEY = /^port_new:(.+):(tcp|udp)\/(\d{1,5})$/
export function portOf(key) {
  const m = PORT_KEY.exec(String(key))
  return m ? { host: m[1], proto: m[2], port: Number(m[3]) } : null
}
// "Mark as known": only when the whole (non-empty) selection is made of port_new
export const allPorts = keys => keys.length > 0 && keys.every(k => portOf(k) != null)

// "12 acknowledged, 2 failed (unknown alert, already acknowledged ×2)"
export function resultText({ results = [], ok = 0, failed = 0 } = {}, done = [t('sel.acked_one'), t('sel.acked_many')]) {
  const reasons = new Map()
  for (const r of results) if (!r.ok) reasons.set(r.error, (reasons.get(r.error) ?? 0) + 1)
  const why = [...reasons].map(([e, n]) => (n > 1 ? `${e} ×${n}` : e)).join(', ')
  return `${ok} ${ok > 1 ? done[1] : done[0]}${failed ? t('sel.failed', { count: failed, why }) : ''}`
}
