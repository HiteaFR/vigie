// Example plugin, navigation entry (sidebar, mobile bar, palette); order: place among the core
// views (nav.js: Alerts is 80). mobile: false keeps it out of the mobile bar (8 entries at most).
// The label is read when rendering (a getter), never when the module loads: the locale is not known yet.
import { ListOrdered } from 'lucide-react'
import { t } from '../../i18n/index.js'

export default [
  { path: '/example', get label() { return t('example.nav.label') }, icon: ListOrdered, order: 85, mobile: false },
]
