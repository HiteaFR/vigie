// Common HTTP client. Every outgoing request carries the User-Agent "vigie/<version>"
// (user-agent.js); plugins only reach the outside through createHttp() (ctx.http), with a
// bounded timeout (default 10 s, from 0.1 to 30 s) and the server TLS agent (lib/tls.js: public CAs,
// or pinned CA; secret: never a permissive fallback). The User-Agent cannot be replaced, whatever
// the case (headers normalized by Headers; a Headers object is kept as is). Plugins:
// secret by default (defaultSecret), and always as soon as an Authorization or Cookie header is sent.
import { fetch as uFetch } from 'undici'
import { USER_AGENT } from './user-agent.js'
import { agentFor as tlsAgentFor } from './tls.js'

export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_TIMEOUT_MS = 30_000
export const MIN_TIMEOUT_MS = 100

// headers of an outgoing core request: the given ones, plus the User-Agent
export const withUserAgent = (headers = {}) => ({ ...headers, 'User-Agent': USER_AGENT })

export const boundTimeout = ms => Math.min(Math.max(Number.isFinite(Number(ms)) ? Number(ms) : DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)

// → http(url, { method, headers, body, timeoutMs, secret, ca }): undici Response
export function createHttp({ fetch = uFetch, agentFor = tlsAgentFor, defaultSecret = false } = {}) {
  return function http(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, secret = defaultSecret, ca = null, dispatcher, signal, ...rest } = {}) {
    const h = new Headers(headers)
    h.set('user-agent', USER_AGENT)
    const withSecret = !!secret || h.has('authorization') || h.has('cookie')
    return fetch(url, {
      ...rest,
      headers: h,
      dispatcher: agentFor(String(url), { secret: withSecret, ca }),
      signal: AbortSignal.timeout(boundTimeout(timeoutMs)),
    })
  }
}
