import { Gauge, LayoutGrid, Server, Archive, Bell, PackageCheck, Network, Puzzle } from 'lucide-react'
import { PLUGIN_NAV } from './plugins/nav.js'
import { t } from './i18n/index.js'

// core views (labels read at render time, through the catalog); order: place in the navigation,
// shared with plugin entries (plugins/nav.js: CI of the gitea plugin at 70); placement "bottom":
// bottom of the sidebar, not in the mobile bar (mobile: false), always in the palette
const CORE_VIEWS = [
  { path: '/', get label() { return t('nav.cockpit') }, icon: Gauge, order: 10 },
  { path: '/services', get label() { return t('nav.services') }, icon: LayoutGrid, order: 20 },
  { path: '/infra', get label() { return t('nav.infra') }, icon: Server, order: 30 },
  { path: '/network', get label() { return t('nav.network') }, icon: Network, badge: 'network', order: 40 },
  { path: '/updates', get label() { return t('nav.updates') }, get short() { return t('nav.updates_short') }, icon: PackageCheck, badge: 'updates', order: 50 },
  { path: '/backups', get label() { return t('nav.backups') }, get short() { return t('nav.backups_short') }, icon: Archive, order: 60 },
  { path: '/alerts', get label() { return t('nav.alerts') }, icon: Bell, badge: 'alerts', order: 80 },
  // modules and plugins, state and last error (read only)
  { path: '/integrations', get label() { return t('nav.integrations') }, icon: Puzzle, order: 900, placement: 'bottom', mobile: false },
]

// shipped views: the core ones and the plugin ones, in order
export const VIEWS = [...CORE_VIEWS, ...PLUGIN_NAV].sort((a, b) => a.order - b.order)

// keeps the environment filter in shareable links. MERGES env into an existing query
// (/reseau?d=12 → /reseau?d=12&env=prod), replaces an env already present instead of
// duplicating it, keeps any # and the encoding of the other parameters; env missing or "all":
// link unchanged
export function withEnv(path, env) {
  if (!env || env === 'all') return path
  const h = path.indexOf('#')
  const hash = h < 0 ? '' : path.slice(h)
  const base = h < 0 ? path : path.slice(0, h)
  const q = base.indexOf('?')
  const params = (q < 0 ? '' : base.slice(q + 1)).split('&').filter(p => p && p !== 'env' && !p.startsWith('env='))
  return `${q < 0 ? base : base.slice(0, q)}?${[...params, `env=${encodeURIComponent(env)}`].join('&')}${hash}`
}
