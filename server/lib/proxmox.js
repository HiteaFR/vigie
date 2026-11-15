// Parsing of Proxmox responses (nodes, SMART, backup jobs,
// vzdump logs). Pure functions, tested without network; the calls are
// in sources.js.

const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const int = v => {
  const m = String(v ?? '').replace(/[,\s]/g, '').match(/^-?\d+/)
  return m ? Number(m[0]) : null
}

// /nodes/{n}/status → the essentials ("available" memory if PVE provides it)
export function nodeStatus(node, s) {
  const mem = s.memory || {}
  return {
    node,
    pveVersion: String(s.pveversion || '').split('/')[1] || null,
    kernel: s['current-kernel']?.release || String(s.kversion || '').split(' ')[1] || null,
    cpuModel: s.cpuinfo?.model ?? null,
    cpus: num(s.cpuinfo?.cpus),
    load: (s.loadavg || []).slice(0, 3).map(num),
    iowait: num(s.wait),
    uptime: num(s.uptime),
    mem: { total: num(mem.total), used: num(mem.used), available: num(mem.available) },
    swap: { total: num(s.swap?.total), used: num(s.swap?.used) },
    rootfs: { total: num(s.rootfs?.total), used: num(s.rootfs?.used), avail: num(s.rootfs?.avail) },
  }
}

// share of memory actually used: total − available (cache does not count)
export function memPct(n) {
  const { total, used, available } = n.mem
  if (!total) return null
  return ((total - (available ?? total - used)) / total) * 100
}

// /disks/smart: NVMe as text (smartctl), SATA as attributes
export function parseSmart(s) {
  const out = { temp: null, powerOnHours: null, percentUsed: null, mediaErrors: null, reallocated: null, pending: null, uncorrectable: null, criticalWarning: null }
  if (s?.type === 'text' && s.text) {
    const field = re => {
      const m = s.text.match(re)
      return m ? m[1] : null
    }
    out.temp = int(field(/^Temperature:\s+(\d+)/m))
    out.powerOnHours = int(field(/^Power On Hours:\s+([\d,]+)/m))
    out.percentUsed = int(field(/^Percentage Used:\s+(\d+)%/m))
    out.mediaErrors = int(field(/^Media and Data Integrity Errors:\s+([\d,]+)/m))
    const cw = field(/^Critical Warning:\s+(0x[0-9a-f]+)/mi)
    out.criticalWarning = cw ? parseInt(cw, 16) : null
  }
  for (const a of s?.attributes || []) {
    const id = int(a.id)
    const raw = int(a.raw)
    if (id === 194 || (out.temp == null && /^Temperature_Cel/i.test(a.name))) out.temp = raw
    else if (id === 9) out.powerOnHours = raw
    else if (id === 5) out.reallocated = raw
    else if (id === 197) out.pending = raw
    else if (id === 187 || id === 198) out.uncorrectable = (out.uncorrectable ?? 0) + (raw ?? 0)
  }
  return out
}

// /disks/list: wearout = remaining life in % ("N/A" for a hard disk)
export function diskView(node, d, smart) {
  return {
    node, devpath: d.devpath, type: d.type ?? null, model: d.model ? String(d.model).replace(/_/g, ' ').trim() : null,
    size: num(d.size), health: d.health ?? null, used: d.used ?? null,
    wearout: num(d.wearout),
    ...(smart?.error ? { smartError: smart.error } : parseSmart(smart)),
  }
}

export const smartOk = h => h == null || /^(PASSED|OK)$/i.test(h)

// /cluster/backup → readable jobs; vmid and exclude are lists "100,101"
const ids = v => (v == null || v === '' ? [] : String(v).split(',').map(x => Number(x.trim())).filter(Number.isFinite))
export function backupJob(j) {
  return {
    id: j.id, enabled: j.enabled !== 0 && j.enabled !== '0',
    schedule: j.schedule ?? j.starttime ?? null, nextRun: num(j['next-run']),
    storage: j.storage ?? null, node: j.node ?? null, mode: j.mode ?? null,
    all: !!Number(j.all ?? 0), vmid: ids(j.vmid), exclude: ids(j.exclude), pool: j.pool ?? null,
    comment: j.comment ?? null,
  }
}

// is a guest covered by an active job? (pool: unknown without /pools → null)
export function coverage(jobs, guest) {
  let unknown = false
  for (const j of jobs) {
    if (!j.enabled || (j.node && j.node !== guest.node)) continue
    if (j.pool) {
      unknown = true
      continue
    }
    if (j.all ? !j.exclude.includes(guest.vmid) : j.vmid.includes(guest.vmid)) return { covered: true, job: j.id }
  }
  if (unknown) return { covered: null }
  const excluded = jobs.some(j => j.enabled && j.all && j.exclude.includes(guest.vmid))
  return { covered: false, excluded }
}

// log of a vzdump task → result per guest
export function runsFromLog(lines) {
  const out = new Map()
  for (const line of lines) {
    const ok = line.match(/Finished Backup of VM (\d+)/)
    const ko = line.match(/ERROR: Backup of VM (\d+) failed/)
    const m = ok || ko
    if (m) out.set(Number(m[1]), !!ok)
  }
  return out
}

// content of a backup storage: volumes whose guest no longer exists
export function orphans(content, guestIds) {
  const by = new Map()
  for (const b of content) {
    if (b.vmid == null || guestIds.has(Number(b.vmid))) continue
    const vmid = Number(b.vmid)
    const cur = by.get(vmid) || { vmid, count: 0, size: 0, last: 0, first: Infinity, name: null, type: b.subtype ?? null }
    cur.count++
    cur.size += num(b.size) ?? 0
    if ((b.ctime || 0) > cur.last) {
      cur.last = b.ctime
      cur.name = b.notes ? String(b.notes).split('\n')[0].slice(0, 60) : cur.name
    }
    cur.first = Math.min(cur.first, b.ctime || Infinity)
    by.set(vmid, cur)
  }
  return [...by.values()].map(o => ({ ...o, first: Number.isFinite(o.first) ? o.first : null })).sort((a, b) => a.vmid - b.vmid)
}

// failed tasks: "WARNINGS: n" is only a warning
export function taskView(t) {
  return {
    type: t.type, id: t.id || null, node: t.node, user: t.user ?? null,
    start: num(t.starttime), end: num(t.endtime),
    status: String(t.status || '').slice(0, 200),
    level: /^WARNINGS/.test(t.status || '') ? 'warn' : 'error',
  }
}

// PVE notifications: targets and routing rules (no secret)
export function notificationsView(targets, matchers) {
  return {
    targets: (targets || []).map(t => ({ name: t.name, type: t.type, origin: t.origin ?? null, disabled: !!t.disable })),
    matchers: (matchers || []).map(m => ({ name: m.name, targets: [].concat(m.target || []), origin: m.origin ?? null, disabled: !!m.disable, mode: m.mode ?? null })),
  }
}

// reduces an RRD series to ~max points (average per bucket)
export function downsample(pts, keys, max = 144) {
  const step = Math.max(1, Math.ceil(pts.length / max))
  const out = []
  for (let i = 0; i < pts.length; i += step) {
    const g = pts.slice(i, i + step)
    const row = { t: g[0].t }
    for (const k of keys) {
      const v = g.map(p => p[k]).filter(x => x != null)
      row[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null
    }
    out.push(row)
  }
  return out
}
