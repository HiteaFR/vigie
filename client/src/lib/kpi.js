// "Alerts" and "Updates" tiles of the cockpit. Pure code (no React, no client import outside
// lib), tested directly by server/test/kpi.test.js.
// Value: three colored numbers (red, orange, blue) whose sum equals the menu badge; short
// legend; accessible text (color never carries the meaning alone); state crit, warn,
// otherwise ok (blue alone leaves the tile green), via toneOf.
import { toneOf, tileState } from './tone.js'
import { updateCounts } from './updates.js'
import { t } from '../i18n/index.js'

// count and noun, plural through the catalog
const n = (k, key) => t(key, { count: k })

// Width of the value in em (bold, tabular figures), measured at 24 px:
// "10 · 2 · 26" = 118 px (4.92 em), "120 · 15 · 260" = 168 px (7.0 em) → 0.694 em per digit and
// 0.722 em per separator (thin spaces and middle dot), plus a 4 % margin. The cockpit derives the
// size from it: clamp(12 px, tile width / em, 24 px), which shrinks as the value gets longer.
export const DIGIT_EM = 0.694
export const SEP_EM = 0.722
export function valueEm(numbers) {
  const digits = numbers.reduce((a, k) => a + String(k).length, 0)
  return Math.round((digits * DIGIT_EM + (numbers.length - 1) * SEP_EM) * 1.04 * 1000) / 1000
}

const tile = (r, o, b, legend, label) => {
  const tone = toneOf(r, o, b)
  return {
    parts: [{ n: r, tone: 'crit' }, { n: o, tone: 'warn' }, { n: b, tone: 'info' }],
    value: `${r} · ${o} · ${b}`,
    em: valueEm([r, o, b]),
    label,
    sub: legend,
    state: tileState(tone),
    tone,
  }
}
const unavailable = sub => ({ parts: null, value: '—', em: null, label: sub, sub, state: 'unknown', tone: null })

// firing: firingOf(alerts.data, env), the computation of the bell and the badge; null or missing
// (alerts not loaded yet, network error) → counters from /api/summary; nothing → "—"
export function alertsKpi(firing, summaryAlerts) {
  if (firing == null && summaryAlerts == null) return unavailable(t('kpi.alerts_unavailable'))
  const s = summaryAlerts ?? {}
  const count = firing == null
    ? severity => s[severity] ?? 0
    : severity => firing.filter(a => a.severity === severity).length
  const [c, w, i] = [count('critical'), count('warning'), count('info')]
  return tile(c, w, i, 'crit · warn · info', `${n(c, 'kpi.critical')}, ${n(w, 'kpi.warning')}, ${n(i, 'kpi.info')}`)
}

// todo: todoOf(updates.data, env), the badge filter. Without /api/updates (including while
// loading) → "—", unknown state: NO fallback to /api/summary, which does not count like the
// badge (and the badge is missing too)
export function updatesKpi(todo) {
  if (todo == null) return unavailable(t('kpi.updates_unavailable'))
  const k = updateCounts(todo)
  return tile(k.r, k.o, k.b, t('kpi.updates_parts'), `${t('kpi.security_eol', { count: k.r })}, ${n(k.o, 'kpi.major')}, ${n(k.b, 'kpi.other')}`)
}
