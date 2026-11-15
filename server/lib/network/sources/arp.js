// "arp" source: JSON file written every 120 s by the net-scan unit (deploy/net-scan in the
// infrastructure repository), the only one with CAP_NET_RAW; the dashboard only reads it.
// The file counts as presence: its ORIGIN is checked before any read (link, type,
// permissions, owner, size), then its content is validated entry by entry (parseArp, pure).
// No error quotes the content.
import fsDefault from 'node:fs'
import path from 'node:path'
import { normalizeMac } from '../../net/mac.js'
import { isIpv4, inCidr } from '../../net/ip.js'
import { arpDetail } from '../events.js'
import { t as tr } from '../../i18n.js'

const MAX_BYTES = 512 * 1024
const MAX_HOSTS = 1024
const MAX_MACS_PER_IP = 4 // beyond that, answers counted and ignored (spoofing)
// beyond that, the MAC answers for everything (proxy ARP, spoofing): no presence, no IP, no
// record. Known limit: a legitimate host with more than 4 IPs on the LAN would be invisible
const MAX_IPS_PER_MAC = 4

const refused = why => new Error(tr('errors.arp.refused', { why: tr(`errors.arp.${why}`) }))
// error of a failed sweep (already bounded by net-scan): bounded again here
const cleanError = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 80) || tr('errors.arp.scan_failed')

const emptyAnomalies = () => ({ invalid: 0, extraMacs: 0, wideMacs: 0, multiMacIps: 0, hdrmac: 0, dup: 0, conflicts: [] })

// file text → { ts, ok, error, hosts: Sighting[], anomalies }; cidrs: parsed ranges of
// network.subnets. Unreadable or wrongly formatted file: ok false, without quoting the content
export function parseArp(text, { cidrs = [], now = Date.now() } = {}) {
  const anomalies = emptyAnomalies()
  const bad = (error, ts = null) => ({ ts, ok: false, error, hosts: [], anomalies })
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) return bad(tr('errors.arp.too_big'))
  let o
  try {
    o = JSON.parse(text)
  } catch {
    return bad(tr('errors.arp.json'))
  }
  if (!o || typeof o !== 'object' || o.v !== 1) return bad(tr('errors.arp.version'))
  if (!Number.isFinite(o.ts) || o.ts <= 0) return bad(tr('errors.arp.ts'))
  const ts = Math.min(o.ts, now) // never in the future
  if (o.ok !== true) return bad(cleanError(o.error), ts)
  if (!Array.isArray(o.hosts)) return bad(tr('errors.arp.no_hosts'), ts)
  if (o.hosts.length > MAX_HOSTS) return bad(tr('errors.arp.refused', { why: tr('errors.arp.too_many', { max: MAX_HOSTS }) }), ts)

  // valid entries: IP in a LAN subnet, MAC and header MAC in the right format
  const valid = []
  for (const h of o.hosts) {
    const mac = normalizeMac(h?.mac)
    const hdrmac = h?.hdrmac == null ? mac : normalizeMac(h.hdrmac)
    const dup = h?.dup ?? 0
    if (!mac || !hdrmac || !isIpv4(h?.ip) || !cidrs.some(c => inCidr(h.ip, c)) || !Number.isInteger(dup) || dup < 0) {
      anomalies.invalid++
      continue
    }
    valid.push({ ip: h.ip, mac, hdrmac, dup })
  }

  const conflicts = new Map()
  // kind: 'dup' (duplicate answers only, filtered by the module), otherwise 'spoof'; a
  // spoofing hint replaces a duplicate answer on the same key, never the reverse
  const conflict = (key, detail, kind = 'spoof') => {
    if (!conflicts.has(key) || (conflicts.get(key).kind === 'dup' && kind !== 'dup')) conflicts.set(key, { detail, kind })
  }
  // spoofing hints on ALL the answers (a duplicate answer can carry another Ethernet
  // header): header MAC different from the ARP sender, duplicate answers
  for (const e of valid) {
    if (e.hdrmac !== e.mac) {
      anomalies.hdrmac++
      conflict(`mac:${e.mac}`, arpDetail.header(e.mac, e.hdrmac))
    }
    if (e.dup > 0) {
      anomalies.dup++
      conflict(`mac:${e.mac}`, arpDetail.dup(e.mac, e.dup), 'dup')
    }
  }
  // one IP: 4 MACs at most; several MACs = conflict (macvlan, proxy ARP… or spoofing)
  const byIp = new Map()
  const kept = []
  for (const e of valid) {
    const list = byIp.get(e.ip) ?? []
    if (list.includes(e.mac)) continue
    if (list.length >= MAX_MACS_PER_IP) {
      anomalies.extraMacs++
      continue
    }
    list.push(e.mac)
    byIp.set(e.ip, list)
    kept.push(e)
  }
  for (const [ip, list] of byIp) {
    if (list.length < 2) continue
    anomalies.multiMacIps++
    conflict(`ip:${ip}`, arpDetail.ip(ip, list))
  }
  // a MAC answering for more than 4 IPs: no presence, no IP, no record
  const ipsOf = new Map()
  for (const e of kept) ipsOf.set(e.mac, (ipsOf.get(e.mac) ?? new Set()).add(e.ip))
  const wide = new Set([...ipsOf].filter(([, s]) => s.size > MAX_IPS_PER_MAC).map(([mac]) => mac))
  for (const mac of wide) {
    anomalies.wideMacs++
    conflict(`mac:${mac}`, arpDetail.wide(mac, ipsOf.get(mac).size))
  }
  const hosts = kept.filter(e => !wide.has(e.mac)).map(e => ({ mac: e.mac, ip: e.ip, source: 'arp', ts, presence: true }))
  anomalies.conflicts = [...conflicts].map(([key, c]) => ({ key, ...c }))
  const ms = Number.isFinite(o.ms) && o.ms >= 0 ? Math.min(Math.round(o.ms), 600_000) : null
  return { ts, ok: true, error: null, ms, hosts, anomalies }
}

