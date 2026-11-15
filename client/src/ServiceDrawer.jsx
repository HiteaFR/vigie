import { useEffect, useRef, useEffectEvent } from 'react'
import { X, ExternalLink, History } from 'lucide-react'
import { useJson, useSource } from './api.js'
import { useUrlParam } from './hooks/useUrlState.js'
import { StatusBadge, StatusDot } from './ui/Status.jsx'
import ServiceIcon from './ui/ServiceIcon.jsx'
import UptimeBand from './ui/UptimeBand.jsx'
import Sparkline from './ui/Sparkline.jsx'
import WidgetFields from './ui/WidgetFields.jsx'
import { duration } from './lib/format.js'
import { listenDrawerEscape } from './lib/escape.js'
import { holdInert } from './lib/inert.js'
import { localeTag, t } from './i18n/index.js'

// label range.<id>, read at render time
const RANGES = ['24h', '7d', '30d', '90d']

const fmtPct = v => (v == null ? '—' : `${v.toFixed(v >= 99.95 || v === 0 ? 0 : 2)} %`)
const when = t => new Date(t).toLocaleString(localeTag(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function CheckHistory({ c, data }) {
  const lat = c.points.map(p => p.lat)
  const avg = lat.filter(x => x != null)
  const mean = avg.length ? Math.round(avg.reduce((a, b) => a + b, 0) / avg.length) : null
  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <StatusDot state={c.state} size={13} />
        <span className="text-sm font-medium text-fg truncate">{c.label || c.type.toUpperCase()}</span>
        <span className="text-2xs uppercase text-subtle">{c.type}</span>
        <span className="ml-auto text-xs tabular-nums text-fg" title={t('drawer.availability_over_period')}>{fmtPct(c.uptime)}</span>
      </div>
      <div className="mt-1 font-mono text-2xs text-subtle truncate" title={c.target}>{c.target}</div>
      {c.type !== 'tls' && (
        <>
          <UptimeBand band={c.band} start={data.bandStart} size={data.bandSize} height="h-3" className="mt-2" />
          <div className="mt-2 flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <Sparkline values={lat} height={28} className="text-info" label={t('drawer.latency_of', { name: c.label || c.type })} />
            </div>
            <div className="shrink-0 text-right text-2xs text-subtle leading-tight">
              <div>{t('drawer.avg_latency')}</div>
              <div className="text-xs text-fg tabular-nums">{mean != null ? `${mean} ms` : '—'}</div>
            </div>
          </div>
        </>
      )}
      {c.tls && (
        <div className="mt-2 text-xs text-muted">
          {t('drawer.expires', { date: new Date(c.tls.validTo).toLocaleDateString(localeTag()), n: c.tls.daysLeft })}{c.tls.issuer ? ` · ${c.tls.issuer}` : ''}
        </div>
      )}
      {c.failures?.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-2xs text-muted">
          {c.failures.map(f => (
            <li key={f.t} className="flex gap-2"><span className="font-mono text-subtle">{when(f.t)}</span><span className="text-crit truncate">{f.error || t('drawer.code', { code: f.code })}</span></li>
          ))}
        </ul>
      )}
    </li>
  )
}

// Detail drawer of a service (?s=<id>): history, probes, incidents.
// Shareable link; Escape or a click outside the panel closes it.
export default function ServiceDrawer() {
  const [id, setId] = useUrlParam('s')
  const [range, setRange] = useUrlParam('range', '24h')
  const services = useSource('services')
  const hist = useJson(id ? `/api/history/service/${encodeURIComponent(id)}?range=${range}` : null, 60_000)
  const panel = useRef(null)
  const svc = services.data?.services.find(s => s.id === id)
  const close = () => {
    setRange('')
    setId('')
  }

  // Escape calls the CURRENT close (useEffectEvent), even if the URL changed since opening; the
  // effect still runs only on opening (focus, inert background, listener)
  const onEscape = useEffectEvent(() => close())
  useEffect(() => {
    if (!id) return
    const prev = document.activeElement
    // inert background (Shell), focus inside the drawer; released BEFORE the focus is given back
    const release = holdInert(document)
    panel.current?.focus()
    // Escape: ignored when it is meant for the bell or for a modal
    const off = listenDrawerEscape(window, () => onEscape(), document)
    return () => {
      off()
      release()
      prev?.focus?.()
    }
  }, [id])

  if (!id) return null
  const d = hist.data
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* backdrop clickable with the mouse, outside the tab order (Escape or "Close details" from the keyboard) */}
      <button type="button" aria-label={t('common.close')} tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={close} />
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('infra.detail_of', { name: svc?.name || id })}
        className="relative h-full w-full max-w-lg overflow-y-auto border-l border-line bg-bg p-4 shadow-2xl focus:outline-none sm:p-5"
      >
        <div className="flex items-start gap-3">
          {svc && <ServiceIcon name={svc.name} iconUrl={svc.iconUrl} iconUrlDark={svc.iconUrlDark} size={36} />}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-fg truncate">{svc?.name || id}</h2>
            {svc?.desc && <p className="text-xs text-muted">{svc.desc}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {svc && <StatusBadge state={svc.state} />}
              {svc?.url && (
                <a href={svc.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  {t('drawer.open')} <ExternalLink size={12} aria-hidden />
                </a>
              )}
              <span className="text-2xs uppercase text-subtle">{svc?.env}</span>
            </div>
          </div>
          <button type="button" onClick={close} className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-fg" aria-label={t('common.close_details')}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <WidgetFields widget={svc?.widget} className="mt-4" />

        <div className="mt-4 flex rounded-lg border border-line bg-surface p-0.5 w-fit" role="radiogroup" aria-label={t('drawer.period')}>
          {RANGES.map(v => (
            <button key={v} type="button" role="radio" aria-checked={range === v} onClick={() => setRange(v)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${range === v ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}>
              {t(`range.${v}`)}
            </button>
          ))}
        </div>

        {hist.error && <p className="mt-4 text-sm text-crit">{t('drawer.history_error', { err: String(hist.error.message) })}</p>}
        {!d && !hist.error && <div className="mt-4 h-40 rounded-[var(--radius-card)] border border-line bg-surface animate-pulse" />}
        {d && (
          <>
            {d.historySince && Date.now() - d.historySince < { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[range] * 86400_000 && (
              <p className="mt-3 text-2xs text-subtle">{t('drawer.history_since', { date: when(d.historySince) })}</p>
            )}
            <ul className="mt-3 space-y-2">
              {d.checks.map(c => <CheckHistory key={c.id} c={c} data={d} />)}
            </ul>
            <h3 className="mt-5 mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              <History size={13} aria-hidden /> {t('drawer.incidents')}
            </h3>
            {d.incidents.length ? (
              <ul className="space-y-1">
                {d.incidents.map(i => (
                  <li key={i.id} className="flex items-center gap-2 text-xs">
                    <StatusDot state={i.resolvedAt ? 'ok' : 'crit'} size={11} label={i.resolvedAt ? t('drawer.resolved') : t('drawer.ongoing')} />
                    <span className="font-mono text-subtle">{when(i.startedAt)}</span>
                    <span className="truncate text-muted" title={i.summary || ''}>{i.summary}</span>
                    <span className="ml-auto shrink-0 text-fg">{i.resolvedAt ? duration(i.resolvedAt - i.startedAt) : t('drawer.ongoing')}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-subtle">{t('drawer.no_incidents_period')}</p>}
          </>
        )}
      </section>
    </div>
  )
}
