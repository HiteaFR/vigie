// Service widgets (inspired by Homepage, no code reused): a single generic engine. Each
// widget calls one or more API routes, extracts values (JSON path
// or Prometheus metric) and formats them on the server side. Secrets come
// from the environment (secretEnv) and never leave the server: the client only
// receives labels and already formatted values.
import { fetch as uFetch } from 'undici'
import { seconds } from './duration.js'
import { retryDelay } from './monitor.js'
import { createPiholes } from './pihole.js'
import { agentFor } from './tls.js'
import { withUserAgent } from './http.js'
import { WIDGET_TIMEOUT } from './widget-types.js'
import { widgetAuths, widgetFormats } from './registry.js'
import { redactError } from './redact.js'
import { t as tr } from './i18n.js'
// formats and authentications live in registries (lib/widget-types.js: core ones; plugins
// may add more); the engine below knows no type by name
const TIMEOUT = WIDGET_TIMEOUT
// a widget with auth carries a secret → never the permissive agent
export const widgetAgent = w => agentFor(w.url, { secret: !!w.auth })
const MAX_CONCURRENT = 4

// Isolation of a plugin entry (authentication, format): bounded delay (the request one),
// prefixed message. The error stays DATA of the widget (error field, old values kept), like
// an error response from the service: no plugin_error, the widget already shows it
// secrets: values to mask in addition to the plugin's (widget secrets); masked messages
// (lib/redact.js): they go out through /api/services
function bounded(entry, what, fn, ms = TIMEOUT, secrets = []) {
  if (entry.owner === 'core') return fn()
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(tr('errors.timeout'))), ms)
  })
  return Promise.race([Promise.resolve().then(fn), deadline])
    .catch(e => { throw new Error(tr('errors.plugin_call', { what, owner: entry.owner, error: redactError(e, [...entry.secretValues, ...secrets]) })) })
    .finally(() => clearTimeout(timer))
}
function formatValue(fmt, name, raw) {
  if (fmt.owner === 'core') return fmt.format(raw)
  try {
    return String(fmt.format(raw))
  } catch (e) {
    throw new Error(tr('errors.plugin_format', { name, owner: fmt.owner, error: redactError(e, fmt.secretValues) }))
  }
}

// "queries.percent_blocked", "0", "records.length"
function pick(obj, path) {
  if (!path) return obj
  let cur = obj
  for (const k of path.split('.')) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

function promValue(text, metric) {
  const line = text.split('\n').find(l => l.startsWith(`${metric} `) || l.startsWith(`${metric}{`))
  return line ? Number(line.trim().split(/\s+/).pop()) : undefined
}

// piholes: Pi-hole session registry shared with the network module (lib/pihole.js)
// pluginTimeoutMs: timeout of a plugin entry (tests; the request one by default)
export function createWidgets(cfg, env = process.env, { piholes = createPiholes({ env }), pluginTimeoutMs = TIMEOUT } = {}) {
  const results = new Map()
  const sessions = new Map() // qBittorrent cookie, per service
  const widgets = cfg.services.filter(s => s.widget).map(s => ({ id: s.id, ...s.widget }))

  const secret = name => {
    const v = env[name]
    if (!v) throw new Error(tr('errors.secret_missing', { name }))
    return v
  }

  const authOf = w => (w.auth ? widgetAuths.get(w.auth.type) : null)
  // values of the secrets named by the widget's authentication (…Env fields), masked in its errors
  const authSecrets = w => Object.entries(w.auth ?? {}).filter(([k, v]) => k.endsWith('Env') && typeof v === 'string').map(([, v]) => env[v]).filter(v => typeof v === 'string')
  const ctx = { secret }

  // authentication headers: on every request (headers); otherwise kept per widget (session;
  // an auth with neither headers nor session, like query, keeps {}: a 401/403 retries the
  // request once)
  async function headersFor(w) {
    const a = authOf(w)
    if (!a) return {}
    if (a.headers) return bounded(a, `authentification ${a.name}`, () => a.headers(w.auth, { ...ctx, url: w.url }), pluginTimeoutMs, authSecrets(w))
    if (!sessions.has(w.id)) sessions.set(w.id, a.session ? await a.session(w, ctx) : {})
    return sessions.get(w.id)
  }

  async function call(w, path, retry = true) {
    const a = authOf(w)
    // shared client (Pi-hole: session, reconnection and errors handled by lib/pihole.js)
    if (a?.call) return a.call(w, path, { piholes })
    const url = new URL(path, w.url)
    if (a?.query) for (const [k, v] of await bounded(a, `authentification ${a.name}`, () => a.query(w.auth, ctx), pluginTimeoutMs, authSecrets(w))) url.searchParams.set(k, v)
    const r = await uFetch(url, {
      headers: withUserAgent({ Accept: 'application/json', ...(await headersFor(w)) }),
      dispatcher: widgetAgent(w), signal: AbortSignal.timeout(TIMEOUT),
    })
    // session expired: one new login, only once
    if ((r.status === 401 || r.status === 403) && sessions.has(w.id) && retry) {
      await r.body?.cancel()
      sessions.delete(w.id)
      return call(w, path, false)
    }
    // no URL in the error: it may carry a secret ("query" auth)
    if (!r.ok) {
      await r.body?.cancel()
      throw new Error(`${path.split('?')[0]} → HTTP ${r.status}`)
    }
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async function run(w) {
    const bodies = new Map()
    const fields = []
    try {
      for (const f of w.fields) {
        if (!bodies.has(f.path)) bodies.set(f.path, await call(w, f.path))
        const body = bodies.get(f.path)
        const raw = f.prom ? promValue(String(body), f.prom) : pick(body, f.json)
        const name = f.format ?? 'number'
        const fmt = widgetFormats.get(name) ?? widgetFormats.get('text')
        const value = raw == null || (fmt.numeric && Number.isNaN(Number(raw)))
          ? '—'
          : formatValue(fmt, name, raw) + (f.unit ? ` ${f.unit}` : '')
        fields.push({ label: f.label, value })
      }
      results.set(w.id, { fields, error: null, at: new Date().toISOString() })
      return true
    } catch (e) {
      const prev = results.get(w.id)
      results.set(w.id, {
        fields: prev?.fields ?? [],
        error: String(e?.cause?.code || e?.name === 'TimeoutError' && 'timeout' || e.message || e),
        at: new Date().toISOString(),
        stale: !!prev?.fields?.length,
      })
      return false
    }
  }

  // simple queue: at most MAX_CONCURRENT widgets in flight
  let inFlight = 0
  const queue = []
  function schedule(w, delay) {
    setTimeout(() => {
      queue.push(w)
      pump()
    }, delay)
  }
  function pump() {
    while (inFlight < MAX_CONCURRENT && queue.length) {
      const w = queue.shift()
      inFlight++
      run(w).then(ok => {
        inFlight--
        // failing (service restarting), retry without waiting for the whole interval
        const every = (w.interval ? seconds(w.interval) : 60) * 1000
        schedule(w, ok ? every : retryDelay(1, every))
        pump()
      })
    }
  }

  return {
    count: widgets.length,
    start() {
      for (const w of widgets) schedule(w, 1000 + Math.random() * 8000)
    },
    get: id => results.get(id) ?? null,
    // out-of-cycle run ("Refresh" button)
    runAll: () => Promise.allSettled(widgets.map(w => run(w))),
    // closing of the Pi-hole sessions (limited number of sessions on the FTL side)
    async stop() {
      await Promise.all(widgets.filter(x => authOf(x)?.stop).map(w => authOf(w).stop(w, { piholes })))
    },
  }
}
