// Example plugin, client registry entry (routes and cockpit tiles). Static import at build time,
// no external loading (v0). Not listed in plugins/index.jsx: see docs/plugins.md.
import { lazy } from 'react'
import { ExampleKpi } from './tiles.jsx'

const ExampleView = lazy(() => import('./ExampleView.jsx'))

export default {
  id: 'example',
  routes: [{ path: '/example', component: ExampleView }],
  tiles: {
    kpi: [{ order: 90, component: ExampleKpi }],
  },
}
