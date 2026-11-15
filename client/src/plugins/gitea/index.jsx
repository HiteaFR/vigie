// gitea plugin, client side (client/src/plugins/<id>/, imported at build time, no external
// loading). Routes (/ci view, lazy chunk) and cockpit tiles; navigation (nav.js) and data
// (meta.js: labels, sources) live apart, without components.
import { lazy } from 'react'
import { CiKpi, CiCard } from './tiles.jsx'

const Ci = lazy(() => import('./Ci.jsx'))

export default {
  id: 'gitea',
  routes: [{ path: '/ci', component: Ci }],
  tiles: {
    kpi: [{ order: 70, component: CiKpi }],
    cards: [{ order: 30, component: CiCard }],
  },
}
