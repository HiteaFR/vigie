import { useState } from 'react'
import { Link } from 'wouter'
import {
  LayoutGrid, Server, Bell, ShieldCheck, Archive, Activity, Star, Cpu, MonitorPlay, PackageCheck, Network,
  Sun, Moon, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudSun,
} from 'lucide-react'
import { useJson, useSource } from '../api.js'
import { useEnv, useUrlParam, matchEnv, } from '../hooks/useUrlState.js'
import { useFavorites } from '../hooks/useFavorites.js'
import { withEnv } from '../nav.js'
import { RANK, stateOf } from '../lib/state.js'
import { pct, bytes, uptime } from '../lib/format.js'
import { StatusDot } from '../ui/Status.jsx'
import Kpi, { card } from '../ui/Kpi.jsx'
import { pluginTiles } from '../plugins/index.jsx'
import Panel, { ErrorBox, Skeleton } from '../ui/Panel.jsx'
import TimeAgo from '../ui/TimeAgo.jsx'
import Gauge from '../ui/Gauge.jsx'
import Sparkline from '../ui/Sparkline.jsx'
import UptimeBand from '../ui/UptimeBand.jsx'
import ServiceIcon from '../ui/ServiceIcon.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import CompactTile from '../components/CompactTile.jsx'
import { fmtUptime } from '../lib/format.js'
import { AlertRows, panelOf } from '../AlertBell.jsx'
// same computation as the bell (separate import: the line above is checked by a test)
import { firingOf } from '../AlertBell.jsx'
import { alertsKpi, updatesKpi } from '../lib/kpi.js'
import { todoOf } from '../lib/updates.js'
import { TEXT_CLASS, FILL_CLASS } from '../lib/tone.js'
import GapBadge from '../components/GapBadge.jsx'
import { displayGap } from '../lib/updates.js'
import { localeTag, t } from '../i18n/index.js'


function weatherIcon(w) {
  const c = w.code
  if (c == null) return Cloud
  if (c === 0 || c === 1) return w.isDay ? Sun : Moon
  if (c === 2) return CloudSun
  if (c === 45 || c === 48) return CloudFog
  if (c >= 71 && c <= 86 && c !== 80 && c !== 81 && c !== 82) return CloudSnow
  if (c >= 95) return CloudLightning
  if (c >= 51) return CloudRain
  return Cloud
}

// Weather: separate card, next to the banner on large screens, below it on mobile
function Weather({ w, big }) {
  if (!w) return null
  const Icon = weatherIcon(w)
  const r = v => (v == null ? '—' : Math.round(v))
  return (
    <section className={`${card} flex items-center gap-3 px-4 ${big ? 'py-5' : 'py-3'} lg:min-w-72`} aria-label={t('cockpit.weather_at', { place: w.label })}>
      <Icon size={big ? 36 : 30} aria-hidden className="shrink-0 text-fg" />
      <div className="shrink-0">
        <div className={`${big ? 'text-3xl' : 'text-2xl'} font-bold leading-none tabular-nums text-fg`}>{r(w.temp)}°</div>
        <div className="mt-1 text-2xs text-subtle">{w.label}</div>
      </div>
      <div className={`min-w-0 flex-1 ${big ? 'text-sm' : 'text-xs'} text-muted leading-snug`}>
        <div className="font-medium text-fg truncate">{w.text ?? '—'}</div>
        <div className="tabular-nums">{t('cockpit.weather_feels_like', { min: r(w.min), max: r(w.max), feels: r(w.feels) })}</div>
        <div className="tabular-nums">{t('cockpit.weather_wind', { wind: r(w.wind), rain: w.rain ?? 0 })}</div>
        {/* data source attribution (Open-Meteo terms), discreet */}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-2xs text-subtle hover:underline">{t('cockpit.weather_source')}</a>
      </div>
    </section>
  )
}

