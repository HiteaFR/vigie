import { t as tr } from '../i18n/index.js'
export const pct = (used, max) => {
  if (!max) return 0
  return Math.min(100, Math.round((used / max) * 100))
}

// t imported as tr (ago takes a parameter named t)
export function bytes(n) {
  if (!n) return '0'
  const u = ['b', 'kb', 'mb', 'gb', 'tb'].map(k => tr(`units.${k}`))
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

export function uptime(s) {
  if (!s) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return tr('time.uptime_dh', { d, h })
  if (h) return tr('time.uptime_hm', { h, m })
  return tr('time.uptime_m', { m })
}

// The ONE "time ago" helper. t: timestamp in ms or ISO date (or Date). Three formats are kept
// through options (outputs pinned by server/test/time-ago.test.js):
// - default (Gitea, backups): nothing if t is empty; "just now" under 60 s, then "N min | h | d ago";
// - seconds (TimeAgo, device freshness): ROUNDED seconds, "just now" under 5 s,
//   "N s ago" under 60 s;
// - bare (a container's "for" duration, lib/agent.js): no "ago", at least "1 min".
export function ago(t, { seconds = false, bare = false } = {}) {
  if (!seconds && !bare && !t) return ''
  const raw = (Date.now() - (typeof t === 'number' ? t : new Date(t).getTime())) / 1000
  const s = seconds ? Math.max(0, Math.round(raw)) : raw
  // through the catalog (time.*); bare: duration only, otherwise "… ago"
  const unit = (k, n) => tr(bare ? `time.${k}` : `time.ago_${k}`, { n })
  if (bare) {
    if (s < 3600) return unit('min', Math.max(1, Math.floor(s / 60)))
  } else if (seconds) {
    if (s < 5) return tr('time.just_now')
    if (s < 60) return unit('s', s)
  } else if (s < 60) return tr('time.just_now')
  if (s < 3600) return unit('min', Math.floor(s / 60))
  if (s < 86400) return unit('h', Math.floor(s / 3600))
  return unit('d', Math.floor(s / 86400))
}

// readable duration of an alert or an incident
export function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return tr('time.min', { n: m })
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? tr('time.h_mm', { h, mm: String(m % 60).padStart(2, '0') }) : tr('time.h', { n: h })
  return tr('time.d', { n: Math.floor(h / 24) })
}

// availability in %
export const fmtUptime = v => (v == null ? '—' : `${v >= 99.95 ? Math.round(v) : v.toFixed(1)} %`)
