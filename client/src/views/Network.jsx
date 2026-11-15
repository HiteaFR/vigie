import { useState, lazy, Suspense } from 'react'
import { Network as NetworkIcon, Search, Shuffle, Link2, CircleAlert, ListChecks, ArrowUpDown, Unlink, Radar } from 'lucide-react'
import { useSource, useJson } from '../api.js'
import { useAdmin, Modal, ReasonForm, btnGhost } from '../admin.jsx'
import { netKeys } from '../lib/netKeys.js'
import NetworkSuggestions from '../components/NetworkSuggestions.jsx'

// network map: loaded on demand, d3 only in its chunk
const NetworkMap = lazy(() => import('../NetworkMap.jsx'))
import { useUrlParam } from '../hooks/useUrlState.js'
import Panel, { Skeleton } from '../ui/Panel.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import { StatusDot } from '../ui/Status.jsx'
import TimeAgo from '../ui/TimeAgo.jsx'
import UptimeBand from '../ui/UptimeBand.jsx'
import Chart from '../ui/Chart.jsx'
import { typeOf, presenceState, presenceText, deviceName, SOURCE_LABEL } from '../lib/deviceTypes.js'
import { localeTag, t } from '../i18n/index.js'

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
const field = 'rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-fg'

// presence filters: freshness without a probe, online / offline with the ARP probe
// label net.filter.<id>, read at render time
const FILTERS_PASSIVE = [['active'], ['idle'], ['dhcp']]
const FILTERS_ARP = [['online'], ['offline'], ['unknown']]
// no more Ignored or Archived (nothing is ignored); every record is listed
const FILTERS_STATE = [['new'], ['review'], ['pending']]
const listed = () => true
const keep = {
  '': listed,
  active: d => listed(d) && d.freshness === 'active',
  idle: d => listed(d) && (d.freshness === 'idle' || d.freshness === 'stale'),
  dhcp: d => listed(d) && d.freshness === 'dhcp',
  online: d => listed(d) && d.online === 1,
  offline: d => listed(d) && d.online === 0,
  unknown: d => listed(d) && d.online == null,
  new: d => d.state === 'new',
  review: d => d.review && listed(d),
  pending: d => d.pending > 0,
}

const ipKey = ip => (ip ? ip.split('.').reduce((n, o) => n * 256 + Number(o), 0) : Infinity)
const ms = v => (v ? Date.parse(v) : 0)
// arp: sort on reliable presence (online first, last answer); otherwise on freshness
const sortsFor = arp => ({
  ip: (a, b) => ipKey(a.ip) - ipKey(b.ip),
  name: (a, b) => deviceName(a).localeCompare(deviceName(b), localeTag()),
  seen: arp ? (a, b) => ms(b.lastPresent) - ms(a.lastPresent) : (a, b) => ms(b.lastSeen) - ms(a.lastSeen),
  state: arp ? (a, b) => (a.online === 1 ? 0 : 1) - (b.online === 1 ? 0 : 1) || ipKey(a.ip) - ipKey(b.ip)
    : (a, b) => (a.freshness === 'active' ? 0 : 1) - (b.freshness === 'active' ? 0 : 1) || ipKey(a.ip) - ipKey(b.ip),
})

// search on every word: name, IP, MAC, vendor, type, linked host
const matchDevice = (d, q) => {
  const hay = [d.name, d.ip, d.mac, d.vendor, typeOf(d.type).label, d.hostId, d.location].filter(Boolean).join(' ').toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

function Sources({ sources }) {
  const entries = Object.entries(sources || {})
  if (!entries.length) return null
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {entries.map(([name, s]) => (
        <span key={name} className="inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] border border-line bg-surface px-2 py-0.5 text-2xs text-muted"
          title={s.error || (s.at ? t('net.last_reading', { date: new Date(s.at).toLocaleString(localeTag()) }) : t('net.no_reading'))}>
          <StatusDot state={s.ok === null ? 'unknown' : !s.ok ? 'crit' : s.stale || s.error ? 'warn' : 'ok'} size={11}
            label={s.ok === null ? t('net.no_reading') : !s.ok ? t('net.src_failed') : s.stale ? t('net.src_stale') : s.error ? t('net.src_partial') : t('net.src_ok')} />
          {SOURCE_LABEL[name] || name}
          {s.n != null && <span className="tabular-nums text-subtle">{s.n}</span>}
          {s.at && <TimeAgo date={s.at} className="text-subtle" />}
          {name === 'merge' && s.error && <span className="text-warn">{s.error}</span>}
        </span>
      ))}
    </div>
  )
}

