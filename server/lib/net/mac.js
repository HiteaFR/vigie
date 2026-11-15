// MAC addresses: normalization and quality of the identifier. Pure functions.
//
// The MAC is the identity key of a device. It is only durable when it is
// "universal" (assigned by the manufacturer, U/L bit at 0). A "local" MAC
// (bit 0x02 of the first octet) may be random (phone, rotating device) or
// recreated (Docker macvlan): the record is still created, but the MAC is not used
// for automatic merging. Some addresses designate no device at all.

// "AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff", "aabbccddeeff", "a:b:c:d:e:f"
// → "aa:bb:cc:dd:ee:ff"; null if it is not a 48-bit MAC
export function normalizeMac(v) {
  const s = String(v ?? '').trim().toLowerCase()
  let hex
  if (/^[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}$/.test(s)) hex = s.split(/[:-]/).map(x => x.padStart(2, '0')).join('')
  else if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(s)) hex = s.replace(/\./g, '')
  else if (/^[0-9a-f]{12}$/.test(s)) hex = s
  else return null
  return hex.match(/../g).join(':')
}

const firstOctet = mac => parseInt(mac.slice(0, 2), 16)

// bit 0x02 of the first octet: locally administered address (often random)
export const isLocal = mac => (firstOctet(mac) & 0x02) !== 0
// bit 0x01: multicast (and broadcast ff:ff:ff:ff:ff:ff)
const isMulticast = mac => (firstOctet(mac) & 0x01) !== 0

// patterns "aa:bb:cc:*", full MACs or whole-octet prefixes ("ae:00:53"): MAC families
// (attach rules). An entry that is not a MAC has no effect here.
export function matchPrefix(mac, list = []) {
  if (!mac) return false
  for (const raw of list) {
    const p = String(raw).trim().toLowerCase().replace(/:\*$/, '')
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){0,5}$/.test(p)) continue
    if (mac === p || mac.startsWith(`${p}:`)) return true
  }
  return false
}

// addresses that designate no device
function excluded(mac) {
  if (mac === '00:00:00:00:00:00' || isMulticast(mac)) return true
  // virtual router: VRRP (RFC 5798) and CARP, IPv4 and IPv6; HSRP v1 and v2 (Cisco)
  return /^00:00:5e:00:0[12]:/.test(mac) || mac.startsWith('00:00:0c:07:ac:') || mac.startsWith('00:00:0c:9f:f')
}

// sources that read the MAC "from the inside" (guest config, host report)
const INSIDE = new Set(['pve', 'config', 'agent'])

// → 'strong' | 'weak' | 'hypervisor' | 'excluded'
//   excluded   : invalid, null, multicast, virtual router: never stored (excluded by
//                NATURE, these are not devices; there are no manual exclusions)
//   hypervisor : declared by pve, config or the agent, strong even when it is local
//   (no OUI database: an unknown OUI does not make a MAC weak)
//   strong     : universal (U/L bit at 0)
//   weak       : local, only seen on the network
export function gradeMac(v, { source = null } = {}) {
  const mac = normalizeMac(v)
  if (!mac || excluded(mac)) return 'excluded'
  if (INSIDE.has(source)) return 'hypervisor'
  return isLocal(mac) ? 'weak' : 'strong'
}

// manufacturer prefix (OUI, 3 octets); not applicable to a local MAC
export const ouiOf = mac => (mac && !isLocal(mac) ? mac.slice(0, 8) : null)
