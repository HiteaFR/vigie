// "neigh" source: IPv4 neighbor table of the dashboard's container (`ip -j -4 neigh`),
// readable without privilege. The parser is pure; the read goes through execFile, without
// a shell. /proc/net/arp would be simpler but does not distinguish REACHABLE (ARP answer
// less than 30 s old: an observation) from STALE (association only).
import { execFile } from 'node:child_process'
import { normalizeMac } from '../../net/mac.js'
import { isIpv4 } from '../../net/ip.js'
import { t as tr } from '../../i18n.js'

// output (JSON text or array already read) → Sighting[]; entries without lladdr
// (FAILED, INCOMPLETE), IPv6 and invalid MACs left out
export function parseNeigh(input, now = Date.now()) {
  let list = input
  if (typeof input === 'string') {
    try {
      list = JSON.parse(input || '[]')
    } catch {
      throw new Error(tr('net.status.neigh_unreadable'))
    }
  }
  if (!Array.isArray(list)) throw new Error(tr('net.status.neigh_format'))
  const out = []
  for (const e of list) {
    const mac = normalizeMac(e?.lladdr)
    if (!mac || !isIpv4(e?.dst)) continue
    const state = Array.isArray(e.state) ? e.state : [e.state]
    out.push({ mac, ip: e.dst, source: 'neigh', ts: now, presence: state.includes('REACHABLE') })
  }
  return out
}

// read: `ip -j -4 neigh show dev <iface>` (5 s max, 1 MB max)
export function readNeigh({ iface = 'eth0', now = Date.now(), run = execFile } = {}) {
  if (!/^[\w.-]{1,15}$/.test(iface)) return Promise.reject(new Error('ip neigh: invalid interface'))
  return new Promise((resolve, reject) => {
    run('ip', ['-j', '-4', 'neigh', 'show', 'dev', iface], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(tr(err.code === 'ENOENT' ? 'net.status.neigh_missing' : err.killed ? 'net.status.neigh_timeout' : 'net.status.neigh_failed')))
      try {
        resolve(parseNeigh(String(stdout), now))
      } catch (e) {
        reject(e)
      }
    })
  })
}