function Counts({ c, activeMin, arp, setFilter }) {
  const items = [
    ['', t('net.count.total'), c.total, 'ok'],
    ...(arp ? [['online', t('net.filter.online'), c.online, 'ok'], ['offline', t('net.filter.offline'), c.offline, c.offline ? 'crit' : 'ok']]
      : [['active', t('net.count.active', { min: activeMin }), c.active, 'ok'], ['dhcp', t('net.filter.dhcp'), c.dhcp, 'unknown']]),
    ['new', t('net.filter.new'), c.new, c.new ? 'warn' : 'ok'], ['review', t('net.filter.review'), c.review, c.review ? 'info' : 'ok'],
  ]
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {items.map(([f, label, n, st]) => (
        <button key={label} type="button" onClick={() => setFilter(f)} className={`${card} px-3 py-2 text-left hover:border-line-strong`}>
          <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">
            <span className="truncate">{label}</span><StatusDot state={st} size={11} className="ml-auto" label={label} />
          </div>
          <div className="mt-0.5 text-xl font-bold tabular-nums text-fg">{n}</div>
        </button>
      ))}
    </div>
  )
}

function Th({ k, sort, setSort, className = '', children }) {
  return (
    <th className={`px-3 py-2 font-medium ${className}`} aria-sort={sort === k ? 'ascending' : 'none'}>
      <button type="button" onClick={() => setSort(k)} className={`inline-flex items-center gap-1 uppercase ${sort === k ? 'text-fg' : 'hover:text-fg'}`}>
        {children}<ArrowUpDown size={10} aria-hidden />
      </button>
    </th>
  )
}

// bulk actions (admin): "Known" and "Delete", reason required; a batch to delete is all or
// nothing (a record linked to a host makes it refused entirely)
// labels read at render time (net.bulk.<verb>_*)
const BULK = {
  ack: { get label() { return t('net.bulk.ack') }, get title() { return t('net.bulk.ack_title') }, get ok() { return t('net.bulk.ack_ok') }, url: '/api/network/devices/ack' },
  delete: { get label() { return t('net.bulk.delete') }, get title() { return t('net.bulk.delete_title') }, get ok() { return t('net.bulk.delete_ok') }, url: '/api/network/devices/delete' },
}
function BulkBar({ selected, clear }) {
  const { act, notify } = useAdmin()
  const [verb, setVerb] = useState(null)
  if (!selected.size) return null
  const ids = [...selected]
  async function run(reason) {
    await act(BULK[verb].url, { ids, reason }, { invalidate: netKeys() })
    notify(t('net.bulk_done', { n: ids.length, what: BULK[verb].ok }))
    setVerb(null)
    clear()
  }
  return (
    <div className={`${card} mb-3 flex flex-wrap items-center gap-2 px-3 py-2 text-xs`} role="toolbar" aria-label={t('net.actions_selection')}>
      <span className="text-fg">{t('net.selected', { n: ids.length })}</span>
      {Object.entries(BULK).map(([k, b]) => <button key={k} type="button" className={btnGhost} onClick={() => setVerb(k)}>{b.label}…</button>)}
      <button type="button" className="ml-auto text-subtle hover:text-fg" onClick={clear}>{t('net.deselect_all')}</button>
      <Modal open={!!verb} onClose={() => setVerb(null)} title={verb ? t('net.bulk_title', { title: BULK[verb].title, n: ids.length }) : ''}>
        {verb && <ReasonForm submitLabel={BULK[verb].label} onCancel={() => setVerb(null)} onSubmit={run} placeholder={t('net.example_household_devices_checked')} />}
      </Modal>
    </div>
  )
}

// "Probe all" (admin): the Sunday run started by hand, at most once per hour
// "Probe all": state and start (admin); the button is rendered by NetworkTabs
function useProbeAll() {
  const { isAdmin, act, notify } = useAdmin()
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const r = await act('/api/network/probe/all', {}, { invalidate: netKeys() })
      notify(t('net.probe_started', { n: r.targets }))
    } catch {
      // message already shown by act
    } finally {
      setBusy(false)
    }
  }
  return { isAdmin, busy, run }
}

