// "config" source: hosts[].mac from config.json, to link to a host a device that is not a
// Proxmox guest (NAS, internet box, PVE node, Tailscale…). Identity only; hosts[].ip are
// used for matching by IP (merge.matchHost).
export const configSightings = (cfg, now = Date.now()) => cfg.hosts.filter(h => h.mac).map(h => ({
  mac: h.mac, ip: h.ip ?? null, source: 'config', ts: now, presence: false, name: h.name, hostId: h.id,
}))
