// "pve" source: network cards of the Proxmox guests (netX config, plus the IPs seen by
// Proxmox). It is a reliable identity, read "from the inside": a guest's MAC is strong even
// if it is locally administered. It does not prove presence: a "running" guest is already
// tracked by guest_stopped.
import { normalizeMac } from '../../net/mac.js'
import { isIpv4 } from '../../net/ip.js'

// SINGLE period of the pve data: cache of guestNics (lib/sources.js), period of the source
// in sourceView and identity window (IDENTITY_WINDOW_MS, merge.js)
export const PVE_PERIOD_MS = 10 * 60_000

const MODELS = new Set(['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3', 'ne2k_pci', 'i82551', 'i82557b', 'i82559er', 'pcnet'])

// "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1" (VM)
// "name=eth0,bridge=vmbr0,gw=…,hwaddr=BC:24:11:00:00:02,ip=192.0.2.5/24,type=veth" (CT)
// → { mac, ip, bridge }; null if no MAC
export function parseNetLine(s) {
  if (typeof s !== 'string') return null
  let mac = null
  let ip = null
  let bridge = null
  for (const part of s.split(',')) {
    const [k, v = ''] = part.split('=')
    if (k === 'hwaddr' || MODELS.has(k)) mac = normalizeMac(v) ?? mac
    else if (k === 'bridge') bridge = v || null
    else if (k === 'ip') ip = isIpv4(v.split('/')[0]) ? v.split('/')[0] : null // dhcp, manual → null
  }
  return mac ? { mac, ip, bridge } : null
}

// sources.guestNics() → Sighting[]; hostId by (proxmox, vmid) in cfg.hosts.
// An IP seen by Proxmox (guest agent, container interfaces) takes precedence over the
// static IP, which takes precedence over cfg.hosts[].ip.
export function guestSightings(clusters, cfg, now = Date.now()) {
  const out = []
  for (const c of clusters || []) {
    if (c.error) continue
    for (const g of c.guests || []) {
      const host = cfg.hosts.find(h => h.pve === c.id && h.vmid === g.vmid)
      for (const n of g.nics || []) {
        const mac = normalizeMac(n.mac)
        if (!mac) continue
        out.push({
          mac, ip: n.ips?.find(isIpv4) ?? n.ip ?? host?.ip ?? null, source: 'pve', ts: now, presence: false,
          name: host?.name ?? g.name, hostId: host?.id,
        })
      }
    }
  }
  return out
}
