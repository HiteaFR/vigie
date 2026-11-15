// Background collectors for the alert engine: each source is read at its own
// period (through the cache shared with the routes) and the last result is
// kept, with any error. Rules only read this snapshot.
// nodes and disks: SMART read every 30 min, cached by the source
import { t as tr } from '../i18n.js'
const PERIODS = { cluster: 60, backups: 600, nodes: 60, disks: 1800 }
// core sources (snapshot names), reserved: no plugin may use their name (lib/plugins/core.js)
export const CORE_SOURCES = Object.freeze(Object.keys(PERIODS))

// injectable timer, randomness and clock (tests); production defaults
// extra = sources of modules and plugins (host, host.collectors()): { name, periodSec, fn,
// configured, timeoutSec }; same rules as core sources (snapshot, error kept, not
// configured), plus a per-source timeout: a source that never returns becomes a
// "timeout" error (never silently frozen)
export function createCollector(sources, { setTimer = setTimeout, random = Math.random, now = () => Date.now(), extra = [] } = {}) {
  const periods = { ...PERIODS }
  const snap = { cluster: null, backups: null, nodes: null, disks: null }
  const fns = { cluster: sources.cluster, backups: sources.backups, nodes: sources.nodes, disks: sources.disks }
  const offs = new Set()
  const timeouts = {}
  for (const x of extra) {
    if (Object.hasOwn(snap, x.name)) throw new Error(`collector: duplicate source ${x.name}`)
    periods[x.name] = x.periodSec
    snap[x.name] = null
    fns[x.name] = x.fn
    if (x.timeoutSec) timeouts[x.name] = x.timeoutSec * 1000
    if (x.configured === false) offs.add(x.name)
  }

  // optional source not configured (configured: false on a module source, or
  // sources.configured[name] === false): never read, snapshot { configured: false } (no
  // source_error; views and digest show "not configured")
  const off = name => offs.has(name) || sources.configured?.[name] === false
  for (const name of Object.keys(snap)) if (off(name)) snap[name] = { configured: false, data: null, at: null, error: null }

  // timeout of a module source (real timer, cleared in every case)
  function bounded(fn, ms) {
    let timer
    return Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(tr('errors.timeout'))), ms) }),
    ]).finally(() => clearTimeout(timer))
  }

  async function run(name, { reschedule = true } = {}) {
    if (off(name)) return
    try {
      snap[name] = { data: await (timeouts[name] ? bounded(fns[name], timeouts[name]) : fns[name]()), at: now(), error: null }
    } catch (e) {
      // keep the last known data: the error is a source_error
      snap[name] = { data: snap[name]?.data ?? null, at: now(), error: String(e?.message || e) }
    } finally {
      if (reschedule) setTimer(() => run(name), periods[name] * 1000)
    }
  }

  return {
    snap,
    // immediate re-read of all sources (caches cleared by the caller)
    runAll: () => Promise.allSettled(Object.keys(periods).filter(name => !off(name)).map(name => run(name, { reschedule: false }))),
    start() {
      for (const name of Object.keys(periods)) if (!off(name)) setTimer(() => run(name), 1000 + random() * 4000)
    },
  }
}
