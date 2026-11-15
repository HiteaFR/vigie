// Memory of agent v8 in the database, for the posture_regression and port_new rules.
// Same model as updates/pending.js: additive tables, in-memory cache loaded at
// creation, observation at each NEW slow v8 report of a host (slowAt changed); an
// unchanged, missing, v7 or v6 report, or a null field, touches nothing. The rules only read.
// Hosts removed from the config: rows purged at creation and at each observation.
//
// Posture (table host_posture, per host and per criterion):
//  - first_ok / last_ok: the criterion was seen COMPLIANT by a v8 report ("already seen
//    compliant" memory); a gap present from the first v8 report has no first_ok: displayed, without
//    alert (no avalanche at deployment);
//  - accepted_*: gap accepted by an admin (reason, audit): displayed "accepted", without alert;
//    the acceptance drops as soon as the criterion becomes compliant again (memory resumes: a
//    later regression alerts again).
// Ports (table host_ports, per host, protocol and port, whatever the address): only NON-local
// ports (at least one address outside 127.0.0.0/8 and ::1); first v8 report of a host:
// all known (bootstrap); new port: known_at null until "Known"; closed: closed_at;
// reopened within REOPEN_DAYS: reopened silently; beyond: new (like a deleted network record
// that comes back); row closed for more than REOPEN_DAYS: purged.
// Automatic updates seen active since (kv AUTO_KEY, one entry per host): date of the
// first observation of a slow report where autoActive is true (v7 or later); cleared as soon as a
// report shows them inactive (off, not limited to security, agent < v7), so that a
// reinstallation starts from scratch. Read by autoupdate_failed ("no run recorded").

import { autoActive } from './updates/pending.js'
import { t as tr } from './i18n.js'
import { KNOWN_BY_BOOTSTRAP, knownBy } from './codes.js'

export const REOPEN_DAYS = 7
const DAY = 86400_000
export const CRITERIA = ['ssh_root', 'ssh_password', 'firewall']
// author of a port known by default at the first report (host_ports.known_by): code of
// lib/codes.js; the client gets a boolean (known.bootstrap), the former value is read through knownBy
export { KNOWN_BY_BOOTSTRAP }
// label of a posture criterion: catalog (posture.<criterion>), read at each access
export const CRITERION_LABEL = Object.freeze(Object.defineProperties({}, Object.fromEntries(['ssh_root', 'ssh_password', 'firewall'].map(c => [c, { enumerable: true, get: () => tr(`posture.${c}`) }]))))
const ROOT_OK = new Set(['no', 'prohibit-password', 'forced-commands-only'])
const BOOT_KEY = 'agentmemory.portsBootstrapped'
export const AUTO_KEY = 'agentmemory.autoActiveSince'

// criterion → true (compliant), false (gap), null (unknown)
export function postureOf(posture) {
  const ssh = posture?.ssh ?? null
  const fw = posture?.firewall ?? null
  return {
    ssh_root: ssh?.permitRootLogin == null ? null : ROOT_OK.has(ssh.permitRootLogin),
    ssh_password: ssh?.passwordAuth == null ? null : !ssh.passwordAuth,
    firewall: fw == null ? null : fw.type !== 'none' && fw.active === true,
  }
}

// loopback: 127.0.0.0/8, ::1, and mapped IPv4 ::ffff:127.0.0.0/104
const LOCAL = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?|\[?::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}\]?)$/i
export const isLocalAddr = addr => LOCAL.test(String(addr))
// Tailscale peerapi: tailscaled listens in TCP on its tailnet addresses only (100.64.0.0/10,
// fd7a:115c:a1e0::/48), on a port drawn at random at each start; it would raise a new port_new
// after every restart. Such a listen is shown and never alerts, like loopback; the same port on any
// other address, or another process on a tailnet address, still counts
const TAILNET = /^\[?(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|fd7a:115c:a1e0:[0-9a-f:]*)\]?$/i
export const isTailscalePeerapi = p => p.proto === 'tcp' && p.process === 'tailscaled' && TAILNET.test(String(p.addr))
// non-local ports of the report: Map 'tcp/22' → { proto, port, addrs, processes }
export function exposedPorts(listening) {
  const out = new Map()
  for (const p of listening || []) {
    const k = `${p.proto}/${p.port}`
    const e = out.get(k) ?? { proto: p.proto, port: p.port, addrs: [], processes: [], exposed: false }
    if (!e.addrs.includes(p.addr)) e.addrs.push(p.addr)
    if (p.process && !e.processes.includes(p.process)) e.processes.push(p.process)
    if (!isLocalAddr(p.addr) && !isTailscalePeerapi(p)) e.exposed = true
    out.set(k, e)
  }
  return new Map([...out].filter(([, e]) => e.exposed))
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })
const reasonOf = reason => {
  const r = String(reason ?? '').trim()
  if (r.length < 3 || r.length > 200) throw bad(tr('api.reason_required'))
  return r
}

