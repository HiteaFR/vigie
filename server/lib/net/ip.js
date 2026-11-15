// IPv4 and CIDR ranges (subnets of the network block, ipIdentity ranges). Pure.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export const isIpv4 = s => IPV4.test(String(s ?? ''))

// "192.0.2.10" → unsigned integer; null if invalid
export function ipToInt(s) {
  if (!isIpv4(s)) return null
  return s.split('.').reduce((n, o) => n * 256 + Number(o), 0)
}

// "192.0.2.0/24" → { base, bits }; null if invalid
export function parseCidr(s) {
  const m = String(s ?? '').match(/^([\d.]+)\/(\d{1,2})$/)
  if (!m || Number(m[2]) > 32) return null
  const ip = ipToInt(m[1])
  if (ip == null) return null
  const bits = Number(m[2])
  const size = 2 ** (32 - bits)
  return { base: ip - (ip % size), bits, size }
}

export function inCidr(ip, cidr) {
  const n = ipToInt(ip)
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr
  return n != null && c != null && n >= c.base && n < c.base + c.size
}
