// Trusted proxies (trustedProxies): exact IPv4 or IPv6 addresses, or IPv4 and IPv6 CIDR ranges
// (a containerized proxy changes address within its subnet). Minimum prefix: /8 for IPv4, /32 for
// IPv6 (a wider range would make almost everyone a proxy). Never a DNS name or a port.
//
// Mapped IPv4 (::ffff:0:0/96): net.BlockList matches an IPv4 against any IPv6 rule that
// covers these addresses (::/32 or ::ffff:0.0.0.0/96 would trust ALL IPv4 addresses). Therefore:
//   - an entry INSIDE ::ffff:0:0/96 (::ffff:a.b.c.d or ::ffff:a.b.c.d/n, n ≥ 96) is reduced to its
//     IPv4 form (a.b.c.d/(n-96)), subject to the IPv4 rule (/8 minimum);
//   - a wider IPv6 range that covers or overlaps ::ffff:0:0/96 is rejected;
//   - two separate lists: an IPv4 (or a mapped IPv4, reduced to IPv4) is only ever compared
//     with IPv4 rules, an IPv6 only with IPv6 rules.
// Other IPv6 ranges that carry an IPv4 (6to4 2002::/16, NAT64 64:ff9b::/96, compatible
// ::/96) are not matched against IPv4 by BlockList (verified): they are IPv6 addresses.
import net from 'node:net'

const MATCHER = Symbol('proxyMatcher')
const MAPPED = 0xffffn << 32n // ::ffff:0:0
const MAPPED_END = MAPPED + 0xffffffffn
const ALL = (1n << 128n) - 1n

// IPv6 text (already validated by net.isIP) → 128-bit integer
function v6ToBigInt(s) {
  let str = s.toLowerCase()
  if (str.includes('.')) {
    const i = str.lastIndexOf(':')
    const b = str.slice(i + 1).split('.').map(Number)
    str = `${str.slice(0, i + 1)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`
  }
  const parts = str.split('::')
  const h = parts[0] ? parts[0].split(':') : []
  const t = parts.length > 1 && parts[1] ? parts[1].split(':') : []
  const groups = parts.length > 1 ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n)
}
const bigIntToV4 = n => [24n, 16n, 8n, 0n].map(s => Number((n >> s) & 0xffn)).join('.')

// "192.0.2.10", "2001:db8::1", "172.18.0.0/16", "fd00::/32", "::ffff:198.51.100.0/120"
// → { address, prefix, family } (IPv4 form for a mapped entry); otherwise null
export function parseProxyEntry(s) {
  const m = String(s ?? '').trim().match(/^([^/\s]+)(?:\/(\d{1,3}))?$/)
  if (!m) return null
  const v = net.isIP(m[1])
  if (!v) return null
  if (v === 4) {
    const prefix = m[2] == null ? 32 : Number(m[2])
    return prefix >= 8 && prefix <= 32 ? { address: m[1], prefix, family: 'ipv4' } : null
  }
  const prefix = m[2] == null ? 128 : Number(m[2])
  if (!(prefix >= 32 && prefix <= 128)) return null
  const n = v6ToBigInt(m[1])
  const size = 1n << BigInt(128 - prefix)
  const base = n & (ALL ^ (size - 1n))
  const end = base + size - 1n
  if (end < MAPPED || base > MAPPED_END) return { address: m[1].toLowerCase(), prefix, family: 'ipv6' }
  // the range touches ::ffff:0:0/96: contained → IPv4 form and IPv4 rule; wider → rejected
  if (prefix < 96) return null
  const p4 = prefix - 96
  return p4 >= 8 ? { address: bigIntToV4(n & 0xffffffffn), prefix: p4, family: 'ipv4' } : null
}

// IP of a request: IPv4, mapped IPv4 reduced to IPv4, or IPv6 → { ip, family }; otherwise null
function readQuery(ip) {
  const s = String(ip ?? '').trim()
  if (/^::ffff:/i.test(s) && net.isIPv4(s.slice(7))) return { ip: s.slice(7), family: 'ipv4' }
  const v = net.isIP(s)
  return v ? { ip: s, family: v === 4 ? 'ipv4' : 'ipv6' } : null
}

// list from the config (array or Set) → { has(ip) }; an invalid entry throws (config already
// validated by the schema). An already built matcher is returned as is
export function proxyMatcher(list = []) {
  if (list && list[MATCHER]) return list
  const blocks = { ipv4: new net.BlockList(), ipv6: new net.BlockList() }
  const counts = { ipv4: 0, ipv6: 0 }
  for (const s of list ?? []) {
    const e = parseProxyEntry(s)
    if (!e) throw new Error(`trustedProxies: invalid "${s}" (IPv4, IPv6 or CIDR, prefix ≥ /8 in IPv4, ≥ /32 in IPv6, never the IPv4-mapped range)`)
    if (e.prefix === (e.family === 'ipv4' ? 32 : 128)) blocks[e.family].addAddress(e.address, e.family)
    else blocks[e.family].addSubnet(e.address, e.prefix, e.family)
    counts[e.family]++
  }
  return {
    [MATCHER]: true,
    size: counts.ipv4 + counts.ipv6,
    has(ip) {
      const q = readQuery(ip)
      return !!q && counts[q.family] > 0 && blocks[q.family].check(q.ip, q.family)
    },
  }
}