// Tab bar of the Network page (tablist and tab roles, aria-selected, left and right arrows)
// and, on the right of the same row, "Probe all" (admin, probe enabled). Under 640 px, the
// button shrinks to its icon, with an accessible label. Pure component. A single panel
// (role="tabpanel", NET_PANEL_ID): each tab points at it through aria-controls, and the panel
// names the active tab through aria-labelledby (roving tabIndex: 0 on the active one, -1 elsewhere)
export const NET_PANEL_ID = 'net-tabpanel'
const tabCls = on => `-mb-px whitespace-nowrap rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium ${on ? 'border-accent bg-surface-2 text-fg' : 'border-transparent text-muted hover:bg-surface-2 hover:text-fg'}`
const probeCls = 'inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:brightness-90 disabled:opacity-50'
export function NetworkTabs({ tabs, tab, onTab, probe = null, isAdmin = false, busy = false, onProbe = () => {} }) {
  const keys = tabs.map(([k]) => k)
  // unknown tab in the URL (?tab=xyz, or history without presence): Devices, like the content
  const shown = keys.includes(tab) ? tab : 'devices'
  const onKey = e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = keys.indexOf(shown)
    const next = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length]
    onTab(next)
    document.getElementById(`net-tab-${next}`)?.focus()
  }
  const label = probe?.running ? t('net.probe_running') : t('net.probe_all')
  return (
    <div className="mb-3 flex items-end gap-2 border-b border-line">
      <div role="tablist" aria-label={t('net.network_views')} className="flex min-w-0 gap-1" onKeyDown={onKey}>
        {tabs.map(([k, name]) => (
          <button key={k} id={`net-tab-${k}`} type="button" role="tab" aria-selected={shown === k} aria-controls={NET_PANEL_ID} tabIndex={shown === k ? 0 : -1}
            onClick={() => onTab(k)} className={tabCls(shown === k)}>{name}</button>
        ))}
      </div>
      {isAdmin && probe?.enabled && (
        <button type="button" className={`${probeCls} mb-1.5 ml-auto`} disabled={busy || probe.running} onClick={onProbe}
          aria-label={label} title={t('net.probe_all_infrastructure_hosts')}>
          <Radar size={15} aria-hidden /><span className="hidden sm:inline">{label}</span>
        </button>
      )}
    </div>
  )
}

