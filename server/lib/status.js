// Aggregates shared by the cockpit (/api/summary) and the digest: same rules
// as the alert engine, so that displayed and notified figures match.
const guestHosts = (cfg, clusterId) => cfg.hosts.filter(h => (h.kind === 'vm' || h.kind === 'lxc') && h.pve === clusterId)

const nextRun = jobs => {
  const runs = (jobs || []).filter(j => j.enabled && j.nextRun).map(j => j.nextRun)
  return runs.length ? Math.min(...runs) * 1000 : null
}

// up-to-date backups per hypervisor, for the guests declared in hosts[]
export function backupStatus(cfg, snap, now = Date.now()) {
  return (snap.backups?.data || []).map(e => {
    const node = cfg.hosts.find(h => h.kind === 'pve-node' && h.pve === e.id)
    // alerts.backups false (guest deliberately left out of the backups): not counted, like the
    // alert rules (no backup_late, no not_backed_up), unless its last backup task failed
    const guests = guestHosts(cfg, e.id).filter(h => h.alerts?.backups !== false || e.items?.find(x => x.vmid === h.vmid)?.failed)
    if (e.error) return { id: e.id, node: node?.name ?? e.id, env: node?.env ?? 'prod', error: e.error, total: guests.length, ok: 0, late: [], failed: [] }
    const late = []
    const failed = []
    for (const h of guests) {
      const it = e.items.find(x => x.vmid === h.vmid)
      if (it?.failed) failed.push(h.name)
      else if (!it?.last || now - it.last * 1000 > cfg.alerts.backupMaxAgeHours * 3600_000) late.push(h.name)
    }
    return {
      id: e.id, node: node?.name ?? e.id, env: node?.env ?? 'prod', total: guests.length,
      ok: guests.length - late.length - failed.length, late, failed,
      last: Math.max(0, ...e.items.map(i => i.last || 0)) * 1000 || null,
      // next run of an active job (/cluster/backup schedule)
      next: nextRun(e.jobs),
    }
  })
}

// host: keys of modules and plugins (network, updates, …); without host, the network argument is used
export function summary({ cfg, snap, monitor, engine, servicesView, network = null, host = null, env = 'all', now = Date.now() }) {
  const inEnv = e => env === 'all' || e === env

  // services
  const svc = servicesView().filter(s => inEnv(s.env) && s.state !== 'none')
  const lat = svc.map(s => s.latencyMs).filter(x => x != null).sort((a, b) => a - b)
  const services = {
    total: svc.length,
    ok: svc.filter(s => s.state === 'ok').length,
    warn: svc.filter(s => s.state === 'warn').length,
    crit: svc.filter(s => s.state === 'crit').length,
    unknown: svc.filter(s => s.state === 'unknown').length,
    medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
  }

  // guests (all those Proxmox knows) and the declared ones that should be running
  const guests = { running: 0, total: 0, byEnv: {}, stoppedDeclared: [], errors: [] }
  for (const c of snap.cluster?.data || []) {
    const node = cfg.hosts.find(h => h.kind === 'pve-node' && h.pve === c.id)
    const cEnv = node?.env ?? 'prod'
    if (!inEnv(cEnv)) continue
    if (c.error) {
      guests.errors.push(`${node?.name ?? c.id} : ${c.error}`)
      continue
    }
    const run = c.guests.filter(g => g.status === 'running').length
    guests.running += run
    guests.total += c.guests.length
    guests.byEnv[cEnv] = { running: run, total: c.guests.length, node: node?.name ?? c.id }
    for (const h of guestHosts(cfg, c.id)) {
      const g = c.guests.find(x => x.vmid === h.vmid)
      if (!g || g.status !== 'running') guests.stoppedDeclared.push(h.name)
    }
  }

  // alerts
  const active = engine.active().filter(a => inEnv(a.env))
  const firing = active.filter(a => a.state === 'firing' && !a.suppressed)
  const alerts = {
    critical: firing.filter(a => a.severity === 'critical').length,
    warning: firing.filter(a => a.severity === 'warning').length,
    info: firing.filter(a => a.severity === 'info').length,
    pending: active.filter(a => a.state === 'pending').length,
    masked: active.filter(a => a.state === 'firing' && a.suppressed).length,
    incidents24h: engine.incidents(now - 86400_000).filter(i => inEnv(i.env)).length,
  }

  // certificates
  const certs = { total: 0, minDays: null, minName: null, soon: 0 }
  for (const c of monitor.checks.filter(c => c.type === 'tls')) {
    const s = cfg.services.find(x => x.id === c.serviceId)
    const host = cfg.hosts.find(h => h.id === s?.host)
    if (!inEnv(s?.env ?? host?.env)) continue
    const d = monitor.result(c.id)?.tls?.daysLeft
    if (d == null) continue
    certs.total++
    if (d < (c.warnDays ?? 21)) certs.soon++
    if (certs.minDays == null || d < certs.minDays) {
      certs.minDays = d
      certs.minName = s?.name ?? c.serviceId
    }
  }

  const backups = backupStatus(cfg, snap, now).filter(b => inEnv(b.env))

  // overall state: worst notifiable alert; "partiel" if a source is missing
  const sourcesDown = [...guests.errors, ...backups.filter(b => b.error).map(b => `sauvegardes ${b.node}`)]
  const state = alerts.critical ? 'crit' : alerts.warning ? 'warn' : sourcesDown.length ? 'unknown' : 'ok'

  // network (network module): the LAN is neither prod nor dev, unfiltered figures; null without a network block
  const mods = host ? host.summaries({ snap, env, now }) : { network: network?.summary(now) ?? null }

  return { generatedAt: new Date(now).toISOString(), env, state, sourcesDown, services, guests, alerts, certs, backups, ...mods }
}
