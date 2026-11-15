// Gateway of the container's default route: consistency anchor of the ARP probe when
// network.subnets[].gateway is not set. Read from /proc/net/route, readable without
// privilege (never execFile('ip') resolved through the PATH), re-read at each sweep. Pure:
// the text of the file is passed as an argument.
import { isIpv4 } from '../../net/ip.js'
import { t as tr } from '../../i18n.js'

const RTF_UP = 0x1
const RTF_GATEWAY = 0x2

// "FE00000A" (little-endian hexadecimal) → "10.0.0.254"; null if invalid
export function hexToIp(hex) {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex ?? '')) return null
  return hex.match(/../g).reverse().map(b => parseInt(b, 16)).join('.')
}

// text of /proc/net/route → { gateway, error }; route retained: Destination and Mask
// 00000000, flags RTF_UP and RTF_GATEWAY, interface iface; several routes: the lowest
// metric; a tie between two different gateways: inconclusive, "ambiguous gateway"
export function defaultGateway(text, iface = 'eth0') {
  const unknown = { gateway: null, error: tr('net.status.unknown_gateway') }
  if (typeof text !== 'string') return unknown
  const lines = text.split('\n').filter(l => l.trim())
  const head = (lines.shift() ?? '').trim().split(/\s+/)
  const col = name => head.indexOf(name)
  const [ci, cd, cg, cf, cm, cmask] = ['Iface', 'Destination', 'Gateway', 'Flags', 'Metric', 'Mask'].map(col)
  if ([ci, cd, cg, cf, cm, cmask].some(i => i < 0)) return unknown
  const routes = []
  for (const line of lines) {
    const f = line.trim().split(/\s+/)
    const flags = parseInt(f[cf], 16)
    if (f[ci] !== iface || f[cd] !== '00000000' || f[cmask] !== '00000000' || !Number.isFinite(flags) || (flags & (RTF_UP | RTF_GATEWAY)) !== (RTF_UP | RTF_GATEWAY)) continue
    const gw = hexToIp(f[cg])
    const metric = Number(f[cm])
    if (!gw || !isIpv4(gw) || gw === '0.0.0.0' || !Number.isInteger(metric)) continue
    routes.push({ gw, metric })
  }
  if (!routes.length) return unknown
  const best = Math.min(...routes.map(r => r.metric))
  const gws = [...new Set(routes.filter(r => r.metric === best).map(r => r.gw))]
  return gws.length === 1 ? { gateway: gws[0], error: null } : { gateway: null, error: tr('net.status.ambiguous_gateway') }
}