// global state banner
function Banner({ q, mural, env }) {
  const s = q.data
  let state, title, sub
  if (q.error && (!q.dataUpdatedAt || Date.now() - q.dataUpdatedAt > 60_000)) {
    state = 'unknown'
    title = t('cockpit.dashboard_disconnected_server')
    sub = q.dataUpdatedAt ? <>{t('cockpit.last_data')} <TimeAgo date={q.dataUpdatedAt} /></> : String(q.error.message)
  } else if (!s) {
    state = 'unknown'
    title = t('cockpit.collecting')
  } else {
    state = s.state
    const a = s.alerts
    if (state === 'ok') title = t('cockpit.operational')
    else if (state === 'unknown') title = t('cockpit.partial_data')
    else title = t('cockpit.degraded', { list: [a.critical && t('kpi.critical', { count: a.critical }), a.warning && t('kpi.warning', { count: a.warning })].filter(Boolean).join(', ') })
    sub = state === 'unknown'
      ? t('cockpit.source_down', { list: s.sourcesDown.join(' · ') })
      : t('cockpit.banner_sub', { ok: s.services.ok, total: s.services.total, run: s.guests.running, guests: s.guests.total })
  }
  const st = stateOf(state)
  const stripes = state === 'unknown' && q.error ? 'bg-[repeating-linear-gradient(135deg,transparent_0_8px,var(--surface-3)_8px_16px)]' : ''
  return (
    <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <section className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-card)] border border-line ${st.bg} ${stripes} px-4 ${mural ? 'py-5' : 'py-3'}`} aria-live="polite">
        <StatusDot state={state} size={mural ? 30 : 22} />
        <div className="min-w-0 flex-1">
          <h1 className={`${mural ? 'text-2xl' : 'text-base'} font-bold ${st.text}`}>{title}</h1>
          {sub && <p className={`${mural ? 'text-sm' : 'text-xs'} text-muted sm:truncate`}>{sub}</p>}
        </div>
        {/* hidden on mobile: the title takes the whole width there, the wall display mode
            stays reachable from the header */}
        <div className="hidden sm:flex items-center gap-3 text-2xs text-subtle">
          {q.dataUpdatedAt ? <span>{t('cockpit.updated')} <TimeAgo date={q.dataUpdatedAt} /></span> : null}
          {!mural && (
            <Link href={withEnv('/wall', env)} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted hover:text-fg" title={t('cockpit.wall_mode_dedicated_screen')}>
              <MonitorPlay size={13} aria-hidden /> {t('cockpit.wall')}
            </Link>
          )}
        </div>
      </section>
      <Weather w={s?.weather} big={mural} />
    </div>
  )
}

// separator of three-number tiles: non-breaking thin spaces around the middle dot
function Sep() {
  return <span className="font-normal text-subtle">{'\u202f·\u202f'}</span>
}
// three colored numbers (red, orange, blue); a zero is dimmed; with a separate accessible text
// (color never carries the meaning alone)
function Tri({ k }) {
  if (!k.parts) return k.value
  return (
    <>
      <span className="sr-only">{k.label}</span>
      <span aria-hidden="true">
        {k.parts.map((p, i) => (
          <span key={p.tone}>
            {i > 0 && <Sep />}
            <span className={p.n ? TEXT_CLASS[p.tone] : 'text-subtle'}>{p.n}</span>
          </span>
        ))}
      </span>
    </>
  )
}

// plugin tiles (static registry): indicators after the core ones and before the network one;
// cards after the core ones (not on the wall display). Wide-screen columns depend on the number
// of indicators (Tailwind classes written in full, for the build)
const KPI_TILES = pluginTiles('kpi')
const CARD_TILES = pluginTiles('cards')
const KPI_XL = { 6: 'xl:grid-cols-6', 7: 'xl:grid-cols-7', 8: 'xl:grid-cols-8', 9: 'xl:grid-cols-9', 10: 'xl:grid-cols-10' }

// seven indicators
function Kpis({ s, env, mural }) {
  // firing alerts counted like the bell (same data, same computation)
  const alerts = useSource('alerts')
  // updates counted like the menu badge (same source, same filter)
  const updates = useSource('updates')
  if (!s) return <Skeleton count={6} h="h-24" cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6" />
  const sv = s.services
  const bk = s.backups
  const bkOk = bk.reduce((a, b) => a + b.ok, 0)
  const bkTotal = bk.reduce((a, b) => a + b.total, 0)
  const bkFailed = bk.some(b => b.failed.length)
  const bkErr = bk.some(b => b.error)
  const g = s.guests
  // without alert data (loading, error), the counters from /api/summary
  const ak = alerts.data ? alertsKpi(firingOf(alerts.data, env), s.alerts) : alertsKpi(null, s.alerts)
  // without /api/updates (including while loading), "—": no fallback to /api/summary
  const uk = updates.data ? updatesKpi(todoOf(updates.data, env)) : updatesKpi(null)
  const net = s.network
  return (
    <div className={`mb-6 grid gap-3 grid-cols-2 md:grid-cols-4 ${KPI_XL[6 + KPI_TILES.length + (net ? 1 : 0)]}`}>
      <Kpi mural={mural} icon={LayoutGrid} label={t('cockpit.kpi_services')} value={`${sv.ok}/${sv.total}`}
        sub={sv.crit || sv.warn ? t('cockpit.svc_bad', { crit: sv.crit, warn: sv.warn }) : sv.medianLatencyMs != null ? t('cockpit.median_latency', { ms: sv.medianLatencyMs }) : t('cockpit.online')}
        state={sv.crit ? 'crit' : sv.warn ? 'warn' : sv.unknown === sv.total ? 'unknown' : 'ok'}
        href={withEnv(sv.crit || sv.warn ? '/services?state=crit,warn' : '/services', env)} />
      <Kpi mural={mural} icon={Server} label={t('cockpit.kpi_guests')} value={g.total ? `${g.running}/${g.total}` : '—'}
        sub={g.errors.length ? g.errors[0] : g.stoppedDeclared.length ? t('cockpit.stopped', { list: g.stoppedDeclared.join(', ') }) : Object.entries(g.byEnv).map(([e, v]) => `${e} ${v.running}/${v.total}`).join(' · ')}
        state={g.errors.length ? 'unknown' : g.stoppedDeclared.length ? 'warn' : 'ok'} href={withEnv('/infra', env)} />
      <Kpi mural={mural} tri em={ak.em} icon={Bell} label={t('cockpit.kpi_alerts')} value={<Tri k={ak} />} sub={ak.sub} state={ak.state} href={withEnv('/alerts', env)} />
      <Kpi mural={mural} tri em={uk.em} icon={PackageCheck} label={t('cockpit.kpi_updates')} value={<Tri k={uk} />} sub={uk.sub} state={uk.state} href={withEnv('/updates', env)} />
      <Kpi mural={mural} icon={ShieldCheck} label={t('cockpit.kpi_certs')} value={s.certs.minDays != null ? t('cockpit.days', { n: s.certs.minDays }) : '—'}
        sub={s.certs.minName ? t('cockpit.cert_next', { name: s.certs.minName, total: s.certs.total }) : t('cockpit.no_cert')}
        state={s.certs.minDays == null ? 'unknown' : s.certs.minDays < 7 ? 'crit' : s.certs.minDays < 21 ? 'warn' : 'ok'} href={withEnv('/services', env)} />
      <Kpi mural={mural} icon={Archive} label={t('cockpit.kpi_backups')} value={bkTotal ? `${bkOk}/${bkTotal}` : '—'}
        sub={bkErr ? t('cockpit.source_unreachable') : bk.map(b => `${b.node} ${b.ok}/${b.total}`).join(' · ')}
        state={bkFailed ? 'crit' : bkErr ? 'unknown' : bkOk < bkTotal ? 'warn' : 'ok'} href={withEnv('/backups', env)} />
      {/* plugin tiles (CI indicator of the gitea plugin) */}
      {KPI_TILES.map(t => <t.component key={t.order} s={s} env={env} mural={mural} net={net} />)}
      {/* network: missing if the module is not configured; "online" only with the ARP probe
          (presence 'arp'): never the Pi-hole freshness; otherwise "active" */}
      {net && (() => {
        const arp = net.presence === 'arp'
        const what = arp ? t('cockpit.net_online') : t('cockpit.net_active')
        return (
          <Kpi mural={mural} icon={Network} label={t('cockpit.kpi_network')} value={`${arp ? net.online : net.active}/${net.total}`}
            sub={net.sourcesDown.length ? t('cockpit.net_down', { list: net.sourcesDown.join(', ') }) : net.new ? t('cockpit.net_new', { what, count: net.new }) : t('cockpit.net_devices', { what })}
            state={net.new ? 'warn' : net.sourcesDown.length ? 'unknown' : 'ok'} href={withEnv(net.new ? '/network?state=new' : '/network', env)} />
        )
      })()}
    </div>
  )
}

// active alerts (5 max): only in wall display mode; elsewhere, the bell in the header; rows
// shared with the bell (AlertRows)
function ActiveAlerts({ env }) {
  const q = useSource('alerts')
  const list = panelOf(q.data, env)
  const lastResolved = q.data?.incidents.find(i => i.resolvedAt && matchEnv(env, i.env))
  return (
    <Panel icon={Bell} title={t('cockpit.active_alerts')} query={q} skeleton={<Skeleton count={2} h="h-12" cols="" />}>
      <AlertRows list={list} env={env} lastResolved={lastResolved} />
    </Panel>
  )
}

// one hypervisor: gauges + 24 h sparklines (rrddata)
function Hypervisor({ c }) {
  const node = c.nodes?.[0]
  const rrd = useJson(node ? `/api/rrd/${c.id}/${encodeURIComponent(node.name)}?timeframe=day` : null, 60_000)
  if (c.error) return <div className={`${card} p-4`}><ErrorBox prefix={c.label} msg={c.error} /></div>
  if (!node) return null
  const main = c.storages?.find(s => s.name === 'local-lvm') || c.storages?.[0]
  const run = c.guests.filter(g => g.status === 'running')
  const vms = c.guests.filter(g => g.type === 'qemu')
  const cts = c.guests.filter(g => g.type === 'lxc')
  const pts = rrd.data || []
  return (
    <div className={`${card} p-4`}>
      <div className="flex items-center gap-2">
        <StatusDot state={node.status === 'online' ? 'ok' : 'crit'} size={14} />
        <span className="text-sm font-semibold text-fg">{node.name}</span>
        <span className="text-2xs text-subtle truncate">{c.label.split('—')[0].trim()}</span>
        <span className="ml-auto text-2xs text-subtle">uptime {uptime(node.uptime)}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Gauge value={pct(node.cpu, 1)} label={`CPU · ${node.maxcpu}`} />
        <Gauge value={pct(node.mem, node.maxmem)} label={`RAM · ${bytes(node.maxmem)}`} />
        {main && <Gauge value={pct(main.disk, main.maxdisk)} label={main.name} />}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xs text-subtle">CPU 24 h</div>
          <Sparkline values={pts.map(p => p.cpu)} max={100} height={36} className="text-accent" label={t('cockpit.cpu_over_24_h')} />
        </div>
        <div>
          <div className="text-2xs text-subtle">RAM 24 h</div>
          <Sparkline values={pts.map(p => p.mem)} max={100} height={36} className="text-info" label={t('cockpit.ram_over_24_h')} />
        </div>
      </div>
      <div className="mt-2 text-2xs text-muted">
        {t('cockpit.hv_guests', { run: run.length, total: c.guests.length, vm: vms.length, ct: cts.length })}
      </div>
    </div>
  )
}

function Hypervisors({ env }) {
  const q = useSource('cluster')
  const list = q.data?.filter(c => matchEnv(env, c.id))
  return (
    <Panel icon={Cpu} title={t('cockpit.hypervisors')} query={q} skeleton={<Skeleton count={2} h="h-44" cols="md:grid-cols-2" />}>
      {/* a single card takes the whole row; two columns from two cards upward */}
      <div className={`grid grid-cols-1 gap-3 ${list?.length > 1 ? 'md:grid-cols-2' : ''} [&>*]:min-w-0`}>
        {list?.map(c => <Hypervisor key={c.id} c={c} />)}
      </div>
    </Panel>
  )
}

// service health: 24 h uptime bands, non-ok first
function Health({ env, rows = 10 }) {
  const q = useSource('services')
  const [favs] = useFavorites()
  const [, openHistory] = useUrlParam('s')
  const [all, setAll] = useState(false)
  const list = (q.data?.services || [])
    .filter(s => matchEnv(env, s.env) && s.state !== 'none')
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9)
      || (a.uptime24h ?? 101) - (b.uptime24h ?? 101)
      || Number(b.pinned || favs.has(b.id)) - Number(a.pinned || favs.has(a.id))
      || a.name.localeCompare(b.name))
  const shown = all ? list : list.slice(0, rows)
  return (
    <Panel icon={Activity} title={t('cockpit.service_health_24_h')} query={q} skeleton={<Skeleton count={1} h="h-64" cols="" />}>
      <ul className={`${card} divide-y divide-line`}>
        {shown.map(s => (
          <li key={s.id}>
            {/* up to lg (1024 px), the uptime band (48 cells, at least 143 px) moves to its own
                line; inline, it overflowed onto the percentage at 768 px */}
            <button type="button" onClick={() => openHistory(s.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left hover:bg-surface-2 lg:flex-nowrap">
              <ServiceIcon name={s.name} iconUrl={s.iconUrl} iconUrlDark={s.iconUrlDark} size={20} />
              <span className="min-w-0 flex-1 truncate text-sm text-fg lg:w-40 lg:flex-none lg:shrink-0">{s.name}</span>
              <UptimeBand band={s.band24h} height="h-4" className="order-last basis-full min-w-0 lg:order-none lg:basis-auto lg:flex-1" />
              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-fg">{fmtUptime(s.uptime24h)}</span>
              <span className="hidden sm:block w-14 shrink-0 text-right text-2xs tabular-nums text-subtle">{s.latencyMs != null ? `${s.latencyMs} ms` : '—'}</span>
              <StatusDot state={s.state} size={13} />
            </button>
          </li>
        ))}
      </ul>
      {list.length > rows && (
        <button type="button" onClick={() => setAll(x => !x)} className="mt-2 text-xs text-accent hover:underline">
          {all ? t('cockpit.collapse') : t('cockpit.see_all', { n: list.length })}
        </button>
      )}
    </Panel>
  )
}

// backups: up to date / late / failed bar per hypervisor
// pending updates: the six with the highest priority
function UpdatesCard({ env }) {
  const q = useSource('updates')
  const list = (q.data?.components || []).filter(c => matchEnv(env, c.env) && !c.ignored
    && ((c.gap && !['same', 'ahead'].includes(c.gap)) || c.eol?.passed) && c.kind !== 'apt')
  return (
    <Panel icon={PackageCheck} title={t('cockpit.updates')} query={q} skeleton={<Skeleton count={1} h="h-40" cols="" />}>
      <div className={`${card} p-3`}>
        {list.length === 0
          ? <p className="px-1 py-2 text-xs text-muted">{q.data?.checkedAt ? <>{t('cockpit.all_up_to_date')} <TimeAgo date={q.data.checkedAt} /></> : t('updates.first_check')}</p>
          : (
            <ul className="space-y-1.5">
              {list.slice(0, 6).map(c => (
                <li key={c.id} className="flex min-w-0 items-center gap-2 text-xs">
                  <GapBadge c={c} gap={displayGap(c)} />
                  <span className="truncate text-fg" title={`${c.name} · ${c.where || ''}`}>{c.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-2xs text-muted">
                    {c.eol?.passed && (!c.latest || c.latest === c.current) ? `${c.current} EOL` : c.gap === 'digest' ? c.current : `${c.current} → ${c.latest}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        <Link href={withEnv('/updates', env)} className="mt-3 block text-xs text-accent hover:underline">
          {list.length > 6 ? t('cockpit.more', { n: list.length - 6 }) : ''}{t('cockpit.all_updates')}
        </Link>
      </div>
    </Panel>
  )
}

