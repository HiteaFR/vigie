// "self" source: the dashboard's own container, which arp-scan does not see. One presence
// observation per IPv4 address of the LAN interface (neigh.iface), at each successful ARP
// sweep. Pure: ifaces comes from os.networkInterfaces().
import { normalizeMac } from '../../net/mac.js'
import { isIpv4, inCidr } from '../../net/ip.js'

export function selfSightings(ifaces, { iface = 'eth0', cidrs = [], now = Date.now() } = {}) {
  const out = []
  for (const a of ifaces?.[iface] ?? []) {
    const mac = normalizeMac(a.mac)
    if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isIpv4(a.address) || !mac || mac === '00:00:00:00:00:00') continue
    if (!cidrs.some(c => inCidr(a.address, c))) continue
    out.push({ mac, ip: a.address, source: 'self', ts: now, presence: true })
  }
  return out
}
