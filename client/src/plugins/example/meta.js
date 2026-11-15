// Example plugin, client side: data only (no component, no icon), read by lib/alerts.js and
// api.js once the plugin is listed in plugins/meta.js. Not listed: see docs/plugins.md.
// Its catalog (locales/<locale>.json) is registered here, under "example.<key>".
import { registerCatalog } from '../../i18n/index.js'
import fr from './locales/fr.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }

registerCatalog('example', { fr, en })

export default {
  id: 'example',
  labels: { example_queue: { label: { en: 'Queue too long', fr: 'File trop longue' }, order: 1000 } },
  sources: {
    example: { url: '/api/example', period: 60_000 },
  },
}