export function createAgentMemory({ db, kv, hostIds = [] }) {
  const q = {
    postureAll: db.prepare('SELECT * FROM host_posture'),
    postureUpsertOk: db.prepare(`INSERT INTO host_posture (host, criterion, first_ok, last_ok) VALUES (?, ?, ?, ?)
      ON CONFLICT(host, criterion) DO UPDATE SET first_ok = COALESCE(first_ok, excluded.first_ok), last_ok = excluded.last_ok,
        accepted_at = NULL, accepted_by = NULL, accepted_reason = NULL`),
    postureAccept: db.prepare(`INSERT INTO host_posture (host, criterion, accepted_at, accepted_by, accepted_reason) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(host, criterion) DO UPDATE SET accepted_at = excluded.accepted_at, accepted_by = excluded.accepted_by, accepted_reason = excluded.accepted_reason`),
    postureUnaccept: db.prepare('UPDATE host_posture SET accepted_at = NULL, accepted_by = NULL, accepted_reason = NULL WHERE host = ? AND criterion = ?'),
    postureDelHost: db.prepare('DELETE FROM host_posture WHERE host = ?'),
    portsAll: db.prepare('SELECT * FROM host_ports'),
    portInsert: db.prepare(`INSERT INTO host_ports (host, proto, port, first_seen, last_seen, closed_at, known_at, known_by, known_reason)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(host, proto, port) DO UPDATE SET first_seen = excluded.first_seen, last_seen = excluded.last_seen, closed_at = NULL,
        known_at = excluded.known_at, known_by = excluded.known_by, known_reason = excluded.known_reason`),
    portSeen: db.prepare('UPDATE host_ports SET last_seen = ?, closed_at = NULL WHERE host = ? AND proto = ? AND port = ?'),
    portClose: db.prepare('UPDATE host_ports SET closed_at = ? WHERE host = ? AND proto = ? AND port = ?'),
    portKnown: db.prepare('UPDATE host_ports SET known_at = ?, known_by = ?, known_reason = ? WHERE host = ? AND proto = ? AND port = ?'),
    portDel: db.prepare('DELETE FROM host_ports WHERE host = ? AND proto = ? AND port = ?'),
    portsDelHost: db.prepare('DELETE FROM host_ports WHERE host = ?'),
  }
  const known = new Set(hostIds)
  const posture = new Map() // host → Map(criterion → row)
  const ports = new Map() // host → Map('tcp/22' → row)
  const boot = new Set((() => { try { return JSON.parse(kv.get(BOOT_KEY) || '[]') } catch { return [] } })())
  const saveBoot = () => kv.set(BOOT_KEY, JSON.stringify([...boot].sort()))
  // host → ms; unreadable or non-numeric value: ignored
  const autoSince = new Map((() => {
    try {
      const v = JSON.parse(kv.get(AUTO_KEY) || '{}')
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).filter(([, t]) => Number.isFinite(t)) : []
    } catch { return [] }
  })())
  const saveAuto = () => kv.set(AUTO_KEY, JSON.stringify(Object.fromEntries([...autoSince].sort(([a], [b]) => a.localeCompare(b)))))
  const sub = (m, host) => { if (!m.has(host)) m.set(host, new Map()); return m.get(host) }

  for (const r of q.postureAll.all()) {
    if (known.has(r.host)) sub(posture, r.host).set(r.criterion, r)
  }
  for (const r of q.portsAll.all()) {
    if (known.has(r.host)) sub(ports, r.host).set(`${r.proto}/${r.port}`, r)
  }
  function purgeUnknown() {
    for (const h of new Set([...posture.keys(), ...ports.keys(), ...boot, ...autoSince.keys()])) {
      if (known.has(h)) continue
      q.postureDelHost.run(h)
      q.portsDelHost.run(h)
      posture.delete(h)
      ports.delete(h)
      boot.delete(h)
      autoSince.delete(h)
    }
    // posture of a host never bootstrapped (posture without a port list): absent from the cache and the bootstrap
    for (const r of q.postureAll.all()) if (!known.has(r.host)) q.postureDelHost.run(r.host)
    saveBoot()
    saveAuto()
  }
  purgeUnknown()

  const seenSlowAt = new Map()
  function tx(fn) {
    db.exec('BEGIN')
    try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
  }

  function observePosture(host, p, at) {
    const crit = postureOf(p)
    const m = sub(posture, host)
    for (const c of CRITERIA) {
      if (crit[c] !== true) continue // gap or unknown: the memory does not move
      q.postureUpsertOk.run(host, c, at, at)
      const row = m.get(c) ?? { host, criterion: c, first_ok: null }
      m.set(c, { ...row, first_ok: row.first_ok ?? at, last_ok: at, accepted_at: null, accepted_by: null, accepted_reason: null })
    }
  }

  function observePorts(host, listening, at, now) {
    const cur = exposedPorts(listening)
    const m = sub(ports, host)
    if (!boot.has(host)) {
      // first v8 report of the host: everything already listening is known, no alert
      for (const [k, e] of cur) {
        q.portInsert.run(host, e.proto, e.port, at, at, at, KNOWN_BY_BOOTSTRAP, null)
        m.set(k, { host, proto: e.proto, port: e.port, first_seen: at, last_seen: at, closed_at: null, known_at: at, known_by: KNOWN_BY_BOOTSTRAP, known_reason: null })
      }
      boot.add(host)
      saveBoot()
      return
    }
    for (const [k, e] of cur) {
      const row = m.get(k)
      if (row && (row.closed_at == null || now - row.closed_at <= REOPEN_DAYS * DAY)) {
        q.portSeen.run(at, host, e.proto, e.port)
        m.set(k, { ...row, last_seen: at, closed_at: null })
      } else {
        // never seen, or closed for more than REOPEN_DAYS: new
        q.portInsert.run(host, e.proto, e.port, at, at, null, null, null)
        m.set(k, { host, proto: e.proto, port: e.port, first_seen: at, last_seen: at, closed_at: null, known_at: null, known_by: null, known_reason: null })
      }
    }
    for (const [k, row] of [...m]) {
      if (cur.has(k)) continue
      if (row.closed_at == null) {
        q.portClose.run(now, host, row.proto, row.port)
        m.set(k, { ...row, closed_at: now })
      } else if (now - row.closed_at > REOPEN_DAYS * DAY) {
        q.portDel.run(host, row.proto, row.port)
        m.delete(k)
      }
    }
  }

  // first sighting of active automatic updates; inactive: cleared
  function observeAuto(host, slow, now) {
    const active = autoActive(slow)
    if (active === autoSince.has(host)) return
    if (active) autoSince.set(host, now)
    else autoSince.delete(host)
    saveAuto()
  }

  // agents: { hosts, get(id) → { slow, slowAt } }
  function observe(agents, now = Date.now()) {
    for (const h of agents?.hosts || []) {
      if (!known.has(h.id)) continue
      const st = agents.get(h.id)
      const slow = st?.slow
      if (!slow || st.slowAt == null || seenSlowAt.get(h.id) === st.slowAt) continue
      seenSlowAt.set(h.id, st.slowAt)
      observeAuto(h.id, slow, now)
      if (!(slow.version >= 8)) continue
      const at = Math.min(Number.isFinite(slow.ts) ? slow.ts * 1000 : now, now)
      tx(() => {
        if (slow.posture) observePosture(h.id, slow.posture, at)
        if (Array.isArray(slow.listening)) observePorts(h.id, slow.listening, at, now)
      })
    }
  }

  // --- reading ---------------------------------------------------------------------------------
  const postureRow = (host, c) => posture.get(host)?.get(c) ?? null
  const portRow = (host, proto, port) => ports.get(host)?.get(`${proto}/${port}`) ?? null
  const bootstrapped = host => boot.has(host)
  // rows of the host not yet "Known" (open, or closed for less than
  // REOPEN_DAYS, since the purge removes the others): candidates for closing port_new
  const unknownPorts = host => [...(ports.get(host)?.values() ?? [])].filter(r => r.known_at == null)
  const autoActiveSince = host => autoSince.get(host) ?? null

  // display state: criterion → { state: ok | gap | accepted | unknown, value, seenOk, accepted }
  function postureView(host, p) {
    const crit = postureOf(p)
    return Object.fromEntries(CRITERIA.map(c => {
      const row = postureRow(host, c)
      const accepted = row?.accepted_at ? { at: row.accepted_at, by: row.accepted_by, reason: row.accepted_reason } : null
      const state = crit[c] == null ? 'unknown' : crit[c] ? 'ok' : accepted ? 'accepted' : 'gap'
      return [c, { state, seenOk: row?.first_ok ?? null, regression: state === 'gap' && row?.first_ok != null, accepted }]
    }))
  }
  // ports of the report (all, local included): status local | known | new
  function portsView(host, listening) {
    const exp = exposedPorts(listening)
    const all = new Map()
    for (const p of listening || []) {
      const k = `${p.proto}/${p.port}`
      const e = all.get(k) ?? { proto: p.proto, port: p.port, addrs: [], processes: [] }
      if (!e.addrs.includes(p.addr)) e.addrs.push(p.addr)
      if (p.process && !e.processes.includes(p.process)) e.processes.push(p.process)
      all.set(k, e)
    }
    return [...all.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto)).map(e => {
      const row = portRow(host, e.proto, e.port)
      const status = !exp.has(`${e.proto}/${e.port}`) ? 'local' : row?.known_at != null ? 'known' : bootstrapped(host) ? 'new' : 'known'
      return { ...e, status, firstSeen: row?.first_seen ?? null, known: row?.known_at != null ? { at: row.known_at, by: knownBy(row.known_by), reason: row.known_reason, bootstrap: knownBy(row.known_by) === KNOWN_BY_BOOTSTRAP } : null }
    })
  }

  // --- admin actions (reason required; the audit is written by the route) ---------------------
  function accept(host, criterion, reason, by, current, now = Date.now()) {
    if (!known.has(host)) throw bad(tr('api.unknown_host'), 404)
    if (!CRITERIA.includes(criterion)) throw bad(tr('api.posture.unknown_criterion'), 400)
    const r = reasonOf(reason)
    const v = postureOf(current)[criterion]
    if (v !== false) throw bad(v === true ? tr('api.posture.compliant') : tr('api.posture.unknown_for_host'), 409)
    q.postureAccept.run(host, criterion, now, by, r)
    const row = postureRow(host, criterion) ?? { host, criterion, first_ok: null, last_ok: null }
    sub(posture, host).set(criterion, { ...row, accepted_at: now, accepted_by: by, accepted_reason: r })
    return { host, criterion, accepted: { at: now, by, reason: r } }
  }
  function unaccept(host, criterion, reason, by) {
    if (!known.has(host)) throw bad(tr('api.unknown_host'), 404)
    if (!CRITERIA.includes(criterion)) throw bad(tr('api.posture.unknown_criterion'), 400)
    reasonOf(reason)
    const row = postureRow(host, criterion)
    if (!row?.accepted_at) throw bad(tr('api.posture.no_acceptance'), 409)
    q.postureUnaccept.run(host, criterion)
    sub(posture, host).set(criterion, { ...row, accepted_at: null, accepted_by: null, accepted_reason: null })
    return { host, criterion, accepted: null, by }
  }
  function portKnown(host, proto, port, reason, by, now = Date.now()) {
    if (!known.has(host)) throw bad(tr('api.unknown_host'), 404)
    if (proto !== 'tcp' && proto !== 'udp') throw bad(tr('api.port.bad_proto'), 400)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad(tr('api.port.bad_port'), 400)
    const r = reasonOf(reason)
    const row = portRow(host, proto, port)
    if (!row || row.closed_at != null) throw bad(tr('api.port.unknown'), 404)
    if (row.known_at != null) throw bad(tr('api.port.known'), 409)
    q.portKnown.run(now, by, r, host, proto, port)
    sub(ports, host).set(`${proto}/${port}`, { ...row, known_at: now, known_by: by, known_reason: r })
    return { host, proto, port, known: { at: now, by, reason: r } }
  }

  return { observe, postureRow, portRow, bootstrapped, unknownPorts, autoActiveSince, postureView, portsView, accept, unaccept, portKnown }
}

// /api/agents view extended with v8 = { known, restricted, posture, ports } for hosts
// with an agent. Posture and listening ports (and slow.posture, slow.listening) ONLY with an admin
// session, like the ports of the Network module: "this host accepts root by password" is
// reconnaissance information. Without a session: neither of them, not even a summary
// (restricted). posture_regression alerts remain readable in /api/alerts.
export function agentsView(hosts, memory, { admin = false } = {}) {
  return hosts.map(h => {
    if (!h.agent) return h
    const v8 = h.slow?.version >= 8
    const slow = h.slow && !admin ? { ...h.slow, posture: null, listening: null } : h.slow
    return { ...h, slow, v8: {
      known: v8,
      restricted: !admin,
      posture: v8 && admin && h.slow.posture ? memory.postureView(h.id, h.slow.posture) : null,
      ports: v8 && admin && Array.isArray(h.slow.listening) ? memory.portsView(h.id, h.slow.listening) : null,
    } }
  })
}
