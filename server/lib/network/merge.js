// Merging of observations. Pure functions: mergeSightings reads a snapshot of the state
// and returns the list of writes to perform (ops) and the events, then applied by
// store.applyOps in a single transaction.
//
// Principles: the MAC is the identity key (a MAC belongs to only one device); what is
// entered by hand (name, type… columns of net_devices) always wins over what is
// discovered (net_attrs, one row per attribute and per source, with a rank).
import { randomBytes } from 'node:crypto'
import { normalizeMac, gradeMac, isLocal, matchPrefix } from '../net/mac.js'
import { parseCidr, inCidr } from '../net/ip.js'
import { PVE_PERIOD_MS } from './sources/pve.js'
import { whyDetail, returnedDetail, newDetail, macAddedDetail } from './events.js'
import { t as tr } from '../i18n.js'

// rank of the sources of a discovered attribute (manual entry is worth 10, in net_devices)
export const RANK = { config: 8, pve: 8, agent: 7, dhcp: 6, mdns: 5, pihole: 4, 'import:netalertx': 3, guess: 2, oui: 2, probe: 1 }
// sources whose observation counts as presence for freshness (the others: identity
// only); self: the dashboard's own container. 'agent' (containers) is an IDENTITY and is
// not in it; 'agent-neigh' (neighbors seen by an agent) is in it for freshness ONLY
// (FRESH_ONLY): no absence, no persistence, no creation.
// 'mdns' is not in it (identity only: a forged packet refreshes nothing)
export const PRESENCE_SOURCES = new Set(['pihole', 'neigh', 'arp', 'agent-neigh', 'self'])
const FRESH_ONLY = new Set(['agent-neigh'])

// Persisted record → container associations ("container" attribute from the agent source,
// value "host/container/network"); an identity never has two records: the most recent view
// wins. → { byKey: Map key → id, byDevice: Map id → { host, name, network, key } }
// SHARED predicate (forbidden() here, isIdentity in writes.js): a MAC whose hypervisor
// grade comes ONLY from the agent (mac|agent view, no pve or config view) is not an
// identity; seen: Map "mac|source" → view
export const agentOnly = (m, seen) => !!seen && m.grade === 'hypervisor' && seen.has(`${m.mac}|agent`) && !seen.has(`${m.mac}|pve`) && !seen.has(`${m.mac}|config`)

export function containerAssociations(attrs) {
  const best = new Map() // key → { device, at }
  for (const [device, list] of attrs || []) {
    for (const a of list || []) {
      if (a.attr !== 'container' || a.source !== 'agent' || typeof a.value !== 'string') continue
      const cur = best.get(a.value)
      if (!cur || a.seen_at > cur.at) best.set(a.value, { device, at: a.seen_at })
    }
  }
  const byKey = new Map()
  const byDevice = new Map()
  for (const [key, { device, at }] of best) {
    const [host, name, ...rest] = key.split('/')
    const network = rest.join('/')
    if (!host || !name || !network) continue
    byKey.set(key, device)
    const cur = byDevice.get(device)
    if (!cur || at > cur.at) byDevice.set(device, { host, name, network, key, at })
  }
  return { byKey, byDevice }
}
// presence in the probe's sense: an answer required now; neigh only counts when
// REACHABLE (its view is only written on presence: true). Neither Pi-hole
// (ips[].lastSeen moves forward for STALE entries), nor DNS, nor a lease
export const ARP_PRESENCE_SOURCES = new Set(['arp', 'neigh', 'self'])
const GRADE_RANK = { weak: 0, strong: 1, hypervisor: 2 }
const MIN_MS = 60_000
const ABSENT_MS = 10 * 60_000 // "absent" MAC: a new MAC may be attached in its place
const STABLE_MS = 7 * 86400_000 // IP held longer than this: its change is an event
export const THROTTLE_MS = 10 * 60_000 // rewrite of an identity view with an unchanged address
// an identity is "still reported" by Proxmox if its pve view is less than IDENTITY_WINDOW_MS
// older than the last SUCCESSFUL poll: the view is rewritten at most every THROTTLE_MS, plus
// two periods of the pve source (PVE_PERIOD_MS, single shared constant), i.e. 30 min
export const IDENTITY_WINDOW_MS = THROTTLE_MS + 2 * PVE_PERIOD_MS

// last presence of a MAC (presence sources, excluding agent neighbors) and last presence
// in the probe's sense (arp, neigh REACHABLE, self); seen: Map "mac|source" → view
function lastPresenceOf(seen, mac) {
  let t = null
  for (const src of PRESENCE_SOURCES) {
    if (FRESH_ONLY.has(src)) continue // agent neighbors: freshness only, never absence
    const r = seen?.get(`${mac}|${src}`)
    if (r && (t == null || r.last_seen > t)) t = r.last_seen
  }
  return t
}
function lastArpOf(seen, mac) {
  let t = null
  for (const src of ARP_PRESENCE_SOURCES) {
    const r = seen?.get(`${mac}|${src}`)
    if (r && (t == null || r.last_seen > t)) t = r.last_seen
  }
  return t
}
// end of the life period of a known MAC, mode by mode, for disjoint() and the suggestions:
// probe (probe ≠ 'off') → its presence only (a stale Pi-hole view extends nothing),
// otherwise first_seen; without the probe: last_seen, or the presence excluding agent
// neighbors when the MAC has an agent-neigh view
export function lifeEndOf(m, seen, arpMode) {
  if (arpMode) return lastArpOf(seen, m.mac) ?? m.first_seen
  return seen?.has(`${m.mac}|agent-neigh`) ? lastPresenceOf(seen, m.mac) ?? m.first_seen : m.last_seen
}

// identity MAC in the static sense: hypervisor grade outside agentOnly, or attach pve/config
export const isIdentityMac = (m, seen) => (m.grade === 'hypervisor' && !agentOnly(m, seen)) || m.attach === 'pve' || m.attach === 'config'

// Is an identity still reported? Pure; called ONLY by deletionBlock (writes.js).
// → null (not an identity), 'live' (current config, or recent pve view at the last
// successful poll), 'unknown' (pve source in error, stale or partial: no conclusion)
// or 'gone'. health.pve: { ok, stale, partial, lastOkAt }, or null without a pve
// source (nothing can then report it through Proxmox)
export function liveIdentity(m, { seen, cfg, health } = {}) {
  if (!isIdentityMac(m, seen)) return null
  if ((cfg?.hosts ?? []).some(h => h.mac && normalizeMac(h.mac) === m.mac)) return 'live'
  const pve = health?.pve
  if (pve == null) return 'gone'
  const v = seen?.get(`${m.mac}|pve`)
  if (v && pve.lastOkAt != null && v.last_seen >= pve.lastOkAt - IDENTITY_WINDOW_MS) return 'live'
  if (pve.ok !== true || pve.stale || pve.partial) return 'unknown'
  return 'gone'
}
const ATTR_REFRESH_MS = 3600_000 // rewrite of an unchanged attribute
const MAX_DEVICES = 2000 // hard ceiling (MAC flooding)
const DAY = 86400_000

// --- names ----------------------------------------------------------------

