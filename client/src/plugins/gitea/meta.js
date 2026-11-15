// gitea plugin, client side, data only (no component, no icon): labels of its rules and the
// sources it polls. Read by lib/alerts.js and api.js (through plugins/meta.js).
// labels: label (a string, or { en, fr }) and order = place in the rule list (lib/alerts.js: core
// rules at 10, 20, 30… in file order); 75 and 76: between backup_failed (70) and source_error (80)
import { registerCatalog } from '../../i18n/index.js'
import fr from './locales/fr.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }

// client plugin catalog (locales/<locale>.json), under "gitea.<key>"
registerCatalog('gitea', { fr, en })

export default {
  id: 'gitea',
  labels: {
    ci_failed: { label: { fr: 'CI en échec', en: 'CI failing' }, order: 75 },
    runner_offline: { label: { fr: 'Runner hors ligne', en: 'Runner offline' }, order: 76 },
  },
  sources: {
    gitea: { url: '/api/gitea', period: 30_000 },
    runners: { url: '/api/runners', period: 15_000 },
  },
}
