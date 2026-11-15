// "mdns" source: STRICTLY passive listening to mDNS, inside the dashboard process. One UDP
// 5353 socket (reuseAddr), a single group (224.0.0.251) on the IPv4 of the LAN interface, NO
// emission. Only the ANSWERS coming from the LAN are parsed, by a bounded parser (sizes,
// counters, names, iterative compression strictly backwards, try/catch per packet, rate).
// The only output is a candidate NAME, consistent with the source IP: no presence, no
// creation, no attachment (merge.js, mdnsNames).
import { cleanName, isGenericName } from '../merge.js'
import { isIpv4, inCidr } from '../../net/ip.js'
import { t as tr } from '../../i18n.js'

const MDNS_PORT = 5353
export const MDNS_GROUP = '224.0.0.251'
const MAX_PACKET = 9000
const MIN_PACKET = 12
const MAX_COUNT = 64
const MAX_LABEL = 63
const MAX_NAME = 255
const MAX_JUMPS = 16
const RATE_PER_MIN = 2000
const SERVICE_TYPE = /^_[a-z0-9-]{1,15}\._(tcp|udp)$/
const TYPES = { 1: 'A', 12: 'PTR', 16: 'TXT', 33: 'SRV' }

class Malformed extends Error {}
const fail = why => { throw new Malformed(why) }

// --- DNS parsing (pure) -------------------------------------------------------------------

// name at offset off: labels ≤ 63, name ≤ 255, reserved bits rejected; ITERATIVE
// compression, each pointer strictly before the start of the current segment (which rules
// out any loop), 16 jumps at most → { name, end } (end: byte after the name)
export function readName(buf, off) {
  const labels = []
  let pos = off
  let limit = off // a pointer must point strictly before the start of the current segment
  let jumps = 0
  let end = -1
  let total = 0
  for (;;) {
    if (pos >= buf.length) fail('name outside the packet')
    const len = buf[pos]
    if (len === 0) {
      if (end < 0) end = pos + 1
      break
    }
    const kind = len & 0xc0
    if (kind === 0xc0) {
      if (pos + 1 >= buf.length) fail('truncated pointer')
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]
      if (ptr >= limit) fail('forward pointer')
      if (++jumps > MAX_JUMPS) fail('too many jumps')
      if (end < 0) end = pos + 2
      limit = ptr
      pos = ptr
      continue
    }
    if (kind !== 0) fail('reserved label bits')
    if (len > MAX_LABEL) fail('label too long')
    if (pos + 1 + len > buf.length) fail('label outside the packet')
    total += len + 1
    if (total > MAX_NAME) fail('name too long')
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len))
    pos += 1 + len
  }
  return { name: labels.join('.'), end }
}

// mDNS packet → { qr, records: [{ type, name, target?, ip? }] }; throws Malformed on any
// overflow (the packet is then rejected); TXT never kept, types outside the list skipped
export function parsePacket(buf) {
  if (buf.length > MAX_PACKET) fail('too big')
  if (buf.length < MIN_PACKET) fail('too short')
  const flags = buf.readUInt16BE(2)
  const qr = (flags & 0x8000) !== 0
  const [qd, an, ns, ar] = [4, 6, 8, 10].map(o => buf.readUInt16BE(o))
  if ([qd, an, ns, ar].some(n => n > MAX_COUNT)) fail('compteurs')
  if (qd * 5 + (an + ns + ar) * 11 > buf.length - 12) fail('counters inconsistent with the size')
  let pos = 12
  for (let i = 0; i < qd; i++) {
    pos = readName(buf, pos).end + 4
    if (pos > buf.length) fail('truncated question')
  }
  const records = []
  for (let i = 0; i < an + ns + ar; i++) {
    const { name, end } = readName(buf, pos)
    if (end + 10 > buf.length) fail('truncated record')
    const typeCode = buf.readUInt16BE(end)
    const rdlength = buf.readUInt16BE(end + 8)
    const rd = end + 10
    if (rdlength > buf.length - rd) fail('rdlength')
    const type = TYPES[typeCode]
    if (type === 'PTR') records.push({ type, name, target: readName(buf, rd).name })
    else if (type === 'SRV') {
      if (rdlength < 7) fail('SRV too short')
      records.push({ type, name, target: readName(buf, rd + 6).name })
    } else if (type === 'A') {
      if (rdlength !== 4) fail('invalid A record')
      records.push({ type, name, ip: `${buf[rd]}.${buf[rd + 1]}.${buf[rd + 2]}.${buf[rd + 3]}` })
    } else if (type === 'TXT') records.push({ type, name }) // content never kept
    pos = rd + rdlength
  }
  return { qr, records }
}

