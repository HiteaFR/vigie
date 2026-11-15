// "agent" source: fast v6 reports from dash-report, already reduced to the allow-list by
// agents.js (cleanFast). Pure function: reports = [{ host, at, fast }] (agents.reports()),
// cfg, now → Sighting[].
//
// A. neighbors of an agent ("agent-neigh" source): FRESHNESS only (never a proof of
//    presence for the probe, never a creation): REACHABLE, IP in network.subnets AND in the
//    subnet of an interface of the reporting agent;
// B. containers ("agent" source): IDENTITY, on a macvlan or ipvlan network of the same
//    report, real IP of the container in network.subnets; Docker bridges, host, none,
//    overlay and any network outside the LAN produce nothing.
// A report older than 5 min is ignored; each observation is dated with the report.
import { normalizeMac } from '../../net/mac.js'
import { isIpv4, parseCidr, inCidr } from '../../net/ip.js'

const AGENT_MAX_AGE_MS = 5 * 60_000
const LAN_DRIVERS = new Set(['macvlan', 'ipvlan'])

export function agentSightings(reports, cfg, now = Date.now()) {
  const subnets = (cfg.network?.subnets ?? []).map(x => parseCidr(x.cidr)).filter(Boolean)
  const hostIds = new Set(cfg.hosts.map(h => h.id))
  const onLan = ip => isIpv4(ip) && subnets.some(c => inCidr(ip, c))
  const out = []
  for (const r of reports || []) {
    const f = r?.fast
    if (!f || !hostIds.has(r.host)) continue
    const ts = Math.min(Number.isFinite(f.ts) && f.ts > 0 ? f.ts * 1000 : r.at ?? 0, now)
    if (!ts || now - ts > AGENT_MAX_AGE_MS) continue
    // A. neighbors: subnets of the agent's interfaces (v6; v5: net undefined → nothing)
    const own = (f.net?.ifaces ?? []).flatMap(i => i.ipv4 ?? []).map(parseCidr).filter(Boolean)
    for (const n of f.net?.neigh ?? []) {
      if (n.state !== 'REACHABLE' || !onLan(n.ip) || !own.some(c => inCidr(n.ip, c))) continue
      const mac = normalizeMac(n.mac)
      if (mac) out.push({ mac, ip: n.ip, source: 'agent-neigh', ts, presence: true, agent: r.host })
    }
    // B. containers on a macvlan or ipvlan network of the same report, real IP on the LAN
    const driver = new Map((f.docker?.networks ?? []).map(x => [x.name, x.driver]))
    for (const c of f.docker?.containers ?? []) {
      const name = String(c?.name ?? '').replace(/^\//, '')
      if (!name) continue
      for (const e of c.networks ?? []) {
        if (!e || !LAN_DRIVERS.has(driver.get(e.network)) || !e.ip || !onLan(e.ip)) continue
        const mac = normalizeMac(e.mac)
        if (!mac) continue
        out.push({ mac, ip: e.ip, source: 'agent', ts, presence: false, name, container: { host: r.host, name, network: e.network } })
      }
    }
  }
  return out
}

// index of the announced containers: MAC → { host, name, network, ip, ts } (attachment by
// identity); a MAC announced twice keeps the most recent report
export function containerIndex(sightings) {
  const idx = new Map()
  for (const s of sightings) {
    if (s.source !== 'agent') continue
    const cur = idx.get(s.mac)
    if (!cur || s.ts > cur.ts) idx.set(s.mac, { ...s.container, ip: s.ip, ts: s.ts })
  }
  return idx
}
