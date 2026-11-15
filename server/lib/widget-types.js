// widget registries (lib/registry.js): value formats (server-side formatting) and
// authentications. Core entries below, in a fixed order (validation messages
// unchanged); a plugin adds some through definePlugin({ extensions: { widgetFormats, widgetAuths } }).
//
// Format: { numeric (a non-numeric value shows as "—"), format(v) → text }.
// Authentication: { schema (zod, type field), and one of:
//   headers(auth, { secret, url }) → headers of each request (core: header, bearer; plugins);
//   query(auth, { secret }) → [[name, value]] added to the URL (core: query; plugins);
//   session(widget, { secret }) → headers kept per widget, redone once on 401/403 (core:
//     qbittorrent);
//   call(widget, path, { piholes }) → body read by a shared client, and stop (core: pihole) }.
// session and call stay in the core: a plugin declares headers or query.
import { z } from 'zod'
import { fetch as uFetch } from 'undici'
import { envName } from './config-types.js'
import { agentFor } from './tls.js'
import { withUserAgent } from './http.js'
import { widgetFormats, widgetAuths } from './registry.js'
import { numberFormat, t as tr } from './i18n.js'

export const WIDGET_TIMEOUT = 8000

// --- formats --------------------------------------------------------------------------------------
// in the instance locale (lib/i18n.js), read on every formatting
const nf = numberFormat({ maximumFractionDigits: 1 })
const nf0 = numberFormat({ maximumFractionDigits: 0 })
widgetFormats.add('number', { numeric: true, format: v => nf.format(Number(v)) })
widgetFormats.add('int', { numeric: true, format: v => nf0.format(Number(v)) })
widgetFormats.add('percent', { numeric: true, format: v => `${nf.format(Number(v))} %` })
widgetFormats.add('mbps', { numeric: true, format: v => `${nf.format(Number(v))} Mb/s` })
widgetFormats.add('ms', { numeric: true, format: v => `${nf.format(Number(v))} ms` })
widgetFormats.add('rate', {
  numeric: true,
  format: v => {
    let n = Number(v)
    const u = ['b', 'kb', 'mb', 'gb'].map(k => tr(`widgets.rate.${k}`))
    let i = 0
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return `${nf.format(n)} ${u[i]}`
  },
})
widgetFormats.add('until', {
  numeric: false,
  format: v => {
    // Tailscale returns 0001-01-01T00:00:00Z when expiry is disabled
    if (Date.parse(v) < Date.UTC(2000, 0, 1)) return tr('widgets.never')
    const d = Math.floor((Date.parse(v) - Date.now()) / 86400_000)
    return Number.isNaN(d) ? '—' : d < 0 ? tr('widgets.expired') : tr('widgets.days', { d })
  },
})
widgetFormats.add('ago', {
  numeric: false,
  format: v => {
    const m = Math.floor((Date.now() - Date.parse(v)) / 60000)
    if (Number.isNaN(m)) return '—'
    return m < 2 ? tr('widgets.now') : m < 60 ? tr('widgets.ago_min', { n: m }) : m < 2880 ? tr('widgets.ago_h', { n: Math.floor(m / 60) }) : tr('widgets.ago_d', { n: Math.floor(m / 1440) })
  },
})
widgetFormats.add('bool', { numeric: false, format: v => (v ? tr('widgets.yes') : tr('widgets.no')) })
widgetFormats.add('text', { numeric: false, format: v => String(v) })

// --- authentications ------------------------------------------------------------------------------
widgetAuths.add('header', {
  schema: z.object({ type: z.literal('header'), name: z.string(), prefix: z.string().optional(), secretEnv: envName }).strict(),
  headers: (a, { secret }) => ({ [a.name]: (a.prefix ?? '') + secret(a.secretEnv) }),
})
widgetAuths.add('bearer', {
  schema: z.object({ type: z.literal('bearer'), secretEnv: envName }).strict(),
  headers: (a, { secret }) => ({ Authorization: `Bearer ${secret(a.secretEnv)}` }),
})
widgetAuths.add('query', {
  schema: z.object({ type: z.literal('query'), name: z.string(), secretEnv: envName }).strict(),
  query: (a, { secret }) => [[a.name, secret(a.secretEnv)]],
})
// Pi-hole: session shared with the network module, reconnection and errors handled by lib/pihole.js
widgetAuths.add('pihole', {
  schema: z.object({ type: z.literal('pihole'), secretEnv: envName }).strict(),
  call: (w, path, { piholes }) => piholes.get(w.url, w.auth.secretEnv).get(path),
  stop: (w, { piholes }) => piholes.get(w.url, w.auth.secretEnv).close(),
})
// qBittorrent: session cookie, per widget
widgetAuths.add('qbittorrent', {
  schema: z.object({ type: z.literal('qbittorrent'), userEnv: envName, secretEnv: envName }).strict(),
  async session(w, { secret }) {
    const a = w.auth
    const r = await uFetch(new URL('/api/v2/auth/login', w.url), {
      method: 'POST', headers: withUserAgent({ Referer: w.url }),
      body: new URLSearchParams({ username: secret(a.userEnv), password: secret(a.secretEnv) }),
      dispatcher: agentFor(w.url, { secret: true }), signal: AbortSignal.timeout(WIDGET_TIMEOUT),
    })
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
    if (!cookie) throw new Error(tr('errors.qbittorrent.auth', { status: r.status }))
    return { Cookie: cookie }
  },
})