// domain suffixes removed from discovered names: the usual local ones, plus network.hostSuffixes
// (for example the domain an ISP router appends to DHCP names). A process-wide setting, set by
// the network module when it starts (setHostSuffixes); default: the local suffixes only
const LOCAL_SUFFIXES = ['lan', 'local', 'home', 'localdomain']
const suffixRe = extra => new RegExp(`\\.(${[...LOCAL_SUFFIXES, ...extra.map(s => s.replace(/^\./, '').toLowerCase())].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, 'i')
let SUFFIXES = suffixRe([])
export function setHostSuffixes(list = []) {
  SUFFIXES = suffixRe(list)
}
const EMPTY = new Set(['', '*', '(name not found)', '(unknown)', 'unknown', 'null', '[]'])

// discovered name (DHCP, PTR, mDNS…): hostile data, cleaned before any use; the ONLY name
// rule, for every source. Bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F),
// U+200B and U+FEFF are removed too; U+200C (ZWNJ) and U+200D (ZWJ) are kept
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
export function cleanName(s) {
  if (s == null) return null
  let v = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(INVISIBLE, '').trim().replace(/\.$/, '')
  for (let i = 0; i < 3 && SUFFIXES.test(v); i++) v = v.replace(SUFFIXES, '')
  v = v.trim().slice(0, 64)
  return EMPTY.has(v.toLowerCase()) ? null : v
}

// raw discovered text (full DNS name, vendor): control characters removed, trailing dot
// removed, 253 characters at most; null if empty
export function cleanText(s, max = 253) {
  if (s == null) return null
  const v = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().replace(/\.$/, '').slice(0, max)
  return v && !EMPTY.has(v.toLowerCase()) ? v : null
}

// text displayed outside the browser (Telegram): control characters removed, whatever is
// in the database (defence in depth: names are already cleaned on input); IPv4 addresses
// are masked afterwards by t() (formatter scrub)
export const plain = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

// label of a record outside the browser (alerts, digest, bot): the name; without a name,
// the vendor or "unnamed device", followed by the record number (/appareil 47, /reseau?d=47;
// the IP would be masked by t()): never a bare MAC as a name
export function deviceLabel(d) {
  if (d?.disp_name) return plain(d.disp_name)
  const what = d?.vendor ? plain(d.vendor) : tr('net.device.unnamed')
  return d?.id != null ? tr('net.device.label', { what, id: d.id }) : what
}

// DHCP name too generic to attach a random MAC to a known device
export const isGenericName = n => !n || n.length < 3
  || /^(android|esp|espressif|esp32|esp8266)([-_][0-9a-f]+)?$/i.test(n)
  || /^(docker|localhost|unknown|device|host)$/i.test(n)

// --- attributes -----------------------------------------------------------

// best discovered attribute: highest rank, then most recent. A name from the mdns source
// is ignored as soon as another name attribute exists (it only fills an empty name); the
// ordering of the other sources is unchanged
export function bestAttr(attrs, name) {
  let best = null
  const skipMdns = name === 'name' && (attrs || []).some(a => a.attr === 'name' && a.source !== 'mdns')
  for (const a of attrs || []) {
    if (a.attr !== name || (skipMdns && a.source === 'mdns')) continue
    if (!best || a.rank > best.rank || (a.rank === best.rank && a.seen_at > best.seen_at)) best = a
  }
  return best ? { value: best.value, source: best.source, rank: best.rank } : null
}

// --- guessed type and profile (discovered value, never a manual entry) ------------

// vendor, or name (whole words: "XboxOne" is not a box, a domain "…example.net" is not a
// speaker) → type and profile
const KINDS = [
  [/espressif|tuya|broadlink|shelly|sonoff|itead/i, null, 'iot', 'sleepy'],
  [/synology|qnap|western digital|asustor/i, null, 'nas', 'fixed'],
  [/microsoft|sony interactive|nintendo|valve/i, /xbox|playstation|\bps[45]\b|nintendo|steam[-_ ]?deck/i, 'console', 'normal'],
  [/sagemcom|freebox|ubiquiti/i, /(^|[-_. ])(bbox|livebox|freebox|router|routeur|gateway)([-_. ]|$)/i, 'router', 'fixed'],
  [/amazon|sonos/i, /(^|[-_. ])(echo|sonos|homepod|enceinte|speaker)([-_. ]|$)|google[-_ ]?home|nest[-_ ]?(mini|audio)/i, 'speaker', 'normal'],
]

// → { type, profile }; type null when nothing allows a guess
export function guessKind({ vendor, names = [], grade, hostKind } = {}) {
  const v = vendor || ''
  const n = names.filter(Boolean).join(' ')
  if (hostKind === 'pve-node') return { type: 'hypervisor', profile: 'fixed' }
  if (hostKind === 'vm' || hostKind === 'lxc') return { type: 'server', profile: 'fixed' }
  if (hostKind === 'appliance') return { type: /nas|synology/i.test(`${v} ${n}`) ? 'nas' : 'server', profile: 'fixed' }
  if (/cam(era)?[-_ ]|camera$/i.test(n)) return { type: 'camera', profile: 'sleepy' }
  if (/iphone|ipad|galaxy|pixel|phone|android|^s2\d/i.test(n)) {
    return { type: /ipad|tab/i.test(n) ? 'tablet' : 'phone', profile: 'sleepy' }
  }
  if (/switch|sg\d{3}|gs\d{3}/i.test(n) && /tp-link|netgear|d-link|cisco/i.test(v)) return { type: 'switch', profile: 'fixed' }
  for (const [vre, nre, type, profile] of KINDS) {
    if (vre.test(v) || (nre && nre.test(n))) return { type, profile }
  }
  if (/laptop|lapt|book/i.test(n)) return { type: 'laptop', profile: 'normal' }
  if (/desktop|pc-|-pc$/i.test(n)) return { type: 'computer', profile: 'normal' }
  if (/tv|bravia|roku|chromecast/i.test(n) || /tcl|lg electronics|hisense/i.test(v)) return { type: 'tv', profile: 'normal' }
  if (/printer|imprimante|epson|brother|canon/i.test(`${v} ${n}`)) return { type: 'printer', profile: 'normal' }
  return { type: null, profile: 'normal' }
}

// --- link with the dashboard hosts --------------------------------------------

// device: net_devices row (last_ip); macs: its MACs; guestIndex: MAC → hostId (pve);
// taken: hostId → device that carries it by its MAC (pve, config): the IP does not link it elsewhere
export function matchHost(device, macs, { cfg, guestIndex = new Map(), taken = new Map(), hostByMac = null }) {
  macs = macs.filter(m => !isPending(m)) // a pending MAC never links a host
  for (const m of macs) if (guestIndex.has(m.mac)) return { hostId: guestIndex.get(m.mac), src: 'pve' }
  for (const m of macs) {
    const h = hostByMac ? hostByMac.get(m.mac) : cfg.hosts.find(x => x.mac === m.mac)?.id
    if (h) return { hostId: h, src: 'config' }
  }
  // by IP only if the identity is solid: a random MAC can take over an IP
  const strong = macs.some(m => m.grade !== 'weak')
  const h = strong && device.last_ip ? cfg.hosts.find(x => x.ip === device.last_ip) : null
  return h && (taken.get(h.id) ?? device.id) === device.id ? { hostId: h.id, src: 'ip' } : null
}

// --- merge ------------------------------------------------------------------

// MAC attached automatically (same DHCP name, same IP in a macvlan range) and not yet
// confirmed by a human: it counts neither for freshness nor for the host link
export const isPending = m => (m.attach === 'name' || m.attach === 'ip') && m.confirmed_at == null

// MAC flooding: bounded refusal, persistent MACs are created anyway
const FLOOD_LIST = 500 // refused MACs kept in memory (the oldest drop out)
const FLOOD_END_MS = 3600_000 // episode over after 1 h without exceeding the limit
const PERSIST_RUNS = 3 // persistent: PRESENCE (Pi-hole, neighbors) in 3 polls…
const PERSIST_MS = 10 * 60_000 // … over at least 10 min; a DHCP lease alone is never enough
const PERSIST_PER_HOUR = 5 // (DHCP pool exhaustion: leases of MACs that do not answer)
// random tie-break salt: with equal views, eviction depends neither on arrival order nor
// on a choice of the attacker (they cannot forge "priority" MACs); re-salted at every poll
// (salt | poll time): bad luck does not stick to one MAC. With a fixed salt, a MAC with a
// high hash, tied at every poll (an intruder coming back among throwaway MACs, a single
// presence each time), was evicted every time and never inventoried, as long as the
// process lived (flakiness of network-flood.test.js)
// confirmed: MACs created as persistent (already seen in 3 polls over 10 min) → the double
// view of net_new is acquired, the alert goes out at the creation poll (kept 1 h)
export const emptyFlood = (salt = randomBytes(8).toString('hex')) => ({ refused: new Map(), episode: null, persisted: [], confirmed: new Map(), salt })
// tie-break key of a poll: the salt and the poll time
export const floodTieSalt = (salt, now) => `${salt}|${now}`
export const tieOf = (salt, mac) => {
  let h = 2166136261
  for (const ch of `${salt}|${mac}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

// state: snapshot (store.load) { devices, macs, seen, attrs, addresses, rules } as Maps
//   and state.flood (kept by createNetwork from one poll to the next)
// sightings: Sighting[] from every source of the poll
// baseline: bootstrap (records created "known, to review"); ingestSince: Pi-hole
// ingestion window
// → { ops, created, stats, flood }; a device created here is designated by a reference
//   "new:N" that store.applyOps resolves into an id; flood: new flooding state
// oui: vendor of a universal prefix (reduced IEEE database, lib/network/oui.js), optional;
// baselineMax: at most this many "known, to review" records created by this poll
// (probe bootstrap); beyond that, normal path WITHIN this poll (new, ceiling, influx)
// probe: state of the ARP probe, which decides what creates a record:
//   'off'  : not configured or never a valid sweep → passive rules;
//   'on'   : in service → only a fresh presence from ARP_PRESENCE_SOURCES (never
//            Pi-hole, a lease or DNS); creation, persistence and absence;
//   'down' : silent after being put in service → NO creation (fail closed).
// state.tombstones: deleted MACs; recreated only by a presence observation valid for the
// mode, with a timestamp STRICTLY later than the deletion
// IP handover (recreated macvlan): arpScan (valid sweep n, on the probe's poll only:
// { ts, byIp: Map ip → [mac], macs: Set, conflicts: Set of ip:/mac: keys }),
// idHistory (previous valid sweeps, reduced to the ipIdentity ranges, most recent first:
// [{ ts, ips: { ip: [mac] } }]), l1Recent (records with an IP handover in the last hour),
// l1Macs (active IP-handover MACs, pending and not escalated: they count for last_present)
// agentIndex (MAC → { host, name, network, ip, ts } from v6 reports less than 5 min
// old) for attachment by container identity; l1Escalated (escalated IP-handover MACs: never
// confirmed by the agent)
export function mergeSightings(state, sightings, { cfg, now = Date.now(), baseline = false, ingestSince = null, oui = null, baselineMax = null, probe = 'off',
  arpScan = null, idHistory = [], l1Recent = new Set(), l1Macs = new Set(), agentIndex = new Map(), l1Escalated = new Set(),
  agentFirst = new Set(), agentLate = new Map(), agentSuspended = new Set(), mdnsNames = [], mdnsScan = null, nameHints = new Map(), nameWait = new Set() } = {}) {
  const net = cfg.network ?? {}
  const tombstones = state.tombstones ?? new Map()
  const arpMode = probe !== 'off'
  // schema defaults only (validated config), no fallback here
  const idRanges = net.ipIdentity.map(parseCidr).filter(Boolean)
  const subnets = net.subnets.map(x => parseCidr(x.cidr)).filter(Boolean)
  const maxNew = net.maxNewPerCycle
  const since = ingestSince ?? now - net.ingestDays * DAY
  const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))
  const hostByMac = new Map(cfg.hosts.filter(h => h.mac).map(h => [h.mac, h.id]))
  const rules = state.rules ?? []

  // working copies: the caller's snapshot is never modified
  const devices = new Map([...state.devices].map(([k, d]) => [k, { ...d }]))
  const macs = new Map([...state.macs].map(([k, m]) => [k, { ...m }]))
  const seen = new Map(state.seen)
  const attrs = new Map([...state.attrs].map(([k, a]) => [k, [...a]]))
  const addresses = state.addresses
  const f0 = state.flood ?? emptyFlood()
  const flood = { refused: new Map(f0.refused), episode: f0.episode ? { ...f0.episode } : null, persisted: f0.persisted.filter(t => now - t < 3600_000),
    confirmed: new Map([...(f0.confirmed ?? [])].filter(([, t]) => now - t < 3600_000)), salt: f0.salt ?? '' }
  if (flood.episode && now - flood.episode.lastOver >= FLOOD_END_MS) flood.episode = null
  const ops = []
  const l1 = [] // IP-handover attachments of this poll: { mac, device, ip } (network.ipHandover registry)
  const stats = { sightings: sightings.length, excluded: 0, outside: 0, notAdmitted: 0, created: 0, baseline: 0, capped: 0, refused: 0, agentNeighUnknown: 0 }
  const startIp = new Map([...state.macs].map(([k, m]) => [k, m.last_ip]))
  const hostDevice = new Map()
  for (const d of devices.values()) if (d.host_id) hostDevice.set(d.host_id, d.id)
  const guestIndex = new Map()
  let refN = 0

  // indexes (performance): MACs per record, records per IP and per name
  const byDevice = new Map()
  const addMac = m => {
    if (!byDevice.has(m.device_id)) byDevice.set(m.device_id, [])
    byDevice.get(m.device_id).push(m)
  }
  for (const m of macs.values()) addMac(m)
  const macsOf = id => byDevice.get(id) || []
  const byIp = new Map()
  for (const d of devices.values()) if (d.last_ip) byIp.set(d.last_ip, [...(byIp.get(d.last_ip) || []), d.id])

  const lastPresence = mac => lastPresenceOf(seen, mac)
  const lastArp = mac => lastArpOf(seen, mac)
  const confirmedOf = id => macsOf(id).filter(m => !isPending(m))
  // absence before an attachment by name or IP: probe in service → its presence only
  // (Pi-hole would keep a ghost record "present")
  const absenceOf = arpMode ? lastArp : lastPresence
  const absent = id => confirmedOf(id).every(m => (absenceOf(m.mac) ?? 0) < now - ABSENT_MS)

  // attributes proposed by the poll: (device, attribute, source) → most recent value
  const proposed = new Map()
  function propose(device, attr, source, value, ts) {
    if (value == null || value === '') return
    const k = `${device}|${attr}|${source}`
    const p = proposed.get(k)
    if (!p || ts > p.ts) proposed.set(k, { device, attr, source, value: String(value).slice(0, 253), ts })
  }

  // name of each MAC in this poll: DHCP lease preferably, otherwise any other source;
  // MACs eligible for creation: seen by a source other than the Pi-hole table (current
  // lease, neighbors, Proxmox, config), or by Pi-hole within the window;
  // MACs with a current lease (persistence during a flood)
  const cycleName = new Map()
  const ingestOk = new Set()
  const leased = new Set()
  for (const x of sightings) {
    const mac = normalizeMac(x.mac)
    if (!mac) continue
    const n = cleanName(x.name)
    if (n && (x.source === 'dhcp' || !cycleName.has(mac))) cycleName.set(mac, n)
    if (x.source !== 'pihole' || Math.max(x.ts ?? 0, x.lastQuery ?? 0) >= since) ingestOk.add(mac)
    if (x.source === 'dhcp' && (x.leaseExpires ?? 0) > now) leased.add(mac)
  }
  const lease = new Map() // device → expiry of the longest lease seen in this poll
  // presence of each MAC in this poll: basis of persistence and creations; probe in
  // service: ARP_PRESENCE_SOURCES only (neigh only counts when REACHABLE)
  const presenceSet = arpMode ? ARP_PRESENCE_SOURCES : PRESENCE_SOURCES
  const presentTs = new Map()
  for (const x of sightings) {
    const mac = normalizeMac(x.mac)
    if (mac && x.presence && presenceSet.has(x.source) && !FRESH_ONLY.has(x.source) && (x.ts ?? 0) > (presentTs.get(mac) ?? -1)) presentTs.set(mac, Math.min(x.ts ?? now, now))
  }
  // can an observation create (or attach) an unknown MAC? identity (pve, config) always;
  // otherwise depending on the probe, and after a deletion only if it is later than
  // deleted_at (never an old entry of the Pi-hole table)
  const inIdRange = ip => !!ip && idRanges.some(r => inCidr(ip, r))
  const admits = s => {
    // the agent (containers) and its neighbors NEVER create or attach, in any mode
    if (s.source === 'agent' || s.source === 'agent-neigh') return false
    if (s.hostId && (s.source === 'pve' || s.source === 'config')) return true
    if (probe === 'down') return false
    // IP handover, rule 0 (deferral): probe in service, within an ipIdentity range, an unknown MAC is
    // only handled by a valid sweep (arp source); neigh or self alone wait
    if (probe === 'on' && inIdRange(s.ip) && s.source !== 'arp') return false
    const ok = arpMode ? ARP_PRESENCE_SOURCES.has(s.source) && !!s.presence : ingestOk.has(s.mac ?? normalizeMac(s.mac))
    const tomb = tombstones.get(normalizeMac(s.mac))
    return ok && (!tomb || Math.min(s.ts ?? now, now) > tomb.deleted_at)
  }
  // MAC back after a deletion: tombstone removed, returned event
  const returned = (device, mac) => {
    const tomb = tombstones.get(mac)
    if (!tomb) return
    tombstones.delete(mac)
    ops.push({ op: 'removeTombstone', mac })
    ops.push({ op: 'insertEvent', device, type: 'returned', ts: now,
      detail: returnedDetail(mac, new Date(tomb.deleted_at).toISOString().slice(0, 16).replace('T', ' '), String(tomb.reason).slice(0, 200)) })
  }

  // records by name (attributes, plus the names of their MACs in this poll)
  const byName = new Map()
  // CLEANED form on both sides (an old name stored with bidi controls and the same name
  // received without them match)
  const nameKey = n => (cleanName(n) ?? String(n)).toLowerCase()
  const addName = (n, id) => {
    const k = nameKey(n)
    if (!byName.has(k)) byName.set(k, new Set())
    byName.get(k).add(id)
  }
  // an mDNS name (forgeable) never steers attachment by name
  for (const [id, list] of attrs) for (const a of list) if (a.attr === 'name' && a.source !== 'mdns') addName(a.value, id)
  for (const m of macs.values()) if (cycleName.has(m.mac)) addName(cycleName.get(m.mac), m.device_id)

  // family or exclusion rule entered by hand (net_mac_rules) that covers an unknown MAC;
  // in probe mode the ARP observation has no name: same hint as attachment by name,
  // otherwise a family would never apply (only the sweep creates or attaches a MAC)
  const ruleFor = mac => rules.find(r => matchPrefix(mac, [r.prefix])
    && (!r.name || (cycleName.get(mac) ?? nameHints.get(mac) ?? '').toLowerCase() === r.name.toLowerCase()))

  // target forbidden to an automatic attachment: linked host, record that carries a strong
  // identity MAC. Narrow exception: a MAC whose hypervisor grade comes ONLY from the agent
  // (mac|agent view, no pve or config view) does not make the record forbidden
  const forbidden = d => !d || d.host_id || macsOf(d.id).some(m => m.grade !== 'weak' && !agentOnly(m, seen))
  // record → container associations (H/X/N: host/container/network), updated by the agent views of the poll
  const assocs = containerAssociations(attrs)
  const assoc = assocs.byKey // key → record
  const assocOf = new Map([...assocs.byDevice].map(([id, c]) => [id, c.key])) // record → key
  const agentOut = { conflicts: [], late: [] } // conflicts, late associations
  // attachment by container identity, BEFORE the IP handover: M seen on P by an observation that can
  // create, attributed by the agent of H (≤ 5 min) to container X on N with the same IP P;
  // a single unlinked record carries H/X/N; no tombstone.
  // Confirmed outright only if the IP is in ipIdentity AND the probe (in service) sees M on
  // that IP in the valid sweep; otherwise PENDING (attach 'ip', info), without IP handover.
  // Suspended for a record in identity conflict, until a human decision
  function agentTarget(s) {
    const ci = agentIndex.get(s.mac)
    if (!ci || ci.ip !== s.ip || now - ci.ts > 5 * MIN_MS || tombstones.has(s.mac)) return null
    const id = assoc.get(`${ci.host}/${ci.name}/${ci.network}`)
    const F = id != null ? devices.get(id) : null
    // an unconfirmed late association is not used for attachment by identity
    if (!F || F.host_id || agentSuspended.has(F.id) || agentLate.has(F.id)) return null
    const why = whyDetail.agent(ci.name, ci.host, ci.network)
    const seenByProbe = probe === 'on' && !!arpScan && s.source === 'arp' && !!s.presence && (arpScan.byIp.get(s.ip) ?? []).includes(s.mac)
    if (inIdRange(s.ip) && seenByProbe) return { id: F.id, why, attach: 'agent', confirmed: { confirmed_by: `agent:${ci.host}`, confirmed_at: ci.ts } }
    return { id: F.id, why: whyDetail.pending(why), attach: 'ip' }
  }

  // IP handover: handover observed in the sweep, conditions 1 to 8; → id of F or null
  const l1Now = new Set(l1Macs)
  const l1Done = new Set(l1Recent)
  function l1Target(s) {
    const P = s.ip
    if (probe !== 'on' || !arpScan || s.source !== 'arp' || !s.presence || !inIdRange(P)) return null // 1, 2
    const holders = byIp.get(P) || []
    if (holders.length !== 1) return null // 3: a single record holds the IP
    const F = devices.get(holders[0])
    if (!F || F.state !== 'known' || forbidden(F)) return null // 3: known, neither linked nor strong identity
    if (l1Done.has(F.id)) return null // 8: one IP handover per record and per hour
    if (tombstones.has(s.mac)) return null // 7: a tombstone wins (returned, "new")
    const all = macsOf(F.id)
    if (all.some(m => arpScan.macs.has(m.mac))) return null // 5: no MAC of F answers sweep n
    const scanned = arpScan.byIp.get(P) || []
    if (scanned.length !== 1 || scanned[0] !== s.mac || arpScan.conflicts.has(`ip:${P}`) || arpScan.conflicts.has(`mac:${s.mac}`)) return null // 6
    // 4: old MAC (not pending, or active IP handover) on P in sweep n−1, or n−2 if P was silent at n−1
    const old = new Set(all.filter(m => !isPending(m) || l1Macs.has(m.mac)).map(m => m.mac))
    const at = k => idHistory[k]?.ips?.[P] ?? []
    const handover = at(0).some(x => old.has(x)) || (idHistory.length >= 1 && at(0).length === 0 && at(1).some(x => old.has(x)))
    return handover ? F.id : null
  }

  // unknown MAC: existing device to attach it to, or null
  // → { id, why, attach }; attach: pve | config | ip | name
  function attachTarget(s, grade) {
    if (s.hostId && hostDevice.has(s.hostId)) return { id: hostDevice.get(s.hostId), why: null, attach: s.source }
    const ag = agentTarget(s)
    if (ag) return ag
    const l1 = l1Target(s)
    if (l1 != null) return { id: l1, why: whyDetail.ipHandover(s.ip), attach: 'ip', l1: true }
    // range where the IP is the identity (macvlan): a device held this IP, its MACs are gone
    if (s.ip && idRanges.some(r => inCidr(s.ip, r))) {
      const id = (byIp.get(s.ip) || []).find(x => !forbidden(devices.get(x)) && absent(x))
      if (id != null) return { id, why: whyDetail.sameIp(s.ip), attach: 'ip' }
    }
    // random MAC: same non-generic DHCP name, single candidate whose MACs are gone (the
    // name can come from another observation of the same poll: DHCP lease), and disjoint
    // life periods (first → last seen): a device that rotates its MACs does so one after
    // the other; two "Phone-X1" seen at the same time are two devices.
    // Any device can announce that name: the attachment stays "pending" (net_mac_added
    // alert, record to review) until a human has confirmed it.
    // In probe mode the ARP observation has no name; the hint comes from the last passive
    // poll (index.js) and is used ONLY HERE (no attribute, no creation)
    const name = cycleName.get(s.mac) ?? nameHints.get(s.mac) ?? cleanName(s.name)
    // probe mode → life starts at the ARP observation (never a Pi-hole firstSeen) and is
    // measured like absent(); without the probe, unchanged (lifeEndOf)
    const life = [arpMode ? s.ts : s.firstSeen ?? s.ts, s.ts]
    const disjoint = m => life[1] < m.first_seen || lifeEndOf(m, seen, arpMode) < life[0]
    if (grade === 'weak' && name && !isGenericName(name)) {
      const c = [...(byName.get(nameKey(name)) || [])].map(id => devices.get(id))
        .filter(d => d && !forbidden(d) && macsOf(d.id).every(m => m.grade === 'weak' && disjoint(m)) && absent(d.id))
      if (c.length === 1) return { id: c[0].id, why: whyDetail.sameName(name), attach: 'name' }
    }
    return null
  }

  // refused MAC (ceiling, flooding episode): tracked once per poll; the list is bounded at
  // the end of the poll, keeping the MACs seen again most often (an intruder that stays
  // must not be chased out by hundreds of throwaway MACs)
  const counted = new Set()
  // presence moving forward for a refused MAC (the same repeated Pi-hole view does not count)
  const advances = (mac, r) => presentTs.has(mac) && presentTs.get(mac) > (r?.lastPresence ?? -1)
  function refuse(mac) {
    stats.capped++
    if (counted.has(mac)) return
    counted.add(mac)
    const r = flood.refused.get(mac)
    const adv = advances(mac, r)
    flood.refused.set(mac, {
      first: r?.first ?? now, last: now, runs: (r?.runs ?? 0) + 1, lease: !!r?.lease || leased.has(mac),
      presenceRuns: (r?.presenceRuns ?? 0) + (adv ? 1 : 0),
      firstPresence: r?.firstPresence ?? (adv ? now : null),
      lastPresence: adv ? presentTs.get(mac) : r?.lastPresence ?? null,
    })
  }
  function trimRefused() {
    if (flood.refused.size <= FLOOD_LIST) return
    const keep = [...flood.refused].sort(([ma, a], [mb, b]) => (b.presenceRuns ?? 0) - (a.presenceRuns ?? 0) || b.runs - a.runs || b.last - a.last
      || tieOf(floodTieSalt(flood.salt, now), ma) - tieOf(floodTieSalt(flood.salt, now), mb)).slice(0, FLOOD_LIST)
    flood.refused = new Map(keep)
  }
  // persistent: present in at least 3 polls over at least 10 min (this poll included)
  const persistent = mac => {
    const r = flood.refused.get(mac)
    if (!r || !advances(mac, r)) return false
    return (r.presenceRuns ?? 0) + 1 >= PERSIST_RUNS && r.firstPresence != null && now - r.firstPresence >= PERSIST_MS
  }

  function createDevice(s, grade) {
    // "known" outright: identity read from the inside (Proxmox NIC, hosts[].mac); a MAC
    // that only takes a host's IP follows the normal rules (it may be spoofing)
    const host = s.hostId ? hostsById.get(s.hostId) : null
    // a deleted MAC that comes back, through any source (pve or config with a host
    // included), creates a NEW record (returned, net_new): never silently "known"
    const back = tombstones.has(s.mac)
    const amorce = baseline && !host && !back && !(baselineMax != null && stats.baseline >= baselineMax)
    const state = (host || amorce) && !back ? 'known' : 'new'
    // bootstrap: ceiling ten times higher (existing devices arrive all at once, a flood stays bounded)
    if (devices.size >= MAX_DEVICES || (state === 'known' && !host && stats.baseline >= (baselineMax ?? maxNew * 10))) {
      stats.capped++
      return null
    }
    if (state === 'new') {
      // beyond the ceiling (the whole poll is then refused: no burst of "new" records),
      // or during a flooding episode: refusal, except for a persistent MAC (5 per hour at
      // most); exceeding opens the episode, or extends it
      const over = overflow || stats.created >= maxNew
      if (over || flood.episode) {
        if (over) flood.episode = { since: flood.episode?.since ?? now, lastOver: now }
        if (!(persistent(s.mac) && flood.persisted.length < PERSIST_PER_HOUR)) {
          refuse(s.mac)
          return null
        }
        flood.persisted.push(now)
        flood.confirmed.set(s.mac, now)
      }
      stats.created++
      flood.refused.delete(s.mac)
    } else if (!host) stats.baseline++
    const id = `new:${++refN}`
    const origin = s.source === 'pve' || s.source === 'config' ? s.source : 'scan'
    const fields = { state, review: amorce ? 1 : 0, origin, created_at: now, updated_at: now, first_seen: s.firstSeen ?? s.ts }
    devices.set(id, { id, ...fields })
    attrs.set(id, [])
    if (s.hostId) hostDevice.set(s.hostId, id)
    ops.push({ op: 'insertDevice', ref: id, fields })
    ops.push({ op: 'insertEvent', device: id, type: 'new', ts: now, detail: newDetail(origin, amorce) })
    return id
  }

  // influx: unknown MACs that are candidates for a "new" record in this poll; beyond the
  // ceiling none is created (except persistent ones), so as not to fire a burst of alerts
  const candidates = new Set()
  if (!baseline || baselineMax != null) {
    for (const x of sightings) {
      const mac = normalizeMac(x.mac)
      if (!mac || macs.has(mac) || x.hostId || !x.ip || !admits({ ...x, mac })) continue
      if (gradeMac(mac, { source: x.source }) === 'excluded' || (subnets.length && !subnets.some(c => inCidr(x.ip, c)))) continue
      if (ruleFor(mac) || nameWait.has(mac)) continue
      candidates.add(mac)
    }
  }
  // capped bootstrap: the first baselineMax are not candidates for "new"
  const overflow = candidates.size - (baseline ? baselineMax ?? Infinity : 0) > maxNew
  if (overflow) flood.episode = { since: flood.episode?.since ?? now, lastOver: now }

  // safe identities first (the host's record exists before the network views), then,
  // during an influx, the refused MACs most present (they take the 5 slots per hour),
  // then by date: for a MAC seen on two IPs, the most recent wins
  const order = { pve: 0, config: 1 }
  const rank = x => {
    const r = flood.refused.get(normalizeMac(x.mac))
    return r ? -((r.presenceRuns ?? 0) * 1000 + r.runs) : 0
  }
  const list = [...sightings].sort((a, b) => (order[a.source] ?? 2) - (order[b.source] ?? 2) || rank(a) - rank(b) || (a.ts ?? 0) - (b.ts ?? 0))

  for (const s0 of list) {
    const mac = normalizeMac(s0.mac)
    // exclusions by NATURE (null MAC, multicast, virtual router): these are not devices
    const grade = gradeMac(mac, { source: s0.source })
    if (grade === 'excluded') {
      stats.excluded++
      continue
    }
    // outside the LAN subnets (Docker bridge, tailnet…): outside the tracked network
    if (s0.ip && subnets.length && !subnets.some(c => inCidr(s0.ip, c))) {
      stats.outside++
      continue
    }
    // a date coming from a source is never in the future (Pi-hole clock running ahead)
    const s = { ...s0, mac, ts: Math.min(s0.ts ?? now, now) }
    if (s.source === 'pve' && s.hostId) guestIndex.set(mac, s.hostId)
    const isPresence = PRESENCE_SOURCES.has(s.source)
    let m = macs.get(mac)

    if (!m) {
      // validated family (attach rule): attachment; there is no ignore rule any more
      const rule = s.source === 'pve' || s.source === 'config' ? null : ruleFor(mac)
      // without IP or host: identity of an already known MAC only; an old entry of the
      // Pi-hole table (MAC seen weeks ago) does not create a record
      if (!s.ip && !s.hostId) continue
      // creation or attachment depending on the probe and the tombstones
      if (!admits(s)) {
        if (s.source === 'agent-neigh') stats.agentNeighUnknown++
        else stats.notAdmitted++
        continue
      }
      // random MAC seen by the sweep before its lease was read (index.js): neither record
      // nor attachment on this sweep, the next one decides with the name
      if (!rule && nameWait.has(mac)) continue
      const ruleTarget = rule?.action === 'attach' && devices.get(rule.device_id)
      const t = ruleTarget
        ? { id: ruleTarget.id, why: whyDetail.family(rule.prefix, rule.name), attach: 'rule' }
        : attachTarget(s, grade)
      const device = t?.id ?? createDevice(s, grade)
      if (!device) continue
      returned(device, mac)
      if (t?.l1) {
        l1Now.add(mac)
        l1Done.add(device)
        l1.push({ mac, device, ip: s.ip })
      }
      // MAC that creates its record: attach NULL, except identity (pve, config)
      const attach = t?.attach ?? (s.source === 'pve' || s.source === 'config' ? s.source : null)
      if (t?.why) ops.push({ op: 'insertEvent', device, type: 'mac_added', ts: now, detail: macAddedDetail(mac, t.why) })
      if (attach === 'name' || attach === 'ip') {
        const d = devices.get(device)
        if (d && !d.review) {
          d.review = 1
          ops.push({ op: 'updateDevice', device, fields: { review: 1, updated_at: now } })
        }
      }
      // validated family: attachment confirmed outright, dated (net_mac_added as info for 24 h)
      const confirmed = attach === 'rule' ? { confirmed_by: `rule:${rule.id}`, confirmed_at: now }
        : attach === 'agent' ? t.confirmed : { confirmed_by: null, confirmed_at: null }
      m = { mac, device_id: device, grade, random: isLocal(mac) ? 1 : 0, oui_vendor: null, first_seen: s.firstSeen ?? s.ts, last_seen: s.ts, last_ip: s.ip ?? null, attach, ...confirmed, dirty: true, born: true }
      macs.set(mac, m)
      addMac(m)
      if (cycleName.has(mac)) addName(cycleName.get(mac), device)
    } else if (GRADE_RANK[grade] > GRADE_RANK[m.grade] && s.source !== 'agent') {
      // an agent view only raises the grade if the association is accepted (below)
      m.grade = grade
      m.dirty = true
    }

    // last view per source: a presence observation only if it moves forward
    const key = `${mac}|${s.source}`
    const prev = seen.get(key)
    let fresh = false
    if (isPresence) {
      fresh = !!s.presence && s.ts > (prev?.last_seen ?? -1)
    } else {
      // identity (dhcp, pve, config): rewritten if the IP changes or every 10 min
      fresh = !prev || prev.last_ip !== (s.ip ?? null) || s.ts - prev.last_seen >= THROTTLE_MS
    }
    if (fresh) {
      const row = { mac, source: s.source, last_seen: s.ts, last_ip: s.ip ?? null }
      seen.set(key, row)
      ops.push({ op: 'upsertSeen', ...row })
    }

    // MAC: last view and current IP carried by presence observations; an identity source
    // only fills in an unknown IP; agent neighbors: last view only (no IP, no address
    // history)
    const freshOnly = FRESH_ONLY.has(s.source)
    if (isPresence && fresh) {
      if (s.ts > m.last_seen) m.last_seen = s.ts
      if (s.ip && m.last_ip !== s.ip && !freshOnly) m.last_ip = s.ip
      m.dirty = true
    } else if (!isPresence && s.ip && !m.last_ip) {
      m.last_ip = s.ip
      m.dirty = true
    }
    if (s.firstSeen && s.firstSeen < m.first_seen) {
      m.first_seen = s.firstSeen
      m.dirty = true
    }

    if (s.leaseExpires && !isPending(m)) lease.set(m.device_id, Math.max(lease.get(m.device_id) ?? 0, s.leaseExpires))

    // agent view of a container (identity): H/X/N association with the record that carries
    // the MAC (it takes it over from another record); pending, non-escalated IP-handover MAC, same IP,
    // on a record already associated with H/X/N → confirmed by the agent (probe / agent race)
    if (s.source === 'agent' && s.container) {
      const key = `${s.container.host}/${s.container.name}/${s.container.network}`
      if (!isPending(m)) {
        const F = devices.get(m.device_id)
        const holder = assoc.get(key)
        const cur = assocOf.get(m.device_id)
        // hypervisor grade only for an accepted association (all checks below passed)
        const raise = () => {
          if (GRADE_RANK.hypervisor > GRADE_RANK[m.grade]) {
            m.grade = 'hypervisor'
            m.dirty = true
          }
        }
        if (holder === m.device_id && cur === key) {
          raise()
          propose(m.device_id, 'container', 'agent', key, s.ts) // existing association: refreshed
        } else if (!isLocal(mac) || forbidden(F)) {
          // universal MAC never associated; linked record, strong MAC, pve or config
        } else if ((holder != null && holder !== m.device_id) || (cur && cur !== key)) {
          // never an automatic move: refusal, conflict, container rule suspended
          agentOut.conflicts.push({ device: m.device_id, key, other: holder != null && holder !== m.device_id ? holder : null, current: cur ?? null })
        } else {
          assoc.set(key, m.device_id)
          assocOf.set(m.device_id, key)
          raise()
          propose(m.device_id, 'container', 'agent', key, s.ts)
          // association made after the host's first v6 report: late (name withheld until
          // a human confirmation); record already known: to review, digest
          if (!agentFirst.has(s.container.host)) {
            agentOut.late.push({ device: m.device_id, key, at: now, known: F?.state === 'known' })
            agentLate.set(m.device_id, now)
            if (F?.state === 'known' && !F.review) {
              F.review = 1
              ops.push({ op: 'updateDevice', device: m.device_id, fields: { review: 1, updated_at: now } })
            }
          }
        }
        // container name (rank 7): record associated with this identity, and association from
        // the first v6 report, or confirmed by a human ("Known" after the late association)
        const lateAt = agentLate.get(m.device_id)
        if (assoc.get(key) === m.device_id && (lateAt == null || (F?.acked_at != null && F.acked_at > lateAt))) {
          propose(m.device_id, 'name', 'agent', cleanName(s.name), s.ts)
        }
      } else if (l1Macs.has(m.mac) && !l1Escalated.has(m.mac) && m.last_ip === s.ip && assoc.get(key) === m.device_id) {
        m.confirmed_by = `agent:${s.container.host}`
        m.confirmed_at = s.ts
        m.confirm = true
        m.dirty = true
      }
    }

    // IP ↔ MAC history
    if (s.ip && (fresh || !isPresence) && !freshOnly) {
      const a = addresses.get(`${mac}|${s.ip}`)
      if (!a || s.ts - a.last_seen >= THROTTLE_MS) ops.push({ op: 'upsertAddress', mac, ip: s.ip, ts: s.ts, source: s.source })
    }

    // discovered attributes (not those of a pending MAC: a spoofer renames nothing)
    // agent: name proposed above, only within the association checks (never through this path)
    const rankSrc = RANK[s.source] != null && !isPending(m) && s.source !== 'agent' ? s.source : null
    if (rankSrc) {
      propose(m.device_id, 'name', rankSrc, cleanName(s.name), s.ts)
      propose(m.device_id, 'hostname', rankSrc, cleanText(s.hostname), s.ts)
      // a local MAC has no vendor: Pi-hole wrongly guesses one (OUI without the U/L bit)
      if (!isLocal(mac)) propose(m.device_id, 'vendor', rankSrc, cleanText(s.vendor), s.ts)
    }
    // vendor from the OUI database (rank 2): universal MAC only, Pi-hole takes precedence
    if (oui && !isPending(m) && !isLocal(mac)) propose(m.device_id, 'vendor', 'oui', cleanText(oui(mac), 40), s.ts)
  }

  // modified MACs, then IP changes (once per poll, final IP against initial IP)
  for (const m of macs.values()) {
    if (!m.dirty) continue
    delete m.dirty
    ops.push({ op: 'upsertMac', mac: m.mac, device: m.device_id, grade: m.grade, random: m.random, oui_vendor: m.oui_vendor ?? null, first_seen: m.first_seen, last_seen: m.last_seen, last_ip: m.last_ip, attach: m.attach ?? null,
      ...((m.born || m.confirm) && m.confirmed_at ? { confirmed_by: m.confirmed_by, confirmed_at: m.confirmed_at } : {}) })
    delete m.born
    delete m.confirm
    const before = startIp.get(m.mac)
    if (before && m.last_ip && before !== m.last_ip && !isPending(m)) {
      const d = devices.get(m.device_id)
      // DHCP noise discarded: the old IP had been held for 7 days and the new one was never
      // seen (a workstation alternating between two known IPs produces nothing)
      const held = addresses.get(`${m.mac}|${before}`)
      const novel = !addresses.has(`${m.mac}|${m.last_ip}`)
      if (d?.expected_ip || (novel && held && held.last_seen - held.first_seen >= STABLE_MS)) {
        ops.push({ op: 'insertEvent', device: m.device_id, type: 'ip_changed', ts: now, detail: `${before} → ${m.last_ip}` })
      }
    }
  }

  // attributes: written if new, modified or one hour old
  for (const p of proposed.values()) {
    const list = attrs.get(p.device) || []
    const cur = list.find(a => a.attr === p.attr && a.source === p.source)
    if (cur && cur.value === p.value && p.ts - cur.seen_at < ATTR_REFRESH_MS) continue
    const row = { device_id: p.device, attr: p.attr, source: p.source, value: p.value, rank: RANK[p.source], seen_at: p.ts }
    attrs.set(p.device, [...list.filter(a => a !== cur), row])
    ops.push({ op: 'upsertAttr', device: p.device, attr: p.attr, source: p.source, value: p.value, rank: row.rank, seen_at: p.ts })
  }

  // attribute discovered outside an observation (name of the linked host, guessed type):
  // written if new, modified or one hour old
  function setAttr(device, attr, source, value) {
    const list = attrs.get(device) || []
    const cur = list.find(a => a.attr === attr && a.source === source)
    if (cur && cur.value === value && now - cur.seen_at < ATTR_REFRESH_MS) return
    attrs.set(device, [...list.filter(a => a !== cur), { device_id: device, attr, source, value, rank: RANK[source], seen_at: now }])
    ops.push({ op: 'upsertAttr', device, attr, source, value, rank: RANK[source], seen_at: now })
  }

  // stable mDNS names [{ ip, name, ts }] → name attribute from the mdns source on an EXISTING
  // record WITHOUT a name. Record targeted by the last VALID ARP sweep (mdnsScan, null if the
  // probe is not in service): a single MAC on the IP, without an ip: or mac: conflict, not
  // pending, record known and not linked to a host. No presence, no creation, no attachment
  const mdnsOut = { candidates: 0, applied: [], nameDiffers: 0, nameConflict: 0, noDevice: 0, ambiguous: 0, offline: 0 }
  if (mdnsNames.length) {
    const shown = new Map()
    for (const d of devices.values()) if (d.disp_name) shown.set(d.disp_name.toLowerCase(), [...(shown.get(d.disp_name.toLowerCase()) ?? []), d.id])
    for (const c of mdnsNames) {
      mdnsOut.candidates++
      const list = mdnsScan?.byIp.get(c.ip) ?? []
      if (!list.length) {
        mdnsOut.noDevice++
        continue
      }
      if (list.length > 1 || mdnsScan.conflicts.has(`ip:${c.ip}`) || mdnsScan.conflicts.has(`mac:${list[0]}`)) {
        mdnsOut.ambiguous++
        continue
      }
      const m = macs.get(list[0])
      const d = m ? devices.get(m.device_id) : null
      if (!d) {
        mdnsOut.noDevice++
        continue
      }
      if (isPending(m) || d.state !== 'known' || d.host_id) {
        mdnsOut.offline++
        continue
      }
      const lower = c.name.toLowerCase()
      // only fill an empty name: neither a manual entry, nor a name from another source
      // (whatever its rank), nor another mDNS name already set (never a rename)
      const names = (attrs.get(d.id) || []).filter(a => a.attr === 'name')
      const prev = names.find(a => a.source === 'mdns')
      const held = d.name ?? names.find(a => a.source !== 'mdns')?.value ?? (prev && prev.value !== c.name ? prev.value : null)
      if (held != null) {
        // record already named. Candidate equal to the RETAINED name (case-insensitive) → the
        // informative name is cleared; different → counted, and kept as an informative name
        // (mdns_name), even if it is the displayed name of another record (display only, with a note)
        const retained = d.name ?? bestAttr(names, 'name')?.value ?? held
        if (String(retained).toLowerCase() === lower) dropInfo(d.id)
        else {
          mdnsOut.nameDiffers++
          setInfo(d.id, c.name)
        }
        continue
      }
      if ((shown.get(lower) ?? []).some(id => id !== d.id)) { // displayed name of ANOTHER record
        mdnsOut.nameConflict++
        continue
      }
      dropInfo(d.id) // the record takes this name: no more informative name
      if (!prev) mdnsOut.applied.push(d.id)
      setAttr(d.id, 'name', 'mdns', c.name)
    }
  }
  // informative name, a distinct mdns_name attribute (mdns source), never a name.
  // At most one change per 24 h; seen_at is NOT refreshed as long as the value does not
  // change: it is the date of the last change. No event.
  function setInfo(id, value) {
    const list = attrs.get(id) || []
    const cur = list.find(a => a.attr === 'mdns_name' && a.source === 'mdns')
    if (cur && (cur.value === value || now - cur.seen_at < DAY)) return
    setAttr(id, 'mdns_name', 'mdns', value)
  }
  function dropInfo(id) {
    const list = attrs.get(id) || []
    if (!list.some(a => a.attr === 'mdns_name' && a.source === 'mdns')) return
    attrs.set(id, list.filter(a => !(a.attr === 'mdns_name' && a.source === 'mdns')))
    ops.push({ op: 'deleteAttr', device: id, attr: 'mdns_name', source: 'mdns' })
  }

  // hosts carried by a record's MAC (Proxmox NIC, hosts[].mac): a link by IP cannot attach
  // them to another record (IP spoofing, two records for one host)
  const taken = new Map()
  for (const m of macs.values()) {
    if (isPending(m)) continue
    const h = guestIndex.get(m.mac) ?? hostByMac.get(m.mac)
    if (h && !taken.has(h)) taken.set(h, m.device_id)
  }
  for (const d of devices.values()) if ((d.host_src === 'pve' || d.host_src === 'config') && !taken.has(d.host_id)) taken.set(d.host_id, d.id)

  // denormalised fields of each device (list, search), written if they change
  const ctx = { cfg, guestIndex, lastPresence, lastArp, lease, taken, hostByMac }
  for (const d of devices.values()) {
    const all = macsOf(d.id)
    if (!all.length) continue
    // a pending MAC does not count (unless the record has only that one, impossible outside writes)
    const dm = all.filter(m => !isPending(m)).length ? all.filter(m => !isPending(m)) : all
    // IP handover: an active IP-handover MAC (pending, not escalated) counts for last_present, and nothing else
    ctx.presentMacs = [...dm, ...all.filter(m => isPending(m) && l1Now.has(m.mac) && !dm.includes(m))]
    let fields = deriveDevice(d, dm, attrs.get(d.id) || [], ctx)
    const host = hostsById.get(fields.host_id ?? d.host_id)
    // linked by IP to a host of the config: its name becomes a discovered name of rank 8
    // (pve and config links already bring it through their observations)
    if (host && (fields.host_src ?? d.host_src) === 'ip') setAttr(d.id, 'name', 'config', host.name)
    // guessed type: discovered value of rank 2, never a manual entry
    const kind = guessKind({
      // the mDNS name guesses neither type nor profile
      vendor: fields.vendor, names: (attrs.get(d.id) || []).filter(a => a.attr === 'name' && a.source !== 'mdns').map(a => a.value),
      grade: fields.grade, hostKind: host?.kind,
    })
    if (kind.type) setAttr(d.id, 'type', 'guess', kind.type)
    // guessed presence profile: rank 2, a manual entry (profile column) replaces it
    if (kind.profile) setAttr(d.id, 'profile', 'guess', kind.profile)
    fields = deriveDevice(d, dm, attrs.get(d.id) || [], ctx)
    delete fields.grade
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => d[k] !== v))
    if (Object.keys(changed).length) {
      Object.assign(d, changed)
      ops.push({ op: 'updateDevice', device: d.id, fields: { ...changed, updated_at: now } })
    }
  }

  trimRefused()
  stats.refused = flood.refused.size
  return { ops, created: stats.created, stats, flood, l1, agent: agentOut, mdns: mdnsOut }
}

