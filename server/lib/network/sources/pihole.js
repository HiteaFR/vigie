// "pihole" source: FTL network table (Pi-hole ARP cache, re-read by FTL about every 60 s)
// and DHCP leases (Pi-hole is the only DHCP server of the LAN). Pure parsers; the read goes
// through the shared session of lib/pihole.js.
//
// ips[].lastSeen moves forward as long as the IP is in the Pi-hole ARP cache: it is the
// reference presence source without the probe. lastQuery (last DNS query) is only
// informative. All FTL dates are in epoch seconds.
import { normalizeMac } from '../../net/mac.js'
import { isIpv4 } from '../../net/ip.js'
import { t as tr } from '../../i18n.js'

const LEASE_FOREVER_MS = 15 * 60_000 // endless lease: "seen by DHCP" as long as it is listed
const ms = v => (Number.isFinite(v) && v > 0 ? v * 1000 : null)
const str = v => (typeof v === 'string' && v.trim() && v.trim() !== '*' ? v.trim() : undefined)

// GET /api/network/devices → Sighting[]: one observation per (MAC, IPv4).
// Left out: interface lo (Pi-hole itself), null or invalid MAC. A device without IPv4 gives
// an observation without IP or presence (identity only).
export function parseDevices(json) {
  const list = json?.devices
  if (!Array.isArray(list)) throw new Error(tr('errors.pihole.devices'))
  const out = []
  for (const d of list) {
    if (d?.interface === 'lo') continue
    const mac = normalizeMac(d?.hwaddr)
    if (!mac || mac === '00:00:00:00:00:00') continue
    const base = { mac, source: 'pihole', vendor: str(d.macVendor), firstSeen: ms(d.firstSeen) ?? undefined, lastQuery: ms(d.lastQuery) ?? undefined }
    const ips = (Array.isArray(d.ips) ? d.ips : []).filter(i => isIpv4(i?.ip))
    if (!ips.length) {
      out.push({ ...base, ip: null, ts: ms(d.lastQuery) ?? ms(d.firstSeen) ?? 0, presence: false })
      continue
    }
    for (const i of ips) {
      const ts = ms(i.lastSeen)
      const name = str(i.name)
      out.push({ ...base, ip: i.ip, ts: ts ?? base.firstSeen ?? 0, presence: ts != null, name, hostname: name })
    }
  }
  return out
}

// GET /api/dhcp/leases → Sighting[] ("dhcp" source): a current lease says that a device has
// that IP, not that it is there ("seen by DHCP", never "active").
// Expired lease ignored; name "*" = no name; expires = 0: endless lease, its expiry is
// pushed back by 15 min at each poll as long as it is in the list.
export function parseLeases(json, now = Date.now()) {
  const list = json?.leases
  if (!Array.isArray(list)) throw new Error(tr('errors.pihole.leases'))
  const out = []
  for (const l of list) {
    const mac = normalizeMac(l?.hwaddr)
    if (!mac || mac === '00:00:00:00:00:00' || !isIpv4(l.ip)) continue
    const exp = Number(l.expires)
    if (exp > 0 && exp * 1000 <= now) continue
    out.push({ mac, ip: l.ip, source: 'dhcp', ts: now, presence: false, name: str(l.name), leaseExpires: exp > 0 ? exp * 1000 : now + LEASE_FOREVER_MS })
  }
  return out
}

// FTL's default values (10 devices, 3 addresses) would truncate the table
export const readDevices = pihole => pihole.get('/api/network/devices?max_devices=1000&max_addresses=10').then(parseDevices)
export const readLeases = (pihole, now = Date.now()) => pihole.get('/api/dhcp/leases').then(j => parseLeases(j, now))
