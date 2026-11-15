// HTTP / TCP / TLS / DNS probes. Each probe returns a normalized result:
// { state: ok|warn|crit, latencyMs, code, error, tls? }. They never throw.
import { fetch as uFetch } from 'undici'
import net from 'node:net'
import tls from 'node:tls'
import { Resolver } from 'node:dns/promises'
import { z } from 'zod'
import { agentFor } from './tls.js'
import { USER_AGENT } from './user-agent.js'
import { isIpv4 } from './net/ip.js'
import { duration } from './config-types.js'
import { probeTypes } from './registry.js'
import { redactError } from './redact.js'
import { t as tr } from './i18n.js'

const TIMEOUT_MS = 5000
const BODY_LIMIT = 1024 * 1024
// timeout, pause before the second attempt and clock injectable (tests); these default values
// are the production ones, no production caller changes them
export const CHECK_DEFAULTS = Object.freeze({ timeoutMs: TIMEOUT_MS, retryDelayMs: 500, now: () => Date.now() })

// agent chosen by agentFor; a check never carries a secret: permissive
// on a literal private IPv4 or with the explicit exception tls: 'insecure' (tlsReason
// required), strict otherwise. Redirects are never followed (redirect: 'manual'). The tls
// probe type stays permissive by nature: it must read an expired or unknown certificate.

export const checkAgent = c => agentFor(c.url, { tls: c.tls })

const errCode = e => String(e?.cause?.code || e?.code || e?.message || e)

async function readLimited(body) {
  const chunks = []
  let size = 0
  for await (const chunk of body) {
    chunks.push(chunk)
    size += chunk.length
    if (size >= BODY_LIMIT) break
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function http(c, o = CHECK_DEFAULTS) {
  const started = Date.now()
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), o.timeoutMs)
  try {
    const headers = { 'User-Agent': USER_AGENT }
    const r = await uFetch(c.url, {
      headers, dispatcher: checkAgent(c), signal: ctrl.signal, redirect: 'manual',
    })
    const latencyMs = Date.now() - started
    const want = c.expect?.status
    const statusOk = want == null ? r.status < 500
      : Array.isArray(want) ? want.includes(r.status) : r.status === want
    if (!statusOk) {
      await r.body?.cancel()
      return { state: 'crit', latencyMs, code: r.status, error: `HTTP ${r.status}` }
    }
    if (c.expect?.body) {
      const text = r.body ? await readLimited(r.body) : ''
      if (!text.includes(c.expect.body)) {
        return { state: 'crit', latencyMs, code: r.status, error: tr('errors.probe.keyword', { word: c.expect.body }) }
      }
    } else {
      await r.body?.cancel()
    }
    return { state: 'ok', latencyMs, code: r.status }
  } catch (e) {
    return {
      state: 'crit', latencyMs: Date.now() - started, code: 0,
      error: ctrl.signal.aborted ? 'timeout' : errCode(e),
    }
  } finally {
    clearTimeout(to)
  }
}

function tcp(c, o = CHECK_DEFAULTS) {
  const [host, port] = [c.target.slice(0, c.target.lastIndexOf(':')), Number(c.target.split(':').pop())]
  return new Promise(resolve => {
    const started = Date.now()
    const sock = net.connect({ host, port })
    let done = false
    const finish = (ok, err) => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ state: ok ? 'ok' : 'crit', latencyMs: Date.now() - started, code: ok ? 'tcp' : 0, error: err })
    }
    sock.setTimeout(o.timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false, 'timeout'))
    sock.once('error', e => finish(false, errCode(e)))
  })
}

