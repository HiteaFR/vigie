// Alert rules: turn the current state (probes + collectors) into signals.
// cond = true (problem), false (recovered) or null (no new information:
// the engine keeps the current state, e.g. at startup or when a source is silent).
import { fmtDuration } from '../clock.js'
import { memPct, smartOk } from '../proxmox.js'
import { VPN_FIELDS } from '../config.js'
import { autoActive } from '../updates/pending.js'
import { postureOf, exposedPorts, CRITERIA } from '../agentmemory.js'
import { SLOW_SEC } from '../agents.js'
import { localeTag, numberFormat, t as tr } from '../i18n.js'

const SEV_RANK = { info: 0, warning: 1, critical: 2 }
// rule types emitted by the core (this file): no module or plugin may declare them
// (lib/plugins/host.js), except source_error (shared, distinct keys). Kept up to date by a test
// that re-reads the "rule: '…'" entries of this file. ci_failed and runner_offline belong to the
// gitea plugin (server/plugins/gitea), never emitted from here (no double emission).
export const CORE_RULES = Object.freeze([
  'agent_unreachable', 'apt_stale', 'autoupdate_failed', 'autoupdate_off', 'backup_failed', 'backup_late', 'cert_expiry',
  'container_down', 'container_restarting', 'container_unhealthy', 'disk_free', 'disk_temp', 'disk_wear', 'guest_disk',
  'guest_inodes', 'guest_stopped', 'guest_undeclared', 'node_mem', 'node_swap', 'not_backed_up', 'port_new',
  'posture_regression', 'pve_unreachable', 'reboot_required', 'restart_required', 'security_updates',
  'service_down', 'smart_failed', 'source_error', 'storage_usage', 'systemd_failed', 'time_unsynced', 'vpn_down', 'vpn_leak',
  'vpn_noinfo', 'oom_kill',
  // notification channel failing (lib/notify/notifier.js, channelSignals)
  'channel_error',
])
// closing of port_new alerts for ports that are gone; fresh slow report (collected every hour:
// one missed collection is tolerated, same threshold as a stale local report) and cap on CLOSED lines per host
export const PORT_SLOW_FRESH = 3 * SLOW_SEC * 1000
export const PORT_GONE_MAX = 32
// disk_free: GB of 1024³ bytes (like the display and df -h); recovers at threshold + 1 GB. Free
// space rounded down (11.96 GB → "11.9", never "12" under a threshold of 12)
const GIB = 1024 ** 3
export const DISK_FREE_HYST_GB = 1
const gbFloor = numberFormat({ maximumFractionDigits: 1, roundingMode: 'floor' })
const gbFmt = numberFormat({ maximumFractionDigits: 1 })

