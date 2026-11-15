// Built-in Vigie plugins (server/plugins/<id>/, static list, no external loading). Each entry
// is a definePlugin(…) (lib/plugins/host.js), in the order of their signals and digest
// lines.
import gitea from './gitea/index.js'
// second notification channel, inactive without a plugins.ntfy block
import ntfy from './ntfy/index.js'

export const PLUGINS = [gitea, ntfy]
