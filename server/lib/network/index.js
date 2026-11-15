// Network module: inventory of the LAN devices from passive sources (Pi-hole network
// table and DHCP leases, neighbors of the container, Proxmox guest NICs, hosts of the
// config) and from the ARP probe (file written by the net-scan unit, the only one with
// CAP_NET_RAW; this process only reads it). Without the probe, freshness only, never
// "online".
//
// Presence: on each new successful sweep (file re-read every 30 s, gateway present),
// merge of the answers, then presence, sessions and rollup in the same transaction.
// First sweep: network.presenceSince; bootstrap over the first 3 sweeps.
//
// One poll every sources.pihole.intervalSec: sources read in parallel (a failing source
// keeps its last data and does not stop the others), merge, then writes in a single
// transaction and a new in-memory snapshot. Routes read this snapshot and SQLite, never
// a source.
import { createNetStore } from './store.js'
import { normalizeMac, gradeMac } from '../net/mac.js'
import { mergeSightings, bestAttr, RANK, emptyFlood, isPending, plain, deviceLabel, containerAssociations, agentOnly, cleanName, isGenericName, setHostSuffixes } from './merge.js'
import { networkSignals } from './rules.js'
import { suggestFamilies, suggestMerges } from './suggest.js'
import { createNetworkWrites, deletionBlock, DEVICE_TYPES } from './writes.js'
import fs from 'node:fs'
import os from 'node:os'
import { freshnessOf, presenceOf, sessionOps, rollupOps, graceMs, cellOf, absentSince } from './presence.js'
import { ouiOf } from './oui.js'
import { parseCidr, inCidr } from '../net/ip.js'
import { readDevices, readLeases } from './sources/pihole.js'
import { readArp } from './sources/arp.js'
import { buildTopology, toMermaid, deviceParent } from './topology.js'
import { selfSightings } from './sources/self.js'
import { defaultGateway } from './sources/route.js'
import { readNeigh } from './sources/neigh.js'
import { guestSightings, PVE_PERIOD_MS } from './sources/pve.js'
import { configSightings } from './sources/config.js'
import { agentSightings, containerIndex } from './sources/agent.js'
import { createProbe, excluded, needsForce } from './probe.js'
import { createClock } from '../clock.js'
import { NET_VERB, netAction, KV, kvGet, MIGRATION_ACTOR, eventActor, EV } from '../codes.js'
import { arpKey, arpConflict, isIpHandover, isAdminProbe, eventText, agentConflictDetail } from './events.js'
import { t as tr } from '../i18n.js'
import dgram from 'node:dgram'
import { createMdnsHandler, ifaceIp, openSocket } from './sources/mdns.js'

const MIN = 60_000
const HOUR = 3600_000
const DAY = 86400_000
const BASELINE_RUNS = 30 // silent bootstrap: successful Pi-hole polls

const errText = e => String(e?.cause?.code || (e?.name === 'TimeoutError' && 'timeout') || e?.message || e).slice(0, 200)
const iso = v => (v == null ? null : new Date(v).toISOString())

// inert module: config without a network block
function disabled() {
  return {
    enabled: false,
    // stop() asynchronous like the active module's (index.js shutdown awaits it)
    start() {}, stop: async () => {}, purge() {},
    runAll: async () => null,
    view: () => ({ enabled: false, presence: 'passive', generatedAt: new Date().toISOString(), sources: {}, counts: null, devices: [] }),
    device: () => null,
    history: () => null,
    runArp: () => null,
    topology: () => null,
    topologyMermaid: () => null,
    summary: () => null,
    signals: () => [],
    digestLines: () => [],
    search: () => [],
    writes: null,
    bot: null,
    onWrite() {},
    firing() {},
  }
}

// exec: injectable execFile (neighbors); pihole: client of the shared registry (lib/pihole.js);
// audit: write journal; arpFs, arpUid, ifaces: reading of the probe file and interfaces of
// the container, injectable (tests); oui: vendor of a prefix (null: none);
// routeText: content of /proc/net/route (gateway of the default route), injectable.
// Module periods when the source is not configured (same values as the schema defaults
// for sources.pihole.intervalSec and sources.arp.intervalSec)
const RUN_PERIOD_SEC = 60
const ARP_PERIOD_SEC = 120