// host (lib/plugins/host.js): signals of the modules and plugins (updates, network, …);
// without host, the updates and network signals are called directly
// channels(now) → channel_error signals of the notification channels (notifier.channelSignals),
// emitted last; without channels, none
export function createRules(cfg, monitor, agents = null, updates = null, network = null, widgets = null, memory = null, { host = null, channels = null } = {}) {
  const A = cfg.alerts
  // short date ("03/11") in the alerts time zone (alerts.timezone), not the system one
  const fmtDay = ms => new Date(ms).toLocaleDateString(localeTag(), { day: '2-digit', month: '2-digit', timeZone: A.timezone ?? 'Europe/Paris' })
  const hosts = new Map(cfg.hosts.map(h => [h.id, h]))
  const checksByService = Map.groupBy(monitor.checks, c => c.serviceId)
  const pveNode = id => cfg.hosts.find(h => h.kind === 'pve-node' && h.pve === id)

  // prod → critical; dev capped at warning (staging); host overrides then service overrides
  function severity(base, env, ...overrides) {
    let s = base
    for (const o of overrides) if (o?.alerts?.severity) s = o.alerts.severity
    if (env === 'dev' && SEV_RANK[s] > SEV_RANK.warning) s = 'warning'
    return s
  }
  const byEnv = env => (env === 'prod' ? 'critical' : 'warning')
  const muted = (...objs) => objs.some(o => o?.alerts?.mute)

  // ancestors of a host: its Proxmox guest, then the Proxmox API that hosts it
  function parentsOf(hostId) {
    const out = new Set()
    const seen = new Set()
    for (let h = hosts.get(hostId); h && !seen.has(h.id); h = h.parent ? hosts.get(h.parent) : null) {
      seen.add(h.id)
      if (h.kind === 'vm' || h.kind === 'lxc') out.add(`guest_stopped:${h.id}`)
      if (h.pve) out.add(`pve_unreachable:${h.pve}`)
    }
    return [...out]
  }

  // "CT 201 · pve-a" / "VM 202 · pve-b" / appliance name
  function hostLabel(h) {
    if (!h) return null
    if (h.kind === 'vm' || h.kind === 'lxc') {
      return `${h.kind === 'lxc' ? 'CT' : 'VM'} ${h.vmid} ${h.name} · ${pveNode(h.pve)?.name || h.pve}`
    }
    return h.name
  }

  // essential unit (exact name, or name + ".service")
  const essentialUnit = u => A.criticalUnits.some(c => u === c || u === `${c}.service`)

  const isIp = s => /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s)
  const checkLabel = c => (c.label && !isIp(c.label) ? c.label : c.type.toUpperCase())

  // containers of the last fast report of an agent host, if it is fresh (5 min) and has a
  // docker block; otherwise null (no information)
  function dockerListed(hostId, now) {
    if (!agents?.hosts?.some(h => h.id === hostId)) return null
    const st = agents.get(hostId)
    return st?.ok && st.fast && now - st.at < 5 * 60_000 ? st.fast.docker?.containers ?? null : null
  }

  // only for the container_down parent of service_down: a fast report with a docker block
  // received less than 5 min ago, EVEN if the last read failed (st.fast and st.at are kept):
  // a single ssh failure must not release service_down (double notification); a lost agent
  // only holds it for 5 min at most. container_down keeps the strict rule (dockerListed)
  function dockerSeen(hostId, now) {
    if (!agents?.hosts?.some(h => h.id === hostId)) return false
    const st = agents.get(hostId)
    return !!st?.fast?.docker?.containers && now - st.at < 5 * 60_000
  }

  function services(now) {
    const out = []
    for (const s of cfg.services) {
      const h = hosts.get(s.host)
      const env = s.env ?? h?.env
      const base = {
        entity: s.id, title: s.name, env, hostId: s.host ?? null, host: hostLabel(h),
        link: `/services?q=${encodeURIComponent(s.name)}`, muted: muted(h, s),
        parents: s.host ? parentsOf(s.host) : [],
      }
      const checks = checksByService.get(s.id) || []
      // a declared container that is missing or stopped suppresses the service failure; only
      // with a recent docker report: a container_down left pending without data (lost agent)
      // would hold service_down forever
      const downParents = s.host && s.container && dockerSeen(s.host, now) ? [`container_down:${s.host}/${s.container}`, ...base.parents] : base.parents

      // availability: every probe except certificate expiry
      const avail = checks.filter(c => c.type !== 'tls').map(c => ({ c, r: monitor.result(c.id) }))
      if (avail.length) {
        const failing = avail.filter(x => x.r && x.r.fails >= A.failAfter)
        let cond = null
        if (failing.length) cond = true
        else if (avail.every(x => x.r && x.r.state !== 'crit' && x.r.oks >= A.recoverAfter)) cond = false
        out.push({
          ...base, key: `service_down:${s.id}`, rule: 'service_down', cond, parents: downParents,
          severity: severity(byEnv(env), env, h, s),
          detail: failing.map(x => tr('rules.check_line', { check: checkLabel(x.c), error: x.r.error || (x.r.code ? `HTTP ${x.r.code}` : tr('rules.check_failed')) })).join(' · ') || null,
        })
      }

      // certificates: warn < 21 d, crit < 7 d (probe thresholds)
      for (const c of checks.filter(c => c.type === 'tls')) {
        const r = monitor.result(c.id)
        const days = r?.tls?.daysLeft
        const warnDays = c.warnDays ?? 21
        const critDays = c.critDays ?? 7
        out.push({
          ...base, key: `cert_expiry:${c.id}`, rule: 'cert_expiry',
          title: `${s.name} — ${checkLabel(c)}`,
          cond: days == null ? null : days < warnDays,
          severity: days != null && days < critDays ? severity('critical', env, h, s) : 'warning',
          detail: days == null ? null
            : days < 0 ? tr('rules.cert.expired')
              : tr('rules.cert.expires', { days, date: new Date(r.tls.validTo).toLocaleDateString(localeTag()) }),
          parents: [], // an expiry does not depend on the host's availability
        })
      }
    }
    return out
  }

  function proxmox(snap) {
    const out = []
    const clusters = snap.cluster?.data
    for (const p of cfg.proxmox) {
      const node = pveNode(p.id)
      const env = node?.env ?? 'prod'
      const entry = clusters?.find(c => c.id === p.id)
      // only a network failure (node off, link down) suppresses the guests and
      // services: an API error (expired token, 401/403) says nothing about them,
      // and their direct probes must keep alerting
      // decided on the source's error code (lib/sources.js: api or network), not on its
      // text (which is translated)
      const network = !!entry?.error && entry.errorKind !== 'api'
      out.push({
        key: `pve_unreachable:${p.id}`, rule: 'pve_unreachable', entity: p.id,
        title: `Proxmox ${node?.name || p.id}`, env, hostId: node?.id ?? null, host: null,
        cond: entry ? !!entry.error : null, forSec: 120,
        severity: network ? severity(byEnv(env), env, node) : 'warning',
        detail: entry?.error ? (network ? entry.error : tr('rules.pve.api_error', { error: entry.error })) : null,
        masksChildren: network,
        link: '/infra', muted: muted(node), parents: [],
      })
      if (!entry || entry.error) continue

      // guests declared in the config: expected to run all the time
      for (const h of cfg.hosts.filter(h => (h.kind === 'vm' || h.kind === 'lxc') && h.pve === p.id)) {
        const g = entry.guests.find(x => x.vmid === h.vmid)
        out.push({
          key: `guest_stopped:${h.id}`, rule: 'guest_stopped', entity: h.id,
          title: `${h.kind === 'lxc' ? 'CT' : 'VM'} ${h.vmid} ${h.name}`, env: h.env, hostId: h.id,
          host: node?.name ?? p.id,
          cond: !g || g.status !== 'running', forSec: 90,
          severity: severity(byEnv(h.env), h.env, h), detail: g ? tr('rules.guest.state', { status: g.status }) : tr('rules.guest.missing'),
          link: '/infra', muted: muted(h), parents: [`pve_unreachable:${p.id}`],
        })
      }

      // Proxmox guest (templates excluded) missing from the cluster's hosts[]: info. Declared
      // later → cond false (resolved); ignored (proxmox[].ignoreGuests) → cond false; gone from
      // Proxmox → no more signal, the alert is forgotten without a message (engine, 10 min)
      const declared = new Set(cfg.hosts.filter(h => h.pve === p.id && h.vmid != null).map(h => h.vmid))
      const ignored = new Set(p.ignoreGuests)
      for (const g of entry.guests) {
        out.push({
          key: `guest_undeclared:${p.id}:${g.vmid}`, rule: 'guest_undeclared', entity: `${p.id}/${g.vmid}`,
          title: tr('rules.guest.undeclared_title', { kind: g.type === 'lxc' ? 'CT' : 'VM', vmid: g.vmid, name: g.name }), env, hostId: null, host: node?.name ?? p.id,
          cond: !declared.has(g.vmid) && !ignored.has(g.vmid), severity: severity('info', env),
          detail: tr('rules.guest.undeclared_detail', { status: g.status }),
          link: '/infra', muted: muted(node), parents: [`pve_unreachable:${p.id}`],
        })
      }

      // rootfs of containers declared WITHOUT an agent, according to Proxmox (/cluster/resources,
      // disk and maxdisk): same guest_disk rule, same thresholds and same key as the root seen by
      // an agent (an agent host keeps the agent's measure: no duplicate). VMs are excluded:
      // Proxmox does not see a VM's internal disk
      for (const h of cfg.hosts.filter(h => h.kind === 'lxc' && h.pve === p.id && !h.agent)) {
        const g = entry.guests.find(x => x.vmid === h.vmid)
        const pct = g?.status === 'running' && g.maxdisk > 0 ? (g.disk / g.maxdisk) * 100 : null
        const D = A.disk
        out.push({
          key: `guest_disk:${h.id}:/`, rule: 'guest_disk', entity: h.id, title: tr('rules.disk.title', { mount: '/', host: h.name }),
          env: h.env, hostId: h.id, host: hostLabel(h), link: `/infra?h=${h.id}`, muted: muted(h),
          cond: pct == null ? null : pct >= D.warnPct ? true : pct < D.warnPct - 2 ? false : null,
          severity: pct != null && pct >= D.critPct ? severity('critical', h.env, h) : 'warning',
          detail: pct == null ? null : tr('rules.used_pve', { pct: pct.toFixed(0) }), parents: parentsOf(h.id),
        })
      }

      // storages: a shared storage (same name, same size) is counted only once
      for (const st of entry.storages) {
        if (!st.maxdisk) continue
        const twin = clusters.find(c => c.id !== p.id && !c.error && c.storages?.some(x => x.name === st.name && x.maxdisk === st.maxdisk))
        if (twin && cfg.proxmox.findIndex(x => x.id === twin.id) < cfg.proxmox.findIndex(x => x.id === p.id)) continue
        const pct = (st.disk / st.maxdisk) * 100
        const S = A.storage
        out.push({
          key: `storage_usage:${p.id}/${st.name}`, rule: 'storage_usage', entity: `${p.id}/${st.name}`,
          title: tr('rules.storage.title', { name: st.name, node: node?.name ?? p.id }), env, hostId: node?.id ?? null, host: null,
          // 2-point hysteresis so as not to oscillate around the threshold
          cond: pct >= S.warnPct ? true : pct < S.warnPct - 2 ? false : null,
          severity: pct >= S.critPct ? severity('critical', env) : 'warning',
          detail: tr('rules.used', { pct: pct.toFixed(0) }), pct,
          link: '/infra', muted: muted(node), parents: [`pve_unreachable:${p.id}`],
        })
      }
    }
    return out
  }

  function backups(snap, now) {
    const out = []
    for (const entry of snap.backups?.data || []) {
      const node = pveNode(entry.id)
      out.push({
        key: `source_error:backups/${entry.id}`, rule: 'source_error', entity: `backups/${entry.id}`,
        title: tr('rules.backup.read_title', { node: node?.name ?? entry.id }), env: node?.env ?? 'prod',
        cond: !!entry.error, forSec: 600, severity: 'warning', detail: entry.error || null,
        link: '/backups', parents: [`pve_unreachable:${entry.id}`],
      })
      if (entry.error || !entry.mode) continue
      for (const h of cfg.hosts.filter(h => (h.kind === 'vm' || h.kind === 'lxc') && h.pve === entry.id)) {
        const it = entry.items.find(x => x.vmid === h.vmid)
        const cov = entry.coverage?.find(x => x.vmid === h.vmid)
        const base = {
          entity: h.id, env: h.env, hostId: h.id, host: node?.name ?? entry.id,
          link: '/backups', muted: muted(h), parents: [],
        }
        const label = `${h.kind === 'lxc' ? 'CT' : 'VM'} ${h.vmid} ${h.name}`
        const age = it?.last ? now - it.last * 1000 : null
        // alerts.backups false: guest deliberately left out of the backups, no "late" or "not
        // backed up" alert (a failed task, if any, is still reported)
        const optedOut = h.alerts?.backups === false
        if (!optedOut) out.push({
          ...base, key: `backup_late:${h.id}`, rule: 'backup_late', title: tr('rules.backup.title', { label }),
          cond: age == null || age > A.backupMaxAgeHours * 3600_000,
          severity: severity('warning', h.env, h),
          detail: age == null ? tr('rules.backup.none') : tr('rules.backup.last', { duration: fmtDuration(age) }),
        })
        if (it?.failed != null) {
          out.push({
            ...base, key: `backup_failed:${h.id}`, rule: 'backup_failed', title: tr('rules.backup.title', { label }),
            cond: it.failed, severity: severity(byEnv(h.env), h.env, h),
            detail: tr('rules.backup.failed'),
          })
        }
        // guest declared but covered by no active job (excluded, or job disabled)
        if (!optedOut) out.push({
          ...base, key: `not_backed_up:${h.id}`, rule: 'not_backed_up', title: tr('rules.backup.title', { label }),
          cond: cov ? cov.covered === false : null, severity: severity('warning', h.env, h),
          detail: cov?.excluded ? tr('rules.backup.excluded') : tr('rules.backup.no_job'),
        })
      }
    }
    return out
  }

  // Proxmox nodes: memory, swap, SMART and disk wear
  function nodes(snap) {
    const out = []
    for (const entry of snap.nodes?.error ? [] : snap.nodes?.data || []) {
      if (entry.error) continue
      for (const n of entry.nodes || []) {
        if (n.error) continue
        const h = cfg.hosts.find(x => x.kind === 'pve-node' && x.pve === entry.id && x.name === n.node) || pveNode(entry.id)
        const env = h?.env ?? 'prod'
        const base = { env, hostId: h?.id ?? null, host: null, link: '/infra', muted: muted(h), parents: [`pve_unreachable:${entry.id}`] }
        const mem = memPct(n)
        if (mem != null) {
          const M = A.nodeMem
          out.push({
            ...base, key: `node_mem:${entry.id}/${n.node}`, rule: 'node_mem', entity: `${entry.id}/${n.node}`, title: tr('rules.mem.title', { node: n.node }),
            cond: mem >= M.warnPct ? true : mem < M.warnPct - 2 ? false : null, forSec: 300,
            severity: mem >= M.critPct ? severity('critical', env, h) : 'warning',
            detail: tr('rules.mem.detail', { pct: mem.toFixed(0) }),
          })
        }
        if (n.swap?.total) {
          const sw = (n.swap.used / n.swap.total) * 100
          const S = A.nodeSwap
          out.push({
            ...base, key: `node_swap:${entry.id}/${n.node}`, rule: 'node_swap', entity: `${entry.id}/${n.node}`, title: `Swap ${n.node}`,
            cond: sw >= S.warnPct ? true : sw < S.warnPct - 5 ? false : null, forSec: 600, severity: 'warning',
            detail: tr('rules.swap.detail', { pct: sw.toFixed(0) }),
          })
        }
      }
    }
    for (const entry of snap.disks?.error ? [] : snap.disks?.data || []) {
      if (entry.error) continue
      for (const d of entry.disks || []) {
        const h = cfg.hosts.find(x => x.kind === 'pve-node' && x.pve === entry.id && x.name === d.node) || pveNode(entry.id)
        const env = h?.env ?? 'prod'
        const name = `${d.model || d.type || tr('rules.disk.default')} (${d.devpath} · ${d.node})`
        const base = { env, hostId: h?.id ?? null, host: null, link: '/infra', muted: muted(h), parents: [`pve_unreachable:${entry.id}`], entity: `${entry.id}/${d.node}${d.devpath}` }
        const counters = [
          d.reallocated ? tr('rules.smart.reallocated', { n: d.reallocated }) : null,
          d.pending ? tr('rules.smart.pending', { n: d.pending }) : null,
          d.mediaErrors ? tr('rules.smart.media', { n: d.mediaErrors }) : null,
        ].filter(Boolean)
        out.push({
          ...base, key: `smart_failed:${base.entity}`, rule: 'smart_failed', title: `SMART ${name}`,
          cond: d.health == null ? null : !smartOk(d.health), severity: severity(byEnv(env), env, h),
          detail: [tr('rules.smart.state', { health: d.health }), ...counters].join(' · '),
        })
        if (d.wearout != null) {
          out.push({
            ...base, key: `disk_wear:${base.entity}`, rule: 'disk_wear', title: tr('rules.wear.title', { name }),
            cond: d.wearout <= A.diskWearMinPct, severity: 'warning',
            detail: `${tr('rules.wear.left', { pct: d.wearout })}${d.percentUsed != null ? tr('rules.wear.used', { used: d.percentUsed }) : ''}`,
          })
        }
        // SMART temperature, same thresholds for all node disks; 2 °C hysteresis like
        // guest_disk; unknown value: no information
        const T = A.diskTemp
        const t = typeof d.temp === 'number' && Number.isFinite(d.temp) ? d.temp : null
        out.push({
          ...base, key: `disk_temp:${base.entity}`, rule: 'disk_temp', title: tr('rules.temp.title', { name }),
          cond: t == null ? null : t >= T.warn ? true : t < T.warn - 2 ? false : null,
          severity: t != null && t >= T.crit ? severity('critical', env, h) : 'warning',
          detail: t == null ? null : tr('rules.temp.detail', { t, warn: T.warn, crit: T.crit }),
        })
      }
    }
    return out
  }

  // dash-report agent: a report older than 5 min no longer says anything
  // (cond null); an unreachable agent suppresses the host's alerts
  function agentRules(now) {
    const out = []
    for (const h of agents?.hosts || []) {
      const st = agents.get(h.id)
      const label = hostLabel(h)
      const base = { entity: h.id, env: h.env, hostId: h.id, host: label, link: `/infra?h=${h.id}`, muted: muted(h) }
      const hostKey = st.errorKind === 'hostkey'
      out.push({
        ...base, key: `agent_unreachable:${h.id}`, rule: 'agent_unreachable', title: `Agent ${h.name}`,
        cond: st.ok == null ? null : !st.ok, forSec: hostKey ? 0 : 300,
        // a changed host key is a security alert, not just a collection gap
        severity: hostKey ? severity(byEnv(h.env), h.env, h) : 'warning',
        detail: st.error, parents: parentsOf(h.id),
      })
      const fresh = st.ok && st.fast && now - st.at < 5 * 60_000
      const parents = [`agent_unreachable:${h.id}`, ...parentsOf(h.id)]
      const f = fresh ? st.fast : null

      for (const fs of f?.fs || []) {
        // file system inodes (agent v8), key separate from guest_disk, same thresholds, same
        // hysteresis and same severity; inodes null or total zero (btrfs, tmpfs): no information
        if (f.version >= 8 && Object.hasOwn(fs, 'inodes')) {
          const ino = fs.inodes
          const ipct = ino?.total ? (ino.used / ino.total) * 100 : null
          const D = A.disk
          out.push({
            ...base, key: `guest_inodes:${h.id}:${fs.mount}`, rule: 'guest_inodes', title: `Inodes ${fs.mount} · ${h.name}`,
            cond: ipct == null ? null : ipct >= D.warnPct ? true : ipct < D.warnPct - 2 ? false : null,
            severity: ipct != null && ipct >= D.critPct ? severity('critical', h.env, h) : 'warning',
            detail: ipct == null ? null : tr('rules.inodes.detail', { pct: ipct.toFixed(0) }), parents,
          })
        }
        if (!fs.size) continue
        const pct = (fs.used / (fs.used + fs.avail)) * 100
        const D = A.disk
        out.push({
          ...base, key: `guest_disk:${h.id}:${fs.mount}`, rule: 'guest_disk', title: tr('rules.disk.title', { mount: fs.mount, host: h.name }),
          cond: pct >= D.warnPct ? true : pct < D.warnPct - 2 ? false : null,
          severity: pct >= D.critPct ? severity('critical', h.env, h) : 'warning',
          detail: tr('rules.used', { pct: pct.toFixed(0) }), parents,
        })
      }
      // absolute free-space threshold of the root (hosts[].alerts.diskFreeMinGB, GB of 1024³ bytes):
      // warning below the threshold (strictly), recovered at threshold + 1 GB (hysteresis), in between
      // no information; key separate from guest_disk (both can fire). Root missing from the
      // report, unusable avail (missing, null, empty or non-numeric: null after cleanFast,
      // never "0 GB free") or stale report: no signal, like guest_disk
      const minGB = h.alerts?.diskFreeMinGB
      const root = minGB != null ? f?.fs?.find(x => x.mount === '/' && x.size > 0 && Number.isFinite(x.avail)) : null
      if (root) {
        const freeGB = root.avail / GIB
        out.push({
          ...base, key: `disk_free:${h.id}:/`, rule: 'disk_free', title: tr('rules.disk_free.title', { mount: '/', host: h.name }),
          cond: freeGB < minGB ? true : freeGB >= minGB + DISK_FREE_HYST_GB ? false : null,
          severity: 'warning',
          detail: tr('rules.disk_free.detail', { free: gbFloor.format(freeGB), min: gbFmt.format(minGB) }), parents,
        })
      }
      for (const c of f?.docker?.containers || []) {
        const cb = { ...base, entity: `${h.id}/${c.name}`, parents, link: `/infra?h=${h.id}` }
        out.push({
          ...cb, key: `container_unhealthy:${h.id}/${c.name}`, rule: 'container_unhealthy', title: tr('rules.container.title', { name: c.name, host: h.name }),
          // health only counts while the container runs: Docker keeps the last status after a stop
          // (an unhealthy container stopped on purpose would otherwise alert until restarted);
          // a stopped declared container is container_down's job
          cond: c.state === 'running' && c.health === 'unhealthy', forSec: 120,
          severity: severity(byEnv(h.env), h.env, h), detail: tr('rules.container.unhealthy'),
        })
        out.push({
          ...cb, key: `container_restarting:${h.id}/${c.name}`, rule: 'container_restarting', title: tr('rules.container.title', { name: c.name, host: h.name }),
          cond: c.state === 'restarting' || c.recentRestarts >= 3,
          severity: severity(byEnv(h.env), h.env, h),
          detail: c.state === 'restarting' ? tr('rules.container.looping', { n: c.restarts }) : tr('rules.container.restarts', { n: c.recentRestarts }),
        })
      }
      // DECLARED container (services[].container) missing from the report or not running;
      // matched like the updates module (name or compose service). Report missing, old or without a
      // docker block, or unknown state: no information (agent_unreachable covers the agent). forSec:
      // a re-creation (compose up) raises nothing. In a restart loop: suppressed by
      // container_restarting (a single notification)
      const listed = dockerListed(h.id, now)
      for (const [name, svcs] of Map.groupBy(cfg.services.filter(s => s.host === h.id && s.container), s => s.container)) {
        const c = listed?.find(x => x.name === name || x.service === name)
        const state = c?.state ?? null
        out.push({
          ...base, key: `container_down:${h.id}/${name}`, rule: 'container_down', entity: `${h.id}/${name}`,
          // services that declare the container: a silence or maintenance on one of them covers it
          title: tr('rules.container.title', { name, host: h.name }), muted: muted(h, ...svcs), services: svcs.map(s => s.id),
          cond: !listed ? null : !c ? true : state == null ? null : state !== 'running', forSec: 120,
          severity: severity(byEnv(h.env), h.env, h),
          detail: !listed ? null : !c ? tr('rules.container.missing') : state == null ? null : tr('rules.container.state', { state }),
          parents: c ? [...parents, `container_restarting:${h.id}/${c.name}`] : parents,
        })
      }
      if (f?.systemd) {
        const bad = [...f.systemd.failed, ...f.systemd.watched.filter(u => u.active !== 'active').map(u => u.unit)]
        // warning, unless an essential unit (alerts.criticalUnits) has failed;
        // essential ones first in the detail
        const uniq = [...new Set(bad)].sort((a, b) => essentialUnit(b) - essentialUnit(a))
        const critical = uniq.some(essentialUnit)
        out.push({
          ...base, key: `systemd_failed:${h.id}`, rule: 'systemd_failed', title: tr('rules.systemd.title', { host: h.name }),
          cond: uniq.length > 0, forSec: 120, severity: severity(critical ? 'critical' : 'warning', h.env, h),
          detail: uniq.length ? uniq.slice(0, 5).join(', ') + (uniq.length > 5 ? ` (+${uniq.length - 5})` : '') : null, parents,
        })
      }
      // clock not synchronized by NTP (agent v8, slow report: reacts within 1 to 2 h
      // with forSec); null: no information
      if (f && st.slow?.version >= 8) {
        const sync = st.slow.time?.ntpSynced ?? null
        out.push({
          ...base, key: `time_unsynced:${h.id}`, rule: 'time_unsynced', title: tr('rules.time.title', { host: h.name }),
          cond: sync == null ? null : !sync, forSec: 30 * 60, severity: severity('warning', h.env, h),
          detail: sync === false ? tr('rules.time.detail') : null, parents,
        })
      }
      // agent v9: processes killed by earlyoom over the last hour (fast report), warning; null:
      // earlyoom absent or unknown (no signal); v8 and older: no signal
      if (f && f.version >= 9 && f.oom) {
        const oom = f.oom
        out.push({
          ...base, key: `oom_kill:${h.id}`, rule: 'oom_kill', title: tr('rules.oom.title', { host: h.name }),
          cond: oom.kills > 0, severity: severity('warning', h.env, h),
          detail: oom.kills > 0 ? tr('rules.oom.detail', { count: oom.kills, process: oom.lastProcess ?? '?' }) : null, parents,
        })
      }
      if (f) {
        out.push({
          ...base, key: `reboot_required:${h.id}`, rule: 'reboot_required', title: tr('rules.reboot.title', { host: h.name }),
          cond: f.reboot.required, severity: 'info', detail: f.reboot.reason, parents,
        })
      }
      const apt = fresh && st.slow?.apt
      if (apt) {
        const age = apt.listsAt ? now - apt.listsAt * 1000 : null
        out.push({
          ...base, key: `apt_stale:${h.id}`, rule: 'apt_stale', title: tr('rules.apt.title', { host: h.name }),
          cond: age == null || age > A.aptMaxAgeDays * 86400_000, severity: 'warning',
          detail: age == null ? tr('rules.apt.missing') : tr('rules.apt.age', { duration: fmtDuration(age) }), parents,
        })
        // postponed or ignored from the updates page: no more alert, in both modes
        const ignored = !!updates?.isIgnored?.(`apt:${h.id}`)
        if (autoActive(st.slow)) {
          // automatic updates active: only a stuck fix (pending for more than
          // securityPendingHours, age from the database); warning, same severity in prod and dev
          const list = updates?.securityPending?.(h.id)
          const limit = A.securityPendingHours * 3600_000
          const blocked = (list ?? []).filter(p => now - p.since > limit)
          out.push({
            ...base, key: `security_updates:${h.id}`, rule: 'security_updates', title: tr('rules.security.title', { host: h.name }),
            cond: list == null ? null : blocked.length > 0 && !ignored, severity: severity('warning', h.env, h),
            detail: blocked.length ? tr('rules.security.blocked', { duration: fmtDuration(now - blocked[0].since), list: `${blocked.slice(0, 5).map(p => p.name).join(', ')}${blocked.length > 5 ? ` (+${blocked.length - 5})` : ''}` }) : null,
            parents,
          })
        } else {
          // without automatic updates (agent v6, disabled): plain pending-updates check
          out.push({
            ...base, key: `security_updates:${h.id}`, rule: 'security_updates', title: tr('rules.security.title', { host: h.name }),
            cond: apt.security > 0 && !ignored, severity: 'info',
            detail: tr('rules.security.pending', { security: apt.security, upgradable: apt.upgradable }), parents,
          })
        }
      }
      // services to restart after an update (needrestart, agent v8), info like
      // reboot_required; v7 or v6: no information (cond null)
      const restart = fresh && st.slow?.version >= 8 ? st.slow.restart : null
      out.push({
        ...base, key: `restart_required:${h.id}`, rule: 'restart_required', title: tr('rules.restart.title', { host: h.name }),
        cond: restart ? restart.units.length > 0 : null, severity: 'info',
        detail: restart?.units.length ? restartDetail(restart.units) : null, parents,
      })
      // SSH or firewall posture regression: a criterion out of line while a v8 report already
      // saw it compliant, and the gap has not been accepted; a gap present from the first v8
      // report does not alert (no avalanche); without memory or without v8: cond null
      const pv = fresh && st.slow?.version >= 8 && st.slow.posture && memory ? postureOf(st.slow.posture) : null
      const regressed = pv ? CRITERIA.filter(c => pv[c] === false && memory.postureRow(h.id, c)?.first_ok != null && !memory.postureRow(h.id, c)?.accepted_at) : []
      out.push({
        ...base, key: `posture_regression:${h.id}`, rule: 'posture_regression', title: tr('rules.posture.title', { host: h.name }),
        cond: pv ? regressed.length > 0 : null, severity: severity('warning', h.env, h),
        detail: regressed.length ? regressed.map(c => tr('rules.posture.gap', { gap: POSTURE_GAP[c](st.slow.posture), date: fmtDay(memory.postureRow(h.id, c).last_ok) })).join(' · ') : null,
        parents,
      })
      // port listening on a non-local address, never seen on this host since its first v8
      // report (bootstrapped without alert), as long as it is not marked "Known"; info
      // host with alerts.ports false: no port_new signal, neither raised nor closed;
      // an alert already raised has no signal any more and the engine forgets it quietly (FORGET_AFTER)
      const portsOn = h.alerts?.ports !== false
      const exposed = portsOn && fresh && st.slow?.version >= 8 && Array.isArray(st.slow.listening) && memory?.bootstrapped(h.id)
        ? exposedPorts(st.slow.listening) : null
      for (const [k, e] of exposed ?? []) {
        const row = memory.portRow(h.id, e.proto, e.port)
        out.push({
          ...base, key: `port_new:${h.id}:${k}`, rule: 'port_new', title: `Port ${k} · ${h.name}`,
          cond: !row || row.known_at == null, severity: 'info',
          detail: tr('rules.port.detail', { processes: e.processes.length ? ` (${e.processes.join(', ')})` : '', addrs: e.addrs.join(', ') }), parents,
        })
      }
      // port not yet "Known" that the report no longer exposes. Fresh slow report
      // (less than PORT_SLOW_FRESH): cond false, the alert resolves. Otherwise (stale report, agent
      // unreachable, < v8, listening missing): cond null, nothing changes; the signal keeps the alert
      // alive, which the engine would otherwise forget after 10 min without a signal. Memory lines
      // only: all lines still open (each one is a raised alert, to keep or to resolve), then at most
      // PORT_GONE_MAX closed lines per host (purged 7 d after closing), most recent first; a false
      // on a key without state does nothing.
      // Host not bootstrapped: no line
      if (portsOn && memory?.bootstrapped?.(h.id)) {
        const slowFresh = !!exposed && st.slowAt != null && now - st.slowAt < PORT_SLOW_FRESH
        const rows = memory.unknownPorts(h.id).filter(r => !exposed?.has(`${r.proto}/${r.port}`))
          .sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0) || a.port - b.port || a.proto.localeCompare(b.proto))
        const gone = [...rows.filter(r => r.closed_at == null), ...rows.filter(r => r.closed_at != null).slice(0, PORT_GONE_MAX)]
        for (const r of gone) {
          out.push({
            ...base, key: `port_new:${h.id}:${r.proto}/${r.port}`, rule: 'port_new', title: `Port ${r.proto}/${r.port} · ${h.name}`,
            cond: slowFresh ? false : null, severity: 'info', detail: null, parents,
          })
        }
      }
      // automatic security updates (agent v7, slow report); v6 or missing block: no
      // information (cond null), hence no new alert
      const au = fresh && st.slow?.version >= 7 ? st.slow.autoUpdate : null
      const active = autoActive(st.slow)
      const off = !au ? null
        : !au.installed ? tr('rules.auto.missing')
          : !au.enabled ? tr('rules.auto.disabled')
            : !au.securityOnly ? tr('rules.auto.not_security') : false
      out.push({
        ...base, key: `autoupdate_off:${h.id}`, rule: 'autoupdate_off', title: tr('rules.auto.title', { host: h.name }),
        cond: off === null ? null : !!off, severity: severity('warning', h.env, h), detail: off || null, parents,
      })
      const runAge = au?.lastRunAt != null ? now - au.lastRunAt * 1000 : null
      const never = tr('rules.auto.never')
      const failed = !au || !active ? null
        : au.lastResult === 'failed' ? tr('rules.auto.failed')
          : runAge == null ? never
            : runAge > A.autoUpdateMaxAgeHours * 3600_000 ? tr('rules.auto.age', { duration: fmtDuration(runAge) }) : false
      // never run (freshly equipped host): no information, hence nothing shown, not even
      // pending, as long as automatic updates have been seen active for less than
      // autoUpdateMaxAgeHours (first-seen date persisted by the agent memory); past that
      // delay: raised without waiting. Date still unknown (report not observed yet, no
      // memory): no information
      const since = failed === never ? memory?.autoActiveSince?.(h.id) ?? null : null
      const young = failed === never && (since == null || now - since < A.autoUpdateMaxAgeHours * 3600_000)
      out.push({
        ...base, key: `autoupdate_failed:${h.id}`, rule: 'autoupdate_failed', title: tr('rules.auto.title', { host: h.name }),
        // automatic updates disabled: autoupdate_off only (no double alert)
        cond: au && !active ? false : failed === null || young ? null : !!failed,
        severity: severity('warning', h.env, h), detail: young ? null : failed || null, parents,
      })
    }
    return out
  }

  // VPN tunnel of a service (gluetun type), from its widget fields (collected every
  // minute, no extra call). vpn_down: status ≠ running (warning); vpn_leak: organization
  // of the public IP at the home ISP, or country outside countries (critical through
  // severity(), hence warning in dev). Widget IN ERROR (key refused, API changed…): vpn_down raised
  // with the error in the detail, so that monitoring does not go silent (suppressed if service_down
  // is already raised: parent); widget missing, old (> 5 min) or empty value: no information
  // (cond null). An unreachable control server stays under service_down (parent).
  function vpnRules(now) {
    const out = []
    for (const s of cfg.services.filter(x => x.vpn)) {
      const h = hosts.get(s.host)
      const env = s.env ?? h?.env
      const w = widgets?.get(s.id)
      const fresh = !!w && !w.error && !w.stale && w.at && now - Date.parse(w.at) < 5 * 60_000
      const val = k => {
        const [p, j] = VPN_FIELDS[k]
        const i = s.widget.fields.findIndex(f => f.path === p && f.json === j)
        const v = fresh && i >= 0 ? w.fields[i]?.value : null
        return v == null || v === '—' || String(v).trim() === '' ? null : String(v).trim()
      }
      const status = val('status')
      const org = val('organization')
      const country = s.vpn.countries ? val('country') : null
      const parents = [
        `service_down:${s.id}`,
        ...(s.container ? [`container_restarting:${s.host}/${s.container}`, `container_unhealthy:${s.host}/${s.container}`] : []),
        ...(h?.agent ? [`agent_unreachable:${h.id}`] : []),
        ...parentsOf(s.host),
      ]
      const base = { entity: s.id, env, hostId: s.host, host: hostLabel(h), link: `/services?q=${encodeURIComponent(s.name)}`, muted: muted(h, s), parents }
      const widgetError = w?.error ? String(w.error) : null
      out.push({
        ...base, key: `vpn_down:${s.id}`, rule: 'vpn_down', title: `VPN ${s.name}`,
        cond: widgetError ? true : status == null ? null : status.toLowerCase() !== 'running', forSec: 120,
        severity: severity('warning', env, h, s),
        detail: widgetError ? tr('rules.vpn.widget_error', { error: widgetError }) : status == null ? null : tr('rules.vpn.tunnel', { status }),
      })
      const ispLeak = org != null && org.toLowerCase().includes(s.vpn.homeIsp.toLowerCase())
      const countryLeak = country != null && !s.vpn.countries.some(c => c.toLowerCase() === country.toLowerCase())
      const known = org != null || country != null
      out.push({
        ...base, key: `vpn_leak:${s.id}`, rule: 'vpn_leak', title: tr('rules.vpn.leak_title', { name: s.name }),
        cond: known ? ispLeak || countryLeak : null,
        severity: severity('critical', env, h, s),
        detail: ispLeak ? tr('rules.vpn.isp_leak', { org }) : countryLeak ? tr('rules.vpn.country_leak', { country, expected: s.vpn.countries.join(', ') }) : null,
      })
      // tunnel running, widget fresh and without error, but neither country nor organization
      // for the public IP (gluetun's IP provider expired): vpn_leak would be blind without
      // saying so. Same fields as vpn_leak (no extra request); a stopped tunnel belongs to
      // vpn_down (parent); widget missing, old or empty status: no information. 15 min,
      // because a watchdog restarts gluetun after ~6 min: the alert says that was not enough
      const anyCountry = val('country')
      const running = status != null && status.toLowerCase() === 'running'
      out.push({
        ...base, key: `vpn_noinfo:${s.id}`, rule: 'vpn_noinfo', title: tr('rules.vpn.noinfo_title', { name: s.name }),
        cond: status == null ? null : running && org == null && anyCountry == null, forSec: 900,
        severity: severity('warning', env, h, s), parents: [...parents, `vpn_down:${s.id}`],
        detail: running && org == null && anyCountry == null ? tr('rules.vpn.noinfo') : null,
      })
    }
    return out
  }

  // services impacted by a parent failure (message "pve-b unreachable: …")
  function impacted(key) {
    const svc = cfg.services.filter(s => s.host && parentsOf(s.host).includes(key)).map(s => s.name)
    const guests = key.startsWith('pve_unreachable:')
      ? cfg.hosts.filter(h => (h.kind === 'vm' || h.kind === 'lxc') && h.pve === key.split(':')[1]).length
      : 0
    return { services: svc, guests }
  }

  return {
    evaluate: (snap, now) => {
      // module slots (lib/plugins/host.js): "ci" just before the agent rules (where the CI
      // rules used to be), "end" at the end; order of application and of notifications
      const before = [...services(now), ...vpnRules(now), ...proxmox(snap), ...nodes(snap), ...backups(snap, now)]
      const agentSignals = agentRules(now)
      const norm = list => list.map(s => ({ ...s, severity: severity(s.severity, s.env), muted: muted(hosts.get(s.hostId)) }))
      const core = [...before, ...agentSignals]
      const chans = channels ? channels(now) : []
      if (host) {
        const mods = host.evaluate(snap, now, { parentsOf, taken: new Set(core.map(s => s.key)) })
        return [...before, ...norm(mods.ci), ...agentSignals, ...norm(mods.end), ...chans]
      }
      return [
      ...core,
      // without host (tests): versions (end of life, published fixes) then network;
      // severity (dev capped at warning, overrides) and silence of the linked host like the core
      ...norm([...(updates?.signals(now) || []), ...(network?.signals?.(now, { parentsOf }) || [])]),
      ...chans,
      ]
    },
    impacted,
  }
}