function DeviceTable({ list, open, selected, toggle, mode }) {
  const [sort, setSort] = useUrlParam('sort', 'ip')
  const arp = mode === 'arp'
  const sorts = sortsFor(arp)
  const rows = [...list].sort(sorts[sort] || sorts.ip)
  const banded = arp
  if (!rows.length) return <EmptyState icon={Search} title={t('net.no_devices')} hint={t('net.no_device_matches_filters')} />
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-2xs tracking-wider text-subtle">
            {selected && (
              <th className="w-8 px-3 py-2">
                <input type="checkbox" aria-label={t('net.select_all')} checked={rows.every(d => selected.has(d.id))}
                  onChange={e => toggle(rows.map(d => d.id), e.target.checked)} />
              </th>
            )}
            <Th k="state" sort={sort} setSort={setSort} className="w-8"><span className="sr-only">{t('net.state')}</span></Th>
            <Th k="name" sort={sort} setSort={setSort}>{t('net.device')}</Th>
            <Th k="ip" sort={sort} setSort={setSort}>IP</Th>
            <th className="hidden px-3 py-2 font-medium uppercase md:table-cell">{t('net.vendor')}</th>
            {banded && <th className="hidden w-40 px-3 py-2 font-medium uppercase lg:table-cell">24 h</th>}
            <Th k="seen" sort={sort} setSort={setSort} className="hidden sm:table-cell">{t('net.col_seen')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(d => {
            const T = typeOf(d.type)
            return (
              <tr key={d.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => open(String(d.id))}>
                {selected && (
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" aria-label={t('net.select', { name: deviceName(d) })} checked={selected.has(d.id)} onChange={e => toggle([d.id], e.target.checked)} />
                  </td>
                )}
                <td className="px-3 py-2"><StatusDot state={presenceState(d, mode)} size={13} label={d.state === 'new' ? t('net.new') : presenceText(d, mode)} /></td>
                {/* w-full + max-w-0: the cell takes the remaining space and truncates */}
                <td className="w-full max-w-0 px-3 py-2">
                  <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={e => { e.stopPropagation(); open(String(d.id)) }}>
                    <T.icon size={15} className="shrink-0 text-subtle" aria-label={T.label} />
                    <span className="truncate text-fg">{deviceName(d)}</span>
                    {d.state === 'new' && <span className="shrink-0 rounded bg-warn-bg px-1 text-2xs font-semibold text-warn">{t('net.new')}</span>}
                    {d.review && <span className="shrink-0 rounded border border-line px-1 text-2xs text-subtle" title={t('net.imported_netalertx_seen_during')}>{t('net.review')}</span>}
                    {d.pending > 0 && <span className="shrink-0 rounded bg-warn-bg px-1 text-2xs font-semibold text-warn" title={t('net.mac_attached_automatically_confirm')}>{t('net.mac_confirm')}</span>}
                    {d.random && <Shuffle size={12} className="shrink-0 text-subtle" aria-label={t('net.random_local_mac')} />}
                    {d.hostId && <Link2 size={12} className="shrink-0 text-accent" aria-label={t('net.linked_host', { host: d.hostId })} />}
                  </button>
                  <div className="truncate text-2xs text-subtle">
                    {[d.type && T.label, presenceText(d, mode), d.macs > 1 && `${d.macs} MAC`].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">{d.ip || '—'}</td>
                <td className="hidden max-w-48 truncate px-3 py-2 text-xs text-muted md:table-cell" title={d.vendor || ''}>{d.vendor || '—'}</td>
                {banded && <td className="hidden px-3 py-2 lg:table-cell"><UptimeBand band={d.band24h} height="h-3" label={t('net.presence_24')} /></td>}
                <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted sm:table-cell">{(arp ? d.lastPresent : d.lastSeen) ? <TimeAgo date={arp ? d.lastPresent : d.lastSeen} /> : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Devices({ v }) {
  const [q, setQ] = useUrlParam('q')
  const [filter, setFilter] = useUrlParam('state')
  const [type, setType] = useUrlParam('type')
  const [, open] = useUrlParam('d')
  const { isAdmin } = useAdmin()
  const [selected, setSelected] = useState(() => new Set())
  const toggle = (ids, on) => setSelected(cur => {
    const next = new Set(cur)
    for (const id of ids) on ? next.add(id) : next.delete(id)
    return next
  })
  const types = [...new Set(v.devices.map(d => d.type).filter(Boolean))].sort()
  const list = v.devices.filter(d => (keep[filter] || keep[''])(d) && (!type || d.type === type) && (!q || matchDevice(d, q)))
  const arp = v.presence === 'arp'
  const filters = [[''], ...(arp ? FILTERS_ARP : FILTERS_PASSIVE), ...FILTERS_STATE]
  return (
    <>
      <Counts c={v.counts} activeMin={v.activeMin} arp={arp} setFilter={setFilter} />
      {v.counts.new > 0 && (
        <p className={`${card} mb-3 flex items-center gap-2 border-l-[3px] border-l-warn px-3 py-2 text-xs text-fg`}>
          <CircleAlert size={14} className="text-warn" aria-hidden />
          {t('net.new_banner', { count: v.counts.new })}
          <button type="button" className="text-accent hover:underline" onClick={() => setFilter('new')}>{t('net.show')}</button>
        </p>
      )}
      {v.counts.pending > 0 && filter !== 'pending' && (
        <p className={`${card} mb-3 flex items-center gap-2 border-l-[3px] border-l-warn px-3 py-2 text-xs text-fg`}>
          <Unlink size={14} className="text-warn" aria-hidden />
          {t('net.pending_banner', { count: v.counts.pending })}
          <button type="button" className="text-accent hover:underline" onClick={() => setFilter('pending')}>{t('net.show')}</button>
        </p>
      )}
      <NetworkSuggestions suggestions={v.suggestions} devices={v.devices} />
      {v.counts.review > 0 && filter !== 'review' && (
        <p className={`${card} mb-3 flex items-center gap-2 px-3 py-2 text-xs text-muted`}>
          <ListChecks size={14} className="text-info" aria-hidden />
          {t('net.review_banner', { count: v.counts.review })}
          <button type="button" className="text-accent hover:underline" onClick={() => setFilter('review')}>{t('net.display')}</button>
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-48 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('net.name_ip_mac_vendor')} aria-label={t('net.search_device')} className={`${field} w-full pl-8`} />
        </label>
        <select value={filter} onChange={e => setFilter(e.target.value)} className={field} aria-label={t('net.filter_state')}>
          {filters.map(([k]) => <option key={k} value={k}>{t(`net.filter.${k || 'all'}`)}</option>)}
        </select>
        <select value={type} onChange={e => setType(e.target.value)} className={field} aria-label={t('net.filter_type')}>
          <option value="">{t('net.all_types')}</option>
          {types.map(ty => <option key={ty} value={ty}>{typeOf(ty).label}</option>)}
        </select>
        <span className="text-2xs text-subtle tabular-nums">{list.length} / {v.devices.length}</span>
      </div>
      {isAdmin && <BulkBar selected={selected} clear={() => setSelected(new Set())} />}
      <DeviceTable list={list} open={open} selected={isAdmin ? selected : null} toggle={toggle} mode={v.presence} />
    </>
  )
}

// devices online per hour, from the presence aggregate (7, 30 or 90 d)
function History() {
  const [days, setDays] = useUrlParam('days', '7')
  const q = useJson(`/api/network/history?days=${encodeURIComponent(days)}`, 300_000)
  const points = q.data?.points ?? []
  return (
    <div className={`${card} px-4 py-3`}>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="text-muted">{t('net.period')}</span>
        {['7', '30', '90'].map(d => (
          <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
            className={`rounded-[var(--radius-chip)] border px-2 py-0.5 ${days === d ? 'border-accent text-fg' : 'border-line text-muted hover:text-fg'}`}>{t('net.days', { n: d })}</button>
        ))}
      </div>
      <Chart title={t('net.devices_online_per_hour')} series={[{ label: t('net.online'), values: points.map(p => p.online), className: 'text-accent' }]}
        times={points.map(p => Date.parse(p.t))} height={120} />
    </div>
  )
}

// presence banner: reliable probe (anchor gateway), not installed yet, or silent
function PresenceNote({ v }) {
  if (v.presence === 'arp') {
    return (
      <p className="mb-3 text-2xs text-subtle">
        {t('net.presence_arp', { min: v.arpIntervalSec / 60 })}
        {v.gateway && <>{t('net.anchor')}<span className="font-mono">{v.gateway.ip}</span>{t('net.anchor_src', { src: v.gateway.source === 'route' ? t('net.default_route') : 'config' })}</>}
      </p>
    )
  }
  return (
    <>
      {v.presenceSince && (
        <p className={`${card} mb-3 flex items-center gap-2 border-l-[3px] border-l-warn px-3 py-2 text-xs text-fg`}>
          <CircleAlert size={14} className="text-warn" aria-hidden />
          {t('net.arp_silent')}{v.sources.arp?.at ? <>{t('net.since')}<TimeAgo date={v.sources.arp.at} /></> : ''}{t('net.arp_silent_end')}
        </p>
      )}
      <p className="mb-3 text-2xs text-subtle">
        {t('net.presence_passive', { min: v.activeMin })}
      </p>
    </>
  )
}

// Network view: inventory of the LAN devices; reliable presence with the ARP probe, otherwise
// passive freshness. Detail drawer: ?d=<id>.
export default function Network() {
  const q = useSource('network')
  const v = q.data
  const [tab, setTab] = useUrlParam('tab', 'devices')
  const probeAll = useProbeAll()
  if (v && !v.enabled) {
    return <EmptyState icon={NetworkIcon} title={t('net.network_module_not_configured')} hint={t('net.add_network_block_hint')} />
  }
  return (
    <Panel icon={NetworkIcon} title={t('net.lan_devices')} query={q} skeleton={<Skeleton count={1} h="h-96" cols="" />}
      right={v?.baseline ? <span className="text-2xs text-info">{t('net.bootstrap_progress_devices_recorded')}</span> : null}>
      {v && (
        <>
          <PresenceNote v={v} />
          <Sources sources={v.sources} />
          <NetworkTabs tabs={[['devices', t('net.tab.devices')], ['carte', t('net.tab.map')], ...(v.presenceSince ? [['history', t('net.tab.history')]] : [])]}
            tab={tab} onTab={setTab} probe={v.sources.probe} isAdmin={probeAll.isAdmin} busy={probeAll.busy} onProbe={probeAll.run} />
          <div role="tabpanel" id={NET_PANEL_ID} aria-labelledby={`net-tab-${tab === 'carte' || (tab === 'history' && v.presenceSince) ? tab : 'devices'}`} tabIndex={0} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {tab === 'carte' ? (
              <Suspense fallback={<div className={`${card} h-96 animate-pulse`} />}><NetworkMap /></Suspense>
            ) : tab === 'history' && v.presenceSince ? <History /> : <Devices v={v} />}
          </div>
        </>
      )}
    </Panel>
  )
}
