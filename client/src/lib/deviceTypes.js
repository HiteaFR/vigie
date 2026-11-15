import { ago } from './format.js'
import {
  Router, Network, Wifi, Server, Cpu, HardDrive, Monitor, Laptop, Smartphone, Tablet, Tv, Gamepad2, Speaker,
  Lightbulb, Camera, Printer, CircleHelp,
} from 'lucide-react'
import { t, tLabels } from '../i18n/index.js'

// Device types of the network module (same keys as the server: merge.guessKind,
// NetAlertX import) → label and lucide icon. NetAlertX base64 icons are not used.
export const DEVICE_TYPES = {
  router: { get label() { return t('devtypes.router') }, icon: Router },
  switch: { get label() { return t('devtypes.switch') }, icon: Network },
  ap: { get label() { return t('devtypes.ap') }, icon: Wifi },
  hypervisor: { get label() { return t('devtypes.hypervisor') }, icon: Cpu },
  server: { get label() { return t('devtypes.server') }, icon: Server },
  nas: { get label() { return t('devtypes.nas') }, icon: HardDrive },
  computer: { get label() { return t('devtypes.computer') }, icon: Monitor },
  laptop: { get label() { return t('devtypes.laptop') }, icon: Laptop },
  phone: { get label() { return t('devtypes.phone') }, icon: Smartphone },
  tablet: { get label() { return t('devtypes.tablet') }, icon: Tablet },
  tv: { get label() { return t('devtypes.tv') }, icon: Tv },
  console: { get label() { return t('devtypes.console') }, icon: Gamepad2 },
  speaker: { get label() { return t('devtypes.speaker') }, icon: Speaker },
  iot: { get label() { return t('devtypes.iot') }, icon: Lightbulb },
  camera: { get label() { return t('devtypes.camera') }, icon: Camera },
  printer: { get label() { return t('devtypes.printer') }, icon: Printer },
  other: { get label() { return t('devtypes.other') }, icon: CircleHelp },
}

export const typeOf = ty => DEVICE_TYPES[ty] || { label: ty || t('devtypes.unknown'), icon: CircleHelp }

export const SOURCE_LABEL = tLabels('sources', ['pihole', 'dhcp', 'neigh', 'pve', 'config', 'arp', 'agent', 'mdns', 'import:netalertx', 'guess', 'oui', 'probe', 'merge'])

// Passive freshness: never "online" or "offline", for lack of a probe
const FRESHNESS_LABEL = tLabels('fresh', ['active', 'idle', 'dhcp', 'stale'])

// display state (readable without color, via StatusDot):
// new is warn, active is ok, otherwise unknown with a sub-label
export function deviceState(d) {
  if (d.state === 'new') return 'warn'
  return d.freshness === 'active' ? 'ok' : 'unknown'
}

// "active", "seen 3 h ago", "seen by DHCP", "stale"
export function freshnessText(d) {
  if (d.freshness === 'idle' && d.lastSeen) return t('fresh.seen', { ago: ago(Date.parse(d.lastSeen), { seconds: true }) })
  return FRESHNESS_LABEL[d.freshness] || t('fresh.unknown')
}

// presence: with the ARP probe ('arp' mode), online / offline / unknown;
// otherwise (no probe, no valid scan yet, silent probe) the passive freshness
export function presenceState(d, mode) {
  if (mode !== 'arp') return deviceState(d)
  if (d.state === 'new') return 'warn'
  return d.online === 1 ? 'ok' : d.online === 0 ? 'crit' : 'unknown'
}
export function presenceText(d, mode) {
  if (mode !== 'arp') return freshnessText(d)
  if (d.online === 1) return t('presence.online')
  if (d.online === 0) return d.lastPresent ? t('presence.offline_seen', { ago: ago(Date.parse(d.lastPresent), { seconds: true }) }) : t('presence.offline')
  return t('presence.unknown')
}

export const deviceName = d => d.name || d.vendor || d.ip || d.mac