function tlsExpiry(c, o = CHECK_DEFAULTS) {
  const warnDays = c.warnDays ?? 21
  const critDays = c.critDays ?? 7
  const servername = c.servername ?? (net.isIP(c.host) ? undefined : c.host)
  return new Promise(resolve => {
    const started = Date.now()
    let done = false
    const sock = tls.connect({ host: c.host, port: c.port ?? 443, servername, rejectUnauthorized: false })
    const finish = r => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ latencyMs: Date.now() - started, ...r })
    }
    sock.setTimeout(o.timeoutMs)
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate()
      if (!cert?.valid_to) return finish({ state: 'crit', code: 0, error: tr('errors.probe.no_cert') })
      const validTo = new Date(cert.valid_to)
      const daysLeft = Math.floor((validTo - o.now()) / 86400000)
      const issuer = cert.issuer?.O || cert.issuer?.CN || null
      const state = daysLeft < critDays ? 'crit' : daysLeft < warnDays ? 'warn' : 'ok'
      finish({
        state, code: 'tls',
        error: daysLeft < 0 ? tr('errors.probe.cert_expired') : undefined,
        tls: { validTo: validTo.toISOString(), daysLeft, issuer },
      })
    })
    sock.once('timeout', () => finish({ state: 'crit', code: 0, error: 'timeout' }))
    sock.once('error', e => finish({ state: 'crit', code: 0, error: errCode(e) }))
  })
}

// verdict of a resolution: no address → crit; with expect.address, crit if it is
// not among the answers ("answer <addresses>, expected <address>"); pure
export function dnsVerdict(addrs, c) {
  if (!addrs.length) return { state: 'crit', error: tr('errors.probe.no_address') }
  const want = c.expect?.address
  if (want && !addrs.includes(want)) return { state: 'crit', error: tr('errors.probe.dns_mismatch', { got: addrs.join(', '), want }) }
  return { state: 'ok', error: undefined }
}

async function dns(c, o = CHECK_DEFAULTS) {
  const started = Date.now()
  const resolver = new Resolver({ timeout: o.timeoutMs, tries: 1 })
  resolver.setServers([c.server])
  try {
    const addrs = await resolver.resolve4(c.name)
    return { ...dnsVerdict(addrs, c), latencyMs: Date.now() - started, code: 'dns' }
  } catch (e) {
    return { state: 'crit', latencyMs: Date.now() - started, code: 0, error: errCode(e) }
  }
}

// --- probe type registry ---------------------------------------------------------------------------
// Entry: { schema (zod, config), run(check, o) → normalized result, describe(check) → { label,
// display }, intervalSec (default period, without interval in the config) }. The four core
// types below; a plugin declares others (definePlugin, extensions.probes:
// lib/plugins/extensions.js).
const httpCheck = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  expect: z.object({
    status: z.union([z.number().int(), z.array(z.number().int())]).optional(),
    body: z.string().optional(),
  }).strict().optional(),
  label: z.string().optional(),
  interval: duration.optional(),
  // explicit exception, without a secret; tlsReason required (crossCheck)
  tls: z.literal('insecure').optional(),
  tlsReason: z.string().optional(),
}).strict()

const tcpCheck = z.object({
  type: z.literal('tcp'),
  target: z.string().regex(/^[^:]+:\d+$/, 'target: host:port'),
  name: z.string().optional(),
  label: z.string().optional(),
  interval: duration.optional(),
}).strict()

const tlsCheck = z.object({
  type: z.literal('tls'),
  host: z.string(),
  port: z.number().int().optional(),
  servername: z.string().optional(),
  warnDays: z.number().int().optional(),
  critDays: z.number().int().optional(),
  label: z.string().optional(),
  interval: duration.optional(),
}).strict()

const dnsCheck = z.object({
  type: z.literal('dns'),
  server: z.string(),
  name: z.string(),
  label: z.string().optional(),
  interval: duration.optional(),
  // expected IPv4 address among the answers (otherwise crit); without expect, unchanged
  expect: z.object({ address: z.string().refine(isIpv4, 'IPv4 expected') }).strict().optional(),
}).strict()

