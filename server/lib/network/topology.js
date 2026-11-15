// Network map. Pure functions: tree Internet → gateway → hypervisors → guests, and attached
// devices.
//
// Node references: internet; host:<id> (cfg.hosts); dev:<id> (record NOT linked to a host:
// a linked record IS the host:<id> node, never two nodes for one device); gw:<ip> (gateway
// without a record); grp:<parent>/<type> (collapsible group).
// Parent of a node, by priority: active link entered by hand (manual), cfg.hosts[].parent
// (config), guest → PVE node (pve), host of kind external → internet (external), known
// record whose confirmed IP is the literal services URL of a single host → that host
// (service), otherwise gateway → internet and everything else → gateway (default).
import { isIpv4, inCidr } from '../net/ip.js'
import { isPending } from './merge.js'
import { t as tr, localeTag } from '../i18n.js'

const GROUP_OVER = 6 // beyond 6 leaves of the same type under a parent: a collapsible group
const MAX_DEPTH = 64

// record → node; host_id: the host it represents
const devRef = d => (d.host_id ? `host:${d.host_id}` : `dev:${d.id}`)

// a record whose host has left config.json (host_id still in the database) is an ordinary
// device on the map: never an unknown host:<id> ref (500 on /api/network/topology)
function knownHosts(devices, cfg) {
  const ids = new Set(cfg.hosts.map(h => h.id))
  const orphan = d => d.host_id && !ids.has(d.host_id)
  if (![...devices.values()].some(orphan)) return devices
  return new Map([...devices].map(([k, d]) => [k, orphan(d) ? { ...d, host_id: null } : d]))
}

// entered reference → canonical reference (dev:<id> of a linked record = host:<id>); null if unknown
export function canonicalRef(ref, { devices, hostsById }) {
  const s = String(ref ?? '')
  if (s === 'internet') return s
  const m = /^(dev|host):(.{1,64})$/.exec(s)
  if (!m) return null
  if (m[1] === 'host') return hostsById.has(m[2]) ? s : null
  const d = /^\d{1,10}$/.test(m[2]) ? devices.get(Number(m[2])) : null
  if (!d) return null
  return d.host_id && !hostsById.has(d.host_id) ? `dev:${d.id}` : devRef(d)
}

// gateway → node: record or host carrying that IP, otherwise gw:<ip>; null without a gateway
function gatewayRef(gateway, { devices, cfg }) {
  if (!gateway) return null
  const d = [...devices.values()].find(x => x.last_ip === gateway && x.primary_mac)
  if (d) return devRef(d)
  const h = cfg.hosts.find(x => x.ip === gateway)
  return h ? `host:${h.id}` : `gw:${gateway}`
}

// literal IPv4 of the declared URL of a service, or null: the RAW TEXT must carry it (new URL
// alone would normalize 3232235969 or 0xC0.168.1.193) and new URL().hostname must be
// identical to it; port ignored; a name is never resolved
const URL_IPV4 = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i
export function literalIpv4(url) {
  if (typeof url !== 'string') return null
  const m = URL_IPV4.exec(url)
  if (!m || !isIpv4(m[1])) return null
  try {
    return new URL(url).hostname === m[1] ? m[1] : null
  } catch {
    return null
  }
}

// LAN IP → hosts that declare it as a service URL (order of cfg.services); host IPs
// (identity) and IPs outside the LAN are left out
function serviceClaims(cfg) {
  const hostIps = new Set(cfg.hosts.map(h => h.ip).filter(Boolean))
  const subnets = (cfg.network?.subnets ?? []).map(s => s.cidr)
  const claims = new Map() // ip → { hosts: Set, service: id of the first service }
  for (const s of cfg.services ?? []) {
    const ip = literalIpv4(s.url)
    if (!ip || !s.host || hostIps.has(ip) || !subnets.some(c => inCidr(ip, c))) continue
    const c = claims.get(ip) ?? { hosts: new Set(), service: s.id }
    c.hosts.add(s.host)
    claims.set(ip, c)
  }
  return claims
}

