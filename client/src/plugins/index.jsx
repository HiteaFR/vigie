// Registry of client plugins (routes, cockpit tiles): static list, imported at build time; plugin
// views are lazy chunks of the same build, like the core views.
// Navigation: plugins/nav.js; labels and sources: plugins/meta.js.
import gitea from './gitea/index.jsx'

export const CLIENT_PLUGINS = [gitea]
export const pluginRoutes = () => CLIENT_PLUGINS.flatMap(p => p.routes ?? [])
// tiles of a cockpit slot (kpi, cards), sorted by order
export const pluginTiles = slot => CLIENT_PLUGINS.flatMap(p => p.tiles?.[slot] ?? []).sort((a, b) => a.order - b.order)
