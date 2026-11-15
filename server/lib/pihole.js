// Pi-hole v6 session shared between the widget of the pihole service and the network
// module: FTL limits the number of sessions (max_sessions = 16), so only one is
// opened per Pi-hole and per secret. Login on demand (POST /api/auth
// → X-FTL-SID), a single reconnection on 401/403 (expired session), logout
// (DELETE /api/auth) on shutdown. The password comes from the environment and
// never appears in an error, nor does the URL.
import { fetch as uFetch } from 'undici'
import { agentFor } from './tls.js'
import { withUserAgent } from './http.js'
import { t as tr } from './i18n.js'

const TIMEOUT = 8000

// password: function (read at each login, error if the secret is missing) or string.
// The password and the session id (X-FTL-SID) are secrets.
// Login keeps the global undici agent (verification by the Node bundled store, like
// the strict agent); reads and logout go through agentFor(url, { secret: true }), hence strict.
export function createPihole({ url, password, fetch = uFetch, timeout = TIMEOUT, dispatcher = agentFor(url, { secret: true }), loginDispatcher }) {
  const secret = typeof password === 'function' ? password : () => password
  let sid = null
  let logging = null // login in progress, shared by concurrent calls

  async function login() {
    const r = await fetch(new URL('/api/auth', url), {
      method: 'POST', headers: withUserAgent({ 'content-type': 'application/json' }),
      body: JSON.stringify({ password: secret() }), ...(loginDispatcher ? { dispatcher: loginDispatcher } : {}), signal: AbortSignal.timeout(timeout),
    })
    const j = await r.json().catch(() => ({}))
    if (!j.session?.sid) throw new Error(tr('errors.pihole.auth', { status: r.status }))
    return j.session.sid
  }

  function session() {
    if (sid) return sid
    logging ??= login().then(s => (sid = s)).finally(() => {
      logging = null
    })
    return logging
  }

  // GET → JSON (or raw text if the response is not JSON)
  async function get(path, retry = true) {
    const used = await session()
    const r = await fetch(new URL(path, url), {
      headers: withUserAgent({ Accept: 'application/json', 'X-FTL-SID': used }),
      dispatcher, signal: AbortSignal.timeout(timeout),
    })
    // expired session: a new login, only once (unless another
    // call has already renewed it in the meantime)
    if ((r.status === 401 || r.status === 403) && retry) {
      await r.body?.cancel()
      if (sid === used) sid = null
      return get(path, false)
    }
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

  // session logout (2 s max); no effect if none is open
  async function close() {
    const s = sid
    sid = null
    if (!s) return
    await fetch(new URL('/api/auth', url), {
      method: 'DELETE', headers: withUserAgent({ 'X-FTL-SID': s }), dispatcher, signal: AbortSignal.timeout(2000),
    }).then(r => r.body?.cancel()).catch(() => {})
  }

  return { get, close, get open() { return !!sid } }
}

// Registry: one client per (origin, secret variable), shared by all
// consumers of the process; stop() closes all open sessions.
export function createPiholes({ env = process.env, fetch = uFetch, timeout = TIMEOUT } = {}) {
  const clients = new Map()
  return {
    get(url, secretEnv) {
      const key = `${new URL(url).origin}|${secretEnv}`
      if (!clients.has(key)) {
        clients.set(key, createPihole({
          url, fetch, timeout,
          password: () => {
            const v = env[secretEnv]
            if (!v) throw new Error(tr('errors.secret_missing', { name: secretEnv }))
            return v
          },
        }))
      }
      return clients.get(key)
    },
    stop: () => Promise.all([...clients.values()].map(c => c.close())),
  }
}