// effective parents of each node (Map ref → { parent, origin }): basis of the map, of the
// record (mapParent) and of the cycle refusal; links: active links entered by hand
// { child, parent }; macs: net_macs state (Map), for the "service" rule (IP carried by a
// confirmed MAC); containerOf: Map record id → { host, name, network } (persisted association)
export function effectiveParents({ cfg, devices, links = [], gateway = null, macs = new Map(), containerOf = new Map() }) {
  devices = knownHosts(devices, cfg)
  const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))
  const refs = new Set(['internet'])
  for (const h of cfg.hosts) refs.add(`host:${h.id}`)
  for (const d of devices.values()) if (d.primary_mac) refs.add(devRef(d))
  const gw = gatewayRef(gateway, { devices, cfg })
  if (gw) refs.add(gw)
  const parents = new Map()
  const warnings = []
  const manual = new Map()
  // "service" rule: unlinked record, known, LAN IP carried by a confirmed MAC, which is the
  // IP of no host, and literal services URL of a SINGLE host
  const claims = serviceClaims(cfg)
  // ambiguity: computed on the config alone, once per IP, even without a record
  for (const [ip, c] of claims) if (c.hosts.size > 1) warnings.push(tr('net.topology.ip_claimed', { ip, hosts: [...c.hosts].join(', ') }))
  const confirmedIps = new Map() // device_id → Set(IPs carried by a confirmed MAC)
  for (const m of macs.values()) {
    if (!m.last_ip || isPending(m)) continue
    if (!confirmedIps.has(m.device_id)) confirmedIps.set(m.device_id, new Set())
    confirmedIps.get(m.device_id).add(m.last_ip)
  }
  const byService = new Map() // ref dev:<id> → { parent, service }
  for (const d of devices.values()) {
    if (!d.primary_mac || d.host_id || d.state !== 'known' || !d.last_ip) continue
    if (!confirmedIps.get(d.id)?.has(d.last_ip)) continue
    const c = claims.get(d.last_ip)
    if (!c || c.hosts.size > 1) continue
    const h = [...c.hosts][0]
    if (hostsById.has(h)) byService.set(`dev:${d.id}`, { parent: `host:${h}`, service: c.service })
  }
  for (const l of links) {
    const child = canonicalRef(l.child, { devices, hostsById })
    const parent = canonicalRef(l.parent, { devices, hostsById })
    if (!child || !parent || !refs.has(child) || !refs.has(parent) || child === parent) {
      warnings.push(tr('net.topology.orphan', { id: l.id ?? '?' }))
      continue
    }
    if (!manual.has(child)) manual.set(child, { parent, id: l.id ?? null })
  }
  for (const ref of refs) {
    if (ref === 'internet') continue
    const host = ref.startsWith('host:') ? hostsById.get(ref.slice(5)) : null
    let parent = null
    let origin = 'default'
    if (manual.has(ref)) [parent, origin] = [manual.get(ref).parent, 'manual']
    else if (host?.parent && hostsById.has(host.parent)) [parent, origin] = [`host:${host.parent}`, 'config']
    else if (host && (host.kind === 'vm' || host.kind === 'lxc') && host.pve) {
      const node = cfg.hosts.find(x => x.kind === 'pve-node' && x.pve === host.pve)
      if (node) [parent, origin] = [`host:${node.id}`, 'pve']
    }
    if (!parent && host?.kind === 'external') [parent, origin] = ['internet', 'external']
    // unlinked record associated with a container of a config host → that host (agent),
    // before the service rule (the agent's report is more reliable than the URL)
    const ctr = !parent && ref.startsWith('dev:') ? containerOf.get(Number(ref.slice(4))) : null
    if (ctr && hostsById.has(ctr.host)) [parent, origin] = [`host:${ctr.host}`, 'agent']
    if (!parent && byService.has(ref)) [parent, origin] = [byService.get(ref).parent, 'service']
    if (!parent) parent = ref === gw || !gw ? 'internet' : gw
    parents.set(ref, {
      parent, origin,
      ...(origin === 'manual' ? { linkId: manual.get(ref).id } : {}),
      ...(origin === 'service' ? { originService: byService.get(ref).service } : {}),
      ...(origin === 'agent' ? { originContainer: ctr.name } : {}),
    })
  }
  // a cycle (inconsistent config, old link, recomputed service parent): the node falls back
  // to its default parent, internet for an external host. A parent of origin service yields
  // FIRST: a link entered by hand or the config do not yield to a deduction.
  // Only a node ON the cycle yields (not the one leading to it: dev:36 under host-a stays)
  const onCycle = (ref, parent, depth = MAX_DEPTH) => {
    let cur = parent
    for (let i = 0; i < depth && cur && cur !== 'internet'; i++) {
      if (cur === ref) return true
      cur = parents.get(cur)?.parent
    }
    return false
  }
  const fallback = (ref, p, depth = MAX_DEPTH) => {
    if (p.origin === 'default' || p.origin === 'external' || !onCycle(ref, p.parent, depth)) return
    warnings.push(tr('net.topology.cycle', { ref }))
    const external = ref.startsWith('host:') && hostsById.get(ref.slice(5))?.kind === 'external'
    parents.set(ref, external ? { parent: 'internet', origin: 'external' } : { parent: ref === gw || !gw ? 'internet' : gw, origin: 'default' })
  }
  for (const [ref, p] of parents) if (p.origin === 'service') fallback(ref, p)
  for (const [ref, p] of parents) if (p.origin === 'agent') fallback(ref, p) // after service
  for (const [ref, p] of parents) fallback(ref, p)
  // third pass, onCycle at a depth of parents.size + 1: a long cycle (more than 64 nodes),
  // which the bounded passes do not see, is broken; only a node ON the cycle yields, the
  // upstream nodes keep their parent
  for (const [ref, p] of parents) fallback(ref, p, parents.size + 1)
  return { parents, warnings, gateway: gw }
}