// recomputed fields: primary MAC, IP, vendor, displayed name and type, first and last
// seen, link with a host (never instead of a link entered by hand).
// dm: confirmed MACs of the record (pending MACs are excluded by the caller)
function deriveDevice(d, dm, attrs, { cfg, guestIndex, lastPresence, lastArp, lease, taken, hostByMac, presentMacs = dm }) {
  const ranked = [...dm].sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade] || b.last_seen - a.last_seen)
  let lastSeen = null
  let lastIpMac = null
  for (const m of dm) {
    const t = lastPresence(m.mac)
    if (t != null && (lastSeen == null || t > lastSeen)) {
      lastSeen = t
      lastIpMac = m
    }
  }
  const out = {
    primary_mac: ranked[0].mac,
    last_ip: lastIpMac?.last_ip ?? ranked.find(m => m.last_ip)?.last_ip ?? d.last_ip ?? null,
    vendor: bestAttr(attrs, 'vendor')?.value ?? null,
    first_seen: Math.min(...dm.map(m => m.first_seen), d.first_seen ?? Infinity),
    // last presence observation: the most recent of the sources, or the one from the import
    last_seen: Math.max(lastSeen ?? -Infinity, d.last_seen ?? -Infinity),
    // presence in the probe's sense: the only one presenceOf reads
    last_present: Math.max(...presentMacs.map(m => lastArp(m.mac) ?? -Infinity), d.last_present ?? -Infinity),
    last_dhcp: Math.max(lease.get(d.id) ?? -Infinity, d.last_dhcp ?? -Infinity),
    grade: ranked[0].grade,
  }
  if (out.last_present === -Infinity) out.last_present = null
  if (out.last_seen === -Infinity) out.last_seen = null
  if (out.last_dhcp === -Infinity) out.last_dhcp = null
  // a link to a host removed from config.json is no longer kept, whatever its source
  // (manual entry included): the record then follows matchHost like an unlinked record
  const hostGone = d.host_id != null && !cfg.hosts.some(h => h.id === d.host_id)
  if (d.host_src !== 'user' || hostGone) {
    const link = matchHost({ ...d, last_ip: out.last_ip }, dm, { cfg, guestIndex, taken, hostByMac })
    // a pve or config link does not yield to a link by IP, nor disappears because the pve
    // source is down; a link by IP follows the IP
    const sure = !hostGone && (d.host_src === 'pve' || d.host_src === 'config')
    if (link && !(sure && link.src === 'ip')) Object.assign(out, { host_id: link.hostId, host_src: link.src })
    else if (!link && !sure) Object.assign(out, { host_id: null, host_src: null })
  }
  out.disp_name = d.name ?? bestAttr(attrs, 'name')?.value ?? null
  out.disp_type = d.type ?? bestAttr(attrs, 'type')?.value ?? null
  return out
}
