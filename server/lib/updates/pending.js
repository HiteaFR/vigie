// Dating of pending security fixes under automatic updates. The agent report has no
// per-package age: the first observation per host and per package is kept in the
// database (apt_security_pending table), so that a restart of the service does not reset
// the ages. Rules read from an in-memory cache, loaded at creation; only observe()
// writes.
//
// Observation, on every NEW slow report of a host (slowAt changed):
//  - automatic updates active (v7, installed, enabled and securityOnly true) and apt present: each
//    pending fix (suite "-security", not held by apt-mark hold) missing from the table
//    is inserted with first_seen = report timestamp (capped at now); a fix already
//    present only updates last_seen and the version (first_seen unchanged, even if the
//    candidate version changes); a line of the host missing from the report is deleted;
//  - automatic updates not active (v6, autoUpdate null, disabled, not limited to security): all
//    lines of the host are deleted (age only counts under automatic updates);
//  - report unchanged, missing, or without apt: nothing is touched (the ages keep running).
// Hosts removed from the config: lines deleted at creation and on every observation.

export const isSecurityPending = p => !!p && !p.held && /-security/.test(String(p.suite ?? ''))
export const autoActive = slow => !!(slow && slow.version >= 7 && slow.autoUpdate?.installed && slow.autoUpdate.enabled && slow.autoUpdate.securityOnly)

export function createSecurityPending({ db, hostIds = [] }) {
  const q = {
    all: db.prepare('SELECT host, name, version, first_seen, last_seen FROM apt_security_pending'),
    insert: db.prepare('INSERT INTO apt_security_pending (host, name, version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE apt_security_pending SET version = ?, last_seen = ? WHERE host = ? AND name = ?'),
    del: db.prepare('DELETE FROM apt_security_pending WHERE host = ? AND name = ?'),
    delHost: db.prepare('DELETE FROM apt_security_pending WHERE host = ?'),
  }
  const known = new Set(hostIds)
  // cache: host → Map(name → { name, version, since, lastSeen })
  const cache = new Map()
  for (const r of q.all.all()) {
    if (!known.has(r.host)) { q.del.run(r.host, r.name); continue }
    if (!cache.has(r.host)) cache.set(r.host, new Map())
    cache.get(r.host).set(r.name, { name: r.name, version: r.version, since: r.first_seen, lastSeen: r.last_seen })
  }
  const seenSlowAt = new Map()

  function dropHost(host) {
    if (!cache.get(host)?.size) { cache.delete(host); return }
    q.delHost.run(host)
    cache.delete(host)
  }

  // agents: { hosts, get(id) → { slow, slowAt } } (agents module)
  function observe(agents, now = Date.now()) {
    for (const host of [...cache.keys()]) if (!known.has(host)) dropHost(host)
    for (const h of agents?.hosts || []) {
      if (!known.has(h.id)) continue
      const st = agents.get(h.id)
      const slow = st?.slow
      if (!slow || st.slowAt == null || seenSlowAt.get(h.id) === st.slowAt) continue
      seenSlowAt.set(h.id, st.slowAt)
      if (!autoActive(slow)) { dropHost(h.id); continue }
      if (!slow.apt) continue
      const at = Math.min(Number.isFinite(slow.ts) ? slow.ts * 1000 : now, now)
      const list = new Map()
      for (const p of slow.apt.packages || []) if (isSecurityPending(p) && p.name) list.set(p.name, p)
      const cur = cache.get(h.id) ?? new Map()
      db.exec('BEGIN')
      try {
        for (const [name, p] of list) {
          const row = cur.get(name)
          if (row) {
            if (row.version !== p.version || row.lastSeen !== at) q.touch.run(p.version ?? null, at, h.id, name)
            row.version = p.version ?? null
            row.lastSeen = at
          } else {
            q.insert.run(h.id, name, p.version ?? null, at, at)
            cur.set(name, { name, version: p.version ?? null, since: at, lastSeen: at })
          }
        }
        for (const name of [...cur.keys()]) if (!list.has(name)) { q.del.run(h.id, name); cur.delete(name) }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      if (cur.size) cache.set(h.id, cur)
      else cache.delete(h.id)
    }
  }

  // pending fixes of a host, oldest to newest: [{ name, version, since }]
  function get(host) {
    return [...(cache.get(host)?.values() ?? [])].map(({ name, version, since }) => ({ name, version, since })).sort((a, b) => a.since - b.since || a.name.localeCompare(b.name))
  }

  return { observe, get }
}