// would the child → parent link create a cycle? We walk up from parent to the root
// (bounded depth); parents: Map ref → { parent } or ref → parent
export function findCycle(parents, child, parent, maxDepth = MAX_DEPTH) {
  let cur = parent
  for (let i = 0; i < maxDepth && cur && cur !== 'internet'; i++) {
    if (cur === child) return true
    const p = parents.get(cur)
    cur = typeof p === 'string' ? p : p?.parent
  }
  return cur === child || (cur != null && cur !== 'internet')
}

// label and IP of a node (map and parent of the record: same values)
function nodeLabel(ref, { cfg, devices }) {
  if (ref === 'internet') return { label: 'Internet', ip: null }
  if (ref.startsWith('gw:')) return { label: tr('net.topology.gateway', { ip: ref.slice(3) }), ip: ref.slice(3) }
  if (ref.startsWith('host:')) {
    const h = cfg.hosts.find(x => x.id === ref.slice(5))
    const d = [...devices.values()].find(x => x.host_id === h?.id && x.primary_mac)
    return { label: h?.name ?? ref.slice(5), ip: h?.ip ?? d?.last_ip ?? null }
  }
  const d = devices.get(Number(ref.slice(4)))
  return d ? { label: d.disp_name || d.vendor || d.primary_mac || tr('net.map.device', { id: d.id }), ip: d.last_ip ?? null } : { label: ref, ip: null }
}

// effective parent of a record (mapParent): same computation as the map; link only for a
// link entered by hand ({ id, kind, port, note }, never reason or author)
export function deviceParent(d, { cfg, devices, links = [], gateway = null, macs = new Map(), containerOf = new Map() }) {
  if (!d?.primary_mac) return null
  const { parents } = effectiveParents({ cfg, devices, links, gateway, macs, containerOf })
  const p = parents.get(d.host_id && !cfg.hosts.some(h => h.id === d.host_id) ? `dev:${d.id}` : devRef(d))
  if (!p) return null
  const l = p.origin === 'manual' ? links.find(x => x.id === p.linkId) : null
  return {
    ref: p.parent, ...nodeLabel(p.parent, { cfg, devices }), origin: p.origin,
    ...(p.originService ? { originService: p.originService } : {}),
    ...(p.originContainer ? { originContainer: p.originContainer } : {}),
    ...(l ? { link: { id: l.id, kind: l.kind, port: l.port ?? null, note: l.note ?? null } } : {}),
  }
}

// state of a node: ok online, crit offline and watched, warn new, otherwise unknown
const stateOf = d => (!d ? 'unknown' : d.state === 'new' ? 'warn' : d.online === 1 ? 'ok' : d.online === 0 && d.alert_down ? 'crit' : 'unknown')