// posture gap, in plain words
const POSTURE_GAP = {
  ssh_root: p => tr('rules.posture.ssh_root', { value: p.ssh?.permitRootLogin }),
  ssh_password: () => tr('rules.posture.ssh_password'),
  firewall: p => (p.firewall?.type === 'none' ? tr('rules.posture.no_firewall') : tr('rules.posture.firewall_off', { type: p.firewall?.type })),
}

// "nginx.service, php8.4-fpm.service (+3)" (5 units at most)
export const restartDetail = units => `${units.slice(0, 5).join(', ')}${units.length > 5 ? ` (+${units.length - 5})` : ''}`

// rule labels from the instance locale (rules.label.<rule>), read on every access;
// enumerable keys (bot, formatter, alerts-preview). Plugin labels (index.js, host.labels)
// are added through Object.assign: a write replaces the getter with the given value.
// net_agent_conflict: same key set as the client
const LABELED_RULES = [
  'service_down', 'cert_expiry', 'pve_unreachable', 'guest_stopped', 'storage_usage', 'backup_late',
  'backup_failed', 'source_error', 'agent_unreachable', 'guest_disk', 'vpn_down', 'vpn_leak', 'vpn_noinfo',
  'guest_undeclared', 'container_unhealthy', 'container_restarting', 'container_down', 'systemd_failed',
  'reboot_required', 'restart_required', 'guest_inodes', 'disk_free', 'posture_regression', 'port_new', 'time_unsynced',
  'oom_kill', 'apt_stale', 'security_updates', 'autoupdate_off', 'autoupdate_failed', 'eol', 'security_release',
  'not_backed_up', 'node_mem', 'node_swap', 'smart_failed', 'disk_wear', 'disk_temp', 'net_new',
  'net_mac_added', 'net_new_flood', 'net_down', 'net_ip_changed', 'net_agent_conflict', 'plugin_error',
  'channel_error'
]
export const RULE_LABEL = {}
for (const rule of LABELED_RULES) {
  Object.defineProperty(RULE_LABEL, rule, {
    enumerable: true,
    configurable: true,
    get: () => tr(`rules.label.${rule}`),
    set(v) { Object.defineProperty(RULE_LABEL, rule, { value: v, writable: true, enumerable: true, configurable: true }) },
  })
}
