import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { Search, Sun, Moon, Monitor, LayoutDashboard } from 'lucide-react'
import { useSource } from './api.js'
import { useEnv, matchEnv } from './hooks/useUrlState.js'
import { THEME_LABEL, nextTheme } from './hooks/useTheme.js'
import { VIEWS, withEnv } from './nav.js'
import { StatusDot } from './ui/Status.jsx'
import { AdminButton, RefreshButton } from './admin.jsx'
import { todoOf, updateCounts } from './lib/updates.js'
import { toneOf, BADGE_CLASS } from './lib/tone.js'
import { AlertBell, firingOf, badgeOf } from './AlertBell.jsx'
import { APP_SHELL_ID } from './lib/inert.js'
import { localeTag, t } from './i18n/index.js'

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return <time className="font-mono tabular-nums text-sm text-muted">{now.toLocaleTimeString(localeTag())}</time>
}

function EnvSwitch() {
  const [env, setEnv] = useEnv()
  const opts = [['all', t('shell.all')], ['prod', 'Prod'], ['dev', 'Dev']]
  return (
    <div className="flex rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label={t('shell.environment')}>
      {opts.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={env === v}
          onClick={() => setEnv(v)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition max-[374px]:px-1.5 ${env === v ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// global counter: services by state in the current environment
function StateSummary() {
  const { data } = useSource('services')
  const [env] = useEnv()
  if (!data) return null
  const c = { crit: 0, warn: 0, ok: 0, unknown: 0 }
  for (const s of data.services) if (matchEnv(env, s.env) && c[s.state] !== undefined) c[s.state]++
  const worst = c.crit ? 'crit' : c.warn ? 'warn' : c.unknown && !c.ok ? 'unknown' : 'ok'
  const text = c.crit || c.warn
    ? [c.crit && t('shell.svc_down', { count: c.crit }), c.warn && t('shell.svc_degraded', { count: c.warn })].filter(Boolean).join(', ')
    : t('shell.svc_up', { count: c.ok })
  return (
    <Link
      href={withEnv(c.crit || c.warn ? '/services?state=crit,warn' : '/services', env)}
      className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-fg hover:border-line-strong"
      aria-live="polite"
    >
      <StatusDot state={worst} size={13} />
      <span className="whitespace-nowrap">{text}</span>
    </Link>
  )
}

// Alerts view badge: firing, non-suppressed alerts (same computation as the bell)
function AlertBadge({ className = '' }) {
  const { data } = useSource('alerts')
  const [env] = useEnv()
  const firing = firingOf(data, env)
  if (!firing.length) return null
  // color from the shared rule (toneOf, through badgeOf, like the bell)
  const { tone } = badgeOf(firing)
  return (
    <span className={`min-w-[1.25rem] rounded-full px-1.5 text-center text-2xs font-semibold tabular-nums leading-5 ${BADGE_CLASS[tone]} ${className}`} aria-label={t('shell.badge_alerts', { count: firing.length })}>
      {firing.length}
    </span>
  )
}

// new devices on the LAN (network module)
function NetworkBadge({ className = '' }) {
  const { data } = useSource('network')
  // new devices + automatically attached MACs, to confirm
  const n = (data?.counts?.new ?? 0) + (data?.counts?.pending ?? 0)
  if (!n) return null
  return (
    <span className={`min-w-[1.25rem] rounded-full px-1.5 text-center text-2xs font-semibold tabular-nums leading-5 ${BADGE_CLASS.warn} ${className}`} aria-label={t('shell.badge_network', { count: n })}>
      {n}
    </span>
  )
}

// updates to handle (the default Updates view); red on security or end of life
function UpdatesBadge({ className = '' }) {
  const { data } = useSource('updates')
  const [env] = useEnv()
  // same filter and same groups as the cockpit tile; color by toneOf
  const todo = todoOf(data, env)
  if (!todo.length) return null
  const k = updateCounts(todo)
  return (
    <span className={`min-w-[1.25rem] rounded-full px-1.5 text-center text-2xs font-semibold tabular-nums leading-5 ${BADGE_CLASS[toneOf(k.r, k.o, k.b)]} ${className}`} aria-label={t('shell.badge_updates', { count: todo.length })}>
      {todo.length}
    </span>
  )
}

const BADGES = { alerts: AlertBadge, network: NetworkBadge, updates: UpdatesBadge }
function Badge({ kind, className }) {
  const B = BADGES[kind]
  return B ? <B className={className} /> : null
}

const THEME_ICON = { auto: Monitor, light: Sun, dark: Moon }

// the sidebar (main entries, then the bottom ones) and the mobile bar (mobile entries: not
// Integrations) follow the registry; mobile bar columns by number of entries (Tailwind classes
// written in full, for the build; 1 to 8 entries); beyond 8, the bar no longer fits at 360 px
const SIDE_MAIN = VIEWS.filter(v => v.placement !== 'bottom')
const SIDE_BOTTOM = VIEWS.filter(v => v.placement === 'bottom')
const MOBILE = VIEWS.filter(v => v.mobile !== false)
const MOBILE_COLS = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6', 7: 'grid-cols-7', 8: 'grid-cols-8' }
export const MOBILE_MAX = 8
// development error (view registry), in English like the logs
if (MOBILE.length > MOBILE_MAX) throw new Error(`mobile bar: ${MOBILE.length} entries, ${MOBILE_MAX} at most (mobile: false for the others)`)

// one sidebar entry
function SideLink({ v, active, env }) {
  return (
    <li>
      <Link
        href={withEnv(v.path, env)}
        aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${active ? 'bg-surface-3 text-fg font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
      >
        <v.icon size={16} aria-hidden className={active ? 'text-accent' : ''} />
        {v.label}
        {v.badge && <Badge kind={v.badge} className="ml-auto" />}
      </Link>
    </li>
  )
}

export default function Shell({ config, theme, setTheme, onSearch, children }) {
  const [location] = useLocation()
  const [env] = useEnv()
  const ThemeIcon = THEME_ICON[theme]
  const isActive = p => (p === '/' ? location === '/' : location.startsWith(p))

  return (
    // container made inert while a drawer is open (lib/inert.js)
    <div id={APP_SHELL_ID} className="min-h-full md:pl-52">
      {/* sidebar (desktop) */}
      <nav aria-label={t('shell.main_navigation')} className="hidden md:flex fixed inset-y-0 left-0 w-52 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line">
          <div className="size-8 rounded-lg bg-accent/15 grid place-items-center text-accent"><LayoutDashboard size={18} aria-hidden /></div>
          <span className="text-sm font-bold leading-tight text-fg">{config?.title || 'Vigie'}</span>
        </div>
        <ul className="flex-1 p-2 space-y-0.5">
          {SIDE_MAIN.map(v => <SideLink key={v.path} v={v} active={isActive(v.path)} env={env} />)}
        </ul>
        {SIDE_BOTTOM.length > 0 && (
          <ul className="p-2 space-y-0.5 border-t border-line">
            {SIDE_BOTTOM.map(v => <SideLink key={v.path} v={v} active={isActive(v.path)} env={env} />)}
          </ul>
        )}
        <div className="p-4 text-2xs text-subtle border-t border-line">{config?.footer}</div>
      </nav>

      {/* header */}
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
        {/* under 375 px, tighter margins and spacing (no horizontal scrolling at 320-360 px) */}
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center gap-3 max-[374px]:gap-1.5 max-[374px]:px-2">
          {/* under sm (640 px), title visually hidden (on a phone it only fitted as "I…" or at
              0 px), read by screen readers; visible from sm to md, then in the sidebar */}
          <div className="min-w-0 md:hidden max-sm:sr-only">
            <h1 className="text-sm font-bold leading-tight text-fg truncate">{config?.title || 'Vigie'}</h1>
          </div>
          <p className="hidden md:block text-xs text-muted truncate min-w-0">{config?.subtitle}</p>
          <div className="ml-auto flex items-center gap-2 max-[374px]:gap-1">
            <div className="hidden sm:block"><StateSummary /></div>
            <AlertBell />
            <EnvSwitch />
            <RefreshButton />
            <button
              type="button"
              onClick={onSearch}
              className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-muted hover:border-line-strong hover:text-fg max-[374px]:px-1.5"
              aria-label={t('shell.search_ctrl_k')}
            >
              <Search size={14} aria-hidden />
              <span className="hidden lg:inline">{t('shell.search')}</span>
              {/* never on two lines */}
              <kbd className="hidden lg:inline whitespace-nowrap font-mono text-2xs text-subtle border border-line rounded px-1">Ctrl K</kbd>
            </button>
            <button
              type="button"
              onClick={() => setTheme(nextTheme(theme))}
              className="rounded-lg border border-line bg-surface p-1.5 text-muted hover:text-fg max-[374px]:p-1"
              aria-label={t('shell.theme_change', { theme: THEME_LABEL[theme] })}
              title={t('shell.theme', { theme: THEME_LABEL[theme] })}
            >
              <ThemeIcon size={15} aria-hidden />
            </button>
            <AdminButton />
            <div className="hidden lg:block"><Clock /></div>
          </div>
        </div>
        <div className="sm:hidden border-t border-line px-4 py-1.5"><StateSummary /></div>
      </header>

      <main className="mx-auto max-w-7xl px-4 md:px-6 py-6 pb-24 md:pb-8">
        {children}
      </main>

      {/* tab bar (mobile) */}
      <nav aria-label={t('shell.navigation_mobile')} className="md:hidden fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        <ul className={`grid ${MOBILE_COLS[MOBILE.length]}`}>
          {MOBILE.map(v => (
            <li key={v.path}>
              <Link
                href={withEnv(v.path, env)}
                aria-current={isActive(v.path) ? 'page' : undefined}
                className={`relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-2xs ${isActive(v.path) ? 'text-accent font-medium' : 'text-muted'}`}
              >
                {/* badge anchored on the icon (it no longer overflows the last cell at 320-360 px) */}
                <span className="relative inline-flex">
                  <v.icon size={18} aria-hidden />
                  {v.badge && <Badge kind={v.badge} className="absolute -top-2 -right-2.5" />}
                </span>
                {/* under 360 px, icon only (label read by screen readers); short label beyond */}
                <span className="sr-only min-[360px]:not-sr-only">{v.short || v.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
