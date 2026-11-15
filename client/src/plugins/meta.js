// Registry of client plugin data (rule labels, sources): static list, imported at build time.
// No component or icon: read by lib/alerts.js and api.js.
import gitea from './gitea/meta.js'

export const PLUGIN_META = [gitea]
// plugin rule labels: [{ rule, label, order }] (order: place among the core ones)
export const PLUGIN_RULE_LABELS = PLUGIN_META.flatMap(p => Object.entries(p.labels ?? {}).map(([rule, l]) => ({ rule, label: l.label, order: l.order })))
export const PLUGIN_SOURCES = Object.assign({}, ...PLUGIN_META.map(p => p.sources ?? {}))
