// gitea plugin, navigation entries (sidebar, mobile bar, palette). order: place among the core
// views (nav.js: Backups 60, Alerts 80).
import { GitBranch } from 'lucide-react'

export default [
  { path: '/ci', label: 'CI', icon: GitBranch, order: 70 },
]
