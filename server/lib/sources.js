// External sources (Proxmox) shared by the HTTP routes and the alert
// engine. Each source goes through a TTL cache: routes and alert collectors
// trigger only one outgoing call per period.
import { fetch as uFetch } from 'undici'
import {
  nodeStatus, diskView, backupJob, coverage, runsFromLog, orphans, taskView, notificationsView, downsample,
} from './proxmox.js'
import { parseNetLine, PVE_PERIOD_MS } from './network/sources/pve.js'
import { agentFor, inspectCa, tlsErrorCode, SERVER_DIR } from './tls.js'
import { pkiDir as pkiDirOf } from './paths.js'
import { withUserAgent } from './http.js'
import { t as tr } from './i18n.js'

// injectable fetch for tests (no network call in CI)
// pkiDir: CA folder (PKI_DIR from env, otherwise server/pki)
export function createSources(cfg, env = process.env, { fetch: doFetch = uFetch, now = () => Date.now(), pkiDir = pkiDirOf(env, SERVER_DIR) } = {}) {

  // Proxmox hypervisors: config.json → proxmox[], secrets in <env>_TOKEN_ID /
  // <env>_TOKEN_SECRET (e.g. PVE_PROD_TOKEN_SECRET). <env>_HOST overrides the URL.
  // pinned CA (proxmox[].ca, pki/…) read at startup; missing, unreadable,
  // not a CA or expired → cluster in explicit error, no permissive fallback, no request
  const clusters = (cfg.proxmox || []).map(c => {
    const ca = c.ca ? inspectCa(c.ca, { dir: pkiDir, now: now() }) : null
    return {
      ...c,
      host: env[`${c.env}_HOST`] || c.host,
      tokenId: env[`${c.env}_TOKEN_ID`],
      tokenSecret: env[`${c.env}_TOKEN_SECRET`],
      caPem: ca?.pem ?? null,
      caInfo: ca && !ca.error ? { subject: ca.subject, validTo: ca.validTo, daysLeft: ca.daysLeft } : null,
      caError: ca?.error ?? null,
    }
  })

  // --- in-memory TTL cache (avoids hammering the APIs at each poll) ---
  // concurrent calls for the same key share the same promise
  const cache = new Map()
  // failTtlMs: a failure is kept for that long (negative cache), otherwise forgotten
  async function cached(key, ttlMs, fn, { failTtlMs = 0 } = {}) {
    const hit = cache.get(key)
    if (hit && now() - hit.t < (hit.failed ? failTtlMs : ttlMs)) return hit.v
    const entry = { t: now(), v: fn(), failed: false }
    cache.set(key, entry)
    entry.v.catch(() => {
      if (failTtlMs > 0) entry.failed = true
      else if (cache.get(key) === entry) cache.delete(key)
    })
    return entry.v
  }
  // error with an HTTP status (404 unknown, 502 Proxmox unreachable), read by the /api/rrd routes
  const httpError = (status, message) => Object.assign(new Error(message), { status })
  // cluster view (5 s cache); Proxmox in error → 502, without a rrddata call
  async function clusterView(clusterId) {
    if (!clusters.some(x => x.id === clusterId)) throw httpError(404, tr('api.unknown_cluster'))
    const view = (await cluster()).find(x => x.id === clusterId)
    if (!view || view.error) throw httpError(502, tr('api.pve_unreachable'))
    return view
  }

  // error classified by the source, for the rules (no text is parsed anymore): api = the API answered
  // with an error (HTTP status) or the token is missing, which says nothing about the guests' state; network
  // (default) = unreachable (network, timeout, certificate)
  const apiError = msg => Object.assign(new Error(msg), { kind: 'api' })
  async function pve(cluster, pathname) {
    if (cluster.caError) throw new Error(tr('errors.pve.unverified', { error: cluster.caError }))
    if (!cluster.tokenSecret) throw apiError(tr('errors.pve.token_missing', { env: cluster.env }))
    const url = `${cluster.host}/api2/json${pathname}`
    let r
    try {
      r = await doFetch(url, {
        headers: withUserAgent({ Authorization: `PVEAPIToken=${cluster.tokenId}=${cluster.tokenSecret}` }),
        dispatcher: agentFor(url, { secret: true, ca: cluster.caPem }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      // handshake refused: the token was not sent
      const code = tlsErrorCode(e)
      if (code) throw new Error(tr('errors.pve.tls', { code, pinned: cluster.ca ? tr('errors.pve.pinned', { ca: cluster.ca }) : '' }))
      throw e
    }
    if (!r.ok) throw apiError(`Proxmox ${r.status}`)
    return (await r.json()).data
  }

  // an unreachable Proxmox must not hide the others: error per cluster
  async function perCluster(fn) {
    return Promise.all(clusters.map(async c => {
      try {
        return { id: c.id, label: c.label, ...(await fn(c)) }
      } catch (e) {
        return { id: c.id, label: c.label, error: String(e.message || e), errorKind: e?.kind === 'api' ? 'api' : 'network' }
      }
    }))
  }

  // VM / LXC state via Proxmox (PVEAuditor), one block per hypervisor
  const cluster = () => cached('cluster', 5000, () => perCluster(async c => {
    const resources = await pve(c, '/cluster/resources')
    const guests = resources
      .filter(r => r.type === 'lxc' || r.type === 'qemu')
      .filter(r => !r.template)
      .map(g => ({
        vmid: g.vmid, name: g.name, type: g.type, status: g.status,
        node: g.node, cpu: g.cpu ?? 0, maxcpu: g.maxcpu ?? 1,
        mem: g.mem ?? 0, maxmem: g.maxmem ?? 0,
        disk: g.disk ?? 0, maxdisk: g.maxdisk ?? 0, uptime: g.uptime ?? 0,
      }))
      .sort((a, b) => a.vmid - b.vmid)
    const nodes = resources
      .filter(r => r.type === 'node')
      .map(n => ({
        name: n.node, status: n.status, cpu: n.cpu ?? 0, maxcpu: n.maxcpu ?? 1,
        mem: n.mem ?? 0, maxmem: n.maxmem ?? 0,
        disk: n.disk ?? 0, maxdisk: n.maxdisk ?? 0, uptime: n.uptime ?? 0,
      }))
    const seen = new Set()
    const storages = resources
      .filter(r => r.type === 'storage')
      .filter(s => !seen.has(s.storage) && seen.add(s.storage))
      .map(s => ({
        name: s.storage, status: s.status,
        disk: s.disk ?? 0, maxdisk: s.maxdisk ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { nodes, guests, storages }
  }))

  // Backups (per VM/CT), two sources depending on the token:
  //  - "storage" mode: storage content (requires VM.Backup + Datastore.AllocateSpace),
  //    which also reveals orphan backups (destroyed guest)
  //  - "tasks" mode  : logs of the latest vzdump jobs (Sys.Audit is enough, hence
  //    compatible with a strictly read-only PVEAuditor token)
  // In both cases, the vzdump logs give the history per day (matrix)
  // and the outcome of the last run; /cluster/backup gives schedule and exclusions.

  // the log of a finished task no longer changes: kept as long as the task is listed
  const taskLogs = new Map()
  async function vzdumpHistory(c, { node, jobs = 10 }) {
    const tasks = (await pve(c, `/nodes/${encodeURIComponent(node)}/tasks?typefilter=vzdump&limit=${Math.max(jobs, 14)}`))
      .filter(t => t.endtime)
      .sort((a, b) => b.starttime - a.starttime)
    const keep = new Set()
    const out = []
    for (const t of tasks) {
      const key = `${c.id}/${t.upid}`
      keep.add(key)
      if (!taskLogs.has(key)) {
        const lines = await pve(c, `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(t.upid)}/log?limit=10000`)
        taskLogs.set(key, runsFromLog(lines.map(l => l.t)))
      }
      out.push({ start: t.starttime, results: taskLogs.get(key) })
    }
    for (const k of taskLogs.keys()) if (k.startsWith(`${c.id}/`) && !keep.has(k)) taskLogs.delete(k)
    return out
  }

  // history (most recent first) → freshness and outcome per guest
  function itemsFromHistory(history) {
    const byVmid = new Map()
    for (const t of history) {
      for (const [vmid, ok] of t.results) {
        const cur = byVmid.get(vmid) || { vmid, last: 0, count: 0, failed: null }
        if (cur.failed === null) cur.failed = !ok
        if (ok) {
          cur.count++
          if (t.start > cur.last) cur.last = t.start
        }
        byVmid.set(vmid, cur)
      }
    }
    return byVmid
  }

  function itemsFromContent(content, history) {
    const fromLogs = itemsFromHistory(history)
    const byVmid = new Map()
    for (const b of content) {
      if (b.vmid == null) continue
      const cur = byVmid.get(b.vmid) || { vmid: b.vmid, last: 0, count: 0, failed: fromLogs.get(b.vmid)?.failed ?? null }
      cur.count++
      if ((b.ctime || 0) > cur.last) cur.last = b.ctime
      byVmid.set(b.vmid, cur)
    }
    return byVmid
  }

  const RUNS_DAYS = 8
  const backups = () => cached('backups', 60000, () => perCluster(async c => {
    const b = c.backups || {}
    if (!b.mode) return { mode: null, items: [], jobs: [], runs: {}, orphans: null, coverage: [] }
    const [jobsRaw, resources, history] = await Promise.all([
      pve(c, '/cluster/backup').catch(() => null),
      pve(c, '/cluster/resources?type=vm'),
      vzdumpHistory(c, b),
    ])
    const jobs = jobsRaw ? jobsRaw.map(backupJob) : null
    const vms = resources.filter(r => r.type === 'qemu' || r.type === 'lxc')
    const guests = vms.filter(r => !r.template)
    // runs of the last days per guest: the matrix is built on the client side (local time zone)
    const since = Date.now() / 1000 - RUNS_DAYS * 86400
    const runs = {}
    for (const t of history) {
      if (t.start < since) continue
      for (const [vmid, ok] of t.results) (runs[vmid] ||= []).push({ t: t.start, ok })
    }
    let items
    let orphanList = null
    if (b.mode === 'storage') {
      const content = await pve(c, `/nodes/${encodeURIComponent(b.node)}/storage/${encodeURIComponent(b.storage)}/content?content=backup`)
      items = itemsFromContent(content, history)
      // a template always exists: its backups are not orphans
      orphanList = orphans(content, new Set(vms.map(g => g.vmid)))
    } else {
      items = itemsFromHistory(history)
    }
    return {
      mode: b.mode, storage: b.storage ?? null,
      items: [...items.values()].sort((x, y) => x.vmid - y.vmid),
      jobs, runs, orphans: orphanList,
      coverage: jobs ? guests.map(g => ({ vmid: g.vmid, name: g.name, type: g.type, ...coverage(jobs, g) })).sort((x, y) => x.vmid - y.vmid) : null,
    }
  }))

  // RRD history of a Proxmox node (Sys.Audit is enough): CPU and RAM, for the
  // cockpit sparklines. Proxmox already keeps one year of aggregated history.
  // node unknown to the cluster → 404 without a PVE call; PVE failure kept 30 s
  const rrd = async (clusterId, node, timeframe = 'day') => {
    const view = await clusterView(clusterId)
    if (!view.nodes.some(n => n.name === node)) throw httpError(404, tr('api.unknown_node'))
    return rrdOf(clusterId, node, timeframe)
  }
  const rrdOf = (clusterId, node, timeframe) => cached(`rrd:${clusterId}:${node}:${timeframe}`, 60000, async () => {
    const c = clusters.find(x => x.id === clusterId)
    const rows = await pve(c, `/nodes/${encodeURIComponent(node)}/rrddata?timeframe=${timeframe}&cf=AVERAGE`)
    const pts = rows
      .filter(r => r.cpu != null)
      .map(r => ({
        t: r.time * 1000,
        cpu: r.cpu * 100,
        mem: r.memtotal ? (r.memused / r.memtotal) * 100 : null,
        load: r.loadavg ?? null,
      }))
    // at most ~144 points (a sparkline does not need per-minute data)
    return downsample(pts, ['cpu', 'mem', 'load'])
  }, { failTtlMs: 30_000 })

  // RRD history of a guest: CPU, RAM, network and disk (bytes/s)
  // guest unknown to the cluster → 404 without a PVE call (node and type read from the cached view);
  // PVE failure kept 30 s
  const guestRrd = async (clusterId, vmid, timeframe = 'day') => {
    const view = await clusterView(clusterId)
    const guest = view.guests.find(x => x.vmid === vmid)
    if (!guest) throw httpError(404, tr('api.unknown_guest'))
    return guestRrdOf(clusterId, guest, timeframe)
  }
  const guestRrdOf = (clusterId, g, timeframe) => cached(`grrd:${clusterId}:${g.vmid}:${timeframe}`, 60000, async () => {
    const c = clusters.find(x => x.id === clusterId)
    const vmid = g.vmid
    const rows = await pve(c, `/nodes/${encodeURIComponent(g.node)}/${g.type}/${vmid}/rrddata?timeframe=${timeframe}&cf=AVERAGE`)
    const pts = rows
      .filter(r => r.cpu != null)
      .map(r => ({
        t: r.time * 1000,
        cpu: r.cpu * 100,
        mem: r.maxmem ? (r.mem / r.maxmem) * 100 : null,
        netin: r.netin ?? null, netout: r.netout ?? null,
        diskread: r.diskread ?? null, diskwrite: r.diskwrite ?? null,
      }))
    return { vmid, name: g.name, type: g.type, node: g.node, maxcpu: g.maxcpu ?? null, maxmem: g.maxmem ?? null, timeframe, points: downsample(pts, ['cpu', 'mem', 'netin', 'netout', 'diskread', 'diskwrite'], 168) }
  }, { failTtlMs: 30_000 })

  // Proxmox VE version per node: installed pve-manager
  const pveVersions = () => cached('pveVersions', 10 * 60_000, () => perCluster(async c => {
    const nodes = (await pve(c, '/nodes')).filter(n => n.status === 'online')
    return {
      nodes: await Promise.all(nodes.map(async n => {
        try {
          const v = await pve(c, `/nodes/${encodeURIComponent(n.node)}/version`)
          return { node: n.node, version: v.version, release: v.release }
        } catch (e) {
          return { node: n.node, error: String(e.message || e) }
        }
      })),
    }
  }))

  // Guest network cards (network module): MAC and bridge from the netX lines of the
  // config, plus the IPs seen by Proxmox (container interfaces, guest agent of a VM;
  // the agent may answer 403 (e.g. on a dev cluster), the IP then comes from the config). MACs change
  // rarely: cache PVE_PERIOD_MS (10 min), about two calls per guest.
  const guestNics = () => cached('guestNics', PVE_PERIOD_MS, () => perCluster(async c => {
    const list = (await pve(c, '/cluster/resources?type=vm')).filter(g => (g.type === 'qemu' || g.type === 'lxc') && !g.template)
    const guests = await Promise.all(list.map(async g => {
      const base = `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`
      try {
        const conf = await pve(c, `${base}/config`)
        const nics = Object.keys(conf).filter(k => /^net\d+$/.test(k)).sort()
          .map(k => ({ key: k, ...parseNetLine(conf[k]) })).filter(n => n.mac)
        // effective IPs, matched by MAC (bridges and Docker veths of a VM are discarded)
        if (g.status === 'running' && nics.length) {
          const ips = new Map()
          if (g.type === 'lxc') {
            for (const i of await pve(c, `${base}/interfaces`).catch(() => [])) {
              if (i.hwaddr && i.inet) ips.set(i.hwaddr.toLowerCase(), [String(i.inet).split('/')[0]])
            }
          } else {
            const r = await pve(c, `${base}/agent/network-get-interfaces`).catch(() => null)
            for (const i of r?.result || []) {
              const v4 = (i['ip-addresses'] || []).filter(a => a['ip-address-type'] === 'ipv4').map(a => a['ip-address'])
              if (i['hardware-address'] && v4.length) ips.set(i['hardware-address'].toLowerCase(), v4)
            }
          }
          for (const n of nics) if (ips.has(n.mac)) n.ips = ips.get(n.mac)
        }
        return { vmid: g.vmid, name: g.name, type: g.type, node: g.node, status: g.status, nics }
      } catch (e) {
        return { vmid: g.vmid, name: g.name, type: g.type, node: g.node, status: g.status, nics: [], error: String(e.message || e) }
      }
    }))
    return { guests: guests.sort((a, b) => a.vmid - b.vmid) }
  }))

  // --- nodes, disks (SMART), failed tasks, PVE notifications ---
  const onlineNodes = async c => (await pve(c, '/nodes')).filter(n => n.status === 'online').map(n => n.node)

  const nodes = () => cached('nodes', 30_000, () => perCluster(async c => ({
    nodes: await Promise.all((await onlineNodes(c)).map(async n => {
      try {
        return nodeStatus(n, await pve(c, `/nodes/${encodeURIComponent(n)}/status`))
      } catch (e) {
        return { node: n, error: String(e.message || e) }
      }
    })),
  })))

  // SMART: one smartctl reading per disk, hence the long period
  const disks = () => cached('disks', 30 * 60_000, () => perCluster(async c => {
    const out = []
    for (const n of await onlineNodes(c)) {
      for (const d of await pve(c, `/nodes/${encodeURIComponent(n)}/disks/list`)) {
        const smart = await pve(c, `/nodes/${encodeURIComponent(n)}/disks/smart?disk=${encodeURIComponent(d.devpath)}`)
          .catch(e => ({ error: String(e.message || e) }))
        out.push(diskView(n, d, smart))
      }
    }
    return { disks: out }
  }))

  // failed tasks of the last 7 days: since= avoids waking up the history
  const TASKS_DAYS = 7
  const failedTasks = () => cached('failedTasks', 5 * 60_000, () => perCluster(async c => {
    const since = Math.floor(Date.now() / 1000) - TASKS_DAYS * 86400
    const out = []
    for (const n of await onlineNodes(c)) {
      const list = await pve(c, `/nodes/${encodeURIComponent(n)}/tasks?errors=1&limit=50&since=${since}`)
      out.push(...list.filter(t => t.endtime && t.starttime >= since).map(taskView))
    }
    return { tasks: out.sort((a, b) => b.start - a.start), days: TASKS_DAYS }
  }))

  const notifications = () => cached('pveNotifications', 30 * 60_000, () => perCluster(async c => {
    const [targets, matchers] = await Promise.all([pve(c, '/cluster/notifications/targets'), pve(c, '/cluster/notifications/matchers')])
    return { notifications: notificationsView(targets, matchers) }
  }))

  // Proxmox view: one block per hypervisor, each part may fail on its own
  async function proxmoxView() {
    const parts = await Promise.all([nodes(), disks(), failedTasks(), notifications()])
    return clusters.map(c => {
      const [n, d, t, no] = parts.map(list => list.find(x => x.id === c.id) || {})
      return {
        id: c.id, label: c.label,
        nodes: n.nodes ?? null, nodesError: n.error ?? null,
        disks: d.disks ?? null, disksError: d.error ?? null,
        tasks: t.tasks ?? null, tasksDays: t.days ?? TASKS_DAYS, tasksError: t.error ?? null,
        notifications: no.notifications ?? null, notificationsError: no.error ?? null,
      }
    })
  }

  // clears the caches ("Refresh" button); vzdump logs stay
  const invalidate = () => cache.clear()

  return { clusters, cluster, backups, rrd, guestRrd, pveVersions, nodes, disks, failedTasks, notifications, proxmoxView, guestNics, invalidate }
}