probeTypes.add('http', {
  schema: httpCheck, run: http, intervalSec: 60,
  describe: c => ({ label: c.label || new URL(c.url).host, display: c.url }),
})
probeTypes.add('tcp', {
  schema: tcpCheck, run: tcp, intervalSec: 60,
  describe: c => ({ label: c.label || c.name || `TCP ${c.target.split(':').pop()}`, display: `tcp://${c.target}` }),
})
probeTypes.add('tls', {
  schema: tlsCheck, run: tlsExpiry, intervalSec: 6 * 3600,
  describe: c => ({ label: c.label || 'certificat', display: `${c.servername || c.host}:${c.port ?? 443}` }),
})
probeTypes.add('dns', {
  schema: dnsCheck, run: dns, intervalSec: 60,
  describe: c => ({ label: c.label || `DNS ${c.name}`, display: `dns://${c.server}/${c.name}` }),
})

// Isolation of a plugin probe: bounded timeout (its own timeout, plus PLUGIN_MARGIN_MS), result
// checked, known fields only, masked messages (lib/redact.js: declared secrets, URLs,
// tokens).
// - Timeout exceeded: crit ("timed out"), like a core probe whose service no longer answers
//   (otherwise a dead service would stay gray, without service_down).
// - Exception or invalid result: THROWS; the monitor turns it into an "unknown" result (data,
//   counted neither as failure nor success) while it is transient, then a failure when it lasts
//   (lib/monitor.js, tick: alerts.failAfter runs in a row). No plugin_error: the result
//   belongs to a probe and is visible on its service, like a collection error.
export const PLUGIN_MARGIN_MS = 1000
const TIMEOUT = Symbol('timeout')
const STATES = new Set(['ok', 'warn', 'crit'])
async function runPluginProbe(p, c, o) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => resolve(TIMEOUT), o.timeoutMs + PLUGIN_MARGIN_MS)
  })
  try {
    const r = await Promise.race([Promise.resolve().then(() => p.run(c, { timeoutMs: o.timeoutMs, now: o.now })), deadline])
    if (r === TIMEOUT) return { state: 'crit', latencyMs: o.timeoutMs + PLUGIN_MARGIN_MS, code: 0, error: tr('errors.probe.timeout') }
    if (!r || !STATES.has(r.state)) throw new Error(tr('errors.probe.invalid_result'))
    const out = { state: r.state, latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null, code: typeof r.code === 'number' || typeof r.code === 'string' ? r.code : null }
    if (r.error != null) out.error = redactError(r.error, p.secretValues)
    return out
  } catch (e) {
    throw new Error(tr('errors.probe.plugin', { type: c.type, owner: p.owner, error: redactError(e, p.secretValues) }))
  } finally {
    clearTimeout(timer)
  }
}

function probeOf(type) {
  const p = probeTypes.get(type)
  if (!p) throw new Error(`unknown probe type: ${String(type).slice(0, 40)}`)
  return p
}
const once = (p, c, o) => (p.owner === 'core' ? p.run(c, o) : runPluginProbe(p, c, o))

// A failure is confirmed by an immediate second attempt before being published:
// this avoids showing red for a lost packet.
export async function runCheck(c, opts = {}) {
  const o = { ...CHECK_DEFAULTS, ...opts }
  const p = probeOf(c.type)
  const first = await once(p, c, o)
  if (first.state !== 'crit') return first
  await new Promise(r => setTimeout(r, o.retryDelayMs))
  return once(p, c, o)
}

// label and display of a probe; a plugin whose describe throws or returns something else: falls back
// to the config label and the type (the monitor is built anyway)
export function describe(c) {
  const p = probeOf(c.type)
  if (p.owner === 'core') return p.describe(c)
  try {
    const d = p.describe(c)
    if (typeof d?.label === 'string' && typeof d?.display === 'string') return { label: d.label, display: d.display }
  } catch {}
  return { label: c.label || c.type, display: c.type }
}
