// Formats of net_events.detail: built here from the codes of lib/codes.js, read back by the code
// (ARP conflict keys, IP-handover marker, origin of a probe run) and displayed through eventText
// (net.event.* catalog). Details written by earlier versions in a former (French) format are
// rewritten in memory by eventDetail (lib/codes.js) before any reading, never in the database;
// a detail of another shape is shown as is.
import { t as tr } from '../i18n.js'
import { EV, eventDetail } from '../codes.js'

export { EV }

// ARP conflicts (lib/network/sources/arp.js)
export const arpDetail = Object.freeze({
  header: (mac, hdr) => `${EV.MAC}${mac}${EV.SEP}Ethernet header ${hdr}`,
  dup: (mac, n) => `${EV.MAC}${mac}${EV.SEP}${n} duplicate repl${n > 1 ? 'ies' : 'y'}`,
  ip: (ip, list) => `${EV.IP}${ip}${EV.SEP}${list.length} MAC (${list.join(', ')})`,
  wide: (mac, n) => `${EV.MAC}${mac}${EV.SEP}answers for ${n} IP`,
})
// key of a conflict ("MAC x" or "IP x"), old or new detail: one alert per key and per day
export const arpKey = detail => String(eventDetail('arp_conflict', detail)).split(EV.SEP)[0]

// reasons of a MAC attachment (mac_added: "<mac>: <reason>", lib/network/merge.js)
export const whyDetail = Object.freeze({
  ipHandover: ip => `${EV.IP_HANDOVER}same IP ${ip} (macvlan range, handover at scan)`,
  sameIp: ip => `same IP ${ip} (macvlan range)`,
  sameName: name => `same name "${name}"`,
  family: (prefix, name) => `family ${prefix}${name ? ` "${name}"` : ''}`,
  agent: (name, host, network) => `agent: container ${name} on ${host} (network ${network})`,
  pending: why => `${why}${EV.PENDING}`,
})
export const macAddedDetail = (mac, why) => `${mac}${EV.SEP}${why}`
// attachment by IP handover (old or new detail)
export const isIpHandover = detail => String(eventDetail('mac_added', detail ?? '')).split(EV.SEP).slice(1).join(EV.SEP).startsWith(EV.IP_HANDOVER)

// probe run (probed), return after deletion (returned), detachment (mac_detached), record (new)
export const probedDetail = (origin, open, requests, c4xx, ms) =>
  `${origin} · ${open} open port${open === 1 ? '' : 's'} · HTTP: ${requests} request${requests === 1 ? '' : 's'}, ${c4xx} 4xx · ${ms} ms`
export const returnedDetail = (mac, deletedAt, reason) => `${mac} returned after deletion on ${deletedAt}${EV.SEP}${reason}`
export const detachedDetail = (mac, id, reason) => `${mac} → record ${id}${EV.SEP}${reason}`
export const newDetail = (origin, bootstrap) => `${origin}${bootstrap ? EV.BOOTSTRAP : ''}`
// container identity conflict (agent_conflict, lib/network/index.js)
export const agentConflictDetail = (key, other, current) => `container ${key}${EV.SEP}${other != null ? `already linked to record ${other}` : `record already linked to ${current}`}; identity attachment suspended`
export const isAdminProbe = detail => String(eventDetail('probed', detail ?? '')).startsWith(EV.ADMIN)

// --- display -------------------------------------------------------------------------------------
const MAC_RE = '(?:[0-9a-f]{2}:){5}[0-9a-f]{2}'

