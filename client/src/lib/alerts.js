// Alert rule labels (shared by the Alerts view and the bell): core rules (order 10, 20, 30… in
// the order below) and plugin rules (plugins/meta.js, order set by the label: gitea's ci_failed
// and runner_offline sit between backup_failed and source_error), sorted by order, so the rule
// list of the silence form keeps a stable order
import { PLUGIN_RULE_LABELS } from '../plugins/meta.js'
import { t, locale } from '../i18n/index.js'

// label from the catalog (rules.label.<rule>, same keys as the server), read on every access
const CORE_RULES = [
  'service_down',
  'cert_expiry',
  'pve_unreachable',
  'guest_stopped',
  'storage_usage',
  'backup_late',
  'backup_failed',
  'source_error',
  'agent_unreachable',
  'guest_disk',
  'container_unhealthy',
  'container_restarting',
  'container_down',
  'systemd_failed',
  'reboot_required',
  'restart_required',
  'guest_inodes',
  'disk_free',
  'posture_regression',
  'port_new',
  'time_unsynced',
  'oom_kill',
  'apt_stale',
  'security_updates',
  'autoupdate_off',
  'autoupdate_failed',
  'eol',
  'security_release',
  'not_backed_up',
  'node_mem',
  'node_swap',
  'smart_failed',
  'disk_wear',
  'disk_temp',
  'net_new',
  'net_mac_added',
  'net_new_flood',
  'net_down',
  'net_ip_changed',
  'net_agent_conflict',
  'plugin_error',
  'vpn_down',
  'vpn_leak',
  'vpn_noinfo',
  'guest_undeclared',
  'channel_error',
]
// plugin label: a string, or { en, fr } read in the instance locale (falls back to en)
export const labelIn = v => (typeof v === 'string' ? v : v?.[locale()] ?? v?.en ?? Object.values(v ?? {})[0])
const ORDERED = [
  ...CORE_RULES.map((rule, i) => ({ rule, label: () => t(`rules.label.${rule}`), order: (i + 1) * 10 })),
  ...PLUGIN_RULE_LABELS.map(x => ({ ...x, label: () => labelIn(x.label) })),
].sort((a, b) => a.order - b.order)
// same enumerable keys, in the same order; value read on every access (instance locale)
export const RULE_LABEL = Object.defineProperties({}, Object.fromEntries(ORDERED.map(x => [x.rule, { enumerable: true, get: x.label }])))
