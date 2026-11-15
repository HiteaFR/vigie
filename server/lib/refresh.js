// "Refresh" button (UI) and /refresh (bot). Immediately reruns
// the agent readings, the probes, the widgets, the Proxmox sources and the plugin sources,
// then the version computation and an alert evaluation. A single pass at
// a time, and no more than one per minute: each pass opens SSH connections
// to all hosts. The local report (dashboard host) keeps its own pace (root timer).
// Network module: rereads its passive sources (never an active scan).
const COOLDOWN_MS = 60_000

// host: refresh of modules and plugins (refresh in parallel, afterRefresh after the
// collector), instead of network.runAll and updates.refresh; without host, those two are used
export function createRefresher({ agents, sources, collector, monitor, widgets, updates, engine, network = null, host = null, now = () => Date.now(), log = console }) {
  let running = null
  let last = null

  async function pass(by) {
    const startedAt = now()
    sources.invalidate()
    host?.invalidate()
    const steps = await Promise.allSettled([agents.refreshAll(), monitor.runAll(), widgets.runAll(), collector.runAll(), ...(host ? host.refresh() : network ? [network.runAll()] : [])])
    if (host) await host.afterRefresh()
    else await updates.refresh().catch(e => log.error(`refresh: versions: ${e.message}`))
    engine.evaluate(collector.snap)
    const failed = steps.filter(s => s.status === 'rejected').map(s => String(s.reason?.message || s.reason))
    last = { by, startedAt, finishedAt: now(), errors: failed }
    return last
  }

  return {
    // → { started, running, cooldownSec }; done: promise of the pass in progress
    run(by) {
      if (running) return { started: false, running: true, done: running }
      const wait = last ? COOLDOWN_MS - (now() - last.startedAt) : 0
      if (wait > 0) return { started: false, running: false, cooldownSec: Math.ceil(wait / 1000) }
      running = pass(by).finally(() => {
        running = null
      })
      return { started: true, running: true, done: running }
    },
    status: () => ({ running: !!running, last }),
  }
}
