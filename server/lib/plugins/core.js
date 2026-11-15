// core modules registered with the host (lib/plugins/host.js), shared by index.js and by the
// golden tests (same definition, to prove equivalence): versions (updates), then network,
// in the order of their signals and digest lines.
import { moduleOf } from './host.js'
import { mountNetwork } from '../network/routes.js'
import { CORE_SOURCES } from '../alerts/collect.js'
import { t as tr } from '../i18n.js'

// rule types of the core modules, reserved with the host BEFORE plugins are loaded
// (createHost({ reservedRules })): a plugin that declares them is cleanly refused (plugin_error)
export const CORE_MODULE_RULES = Object.freeze({
  updates: Object.freeze(['eol', 'security_release']),
  network: Object.freeze(['net_new', 'net_mac_added', 'net_agent_conflict', 'net_new_flood', 'net_down', 'net_ip_changed', 'source_error']),
})

// ids forbidden to plugins (createHost({ reservedIds })): the sources of the core collector
// (snapshot, source_error:<source>/… namespace), the core modules, and proxmox (proxmox[] block
// of the config, /api/proxmox route). A plugin using one of them is refused at load time
// (plugin_error), without taking the id: the core module with the same name loads afterwards
export const RESERVED_PLUGIN_IDS = Object.freeze([...new Set([...CORE_SOURCES, ...Object.keys(CORE_MODULE_RULES), 'proxmox'])])

export function coreModules({ updates, network, unconfigured = false }) {
  return [
    moduleOf('updates', {
      rules: [...CORE_MODULE_RULES.updates],
      signals: (snap, now) => updates.signals(now),
      digest: { slot: 'end', lines: o => updates.digestLines(o) },
      summary: { key: 'updates', value: ({ env }) => updates.counts(env) },
      afterRefresh: () => updates.refresh(),
      // in "to be configured" mode, no version computation
      start: () => { if (!unconfigured) updates.start() },
    }, { label: () => tr('modules.updates') }),
    moduleOf('network', {
      rules: [...CORE_MODULE_RULES.network],
      signals: (snap, now, helpers) => network.signals(now, helpers),
      digest: { slot: 'end', lines: o => network.digestLines(o) },
      summary: { key: 'network', value: ({ now }) => network.summary(now) ?? null },
      routes: (router, h) => mountNetwork(router, { network, ...h }),
      start: () => network.start(),
      refresh: () => network.runAll(),
      purge: () => network.purge(),
      stop: () => network.stop(),
    }, { label: () => tr('modules.network') }),
  ]
}