function BackupsCard({ s, env }) {
  return (
    <Panel icon={Archive} title={t('cockpit.backups')}>
      <div className={`${card} p-4 space-y-3`}>
        {!s ? <div className="h-16 animate-pulse" /> : s.backups.map(b => (
          <div key={b.id}>
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-fg">{b.node}</span>
              <span className="text-subtle">{b.error ? t('cockpit.source_unreachable') : t('cockpit.bk_ok', { ok: b.ok, total: b.total })}</span>
              {b.last && <span className="ml-auto text-2xs text-subtle">{t('cockpit.bk_last')} <TimeAgo date={b.last} />{b.next ? t('cockpit.bk_next', { when: new Date(b.next).toLocaleString(localeTag(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }) : ''}</span>}
            </div>
            {!b.error && b.total > 0 && (
              <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={t('cockpit.bk_bar', { ok: b.ok, late: b.late.length, failed: b.failed.length })}>
                <span className={FILL_CLASS.ok} style={{ width: `${(b.ok / b.total) * 100}%` }} />
                <span className={FILL_CLASS.warn} style={{ width: `${(b.late.length / b.total) * 100}%` }} />
                <span className={FILL_CLASS.crit} style={{ width: `${(b.failed.length / b.total) * 100}%` }} />
              </div>
            )}
            {(b.late.length > 0 || b.failed.length > 0) && (
              <div className="mt-1 text-2xs text-muted">
                {b.failed.length > 0 && <span className="text-crit">{t('cockpit.bk_failed', { list: b.failed.join(', ') })}</span>}
                {b.late.length > 0 && <span className="text-warn">{t('cockpit.bk_late', { list: b.late.join(', ') })}</span>}
              </div>
            )}
          </div>
        ))}
        <Link href={withEnv('/backups', env)} className="block text-xs text-accent hover:underline">{t('cockpit.details_per_guest')}</Link>
      </div>
    </Panel>
  )
}

// pinned (config) and favorites (browser)
function Pinned({ env }) {
  const q = useSource('services')
  const [favs] = useFavorites()
  const list = (q.data?.services || []).filter(s => matchEnv(env, s.env) && (s.pinned || favs.has(s.id)))
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9))
  return (
    <Panel icon={Star} title={t('cockpit.pinned')}>
      {list.length
        ? <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(150px,100%),1fr))]">{list.map(s => <CompactTile key={s.id} s={s} />)}</div>
        : <EmptyState icon={Star} title={t('cockpit.no_favorites')} hint={t('cockpit.pin_service_services_view')} />}
    </Panel>
  )
}

export default function Cockpit({ mural = false }) {
  const [env] = useEnv()
  const summary = useJson(`/api/summary${env !== 'all' ? `?env=${env}` : ''}`, 10_000)
  const s = summary.data
  return (
    <>
      <Banner q={summary} mural={mural} env={env} />
      <Kpis s={s} env={env} mural={mural} />
      {/* min-w-0: a grid cell must not widen for a long word; outside the wall display, the
          alerts live in the bell and the hypervisors take the whole width */}
      {mural ? (
        <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-2"><ActiveAlerts env={env} /></div>
          <div className="min-w-0 lg:col-span-3"><Hypervisors env={env} /></div>
        </div>
      ) : (
        <div className="min-w-0"><Hypervisors env={env} /></div>
      )}
      <Health env={env} rows={mural ? 14 : 10} />
      {!mural && (
        <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2 xl:grid-cols-3">
          <div className="min-w-0"><UpdatesCard env={env} /></div>
          <div className="min-w-0"><BackupsCard s={s} env={env} /></div>
          {CARD_TILES.map(t => <div key={t.order} className="min-w-0"><t.component env={env} /></div>)}
        </div>
      )}
      {!mural && <Pinned env={env} />}
    </>
  )
}