// --- candidate name, consistent with the source IP ---------------------------------------

// records of an answer, source IP → candidate name (cleanName then isGenericName), or null:
//   - instance (PTR of a service type): only if its SRV designates a host whose A, in the
//     SAME packet, is the source IP;
//   - otherwise host name: an A <name>.local whose data is the source IP;
//   - otherwise nothing (a sleep proxy announces the IP of another device: left out).
// A name rejected by the common cleaning → no candidate (no fallback)
export function candidateOf(records, srcIp) {
  const lc = s => String(s ?? '').toLowerCase()
  const aIs = host => records.some(r => r.type === 'A' && lc(r.name) === lc(host) && r.ip === srcIp)
  let raw = null
  for (const r of records) {
    if (r.type !== 'PTR') continue
    const owner = r.name.replace(/\.local$/i, '')
    if (!SERVICE_TYPE.test(owner)) continue
    const suffix = `.${r.name}`
    if (!lc(r.target).endsWith(lc(suffix))) continue
    const srv = records.find(x => x.type === 'SRV' && lc(x.name) === lc(r.target))
    if (srv && aIs(srv.target)) {
      raw = r.target.slice(0, -suffix.length)
      break
    }
  }
  if (raw == null) {
    const a = records.find(r => r.type === 'A' && /\.local$/i.test(r.name) && r.ip === srcIp)
    if (a) raw = a.name.replace(/\.local$/i, '')
  }
  if (raw == null) return null
  const name = cleanName(raw)
  return name && !isGenericName(name) ? name : null
}

// --- packet handler (wired to the socket) ------------------------------------------------------

// cidrs: parsed ranges of network.subnets; onCandidate(ip, name, t); counts only
export function createMdnsHandler({ cidrs = [], now = () => Date.now(), onCandidate = () => {} }) {
  const counts = { packets: 0, rejected: 0, outsideLan: 0, rate: 0 }
  let windowStart = now()
  let windowCount = 0
  function onMessage(buf, rinfo) {
    try {
      counts.packets++
      const t = now()
      if (t - windowStart >= 60_000) {
        windowStart = t
        windowCount = 0
      }
      if (++windowCount > RATE_PER_MIN) {
        counts.rate++
        return
      }
      const ip = rinfo?.address
      if (!isIpv4(ip) || !cidrs.some(c => inCidr(ip, c))) {
        counts.outsideLan++
        return
      }
      if (!Buffer.isBuffer(buf) || buf.length > MAX_PACKET) {
        counts.rejected++
        return
      }
      const p = parsePacket(buf)
      if (!p.qr) { // query: ignored
        counts.rejected++
        return
      }
      const name = candidateOf(p.records, ip)
      if (name) onCandidate(ip, name, t)
    } catch {
      counts.rejected++ // malformed packet (or any other surprise): rejected, listening goes on
    }
  }
  return { onMessage, counts }
}

// --- listening -------------------------------------------------------------------------------

// the SINGLE non-internal IPv4 of the interface; 0 or several, or unknown interface → error
// (never guess; os.networkInterfaces() goes through netlink)
export function ifaceIp(iface, ifaces) {
  if (!ifaces || !Object.hasOwn(ifaces, iface)) throw new Error(tr('net.status.unknown_iface', { iface: String(iface).slice(0, 20) }))
  const own = (ifaces[iface] ?? []).filter(a => a && (a.family === 'IPv4' || a.family === 4) && !a.internal).map(a => a.address)
  if (own.length !== 1) throw new Error(tr('net.status.iface_addresses', { iface, count: own.length }))
  return own[0]
}

// one socket, one bind, a single group; never any emission. Bind refused → rejection (no
// retry); errors after startup → onError (counted), listening goes on
export function openSocket(dgramImpl, ip, onMessage, onError = () => {}) {
  return new Promise((resolve, reject) => {
    const sock = dgramImpl.createSocket({ type: 'udp4', reuseAddr: true })
    sock.once('error', reject)
    sock.on('message', onMessage)
    sock.bind(MDNS_PORT, '0.0.0.0', () => {
      try {
        sock.addMembership(MDNS_GROUP, ip)
      } catch (e) {
        try {
          sock.close()
        } catch { /* already closed */ }
        reject(e)
        return
      }
      sock.removeListener('error', reject)
      sock.on('error', onError)
      resolve(sock)
    })
  })
}