// cfg, devices (Map), links (active), gateway (IP), servicesOf(ip, hostId) → [{ name, state }]
export function buildTopology({ cfg, devices, links = [], gateway = null, macs = new Map(), containerOf = new Map(), servicesOf = () => [], now = Date.now() }) {
  const { parents, warnings, gateway: gw } = effectiveParents({ cfg, devices, links, gateway, macs, containerOf })
  const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))
  const byHost = new Map([...devices.values()].filter(d => d.host_id && d.primary_mac).map(d => [d.host_id, d]))
  const worst = list => (list.some(s => s.state === 'crit') ? 'crit' : list.some(s => s.state === 'warn') ? 'warn' : list.length ? 'ok' : null)
  const node = ref => {
    if (ref === 'internet') return { id: ref, label: 'Internet', kind: 'internet', type: 'internet', ip: null, state: 'ok', services: [], link: null }
    if (ref.startsWith('gw:')) return { id: ref, label: tr('net.topology.gateway', { ip: ref.slice(3) }), kind: 'gateway', type: 'router', ip: ref.slice(3), state: 'unknown', services: [], link: null }
    if (ref.startsWith('host:')) {
      const h = hostsById.get(ref.slice(5))
      const d = byHost.get(h.id)
      const ip = h.ip ?? d?.last_ip ?? null
      const services = ip ? servicesOf(ip, h.id) : []
      return { id: ref, label: h.name, kind: 'host', type: h.kind, ip: h.ip ?? d?.last_ip ?? null, state: d ? stateOf(d) : 'unknown', services, servicesState: worst(services), link: `?h=${encodeURIComponent(h.id)}` }
    }
    const d = devices.get(Number(ref.slice(4)))
    const services = d.last_ip ? servicesOf(d.last_ip, null) : []
    return { id: ref, label: d.disp_name || d.vendor || d.primary_mac || tr('bot.device_n', { id: d.id }), kind: 'device', type: d.disp_type || 'other', ip: d.last_ip ?? null, state: stateOf(d), services, servicesState: worst(services), link: `?d=${d.id}` }
  }
  const nodes = new Map([['internet', { ...node('internet'), parent: null, origin: null }]])
  for (const [ref, p] of parents) nodes.set(ref, { ...node(ref), parent: p.parent, origin: p.origin, linkId: p.linkId ?? null, ...(p.originService ? { originService: p.originService } : {}), ...(p.originContainer ? { originContainer: p.originContainer } : {}), gateway: ref === gw })
  // children sorted by type then by name (stable order)
  const children = new Map()
  for (const n of nodes.values()) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id])
  const order = (a, b) => {
    const [x, y] = [nodes.get(a), nodes.get(b)]
    return String(x.type).localeCompare(String(y.type)) || String(x.label).localeCompare(String(y.label), localeTag()) || a.localeCompare(b)
  }
  for (const list of children.values()) list.sort(order)
  // grouping of numerous leaves of the same type
  const groups = []
  for (const [parent, list] of children) {
    const leaves = list.filter(ref => !children.has(ref))
    const byType = new Map()
    for (const ref of leaves) byType.set(nodes.get(ref).type, [...(byType.get(nodes.get(ref).type) ?? []), ref])
    for (const [type, members] of byType) {
      if (members.length <= GROUP_OVER) continue
      const id = `grp:${parent}/${type}`
      groups.push({ id, parent, type, members })
      nodes.set(id, { id, label: `${members.length} × ${type}`, kind: 'group', type, ip: null, state: worst(members.map(m => nodes.get(m))) ?? 'unknown', services: [], link: null, parent, origin: 'group', members })
      for (const m of members) nodes.get(m).group = id
    }
  }
  const edges = [...nodes.values()].filter(n => n.parent && n.kind !== 'group').map(n => ({ from: n.parent, to: n.id, origin: n.origin }))
  return { nodes: [...nodes.values()], edges, groups, warnings, gateway: gw, generatedAt: new Date(now).toISOString() }
}

// Mermaid label: "#" escaped FIRST (Mermaid decodes the #…; entities: otherwise a typed
// "#lt;" would turn back into "<" when rendered), then " < > & ; backtick, controls and
// line breaks removed; 64 characters at most
export function mermaidLabel(s) {
  const clean = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f`]/g, '').slice(0, 64)
  return clean.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/&/g, '#amp;')
}

// Mermaid export: generated identifiers (n0, n1…), never the name; no click directive,
// %%{init} or classDef built from the data
export function toMermaid(topology) {
  const ids = new Map(topology.nodes.map((n, i) => [n.id, `n${i}`]))
  const lines = ['graph LR']
  for (const n of topology.nodes) {
    if (n.kind === 'group') continue
    lines.push(`  ${ids.get(n.id)}["${mermaidLabel(n.ip ? `${n.label} (${n.ip})` : n.label)}"]`)
  }
  for (const e of topology.edges) lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`)
  return `${lines.join('\n')}\n`
}
