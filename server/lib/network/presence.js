// Device presence. Pure functions.
//
// Without an active probe (or with a silent one), we only talk about freshness: computed on
// read, never stored. With the ARP probe, reliable presence: only presence observations in
// the probe's sense (arp, neigh REACHABLE, self) count (last_present); neither Pi-hole's
// lastSeen, nor a STALE neigh entry, nor DNS.
//
// Asymmetric hysteresis: a device goes online on a single answer, offline only after a
// prolonged (profile delay) AND verified absence (at least minMissedScans successful sweeps
// since the last answer). Silent probe: nothing moves.
const MIN = 60_000
const DAY = 86400_000
const HOUR = 3600_000

// lastSeen: last presence observation (ms); lastDhcp: expiry of the last lease
// → 'active' (seen less than activeMin ago), 'dhcp' (only a current lease),
//   'stale' (nothing for staleDays), otherwise 'idle' (seen longer ago)
// activeMin comes from the config (network.activeMin, schema default); staleDays is not configurable
export const STALE_DAYS = 30
export function freshnessOf({ lastSeen = null, lastDhcp = null, now = Date.now(), activeMin, staleDays = STALE_DAYS }) {
  if (lastSeen != null && now - lastSeen < activeMin * MIN) return 'active'
  if (lastDhcp != null && lastDhcp > now) return 'dhcp'
  if (lastSeen == null || now - lastSeen >= staleDays * DAY) return 'stale'
  return 'idle'
}

// delay without answer before "offline", depending on the profile (fixed | normal | sleepy)
// presence: network.presence of the validated config (schema defaults)
export function graceMs(profile, presence) {
  const min = { fixed: presence.fixedMin, normal: presence.normalMin, sleepy: presence.sleepyMin }
  return (min[profile] ?? min.normal) * MIN
}

// start of the absence delay: the last answer, but never before the first successful sweep;
// a device never seen by the probe thus gets its profile delay counted from presenceSince
// (no global window)
export const absentSince = (lastPresent, presenceSince) => Math.max(lastPresent ?? -Infinity, presenceSince ?? -Infinity)

// lastPresent: last answer (arp, neigh REACHABLE, self), or null
// presenceSince: first successful sweep; prevScanTs: timestamp of the previous sweep (a later
// answer = online); refRunsSince: successful sweeps since absentSince(lastPresent,
// presenceSince); refStale: silent probe; prev: 1, 0 or null
// → { online: 1 | 0 | null, idle, changed }; idle: online but no answer in the last sweep
export function presenceOf({ lastPresent = null, presenceSince = null, profile, refRunsSince = 0, refStale = false, prev = null, now = Date.now(), cfg, prevScanTs = null }) {
  const fresh = lastPresent != null && prevScanTs != null && lastPresent > prevScanTs
  const keep = online => ({ online, idle: online === 1 && !fresh, changed: online !== prev })
  if (refStale) return keep(prev)
  if (fresh) return keep(1)
  const age = now - absentSince(lastPresent, presenceSince)
  if (age > graceMs(profile, cfg) && refRunsSince >= cfg.minMissedScans) return keep(0)
  return keep(prev)
}

// Sessions (net_sessions): opened, dated on the first answer, closed on the last one (not on
// the detection time), reopening of a session closed less than the delay ago (late source).
// session: last session of the device (end null = in progress); online: state computed by
// presenceOf. A session is only closed if it is open: a null → 0 transition closes none.
export function sessionOps({ device, session, lastPresent, online, ip = null, now = Date.now(), graceMs: grace = 10 * MIN }) {
  const open = session && session.end == null
  if (online === 1) {
    if (open) return []
    const start = lastPresent ?? now
    if (session && session.end != null && start - session.end < grace) return [{ op: 'reopenSession', id: session.id, device }]
    return [{ op: 'openSession', device, start, ip }]
  }
  if (online === 0 && open) return [{ op: 'closeSession', id: session.id, device, end: Math.max(session.start, lastPresent ?? session.start) }]
  return []
}

// hourly rollup (net_presence_1h): one more successful sweep for each device whose state is
// known, and one presence if it is online
export function rollupOps(devices, runAt) {
  const hour = Math.floor(runAt / HOUR) * HOUR
  return devices.filter(d => d.online === 1 || d.online === 0)
    .map(d => ({ op: 'rollup', device: d.id, hour, seen: d.online === 1 ? 1 : 0 }))
}

// uptime band cell: '-' no sweep, 'o' always there, 'w' partly, 'c' absent
export const cellOf = (scans, seen) => (!scans ? '-' : seen >= scans ? 'o' : seen > 0 ? 'w' : 'c')