// read of the file, origin checked BEFORE any read:
// - neither the directory nor the file are links (O_NOFOLLOW opening);
// - regular file, 512 KB at most (fstat of the open descriptor, before reading);
// - neither one is writable by the group or others;
// - file owned by the directory owner (UID of the unit, or root as a fallback), never
//   the dashboard's (uid): no other account of the container can forge presence.
// → { installed: false } if missing (net-scan not installed yet), otherwise
//   { installed: true, mtime, ...parseArp }; refusal: exception with a short message
export function readArp({ file, cidrs = [], now = Date.now(), fs = fsDefault, uid = process.getuid?.() ?? -1 }) {
  const dir = path.dirname(file)
  let dst
  try {
    dst = fs.lstatSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return { installed: false }
    throw refused('dir_unreadable')
  }
  if (dst.isSymbolicLink() || !dst.isDirectory()) throw refused('dir_type')
  if (dst.mode & 0o022) throw refused('dir_mode')
  let lst
  try {
    lst = fs.lstatSync(file)
  } catch (e) {
    if (e.code === 'ENOENT') return { installed: false }
    throw refused('unreadable')
  }
  if (lst.isSymbolicLink()) throw refused('link')
  if (!lst.isFile()) throw refused('not_file')
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (e) {
    throw refused(e.code === 'ELOOP' ? 'link' : 'unreadable')
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw refused('not_file')
    if (st.size > MAX_BYTES) throw refused('big')
    if (st.mode & 0o022) throw refused('perms')
    if (st.uid !== dst.uid || st.uid === uid) throw refused('owner')
    const text = fs.readFileSync(fd, 'utf8')
    return { installed: true, mtime: st.mtimeMs, ...parseArp(text, { cidrs, now }) }
  } finally {
    fs.closeSync(fd)
  }
}