// ARP conflict (old or new detail) → { key, text }. label (digest): MAC → label of its record
// ("IP x" key kept); without label (raw detail of an event): "MAC x" or "IP x" key, MACs as they are
export function arpConflict(detail, label = null) {
  const s = String(eventDetail('arp_conflict', detail ?? ''))
  const mac = m => (label ? label(m) : m)
  const macKey = m => (label ? label(m) : `${EV.MAC}${m}`)
  let m
  if ((m = new RegExp(`^MAC (${MAC_RE}): Ethernet header (${MAC_RE})$`).exec(s))) return { key: macKey(m[1]), text: tr('net.event.arp.header', { hdr: mac(m[2]) }) }
  if ((m = new RegExp(`^MAC (${MAC_RE}): (\\d+) duplicate repl(?:y|ies)$`).exec(s))) return { key: macKey(m[1]), text: tr('net.event.arp.dup', { count: Number(m[2]) }) }
  if ((m = new RegExp(`^IP (\\S+): (\\d+) MAC \\(((?:${MAC_RE})(?:, ${MAC_RE})*)\\)$`).exec(s))) return { key: `${EV.IP}${m[1]}`, text: tr('net.event.arp.ip', { count: Number(m[2]), list: m[3].split(', ').map(mac).join(', ') }) }
  if ((m = new RegExp(`^MAC (${MAC_RE}): answers for (\\d+) IP$`).exec(s))) return { key: macKey(m[1]), text: tr('net.event.arp.wide', { count: Number(m[2]) }) }
  return null
}

function whyText(why) {
  let m
  if ((m = /^([\s\S]*), pending$/.exec(why))) return tr('net.event.why.pending', { why: whyText(m[1]) })
  if ((m = /^IP handover: same IP (\S+) \(macvlan range, handover at scan\)$/.exec(why))) return tr('net.event.why.l1', { ip: m[1] })
  if ((m = /^same IP (\S+) \(macvlan range\)$/.exec(why))) return tr('net.event.why.same_ip', { ip: m[1] })
  if ((m = /^same name "([\s\S]*)"$/.exec(why))) return tr('net.event.why.same_name', { name: m[1] })
  if ((m = /^family (\S+) "([\s\S]*)"$/.exec(why))) return tr('net.event.why.family_named', { prefix: m[1], name: m[2] })
  if ((m = /^family (\S+)$/.exec(why))) return tr('net.event.why.family', { prefix: m[1] })
  if ((m = /^agent: container (\S+) on (\S+) \(network (\S+)\)$/.exec(why))) return tr('net.event.why.agent', { name: m[1], host: m[2], network: m[3] })
  return why
}

// detail of an event (old or new format) in the instance locale; null stays null
export function eventText(type, detail) {
  if (detail == null) return detail
  const s = String(eventDetail(type, detail))
  let m
  switch (type) {
    case 'arp_conflict': {
      const c = arpConflict(s)
      return c ? tr('net.event.arp.line', c) : String(detail)
    }
    case 'mac_added':
      return (m = new RegExp(`^(${MAC_RE}): ([\\s\\S]+)$`).exec(s)) ? tr('net.event.mac_why', { mac: m[1], why: whyText(m[2]) }) : String(detail)
    case 'returned':
      return (m = new RegExp(`^(${MAC_RE}) returned after deletion on (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d): ([\\s\\S]*)$`).exec(s)) ? tr('net.event.returned', { mac: m[1], at: m[2], reason: m[3] }) : String(detail)
    case 'mac_detached':
      return (m = new RegExp(`^(${MAC_RE}) → record (\\d+): ([\\s\\S]*)$`).exec(s)) ? tr('net.event.detached', { mac: m[1], id: m[2], reason: m[3] }) : String(detail)
    case 'probed':
      return (m = /^([\s\S]*?) · (\d+) open ports? · HTTP: (\d+) requests?, (\d+) 4xx · (\d+) ms$/.exec(s))
        ? tr('net.event.probed', { origin: m[1], ports: tr('net.event.ports', { count: Number(m[2]) }), requests: tr('net.event.requests', { count: Number(m[3]) }), c4xx: m[4], ms: m[5] }) : String(detail)
    case 'agent_conflict':
      if ((m = /^container (\S+): already linked to record (\d+); identity attachment suspended$/.exec(s))) return tr('net.event.agent_conflict_other', { key: m[1], id: m[2] })
      return (m = /^container (\S+): record already linked to (\S+); identity attachment suspended$/.exec(s)) ? tr('net.event.agent_conflict_current', { key: m[1], current: m[2] }) : String(detail)
    case 'new':
      return (m = /^([\s\S]*), bootstrap$/.exec(s)) ? tr('net.event.new_bootstrap', { origin: m[1] }) : String(detail)
    default:
      return String(detail)
  }
}
