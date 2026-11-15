// Probe scheduler: each probe runs as a background task at its own
// interval (with a random offset at startup), without overlap nor
// more than MAX_CONCURRENT simultaneous probes. HTTP routes only read the
// last result in memory: they never trigger an outgoing call.
import { runCheck, describe } from './checks.js'
import { probeTypes } from './registry.js'
import { seconds } from './duration.js'
import { t as tr } from './i18n.js'

const MAX_CONCURRENT = 8

// delay before a new attempt after the n-th failure in a row: 60 s, then doubled
// at each failure, capped at the normal interval. Widgets call it with n = 1 (fixed retry at
// 60 s); tls probes with their failure counter
export const RETRY_MS = 60_000
export const retryDelay = (n, everyMs) => Math.min(everyMs, RETRY_MS * 2 ** Math.max(0, n - 1))
// failure of a tls probe = no certificate read (connection refused or cut, timeout, no
// certificate, probe error). A certificate read, even close to expiry, is a successful
// read: it keeps the normal interval
const tlsFailed = r => !!r && !r.tls

// Minimal semaphore: limits the number of probes in flight (shared by the monitors of the process)
let inFlight = 0
const waiting = []
async function limited(fn) {
  if (inFlight >= MAX_CONCURRENT) await new Promise(r => waiting.push(r))
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    waiting.shift()?.()
  }
}

// probe, timers, randomness and clock injectable (tests); stop() cancels the
// next runs (tests; index.js does not call it, the process exits). Production defaults.
export function createMonitor(cfg, { run = runCheck, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, now = () => Date.now() } = {}) {
  const timers = new Set()
  let stopped = false
  const later = (fn, ms) => {
    const id = setTimer(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
  }
  const results = new Map()
  // plugin probe in lasting error after failAfter runs in a row (like service_down)
  const failAfter = cfg.alerts?.failAfter ?? 3
  const tlsRetries = new Map() // tls probe → failures in a row (short retry)
  const listeners = []
  const hostIp = new Map(cfg.hosts.map(h => [h.id, h.ip]))
  const checks = cfg.services.flatMap(s => (s.checks ?? defaultChecks(s)).map((c, i) => {
    const d = describe(c)
    // the host IP is already in the tile footer, the HTTP code in the chip: the path is enough
    if (c.type === 'http' && !c.label) {
      const u = new URL(c.url)
      if (u.hostname === hostIp.get(s.host)) d.label = u.pathname === '/' ? 'accueil' : u.pathname
    }
    return {
      ...c,
      ...d,
      id: `${s.id}#${i}`,
      serviceId: s.id,
      // default period carried by the probe type (registry; 60 s otherwise)
      intervalSec: c.interval ? seconds(c.interval) : probeTypes.get(c.type)?.intervalSec ?? 60,
    }
  }))

  // fails / oks: consecutive failures and successes, read by the alert engine
  // (alert after N failures, recovery after M successes)
  async function tick(c, { reschedule = true } = {}) {
    const prev = results.get(c.id)
    try {
      const r = await limited(() => run(c))
      const crit = r.state === 'crit'
      results.set(c.id, {
        ...r, checkedAt: new Date(now()).toISOString(),
        fails: crit ? (prev?.fails ?? 0) + 1 : 0,
        oks: crit ? 0 : (prev?.oks ?? 0) + 1,
      })
    } catch (e) {
      const error = String(e?.message || e)
      const checkedAt = new Date(now()).toISOString()
      if (probeTypes.get(c.type)?.owner === 'core') {
        // core probe: unexpected error
        results.set(c.id, { state: 'unknown', error, checkedAt, fails: prev?.fails ?? 0, oks: prev?.oks ?? 0 })
      } else {
        // plugin probe that throws. Transient: "unknown", nothing counted.
        // Lasting (failAfter runs in a row, like service_down): failure, and each of these runs
        // counts as a failure; service_down therefore fires at the same moment as for a core
        // probe that fails failAfter times. errors: runs in error in a row; failsBefore:
        // failures counted before the series
        const errors = (prev?.errors ?? 0) + 1
        const failsBefore = prev?.errors ? prev.failsBefore : prev?.fails ?? 0
        results.set(c.id, errors >= failAfter
          ? { state: 'crit', error: tr('errors.probe.repeated', { count: errors, error }), code: 0, latencyMs: null, checkedAt, fails: failsBefore + errors, oks: 0, errors, failsBefore }
          : { state: 'unknown', error, checkedAt, fails: prev?.fails ?? 0, oks: prev?.oks ?? 0, errors, failsBefore })
      }
    } finally {
      for (const fn of listeners) {
        try {
          fn(c, results.get(c.id))
        } catch (e) {
          console.error(e)
        }
      }
      let delay = c.intervalSec * 1000
      if (c.type === 'tls') {
        // the counter also follows off-cycle runs (Refresh), which reschedule nothing
        const n = tlsFailed(results.get(c.id)) ? (tlsRetries.get(c.id) ?? 0) + 1 : 0
        if (n) tlsRetries.set(c.id, n)
        else tlsRetries.delete(c.id)
        if (n) delay = retryDelay(n, delay)
      }
      if (reschedule && !stopped) later(() => tick(c), delay)
    }
  }

  return {
    checks,
    start() {
      for (const c of checks) {
        later(() => tick(c), random() * Math.min(c.intervalSec, 10) * 1000)
      }
    },
    stop() {
      stopped = true
      for (const id of timers) clearTimer(id)
      timers.clear()
    },
    result: id => results.get(id),
    // off-cycle run ("Refresh" button), without touching the schedule. tls probes whose
    // certificate was read are excluded: they measure an expiry (in days, read every
    // 6 h) and target public hosts to be spared (shared hosting), and Refresh is allowed every
    // minute. tls probes in failure (no certificate read) are rerun
    runAll: () => Promise.allSettled(checks.filter(c => c.type !== 'tls' || tlsFailed(results.get(c.id))).map(c => tick(c, { reschedule: false }))),
    // subscription to each result (history)
    onResult: fn => listeners.push(fn),
    get completed() { return results.size },
  }
}

// Without a "checks" key: HTTP probe on the service URL. "checks: []" = link only.
function defaultChecks(s) {
  return s.url ? [{ type: 'http', url: s.url }] : []
}

const RANK = { crit: 4, warn: 3, unknown: 2, ok: 1 }
export const worst = states => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok')
