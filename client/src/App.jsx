import { lazy, Suspense, useEffect, useState } from 'react'
import { Route, Switch, useLocation, useSearch } from 'wouter'
import { useSource } from './api.js'
import { titleOf } from './lib/title.js'
import { useTheme } from './hooks/useTheme.js'
import Shell from './Shell.jsx'
import CommandPalette from './CommandPalette.jsx'
import Cockpit from './views/Cockpit.jsx'
import ViewFallback from './ui/ViewFallback.jsx'
import ViewBoundary from './ui/ViewBoundary.jsx'
import ServiceDrawer from './ServiceDrawer.jsx'
import HostDrawer from './HostDrawer.jsx'
import DeviceDrawer from './DeviceDrawer.jsx'
import EmptyState from './ui/EmptyState.jsx'
import LoginScreen from './LoginScreen.jsx'
import Unconfigured from './Unconfigured.jsx'
import { setLocale, t } from './i18n/index.js'
import { useAdmin } from './admin.jsx'
import { accessState, SESSION_WAIT_MS } from './lib/access.js'
import { MapPinOff } from 'lucide-react'
import { pluginRoutes } from './plugins/index.jsx'
import { LEGACY_ROUTES, canonicalUrl } from './lib/routes.js'

// plugin routes (static registry, lazy chunks of the same build)
const PLUGIN_ROUTES = pluginRoutes()

// Views loaded on demand (one chunk per view, same origin); the Cockpit, the home page, stays in
// the main bundle (the wall display uses it too). Shell, palette, bell and drawers, opened from
// several views, stay in the main bundle.
const Services = lazy(() => import('./views/Services.jsx'))
const Infra = lazy(() => import('./views/Infra.jsx'))
const Backups = lazy(() => import('./views/Backups.jsx'))
const Alerts = lazy(() => import('./views/Alerts.jsx'))
const Updates = lazy(() => import('./views/Updates.jsx'))
const Mural = lazy(() => import('./views/Mural.jsx'))
const Network = lazy(() => import('./views/Network.jsx'))
const Integrations = lazy(() => import('./views/Integrations.jsx'))

// Services used to live on "/" before the cockpit: an old filtered link
// (?q=, ?state=, older Telegram notifications) is redirected to /services.
function Home() {
  const search = useSearch()
  const [, navigate] = useLocation()
  const p = new URLSearchParams(search)
  const legacy = p.has('q') || p.has('state')
  useEffect(() => {
    if (legacy) navigate(`/services?${search}`, { replace: true })
  }, [legacy, search, navigate])
  return legacy ? null : <Cockpit />
}

// waiting for /api/session (one request, at most SESSION_WAIT_MS)
function SessionLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex min-h-screen items-center justify-center bg-bg text-xs text-muted">
      {t('app.loading')}
    </div>
  )
}

// views by English path; the old names (lib/routes.js) serve the same view
const VIEW_OF = { '/services': Services, '/infra': Infra, '/network': Network, '/updates': Updates, '/backups': Backups, '/alerts': Alerts, '/integrations': Integrations }
const LEGACY_VIEWS = Object.entries(LEGACY_ROUTES).filter(([, to]) => VIEW_OF[to])

// old French name: URL replaced by the English name (same query, same fragment), without a
// history entry; the view is already the right one
function useCanonicalUrl(location, search, navigate) {
  useEffect(() => {
    const to = canonicalUrl(location, search, window.location.hash)
    if (to) navigate(to, { replace: true })
  }, [location, search, navigate])
}

export default function App() {
  const config = useSource('config')
  // instance locale (texts and formats), set before the views render; default en
  if (config.data?.locale) setLocale(config.data.locale)
  const { session, sessionError } = useAdmin()
  const [theme, setTheme] = useTheme()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [location, navigate] = useLocation()
  const search = useSearch()
  useCanonicalUrl(location, search, navigate)
  // /api/session too slow → after SESSION_WAIT_MS, the application is shown as on failure (the
  // wall display never stays on the loading state)
  const [sessionLate, setSessionLate] = useState(false)
  const sessionKnown = !!session || sessionError
  useEffect(() => {
    if (sessionKnown) return
    const id = setTimeout(() => setSessionLate(true), SESSION_WAIT_MS)
    return () => clearTimeout(id)
  }, [sessionKnown])
  // tab title: config.title once the config has arrived (before that: "Vigie" from index.html)
  useEffect(() => {
    if (config.data) document.title = titleOf(config.data)
  }, [config.data])

  // without anonymous read or session, the login screen replaces the application (wall display
  // included); minimal loading state while the session is not read yet (one request), so that
  // no read doomed to a 401 is started. With anonymous read or a session: no change.
  const access = accessState(session, { error: sessionError || sessionLate })
  if (access === 'pending') return <SessionLoading />
  if (access === 'unconfigured') return <Unconfigured />
  if (access === 'login') return <LoginScreen session={session} config={config.data} />

  // error boundary (chunk not found after a deployment, or render error)
  if (location === '/wall' || LEGACY_ROUTES[location] === '/wall') return <ViewBoundary resetKey={location}><Suspense fallback={<ViewFallback />}><Mural config={config.data} /></Suspense></ViewBoundary>

  return (
    <>
      <Shell config={config.data} theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)}>
        <ViewBoundary resetKey={location}>
          <Suspense fallback={<ViewFallback />}>
            <Switch>
              <Route path="/" component={Home} />
              {Object.entries(VIEW_OF).map(([path, View]) => <Route key={path} path={path} component={View} />)}
              {LEGACY_VIEWS.map(([path, to]) => <Route key={path} path={path} component={VIEW_OF[to]} />)}
              {PLUGIN_ROUTES.map(r => <Route key={r.path} path={r.path} component={r.component} />)}
              <Route>
                <EmptyState icon={MapPinOff} title={t('app.page_not_found')} hint={t('app.view_does_not_exist')} />
              </Route>
            </Switch>
          </Suspense>
        </ViewBoundary>
      </Shell>
      <ServiceDrawer />
      <HostDrawer />
      <DeviceDrawer />
      <CommandPalette isOpen={paletteOpen} setOpen={setPaletteOpen} setTheme={setTheme} />
    </>
  )
}
