// Host label of a service (shared by the Services view and the palette):
// "CT 201 · pve-a" / "VM 202 · pve-b" / appliance name
export function hostLabel(host, hosts) {
  if (!host) return null
  if (host.kind === 'vm' || host.kind === 'lxc') {
    const node = hosts?.find(h => h.kind === 'pve-node' && h.pve === host.pve)
    return `${host.kind === 'lxc' ? 'CT' : 'VM'} ${host.vmid} · ${node?.name || host.pve}`
  }
  return host.name
}
