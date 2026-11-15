import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { Bell } from 'lucide-react'
import { useSource } from './api.js'
import { useEnv, matchEnv } from './hooks/useUrlState.js'
import { withEnv } from './nav.js'
import { StatusDot } from './ui/Status.jsx'
import TimeAgo from './ui/TimeAgo.jsx'
import { listenBellEscape } from './lib/escape.js'
import { toneOf, BADGE_CLASS } from './lib/tone.js'
import { RULE_LABEL } from './lib/alerts.js'
import { duration } from './lib/format.js'
import { t } from './i18n/index.js'

// Alert bell: disclosure button in the header, badge of the firing, non-suppressed alerts,
// non-modal drop-down panel (5 rows at most). The pure parts (firingOf, panelOf, badgeOf,
// BellButton, AlertRows) are driven by props and tested by a real render.

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
const SEV_STATE = { critical: 'crit', warning: 'warn', info: 'info' }

// firing, non-suppressed alerts of the env (bell badge and menu badge)
export const firingOf = (data, env) => (data?.active ?? []).filter(a => a.state === 'firing' && !a.suppressed && matchEnv(env, a.env))
// firing alerts of the env, suppressed ones included (panel content), in API order
export const panelOf = (data, env) => (data?.active ?? []).filter(a => a.state === 'firing' && matchEnv(env, a.env))
// badge number and color: counters by severity, color by toneOf (shared rule)
export function badgeOf(firing) {
  const n = severity => firing.filter(a => a.severity === severity).length
  const critical = n('critical'), warning = n('warning'), info = n('info')
  return { count: firing.length, critical, warning, info, tone: toneOf(critical, warning, info) }
}

const bellLabel = n => (n ? t('bell.label', { count: n }) : t('bell.label_none'))

export function BellButton({ count, tone, open, panelId, onClick, buttonRef }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={bellLabel(count)}
      aria-expanded={open ? 'true' : 'false'}
      aria-controls={panelId}
      className="relative rounded-lg border border-line bg-surface p-1.5 text-muted hover:text-fg"
    >
      <Bell size={15} aria-hidden />
      {count > 0 && (
        <span aria-hidden="true" className={`absolute -right-1.5 -top-1.5 min-w-[1.125rem] rounded-full px-1 text-center text-2xs font-semibold tabular-nums leading-[1.125rem] ${BADGE_CLASS[tone]}`}>
          {count}
        </span>
      )}
    </button>
  )
}

// alert rows, shared by the bell and the "Active alerts" panel of the wall display
export function AlertRows({ list, env, max = 5, lastResolved }) {
  if (!list.length) {
    return (
      <div className={`${card} flex items-center gap-3 bg-ok-bg px-4 py-3`}>
        <StatusDot state="ok" size={18} />
        <div>
          <div className="text-sm font-medium text-ok">{t('bell.no_active_alerts')}</div>
          <div className="text-2xs text-muted">
            {lastResolved ? <>{t('bell.last_resolved')} {lastResolved.title} <TimeAgo date={lastResolved.resolvedAt} /></> : t('bell.no_incidents_7_days')}
          </div>
        </div>
      </div>
    )
  }
  return (
    <ul className="space-y-1.5">
      {list.slice(0, max).map(a => (
        <li key={a.key}>
          <Link href={withEnv(a.link || '/alerts', env)} className={`${card} flex items-center gap-2.5 px-3 py-2 hover:border-line-strong ${a.suppressed ? 'opacity-70' : ''}`}>
            <StatusDot state={a.suppressed ? 'maint' : SEV_STATE[a.severity]} size={14} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg truncate">{a.title}</div>
              <div className="text-2xs text-muted truncate">{a.suppressed || a.detail || RULE_LABEL[a.rule]}</div>
            </div>
            <span className="shrink-0 text-2xs text-subtle">{duration(Date.now() - a.since)}</span>
          </Link>
        </li>
      ))}
      {list.length > max && <li><Link href={withEnv('/alerts', env)} className="text-xs text-accent hover:underline">{t('bell.more', { n: list.length - max })}</Link></li>}
    </ul>
  )
}

export function AlertBell() {
  const { data } = useSource('alerts')
  const [env] = useEnv()
  const [location] = useLocation()
  const search = useSearch()
  const [open, setOpen] = useState(false)
  const [announce, setAnnounce] = useState('')
  const button = useRef(null)
  const panel = useRef(null)
  const lastCount = useRef(null)
  const panelId = useId()
  const { count, tone } = badgeOf(firingOf(data, env))
  const list = panelOf(data, env)
  const lastResolved = data?.incidents?.find(i => i.resolvedAt && matchEnv(env, i.env))

  // live region: announces the number only when it changes after the first read
  useEffect(() => {
    if (!data) return
    if (lastCount.current != null && lastCount.current !== count) setAnnounce(bellLabel(count))
    lastCount.current = count
  }, [data, count])

  // close on any change of path or query (a /reseau?d=… link from /reseau)
  useEffect(() => {
    setOpen(false)
  }, [location, search])

  // open panel: focus on the first link, Escape (capture) closes and gives the focus back to the
  // bell, a click outside the button and the panel closes (the focus stays where you clicked)
  useEffect(() => {
    if (!open) return
    ;(panel.current?.querySelector('a') ?? panel.current)?.focus()
    const off = listenBellEscape(window, {
      close: () => {
        setOpen(false)
        button.current?.focus()
      },
    })
    const onDown = e => {
      if (!button.current?.contains(e.target) && !panel.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => {
      off()
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  // panel: full screen width (fixed inset-x-2) up to md; anchored under the bell from md only,
  // when the sidebar moves it far enough from the left edge for 22 rem
  // (between sm and md, anchoring pushed the panel off the left of the screen)
  return (
    <div className="relative">
      <BellButton count={count} tone={tone} open={open} panelId={panelId} onClick={() => setOpen(o => !o)} buttonRef={button} />
      <span className="sr-only" aria-live="polite">{announce}</span>
      {open && (
        <div
          id={panelId}
          ref={panel}
          role="region"
          aria-label={t('bell.active_alerts')}
          tabIndex={-1}
          onClick={e => { if (e.target.closest?.('a')) setOpen(false) }}
          className="fixed inset-x-2 top-14 z-30 max-h-[70vh] overflow-y-auto rounded-[var(--radius-card)] border border-line bg-surface p-3 shadow-xl md:absolute md:inset-x-auto md:right-0 md:top-full md:mt-2 md:w-[22rem]"
        >
          <AlertRows list={list} env={env} lastResolved={lastResolved} />
        </div>
      )}
    </div>
  )
}