export function createNetwork({ cfg, store, sources = null, pihole = null, audit = null, now = () => Date.now(), log = console, exec,
  arpFs = null, arpUid = null, ifaces = () => os.networkInterfaces(), oui = ouiOf,
  routeText = () => fs.readFileSync('/proc/net/route', 'utf8'), agentReports = null, probeOptions = {}, dgramImpl = dgram, floodSalt } = {}) {
  const net = cfg.network
  if (!net) return disabled()
  setHostSuffixes(net.hostSuffixes ?? []) // before any name is cleaned
  const ns = createNetStore(store)
  // start of the "new device" alerts, set here, synchronously, before the engine is
  // created and therefore before any evaluation: nothing that exists at deployment time
  // can notify
  if (!store.kv.get('network.alertsSince')) store.kv.set('network.alertsSince', String(now()))
  const alertsSince = Number(store.kv.get('network.alertsSince'))
  // purge of ignored and archived records, synchronous, before the engine and therefore
  // before any evaluation; only once (kv network.legacyPurge, formerly network.purgeR4); never blocking
  const purged = purgeLegacyStatesR4()
  function purgeLegacyStatesR4() {
    const none = { ids: [], macs: [] }
    if (kvGet(store.kv, KV.LEGACY_PURGE)) return none
    try {
      return ns.transaction(() => {
        const t = now()
        const max = Number(store.db.prepare('SELECT MAX(id) m FROM net_devices').get().m) || 0
        // never a reused id: the bound is set BEFORE any deletion
        store.kv.set('network.lastDeviceId', String(Math.max(max, Number(store.kv.get('network.lastDeviceId')) || 0)))
        const rows = store.db.prepare("SELECT * FROM net_devices WHERE state IN ('archived', 'ignored') ORDER BY id").all()
        const out = { ids: [], macs: [] }
        for (const d of rows) {
          // linked to a host, or carrying an identity MAC: put back to known, never deleted
          const identity = d.host_id || store.db.prepare("SELECT 1 FROM net_macs WHERE device_id = ? AND (grade = 'hypervisor' OR attach IN ('pve', 'config'))").get(d.id)
          if (identity) {
            ns.setState(d.id, { state: 'known' }, { type: 'edited', detail: `legacy states purge: ${d.state}, linked to a host: back to known`, actor: MIGRATION_ACTOR, ts: t })
            audit?.log({ actor: MIGRATION_ACTOR, source: 'script', action: netAction(NET_VERB.PURGE_R4), target: `dev:${d.id}`, detail: `${d.state}, linked to a host: back to known` })
            continue
          }
          const res = ns.deleteDevice(d.id, { actor: MIGRATION_ACTOR, ts: t, reason: `legacy states purge: ${d.state}` })
          audit?.log({ actor: MIGRATION_ACTOR, source: 'script', action: netAction(NET_VERB.PURGE_R4), target: `dev:${d.id}`, detail: `legacy states purge: ${d.state}, deleted · ${res.summary}` })
          out.ids.push(d.id)
          out.macs.push(...res.macs)
        }
        store.kv.set(KV.LEGACY_PURGE, JSON.stringify({ at: new Date(t).toISOString(), n: out.ids.length, ids: out.ids }))
        return out
      })
    } catch (e) {
      // transaction rolled back, key not set: the purge is retried at the next start
      log.error(`network: legacy states purge: ${e.message}`)
      return none
    }
  }
  const strays = store.db.prepare("SELECT id, state FROM net_devices WHERE state NOT IN ('new', 'known')").all()
  if (strays.length && kvGet(store.kv, KV.LEGACY_PURGE)) log.error(`network: ${strays.length} device(s) in a removed state (${strays.slice(0, 5).map(d => `${d.id}:${String(d.state).slice(0, 12)}`).join(', ')})`)
  const tz = cfg.alerts?.timezone ?? 'Europe/Paris'
  // poll period: Pi-hole's (schema default: 60 s), and the same without Pi-hole
  const intervalMs = (net.sources.pihole?.intervalSec ?? RUN_PERIOD_SEC) * 1000
  // maximum age of the last passive poll whose names serve as hints for the probe's
  // poll
  const NAME_HINT_MAX_AGE_MS = 2 * intervalMs
  const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))

  // mDNS disabled → clean rollback at startup: mdns attributes deleted, displayed names
  // recomputed right away, digest list emptied
  if (!net.mdns?.enabled) dropMdnsNames()
  function dropMdnsNames() {
    try {
      ns.transaction(() => {
        const ids = ns.deleteAttrsBySource('mdns')
        if (ids.length) {
          const st = ns.load()
          const ops = []
          for (const id of ids) {
            const d = st.devices.get(id)
            if (!d) continue
            const shown = d.name ?? bestAttr(st.attrs.get(id) || [], 'name')?.value ?? null
            if (shown !== d.disp_name) ops.push({ op: 'updateDevice', device: id, fields: { disp_name: shown, updated_at: now() } })
          }
          ns.applyOps(ops)
        }
        if (store.kv.get('network.mdnsNamed')) store.kv.set('network.mdnsNamed', '[]')
      })
    } catch (e) {
      log.error(`network: mdns: name removal: ${e.message}`)
    }
  }

  let state = ns.load()
  // last state of each source and last observations (kept on failure)
  const status = {}
  const last = {}
  let lastRunAt = null
  for (const r of ns.runsSince(now() - DAY)) {
    status[r.source] = { ok: !!r.ok, at: r.ts, error: r.error, n: r.n, lastOkAt: r.ok ? r.ts : status[r.source]?.lastOkAt ?? null }
    lastRunAt = r.ts
  }
  // influx of new MACs: bounded refusal and episode, in memory (lost on restart)
  // floodSalt: tie-break salt of the influx list (tests only; random otherwise)
  let flood = emptyFlood(floodSalt)
  // alert keys without an object (merged or deleted record, removed MAC) → emitted with
  // cond: false + quietResolve for 15 min, then not at all; the engine then resolves them
  // without "recovered" or "stabilised". List persisted in kv: a restart within the
  // 15 min re-reads it
  const RETIRE_MS = 15 * MIN
  const retired = new Map((() => {
    try {
      return JSON.parse(store.kv.get('network.retired') || '[]').filter(([k, until]) => typeof k === 'string' && until > now())
    } catch {
      return []
    }
  })()) // key → expiry
  let isFiring = () => false // alert in progress (engine), wired by index.js (network.firing)
  const saveRetired = () => store.kv.set('network.retired', JSON.stringify([...retired]))
  function retireKey(key, t = now()) {
    retired.set(key, t + RETIRE_MS)
  }
  function retire(ids = [], macs = [], t = now()) {
    for (const id of ids) for (const r of ['net_new', 'net_down', 'net_ip_changed']) retireKey(`${r}:${id}`, t)
    for (const mac of macs) retireKey(`net_mac_added:${mac}`, t)
    saveRetired()
  }
  retire(purged.ids, purged.macs)

  // --- ARP probe and presence --------------------------------------------------------
  const arpCfg = net.sources.arp ?? null
  const arpIntervalMs = (arpCfg?.intervalSec ?? ARP_PERIOD_SEC) * 1000
  const cidrs = net.subnets.map(s => parseCidr(s.cidr)).filter(Boolean)
  // IP handover (recreated macvlan): history of the last 3 valid sweeps reduced to the ipIdentity
  // ranges (network.idScans, most recent first) and registry of IP-handover attachments
  // (network.ipHandover, formerly network.l1: MAC, record, IP, date, watched sweeps, escalation), in kv: a restart
  // loses neither the handover nor the watch
  const idRanges = net.ipIdentity.map(parseCidr).filter(Boolean)
  const readKv = (k, d) => {
    try {
      const v = JSON.parse(kvGet(store.kv, k) || 'null')
      return Array.isArray(v) ? v : d
    } catch {
      return d
    }
  }
  // IP-handover entries still valid: MAC still PENDING on its record (otherwise ignored, purged)
  const l1Entries = () => readKv(KV.IP_HANDOVER, []).filter(e => {
    const m = state.macs.get(e?.mac)
    return m && m.device_id === e.device && isPending(m)
  })
  const l1Active = () => new Set(l1Entries().filter(e => !e.escalated).map(e => e.mac))
  const l1Escalated = () => new Set(l1Entries().filter(e => e.escalated).map(e => e.mac))
  // consistency anchor: a sweep only counts if the gateway answers in it (a broken probe,
  // a down interface or filtered ARP would otherwise give an empty "ok" sweep).
  // Gateway: network.subnets[].gateway (optional override), otherwise the container's
  // default route on the LAN interface, re-read at each sweep; undeterminable: fail closed
  const configured = net.subnets.map(s => s.gateway).filter(Boolean)
  const lanIface = net.sources.neigh?.iface ?? 'eth0'
  let lastGateway = null // { ip, source } of the last sweep
  function resolveGateway() {
    if (configured.length) return { ips: configured, source: 'config' }
    let text
    try {
      text = routeText()
    } catch {
      return { error: tr('net.status.unknown_gateway') }
    }
    const g = defaultGateway(text, lanIface)
    if (g.error) return { error: g.error }
    if (!cidrs.some(c => inCidr(g.gateway, c))) return { error: tr('net.status.gateway_outside_lan') }
    return { ips: [g.gateway], source: 'route' }
  }
  const presenceCfg = net.presence
  let lastScan = null // last valid ARP sweep (see arpOnce)
  // successful sweeps (refRunsSince), reloaded from net_runs: a restart delays nothing
  let refRuns = arpCfg ? ns.arpRuns(200) : []
  let lastArpTs = status.arp?.at ?? refRuns.at(-1) ?? null // last file processed (ok or not)
  let lastBadKey = null // file without a readable timestamp, already reported
  let arpInstalled = null // file present on the last pass (null: not read yet)
  let arpAnomalies = null // counters of the last sweep (suspicious answers)
  let arpErrAt = 0
  const presenceSince = () => Number(store.kv.get('network.presenceSince')) || null
  // 'passive': no probe, no valid sweep yet, or silent probe (freshness only);
  // 'arp': reliable presence (no observation window).
  // probe state for the merge: 'off' without a probe or without a valid sweep,
  // 'on' in service, 'down' silent after being put in service (no creation)
  const probeState = t => (!arpCfg || presenceSince() == null ? 'off' : presenceMode(t) === 'arp' ? 'on' : 'down')
  function presenceMode(t) {
    const s = status.arp
    if (!arpCfg || presenceSince() == null || !s?.lastOkAt || t - s.lastOkAt > 3 * arpIntervalMs) return 'passive'
    return 'arp'
  }
  // effective profile: entered, otherwise fixed for a linked host, otherwise guessed (guess attribute)
  const profileOf = d => d.profile ?? (d.host_id ? 'fixed' : bestAttr(state.attrs.get(d.id) || [], 'profile')?.value ?? 'normal')

  // presence, sessions and rollup of a successful sweep (snapshot already merged)
  function presenceOps(scanTs, prevScanTs) {
    const since = presenceSince()
    const ops = []
    const after = []
    for (const d of state.devices.values()) {
      if (!d.primary_mac) continue
      const session = state.sessions.get(d.id)
      const profile = profileOf(d)
      const lp = d.last_present ?? null
      const from = absentSince(lp, since)
      const p = presenceOf({
        lastPresent: lp, presenceSince: since, profile, refRunsSince: refRuns.filter(x => x > from).length,
        prev: d.online ?? null, now: scanTs, cfg: presenceCfg, prevScanTs,
      })
      const sOps = sessionOps({ device: d.id, session, lastPresent: lp, online: p.online, ip: d.last_ip, now: scanTs, graceMs: graceMs(profile, presenceCfg) })
      ops.push(...sOps)
      if (p.changed) {
        const open = session && session.end == null
        const reopened = sOps.some(o => o.op === 'reopenSession')
        const at = p.online === 1 ? (open || reopened ? session.start : lp ?? scanTs) : p.online === 0 ? lp : null
        ops.push({ op: 'updateDevice', device: d.id, fields: { online: p.online, online_since: at, updated_at: scanTs } })
      }
      after.push({ id: d.id, online: p.online })
    }
    ops.push(...rollupOps(after, scanTs))
    return ops
  }

  // one pass (every 30 s): nothing if the file has not changed; synchronous, so it never
  // runs in the middle of a poll merge
  function arpOnce() {
    if (!arpCfg || stopped) return null
    const t = now()
    let r
    try {
      r = readArp({ file: arpCfg.file, cidrs, now: t, ...(arpFs ? { fs: arpFs } : {}), ...(arpUid != null ? { uid: arpUid } : {}) })
    } catch (e) {
      // file refused (origin): short error, without content, logged once per interval
      const error = errText(e)
      const repeat = status.arp?.error === error && t - arpErrAt < arpIntervalMs
      status.arp = { ...status.arp, ok: false, at: t, error }
      if (!repeat) {
        arpErrAt = t
        ns.applyOps([{ op: 'run', ts: t, source: 'arp', ok: false, error }])
        log.warn(`network: arp: ${error}`)
      }
      viewCache = null
      return null
    }
    arpInstalled = r.installed
    if (!r.installed) return null
    if (r.ts == null) {
      // file in a wrong format, without timestamp: reported once per version of the file
      const key = `m${r.mtime}`
      if (key === lastBadKey) return null
      lastBadKey = key
      status.arp = { ...status.arp, ok: false, at: t, error: r.error }
      ns.applyOps([{ op: 'run', ts: t, source: 'arp', ok: false, error: r.error }])
      viewCache = null
      return null
    }
    if (lastArpTs != null && r.ts <= lastArpTs) return null // already processed
    lastArpTs = r.ts
    let gwUnknown = false
    if (r.ok) {
      const gw = resolveGateway()
      if (gw.error) {
        r.ok = false
        r.error = gw.error
        gwUnknown = true
        lastGateway = null
      } else {
        lastGateway = { ip: gw.ips[0], source: gw.source }
        if (!r.hosts.some(h => gw.ips.includes(h.ip))) {
          r.ok = false
          r.error = tr('net.status.no_gateway')
        }
      }
    }
    // failure, or sweep without the gateway: presence frozen, presenceSince not set
    if (!r.ok) {
      status.arp = { ...status.arp, ok: false, at: r.ts, error: r.error, gwUnknown }
      ns.applyOps([{ op: 'run', ts: r.ts, source: 'arp', ok: false, error: r.error }])
      viewCache = null
      return null
    }
    const prevScanTs = refRuns.at(-1) ?? r.ts - arpIntervalMs
    refRuns = [...refRuns, r.ts].slice(-200)
    // first successful sweep (gateway present): start of reliable presence
    if (presenceSince() == null) store.kv.set('network.presenceSince', String(r.ts))
    status.arp = { ok: true, at: r.ts, error: null, n: r.hosts.length, ms: r.ms, lastOkAt: r.ts }
    arpAnomalies = r.anomalies
    const sightings = [...r.hosts, ...selfSightings(ifaces(), { iface: net.sources.neigh?.iface ?? 'eth0', cidrs, now: r.ts })]
    const nameHints = nameHintsAt(r.ts)
    // probe bootstrap: during the first 3 valid sweeps, a MAC that only the probe reveals
    // (static IP, DNS elsewhere, silent device) was already there: known and to review,
    // counted in the digest, without alert. FIXED ceiling of 50 in total; beyond that, or
    // after the 3rd sweep, normal path right away (new, ceiling, influx). Counters in kv
    const scans = Number(store.kv.get('network.arpBootstrapScans')) || 0
    const done = Number(store.kv.get('network.arpDiscoveredCount')) || 0
    const bootstrap = scans < ARP_BOOTSTRAP_SCANS
    const arpBaseline = bootstrap && done < ARP_BOOTSTRAP_MAX
    if (bootstrap) {
      store.kv.set('network.arpBootstrapScans', String(scans + 1))
      // unknown MACs seen during the bootstrap ("X seen" in the digest), bounded
      const seenUnknown = new Set(JSON.parse(store.kv.get('network.arpBootstrapUnknown') || '[]'))
      for (const h of r.hosts) if (!state.macs.has(h.mac) && seenUnknown.size < 4096) seenUnknown.add(h.mac)
      store.kv.set('network.arpBootstrapUnknown', JSON.stringify([...seenUnknown]))
    }
    // IP handover: sweep n (MACs per IP, conflicts), history, records with an IP handover in the last hour
    const arpScan = { ts: r.ts, byIp: new Map(), macs: new Set(), conflicts: new Set(r.anomalies.conflicts.map(c => c.key)) }
    for (const h of r.hosts) {
      arpScan.macs.add(h.mac)
      arpScan.byIp.set(h.ip, [...(arpScan.byIp.get(h.ip) ?? []), h.mac])
    }
    // summary of the LAST valid sweep (MACs per IP, conflicts), in memory only: never
    // persisted, so no mDNS attachment before a sweep after startup
    lastScan = { ts: r.ts, byIp: arpScan.byIp, conflicts: arpScan.conflicts }
    const idHistory = readKv('network.idScans', [])
    const l1Recent = new Set(ns.eventsSince('mac_added', t - 3600_000).filter(e => e.device_id != null && isIpHandover(e.detail)).map(e => e.device_id))
    const nameWait = nameWaitAt(r.hosts, nameHints, t, arpBaseline)
    const m = mergeSightings({ ...state, flood }, sightings, { cfg, now: t, oui, baseline: arpBaseline, baselineMax: arpBaseline ? ARP_BOOTSTRAP_MAX - done : null, probe: probeState(t),
      arpScan, idHistory, l1Recent, l1Macs: l1Active(), l1Escalated: l1Escalated(), agentIndex: agentIndexAt(t), agentSuspended: agentInputs(t).agentSuspended,
      agentLate: agentInputs(t).agentLate, agentFirst: new Set(), nameHints, nameWait })
    if (m.flood.episode && !flood.episode) log.warn('network: flood of new MACs (ARP probe), creations suspended')
    flood = m.flood
    // suspicious answers (possible spoofing): one event per IP or MAC and per 24 h, without alert.
    // Duplicate answers alone: a late answer to the 1st request crosses arp-scan's retry
    // (noise, ≈ once a day per device); reported only if the MAC gives some on DUP_MIN of
    // the last DUP_WINDOW sweeps (an active clone gives some on each one)
    const dupScans = [r.anomalies.conflicts.filter(c => c.kind === 'dup').map(c => c.key).slice(0, 256), ...readKv('network.arpDups', []).filter(Array.isArray)].slice(0, DUP_WINDOW)
    store.kv.set('network.arpDups', JSON.stringify(dupScans))
    const dupCount = key => dupScans.filter(list => list.includes(key)).length
    const conflictOps = []
    const recent = new Set(ns.eventsSince('arp_conflict', r.ts - DAY).map(e => arpKey(e.detail)))
    for (const c of r.anomalies.conflicts) {
      if (c.kind === 'dup' && dupCount(c.key) < DUP_MIN) continue
      const k = arpKey(c.detail)
      if (recent.has(k)) continue
      recent.add(k)
      const device = c.key.startsWith('mac:') ? state.macs.get(c.key.slice(4))?.device_id
        : [...state.devices.values()].find(d => d.last_ip === c.key.slice(3))?.id
      conflictOps.push({ op: 'insertEvent', device: device ?? null, type: 'arp_conflict', ts: r.ts, detail: c.detail })
    }
    ns.transaction(() => {
      const refs = ns.applyOps([{ op: 'run', ts: r.ts, source: 'arp', ok: true, ms: r.ms, n: r.hosts.length }, ...m.ops, ...conflictOps])
      const found = m.ops.filter(o => o.op === 'insertDevice' && o.fields.review === 1).map(o => refs.get(o.ref))
      if (arpBaseline && found.length) {
        // exact counter (the digest), list of the first 50 (the names)
        store.kv.set('network.arpDiscoveredCount', String(done + found.length))
        const list = JSON.parse(store.kv.get('network.arpDiscovered') || '[]')
        store.kv.set('network.arpDiscovered', JSON.stringify([...list, ...found].slice(0, 50)))
      }
      state = ns.load()
      // IP handover: watch of the existing entries (3 sweeps: another MAC on the IP, a dup or a
      // conflict → escalation), purge, new entries, sweep history
      const reg = l1Entries().map(e => {
        if (e.escalated || !(e.watch > 0)) return e
        const other = (arpScan.byIp.get(e.ip) ?? []).some(x => x !== e.mac) || arpScan.conflicts.has(`ip:${e.ip}`) || arpScan.conflicts.has(`mac:${e.mac}`)
        return other ? { ...e, escalated: true, watch: 0 } : { ...e, watch: e.watch - 1 }
      })
      for (const x of m.l1) reg.push({ mac: x.mac, device: x.device, ip: x.ip, at: r.ts, watch: 3, escalated: false })
      store.kv.set(KV.IP_HANDOVER, JSON.stringify(reg.slice(-200)))
      const ips = {}
      for (const [ip, list] of arpScan.byIp) if (idRanges.some(c => inCidr(ip, c))) ips[ip] = list
      store.kv.set('network.idScans', JSON.stringify([{ ts: r.ts, ips }, ...idHistory].slice(0, 3)))
      ns.applyOps(presenceOps(r.ts, prevScanTs))
    })
    state = ns.load()
    viewCache = null
    return { at: r.ts, stats: m.stats }
  }

  const readers = {}
  if (net.sources.pihole && pihole) {
    readers.pihole = () => readDevices(pihole)
    readers.dhcp = t => readLeases(pihole, t)
  }
  if (net.sources.neigh) readers.neigh = t => readNeigh({ iface: net.sources.neigh.iface, now: t, ...(exec ? { run: exec } : {}) })
  if (net.sources.pve && sources?.guestNics) {
    readers.pve = async t => {
      const clusters = await sources.guestNics()
      if (clusters.length && clusters.every(c => c.error)) throw new Error(clusters.map(c => `${c.id} : ${c.error}`).join(' · '))
      const s = guestSightings(clusters, cfg, t)
      s.partial = clusters.filter(c => c.error).map(c => `${c.id} : ${c.error}`).join(' · ') || null
      return s
    }
  }

  // agent reports (function passed by server/index.js, no import of agents.js here);
  // macvlan/ipvlan containers and neighbors, reports less than 5 min old
  const agentNow = t => (agentReports ? agentSightings(agentReports(), cfg, t) : [])
  if (agentReports) readers.agent = async t => agentNow(t)
  const agentIndexAt = t => containerIndex(agentNow(t))
  // container identity conflicts (network.agentConflicts: { device, key, other, current,
  // at }): warning alert, container rule suspended for the record until a human decision
  // (detach, merge, delete: writes.js lifts the entry); late associations
  // (network.agentLate: { device, key, at, known }); first v6 report per host
  // (network.agentV6First: { host: date })
  const kvJson = (k, d) => {
    try {
      const v = JSON.parse(store.kv.get(k) || 'null')
      return v && typeof v === 'object' ? v : d
    } catch {
      return d
    }
  }
  const agentConflicts = () => (Array.isArray(kvJson('network.agentConflicts', [])) ? kvJson('network.agentConflicts', []) : []).filter(e => state.devices.has(e?.device))
  const agentLateList = () => (Array.isArray(kvJson('network.agentLate', [])) ? kvJson('network.agentLate', []) : []).filter(e => state.devices.has(e?.device))
  function agentInputs(t) {
    const v6 = new Set((agentReports ? agentReports() : []).filter(r => r.fast?.version >= 6 && r.at != null && t - r.at <= 5 * MIN).map(r => r.host))
    const known = kvJson('network.agentV6First', {})
    return {
      agentFirst: new Set([...v6].filter(h => known[h] == null)),
      agentLate: new Map(agentLateList().map(e => [e.device, e.at])),
      // the two records involved (the one carrying the announced MAC, the one holding the identity)
      agentSuspended: new Set(agentConflicts().flatMap(e => [e.device, e.other].filter(x => x != null))),
      v6, known,
    }
  }
  function agentAfter(t, inputs, out) {
    if (!agentReports) return
    const known = { ...inputs.known }
    for (const h of inputs.v6) if (known[h] == null) known[h] = t
    store.kv.set('network.agentV6First', JSON.stringify(known))
    const conflicts = agentConflicts()
    for (const c of out?.conflicts ?? []) {
      if (conflicts.some(e => e.device === c.device && e.key === c.key)) continue
      conflicts.push({ ...c, at: t })
      ns.applyOps([{ op: 'insertEvent', device: c.device, type: 'agent_conflict', ts: t,
        detail: agentConflictDetail(c.key, c.other, c.current) }])
    }
    store.kv.set('network.agentConflicts', JSON.stringify(conflicts.slice(-200)))
    // late ones: kept as long as the record is not confirmed ("Known" after the association)
    const late = [...agentLateList(), ...(out?.late ?? [])].filter(e => !(state.devices.get(e.device)?.acked_at > e.at))
    store.kv.set('network.agentLate', JSON.stringify(late.slice(-200)))
  }
  // persisted record → container associations (map, cycles, record): a silent agent or one
  // back on v5 switches nothing off.
  // An unconfirmed late association does not place the record under the host
  const containerOf = () => {
    const late = new Set(agentLateList().map(e => e.device))
    return new Map([...containerAssociations(state.attrs).byDevice].filter(([id]) => !late.has(id)).map(([id, c]) => [id, { host: c.host, name: c.name, network: c.network }]))
  }

  const baselineOn = () => !store.kv.get('network.baseline')

  let running = null
  let stopped = false
  async function runOnce() {
    const t = now()
    const names = Object.keys(readers)
    const results = await Promise.allSettled(names.map(n => {
      const t0 = Date.now()
      return readers[n](t).then(v => ({ v, ms: Date.now() - t0 }))
    }))
    const runOps = []
    results.forEach((r, i) => {
      const n = names[i]
      if (r.status === 'fulfilled') {
        last[n] = r.value.v
        const error = r.value.v.partial ?? null
        status[n] = { ok: true, at: t, error, n: r.value.v.length, lastOkAt: t }
        runOps.push({ op: 'run', ts: t, source: n, ok: true, ms: r.value.ms, n: r.value.v.length, error })
      } else {
        const error = errText(r.reason)
        status[n] = { ...status[n], ok: false, at: t, error }
        runOps.push({ op: 'run', ts: t, source: n, ok: false, error })
        log.warn(`network: ${n}: ${error}`)
      }
    })
    const piholeOk = status.pihole?.ok && status.pihole.at === t
    const sightings = [...Object.values(last).flat(), ...configSightings(cfg, t)]
    const baseline = baselineOn()
    const agentIn = agentInputs(t)
    // stable mDNS names, attached by the last valid sweep, and ONLY with the probe in service
    const mdnsNames = mdnsCfg ? stableNames(t) : []
    const m = mergeSightings({ ...state, flood }, sightings, { cfg, now: t, baseline, oui, probe: probeState(t), l1Macs: l1Active(), l1Escalated: l1Escalated(),
      agentIndex: containerIndex(last.agent ?? []), agentFirst: agentIn.agentFirst, agentLate: agentIn.agentLate, agentSuspended: agentIn.agentSuspended,
      mdnsNames, mdnsScan: probeState(t) === 'on' ? lastScan : null })
    if (m.flood.episode && !flood.episode) log.warn(`network: flood of new MACs (more than ${net.maxNewPerCycle} per read), creations suspended`)
    flood = m.flood
    runOps.push({ op: 'run', ts: t, source: 'merge', ok: true, n: m.stats.sightings, error: m.stats.capped ? tr('net.status.capped', { count: m.stats.capped }) : null })
    ns.applyOps([...runOps, ...m.ops])
    state = ns.load()
    agentAfter(t, agentIn, m.agent)
    if (mdnsCfg) mdnsAfter(m.mdns)
    // bootstrap: records created during the first 30 successful Pi-hole polls are "known, to review"
    if (baseline && piholeOk) {
      const n = Number(store.kv.get('network.baselineRuns') || 0) + 1
      store.kv.set('network.baselineRuns', n)
      if (n >= BASELINE_RUNS) store.kv.set('network.baseline', new Date(t).toISOString())
    }
    lastRunAt = t
    viewCache = null
    return { at: t, stats: m.stats }
  }

  // a single poll at a time; a call during a poll waits for it; none after stop()
  function runAll() {
    if (stopped) return Promise.resolve(null)
    running ??= runOnce().catch(e => {
      log.error(`network: read: ${e.message}`)
      return null
    }).finally(() => {
      running = null
    })
    return running
  }

  // rotating MACs: the sweep can see an unknown random MAC before the passive poll has read
  // its lease; without a name, it would create a record instead of joining its own. Such a
  // MAC waits ONE sweep (so at least one passive poll), never more: a MAC still unknown from
  // one sweep to the next no longer waits. No waiting during a bootstrap or an influx, nor
  // for an ipIdentity range, a container MAC known to the agent or without a name source
  let arpUnknown = new Set()
  function nameWaitAt(hosts, hints, t, skip) {
    const prev = arpUnknown
    arpUnknown = new Set(hosts.filter(h => !state.macs.has(h.mac)).map(h => h.mac))
    if (skip || flood.episode || !(readers.dhcp || readers.pihole)) return new Set()
    const agentIndex = agentIndexAt(t)
    return new Set(hosts.filter(h => arpUnknown.has(h.mac) && !prev.has(h.mac) && !hints.has(h.mac) && !flood.refused.has(h.mac)
      && gradeMac(h.mac, { source: 'arp' }) === 'weak' && !idRanges.some(c => inCidr(h.ip, c)) && !agentIndex.has(h.mac)).map(h => h.mac))
  }

  // name hints (MAC → name) taken from the LAST successful passive poll, if it is less than
  // NAME_HINT_MAX_AGE_MS old: current DHCP leases first, then Pi-hole; names cleaned,
  // generic ones excluded. They are only used for attachment by name (merge.js), nothing else
  function nameHintsAt(t) {
    const hints = new Map()
    const fresh = n => status[n]?.lastOkAt != null && t - status[n].lastOkAt < NAME_HINT_MAX_AGE_MS
    const add = (list, keep) => {
      for (const x of list || []) {
        const mac = normalizeMac(x.mac)
        const name = cleanName(x.name)
        if (mac && name && !isGenericName(name) && keep(x) && !hints.has(mac)) hints.set(mac, name)
      }
    }
    if (fresh('dhcp')) add(last.dhcp, x => (x.leaseExpires ?? 0) > t)
    if (fresh('pihole')) add(last.pihole, () => true)
    return hints
  }

  // --- views ------------------------------------------------------------------

  // state of the pve source: { ok, stale, partial, lastOkAt }; null without a pve source
  const staleOf = (n, s, t) => !s?.lastOkAt || t - s.lastOkAt > 3 * Math.max(n === 'pve' ? PVE_PERIOD_MS : intervalMs, intervalMs)
  function health(t = now()) {
    if (!readers.pve) return { pve: null }
    const s = status.pve
    return { pve: { ok: s ? s.ok : null, stale: staleOf('pve', s, t), partial: s?.ok ? s.error ?? null : null, lastOkAt: s?.lastOkAt ?? null } }
  }

  function sourceView(t) {
    const out = Object.fromEntries(Object.keys(readers).map(n => {
      const s = status[n]
      return [n, s ? {
        ok: s.ok, at: iso(s.at), error: s.error ?? null, n: s.n ?? null,
        stale: staleOf(n, s, t),
      } : { ok: null, at: null, error: null, n: null, stale: true }]
    }))
    // ARP probe: "not installed" as long as the file does not exist (ok null)
    if (arpCfg) {
      const s = status.arp
      out.arp = !s || (arpInstalled === false && !s.lastOkAt)
        ? { ok: null, at: null, error: null, n: null, stale: true, installed: arpInstalled !== false ? null : false, anomalies: null }
        : {
          ok: arpInstalled === false ? false : s.ok, at: iso(s.at), error: arpInstalled === false ? tr('net.status.no_probe_file') : s.error ?? null, n: s.n ?? null, ms: s.ms ?? null,
          stale: !s.lastOkAt || t - s.lastOkAt > 3 * arpIntervalMs, installed: arpInstalled, gatewayUnknown: !!s.gwUnknown && !s.ok,
          anomalies: arpAnomalies && { invalid: arpAnomalies.invalid, extraMacs: arpAnomalies.extraMacs, wideMacs: arpAnomalies.wideMacs, multiMacIps: arpAnomalies.multiMacIps, hdrmac: arpAnomalies.hdrmac, dup: arpAnomalies.dup },
        }
    }
    // MAC influx: visible here during the episode (and net_new_flood alert)
    if (flood.episode) out.merge = { ok: false, at: iso(flood.episode.since), error: tr('net.status.flood', { count: flood.refused.size, until: iso(flood.episode.lastOver + HOUR) }), n: flood.refused.size, stale: false }
    return out
  }

  // number of MACs (and pending ones) per device, recomputed when the snapshot changes
  let macCounts = { of: null, map: new Map(), pending: new Map() }
  const counts = () => {
    if (macCounts.of !== state) {
      const map = new Map()
      const pending = new Map()
      for (const m of state.macs.values()) {
        map.set(m.device_id, (map.get(m.device_id) ?? 0) + 1)
        if (isPending(m)) pending.set(m.device_id, (pending.get(m.device_id) ?? 0) + 1)
      }
      macCounts = { of: state, map, pending }
    }
    return macCounts
  }
  const macCount = id => counts().map.get(id) ?? 0

  // 24 h band of a record (24 one-hour cells, cellOf); bands: ns.bands24h()
  const bandOf = (bands, id) => (bands ? (bands.per.get(id) ?? Array(bands.count).fill(null)).map(c => (c ? cellOf(c.scans, c.seen) : '-')).join('') : null)

  function deviceView(d, t, bands = null) {
    const primary = state.macs.get(d.primary_mac)
    return {
      id: d.id, name: d.disp_name ?? null, type: d.disp_type ?? null, icon: d.icon ?? null, state: d.state, review: !!d.review,
      freshness: freshnessOf({ lastSeen: d.last_seen, lastDhcp: d.last_dhcp, now: t, activeMin: net.activeMin }),
      lastSeen: iso(d.last_seen), lastDhcp: iso(d.last_dhcp), firstSeen: iso(d.first_seen),
      ip: d.last_ip ?? null, mac: d.primary_mac ?? null, macs: macCount(d.id), random: !!primary?.random, grade: primary?.grade ?? null,
      vendor: d.vendor ?? null, hostId: d.host_id ?? null, hostSrc: d.host_src ?? null, location: d.location ?? null, origin: d.origin ?? null,
      pending: counts().pending.get(d.id) ?? 0,
      // presence: online NULL as long as it is not computed (no probe)
      online: d.online ?? null, onlineSince: iso(d.online_since), lastPresent: iso(d.last_present),
      profile: profileOf(d), profileSet: d.profile != null, alertDown: !!d.alert_down, alertSeverity: d.alert_severity ?? null,
      expectedIp: d.expected_ip ?? null,
      band24h: bandOf(bands, d.id),
    }
  }

  // admin: admin session (reasons and authors shown); otherwise read without them (anonymous
  // read, security.anonymousRead)
  let viewCache = null
  function view({ admin = false } = {}) {
    const t = now()
    if (viewCache && t - viewCache.t < 15_000) return admin ? withAdmin(viewCache.v) : viewCache.v
    const bands = arpCfg ? ns.bands24h(t) : null
    const devices = [...state.devices.values()].filter(d => d.primary_mac).map(d => deviceView(d, t, bands))
      .sort((a, b) => (a.ip && b.ip ? ipKey(a.ip) - ipKey(b.ip) : a.ip ? -1 : b.ip ? 1 : a.id - b.id))
    const listed = devices // no hidden state: every record counts
    const by = f => listed.filter(d => d.freshness === f).length
    const counts = {
      total: listed.length, active: by('active'), idle: by('idle'), dhcp: by('dhcp'), stale: by('stale'),
      new: listed.filter(d => d.state === 'new').length, review: listed.filter(d => d.review).length,
      pending: devices.reduce((n, d) => n + d.pending, 0),
      online: listed.filter(d => d.online === 1).length,
      offline: listed.filter(d => d.online === 0).length,
      unknown: listed.filter(d => d.online == null).length,
    }
    const mode = presenceMode(t)
    const dismissed = JSON.parse(store.kv.get('network.dismissed') || '[]')
    const families = suggestFamilies(state, { dismissed })
    const v = {
      enabled: true, presence: mode, presenceSince: iso(presenceSince()), gateway: arpCfg ? lastGateway : null, arpIntervalSec: arpCfg ? arpIntervalMs / 1000 : null,
      generatedAt: iso(t), lastRunAt: iso(lastRunAt), intervalSec: intervalMs / 1000,
      activeMin: net.activeMin, baseline: baselineOn(), alertsSince: iso(alertsSince), sources: { ...sourceView(t), probe: probeSource(), mdns: mdnsSource() }, counts, devices,
      types: DEVICE_TYPES,
      suggestions: [...families, ...suggestMerges(state, { dismissed, families, probe: probeState(t), seen: state.seen })],
      // without reason or author outside an admin session (anonymous read possible); reasons stay in the audit log
      rules: state.rules.map(r => ({ id: r.id, prefix: r.prefix, action: r.action, deviceId: r.device_id, name: r.name, createdAt: iso(r.created_at) })),
    }
    viewCache = { t, v }
    return admin ? withAdmin(v) : v
  }
  const ruleAdmin = r => ({ reason: r.reason, createdBy: r.created_by })
  const withAdmin = v => ({ ...v, rules: v.rules.map(r => ({ ...r, ...ruleAdmin(state.rules.find(x => x.id === r.id) ?? {}) })) })

  // full record: MACs, last view per source, addresses, provenance, events
  function device(id, { servicesOf = () => [], admin = false } = {}) {
    const t = now()
    const d = state.devices.get(Number(id))
    const x = d && ns.detail(d.id, t)
    if (!x) return null
    const chosen = new Map(['name', 'hostname', 'vendor', 'type'].map(a => [a, bestAttr(x.attrs, a)]))
    const host = hostsById.get(d.host_id)
    return {
      ...deviceView(d, t, arpCfg ? ns.bands24h(t) : null),
      band30d: arpCfg ? ns.daily(d.id, 30, t).cells.map(c => (c ? cellOf(c.scans, c.seen) : '-')).join('') : null,
      sessions: x.sessions.map(s => ({ start: iso(s.start), end: iso(s.end), ip: s.ip, origin: s.origin })),
      saisie: { name: d.name, type: d.type, location: d.location, notes: d.notes, profile: d.profile ?? null, expectedIp: d.expected_ip ?? null, alertDown: !!d.alert_down, alertSeverity: d.alert_severity ?? null },
      host: host ? { id: host.id, name: host.name, kind: host.kind, ip: host.ip ?? null, env: host.env } : null,
      macs: x.macs.map(m => ({
        mac: m.mac, grade: m.grade, random: !!m.random, firstSeen: iso(m.first_seen), lastSeen: iso(m.last_seen), lastIp: m.last_ip,
        attach: m.attach ?? null, pending: isPending(m), confirmedBy: m.confirmed_by ?? null, confirmedAt: iso(m.confirmed_at),
        // identity MAC (pve, config); a MAC seen only by the agent is not one
        identity: (m.grade === 'hypervisor' && !agentOnly(m, state.seen)) || m.attach === 'pve' || m.attach === 'config',
      })),
      // deletion allowed? same computation as the deletion itself (deletionBlock)
      deletion: (b => ({ allowed: !b, why: b?.why ?? null }))(deletionBlock(d, state, { cfg, now: t, health: health(t) })),
      seen: x.seen.map(s => ({ mac: s.mac, source: s.source, lastSeen: iso(s.last_seen), lastIp: s.last_ip })),
      addresses: x.addresses.map(a => ({ ip: a.ip, mac: a.mac, firstSeen: iso(a.first_seen), lastSeen: iso(a.last_seen), source: a.source })),
      // informative name announced over mDNS, exposed ONLY HERE (and filtered out of attrs)
      mdnsName: mdnsNameOf(d, x.attrs),
      attrs: x.attrs.filter(a => a.attr !== 'mdns_name').map(a => ({
        attr: a.attr, source: a.source, value: a.value, rank: a.rank, seenAt: iso(a.seen_at),
        // retained: best discovered value, and no manual entry replaces it
        chosen: ({ name: d.name, type: d.type })[a.attr] == null && chosen.get(a.attr)?.source === a.source && chosen.get(a.attr)?.value === a.value,
      })),
      // human writes: neither reason nor author address outside an admin session (anonymous read)
      events: x.events.map(e => ({ at: iso(e.ts), type: e.type, detail: e.actor && !admin ? null : eventText(e.type, e.detail), actor: e.actor ? (admin ? e.actor : actorKind(e.actor)) : null })),
      services: d.last_ip ? servicesOf(d.last_ip, d.host_id) : [],
      // services recognized by the probe (for everyone), last pass; raw ports for the admin
      // only; never the reason or the author of a request
      ...probeView(d, admin),
      // parent on the map: same computation as the map, without reason or author
      mapParent: deviceParent(d, { cfg, devices: state.devices, links: state.links ?? [], gateway: currentGateway(), macs: state.macs, containerOf: containerOf() }),
      rules: state.rules.filter(r => r.device_id === d.id).map(r => ({ id: r.id, prefix: r.prefix, action: r.action, name: r.name, ...(admin ? ruleAdmin(r) : {}) })),
      ranks: RANK,
    }
  }

  // { value, seenAt, conflict } | null; null also if it equals (case-insensitive) the displayed
  // name; conflict recomputed on read: displayed name of ANOTHER record (neither id nor link)
  function mdnsNameOf(d, attrs) {
    const a = attrs.find(x => x.attr === 'mdns_name' && x.source === 'mdns')
    if (!a) return null
    const lower = String(a.value).toLowerCase()
    if ((d.disp_name ?? '').toLowerCase() === lower) return null
    const conflict = [...state.devices.values()].some(o => o.id !== d.id && o.disp_name && o.disp_name.toLowerCase() === lower)
    return { value: a.value, seenAt: iso(a.seen_at), conflict }
  }

  // --- alerts, digest, bot --------------------------------------------------------

  // parentsOf: ancestors of a linked host (alerts/rules.js), parents for net_down
  const signals = (t, { parentsOf = () => [] } = {}) => {
    const before = retired.size
    for (const [k, until] of retired) if (t > until) retired.delete(k)
    if (retired.size !== before) saveRetired()
    const since = presenceSince()
    const presence = arpCfg ? { since, parentsOf, probe: probeState(t) } : null
    // records recreated by the return of a deleted MAC (returned event)
    const returned = new Set(alertsSince == null ? [] : ns.eventsSince('returned', alertsSince).map(e => e.device_id).filter(id => id != null))
    return networkSignals({ devices: state.devices, macs: state.macs, seen: state.seen, sources: sourceView(t), flood, retired: [...retired.keys()], presence, l1Escalated: l1Escalated(), agentConflicts: agentConflicts(), returned },
      { now: t, alertsSince, severity: net.alerts.newSeverity, tz })
  }

  // online devices per hour (History tab), from the rollup; days: 7, 30 or 90
  function history(days, t = now()) {
    const n = [7, 30, 90].includes(Number(days)) ? Number(days) : 7
    const since = Math.floor(t / HOUR) * HOUR - n * DAY
    return { enabled: !!arpCfg, days: n, points: ns.history(since).map(r => ({ t: iso(r.hour), online: r.online, known: r.known })) }
  }

  const nameOf = deviceLabel
  // MAC in a text (event detail) → label of its record, the MAC if it has none
  const MAC_IN_TEXT = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/g
  const macLabel = mac => {
    const d = state.devices.get(state.macs.get(mac)?.device_id)
    return d ? nameOf(d) : mac
  }
  const listNames = (list, max = 5) => list.slice(0, max).map(nameOf).join(', ') + (list.length > max ? ', …' : '')

  // Network section of the digest (plain text: digest.js applies t()); mark: the line
  // "appeared before alerts were enabled" is only given once
  function digestLines({ mark = false, now: t = now() } = {}) {
    const v = view()
    const all = [...state.devices.values()].filter(d => d.primary_mac)
    const live = all
    const fresh = live.filter(d => d.state === 'new' && d.created_at >= alertsSince)
    const pendingMacs = [...state.macs.values()].filter(isPending)
    const pendingDevices = [...new Set(pendingMacs.map(m => m.device_id))].map(id => state.devices.get(id)).filter(Boolean)
    // presence figures: "online" only with the probe (never Pi-hole freshness)
    const parts = [v.presence === 'arp' ? tr('net.digest.counts_arp', { total: v.counts.total, online: v.counts.online, offline: v.counts.offline })
      : tr('net.digest.counts', { total: v.counts.total, active: v.counts.active })]
    if (fresh.length) parts.push(tr('net.digest.new', { count: fresh.length, list: listNames(fresh) }))
    if (pendingMacs.length) parts.push(tr('net.digest.pending', { count: pendingMacs.length, list: listNames(pendingDevices) }))
    if (v.counts.review) parts.push(tr('net.digest.review', { count: v.counts.review }))
    const down = SOURCE_ORDER.filter(n => v.sources[n] && (!v.sources[n].ok || v.sources[n].stale))
    parts.push(down.length ? tr('net.digest.sources', { list: down.map(n => {
      const ok = status[n]?.lastOkAt
      return tr('net.digest.source_error', { name: n, since: ok ? tr('net.digest.source_since', { h: Math.max(1, Math.round((t - ok) / HOUR)) }) : '' })
    }).join(', ') }) : tr('net.digest.sources_ok'))
    const lines = [tr('net.digest.line', { parts: parts.join(' · ') }).slice(0, 590)]
    // appeared before alertsSince: a single line, only once
    const early = live.filter(d => d.state === 'new' && d.created_at < alertsSince)
    if (early.length && !store.kv.get('network.preAlertsDigested')) {
      lines.push(tr('net.digest.early', { list: listNames(early) }))
      if (mark) store.kv.set('network.preAlertsDigested', new Date(t).toISOString())
    }
    // attachments by a validated family (24 h): without alert, but never unnoticed
    const byRule = [...state.macs.values()].filter(m => m.attach === 'rule' && m.confirmed_at != null && t - m.confirmed_at < DAY)
    if (byRule.length) {
      lines.push(`${tr('net.digest.by_rule', { count: byRule.length, list: byRule.slice(0, 5).map(m => tr('net.digest.mac_to', { mac: m.mac, name: nameOf(state.devices.get(m.device_id) ?? { id: m.device_id }) })).join(', ') })}${byRule.length > 5 ? ', …' : ''}`)
    }
    // legacy-state purge: one line, only once; human deletions of the last 24 h
    const purge = JSON.parse(kvGet(store.kv, KV.LEGACY_PURGE) || 'null')
    if (purge?.n && !kvGet(store.kv, KV.LEGACY_PURGE_DIGESTED)) {
      lines.push(tr('net.digest.purge', { count: purge.n }))
      if (mark) store.kv.set(KV.LEGACY_PURGE_DIGESTED, new Date(t).toISOString())
    }
    // late associations of an already known record with a container (24 h)
    const late = agentLateList().filter(e => e.known && t - e.at < DAY)
    if (late.length) lines.push(`${tr('net.digest.late', { count: late.length, list: late.slice(0, 5).map(e => `${nameOf(state.devices.get(e.device))} → ${plain(e.key)}`).join(', ') })}${late.length > 5 ? ', …' : ''}`)
    // ports opened or closed on the infrastructure records (24 h), without an immediate message
    const ports = probe.digestLine(t)
    if (ports) lines.push(ports)
    // records named over mDNS since the last digest (never a rename): one line
    const named = readKv('network.mdnsNamed', []).filter(Number.isInteger).map(id => state.devices.get(id)).filter(Boolean)
    if (named.length) {
      lines.push(`${tr('net.digest.mdns', { named: tr('net.digest.named', { count: named.length }), list: named.slice(0, 5).map(d => nameOf(d)).join(', ') })}${named.length > 5 ? ', …' : ''}`)
    }
    if (mark && store.kv.get('network.mdnsNamed') && store.kv.get('network.mdnsNamed') !== '[]') store.kv.set('network.mdnsNamed', '[]')
    const deleted = ns.eventsSince('deleted', t - DAY).filter(e => eventActor(e.actor) !== MIGRATION_ACTOR)
    if (deleted.length) lines.push(tr('net.digest.deleted', { count: deleted.length }))
    // discovered by the probe during its bootstrap: a single line, only once, with the real
    // totals (X: unknown MACs seen during the first 3 sweeps; Y: records created)
    const y = Number(store.kv.get('network.arpDiscoveredCount')) || 0
    if (y && !store.kv.get('network.arpDiscoveredDigested')) {
      const x = JSON.parse(store.kv.get('network.arpBootstrapUnknown') || '[]').length
      const discovered = JSON.parse(store.kv.get('network.arpDiscovered') || '[]').map(id => state.devices.get(id)).filter(Boolean)
      lines.push(tr('net.digest.arp_found', { seen: tr('net.digest.arp_seen', { count: x }), review: y, list: listNames(discovered, 8) }))
      if (mark) store.kv.set('network.arpDiscoveredDigested', new Date(t).toISOString())
    }
    // suspicious ARP answers (24 h): without alert, reported here
    const conflicts = ns.eventsSince('arp_conflict', t - DAY)
    // "MAC x : …" → name of the record; "IP x : 2 MAC (a, b)" → the IP, then the name of each MAC;
    // recognized format (lib/network/events.js): through the catalog; otherwise the original text
    const conflictText = e => {
      const c = arpConflict(plain(e.detail), macLabel)
      if (c) return tr('net.event.arp.line', c)
      // unknown shape: shown with its own separator (a former detail keeps " : ")
      const raw = plain(e.detail)
      const sep = raw.includes(' : ') ? ' : ' : EV.SEP
      const [key, ...rest] = raw.split(sep)
      return `${key.startsWith(EV.MAC) ? macLabel(key.slice(EV.MAC.length)) : key}${sep}${rest.join(sep).replace(MAC_IN_TEXT, macLabel)}`
    }
    if (conflicts.length) lines.push(`${tr('net.digest.conflicts', { list: conflicts.slice(0, 5).map(conflictText).join(' ; ') })}${conflicts.length > 5 ? ` ; … (${conflicts.length})` : ''}`)
    // back after a deletion (24 h): one alert each, and one line here
    const back = [...new Set(ns.eventsSince('returned', t - DAY).map(e => e.device_id))].map(id => state.devices.get(id)).filter(Boolean)
    if (back.length) lines.push(tr('net.digest.returned', { list: listNames(back) }))
    return lines
  }

  // bot search (/appareil): substring of the name, MAC or vendor, exact IP
  function search(text) {
    const q = String(text ?? '').trim().toLowerCase().slice(0, 64)
    if (!q) return []
    // an integer: the id of the record ("12" or "#12")
    const id = /^#?(\d{1,10})$/.exec(q)
    if (id) {
      const d = state.devices.get(Number(id[1]))
      return d?.primary_mac ? [deviceView(d, now())] : []
    }
    return [...state.devices.values()].filter(d => d.primary_mac && (
      d.last_ip === q
      || [d.disp_name, d.vendor].some(x => x && String(x).toLowerCase().includes(q))
      || [...state.macs.values()].some(m => m.device_id === d.id && m.mac.includes(q))
    )).map(d => deviceView(d, now()))
  }

  // bot buttons (n, c, d): state checked at the very moment of the action (replay, forged or
  // already handled data → null); ref: record id, or MAC as 12 hexadecimal digits.
  // There is no i (Ignore) button any more
  function botCheck(action, ref) {
    if (action === 'n') {
      const d = /^\d{1,10}$/.test(ref) ? state.devices.get(Number(ref)) : null
      if (!d || d.state !== 'new') return null
      return { title: nameOf(d), id: d.id }
    }
    if (action !== 'c' && action !== 'd') return null
    if (!/^[0-9a-f]{12}$/.test(ref)) return null
    const mac = ref.match(/../g).join(':')
    const m = state.macs.get(mac)
    const d = m && state.devices.get(m.device_id)
    if (!m || !d) return null
    if (action === 'c' && !isPending(m)) return null
    if (action === 'd' && (m.attach === 'detached' || m.grade === 'hypervisor' || m.attach === 'pve' || m.attach === 'config' || macCount(d.id) < 2)) return null
    return { title: `${mac} (${nameOf(d)})`, mac }
  }
  function botAct(action, ref, reason, who) {
    const c = botCheck(action, ref)
    if (!c) return null
    if (action === 'n') return writes.ack({ ids: [c.id], reason }, who)
    if (action === 'c') return writes.confirmMac({ mac: c.mac, reason }, who)
    return writes.detachMac({ mac: c.mac, reason }, who)
  }

  // map: gateway of the probe (default route or override), cached per snapshot
  // (recomputed after each poll or write)
  function currentGateway() {
    if (lastGateway) return lastGateway.ip
    const g = resolveGateway()
    return g.error ? null : g.ips[0]
  }
  let topoCache = null
  function topology({ servicesOf = () => [] } = {}) {
    const gw = currentGateway()
    const t = now()
    if (topoCache && topoCache.state === state && topoCache.gw === gw && t - topoCache.t < 15_000) return topoCache.v
    const v = { enabled: true, ...buildTopology({ cfg, devices: state.devices, links: state.links ?? [], gateway: gw, macs: state.macs, containerOf: containerOf(), servicesOf, now: t }) }
    topoCache = { state, gw, t, v }
    return v
  }

  // service probe (scheduled on Sunday at 04:00, or on demand by an admin); never triggered
  // by a read
  const probe = createProbe({
    ns, kv: store.kv, cfg, clock: createClock(tz), now, getState: () => state, log,
    ...probeOptions, // tests: simulated connect, fetchImpl, limiter, defsFile
    afterWrite: () => {
      state = ns.load()
      viewCache = null
    },
  })

  // --- passive mDNS listening -------------------------------------------------------------------
  const mdnsCfg = net.mdns?.enabled ? net.mdns : null
  const mdnsState = { listening: false, error: null, socketErrors: 0, lastAt: null, sock: null, started: false,
    outcome: { candidates: 0, nameDiffers: 0, nameConflict: 0, noDevice: 0, ambiguous: 0, offline: 0 }, applied: new Set() }
  // stability: a name is only proposed when seen identical in 2 packets ≥ 5 min apart, within
  // the hour; a name that changes resets the IP; 4,096 IPs at most (beyond that: ignored)
  const MDNS_MAX_IPS = 4096
  const stable = new Map() // ip → { name, times: [ts] }
  function onMdnsCandidate(ip, name, t) {
    mdnsState.lastAt = t
    let e = stable.get(ip)
    if (!e || e.name !== name) {
      if (!e && stable.size >= MDNS_MAX_IPS) {
        for (const [k, v] of stable) if (!v.times.some(x => t - x <= HOUR)) stable.delete(k)
        if (stable.size >= MDNS_MAX_IPS) return
      }
      e = { name, times: [] }
      stable.set(ip, e)
    }
    e.times = [...e.times, t].slice(-8) // stableNames only reads the last hour
  }
  function stableNames(t) {
    const out = []
    for (const [ip, e] of stable) {
      const times = e.times.filter(x => t - x <= HOUR)
      const lastTs = times.at(-1)
      if (lastTs != null && times.some(x => lastTs - x >= 5 * MIN)) out.push({ ip, name: e.name, ts: lastTs })
    }
    return out
  }
  const mdnsHandler = createMdnsHandler({ cidrs, now, onCandidate: onMdnsCandidate })
  // opening: once; interface without a single IPv4 or bind refused → message, no retry
  async function mdnsStart() {
    if (!mdnsCfg || mdnsState.started || stopped) return
    mdnsState.started = true
    let ip
    try {
      ip = ifaceIp(mdnsCfg.iface ?? net.sources.neigh?.iface ?? 'eth0', ifaces())
    } catch (e) {
      mdnsState.error = tr('net.status.mdns', { error: errText(e) })
      log.error(`network: ${mdnsState.error}`)
      return
    }
    try {
      mdnsState.sock = await openSocket(dgramImpl, ip, (buf, rinfo) => mdnsHandler.onMessage(buf, rinfo), () => { mdnsState.socketErrors++ })
      mdnsState.listening = true
    } catch (e) {
      mdnsState.error = tr('net.status.udp', { error: String(e?.code || errText(e)).slice(0, 80) })
      log.error(`network: ${mdnsState.error}`)
    }
  }
  function mdnsStop() {
    try {
      mdnsState.sock?.close()
    } catch { /* already closed */ }
    mdnsState.sock = null
    mdnsState.listening = false
  }
  // after a poll: counts of the poll, named records (running total and digest list)
  function mdnsAfter(o) {
    const { applied, ...counts } = o
    mdnsState.outcome = counts
    if (!applied.length) return
    for (const id of applied) mdnsState.applied.add(id)
    const list = readKv('network.mdnsNamed', []).filter(Number.isInteger)
    store.kv.set('network.mdnsNamed', JSON.stringify([...new Set([...list, ...applied])].slice(-500)))
  }
  // sources.mdns: COUNTS only (no IP, no name, no type)
  const mdnsSource = () => ({
    ok: mdnsCfg ? mdnsState.listening && !mdnsState.error : null, at: mdnsState.lastAt == null ? null : iso(mdnsState.lastAt),
    enabled: !!mdnsCfg, listening: mdnsState.listening, error: mdnsState.error, ...mdnsHandler.counts,
    candidates: mdnsState.outcome.candidates, applied: mdnsState.applied.size, nameDiffers: mdnsState.outcome.nameDiffers,
    nameConflict: mdnsState.outcome.nameConflict, noDevice: mdnsState.outcome.noDevice, ambiguous: mdnsState.outcome.ambiguous,
    offline: mdnsState.outcome.offline, socketErrors: mdnsState.socketErrors,
    // records carrying an informative name (a count, no name)
    informative: [...state.attrs.values()].filter(list => list.some(a => a.attr === 'mdns_name' && a.source === 'mdns')).length, lastAt: mdnsState.lastAt == null ? null : iso(mdnsState.lastAt),
  })

  // probe state in /api/network (ok: definitions loaded; a disabled probe is not down)
  const probeSource = () => {
    const s = probe.status()
    return { ok: s.defsOk && !s.error, at: s.lastRun, ...s }
  }
  function probeView(d, admin) {
    const rows = ns.portsOf(d.id)
    const names = new Map((probe.defs.defs ?? []).map(x => [x.id, x.name]))
    const services = rows.filter(r => r.closed_at == null && r.service)
      // the port only with an admin session (ports are reserved to the admin)
      .map(r => ({ id: r.service, name: names.get(r.service) ?? r.service, confidence: r.confidence, cfgService: r.cfg_service ?? null, ...(admin ? { port: r.port } : {}) }))
    const last = ns.lastEvent(d.id, 'probed')
    const lastProbe = last ? { at: iso(last.ts), origin: isAdminProbe(last.detail) ? 'admin' : 'planned' } : null
    // probeServices: "services" remains the hosted services of the config
    const out = { probeServices: services, lastProbe }
    if (admin) {
      out.ports = rows.map(r => ({ proto: r.proto, port: r.port, open: r.closed_at == null, firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen), closedAt: iso(r.closed_at), service: r.service ?? null }))
      // for the "Probe" button: excluded (no button), or confirmation with force and reason
      out.probe = { available: probe.usable, excluded: excluded(d, cfg), needsForce: needsForce(d, state.attrs.get(d.id) ?? []) }
    }
    return out
  }

  // writes (UI and bot): after each one, snapshot reloaded and alerts re-evaluated (index.js)
  let onWrite = () => {}
  const writes = audit && createNetworkWrites({
    ns, kv: store.kv, cfg, audit, now, isFiring: key => isFiring(key), gatewayOf: () => currentGateway(), probeRequest: id => probe.request(id), probeAllRequest: () => probe.requestAll(), health: () => health(),
    afterWrite: () => {
      // alerts that became pointless (merged or deleted record, MAC removed or confirmed by
      // merge): resolved silently, without "recovered" (net_down included)
      const before = state
      state = ns.load()
      retire([...before.devices.keys()].filter(id => !state.devices.has(id)), [...before.macs.keys()].filter(mac => !state.macs.has(mac)))
      for (const [mac, m] of before.macs) {
        const after = state.macs.get(mac)
        if (['name', 'ip', 'detached', 'rule', 'agent'].includes(m.attach) && after && !['name', 'ip', 'detached', 'rule', 'agent'].includes(after.attach)) retire([], [mac])
      }
      viewCache = null
      topoCache = null
      onWrite()
    },
  })

  // cockpit figures: "online" only with the probe (presence 'arp'), otherwise "active"
  // (freshness); a probe not installed yet is not a failing source
  function summary() {
    const v = view()
    const down = Object.entries(v.sources).filter(([n, s]) => !(n === 'arp' && s.ok === null && !v.presenceSince) && (!s.ok || s.stale)).map(([n]) => n)
      .filter(n => n !== 'probe' && n !== 'mdns') // neither the service probe nor mDNS are presence sources
    return {
      presence: v.presence, online: v.counts.online, offline: v.counts.offline, unknown: v.counts.unknown,
      total: v.counts.total, active: v.counts.active, new: v.counts.new, review: v.counts.review, pending: v.counts.pending,
      sourcesOk: Object.keys(v.sources).length > 0 && !down.length, sourcesDown: down, lastRunAt: v.lastRunAt,
    }
  }

  let timer = null
  let arpTimer = null
  let probeTimer = null
  let first = null
  const arpSafe = () => {
    try {
      arpOnce()
    } catch (e) {
      log.error(`network: ARP probe: ${e.message}`)
    }
  }
  return {
    enabled: true,
    start() {
      mdnsStart().catch(e => log.error(`network: mdns: ${e.message}`))
      // delayed at startup: the other sources (agent, probes) start first
      first = setTimeout(() => {
        runAll()
        timer = setInterval(runAll, intervalMs)
        // ARP probe: file re-read every 30 s, only a new timestamp is processed
        if (arpCfg) {
          arpSafe()
          arpTimer = setInterval(arpSafe, 30_000)
        }
        // service probe: checked every minute for the Sunday 04:00 window (alerts timezone)
        probeTimer = setInterval(() => {
          try {
            probe.tick()
          } catch (e) {
            log.error(`network: service probe: ${e.message}`)
          }
        }, 60_000)
      }, 5000 + Math.random() * 5000)
    },
    // stop: no more polls, and wait for the current one (it must not reopen a Pi-hole
    // session after it was closed); index.js closes the sessions afterwards
    stop() {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
      clearInterval(arpTimer)
      clearInterval(probeTimer)
      mdnsStop()
      return running ?? Promise.resolve(null)
    },
    runAll,
    view,
    // internal diagnostics (tests: readable failure message in CI), never exposed by the API:
    // salt, episode, size of the refused list and entry of a MAC
    floodState: mac => ({ salt: flood.salt, episode: flood.episode, refused: flood.refused.size, entry: mac ? flood.refused.get(normalizeMac(mac)) ?? null : null }),
    device,
    history,
    runArp: arpOnce,
    topology,
    topologyMermaid: opts => toMermaid(topology(opts)),
    summary,
    signals,
    digestLines,
    search,
    writes,
    probe,
    mdns: { start: mdnsStart, stop: mdnsStop, onMessage: (buf, rinfo) => mdnsHandler.onMessage(buf, rinfo), stableNames, source: mdnsSource },
    bot: { check: botCheck, act: botAct },
    onWrite: fn => {
      onWrite = fn
    },
    // alert in progress (engine): a write that suppresses it requires a reason
    firing: fn => {
      isFiring = fn
    },
    purge: t => ns.purge(t ?? now()),
  }
}

const SOURCE_ORDER = ['pihole', 'dhcp', 'neigh', 'pve', 'merge']
// probe bootstrap: first 3 valid sweeps, 50 "to review" records at most
const ARP_BOOTSTRAP_SCANS = 3
// duplicate answers: reported from 3 sweeps out of the last 10 (20 min)
const DUP_WINDOW = 10
const DUP_MIN = 3
const ARP_BOOTSTRAP_MAX = 50
// author of a write, reduced to its kind (never its address or identifier)
const actorKind = a => (String(a).startsWith('tg:') ? 'telegram' : String(a).startsWith('admin') ? 'admin' : String(a) === 'script' ? 'script' : 'admin')

const ipKey = ip => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
